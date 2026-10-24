// Scheduled job (pg_cron → pg_net, every 10 minutes). In order:
//   1. release unpaid holds that outlived their checkout
//   2. retry any confirmation email that didn't go out
//   3. 24-hour reminders: email always, SMS when switched on and the client opted in
//   4. follow-up email after the session
//   5. waitlist: tell waiting clients when their window frees up
// Deploy with JWT verification OFF; protected by the x-cron-secret header.
import { admin, env, fShort, sendSms, settings, TZ } from "../_shared/util.ts";
import { BOOKING_SELECT, notify, sendEmail, waitlistEmail } from "../_shared/email.ts";

Deno.serve(async (req) => {
  if (!env("CRON_SECRET") || req.headers.get("x-cron-secret") !== env("CRON_SECRET")) return new Response("Forbidden", { status: 403 });
  const db = admin();
  const s = await settings(db);
  const now = Date.now(), iso = (t: number) => new Date(t).toISOString();
  const out = { holds: 0, confirmations: 0, reminders: 0, sms: 0, followups: 0, waitlist: 0, errors: [] as string[] };

  // 1. holds
  const { data: n } = await db.rpc("expire_holds"); out.holds = n ?? 0;

  // 2. missed confirmations
  const { data: missed } = await db.from("bookings").select(BOOKING_SELECT)
    .eq("status", "confirmed").is("confirmation_sent_at", null)
    .lt("created_at", iso(now - 5 * 6e4)).gt("starts_at", iso(now)).limit(50);
  for (const b of missed ?? []) if (await notify(db, "confirmation", b, s.cancel_cutoff_hours, "confirmation_sent_at")) out.confirmations++;

  // 3. reminders (skip bookings made inside the 24h window — they just got a confirmation)
  const { data: due } = await db.from("bookings").select(BOOKING_SELECT + ", created_at, reminder_sent_at, sms_sent_at")
    .eq("status", "confirmed").gt("starts_at", iso(now)).lte("starts_at", iso(now + 24 * 36e5))
    .or("reminder_sent_at.is.null,and(sms_opt_in.eq.true,sms_sent_at.is.null)").limit(100);
  for (const b of due ?? []) {
    const lead = +new Date(b.starts_at) - +new Date(b.created_at);
    if (!b.reminder_sent_at) {
      if (lead < 24 * 36e5) await db.from("bookings").update({ reminder_sent_at: iso(now) }).eq("id", b.id);
      else if (await notify(db, "reminder", b, s.cancel_cutoff_hours, "reminder_sent_at")) out.reminders++;
    }
    if (s.sms_enabled && b.sms_opt_in && b.phone && !b.sms_sent_at && lead >= 3 * 36e5) {
      try {
        const t = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(b.starts_at));
        await sendSms(b.phone, `HOTFUZZJAM: your rehearsal is ${t}. Change or cancel: ${env("SITE_URL", "https://hotfuzzjam.com")}/?manage=${b.manage_token}`);
        await db.from("bookings").update({ sms_sent_at: iso(now) }).eq("id", b.id); out.sms++;
      } catch (e) { out.errors.push(`sms ${b.id}: ${e}`); }
    }
  }

  // 4. follow-ups
  const { data: done } = await db.from("bookings").select(BOOKING_SELECT)
    .eq("status", "confirmed").is("followup_sent_at", null)
    .lt("ends_at", iso(now - s.followup_delay_hours * 36e5)).gt("ends_at", iso(now - 3 * 864e5)).limit(100);
  for (const b of done ?? []) if (await notify(db, "followup", b, s.cancel_cutoff_hours, "followup_sent_at")) out.followups++;

  // 5. waitlist
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const { data: waits } = await db.from("waitlist").select("*").eq("status", "waiting").gte("day", today).limit(200);
  if (waits?.length) {
    const days = [...new Set(waits.map((w: any) => w.day))].sort();
    const from = new Date(`${days[0]}T00:00:00+10:00`), to = new Date(`${days[days.length - 1]}T24:00:00+10:00`);
    const { data: busy } = await db.rpc("get_roster", { p_from: from.toISOString(), p_to: to.toISOString() });
    for (const w of waits) {
      const free = freeStarts(w, busy ?? [], s, now);
      if (!free.length) continue;
      try {
        const label = fShort.format(new Date(`${w.day}T12:00:00+10:00`));
        await sendEmail(w.email, waitlistEmail(w.name, label, free.map((h) => `${String(h).padStart(2, "0")}:00`)));
        await db.from("waitlist").update({ status: "notified", notified_at: iso(now) }).eq("id", w.id); out.waitlist++;
      } catch (e) { out.errors.push(`waitlist ${w.id}: ${e}`); }
    }
  }

  console.log(out);
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
});

/** Start hours inside the waiter's window where `hours_needed` consecutive free hours exist. */
function freeStarts(w: any, busy: any[], s: any, now: number) {
  const hourStart = (h: number) => +new Date(`${w.day}T${String(h).padStart(2, "0")}:00:00+10:00`);
  const taken = (h: number) => busy.some((b) => b.room_id === w.room_id && +new Date(b.starts_at) < hourStart(h) + 36e5 && +new Date(b.ends_at) > hourStart(h));
  const lo = Math.max(w.from_hour, s.open_hour), hi = Math.min(w.to_hour, s.close_hour);
  const out: number[] = [];
  for (let h = lo; h + w.hours_needed <= hi; h++) {
    if (hourStart(h) <= now + 36e5) continue;
    let ok = true; for (let k = 0; k < w.hours_needed; k++) if (taken(h + k)) { ok = false; break; }
    if (ok) out.push(h);
  }
  return out;
}
