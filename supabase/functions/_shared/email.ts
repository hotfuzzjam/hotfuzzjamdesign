// Email templates + sending (Resend) for HOTFUZZJAM Studio.
// Env: RESEND_API_KEY, MAIL_FROM, STUDIO_ADDRESS, ARRIVAL_NOTE, SITE_URL
import { dollars, env, fDate, fTime, manageUrl, SITE_URL } from "./util.ts";

export type Booking = {
  id: string; room_id: string; starts_at: string; ends_at: string; band_name: string | null;
  contact_email: string | null; contact_name?: string | null; manage_token: string;
  amount_cents?: number; discount_cents?: number; gift_applied_cents?: number; due_cents?: number;
  paid_cents?: number; refunded_cents?: number; pay_mode?: string; payment_status?: string;
  coupon_code?: string | null; rooms?: { name: string; rate_cents: number } | null;
};
type Kind = "confirmation" | "reminder" | "rescheduled" | "cancelled" | "followup";

const C = { ground: "#F2E9E3", ink: "#24150F", ink2: "#6A4D43", rule: "#E2CFC4", accent: "#9A3A21" };
const font = "Montserrat,Helvetica,Arial,sans-serif";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function icsStamp(iso: string) { return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
function icsEsc(s: string) { return s.replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n"); }
export function buildIcs(b: Booking, cancel = false) {
  const room = b.rooms?.name ?? "Rehearsal";
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//HOTFUZZJAM Studio//Bookings//EN", `METHOD:${cancel ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT", `UID:${b.id}@hotfuzzjam`, `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(b.starts_at)}`, `DTEND:${icsStamp(b.ends_at)}`,
    `SUMMARY:${icsEsc(`HOTFUZZJAM — ${room}${b.band_name ? ` (${b.band_name})` : ""}`)}`,
    `LOCATION:${icsEsc(env("STUDIO_ADDRESS", "Gold Coast, QLD"))}`,
    `DESCRIPTION:${icsEsc(`Change or cancel: ${manageUrl(b.manage_token)}`)}`,
    ...(cancel ? ["STATUS:CANCELLED"] : ["BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY", "DESCRIPTION:Rehearsal in 2 hours", "END:VALARM"]),
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}

function row(k: string, v: string) {
  return `<tr><td style="padding:12px 0;border-bottom:1px solid ${C.rule};font:400 11px/1.4 ${font};letter-spacing:.2em;text-transform:uppercase;color:${C.ink2}">${k}</td><td style="padding:12px 0;border-bottom:1px solid ${C.rule};text-align:right;font:300 15px/1.4 ${font};color:${C.ink}">${v}</td></tr>`;
}
function button(href: string, label: string, ghost = false) {
  return `<a href="${href}" style="display:inline-block;margin:0 10px 10px 0;padding:14px 22px;font:400 11px/1 ${font};letter-spacing:.22em;text-transform:uppercase;text-decoration:none;${ghost ? `color:${C.ink};border:1px solid ${C.ink}` : `color:${C.ground};background:${C.ink};border:1px solid ${C.ink}`}">${label}</a>`;
}
export function layout(o: { heading: string; lede: string; rows?: string; body?: string; buttons?: string; foot?: string }) {
  return `<!doctype html><html><body style="margin:0;background:${C.ground}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.ground}"><tr><td align="center" style="padding:56px 20px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
      <tr><td style="font:400 11px/1 ${font};letter-spacing:.34em;color:${C.accent};padding-bottom:56px">HOTFUZZJAM STUDIO</td></tr>
      <tr><td style="font:700 40px/1 'Helvetica Neue',Helvetica,Arial,sans-serif;letter-spacing:-.01em;text-transform:uppercase;color:${C.ink};padding-bottom:16px">${o.heading}</td></tr>
      <tr><td style="font:300 16px/1.6 ${font};color:${C.ink2};padding-bottom:32px">${o.lede}</td></tr>
      ${o.rows ? `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${o.rows}</table></td></tr>` : ""}
      ${o.body ? `<tr><td style="font:300 15px/1.6 ${font};color:${C.ink};padding-top:28px">${o.body}</td></tr>` : ""}
      ${o.buttons ? `<tr><td style="padding-top:28px">${o.buttons}</td></tr>` : ""}
      <tr><td style="font:300 13px/1.6 ${font};color:${C.ink2};padding-top:28px">${o.foot ?? ""}</td></tr>
      <tr><td style="font:400 11px/1.6 ${font};letter-spacing:.14em;text-transform:uppercase;color:${C.ink2};padding-top:40px">${esc(env("STUDIO_ADDRESS", "Gold Coast, QLD"))}</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function sessionRows(b: Booking) {
  const lines = [
    row("Room", esc(b.rooms?.name ?? "The Room")),
    row("Day", fDate.format(new Date(b.starts_at))),
    row("Time", `${fTime.format(new Date(b.starts_at))} – ${fTime.format(new Date(b.ends_at))}`),
  ];
  if (b.band_name) lines.push(row("Band", esc(b.band_name)));
  if (b.amount_cents) {
    lines.push(row("Session", dollars(b.amount_cents)));
    if (b.discount_cents) lines.push(row(`Code ${esc(b.coupon_code ?? "")}`, `−${dollars(b.discount_cents)}`));
    if (b.gift_applied_cents) lines.push(row("Gift card", `−${dollars(b.gift_applied_cents)}`));
    if (b.paid_cents) lines.push(row("Paid online", dollars(b.paid_cents)));
    const balance = Math.max(0, (b.due_cents ?? 0) - (b.paid_cents ?? 0));
    lines.push(row(balance ? "Pay at the studio" : "Balance", balance ? dollars(balance) : "Nothing to pay"));
  }
  return lines.join("");
}

export function bookingEmail(kind: Kind, b: Booking, cutoffHours = 24) {
  const when = `${fDate.format(new Date(b.starts_at))}, ${fTime.format(new Date(b.starts_at))}`;
  const manage = manageUrl(b.manage_token);
  const arrival = esc(env("ARRIVAL_NOTE", "Arrive 10 minutes early to load in."));
  const policy = `Change or cancel free of charge up to ${cutoffHours} hours before. Inside ${cutoffHours} hours, online payments aren't refunded.`;
  switch (kind) {
    case "confirmation": return {
      subject: `Booked: ${when}`, ics: buildIcs(b),
      html: layout({ heading: "You're booked.", lede: "Your session is confirmed. The calendar file is attached.", rows: sessionRows(b), body: arrival,
        buttons: button(manage, "Change or cancel", true), foot: policy }),
    };
    case "reminder": return {
      subject: `Reminder: rehearsal ${when}`, ics: buildIcs(b),
      html: layout({ heading: "Tomorrow, you play.", lede: "A reminder that your session is coming up in about 24 hours.", rows: sessionRows(b), body: arrival,
        buttons: button(manage, "Change or cancel", true), foot: policy }),
    };
    case "rescheduled": return {
      subject: `Moved: rehearsal now ${when}`, ics: buildIcs(b),
      html: layout({ heading: "Session moved.", lede: "Your session has a new time. The updated calendar file is attached.", rows: sessionRows(b),
        buttons: button(manage, "Manage booking", true), foot: policy }),
    };
    case "cancelled": return {
      subject: `Cancelled: ${when}`, ics: buildIcs(b, true),
      html: layout({ heading: "Session cancelled.", lede: b.refunded_cents ? `We've refunded ${dollars(b.refunded_cents)} to your card. It can take 5–10 business days to appear.` : "Your session has been cancelled.",
        rows: sessionRows(b), buttons: button(`${SITE_URL()}/#book`, "Book another time") }),
    };
    case "followup": return {
      subject: "Thanks for playing at HOTFUZZJAM",
      html: layout({ heading: "Thanks for the noise.", lede: "Hope the session moved the songs forward. Same time next week?",
        buttons: button(`${SITE_URL()}/#book`, "Book your next session") + button(`${SITE_URL()}/#gifts`, "Gift a session", true),
        foot: "Reply to this email if anything in the room needs our attention." }),
    };
  }
}

export function waitlistEmail(name: string | null, day: string, times: string[]) {
  return {
    subject: `A slot opened up on ${day}`,
    html: layout({ heading: "A slot just opened.", lede: `${name ? esc(name) + ", s" : "S"}omething freed up on ${esc(day)}: ${times.map(esc).join(", ")}. First to book gets it.`,
      buttons: button(`${SITE_URL()}/#book`, "Book it now") }),
  };
}

export function giftEmail(g: { code: string; initial_cents: number; recipient_name?: string | null; purchaser_name?: string | null; message?: string | null }, to: "recipient" | "purchaser") {
  const msg = g.message ? `<p style="margin:0 0 18px;font-style:italic">“${esc(g.message)}”${g.purchaser_name ? ` — ${esc(g.purchaser_name)}` : ""}</p>` : "";
  const codeBlock = `<p style="margin:0;font:400 12px/1 ${font};letter-spacing:.24em;text-transform:uppercase;color:${C.ink2}">Your code</p>
    <p style="margin:10px 0 0;font:700 30px/1.1 'Helvetica Neue',Helvetica,Arial,sans-serif;letter-spacing:.06em;color:${C.ink}">${g.code}</p>`;
  return to === "recipient"
    ? { subject: `${g.purchaser_name ? esc(g.purchaser_name) : "Someone"} sent you studio time at HOTFUZZJAM`,
        html: layout({ heading: "Room to be loud.", lede: `${g.recipient_name ? esc(g.recipient_name) + ", y" : "Y"}ou've been given ${dollars(g.initial_cents)} of rehearsal time.`,
          body: msg + codeBlock, buttons: button(`${SITE_URL()}/#book`, "Book a session"), foot: "Enter the code when you book. Any balance stays on the card for next time." }) }
    : { subject: `Your HOTFUZZJAM gift card: ${dollars(g.initial_cents)}`,
        html: layout({ heading: "Gift card ready.", lede: `Thanks for the purchase. Here's the ${dollars(g.initial_cents)} gift card${g.recipient_name ? ` for ${esc(g.recipient_name)}` : ""}.`,
          body: msg + codeBlock, foot: "Forward this email or share the code. It's redeemable on any booking." }) };
}

export async function sendEmail(to: string, m: { subject: string; html: string; ics?: string }) {
  const key = env("RESEND_API_KEY");
  if (!key) throw new Error("Email isn't set up (RESEND_API_KEY missing).");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env("MAIL_FROM", "HOTFUZZJAM Studio <bookings@hotfuzzjam.com>"), to: [to], subject: m.subject, html: m.html,
      ...(m.ics ? { attachments: [{ filename: "hotfuzzjam-session.ics", content: btoa(unescape(encodeURIComponent(m.ics))) }] } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

/** Send a booking email and stamp the matching column; never throws. */
export async function notify(db: any, kind: Kind, b: Booking, cutoff = 24, stamp?: string) {
  try {
    if (!b.contact_email) return false;
    await sendEmail(b.contact_email, bookingEmail(kind, b, cutoff)!);
    if (stamp) await db.from("bookings").update({ [stamp]: new Date().toISOString() }).eq("id", b.id);
    return true;
  } catch (e) { console.error(`notify ${kind}`, b.id, String(e)); return false; }
}

export const BOOKING_SELECT = "id, room_id, starts_at, ends_at, status, band_name, contact_email, contact_name, manage_token, amount_cents, discount_cents, gift_applied_cents, due_cents, charge_now_cents, paid_cents, refunded_cents, pay_mode, payment_status, coupon_code, gift_code, stripe_session_id, stripe_payment_intent, sms_opt_in, phone, reschedule_count, user_id, rooms(name, rate_cents)";
