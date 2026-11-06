"use strict";
/* Google Maps Platform: the map loader, Places API (New) lookups and photos.
   A trip stores only Google place ids and coordinates. Photos, ratings,
   addresses and reviews are fetched live and kept for this browser session. */
(() => {
const K_KEY = "google-maps-key";
const K_MAPID = "google-map-id";
const SESSION_KEY = "google-places-session-v1";
const PLACES = "https://places.googleapis.com/v1";
const BASIC = "id,displayName,formattedAddress,location,rating,userRatingCount,photos,primaryTypeDisplayName,googleMapsUri";
const FULL = BASIC + ",editorialSummary,reviews";

const key = () => localStorage.getItem(K_KEY) || "";
const mapId = () => localStorage.getItem(K_MAPID) || "DEMO_MAP_ID";

/* ---------- Session cache ---------- */
const cache = new Map();
try {
  const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "[]");
  if (Array.isArray(saved)) saved.forEach(([k, v]) => cache.set(k, v));
} catch {}
let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify([...cache])); } catch {}
  }, 400);
}

/* ---------- Maps JavaScript API ---------- */
let mapsPromise = null;
function loadMaps() {
  if (window.google?.maps?.importLibrary) return Promise.resolve(google.maps);
  if (!key()) return Promise.reject(new Error("no-key"));
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    const cb = "__tripMapsReady";
    window[cb] = () => { delete window[cb]; resolve(google.maps); };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key())}&v=weekly&loading=async&callback=${cb}`;
    s.async = true;
    s.onerror = () => { mapsPromise = null; reject(new Error("load-failed")); };
    document.head.appendChild(s);
  });
  return mapsPromise;
}
// Google calls this when the key is rejected by the Maps JavaScript API.
window.gm_authFailure = () => dispatchEvent(new CustomEvent("google-auth-failed"));

/* Key problems (billing, disabled APIs, website or API restrictions) are
   reported once per message as a "google-error" event so the page can show them. */
const reported = new Set();
function reportError(api, message) {
  if (!message || reported.has(api + message)) return;
  reported.add(api + message);
  dispatchEvent(new CustomEvent("google-error", { detail: { api, message } }));
}
// The Maps JavaScript API only explains a rejected key in the console.
const MAPS_ERRORS = {
  BillingNotEnabledMapError: "Billing is not enabled on the Google Cloud project.",
  ApiNotActivatedMapError: "Maps JavaScript API is not enabled on the project.",
  ApiTargetBlockedMapError: "The key's API restrictions do not include Maps JavaScript API.",
  RefererNotAllowedMapError: "This address (" + location.origin + ") is not in the key's website restrictions.",
  InvalidKeyMapError: "The key is not valid.",
  ExpiredKeyMapError: "The key has expired.",
};
const consoleError = console.error;
console.error = function (...args) {
  const m = String(args[0] ?? "").match(/Google Maps JavaScript API error: (\w+)/);
  if (m) reportError("Maps JavaScript API", MAPS_ERRORS[m[1]] || m[1]);
  return consoleError.apply(this, args);
};

/* ---------- Places API (New) ---------- */
async function placesFetch(path, { method = "GET", body, fields }) {
  if (!key()) { const e = new Error("Add a Google Maps key in Settings."); e.status = 401; throw e; }
  const res = await fetch(PLACES + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key(), "X-Goog-FieldMask": fields },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json())?.error?.message || ""; } catch {}
    const e = new Error(msg || "Google Places returned HTTP " + res.status); e.status = res.status;
    if ([401, 403, 429].includes(res.status)) reportError("Places API", e.message);
    throw e;
  }
  return res.json();
}

/* Find one place by text, optionally biased to a point. */
async function search(text, near, radius = 30000) {
  const body = { textQuery: String(text).slice(0, 200), pageSize: 1 };
  if (near?.lat != null) {
    body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: Math.min(50000, radius) } };
  }
  const j = await placesFetch("/places:searchText", {
    method: "POST", body,
    fields: "places.id,places.displayName,places.location,places.formattedAddress",
  });
  const p = j.places?.[0];
  if (!p?.location) return null;
  return { placeId: p.id, name: p.displayName?.text || "", lat: p.location.latitude, lng: p.location.longitude, address: p.formattedAddress || "" };
}

function normalize(j, full) {
  return {
    placeId: j.id,
    gname: j.displayName?.text || "",
    address: j.formattedAddress || "",
    rating: j.rating || null,
    reviews: j.userRatingCount || 0,
    types: j.primaryTypeDisplayName?.text ? [j.primaryTypeDisplayName.text] : [],
    url: j.googleMapsUri || "",
    photos: (j.photos || []).slice(0, 8).map(ph => ({
      name: ph.name, w: ph.widthPx, h: ph.heightPx,
      author: ph.authorAttributions?.[0]?.displayName || "", authorUri: ph.authorAttributions?.[0]?.uri || "",
    })),
    desc: full ? j.editorialSummary?.text || "" : undefined,
    quotes: full ? (j.reviews || []).slice(0, 3).map(r => ({
      t: r.text?.text || r.originalText?.text || "", r: r.rating || 0,
      a: r.authorAttribution?.displayName || "Google review", d: r.relativePublishTimeDescription || "",
    })).filter(q => q.t) : undefined,
    full: !!full,
  };
}

/* Live details for a trip place. A place without a Google id is looked up
   by name near its coordinates; the caller may store the id it returns. */
const inflight = new Map();
let active = 0;
const queue = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < 4 && queue.length) {
    const job = queue.shift();
    active++;
    job.fn().then(job.resolve, job.reject).finally(() => { active--; pump(); });
  }
}
function cachedDetails(placeId) { return placeId ? cache.get(placeId) || null : null; }
async function details(place, { full = false } = {}) {
  if (!place || !key()) return null;
  let id = place.placeId;
  const hit = cachedDetails(id);
  if (hit && (hit.full || !full)) return hit;
  const flightKey = (id || place.name + "@" + place.lat) + (full ? "|full" : "");
  if (inflight.has(flightKey)) return inflight.get(flightKey);
  const job = limited(async () => {
    if (!id) {
      const found = await search(place.name, place.lat != null ? place : null, 3000);
      if (!found) return null;
      id = found.placeId;
      const again = cachedDetails(id);
      if (again && (again.full || !full)) return again;
    }
    const j = await placesFetch("/places/" + encodeURIComponent(id), { fields: full ? FULL : BASIC });
    const out = normalize(j, full);
    cache.set(id, out); persist();
    return out;
  }).finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, job);
  return job;
}

/* Photos load straight from Google; nothing is downloaded or stored. */
function photoUrl(photo, w = 800) {
  if (!photo?.name || !key()) return "";
  return `${PLACES}/${photo.name}/media?maxWidthPx=${w}&key=${encodeURIComponent(key())}`;
}

window.TripGoogle = {
  key, mapId, hasKey: () => !!key(), K_KEY, K_MAPID,
  loadMaps, search, details, cachedDetails, photoUrl, reportError,
};
})();
