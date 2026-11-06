"use strict";
/* New-trip questionnaire, generation progress and the Trips menu. */
(() => {
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SAMPLES = [
  { url: "samples/japan-in-autumn.json", title: "Japan in Autumn" },
  { url: "samples/japan-unhurried.json", title: "Japan in Autumn, Unhurried" },
];
const hasTrip = !!window.TRIP_DATA;
const form = $("#ob-form");
const steps = $$(".ob-step", form);
let step = 0, controller = null, lastAnswers = null;

const fmtRange = (a, b) => {
  if (!a || !b) return "";
  const o = { day: "numeric", month: "short" };
  const s = new Date(a + "T12:00:00"), e = new Date(b + "T12:00:00");
  return `${s.toLocaleDateString("en-GB", o)} – ${e.toLocaleDateString("en-GB", { ...o, year: "numeric" })}`;
};

/* ---------- Modes ---------- */
function show(panel) {
  for (const id of ["ob-welcome", "ob-form", "ob-book", "ob-working"]) $("#" + id).hidden = id !== panel;
}
function openOnboarding(panel = "ob-welcome") {
  document.body.dataset.mode = "onboard";
  $("#onboard").hidden = false;
  $("#ob-cancel").hidden = !hasTrip;
  renderWelcome();
  show(panel);
  if (panel === "ob-form") goStep(0);
}
function closeOnboarding() {
  if (!hasTrip) return;
  controller?.abort();
  document.body.dataset.mode = "trip";
  $("#onboard").hidden = true;
}

function renderWelcome() {
  const missing = [!TripSettings.deepseekKey() && "a DeepSeek key", !TripGoogle.hasKey() && "a Google Maps key"].filter(Boolean);
  const keys = $("#ob-keys");
  keys.hidden = !missing.length;
  keys.innerHTML = missing.length ? `To generate a trip you need ${missing.join(" and ")}. <button type="button" class="link" data-act="keys">Add ${missing.length > 1 ? "them" : "it"}</button>` : "";
  const trips = TripStore.list();
  const box = $("#ob-trips");
  box.hidden = !trips.length;
  box.innerHTML = trips.length ? `<h2>Your trips</h2>${trips.map(t => `<button type="button" class="ob-trip" data-open="${esc(t.id)}"><b>${esc((t.emoji ? t.emoji + " " : "") + t.title)}</b><span>${esc(fmtRange(t.start, t.end))}</span></button>`).join("")}` : "";
}
$("#ob-welcome").addEventListener("click", e => {
  const open = e.target.closest("[data-open]");
  if (open) TripStore.open(open.dataset.open);
  if (e.target.closest('[data-act="keys"]')) TripSettings.open({ onSaved: renderWelcome });
});
$("#ob-start").addEventListener("click", () => { show("ob-form"); goStep(0); });
$("#ob-sample").addEventListener("click", () => openSample(SAMPLES[0].url));
$("#ob-settings").addEventListener("click", () => TripSettings.open({ onSaved: renderWelcome }));
$("#ob-cancel").addEventListener("click", closeOnboarding);
addEventListener("trip-settings", renderWelcome);

async function openSample(url) {
  try {
    const trip = await TripStore.importSample(url, locateMissing);
    TripStore.open(trip.id);
  } catch (err) {
    stopScene();
    if (err?.name === "AbortError") { if (hasTrip) closeOnboarding(); else show("ob-welcome"); return; }
    alert(err.message || "Could not open the sample trip.");
    if (hasTrip) closeOnboarding(); else show("ob-welcome");
  } finally {
    controller = null;
  }
}
/* A sample may list places by name only; match them on Google before saving,
   on the generation screen. Without a Google key they stay without a pin. */
async function locateMissing(trip) {
  const todo = Object.values(trip.places).filter(p => p.lat == null);
  if (!todo.length || !TripGoogle.hasKey()) return;
  openOnboarding("ob-working");
  startScene({ destination: trip.meta.routeLine, start: trip.meta.start, end: trip.meta.end });
  showPreview({ title: trip.meta.title, emoji: trip.meta.emoji, days: trip.days.map(d => ({ d: d.d, date: d.date, title: d.title, city: trip.places[d.city]?.name || "" })) });
  $$("#gen-days .gen-day").forEach(t => { t.className = "gen-day ok"; });
  $("#ob-gen-error").hidden = true;
  $("#ob-stop").hidden = false;
  $("#ob-retry").hidden = $("#ob-edit").hidden = true;
  controller = new AbortController();
  const report = (done, total) => progress({ step: "places", text: `Finding places on Google Maps (${done} of ${total})…`, done, total });
  report(0, todo.length);
  await TripGenerator.locate(trip.places, todo, { signal: controller.signal, onProgress: report });
  todo.forEach(p => { delete p.query; });
  gen.shown = 1; flightTick();
}

/* ---------- Date range calendar ---------- */
const MAX_DAYS = 30;
const pad = n => String(n).padStart(2, "0");
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = iso => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const shiftISO = (iso, n) => { const d = dateOf(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const spanDays = (a, b) => Math.round((dateOf(b) - dateOf(a)) / 864e5) + 1;
const cal = {
  el: $("#ob-cal"), start: "", end: "", hover: "", focus: "",
  view: (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })(),
};
const today = () => isoOf(new Date());
const CHEV = d => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
function calDisabled(iso) {
  if (iso < today()) return true;
  // While choosing the last day, days past the 30-day limit are off.
  return !!(cal.start && !cal.end && iso > shiftISO(cal.start, MAX_DAYS - 1));
}
function renderCal() {
  const first = cal.view, now = new Date();
  const atNow = first.getFullYear() === now.getFullYear() && first.getMonth() === now.getMonth();
  if (!cal.focus) cal.focus = cal.start || today();
  let html = `<button type="button" class="rcal-nav rcal-prev" data-nav="-1" aria-label="Previous month"${atNow ? " disabled" : ""}>${CHEV("M10 3.5L5.5 8l4.5 4.5")}</button>
    <button type="button" class="rcal-nav rcal-next" data-nav="1" aria-label="Next month">${CHEV("M6 3.5l4.5 4.5L6 12.5")}</button>`;
  for (let m = 0; m < 2; m++) {
    const month = new Date(first.getFullYear(), first.getMonth() + m, 1);
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const lead = (month.getDay() + 6) % 7; // Monday first
    html += `<div class="rcal-month"><h3>${month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</h3><div class="rcal-grid" role="grid">`;
    html += ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map(w => `<span class="rcal-wd" aria-hidden="true">${w}</span>`).join("");
    html += '<span class="rcal-blank"></span>'.repeat(lead);
    for (let d = 1; d <= days; d++) {
      const iso = isoOf(new Date(month.getFullYear(), month.getMonth(), d));
      const label = dateOf(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      const picked = iso === cal.start || iso === cal.end;
      html += `<button type="button" class="rcal-day${iso === today() ? " today" : ""}" data-date="${iso}" aria-label="${label}" aria-pressed="${picked}" tabindex="${iso === cal.focus ? 0 : -1}"${calDisabled(iso) ? " disabled" : ""}><span>${d}</span></button>`;
    }
    html += "</div></div>";
  }
  cal.el.innerHTML = html;
  // Keep one day reachable with Tab even when the focused day is off screen.
  if (!$('.rcal-day[tabindex="0"]', cal.el)) $(".rcal-day:not(:disabled)", cal.el)?.setAttribute("tabindex", "0");
  paintCal();
}
// Range classes only, so hovering doesn't rebuild the grid.
function paintCal() {
  const end = cal.end || (cal.start && cal.hover > cal.start ? cal.hover : "");
  const f = +form.elements.flex.value || 0;
  $$(".rcal-day", cal.el).forEach(b => {
    const iso = b.dataset.date;
    b.classList.toggle("start", iso === cal.start);
    b.classList.toggle("end", !!end && iso === end);
    b.classList.toggle("in", !!cal.end && iso > cal.start && iso < cal.end);
    b.classList.toggle("pre", !cal.end && !!end && iso > cal.start && iso < end);
    b.classList.toggle("flex", !!(f && cal.end) && (iso < cal.start ? iso >= shiftISO(cal.start, -f) : iso > cal.end && iso <= shiftISO(cal.end, f)));
  });
  form.elements.start.value = cal.start;
  form.elements.end.value = cal.end;
  paintSum();
}
const monthName = ym => dateOf(ym + "-01").toLocaleDateString("en-GB", { month: "short" });
const orList = xs => xs.length > 1 ? `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}` : xs[0] || "";
function paintSum() {
  const sum = $("#ob-cal-sum"), flex = form.elements.flex.value;
  if (flex === "any") {
    const n = +form.elements.duration.value || 0;
    const months = $$('[name="months"]:checked', form).map(i => monthName(i.value));
    sum.innerHTML = `<b>${n} day${n === 1 ? "" : "s"}</b> · ${months.length ? `starting in ${esc(orList(months))}` : "now pick when"}`;
    return;
  }
  const fmt = iso => dateOf(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const give = +flex ? ` · ± ${flex} day${+flex > 1 ? "s" : ""}` : "";
  if (cal.start && cal.end) {
    const n = spanDays(cal.start, cal.end);
    sum.innerHTML = `<b>${fmt(cal.start)} → ${fmt(cal.end)}</b> · ${n} day${n > 1 ? "s" : ""}${n > 1 ? `, ${n - 1} night${n > 2 ? "s" : ""}` : ""}${give}`;
  } else if (cal.start) sum.innerHTML = `<b>${fmt(cal.start)}</b> → now pick your last day`;
  else sum.textContent = "Pick your first day";
}
function pickDay(iso) {
  if (!cal.start || cal.end || iso < cal.start) { cal.start = iso; cal.end = ""; }
  else cal.end = iso;
  cal.focus = iso;
  setError("");
  renderCal();
  cal.el.querySelector(`[data-date="${iso}"]`)?.focus();
}
function moveFocus(iso) {
  if (iso < today()) return;
  cal.focus = iso;
  const d = dateOf(iso), v = cal.view;
  const months = (d.getFullYear() - v.getFullYear()) * 12 + d.getMonth() - v.getMonth();
  const shown = matchMedia("(max-width: 560px)").matches ? 1 : 2;
  if (months < 0 || months >= shown) cal.view = new Date(d.getFullYear(), d.getMonth() - (months < 0 ? 0 : shown - 1), 1);
  renderCal();
  cal.el.querySelector(`[data-date="${iso}"]`)?.focus();
}
cal.el.addEventListener("click", e => {
  const nav = e.target.closest("[data-nav]");
  if (nav) { cal.view = new Date(cal.view.getFullYear(), cal.view.getMonth() + +nav.dataset.nav, 1); renderCal(); return; }
  const day = e.target.closest(".rcal-day");
  if (day && !day.disabled) pickDay(day.dataset.date);
});
cal.el.addEventListener("mouseover", e => {
  const day = e.target.closest(".rcal-day");
  const iso = day && !day.disabled ? day.dataset.date : "";
  if (iso !== cal.hover && cal.start && !cal.end) { cal.hover = iso; paintCal(); }
});
cal.el.addEventListener("mouseleave", () => { if (cal.hover) { cal.hover = ""; paintCal(); } });
cal.el.addEventListener("keydown", e => {
  const day = e.target.closest(".rcal-day"); if (!day) return;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  if (step) { e.preventDefault(); moveFocus(shiftISO(day.dataset.date, step)); }
});
// "I'm flexible": a length and the months the trip may start in, instead of dates.
$("#ob-months").innerHTML = Array.from({ length: 12 }, (_, i) => {
  const now = new Date(), d = new Date(now.getFullYear(), now.getMonth() + i, 1);
  return `<label class="ob-month"><input type="checkbox" name="months" value="${isoOf(d).slice(0, 7)}"><span>${monthName(isoOf(d).slice(0, 7))}<small>${d.getFullYear()}</small></span></label>`;
}).join("");
$("#ob-flex").addEventListener("change", () => {
  const any = form.elements.flex.value === "any";
  cal.el.hidden = any;
  $("#ob-flexi").hidden = !any;
  setError("");
  paintCal();
});
$("#ob-flexi").addEventListener("input", () => { setError(""); paintSum(); });
$("#ob-flexi").addEventListener("click", e => {
  const b = e.target.closest("[data-len]"); if (!b) return;
  const input = form.elements.duration;
  input.value = Math.max(1, Math.min(MAX_DAYS, (+input.value || 0) + +b.dataset.len));
  paintSum();
});
renderCal();

/* ---------- Questionnaire ---------- */
function goStep(i) {
  step = Math.max(0, Math.min(steps.length - 1, i));
  steps.forEach((f, j) => { f.hidden = j !== step; });
  $("#ob-step-label").textContent = `Step ${step + 1} of ${steps.length}`;
  $("#ob-bar").style.width = `${((step + 1) / steps.length) * 100}%`;
  $("#ob-back").textContent = step === 0 ? "Cancel" : "Back";
  $("#ob-next").hidden = step === steps.length - 1;
  $("#ob-generate").hidden = step !== steps.length - 1;
  setError("");
  setTimeout(() => $('.rcal-day[tabindex="0"], input:not([type=radio]):not([type=checkbox]):not([type=hidden]), textarea, select', steps[step])?.focus(), 30);
}
function setError(text) { const el = $("#ob-error"); el.hidden = !text; el.textContent = text; }
const MULTI = ["interests", "months", "cities", "food", "diet", "hotelCity", "hotelName", "hotelIn", "hotelOut"];
function answers() {
  const fd = new FormData(form);
  const a = { destination: "Japan" };
  for (const [k, v] of fd) {
    if (MULTI.includes(k)) (a[k] ||= []).push(String(v).trim());
    else a[k] = String(v).trim();
  }
  if (a.flex === "any") { delete a.start; delete a.end; }
  else { delete a.duration; delete a.months; }
  // Hotels already booked, from the rows on the last step.
  a.bookedHotels = (a.hotelName || []).map((name, i) => ({ name, cityName: a.hotelCity[i], checkIn: a.hotelIn[i], checkOut: a.hotelOut[i] }))
    .filter(h => h.name || h.cityName);
  for (const k of ["hotelCity", "hotelName", "hotelIn", "hotelOut"]) delete a[k];
  if (a.hotelsStatus === "help") a.bookedHotels = [];
  a.interestsLove = $$('[name="interests"][data-love="1"]:checked', form).map(i => i.value);
  return a;
}
const STEP = { dates: 0, interests: 2, flights: 9, hotels: 10 };
function validate(i) {
  const a = answers();
  if (i === STEP.dates && a.flex === "any") {
    if (!a.months?.length) return "Pick at least one month.";
    if (!(+a.duration >= 1 && +a.duration <= MAX_DAYS)) return `Trips can be 1 to ${MAX_DAYS} days for now.`;
  } else if (i === STEP.dates) {
    if (!a.start || !a.end) return "Choose the first and last day.";
    const n = Math.round((new Date(a.end + "T12:00:00") - new Date(a.start + "T12:00:00")) / 864e5) + 1;
    if (n < 1) return "The last day must be on or after the first day.";
    if (n > 30) return "Trips can be up to 30 days for now.";
  }
  if (i === STEP.interests && !a.interests?.length && !a.interestsOther) return "Pick at least one thing you'd love to do.";
  if (i === STEP.flights || i === STEP.hotels) {
    const needsDates = i === STEP.flights ? a.flightsStatus !== "booked" : a.hotelsStatus !== "booked";
    if (needsDates && a.flex === "any") return "For this we need exact dates. Go back to the first step and pick them.";
  }
  if (i === STEP.flights) {
    if (a.flightsStatus === "booked") {
      if (!a.inFlight || !a.inDate || !/^[A-Za-z]{3}$/.test(a.inFrom)) return "Add the flight into Japan: number, date and the airport it leaves from.";
      if (!a.outFlight || !a.outDate || !/^[A-Za-z]{3}$/.test(a.outTo)) return "Add the flight home: number, date and the airport it flies to.";
    }
    if (a.flightsStatus === "help" && !/^[A-Z]{3}(,[A-Z]{3})*$/.test(a.homeAirport || "")) return "Pick the city or airport you fly from.";
    if (a.flightsStatus === "self" && (!a.selfInTime || !a.selfOutTime)) return "Add roughly when you land and when you leave.";
  }
  if (i === STEP.hotels) {
    if (a.hotelsStatus !== "help") {
      if (!a.bookedHotels.length) return "List the hotels you've booked, or choose “None yet”.";
      if (a.bookedHotels.some(h => !h.name || !h.cityName || !h.checkIn || !h.checkOut || h.checkOut <= h.checkIn)) return "Each booked hotel needs a city, a name and check-in before check-out.";
    }
  }
  return "";
}

/* ---------- Conditional questions ---------- */
function syncConditional() {
  const v = n => form.elements[n]?.value;
  $("#ob-fl-booked").hidden = v("flightsStatus") !== "booked";
  $("#ob-fl-help").hidden = v("flightsStatus") !== "help";
  $("#ob-fl-self").hidden = v("flightsStatus") !== "self";
  $("#ob-ht-booked").hidden = v("hotelsStatus") === "help";
  $("#ob-onsen-more").hidden = v("onsen") === "no";
  if (!$("#ob-ht-booked").hidden && !$("#ob-hotel-rows").children.length) addHotelRow();
}
function addHotelRow() {
  const row = document.createElement("div");
  row.className = "ob-row ob-hotel-row";
  row.innerHTML = `<label class="field"><span class="field-k">City</span><input name="hotelCity" placeholder="Tokyo"></label>
    <label class="field"><span class="field-k">Hotel</span><input name="hotelName" placeholder="Hotel name"></label>
    <label class="field"><span class="field-k">Check-in</span><input type="date" name="hotelIn"></label>
    <label class="field"><span class="field-k">Check-out</span><input type="date" name="hotelOut"></label>`;
  $("#ob-hotel-rows").append(row);
}
form.addEventListener("change", e => { if (["flightsStatus", "hotelsStatus", "onsen"].includes(e.target.name)) { setError(""); syncConditional(); } });
$("#ob-add-hotel").addEventListener("click", addHotelRow);
// "Who's going" sets a sensible party size; children only matter for families.
const PARTY_ADULTS = { solo: 1, couple: 2, family_with_kids: 2, friends_group: 3, seniors: 2 };
function syncParty(fromParty) {
  const party = form.elements.party.value;
  if (fromParty) form.elements.adults.value = PARTY_ADULTS[party] || 2;
  $("#ob-kids").hidden = party !== "family_with_kids";
  if (party !== "family_with_kids") form.elements.kids.value = "";
}
form.addEventListener("change", e => { if (e.target.name === "party") syncParty(true); });
form.addEventListener("click", e => {
  const b = e.target.closest("[data-count]"); if (!b) return;
  const input = form.elements[b.dataset.count];
  input.value = Math.max(+input.min || 1, Math.min(+input.max || 9, (+input.value || 0) + +b.dataset.d));
});
syncParty(false);
// Example chips add their text to the box below them.
form.addEventListener("click", e => {
  const b = e.target.closest(".ob-chip-add"); if (!b) return;
  const box = form.elements[b.closest(".ob-add").dataset.target];
  const parts = box.value.split(/\s*,\s*/).filter(Boolean);
  if (!parts.includes(b.textContent)) box.value = [...parts, b.textContent].join(", ");
  b.classList.add("on");
});

/* Interest cards: tap once to like, twice to love, a third time to clear. */
form.addEventListener("click", e => {
  const card = e.target.closest(".ob-card"), input = card?.querySelector('input[name="interests"]');
  if (!input) return;
  e.preventDefault();
  const level = !input.checked ? 1 : input.dataset.love === "1" ? 0 : 2;
  input.checked = level > 0;
  input.dataset.love = level === 2 ? "1" : "";
  card.classList.toggle("love", level === 2);
  input.setAttribute("aria-label", `${card.querySelector("b").textContent}: ${["not chosen", "like", "love"][level]}`);
  setError("");
});

/* ---------- Airport search: type a city or airport, pick from the list ---------- */
let airports = null;
const loadAirports = () => airports ||= fetch("assets/airports.json").then(r => r.json()).catch(() => []);
function airportMatches(list, q) {
  q = q.trim().toLowerCase(); if (q.length < 2) return [];
  const scored = [];
  for (const [code, name, city, country, big, kw] of list) {
    const c = (city || "").toLowerCase(), n = name.toLowerCase(), k = (kw || "").toLowerCase();
    let s = code.toLowerCase() === q ? 100 : c.startsWith(q) ? 60 : n.startsWith(q) ? 50 : n.includes(q) ? 35 : c.includes(q) ? 30 : k.includes(q) ? 20 : 0;
    if (s) scored.push({ code, name, city, country, s: s + (big ? 8 : 0) });
  }
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, 7);
  // Several big airports for one city: offer them all at once.
  const big = scored.filter(x => x.s >= 38 && x.country === top[0]?.country).slice(0, 6);
  if (big.length > 1 && top[0].s < 100) top.unshift({ all: true, codes: big.map(x => x.code), name: `All airports: ${big.map(x => x.code).join(", ")}`, city: q.replace(/^./, c => c.toUpperCase()) });
  return top;
}
function airportPicker(box) {
  const name = box.dataset.ap, single = !!box.dataset.single;
  box.innerHTML = `<div class="ap-in"><span class="ap-chips"></span><input type="text" autocomplete="off" placeholder="${single ? "City or airport" : "e.g. London"}" role="combobox" aria-expanded="false" aria-autocomplete="list"></div>
    <input type="hidden" name="${name}"><input type="hidden" name="${name}Label"><ul class="ap-list" role="listbox" hidden></ul>`;
  const input = $("input[type=text]", box), hidden = $("input[type=hidden]", box), list = $(".ap-list", box), chips = $(".ap-chips", box);
  let picked = [], opts = [], at = 0;
  const paint = () => {
    hidden.value = picked.map(p => p.code).join(",");
    hidden.nextElementSibling.value = picked.map(p => p.label.replace(/ · all airports$/, "")).join(", ");
    chips.innerHTML = picked.map((p, i) => `<span class="ap-chip">${esc(p.label)}<button type="button" data-x="${i}" aria-label="Remove ${esc(p.label)}">×</button></span>`).join("");
    input.placeholder = picked.length ? "" : single ? "City or airport" : "e.g. London";
  };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); };
  const show = () => {
    list.innerHTML = opts.map((o, i) => `<li role="option" data-i="${i}" aria-selected="${i === at}">${o.all ? `<b>${esc(o.city)}</b> <span>${esc(o.name)}</span>` : `<b>${esc(o.code)}</b> ${esc(o.name)} <span>${esc(o.city)}, ${esc(o.country)}</span>`}</li>`).join("");
    list.hidden = !opts.length; input.setAttribute("aria-expanded", String(!!opts.length));
  };
  const choose = o => {
    const add = o.all ? [{ code: o.codes.join(","), label: `${o.city} · all airports` }] : [{ code: o.code, label: `${o.code} · ${o.city || o.name}` }];
    picked = single ? (o.all ? [{ code: o.codes[0], label: `${o.codes[0]} · ${o.city}` }] : add) : [...picked, ...add.filter(a => !picked.some(p => p.code === a.code))];
    input.value = ""; opts = []; close(); paint(); setError("");
  };
  input.addEventListener("input", async () => { opts = airportMatches(await loadAirports(), input.value); at = 0; show(); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); at = (at + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % (opts.length || 1); show(); }
    else if (e.key === "Enter" && !list.hidden && opts[at]) { e.preventDefault(); e.stopPropagation(); choose(opts[at]); }
    else if (e.key === "Escape") close();
    else if (e.key === "Backspace" && !input.value && picked.length) { picked.pop(); paint(); }
  });
  list.addEventListener("mousedown", e => { const li = e.target.closest("li"); if (li) { e.preventDefault(); choose(opts[+li.dataset.i]); } });
  chips.addEventListener("click", e => { const x = e.target.closest("[data-x]"); if (x) { picked.splice(+x.dataset.x, 1); paint(); input.focus(); } });
  input.addEventListener("blur", () => setTimeout(close, 120));
}
$$(".ap", form).forEach(airportPicker);
syncConditional();
$("#ob-next").addEventListener("click", () => {
  const err = validate(step);
  if (err) { setError(err); return; }
  goStep(step + 1);
});
$("#ob-back").addEventListener("click", () => { if (step === 0) show("ob-welcome"); else goStep(step - 1); });
form.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.tagName === "INPUT" && step < steps.length - 1) { e.preventDefault(); $("#ob-next").click(); }
});
form.addEventListener("submit", e => {
  e.preventDefault();
  for (let i = 0; i < steps.length; i++) {
    const err = validate(i);
    if (err) { goStep(i); setError(err); return; }
  }
  const a = answers();
  if (!TripSettings.deepseekKey() || !TripGoogle.hasKey()) {
    TripSettings.open({
      note: "Add both keys to generate the trip.",
      onSaved: () => { if (TripSettings.deepseekKey() && TripGoogle.hasKey()) book(a); },
    });
    return;
  }
  book(a);
});

