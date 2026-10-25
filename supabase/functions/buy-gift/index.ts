// Starts a Stripe Checkout for a gift card. Anyone can buy one (no account needed).
// Deploy with JWT verification OFF. The card only activates when the webhook confirms payment.
import { admin, cors, fail, giftCode, json, SITE_URL, stripe, stripeEnabled } from "../_shared/util.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!stripeEnabled()) return fail("Gift cards go on sale once online payments are switched on.", 503);
  let b: any; try { b = await req.json(); } catch { return fail("Bad request."); }

  const cents = Math.round(Number(b.amount_cents));
  if (!Number.isFinite(cents) || cents < 2000 || cents > 100000) return fail("Choose an amount between $20 and $1,000.");
  if (!EMAIL.test(b.purchaser_email ?? "")) return fail("Enter your email so we can send the receipt.");
  const deliver = b.deliver_to === "purchaser" ? "purchaser" : "recipient";
  if (deliver === "recipient" && !EMAIL.test(b.recipient_email ?? "")) return fail("Enter the recipient's email, or send the card to yourself.");

  const db = admin();
  let code = giftCode();
  for (let i = 0; i < 3; i++) {
    const { error } = await db.from("gift_cards").insert({
      code, initial_cents: cents, balance_cents: cents, status: "pending", deliver_to: deliver,
      purchaser_name: String(b.purchaser_name ?? "").slice(0, 80) || null, purchaser_email: b.purchaser_email,
      recipient_name: String(b.recipient_name ?? "").slice(0, 80) || null, recipient_email: deliver === "recipient" ? b.recipient_email : null,
      message: String(b.message ?? "").slice(0, 300) || null,
    });
    if (!error) break;
    if (error.code !== "23505" || i === 2) return fail("Couldn't create the gift card. Try again.", 500);
    code = giftCode();
  }

  const session = await stripe("checkout/sessions", {
    mode: "payment", customer_email: b.purchaser_email,
    line_items: [{ quantity: 1, price_data: { currency: "aud", unit_amount: cents,
      product_data: { name: "HOTFUZZJAM Studio gift card", description: "Redeemable on any rehearsal booking. Balance carries over." } } }],
    metadata: { kind: "gift", gift_code: code },
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
    success_url: `${SITE_URL()}/?gift=success#gifts`, cancel_url: `${SITE_URL()}/?gift=cancel#gifts`,
  }, `gift-${code}`);
  await db.from("gift_cards").update({ stripe_session_id: session.id }).eq("code", code);
  return json({ url: session.url });
});
