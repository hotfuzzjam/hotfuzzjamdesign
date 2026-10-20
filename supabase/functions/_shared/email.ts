// Shared email + calendar helpers for HOTFUZZJAM Studio (Resend).
// Env: RESEND_API_KEY, MAIL_FROM, STUDIO_ADDRESS, ARRIVAL_NOTE, SITE_URL

export type Booking = {
  id: string;
  room_id: string;
  starts_at: string;
  ends_at: string;
  band_name: string | null;
  contact_email: string | null;
  rooms?: { name: string; rate_cents: number } | null;
};

const TZ = "Australia/Brisbane";
const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const fDate = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const fTime = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

function icsStamp(iso: string) {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function esc(s: string) {
  return s.replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
}
export function buildIcs(b: Booking) {
  const room = b.rooms?.name ?? "Rehearsal";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//HOTFUZZJAM Studio//Bookings//EN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${b.id}@hotfuzzjam`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(b.starts_at)}`,
    `DTEND:${icsStamp(b.ends_at)}`,
    `SUMMARY:${esc(`HOTFUZZJAM — ${room}${b.band_name ? ` (${b.band_name})` : ""}`)}`,
    `LOCATION:${esc(env("STUDIO_ADDRESS", "Gold Coast, QLD"))}`,
    `DESCRIPTION:${esc(env("ARRIVAL_NOTE", "Arrive 10 minutes early to load in."))}`,
    "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY", "DESCRIPTION:Rehearsal in 2 hours", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

function html(kind: "confirmation" | "reminder", b: Booking) {
  const room = b.rooms?.name ?? "Rehearsal room";
  const hrs = Math.round((+new Date(b.ends_at) - +new Date(b.starts_at)) / 36e5);
  const total = b.rooms ? `$${((b.rooms.rate_cents * hrs) / 100).toFixed(0)}` : "";
  const heading = kind === "confirmation" ? "You're booked." : "Tomorrow, you play.";
  const lede = kind === "confirmation"
    ? "Your session is confirmed. The calendar file is attached."
    : "A reminder that your session is coming up in about 24 hours.";
  const row = (k: string, v: string) =>
    `<tr><td style="padding:12px 0;border-bottom:1px solid #E2CFC4;font:400 11px/1.4 Montserrat,Helvetica,Arial,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#6A4D43">${k}</td><td style="padding:12px 0;border-bottom:1px solid #E2CFC4;text-align:right;font:300 15px/1.4 Montserrat,Helvetica,Arial,sans-serif;color:#24150F">${v}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#F2E9E3">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2E9E3"><tr><td align="center" style="padding:56px 20px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
      <tr><td style="font:400 11px/1 Montserrat,Helvetica,Arial,sans-serif;letter-spacing:.34em;color:#9A3A21;padding-bottom:64px">HOTFUZZJAM STUDIO</td></tr>
      <tr><td style="font:300 40px/1.05 Montserrat,Helvetica,Arial,sans-serif;letter-spacing:-.03em;color:#24150F;padding-bottom:16px">${heading}</td></tr>
      <tr><td style="font:300 16px/1.6 Montserrat,Helvetica,Arial,sans-serif;color:#6A4D43;padding-bottom:40px">${lede}</td></tr>
      <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${row("Room", room)}
        ${row("Day", fDate.format(new Date(b.starts_at)))}
        ${row("Time", `${fTime.format(new Date(b.starts_at))} – ${fTime.format(new Date(b.ends_at))}`)}
        ${b.band_name ? row("Band", b.band_name) : ""}
        ${total ? row("Total, incl. GST", total) : ""}
        ${row("Where", env("STUDIO_ADDRESS", "Gold Coast, QLD"))}
      </table></td></tr>
      <tr><td style="font:300 14px/1.6 Montserrat,Helvetica,Arial,sans-serif;color:#24150F;padding-top:32px">${env("ARRIVAL_NOTE", "Arrive 10 minutes early to load in. Pay at the studio on arrival.")}</td></tr>
      <tr><td style="font:300 13px/1.6 Montserrat,Helvetica,Arial,sans-serif;color:#6A4D43;padding-top:24px">Need to cancel? Sign in at <a href="${env("SITE_URL", "#")}#book" style="color:#9A3A21">${env("SITE_URL", "our site").replace(/^https?:\/\//, "")}</a> up to 24 hours before.</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

export async function sendBookingEmail(kind: "confirmation" | "reminder", b: Booking) {
  if (!b.contact_email) throw new Error("Booking has no contact email");
  const when = `${fDate.format(new Date(b.starts_at))}, ${fTime.format(new Date(b.starts_at))}`;
  const subject = kind === "confirmation" ? `Booked: ${b.rooms?.name ?? "HOTFUZZJAM"} — ${when}` : `Reminder: rehearsal ${when}`;
  const ics = btoa(unescape(encodeURIComponent(buildIcs(b))));
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env("MAIL_FROM", "HOTFUZZJAM Studio <bookings@hotfuzzjam.com.au>"),
      to: [b.contact_email],
      subject,
      html: html(kind, b),
      attachments: [{ filename: "hotfuzzjam-session.ics", content: ics }],
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