/* ---------- Flights and hotels, before the itinerary ---------- */
function book(a) {
  show("ob-book");
  TripBooking.start(a, { onDone: run, onBack: () => { show("ob-form"); goStep(steps.length - 1); } });
}

/* ---------- Generation ---------- */
const ORDER = ["outline", "days", "places"];
// Light-hearted lines for the wait, true to what each step does.
const QUIPS = {
  outline: ["Unfolding the map…", "Sketching the route between cities…", "Deciding how many nights go where…", "Shortlisting places to stay…", "Working out the travel days…"],
  days: ["Pairing each morning with a good lunch…", "Packing a rainy-day plan B…", "Spacing things out so nobody's sprinting…", "Pencilling in coffee breaks…", "Keeping the walking to your step count…", "Saving a few alternatives, just in case…"],
  places: ["Pinning every stop on the map…", "Checking each place is where we think it is…", "Lining up photos for later…"],
};
// Each step owns part of the route the plane flies; the outline step has no counts, so it creeps.
const BANDS = { outline: [0, .3], days: [.3, .78], places: [.78, 1] };
const gen = { step: "outline", frac: 0, since: 0, shown: 0, timer: 0, quipTimer: 0, quip: 0 };
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
function markStep(name) {
  const at = ORDER.indexOf(name);
  $$("#ob-steps li").forEach(li => {
    const i = ORDER.indexOf(li.dataset.s);
    li.className = name === "done" || i < at ? "done" : i === at ? "on" : "";
  });
  if (name !== gen.step) { gen.step = name; gen.frac = 0; gen.since = performance.now(); nextQuip(true); }
}
function flightTick() {
  const band = BANDS[gen.step];
  let target = 1;
  if (band) {
    const creep = .85 * (1 - Math.exp(-(performance.now() - gen.since) / 25000));
    target = band[0] + (band[1] - band[0]) * Math.min(1, Math.max(gen.frac, gen.step === "places" ? 0 : creep));
  }
  gen.shown += (target - gen.shown) * (reduceMotion.matches ? 1 : .08);
  const path = $("#gen-path"), len = path.getTotalLength();
  const at = Math.max(0.001, Math.min(.999, gen.shown));
  const p = path.getPointAtLength(len * at), q = path.getPointAtLength(len * Math.min(1, at + .01));
  const angle = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
  $("#gen-plane").setAttribute("transform", `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${angle.toFixed(1)})`);
  $("#gen-done").style.strokeDasharray = `${(gen.shown * 100).toFixed(2)} 100`;
}
function nextQuip(reset) {
  const list = QUIPS[gen.step]; if (!list) return;
  gen.quip = reset ? 0 : (gen.quip + 1) % list.length;
  const el = $("#gen-quip");
  if (reduceMotion.matches) { el.textContent = list[gen.quip]; return; }
  el.classList.add("out");
  setTimeout(() => { el.textContent = list[gen.quip]; el.classList.remove("out"); }, 250);
}
function startScene(a) {
  Object.assign(gen, { step: "", frac: 0, shown: 0 });
  $("#gen-emoji").textContent = "🧳";
  $("#gen-title").textContent = "Building your trip";
  gen.where = a.route?.length ? a.route.map(c => c.name).join(" → ") : "Japan";
  const n = a.flex === "any" ? +a.duration : spanDays(a.start, a.end);
  const when = a.flex === "any" ? `${n} day${n > 1 ? "s" : ""}, starting in ${orList(a.months.map(monthName))}` : `${fmtRange(a.start, a.end)} · ${n} day${n > 1 ? "s" : ""}`;
  $("#gen-sub").textContent = [gen.where, when].filter(Boolean).join(" · ");
  $("#gen-preview").hidden = true;
  $("#gen-stops").innerHTML = $("#gen-days").innerHTML = "";
  clearInterval(gen.timer); clearInterval(gen.quipTimer);
  gen.timer = setInterval(flightTick, 50);
  gen.quipTimer = setInterval(() => nextQuip(false), 3400);
}
function stopScene() { clearInterval(gen.timer); clearInterval(gen.quipTimer); }
function showPreview(pv) {
  if (pv.emoji) $("#gen-emoji").textContent = pv.emoji;
  if (pv.title) $("#gen-title").textContent = pv.title;
  // With flexible dates this is the first time the actual dates are known.
  const n = pv.days.length;
  if (n) $("#gen-sub").textContent = [gen.where, `${fmtRange(pv.days[0].date, pv.days[n - 1].date)} · ${n} day${n > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
  // Consecutive days in one city make one stop.
  const stops = [];
  pv.days.forEach(d => { const last = stops[stops.length - 1]; if (d.city && last?.city === d.city) last.n++; else if (d.city) stops.push({ city: d.city, n: 1 }); });
  $("#gen-stops").innerHTML = stops.map((s, i) => `${i ? '<span class="gen-arrow" aria-hidden="true">→</span>' : ""}<span class="gen-stop" style="animation-delay:${i * 90}ms">📍 ${esc(s.city)} <small>${s.n} day${s.n > 1 ? "s" : ""}</small></span>`).join("");
  $("#gen-days").innerHTML = pv.days.map((d, i) => `<div class="gen-day writing" data-d="${d.d}" style="animation-delay:${Math.min(i, 20) * 40}ms">
      <span class="gd-k"><span>Day ${d.d} · ${esc(dateOf(d.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" }))}</span></span>
      <span class="gd-t">${esc(d.title)}</span></div>`).join("");
  $("#gen-preview").hidden = false;
}
function progress(p) {
  markStep(p.step);
  $("#ob-status").textContent = p.text;
  if (p.total) gen.frac = p.done / p.total;
  if (p.preview) showPreview(p.preview);
  if (p.range) for (let d = p.range[0]; d <= p.range[1]; d++) {
    const tile = $(`#gen-days [data-d="${d}"]`);
    if (tile) tile.className = "gen-day ok";
  }
}
async function run(a) {
  lastAnswers = a;
  show("ob-working");
  startScene(a);
  markStep("outline");
  $("#ob-status").textContent = "";
  $("#ob-gen-error").hidden = true;
  $("#ob-stop").hidden = false;
  $("#ob-retry").hidden = $("#ob-edit").hidden = true;
  controller = new AbortController();
  try {
    const trip = await TripGenerator.generate(a, { signal: controller.signal, onProgress: progress });
    if (!TripStore.save(trip)) throw new Error("This browser's storage is full. Delete a trip and try again.");
    gen.shown = 1; flightTick();
    TripStore.open(trip.id);
  } catch (err) {
    stopScene();
    if (err?.name === "AbortError") { show("ob-book"); return; }
    const el = $("#ob-gen-error");
    el.hidden = false;
    el.textContent = err?.status === 401 || err?.status === 403
      ? `A key was rejected: ${err.message}`
      : err?.status === 402 ? "The DeepSeek account is out of credit. Top up at platform.deepseek.com."
      : err instanceof TypeError ? "Could not reach the planning service. Check your connection and try again."
      : err?.message || "Something went wrong. Try again.";
    $("#gen-quip").textContent = "";
    $("#ob-stop").hidden = true;
    $("#ob-retry").hidden = $("#ob-edit").hidden = false;
  } finally {
    controller = null;
  }
}
$("#ob-stop").addEventListener("click", () => controller?.abort());
$("#ob-retry").addEventListener("click", () => lastAnswers && run(lastAnswers));
$("#ob-edit").addEventListener("click", () => { show("ob-book"); });

/* ---------- Trips menu ---------- */
const menu = $("#trips-menu"), menuBtn = $("#trips-btn");
function renderMenu() {
  const active = TripStore.activeId();
  menu.innerHTML = TripStore.list().map(t => `<button type="button" role="menuitemradio" aria-checked="${t.id === active}" data-trip="${esc(t.id)}">
      <b>${esc((t.emoji ? t.emoji + " " : "") + t.title)}</b><small>${esc(fmtRange(t.start, t.end))}</small></button>`).join("") +
    `<hr><button type="button" role="menuitem" data-menu="new">New trip…</button>
    ${SAMPLES.map(s => `<button type="button" role="menuitem" data-sample="${esc(s.url)}">Add the sample “${esc(s.title)}”</button>`).join("")}
    ${hasTrip ? '<button type="button" role="menuitem" data-menu="delete" class="danger">Delete this trip</button>' : ""}`;
}
function openMenu() {
  renderMenu();
  const r = menuBtn.getBoundingClientRect();
  menu.style.left = r.left + "px"; menu.style.top = r.bottom + 4 + "px";
  menu.hidden = false;
  menuBtn.setAttribute("aria-expanded", "true");
  $("button", menu)?.focus();
}
function closeMenu() { menu.hidden = true; menuBtn.setAttribute("aria-expanded", "false"); }
menuBtn?.addEventListener("click", e => { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); });
menu.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  closeMenu();
  if (b.dataset.trip) { if (b.dataset.trip !== TripStore.activeId()) TripStore.open(b.dataset.trip); return; }
  if (b.dataset.menu === "new") openOnboarding("ob-form");
  else if (b.dataset.sample) openSample(b.dataset.sample);
  else if (b.dataset.menu === "delete") {
    const t = window.TRIP_DATA;
    if (!confirm(`Delete “${t.meta.title}”? This cannot be undone.`)) return;
    TripStore.remove(t.id);
    TripStore.open(TripStore.activeId());
  }
});
document.addEventListener("click", e => { if (!menu.hidden && !e.target.closest("#trips-menu")) closeMenu(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !menu.hidden) { closeMenu(); menuBtn.focus(); } });
$("#top-settings")?.addEventListener("click", () => TripSettings.open());

if (!hasTrip) openOnboarding();
})();
