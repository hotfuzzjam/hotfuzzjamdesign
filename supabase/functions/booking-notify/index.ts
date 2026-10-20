// Sends the booking confirmation. Called by the site right after a booking is created.
// Deploy with JWT verification ON. RLS ensures a user can only trigger mail for their own booking.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { sendBookingEmail } from "../_shared/email.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { booking_id } = await req.json();
    if (!booking_id) return json({ error: "booking_id required" }, 400);

    const url = Deno.env.get("SUPABASE_URL")!;
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: b, error } = await asUser
      .from("bookings")
      .select("id, room_id, starts_at, ends_at, band_name, contact_email, confirmation_sent_at, rooms(name, rate_cents)")
      .eq("id", booking_id)
      .single();
    if (error || !b) return json({ error: "Booking not found" }, 404);
    if (b.confirmation_sent_at) return json({ ok: true, alreadySent: true });

    await sendBookingEmail("confirmation", b as never);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("bookings").update({ confirmation_sent_at: new Date().toISOString() }).eq("id", b.id);
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
