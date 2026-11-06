"use strict";
/* Real travel paths and times from the Google Routes API.
   - Walking and driving: one route with its road geometry.
   - Trains, buses, subways, ferries: the transit legs of the journey,
     including the walks to and from the stops.
   Results are cached for this browser session only. If a request fails we
   return an estimate plus a straight line, flagged as approximate.
*/
(() => {
const ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes";
const CACHE_KEY = "trip-route-session-v1";
const MAX_CACHE = 300;
const FIELDS = [
  "routes.duration", "routes.distanceMeters", "routes.polyline.encodedPolyline",
  "routes.legs.steps.travelMode", "routes.legs.steps.distanceMeters", "routes.legs.steps.staticDuration",
  "routes.legs.steps.polyline.encodedPolyline",
  "routes.legs.steps.transitDetails.transitLine.nameShort", "routes.legs.steps.transitDetails.transitLine.name",
  "routes.legs.steps.transitDetails.transitLine.vehicle.type",
  "routes.legs.steps.transitDetails.stopDetails.departureStop.name", "routes.legs.steps.transitDetails.stopDetails.arrivalStop.name",
].join(",");
const cache = new Map();

try {
  const saved = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "[]");
  if (Array.isArray(saved)) saved.forEach(([k, v]) => cache.set(k, v));
} catch {}

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      sessionStorage.setItem(CACHE_KEY, JSON.stringify([...cache]));
    } catch {}
  }, 600);
}
function cached(key) { return cache.get(key); }
function remember(key, value) {
  cache.set(key, value); persist(); return value;
}

const R = 6371000;
function rad(d) { return d * Math.PI / 180; }
function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const SPEED = { walk: 78, car: 470, bus: 270, rail: 750, flight: 13300 };
const WAIT = { walk: 0, car: 2, bus: 5, rail: 8, flight: 60 };
function estimate(kind, meters) {
  return Math.max(1, Math.round(meters / (SPEED[kind] || SPEED.walk) + (WAIT[kind] || 0)));
}

/* A local wall-clock time in an IANA zone, as RFC 3339 with that zone's offset. */
function zonedISO(date, time, tz) {
  const t = /^\d{2}:\d{2}$/.test(String(time || "")) ? time : "09:00";
  let off = "Z";
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz || undefined, timeZoneName: "longOffset" })
      .formatToParts(new Date(`${date}T${t}:00Z`)).find(p => p.type === "timeZoneName")?.value || "";
    const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
    if (m) off = `${m[1]}:${m[2] || "00"}`;
  } catch {}
  return `${date}T${t}:00${off}`;
}

/* Standard encoded polyline (Google uses precision 5). */
function decodePolyline(str, precision = 5) {
  let i = 0, lat = 0, lng = 0;
  const out = [], factor = 10 ** precision;
  // Number arithmetic, not 32-bit bitwise ops, so high-precision values cannot overflow.
  while (i < str.length) {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(i++) - 63; result += (b & 0x1f) * (2 ** shift); shift += 5; } while (b >= 0x20);
    lat += (result % 2) ? -((result + 1) / 2) : result / 2;
    result = 0; shift = 0;
    do { b = str.charCodeAt(i++) - 63; result += (b & 0x1f) * (2 ** shift); shift += 5; } while (b >= 0x20);
    lng += (result % 2) ? -((result + 1) / 2) : result / 2;
    out.push([lng / factor, lat / factor]);
  }
  return out;
}

function classify(step) {
  if (step.travelMode === "WALK") return "walk";
  if (step.travelMode === "DRIVE") return "car";
  const v = String(step.transitDetails?.transitLine?.vehicle?.type || "").toUpperCase();
  if (/BUS|TROLLEYBUS|SHARE_TAXI/.test(v)) return "bus";
  return "rail";
}
const seconds = d => parseFloat(String(d || "0").replace("s", "")) || 0;

function straight(a, b) { return [[a.lng, a.lat], [b.lng, b.lat]]; }
function greatCircle(a, b, n = 32) {
  const toVec = p => [Math.cos(rad(p.lat)) * Math.cos(rad(p.lng)), Math.cos(rad(p.lat)) * Math.sin(rad(p.lng)), Math.sin(rad(p.lat))];
  const A = toVec(a), B = toVec(b);
  const dot = Math.min(1, Math.max(-1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-6) return straight(a, b);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s1 = Math.sin((1 - t) * omega) / Math.sin(omega), s2 = Math.sin(t * omega) / Math.sin(omega);
    const x = s1 * A[0] + s2 * B[0], y = s1 * A[1] + s2 * B[1], z = s1 * A[2] + s2 * B[2];
    out.push([Math.atan2(y, x) * 180 / Math.PI, Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI]);
  }
  return out;
}

