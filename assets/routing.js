"use strict";
/* Real travel paths and times.
   - Walking and driving: OSRM (routing.openstreetmap.de), GeoJSON geometry.
   - Trains, buses, subways, ferries: Transitous (MOTIS), which returns the
     actual legs of a journey, including the walk to/from the station.
   Everything is cached in localStorage so re-opening a day is instant and
   works offline after the first successful lookup. If a request fails we
   return an estimate plus a straight line, flagged as approximate.
*/
(() => {
const OSRM = {
  walk: "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
  car: "https://routing.openstreetmap.de/routed-car/route/v1/driving",
};
const TRANSIT = "https://api.transitous.org/api/v1/plan";
const CACHE_KEY = "trip-route-cache-v4";
const MAX_CACHE = 140;
const cache = new Map();

try {
  const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
  if (Array.isArray(saved)) saved.forEach(([k, v]) => cache.set(k, v));
} catch {}

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      localStorage.setItem(CACHE_KEY, JSON.stringify([...cache]));
    } catch {}
  }, 600);
}
function cached(key) { return cache.get(key); }
function remember(key, value) {
  cache.set(key, value); persist(); return value;
}

/* Transit routing needs a street/stop near the destination. Temples and castles
   often have none, so when a direct transit query fails we snap to a nearby
   station, route station-to-station and add real walking legs at both ends. */
const STATIONS = [
  { name: "Kintetsu Nara", lat: 34.6834, lng: 135.8273 },
  { name: "JR Nara", lat: 34.6808, lng: 135.8185 },
  { name: "Himeji", lat: 34.8274, lng: 134.6908 },
  { name: "Horyuji", lat: 34.6014, lng: 135.7392 },
  { name: "Kyoto", lat: 34.9858, lng: 135.7589 },
  { name: "Kawaguchiko", lat: 35.4982, lng: 138.7688 },
  { name: "Shinjuku", lat: 35.6896, lng: 139.7006 },
  { name: "Ueno", lat: 35.7141, lng: 139.7774 },
  { name: "Tokyo", lat: 35.6812, lng: 139.7671 },
  { name: "Mishima", lat: 35.1260, lng: 138.9110 },
  { name: "Nagoya", lat: 35.1709, lng: 136.8815 },
  { name: "Osaka", lat: 34.7025, lng: 135.4959 },
  { name: "Shin-Osaka", lat: 34.7330, lng: 135.5000 },
  { name: "Odawara", lat: 35.2560, lng: 139.1550 },
];

