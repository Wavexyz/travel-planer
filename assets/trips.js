"use strict";
/* Saved trips. Each trip is one JSON object in localStorage under trip:<id>;
   trips-v1 is the list shown in the Trips menu. The active trip becomes
   window.TRIP_DATA for the page. */
(() => {
const INDEX = "trips-v1", ACTIVE = "trip-active", PREFIX = "trip:";
const read = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

function list() { return read(INDEX, []).filter(t => t && t.id); }
function get(id) {
  const t = read(PREFIX + id, null);
  return t && t.meta && Array.isArray(t.days) && t.places ? t : null;
}
function save(trip) {
  trip.updatedAt = new Date().toISOString();
  if (!write(PREFIX + trip.id, trip)) return false;
  const idx = list().filter(t => t.id !== trip.id);
  idx.unshift({ id: trip.id, title: trip.meta.title, emoji: trip.meta.emoji || "", start: trip.meta.start, end: trip.meta.end, updatedAt: trip.updatedAt });
  return write(INDEX, idx);
}
function remove(id) {
  try {
    localStorage.removeItem(PREFIX + id);
    localStorage.removeItem("trip-chat:" + id);
  } catch {}
  write(INDEX, list().filter(t => t.id !== id));
  if (activeId() === id) setActive(list()[0]?.id || "");
}
function activeId() { try { return localStorage.getItem(ACTIVE) || ""; } catch { return ""; } }
function setActive(id) { try { id ? localStorage.setItem(ACTIVE, id) : localStorage.removeItem(ACTIVE); } catch {} }
function newId() { return "t-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
/* Show another trip. The page is built around one trip, so reload it. */
function open(id) {
  setActive(id);
  location.href = location.pathname + location.search;
}
/* prepare(trip) runs before saving, e.g. to find places that have no coordinates yet. */
async function importSample(url, prepare) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not load the sample trip.");
  const trip = await res.json();
  if (prepare) await prepare(trip);
  trip.id = newId();
  trip.createdAt = new Date().toISOString();
  if (!save(trip)) throw new Error("This browser's storage is full.");
  return trip;
}

let current = get(activeId());
if (!current) {
  const first = list().find(t => get(t.id));
  if (first) { current = get(first.id); setActive(first.id); }
}
window.TRIP_DATA = current || null;
window.TripStore = { list, get, save, remove, activeId, setActive, newId, open, importSample };
})();
