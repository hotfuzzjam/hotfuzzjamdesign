// Owner actions that need Stripe or email: phone/walk-in bookings, cancel with or without refund,
// resend confirmation. Everything else in the dashboard writes directly through admin RLS policies.
// Deploy with JWT verification ON. Caller must be listed in public.admins.
import { admin, caller, cors, fail, hoursBetween, json, settings, stripe, toE164 } from "../_shared/util.ts";
import { BOOKING_SELECT, notify } from "../_shared/email.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const user = await caller(req);
  if (!user) return fail("Sign in first.", 401);
  const db = admin();
  const { data: isAdmin } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!isAdmin) return fail("This account isn't a studio admin.", 403);

  let b: any; try { b = await req.json(); } catch { return fail("Bad request."); }
  const s = await settings(db);

  if (b.action === "create_booking") {
    const { data: room } = await db.from("rooms").select("id, rate_cents").eq("id", b.room_id ?? "a").single();
    if (!room) return fail("That room doesn't exist.");
    const hours = hoursBetween(b.starts_at, b.ends_at);
    const amount = Number.isFinite(b.amount_cents) ? Math.max(0, Math.round(b.amount_cents)) : room.rate_cents * hours;
    const phone = b.phone ? toE164(b.phone) : null;
    const { data, error } = await db.from("bookings").insert({
      user_id: null, source: "admin", room_id: room.id, starts_at: b.starts_at, ends_at: b.ends_at, status: "confirmed",
      band_name: b.band_name || null, contact_name: b.contact_name || null, contact_email: b.contact_email || null, notes: b.notes || null,
      amount_cents: amount, due_cents: amount, pay_mode: amount ? "on_arrival" : "free", phone, sms_opt_in: !!(phone && b.sms_opt_in),
    }).select(BOOKING_SELECT).single();
    if (error) return error.code === "23P01" ? fail("That time overlaps another booking or a block-out.", 409) : fail(error.message);
    if (b.notify && data.contact_email) await notify(db, "confirmation", data, s.cancel_cutoff_hours, "confirmation_sent_at");
    return json({ booking: data });
  }

  const { data: bk } = await db.from("bookings").select(BOOKING_SELECT).eq("id", b.booking_id).maybeSingle();
  if (!bk) return fail("Booking not found.", 404);

  if (b.action === "cancel") {
    if (bk.status === "cancelled") return json({ booking: bk });
    let refunded = 0;
    const owed = Math.max(0, bk.paid_cents - bk.refunded_cents);
    if (b.refund && owed > 0 && bk.stripe_payment_intent) {
      await stripe("refunds", { payment_intent: bk.stripe_payment_intent, amount: owed, metadata: { booking_id: bk.id, by: "admin" } }, `admin-cancel-${bk.id}`);
      refunded = owed;
    }
    if (b.refund && bk.gift_code && bk.gift_applied_cents) await db.rpc("gift_release", { p_code: bk.gift_code, p_cents: bk.gift_applied_cents });
    const total = bk.refunded_cents + refunded;
    const patch = { status: "cancelled", cancelled_at: new Date().toISOString(), refunded_cents: total,
      payment_status: total > 0 ? (total >= bk.paid_cents ? "refunded" : "part_refunded") : bk.payment_status };
    await db.from("bookings").update(patch).eq("id", bk.id);
    if (b.notify !== false) await notify(db, "cancelled", { ...bk, ...patch, refunded_cents: refunded }, s.cancel_cutoff_hours);
    return json({ booking: { ...bk, ...patch }, refunded_cents: refunded });
  }

  if (b.action === "resend") {
    const ok = await notify(db, "confirmation", bk, s.cancel_cutoff_hours, "confirmation_sent_at");
    return ok ? json({ sent: true }) : fail("The email couldn't be sent. Check the Resend key and domain.", 502);
  }

  return fail("Unknown action.");
});
