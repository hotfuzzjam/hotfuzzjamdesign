// Shared helpers for HOTFUZZJAM Studio edge functions.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (provided by Supabase)
//      SITE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export const env = (k: string, d = "") => Deno.env.get(k) ?? d;
export const SITE_URL = () => env("SITE_URL", "https://hotfuzzjam.com").replace(/\/$/, "");
export const TZ = "Australia/Brisbane";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
export const fail = (message: string, status = 400, code?: string) => json({ error: message, code }, status);

// untyped on purpose: no generated DB types, and embedded rows (rooms) come back as objects at runtime
// deno-lint-ignore no-explicit-any
export const admin = (): any =>
  createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

/** The signed-in caller (from the request's JWT), or null. */
export async function caller(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const c = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data } = await c.auth.getUser();
  return data.user ?? null;
}

export type Settings = {
  open_hour: number; close_hour: number; max_hours: number; days_ahead: number; cancel_cutoff_hours: number;
  payment_mode: "full" | "deposit" | "choice" | "on_arrival"; deposit_pct: number; hold_minutes: number;
  followup_delay_hours: number; sms_enabled: boolean;
};
// deno-lint-ignore no-explicit-any
export async function settings(db: any): Promise<Settings> {
  const { data, error } = await db.from("settings").select("*").eq("id", 1).single();
  if (error) throw error;
  return data as Settings;
}

// ---------- Stripe (REST, no SDK) ----------
function form(obj: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) form(v as Record<string, unknown>, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) =>
      typeof item === "object" ? form(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item)));
    else out.append(key, String(v));
  }
  return out;
}
export async function stripe(path: string, params: Record<string, unknown>, idempotencyKey?: string) {
  const key = env("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Online payments aren't set up yet (STRIPE_SECRET_KEY missing).");
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: form(params),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Stripe: ${body?.error?.message ?? res.status}`);
  return body;
}
export const stripeEnabled = () => !!env("STRIPE_SECRET_KEY");

/** Verify a Stripe webhook signature (v1, HMAC-SHA256, 5-minute tolerance). */
export async function verifyStripe(raw: string, header: string | null) {
  const secret = env("STRIPE_WEBHOOK_SECRET");
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]).filter((p) => p.length === 2));
  const t = parts.t; if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${raw}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === hex.length && timingSafeEqual(s, hex));
}
function timingSafeEqual(a: string, b: string) { let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

// ---------- SMS (Twilio) ----------
/** Normalise an Australian mobile ("0412 345 678", "+61 412…") to E.164, or null. */
export function toE164(raw?: string | null): string | null {
  if (!raw) return null;
  let p = raw.replace(/[^\d+]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (/^04\d{8}$/.test(p)) p = "+61" + p.slice(1);
  if (/^4\d{8}$/.test(p)) p = "+61" + p;
  if (/^61\d{9}$/.test(p)) p = "+" + p;
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}
export async function sendSms(to: string, body: string) {
  const sid = env("TWILIO_ACCOUNT_SID"), tok = env("TWILIO_AUTH_TOKEN"), from = env("TWILIO_FROM");
  if (!sid || !tok || !from) throw new Error("SMS isn't set up (Twilio secrets missing).");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
}

// ---------- formatting ----------
export const fDate = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
export const fShort = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
export const fTime = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
export const dollars = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
export const hoursBetween = (a: string, b: string) => Math.round((+new Date(b) - +new Date(a)) / 36e5);
export const manageUrl = (token: string) => `${SITE_URL()}/?manage=${token}`;

export function giftCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const r = crypto.getRandomValues(new Uint8Array(8));
  const s = [...r].map((n) => a[n % a.length]).join("");
  return `HFJ-${s.slice(0, 4)}-${s.slice(4)}`;
}
