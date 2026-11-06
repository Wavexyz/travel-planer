"use strict";
/* Settings dialog: the DeepSeek key (assistant and itinerary generation) and
   the Google Maps Platform key (map, places, photos, routes). Both are stored
   in this browser only. Saving fires a "trip-settings" event. */
(() => {
const $ = s => document.querySelector(s);
const K_DS = "deepseek-key", K_MODEL = "deepseek-model";
const dialog = $("#settings"), statusEl = $("#settings-status");
const dsInput = $("#key"), gInput = $("#gkey"), mapIdInput = $("#mapid"), modelSel = $("#model");
let onSaved = null, returnFocus = null;

const get = k => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const set = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };
// With the site's backend, DeepSeek is called by the server with its own key.
const SERVER = !!window.APP_CONFIG?.server;
const deepseekKey = () => SERVER ? "server" : get(K_DS);
// deepseek-chat and deepseek-reasoner were retired on 2026-07-24.
const LEGACY_MODEL = { "deepseek-chat": "deepseek-flash", "deepseek-reasoner": "deepseek-v4-pro" };
const model = () => { const m = get(K_MODEL); return LEGACY_MODEL[m] || m || "deepseek-flash"; };

function setStatus(text, cls = "") { statusEl.textContent = text; statusEl.className = "settings-status" + (cls ? " " + cls : ""); }
function fill() {
  for (const [input, saved, label] of [[dsInput, deepseekKey(), "sk-…"], [gInput, get(TripGoogle.K_KEY), "AIza…"]]) {
    input.value = "";
    input.type = "password";
    input.placeholder = saved ? "•••••••••••• saved — paste a new key to replace" : label;
  }
  dialog.querySelectorAll("[data-reveal]").forEach(b => { b.textContent = "Show"; });
  $("#clear-key").disabled = !deepseekKey();
  $("#clear-gkey").disabled = !get(TripGoogle.K_KEY);
  mapIdInput.value = get(TripGoogle.K_MAPID);
  modelSel.value = model();
  setStatus("");
  if (SERVER) {
    // Keys are stored as server secrets: nothing to enter here.
    dsInput.closest(".field").hidden = true;
    mapIdInput.closest(".field").hidden = true; // the map is styled in code now, so a Map ID has no effect
    if (window.APP_CONFIG.googleMapsKey) gInput.closest(".field").hidden = true;
    $("#settings-title").nextElementSibling.textContent = "The DeepSeek, Google Maps and travel-data keys are stored securely on the server.";
  }
}
/* open({ focus: "google" | "deepseek", note, onSaved }) */
function open(opts = {}) {
  fill();
  onSaved = opts.onSaved || null;
  returnFocus = document.activeElement;
  if (opts.note) setStatus(opts.note);
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
  const first = opts.focus === "google" ? gInput : opts.focus === "deepseek" ? dsInput : (!deepseekKey() ? dsInput : !get(TripGoogle.K_KEY) ? gInput : dsInput);
  setTimeout(() => first.focus(), 30);
}
function close() {
  if (dialog.open) dialog.close(); else dialog.removeAttribute("open");
  returnFocus?.focus?.(); returnFocus = null;
}
function changed() { dispatchEvent(new CustomEvent("trip-settings")); }

$("#settings-form").addEventListener("submit", e => {
  e.preventDefault();
  const ds = dsInput.value.trim(), g = gInput.value.trim();
  if (ds) set(K_DS, ds);
  if (g) set(TripGoogle.K_KEY, g);
  set(TripGoogle.K_MAPID, mapIdInput.value.trim());
  set(K_MODEL, modelSel.value);
  const cb = onSaved;
  onSaved = null;
  close();
  changed();
  // A new Google key only takes effect for the map after a reload.
  if (g && window.google?.maps) location.reload();
  cb?.();
});
$("#clear-key").addEventListener("click", () => {
  set(K_DS, ""); fill(); setStatus("DeepSeek key removed."); changed();
});
$("#clear-gkey").addEventListener("click", () => {
  set(TripGoogle.K_KEY, ""); fill(); setStatus("Google key removed. Reload the page to unload the map."); changed();
});
dialog.querySelectorAll("[data-reveal]").forEach(b => b.addEventListener("click", () => {
  const input = $("#" + b.dataset.reveal);
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  b.textContent = show ? "Hide" : "Show";
  input.focus();
}));
$("#settings-close").addEventListener("click", close);
dialog.addEventListener("click", e => { if (e.target === dialog) close(); });
dialog.addEventListener("close", () => { onSaved = null; });

window.TripSettings = { open, close, deepseekKey, model, K_DS, K_MODEL };
})();
