// Manage a booking from the private link in every email (?manage=<token>), or from "My bookings".
// Actions: get · reschedule · cancel · release (abandoned checkout).
// Deploy with JWT verification OFF. The unguessable manage_token is the credential.
import { admin, cors, fail, json, settings, stripe } from "../_shared/util.ts";
import { BOOKING_SELECT, notify } from "../_shared/email.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any; try { body = await req.json(); } catch { return fail("Bad request."); }
  const { action, token } = body ?? {};
  if (!UUID.test(token ?? "")) return fail("That link isn't valid.", 404);

  const db = admin();
  const s = await settings(db);
  const { data: b } = await db.from("bookings").select(BOOKING_SELECT).eq("manage_token", token).maybeSingle();
  if (!b) return fail("We couldn't find that booking.", 404);

  const now = Date.now(), start = +new Date(b.starts_at);
  const beforeCutoff = start - now >= s.cancel_cutoff_hours * 36e5;
  const refundable = beforeCutoff ? Math.max(0, b.paid_cents - b.refunded_cents) : 0;
  const view = () => ({
    booking: {
      id: b.id, room_id: b.room_id, room: b.rooms?.name, starts_at: b.starts_at, ends_at: b.ends_at, status: b.status,
      band_name: b.band_name, amount_cents: b.amount_cents, discount_cents: b.discount_cents, gift_applied_cents: b.gift_applied_cents,
      due_cents: b.due_cents, paid_cents: b.paid_cents, refunded_cents: b.refunded_cents, payment_status: b.payment_status, pay_mode: b.pay_mode,
    },
    policy: {
      cutoff_hours: s.cancel_cutoff_hours,
      can_reschedule: b.status === "confirmed" && beforeCutoff && b.reschedule_count < 3,
      can_cancel: b.status === "confirmed" && start > now,
      refund_cents: refundable,
    },
  });

  if (action === "get") return json(view());

  if (action === "release") {
    if (b.status !== "pending") return json(view());
    await db.from("bookings").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("id", b.id).eq("status", "pending");
    if (b.gift_code && b.gift_applied_cents) await db.rpc("gift_release", { p_code: b.gift_code, p_cents: b.gift_applied_cents });
    b.status = "cancelled";
    return json(view());
  }

  if (action === "reschedule") {
    if (b.status !== "confirmed") return fail("Only confirmed sessions can be moved.");
    if (!beforeCutoff) return fail(`Sessions can be moved up to ${s.cancel_cutoff_hours} hours before they start. Call or email the studio for anything later.`, 403);
    if (b.reschedule_count >= 3) return fail("This session has been moved three times. Contact the studio to change it again.", 403);
    const ns = new Date(body.starts_at);
    if (isNaN(+ns)) return fail("Pick a new start time.");
    const ne = new Date(+ns + (+new Date(b.ends_at) - start));
    const { error } = await db.from("bookings").update({ starts_at: ns.toISOString(), ends_at: ne.toISOString(), reschedule_count: b.reschedule_count + 1 }).eq("id", b.id);
    if (error) return error.code === "23P01" ? fail("That time is taken. Pick another.", 409, "taken") : fail(error.message);
    Object.assign(b, { starts_at: ns.toISOString(), ends_at: ne.toISOString(), reschedule_count: b.reschedule_count + 1 });
    await notify(db, "rescheduled", b, s.cancel_cutoff_hours);
    return json(view());
  }

  if (action === "cancel") {
    if (b.status !== "confirmed" || start <= now) return fail("This session can't be cancelled online.");
    let refunded = 0;
    if (refundable > 0 && b.stripe_payment_intent) {
      await stripe("refunds", { payment_intent: b.stripe_payment_intent, amount: refundable, metadata: { booking_id: b.id } }, `cancel-${b.id}`);
      refunded = refundable;
    }
    if (beforeCutoff && b.gift_code && b.gift_applied_cents) await db.rpc("gift_release", { p_code: b.gift_code, p_cents: b.gift_applied_cents });
    const total = b.refunded_cents + refunded;
    const patch = {
      status: "cancelled", cancelled_at: new Date().toISOString(), refunded_cents: total,
      payment_status: total > 0 ? (total >= b.paid_cents ? "refunded" : "part_refunded") : b.payment_status,
    };
    await db.from("bookings").update(patch).eq("id", b.id);
    Object.assign(b, patch);
    await notify(db, "cancelled", { ...b, refunded_cents: refunded }, s.cancel_cutoff_hours);
    return json(view());
  }

  return fail("Unknown action.");
});
