// Creates a booking with server-side pricing (rate × hours − coupon − gift card), then either
// confirms it straight away (nothing to pay now) or holds the slot and returns a Stripe Checkout URL.
// Deploy with JWT verification ON: only signed-in clients can book.
import { admin, caller, cors, dollars, fail, fShort, fTime, hoursBetween, json, SITE_URL, settings, stripe, stripeEnabled, toE164 } from "../_shared/util.ts";
import { BOOKING_SELECT, notify } from "../_shared/email.ts";

type Body = {
  room_id: string; starts_at: string; ends_at: string; band_name?: string; notes?: string;
  coupon?: string; gift_code?: string; pay_choice?: "full" | "deposit"; sms_opt_in?: boolean; phone?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const user = await caller(req);
  if (!user) return fail("Sign in to book.", 401);

  let b: Body;
  try { b = await req.json(); } catch { return fail("Bad request."); }
  if (!b.room_id || !b.starts_at || !b.ends_at) return fail("Pick a day, a start time and a length.");

  const db = admin();
  const s = await settings(db);
  const { data: room } = await db.from("rooms").select("id, name, rate_cents").eq("id", b.room_id).single();
  if (!room) return fail("That room isn't available.");

  const hours = hoursBetween(b.starts_at, b.ends_at);
  if (hours < 1) return fail("Sessions run at least one hour.");
  const amount = room.rate_cents * hours;

  // coupon
  let discount = 0; const coupon = b.coupon?.trim().toUpperCase() || null;
  if (coupon) {
    const { data } = await db.rpc("check_coupon", { p_code: coupon, p_hours: hours, p_amount_cents: amount });
    const r = data?.[0];
    if (!r?.valid) return fail(r?.message ?? "That code isn't valid.", 400, "coupon");
    discount = r.discount_cents;
  }
  const afterCoupon = amount - discount;

  // how much is paid online now
  let mode: "full" | "deposit" | "on_arrival" = s.payment_mode === "choice" ? (b.pay_choice === "deposit" ? "deposit" : "full") : s.payment_mode;
  if (!stripeEnabled()) mode = "on_arrival";            // payments not set up yet → pay at the studio

  const phone = b.sms_opt_in ? toE164(b.phone) : null;
  if (b.sms_opt_in && !phone) return fail("Enter a mobile number like 0412 345 678 for text reminders.", 400, "phone");

  // reserve gift card balance up front; released again if anything below fails
  const gift = b.gift_code?.trim().toUpperCase() || null;
  let giftApplied = 0;
  if (gift && afterCoupon > 0) {
    const { data: chk } = await db.rpc("check_gift", { p_code: gift });
    if (!chk?.[0]?.valid) return fail(chk?.[0]?.message ?? "That gift code isn't valid.", 400, "gift");
    const { data: applied } = await db.rpc("gift_reserve", { p_code: gift, p_cents: afterCoupon });
    giftApplied = applied ?? 0;
  }
  const release = () => gift && giftApplied ? db.rpc("gift_release", { p_code: gift, p_cents: giftApplied }) : Promise.resolve();

  const due = afterCoupon - giftApplied;
  const chargeNow = due === 0 ? 0 : mode === "full" ? due : mode === "deposit" ? Math.max(100, Math.ceil((due * s.deposit_pct) / 100)) : 0;
  const status = chargeNow > 0 ? "pending" : "confirmed";

  const { data: booking, error } = await db.from("bookings").insert({
    user_id: user.id, room_id: room.id, starts_at: b.starts_at, ends_at: b.ends_at,
    band_name: b.band_name?.slice(0, 80) || null, notes: b.notes?.slice(0, 400) || null,
    contact_name: (user.user_metadata?.full_name as string | undefined)?.slice(0, 80) ?? null,
    status, amount_cents: amount, discount_cents: discount, gift_applied_cents: giftApplied, due_cents: due,
    charge_now_cents: chargeNow, pay_mode: due === 0 ? "free" : mode, coupon_code: coupon, gift_code: giftApplied ? gift : null,
    hold_expires_at: status === "pending" ? new Date(Date.now() + (s.hold_minutes + 10) * 60e3).toISOString() : null,
    sms_opt_in: !!phone, phone,
  }).select(BOOKING_SELECT).single();

  if (error) {
    await release();
    if (error.code === "23P01") return fail("Someone just took part of that time. Pick another start or a shorter session.", 409, "taken");
    return fail(error.message, 400);
  }

  if (status === "confirmed") {
    if (coupon) await db.rpc("coupon_used", { p_code: coupon });
    await notify(db, "confirmation", booking, s.cancel_cutoff_hours, "confirmation_sent_at");
    return json({ confirmed: true, booking: publicView(booking) });
  }

  try {
    const start = new Date(b.starts_at), end = new Date(b.ends_at);
    const session = await stripe("checkout/sessions", {
      mode: "payment",
      customer_email: user.email,
      client_reference_id: booking.id,
      expires_at: Math.floor(Date.now() / 1000) + Math.max(30, s.hold_minutes) * 60,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "aud", unit_amount: chargeNow,
          product_data: {
            name: `${room.name} · ${fShort.format(start)} ${fTime.format(start)}–${fTime.format(end)}`,
            description: mode === "deposit" ? `${s.deposit_pct}% deposit. ${dollars(due - chargeNow)} balance paid at the studio.` : `${hours} hour rehearsal`,
          },
        },
      }],
      metadata: { kind: "booking", booking_id: booking.id },
      payment_intent_data: { metadata: { kind: "booking", booking_id: booking.id } },
      success_url: `${SITE_URL()}/?checkout=success&t=${booking.manage_token}#book`,
      cancel_url: `${SITE_URL()}/?checkout=cancel&t=${booking.manage_token}#book`,
    }, `booking-${booking.id}`);
    await db.from("bookings").update({ stripe_session_id: session.id }).eq("id", booking.id);
    return json({ url: session.url, booking: publicView(booking) });
  } catch (e) {
    await db.from("bookings").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("id", booking.id);
    await release();
    console.error(e);
    return fail("Payment couldn't start. Try again in a moment.", 502);
  }
});

function publicView(b: Record<string, unknown>) {
  const { stripe_session_id: _s, stripe_payment_intent: _p, user_id: _u, ...rest } = b;
  return rest;
}
