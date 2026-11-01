// Cheapest fuel near a point, for the /dash in-cab page.
// Source: NSW Government FuelCheck API (covers NSW and Tasmania), free key from api.nsw.gov.au.
// Deploy with JWT verification OFF. Secrets: NSW_FUEL_API_KEY, NSW_FUEL_API_SECRET.
// Self-contained on purpose: it shares nothing with the booking functions.

const BASE = "https://api.onegov.nsw.gov.au";
const FUELS = new Set(["DL", "PDL"]); // diesel, premium diesel
const CACHE_MS = 3 * 60 * 1000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (message: string, status = 400, code?: string) => json({ error: message, code }, status);

let token = "";
let tokenExpires = 0;
const cache = new Map<string, { at: number; body: unknown }>();

async function accessToken(key: string, secret: string) {
  if (token && Date.now() < tokenExpires) return token;
  const r = await fetch(`${BASE}/oauth/client_credential/accesstoken?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${btoa(`${key}:${secret}`)}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("token");
  token = j.access_token;
  tokenExpires = Date.now() + Math.max(300, (Number(j.expires_in) || 3600) - 300) * 1000;
  return token;
}

// FuelCheck wants "dd/MM/yyyy hh:mm:ss AM" in UTC
function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  const h = d.getUTCHours();
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(h % 12 || 12)}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${h >= 12 ? "PM" : "AM"}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("Use POST.", 405);

  const key = Deno.env.get("NSW_FUEL_API_KEY"), secret = Deno.env.get("NSW_FUEL_API_SECRET");
  if (!key || !secret) return fail("Fuel prices aren't connected yet.", 503, "not_configured");

  // deno-lint-ignore no-explicit-any
  let b: any; try { b = await req.json(); } catch { return fail("Bad request."); }
  const lat = Number(b.lat), lng = Number(b.lng);
  const radius = Math.min(70, Math.max(1, Math.round(Number(b.radius) || 70)));
  const fuel = FUELS.has(b.fuel) ? b.fuel : "DL";
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail("Send lat and lng.");
  // NSW + ACT + Tasmania bounding box; anything else FuelCheck can't answer
  if (lat > -28 || lat < -44 || lng < 140.9 || lng > 154) return fail("FuelCheck covers NSW and Tasmania only.", 422, "out_of_area");

  const ck = `${fuel}:${lat.toFixed(2)}:${lng.toFixed(2)}:${radius}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_MS) return json(hit.body);

  try {
    const t = await accessToken(key, secret);
    const r = await fetch(`${BASE}/FuelPriceCheck/v2/fuel/prices/nearby`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${t}`,
        transactionid: crypto.randomUUID(),
        requesttimestamp: stamp(),
      },
      body: JSON.stringify({
        fueltype: fuel, latitude: String(lat), longitude: String(lng),
        radius: String(radius), sortby: "Price", sortascending: "true",
      }),
    });
    if (r.status === 401) { token = ""; return fail("FuelCheck refused the key. Check the secrets.", 502, "auth"); }
    if (!r.ok) return fail("FuelCheck didn't answer. Try again shortly.", 502, "upstream");
    const data = await r.json();

    // deno-lint-ignore no-explicit-any
    const byCode = new Map<string, any>((data.stations ?? []).map((s: any) => [String(s.code), s]));
    const stations = (data.prices ?? [])
      // deno-lint-ignore no-explicit-any
      .map((p: any) => {
        const s = byCode.get(String(p.stationcode));
        if (!s || !(p.price > 0)) return null;
        return {
          name: s.name, brand: s.brand, address: s.address,
          lat: s.location?.latitude, lng: s.location?.longitude,
          distance_km: Number(s.location?.distance) || null,
          cents: Number(p.price), updated: p.lastupdated ?? null,
        };
      })
      .filter(Boolean)
      // deno-lint-ignore no-explicit-any
      .filter((s: any) => s.distance_km == null || s.distance_km <= radius)
      // deno-lint-ignore no-explicit-any
      .sort((a: any, b: any) => a.cents - b.cents || (a.distance_km ?? 0) - (b.distance_km ?? 0))
      .slice(0, 5);

    const body = { fuel, radius, stations, fetched_at: new Date().toISOString() };
    cache.set(ck, { at: Date.now(), body });
    if (cache.size > 500) cache.clear();
    return json(body);
  } catch {
    return fail("Couldn't reach FuelCheck. Try again shortly.", 502, "upstream");
  }
});