function fallback(kind, from, to, reason) {
  const meters = haversine(from, to);
  const mins = estimate(kind, meters);
  return {
    legs: [{ kind, coordinates: kind === "flight" ? greatCircle(from, to) : straight(from, to), duration: mins, distance: meters, approximate: true }],
    duration: mins, distance: meters, approximate: true, source: "fallback", reason,
  };
}

async function computeRoute(kind, from, to, departISO) {
  const key = window.TripGoogle?.key();
  if (!key) throw new Error("no key");
  const mode = kind === "walk" ? "WALK" : kind === "car" ? "DRIVE" : "TRANSIT";
  const body = {
    origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
    destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
    travelMode: mode,
  };
  if (mode === "TRANSIT") {
    // Transit can look up to 7 days back; anything older uses the current timetable.
    if (departISO && new Date(departISO) > Date.now() - 6 * 864e5) body.departureTime = new Date(departISO).toISOString();
    if (kind === "bus") body.transitPreferences = { allowedTravelModes: ["BUS"] };
  }
  const res = await fetch(ROUTES, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json())?.error?.message || ""; } catch {}
    if ([401, 403, 429].includes(res.status)) window.TripGoogle?.reportError("Routes API", msg || "HTTP " + res.status);
    throw new Error(msg || "HTTP " + res.status);
  }
  const j = await res.json();
  const r = j.routes?.[0];
  if (!r) throw new Error("no route");
  const legs = [];
  for (const step of (r.legs || []).flatMap(l => l.steps || [])) {
    const pts = step.polyline?.encodedPolyline ? decodePolyline(step.polyline.encodedPolyline) : [];
    if (pts.length < 2) continue;
    const k = mode === "TRANSIT" ? classify(step) : kind;
    const td = step.transitDetails;
    const prev = legs[legs.length - 1];
    // Merge runs of walking or driving steps into one leg; keep each transit ride separate.
    if (prev && prev.kind === k && !td && !prev.line) {
      prev.coordinates.push(...pts.slice(1));
      prev.duration += seconds(step.staticDuration) / 60;
      prev.distance += step.distanceMeters || 0;
      continue;
    }
    legs.push({
      kind: k, coordinates: pts,
      duration: seconds(step.staticDuration) / 60, distance: step.distanceMeters || 0,
      line: td?.transitLine?.nameShort || td?.transitLine?.name || "",
      from: td?.stopDetails?.departureStop?.name || "", to: td?.stopDetails?.arrivalStop?.name || "",
    });
  }
  if (!legs.length && r.polyline?.encodedPolyline) {
    legs.push({ kind, coordinates: decodePolyline(r.polyline.encodedPolyline), duration: seconds(r.duration) / 60, distance: r.distanceMeters || 0 });
  }
  if (!legs.length) throw new Error("empty route");
  return { legs, duration: seconds(r.duration) / 60, distance: r.distanceMeters || 0, approximate: false, source: "google" };
}

/**
 * Route one leg. `kind` is the intended mode: walk, car/taxi, bus, rail,
 * or flight. Returns { legs, duration (minutes), distance (metres), ... }.
 */
async function routeLeg({ kind, from, to, departISO }) {
  if (!from || !to || from.lat == null || to.lat == null) return null;
  kind = kind === "taxi" ? "car" : kind;
  if (kind === "flight") {
    const r = fallback("flight", from, to, "flight");
    r.approximate = false; r.schematic = true;
    return r;
  }
  const timeKey = departISO ? String(departISO).slice(0, 16) : "";
  const key = `${kind}|${from.lat.toFixed(5)},${from.lng.toFixed(5)}|${to.lat.toFixed(5)},${to.lng.toFixed(5)}|${timeKey}`;
  const hit = cached(key);
  if (hit) return hit;
  try {
    return remember(key, await computeRoute(kind, from, to, departISO));
  } catch (err) {
    // Where there is no transit data, a bus still runs on roads: show the road route.
    if (kind === "bus") {
      try {
        const r = await computeRoute("car", from, to);
        r.legs.forEach(l => { l.kind = "bus"; });
        r.source = "google-road";
        return remember(key, r);
      } catch {}
    }
    // Don't cache failures: the next attempt may succeed.
    return fallback(kind, from, to, err?.message || "unavailable");
  }
}

async function travel(kind, from, to, departISO) {
  const r = await routeLeg({ kind, from, to, departISO });
  if (!r) return null;
  return {
    kind, minutes: Math.max(1, Math.round(r.duration)), distance: Math.round(r.distance),
    approximate: r.approximate, source: r.source,
  };
}

window.TripRouting = {
  routeLeg, travel, haversine, estimate, decodePolyline, zonedISO,
  isOnline: () => navigator.onLine !== false,
};
})();
