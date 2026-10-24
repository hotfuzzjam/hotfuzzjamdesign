// Stripe webhook: confirms paid bookings, activates purchased gift cards, releases expired holds.
// Deploy with JWT verification OFF. Authenticity comes from the Stripe-Signature header.
// Stripe Dashboard → Developers → Webhooks → endpoint https://<ref>.supabase.co/functions/v1/stripe-webhook
// Events: checkout.session.completed, checkout.session.expired
import { admin, json, settings, stripe, verifyStripe } from "../_shared/util.ts";
import { BOOKING_SELECT, giftEmail, notify, sendEmail } from "../_shared/email.ts";

Deno.serve(async (req) => {
  const raw = await req.text();
  if (!(await verifyStripe(raw, req.headers.get("stripe-signature")))) return new Response("Bad signature", { status: 400 });
  const event = JSON.parse(raw);
  const obj = event.data?.object ?? {};
  const kind = obj.metadata?.kind;
  const db = admin();

  try {
    if (event.type === "checkout.session.completed" && kind === "booking") await bookingPaid(db, obj);
    else if (event.type === "checkout.session.completed" && kind === "gift") await giftPaid(db, obj);
    else if (event.type === "checkout.session.expired" && kind === "booking") await bookingExpired(db, obj);
    else if (event.type === "checkout.session.expired" && kind === "gift") await db.from("gift_cards").update({ status: "void" }).eq("code", obj.metadata.gift_code).eq("status", "pending");
  } catch (e) {
    console.error(event.type, e);
    return new Response("Handler error", { status: 500 });   // Stripe retries
  }
  return json({ received: true });
});

async function bookingPaid(db: any, s: any) {
  const id = s.metadata.booking_id;
  const { data: b } = await db.from("bookings").select(BOOKING_SELECT).eq("id", id).single();
  if (!b || b.payment_status === "paid" || b.payment_status === "deposit_paid") return;      // already handled (retry)
  const paid = s.amount_total ?? 0;
  const patch = {
    status: "confirmed", hold_expires_at: null, paid_cents: paid, stripe_payment_intent: s.payment_intent,
    payment_status: paid >= b.due_cents ? "paid" : "deposit_paid",
  };
  const { error } = await db.from("bookings").update(patch).eq("id", id);
  if (error) {
    // the hold lapsed and someone else took the slot before payment landed: refund in full
    if (error.code === "23P01") {
      await stripe("refunds", { payment_intent: s.payment_intent, reason: "duplicate" }, `refund-${id}`);
      await db.from("bookings").update({ status: "cancelled", paid_cents: paid, refunded_cents: paid, payment_status: "refunded", stripe_payment_intent: s.payment_intent }).eq("id", id);
      return;
    }
    throw error;
  }
  if (b.coupon_code) await db.rpc("coupon_used", { p_code: b.coupon_code });
  const st = await settings(db);
  await notify(db, "confirmation", { ...b, ...patch }, st.cancel_cutoff_hours, "confirmation_sent_at");
}

async function bookingExpired(db: any, s: any) {
  const { data: b } = await db.from("bookings").update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", s.metadata.booking_id).eq("status", "pending").select("gift_code, gift_applied_cents").maybeSingle();
  if (b?.gift_code && b.gift_applied_cents) await db.rpc("gift_release", { p_code: b.gift_code, p_cents: b.gift_applied_cents });
}

async function giftPaid(db: any, s: any) {
  const { data: g } = await db.from("gift_cards").update({ status: "active" })
    .eq("code", s.metadata.gift_code).eq("status", "pending").select("*").maybeSingle();
  if (!g) return;
  // the recipient gets the card; the purchaser always gets a copy as their receipt
  if (g.deliver_to === "recipient" && g.recipient_email) await sendEmail(g.recipient_email, giftEmail(g, "recipient"));
  await sendEmail(g.purchaser_email, giftEmail(g, "purchaser"));
  await db.from("gift_cards").update({ delivered_at: new Date().toISOString() }).eq("code", g.code);
}