const R = 6371000;
function rad(d) { return d * Math.PI / 180; }
function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const SPEED = { walk: 78, car: 470, bus: 270, rail: 750, flight: 13300 };
const WAIT = { walk: 0, car: 2, bus: 5, rail: 8, flight: 60 };
function nearestStation(p) {
  let best = null, bestD = Infinity;
  for (const st of STATIONS) {
    const d = haversine(p, st);
    if (d < bestD) { bestD = d; best = st; }
  }
  return best && bestD <= 4000 ? { ...best, dist: bestD } : null;
}
function addMinutes(iso, mins) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  d.setMinutes(d.getMinutes() + Math.round(mins));
  return d.toISOString();
}
function sumLegs(legs) {
  return {
    duration: legs.reduce((s, l) => s + (l.duration || 0), 0),
    distance: legs.reduce((s, l) => s + (l.distance || 0), 0),
  };
}
function estimate(kind, meters) {
  return Math.max(1, Math.round(meters / (SPEED[kind] || SPEED.walk) + (WAIT[kind] || 0)));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Transitous is a shared community service: keep two requests in flight and
   leave a small gap between them. Bursts get rejected without CORS headers. */
let transitActive = 0;
const transitQueue = [];
function pumpTransit() {
  while (transitActive < 2 && transitQueue.length) {
    const job = transitQueue.shift();
    transitActive++;
    getJSON(job.url, 18000).then(job.resolve, job.reject).finally(() => {
      transitActive--;
      setTimeout(pumpTransit, 220);
    });
  }
}
function transitRequest(url) {
  return new Promise((resolve, reject) => {
    transitQueue.push({ url, resolve, reject });
    pumpTransit();
  });
}

async function getJSON(url, ms = 14000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/* Standard encoded polyline (MOTIS uses precision 7). */
function decodePolyline(str, precision = 7) {
  let i = 0, lat = 0, lng = 0;
  const out = [], factor = 10 ** precision;
  // Use Number arithmetic, not 32-bit bitwise ops: lat/lng scaled by 1e7
  // overflow signed 32-bit integers (e.g. Tokyo's longitude).
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

function classify(mode) {
  const m = String(mode || "").toUpperCase();
  if (m === "WALK" || m === "BIKE") return "walk";
  if (m === "BUS" || m === "COACH") return "bus";
  if (m === "CAR" || m === "TAXI") return "car";
  if (m === "FLIGHT") return "flight";
  return "rail";
}

function straight(a, b) { return [[a.lng, a.lat], [b.lng, b.lat]]; }
function lineLength(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) {
    m += haversine({ lat: coords[i - 1][1], lng: coords[i - 1][0] }, { lat: coords[i][1], lng: coords[i][0] });
  }
  return m;
}
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
  const mins = estimate(kind === "taxi" ? "car" : kind, meters);
  return {
    legs: [{ kind: kind === "taxi" ? "car" : kind, coordinates: kind === "flight" ? greatCircle(from, to) : straight(from, to), duration: mins, distance: meters, approximate: true }],
    duration: mins, distance: meters, approximate: true, source: "fallback", reason,
  };
}

async function osrm(kind, from, to) {
  const base = kind === "car" ? OSRM.car : OSRM.walk;
  const url = `${base}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=false`;
  const j = await getJSON(url);
  if (j.code !== "Ok" || !j.routes?.[0]) throw new Error(j.code || "no route");
  const r = j.routes[0];
  return {
    legs: [{ kind: kind === "car" ? "car" : "walk", coordinates: r.geometry.coordinates, duration: r.duration / 60, distance: r.distance, mode: kind }],
    duration: r.duration / 60, distance: r.distance, approximate: false, source: "osrm",
  };
}

async function transitDirect(from, to, departISO) {
  const url = `${TRANSIT}?fromPlace=${from.lat},${from.lng}&toPlace=${to.lat},${to.lng}&time=${encodeURIComponent(departISO)}`;
  let last;
  let j;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { j = await transitRequest(url); break; }
    catch (e) { last = e; if (attempt === 0) await sleep(700); }
  }
  if (!j) throw last || new Error("transit unavailable");
  const it = j.itineraries?.[0];
  if (!it) throw new Error("no itinerary");
  const legs = [];
  for (const leg of it.legs || []) {
    const pg = leg.legGeometry;
    if (!pg?.points) continue;
    let coords = decodePolyline(pg.points, pg.precision ?? 7);
    if (coords.length < 2) continue;
    // Guard against an unexpected lat/lon order by checking the endpoints.
    if (haversine({ lat: coords[0][1], lng: coords[0][0] }, { lat: from.lat, lng: from.lng }) > 5000 &&
        haversine({ lat: coords[0][0], lng: coords[0][1] }, { lat: from.lat, lng: from.lng }) < 5000) {
      coords = coords.map(([x, y]) => [y, x]);
    }
    legs.push({
      kind: classify(leg.mode),
      coordinates: coords,
      duration: (leg.duration || 0) / 60,
      distance: leg.distance || lineLength(coords),
      mode: leg.mode,
      line: leg.routeShortName || leg.tripShortName || leg.routeLongName || "",
      from: leg.from?.name || "",
      to: leg.to?.name || "",
    });
  }
  if (!legs.length) throw new Error("empty itinerary");
  return {
    legs,
    duration: (it.duration || legs.reduce((s, l) => s + l.duration, 0)) / 60,
    distance: legs.reduce((s, l) => s + l.distance, 0),
    approximate: false, source: "transitous",
    startTime: it.startTime, endTime: it.endTime, transfers: it.transfers,
  };
}

async function transit(from, to, departISO) {
  try {
    return await transitDirect(from, to, departISO);
  } catch (err) {
    const a = nearestStation(from), b = nearestStation(to);
    if (!a || !b || a.name === b.name) throw err;
    try {
      const walkA = a.dist > 120 ? await osrm("walk", from, a) : null;
      const dep = addMinutes(departISO, walkA ? walkA.duration : 0);
      const mid = await transitDirect(a, b, dep);
      const walkB = b.dist > 120 ? await osrm("walk", b, to) : null;
      const legs = [...(walkA?.legs || []), ...mid.legs, ...(walkB?.legs || [])];
      const sum = sumLegs(legs);
      return { legs, duration: sum.duration, distance: sum.distance, approximate: false, source: "transitous+walk" };
    } catch {
      throw err;
    }
  }
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
    let out;
    if (kind === "walk" || kind === "car") out = await osrm(kind, from, to);
    else out = await transit(from, to, departISO || new Date().toISOString());
    return remember(key, out);
  } catch (err) {
    // A bus still runs on roads. If the timetable service cannot route it,
    // use the road route so the map shows a real path rather than a straight line.
    if (kind === "bus") {
      try {
        const r = await osrm("car", from, to);
        r.legs.forEach(l => { l.kind = "bus"; l.mode = "BUS"; });
        r.source = "osrm-road";
        r.approximate = false;
        return remember(key, r);
      } catch {}
    }
    // Don't cache failures: the next attempt may succeed when the service recovers.
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
  routeLeg, travel, haversine, estimate, classify, decodePolyline,
  isOnline: () => navigator.onLine !== false,
};
})();
