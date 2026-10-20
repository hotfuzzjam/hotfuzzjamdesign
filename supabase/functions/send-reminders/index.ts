// Hourly job (pg_cron → pg_net). Sends:
//   1. 24-hour reminders for confirmed sessions starting within the next 24 hours
//   2. any confirmation the site failed to trigger (tab closed mid-request, network drop)
// Deploy with JWT verification OFF; protected by the x-cron-secret header instead.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { sendBookingEmail } from "../_shared/email.ts";

const SELECT = "id, room_id, starts_at, ends_at, band_name, contact_email, rooms(name, rate_cents)";

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("Forbidden", { status: 403 });
  }
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = new Date();
  const in24 = new Date(now.getTime() + 24 * 36e5);
  const fiveAgo = new Date(now.getTime() - 5 * 6e4);
  const out = { confirmations: 0, reminders: 0, errors: [] as string[] };

  // Missed confirmations
  const { data: pending } = await db.from("bookings").select(SELECT)
    .eq("status", "confirmed").is("confirmation_sent_at", null)
    .lt("created_at", fiveAgo.toISOString()).gt("starts_at", now.toISOString()).limit(50);
  for (const b of pending ?? []) {
    try {
      await sendBookingEmail("confirmation", b as never);
      await db.from("bookings").update({ confirmation_sent_at: new Date().toISOString() }).eq("id", b.id);
      out.confirmations++;
    } catch (e) { out.errors.push(`${b.id}: ${e}`); }
  }

  // Reminders. Bookings made inside the 24h window get no reminder (they just got a confirmation).
  const { data: due } = await db.from("bookings").select(SELECT + ", created_at")
    .eq("status", "confirmed").is("reminder_sent_at", null)
    .gt("starts_at", now.toISOString()).lte("starts_at", in24.toISOString()).limit(100);
  for (const b of due ?? []) {
    const createdLead = +new Date(b.starts_at) - +new Date((b as { created_at: string }).created_at);
    if (createdLead < 24 * 36e5) {
      await db.from("bookings").update({ reminder_sent_at: now.toISOString() }).eq("id", b.id);
      continue;
    }
    try {
      await sendBookingEmail("reminder", b as never);
      await db.from("bookings").update({ reminder_sent_at: new Date().toISOString() }).eq("id", b.id);
      out.reminders++;
    } catch (e) { out.errors.push(`${b.id}: ${e}`); }
  }

  console.log(out);
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
});
