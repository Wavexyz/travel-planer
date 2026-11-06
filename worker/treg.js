/* treg: catalog endpoints with the provider key injected on treg's side.
   GET https://treg.to/call/<endpoint>?<params> with X-Treg-Token (+ X-Treg-Org).
   Identical calls are cached for 30 minutes so a retry or "back" costs nothing. */
import { HttpError } from "./util.js";

const BASE = "https://treg.to/call/";
const TTL = 1800;

/* params: undefined/null values are left out; "" is sent as an empty value (treg requires some
   parameters to be present even where the provider wants them blank, e.g. multi-city flights). */
export async function tregGet(env, ctx, endpoint, params) {
  if (!env.TREG_TOKEN) throw new HttpError(503, "The treg token is not configured on the server.");
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  qs.sort();
  const url = BASE + endpoint + "?" + qs;
  const cache = caches.default, cacheKey = new Request("https://cache.trip-planner.internal/" + endpoint + "?" + qs);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  const headers = { "X-Treg-Token": env.TREG_TOKEN };
  if (env.TREG_ORG) headers["X-Treg-Org"] = env.TREG_ORG;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new HttpError(502, "The travel data service returned an unreadable answer."); }
  if (!res.ok || data?.error) {
    const msg = typeof data?.detail === "string" ? data.detail : data?.detail?.error || data?.error || "HTTP " + res.status;
    throw new HttpError(502, "Travel data lookup failed: " + String(msg).slice(0, 200));
  }
  ctx.waitUntil(cache.put(cacheKey, new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${TTL}` } })));
  return data;
}
