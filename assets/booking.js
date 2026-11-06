"use strict";
/* Between the questionnaire and the itinerary: settle the flights, the route and the
   hotels first, so the days are planned around real arrival times and real hotels.
     Flights — booked: look up the times by flight number; booking later: ask when they land;
               not booked: 3 options (after the route, which decides the airports).
     Route   — the skill proposes cities, nights, neighbourhoods and airports; editable, with comments.
     Hotels  — a few questions, then 3 hotels per stop with photos, guest reviews and the cheapest site.
   Nothing about the arrival is ever assumed. The traveller books everything themselves.
   TripBooking.start(answers, { onDone(answers), onBack() }) */
(() => {
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
const nightsBetween = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5);
const fmtDay = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const fmtWhen = t => t ? `${fmtDay(t.slice(0, 10))}, ${t.slice(11, 16)}` : "";
const hm = m => `${Math.floor(m / 60)}h${m % 60 ? " " + (m % 60) + "m" : ""}`;
const money = (n, cur) => n == null ? "" : new Intl.NumberFormat("en", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(n);
const TOKYO = ["HND", "NRT"];
const JP_AIRPORTS = [["HND", "Tokyo Haneda"], ["NRT", "Tokyo Narita"], ["KIX", "Osaka Kansai"], ["ITM", "Osaka Itami"], ["NGO", "Nagoya"], ["FUK", "Fukuoka"], ["CTS", "Sapporo"], ["OKA", "Okinawa"]];
const TIER_MAX = { budget: 120, mid_range: 250, upscale: 500, luxury: null };
const BED = { solo: "one_large_bed", couple: "one_large_bed", family_with_kids: "family_apartment", friends_group: "two_twin_beds", seniors: "two_twin_beds" };
const PRIORITIES = ["Central, near the sights", "Close to a major station", "Quiet at night", "Very clean", "Spacious room", "Onsen or public bath", "Breakfast included", "Great views", "Design and character", "Free cancellation"];

const root = $("#ob-book");
let S = null, ctrl = null;

function start(a, { onDone, onBack }) {
  ctrl?.abort();
  ctrl = new AbortController();
  S = { a: { ...a }, onDone, onBack, stage: "route", route: null, note: "", arrive: TOKYO, leave: TOKYO, routeComment: "",
    flights: { status: a.flightsStatus, options: null, chosen: null, in: null, out: null, error: "", loading: false, manual: false, why: "", filters: {}, note: "",
      dates: { out: a.start, back: a.end }, near: {} },
    prefs: { priorities: ["Central, near the sights", "Close to a major station", "Very clean"], bed: BED[a.party] || "one_large_bed", max: +a.maxNightly || TIER_MAX[a.budgetTier] || "", comment: "" },
    hotels: {}, error: "", loading: false };
  // Booked hotels become fixed stays.
  S.booked = (a.bookedHotels || []).map(h => ({ ...h, key: slug(h.name), city: slug(h.cityName), booked: true }));
  S.deck = { items: null, at: 0, error: "", answers: {} };
  loadDeck();
}
/* After the experience deck: flights first when they're booked, otherwise the route. */
function afterDeck() {
  const d = S.deck, pick = v => (d.items || []).filter(x => d.answers[x.id] === v).map(({ id, title, cat }) => ({ id, title, cat }));
  S.a.deck = { yes: pick("yes"), maybe: pick("maybe"), no: pick("no") };
  if (S.flights.status === "booked") lookupFlights();
  else if (S.flights.status === "self") { setSelfFlights(); proposeRoute(); }
  else proposeRoute();
}

/* ---------- Experience deck: yes / maybe / no on ~10 curated experiences ---------- */
async function loadDeck() {
  S.stage = "deck"; render();
  const a = S.a, scope = TripAPI.skillScope(a);
  try {
    const r = await TripAPI.postJSON("/api/deck", {
      interests: scope.interests, love: [...(a.interestsLove || []), ...(a.food || [])], tags: scope.tags,
      start: a.start, end: a.end, cities: a.cities || [], profile: TripGenerator.profileText(a),
    }, { signal: ctrl.signal });
    S.deck.items = r.items || [];
    if (!S.deck.items.length) return afterDeck();
    render();
    // Photos from Google Places, a couple ahead of the card on screen.
    for (const it of S.deck.items) {
      TripGoogle.details({ name: it.query }).then(d => {
        // Prefer a wide shot: tall images are usually posters or menus.
        const ph = (d?.photos || []).find(p => p.w >= p.h * 1.2) || d?.photos?.[0];
        it.photo = ph ? TripGoogle.photoUrl(ph, 1000) : "";
        it.credit = ph?.author || "";
        if (S.stage === "deck" && S.deck.items[S.deck.at] === it) render();
      }).catch(() => { it.photo = ""; });
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    S.deck.error = e.message; render();
  }
}
function answerDeck(v) {
  const d = S.deck, it = d.items[d.at]; if (!it) return;
  d.answers[it.id] = v;
  d.at++;
  if (d.at >= d.items.length) afterDeck(); else render();
}
/* "I'll book them myself": the times they gave us, on the first and last day. */
function setSelfFlights() {
  const a = S.a;
  S.flights.in = { number: "", airline: "", booked: false, from: {}, to: { id: a.selfInAp, time: `${a.start} ${a.selfInTime}` } };
  S.flights.out = { number: "", airline: "", booked: false, from: { id: a.selfOutAp, time: `${a.end} ${a.selfOutTime}` }, to: {} };
  airportsFromFlights();
}

/* ---------- Dates in Japan ---------- */
function japanDates() {
  const f = S.flights, a = S.a;
  const inn = f.chosen?.outbound || f.in, out = f.chosen?.inbound || f.out;
  // A chosen option's outbound ends in Japan; its inbound starts there.
  const arrive = inn?.legs ? inn.legs[inn.legs.length - 1].to.time : inn?.to?.time;
  const leave = out?.legs ? out.legs[0].from.time : out?.from?.time;
  const start = arrive ? arrive.slice(0, 10) : a.start, end = leave ? leave.slice(0, 10) : a.end;
  return { start, end, nights: Math.max(1, nightsBetween(start, end)), arrive, leave };
}

/* ---------- Booked flights: look up their times ---------- */
async function lookupFlights() {
  S.stage = "flights"; S.flights.loading = true; render();
  const a = S.a;
  const get = body => TripAPI.postJSON("/api/flights", { mode: "lookup", ...body }, { signal: ctrl.signal }).catch(e => ({ error: e.message }));
  const [i, o] = await Promise.all([
    get({ flight: a.inFlight, date: a.inDate, from: a.inFrom }),
    get({ flight: a.outFlight, date: a.outDate, to: a.outTo }),
  ]);
  S.flights.loading = false;
  if (i.found) S.flights.in = { ...i.leg, booked: true };
  if (o.found) S.flights.out = { ...o.leg, booked: true };
  if (!i.found || !o.found) { S.flights.manual = true; S.flights.why = "lookup"; render(); return; }
  airportsFromFlights();
  proposeRoute();
}
function airportsFromFlights() {
  const i = S.flights.in?.to?.id, o = S.flights.out?.from?.id;
  if (i) S.arrive = [i];
  if (o) S.leave = [o];
}

/* ---------- Route ---------- */
async function proposeRoute() {
  S.stage = "route"; S.loading = true; S.error = ""; render();
  const d = japanDates(), a = S.a;
  const known = S.flights.in || S.flights.out;
  const booked = S.booked.map(h => `- ${h.name} in ${h.cityName}, ${h.checkIn} to ${h.checkOut} (booked)`).join("\n");
  const current = S.route && S.routeComment
    ? `\nCURRENT ROUTE\n${S.route.map(c => `- ${c.name}: ${c.nights} nights, around ${areaText(c)}`).join("\n")}\nTHE TRAVELLER'S REQUEST FOR CHANGES (follow it): ${S.routeComment}\n` : "";
  const prompt = `TRAVELLER
${TripGenerator.profileText(a)}

Propose the route for ${d.nights} nights in Japan, ${d.start} to ${d.end}${known ? ` (landing at ${S.flights.in?.to?.id} ${S.flights.in?.to?.time}, leaving from ${S.flights.out?.from?.id} ${S.flights.out?.from?.time})` : ""}.
${booked ? `Hotels already booked (keep these cities and nights):\n${booked}\n` : ""}${TripGenerator.deckText(a)}${current}
Apply the skill: base-change tolerance, airport-to-hotel alignment, holiday and weekend bottlenecks, quiet neighbourhoods.
Choose each neighbourhood for convenience above all: central, next to a major station on the lines they'll use most, close to what they'll see. Never an airport-area hotel.
Reply with JSON only:
{"cities":[{"name":"City","nights":3,"areas":[{"name":"neighbourhood or station name, 1–3 words","lat":35.68,"lng":139.77}],"areaWhy":"one short sentence on why these neighbourhoods","stay":"hotel|ryokan","why":"one sentence on why this city","dayTrips":["Nara"]}],
 "arriveAirport":"${known ? "as given" : "HND|NRT|KIX|FUK|CTS|NGO"}","leaveAirport":"${known ? "as given" : "HND|NRT|KIX|FUK|CTS|NGO"}",
 "note":"two short sentences on the route logic"}
The nights must add up to exactly ${d.nights}. Day trips are not separate cities. Use "ryokan" only where an onsen ryokan night suits them.
"areas" are the 2–3 best neighbourhoods to stay in for this traveller (best first), next to each other or on the same lines, with each one's centre as lat/lng. Small towns get one.`;
  try {
    const res = await TripAPI.postJSON("/api/llm", {
      model: "deepseek-flash", temperature: 0.4, max_tokens: 1800, response_format: { type: "json_object" },
      skill: { ...TripAPI.skillScope(a), catalog: false }, messages: [{ role: "user", content: prompt }],
    }, { signal: ctrl.signal });
    const r = JSON.parse(res.choices?.[0]?.message?.content || "{}");
    // A city can appear twice (e.g. Tokyo at both ends): `id` is the stop, `key` the city.
    S.route = (r.cities || []).filter(c => c?.name && +c.nights > 0).map((c, i) => ({
      id: `${slug(c.name)}-${i + 1}`, key: slug(c.name), name: String(c.name).slice(0, 40), nights: Math.round(+c.nights),
      areas: (Array.isArray(c.areas) ? c.areas : []).filter(x => x?.name).slice(0, 3)
        .map(x => ({ name: String(x.name).replace(/\s*\(.*\)\s*/g, "").slice(0, 40), lat: +x.lat || null, lng: +x.lng || null })),
      areaWhy: String(c.areaWhy || "").slice(0, 160),
      stay: c.stay === "ryokan" ? "ryokan" : "hotel", why: String(c.why || "").slice(0, 200), dayTrips: (c.dayTrips || []).map(String).slice(0, 4),
    }));
    S.route.forEach(c => { if (!c.areas.length) c.areas = [{ name: c.name, lat: null, lng: null }]; });
    if (!S.route.length) throw new Error("The planner did not return a route. Try again.");
    S.note = String(r.note || "");
    S.routeComment = "";
    if (!known) {
      const ap = v => /^[A-Z]{3}$/.test(v) ? (TOKYO.includes(v) ? TOKYO : [v]) : TOKYO;
      S.arrive = ap(r.arriveAirport); S.leave = ap(r.leaveAirport);
    }
    S.hotels = {};
    fitNights();
  } catch (e) {
    if (e.name === "AbortError") return;
    S.error = e.message || "Could not plan the route.";
  }
  S.loading = false; render();
}
const areaText = c => c.areas.map(a => a.name).join(", ");
/* Keep the route's nights equal to the nights in Japan (after a flight is chosen they can shift). */
function fitNights() {
  const want = japanDates().nights;
  let have = S.route.reduce((s, c) => s + c.nights, 0);
  while (have !== want && S.route.length) {
    const c = [...S.route].sort((x, y) => y.nights - x.nights)[0];
    if (have > want && c.nights <= 1) break;
    c.nights += have < want ? 1 : -1; have += have < want ? 1 : -1;
  }
  datesFromNights();
}
function datesFromNights() {
  let at = japanDates().start;
  S.route.forEach(c => { c.checkIn = at; at = addDays(at, c.nights); c.checkOut = at; });
}

/* ---------- Flights to choose from ---------- */
async function searchFlights() {
  S.stage = "flights"; S.flights.loading = true; S.flights.error = ""; render();
  const a = S.a;
  try {
    S.flights.options = await TripAPI.postJSON("/api/flights", {
      mode: "search", from: a.homeAirport, arrive: S.arrive, leave: S.leave, outbound: S.flights.dates.out, inbound: S.flights.dates.back,
      adults: +a.adults || 1, children: (a.kids || "").split(/[^\d]+/).filter(Boolean).length, cabin: +a.cabin || 1, currency: a.currency,
      filters: S.flights.filters,
    }, { signal: ctrl.signal });
    S.flights.chosen = null;
  } catch (e) {
    if (e.name === "AbortError") return;
    S.flights.error = e.message;
  }
  S.flights.loading = false; render();
}

/* Nearby days, 3 either side of the planned date: one quick one-way search per day shows which
   days have a short flight, before a full search. dir "out" = to Japan, "back" = home. */
const NEAR = 3;
function nearDates(dir) {
  const base = dir === "out" ? S.a.start : S.a.end, other = S.flights.dates[dir === "out" ? "back" : "out"];
  return Array.from({ length: NEAR * 2 + 1 }, (_, i) => addDays(base, i - NEAR))
    .filter(d => d >= new Date().toLocaleDateString("en-CA") && (dir === "out" ? d < other : d > other));
}
async function loadNear(dir) {
  const a = S.a, f = S.flights;
  f.near[dir] = { loading: true }; render();
  try {
    const r = await TripAPI.postJSON("/api/flights", {
      mode: "dates", from: dir === "out" ? a.homeAirport : S.leave, to: dir === "out" ? S.arrive : a.homeAirport, dates: nearDates(dir),
      adults: +a.adults || 1, children: (a.kids || "").split(/[^\d]+/).filter(Boolean).length, cabin: +a.cabin || 1, currency: a.currency,
    }, { signal: ctrl.signal });
    f.near[dir] = { currency: r.currency, days: r.days || [] };
  } catch (e) {
    if (e.name === "AbortError") return;
    f.near[dir] = { error: e.message };
  }
  render();
}
function setFlightDate(dir, iso) {
  const f = S.flights;
  if (!iso || f.dates[dir] === iso) return;
  f.dates[dir] = iso;
  f.note = `Searching with ${dir === "out" ? "the flight there" : "the flight home"} on ${fmtDay(iso)}. Your route gains or loses nights to match.`;
  searchFlights();
}

/* The traveller's words about the flights ("the way back is too long") become search filters. */
async function adjustFlights(comment) {
  S.flights.loading = true; S.flights.error = ""; render();
  const o = S.flights.options;
  const shown = (o?.options || []).map(x => `${x.label}: ${x.price} ${o.currency}; out ${hm(x.outbound.minutes)}, ${x.outbound.stops} stops, departs ${x.outbound.legs[0].from.time.slice(11, 16)}; back ${hm(x.inbound.minutes)}, ${x.inbound.stops} stops, departs ${x.inbound.legs[0].from.time.slice(11, 16)}`).join("\n");
  try {
    const res = await TripAPI.postJSON("/api/llm", {
      model: "deepseek-flash", temperature: 0.1, max_tokens: 400, response_format: { type: "json_object" },
      messages: [{ role: "user", content: `Turn a traveller's wishes about their flights into search filters.
OPTIONS THEY SAW
${shown || "none"}
CURRENT FILTERS ${JSON.stringify(S.flights.filters)}
CURRENT DATES: there ${S.flights.dates.out}, home ${S.flights.dates.back}. They may move either by up to ${NEAR} days (there: ${addDays(S.a.start, -NEAR)}…${addDays(S.a.start, NEAR)}; home: ${addDays(S.a.end, -NEAR)}…${addDays(S.a.end, NEAR)}).
${["out", "back"].map(k => S.flights.near[k]?.days ? `NEARBY DAYS ${k === "out" ? "THERE" : "HOME"} (one-way): ${S.flights.near[k].days.filter(d => d.fastest).map(d => `${d.date} fastest ${hm(d.fastest.minutes)} ${d.fastest.stops} stops ${d.fastest.price}, cheapest ${d.cheapest.price}`).join("; ")}` : "").filter(Boolean).join("\n")}
THEIR WORDS: "${comment}"
Reply with JSON only, keeping current filters unless their words change them:
{"stops": 1 (nonstop) | 2 (at most 1 stop) | 3 (at most 2 stops) | null, "maxMinutes": longest acceptable flight time per direction in minutes or null,
 "outDepartHours": [earliest, latest] departure hour 0-23 for the flight there, or null, "backDepartHours": [earliest, latest] for the flight home, or null,
 "includeAirlines": [IATA codes] or [], "excludeAirlines": [IATA codes] or [], "maxPrice": total price or null,
 "outDate": "YYYY-MM-DD" only if their words ask to fly there on another day (or a better day is clearly needed and allowed), else null, "backDate": the same for the flight home,
 "note": "one short sentence to the traveller on what you changed"}` }],
    }, { signal: ctrl.signal });
    const r = JSON.parse(res.choices?.[0]?.message?.content || "{}");
    S.flights.note = String(r.note || "");
    delete r.note;
    // Dates move only within the allowed window, and the flight home stays after the flight there.
    const inside = (v, base) => /^\d{4}-\d{2}-\d{2}$/.test(v || "") && Math.abs(nightsBetween(base, v)) <= NEAR ? v : null;
    const out = inside(r.outDate, S.a.start) || S.flights.dates.out, back = inside(r.backDate, S.a.end) || S.flights.dates.back;
    if (back > out) S.flights.dates = { out, back };
    delete r.outDate; delete r.backDate;
    S.flights.filters = Object.fromEntries(Object.entries(r).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));
  } catch (e) {
    if (e.name === "AbortError") return;
    S.flights.loading = false; S.flights.error = e.message; render(); return;
  }
  searchFlights();
}

/* ---------- Hotels ---------- */
function citiesNeedingHotels() {
  return S.route.filter(c => !S.booked.some(h => h.city === c.key || slug(h.cityName) === c.key));
}
async function searchHotels(only) {
  S.stage = "hotels"; render();
  const a = S.a, profile = TripGenerator.profileText({ ...a, bed: S.prefs.bed, hotelPrefs: S.prefs.priorities });
  const kids = (a.kids || "").split(/[^\d]+/).filter(Boolean).map(Number);
  await Promise.all(citiesNeedingHotels().filter(c => !only || c.id === only).map(async c => {
    S.hotels[c.id] = { loading: true, chosen: null };
    render();
    try {
      const r = await TripAPI.postJSON("/api/hotels", {
        city: c.name, areas: c.areas, checkIn: c.checkIn, checkOut: c.checkOut,
        adults: +a.adults || 2, children: kids, currency: a.currency, maxPerNight: S.prefs.max || null,
        priorities: S.prefs.priorities, bed: S.prefs.bed, style: c.stay, comment: S.prefs.comment, profile,
      }, { signal: ctrl.signal });
      S.hotels[c.id] = { loading: false, chosen: null, list: r.hotels, currency: r.currency };
    } catch (e) {
      if (e.name === "AbortError") return;
      S.hotels[c.id] = { loading: false, error: e.message };
    }
    render();
  }));
}

/* ---------- Finish ---------- */
function finish() {
  const a = S.a, d = japanDates(), f = S.flights;
  const leg = (j, end) => j?.legs ? { ...(end ? j.legs[j.legs.length - 1] : j.legs[0]), booked: false } : j;
  const flights = f.chosen
    ? { in: { ...leg(f.chosen.outbound, true), from: f.chosen.outbound.legs[0].from }, out: { ...leg(f.chosen.inbound, false), to: f.chosen.inbound.legs.at(-1).to },
        price: f.chosen.price, currency: f.options.currency, link: f.chosen.link, label: f.chosen.label }
    : { in: f.in, out: f.out };
  const hotels = [
    ...S.booked.map(h => ({ ...h, city: S.route.find(c => c.key === h.city || slug(h.cityName) === c.key)?.key || h.city })),
    ...citiesNeedingHotels().map(c => {
      const st = S.hotels[c.id], h = st?.list?.find(x => x.id === st.chosen);
      return h && { key: slug(h.name), name: h.name, city: c.key, cityName: c.name, checkIn: c.checkIn, checkOut: c.checkOut,
        address: h.address, lat: h.lat, lng: h.lng, price: h.cheapest.perNight, currency: st.currency, source: h.cheapest.source, link: h.cheapest.link };
    }).filter(Boolean),
  ];
  S.onDone({ ...a, start: d.start, end: d.end, flex: "0", route: S.route.map(c => ({ key: c.key, name: c.name, nights: c.nights, area: areaText(c) })),
    flights, hotels, hotelPrefs: S.prefs.priorities, bed: S.prefs.bed, maxNightly: S.prefs.max || "" });
}

/* ---------- Rendering ---------- */
const STAGES = [["deck", "Experiences"], ["flights", "Flights"], ["route", "Route"], ["hotels", "Hotels"], ["done", "Itinerary"]];
function steps() {
  // Booked or self-booked flights come first; flights to choose come after the route.
  const order = S.flights.status === "help" ? ["deck", "route", "flights", "hotels", "done"] : ["deck", "flights", "route", "hotels", "done"];
  const at = order.indexOf(S.stage);
  return `<ol class="ob-steps bk-steps">${order.map((k, i) => `<li class="${i < at ? "done" : i === at ? "now" : ""}">${STAGES.find(s => s[0] === k)[1]}</li>`).join("")}</ol>`;
}
const spinner = text => `<p class="bk-loading"><span class="bk-spin" aria-hidden="true"></span>${esc(text)}</p>`;
const errorBox = (text, act) => `<p class="ob-error">${esc(text)}</p><div class="ob-nav"><button type="button" class="btn" data-act="${act}">Try again</button></div>`;

function render() {
  if (!S) return;
  const body = S.stage === "deck" ? deckView() : S.stage === "route" ? routeView() : S.stage === "flights" ? flightsView() : S.stage === "hotels" ? hotelsView() : "";
  root.classList.toggle("wide", S.stage === "hotels");
  root.innerHTML = `${steps()}${body}`;
}

const CAT_LABEL = {
  ancient_history_temples_castles: "Temples & shrines", samurai_edo_modern_history: "Castles & Edo towns", fine_dining_omakase_kaiseki: "Fine dining",
  street_food_izakaya_markets: "Street food & markets", ramen_soba_udon_hunting: "Noodles", specialty_coffee_kissaten: "Coffee & tea",
  onsen_ryokan_baths: "Onsen & ryokan", nature_gardens_scenic_trains: "Nature & scenic trains", seasonal_festivals_illuminations: "Seasons & festivals",
  contemporary_art_architecture: "Art & architecture", anime_manga_gaming_akiba: "Pop culture", nightlife_cocktails_bars: "Nightlife",
  watches_horology_books_stationery: "Crafts & shopping", jdm_cars_motorsport: "Car culture", performing_arts_immersions: "Arts & hands-on",
};
function deckView() {
  const d = S.deck;
  if (d.error) return `<h1>Would you do this?</h1><p class="ob-error">${esc(d.error)}</p><div class="ob-nav"><button type="button" class="btn" data-act="deck-retry">Try again</button><span class="grow"></span><button type="button" class="btn" data-act="deck-skip">Skip this step</button></div>`;
  if (!d.items) return `<h1>Would you do this?</h1>${spinner("Picking experiences from our Japan guide that fit your interests and dates…")}`;
  const it = d.items[d.at], n = d.items.length;
  return `<h1>Would you do this?</h1>
    <p class="ob-lede">${n} hand-picked experiences that fit your interests and dates. Your answers decide what goes in the plan.</p>
    <div class="bk-deck">
      <div class="bk-deck-bar" aria-hidden="true"><i style="width:${(d.at / n) * 100}%"></i></div>
      <article class="bk-card" id="bk-card" aria-live="polite">
        <div class="bk-card-photo">${it.photo ? `<img src="${esc(it.photo)}" alt="${esc(it.title)}">` : it.photo === "" ? "" : '<span class="bk-spin" aria-hidden="true"></span>'}
          <span class="bk-card-n">${d.at + 1} / ${n}</span>${it.credit ? `<span class="bk-card-credit">Photo: ${esc(it.credit)} · Google Maps</span>` : ""}</div>
        <div class="bk-card-b">
          <span class="tag">${esc(CAT_LABEL[it.cat] || "Experience")}</span>
          <h2>${esc(it.title)}</h2>
          <p class="bk-card-where">${esc(it.location)}${it.timing ? ` · ${esc(it.timing)}` : ""}</p>
          <p>${esc(it.pitch)}</p>
        </div>
      </article>
      <div class="bk-deck-btns">
        <button type="button" class="bk-vote no" data-vote="no" aria-label="No, not for me"><span aria-hidden="true">✕</span>No</button>
        <button type="button" class="bk-vote maybe" data-vote="maybe" aria-label="Maybe"><span aria-hidden="true">?</span>Maybe</button>
        <button type="button" class="bk-vote yes" data-vote="yes" aria-label="Yes, I'd do this"><span aria-hidden="true">♥</span>Yes</button>
      </div>
      <p class="field-hint bk-deck-hint">Swipe, or use ← no · ↓ maybe · → yes</p>
    </div>
    <div class="ob-nav"><button type="button" class="btn" data-act="back">Back to questions</button><span class="grow"></span>
      <button type="button" class="btn" data-act="deck-skip">${d.at ? "That's enough — continue" : "Skip this step"}</button></div>`;
}

function flightLine() {
  const f = S.flights;
  if (f.status === "help" && !f.chosen) return "Flights: we'll show you options next, for these airports.";
  const d = japanDates();
  return `You land ${fmtWhen(d.arrive)} at ${esc(S.arrive.join("/"))} and leave ${fmtWhen(d.leave)} from ${esc(S.leave.join("/"))}.`;
}
function routeView() {
  if (S.loading) return `<h1>Your route</h1>${spinner(S.routeComment ? "Reworking the route with your comments…" : "Planning which cities, how many nights, and where to stay…")}`;
  if (S.error) return `<h1>Your route</h1>${errorBox(S.error, "route")}`;
  const d = japanDates(), total = S.route.reduce((s, c) => s + c.nights, 0);
  return `<h1>Your route</h1>
    <p class="ob-lede">${fmtDay(d.start)} to ${fmtDay(d.end)} · ${d.nights} nights in Japan. ${esc(S.note)}</p>
    <p class="bk-flightline">${flightLine()}</p>
    <div class="bk-route">${S.route.map((c, i) => `
      <div class="bk-city">
        <div class="bk-city-n" aria-hidden="true">${i + 1}</div>
        <div class="bk-city-b">
          <b>${esc(c.name)}</b>${c.stay === "ryokan" ? ' <span class="tag k-hotel">Ryokan</span>' : ""}
          ${c.why ? `<p>${esc(c.why)}</p>` : ""}
          <label class="bk-area"><span>Best areas to stay</span><input value="${esc(areaText(c))}" data-area="${i}" aria-label="Neighbourhoods to stay in, ${esc(c.name)}, separated by commas"></label>
          <small>${esc(c.areaWhy)}${c.dayTrips.length ? `${c.areaWhy ? " · " : ""}Day trips: ${esc(c.dayTrips.join(", "))}` : ""}</small>
        </div>
        <div class="stepper" role="group" aria-label="Nights in ${esc(c.name)}">
          <button type="button" data-nights="${i}" data-d="-1" aria-label="One night fewer in ${esc(c.name)}">−</button>
          <span><b>${c.nights}</b> night${c.nights === 1 ? "" : "s"}</span>
          <button type="button" data-nights="${i}" data-d="1" aria-label="One night more in ${esc(c.name)}">+</button>
        </div>
      </div>`).join("")}
    </div>
    <p class="bk-total ${total === d.nights ? "" : "warn"}">${total} of ${d.nights} nights planned${total === d.nights ? "" : " — adjust the nights to match"}</p>
    <div class="field bk-comment">
      <span class="field-k" id="bk-rc-k">Want something different?</span>
      <textarea id="bk-route-comment" rows="2" aria-labelledby="bk-rc-k" placeholder="e.g. Add a night in Osaka, skip Hakone, stay near Shibuya instead">${esc(S.routeComment)}</textarea>
      <div><button type="button" class="btn" data-act="route-update">Update route</button></div>
    </div>
    <div class="ob-nav">
      <button type="button" class="btn" data-act="back">Back to questions</button>
      <span class="grow"></span>
      <button type="button" class="btn primary" data-act="route-ok"${total === d.nights ? "" : " disabled"}>${S.flights.status === "help" ? "Looks good — find flights" : "Looks good — find hotels"}</button>
    </div>`;
}

/* One line per direction, like a fare list: times, length, stops, airline. Details on demand. */
function legLine(j, cur) {
  const first = j.legs[0], last = j.legs[j.legs.length - 1];
  const t = x => (x || "").slice(11, 16);
  const plus = nightsBetween(first.from.time.slice(0, 10), last.to.time.slice(0, 10));
  return `<div class="bk-fl-leg">
    <img src="${esc(first.logo)}" alt="${esc(first.airline)}" width="22" height="22" loading="lazy">
    <span class="bk-fl-t"><b>${t(first.from.time)}</b> <small>${esc(first.from.id)}</small></span>
    <span class="bk-fl-line" aria-hidden="true"><i></i>${j.stops ? `<em>${esc(j.layovers.map(l => l.id).join(" · "))}</em>` : ""}</span>
    <span class="bk-fl-t"><b>${t(last.to.time)}${plus > 0 ? `<sup>+${plus}</sup>` : ""}</b> <small>${esc(last.to.id)}</small></span>
    <span class="bk-fl-d">${hm(j.minutes)}<small class="${j.stops ? "" : "ok"}">${j.stops ? `${j.stops} stop${j.stops > 1 ? "s" : ""}` : "Nonstop"}</small></span>
  </div>`;
}
function legDetails(j, title) {
  const day = x => x ? fmtDay(x.slice(0, 10)) : "";
  return `<div class="bk-fl-det"><p class="bk-k">${title} · ${day(j.legs[0].from.time)}</p>${j.legs.map((l, i) => `
    <p><b>${esc(l.from.time.slice(11, 16))} ${esc(l.from.name)}</b> → <b>${esc(l.to.time.slice(11, 16))} ${esc(l.to.name)}</b><br>
      <small>${esc(l.airline)} ${esc(l.number)} · ${hm(l.minutes)}${l.airplane ? ` · ${esc(l.airplane)}` : ""}${l.legroom ? ` · legroom ${esc(l.legroom)}` : ""}${l.overnight ? " · overnight" : ""}</small></p>
    ${j.layovers[i] ? `<p class="bk-fl-lay">${hm(j.layovers[i].minutes)} stop in ${esc(j.layovers[i].name)}${j.layovers[i].overnight ? " (overnight)" : ""}</p>` : ""}`).join("")}</div>`;
}
function flightsView() {
  const f = S.flights;
  if (f.loading) return `<h1>Flights</h1>${spinner(f.status === "booked" ? "Looking up your flights…" : f.note || f.filters && Object.keys(f.filters).length ? "Searching again with your wishes…" : "Comparing fares on Google Flights…")}`;
  if (f.manual) return manualFlightsView();
  if (f.status === "booked") return "";
  const commentBox = `<div class="field bk-comment">
      <span class="field-k" id="bk-fc-k">Not quite right?</span>
      <textarea id="bk-flight-comment" rows="2" aria-labelledby="bk-fc-k" placeholder="e.g. The flight back is too long, nonstop only, nothing before 9am"></textarea>
      <div><button type="button" class="btn" data-act="flight-update">Search again</button>${Object.keys(f.filters).length ? ' <button type="button" class="btn" data-act="flight-reset">Clear my wishes</button>' : ""}</div>
    </div>`;
  if (f.error) return `<h1>Flights</h1><p class="ob-error">${esc(f.error)}</p>${commentBox}<div class="ob-nav"><button type="button" class="btn" data-act="flights">Try again</button><span class="grow"></span><button type="button" class="btn" data-act="skip-flights">Enter my flight times instead</button></div>`;
  const o = f.options; if (!o) return "";
  const ins = o.insights?.typical ? ` Usually ${money(o.insights.typical[0], o.currency)}–${money(o.insights.typical[1], o.currency)}.` : "";
  const n = +S.a.adults || 1;
  return `<h1>Pick your flights</h1>
    <p class="ob-lede">${esc(S.a.homeAirportLabel || S.a.homeAirport.replace(/,/g, "/"))} → ${esc(S.arrive.join("/"))}${S.arrive.join() !== S.leave.join() ? `, home from ${esc(S.leave.join("/"))}` : ""} · live from Google Flights.${esc(ins)}</p>
    ${f.note ? `<p class="bk-flightline">${esc(f.note)}</p>` : ""}
    ${datesView()}
    <div class="bk-fls">${o.options.map((x, i) => `
      <article class="bk-fl${f.chosen === x ? " on" : ""}">
        <div class="bk-fl-main">
          <span class="tag bk-fl-tag ${i === 0 ? "y-booked" : ""}">${esc(x.label)}</span>
          <div class="bk-fl-legs">${legLine(x.outbound)}${legLine(x.inbound)}</div>
          <div class="bk-fl-buy"><b>${money(x.price, o.currency)}</b><small>total for ${n}</small>
            <button type="button" class="btn ${f.chosen === x ? "primary" : ""}" data-flight="${i}">${f.chosen === x ? "Chosen ✓" : "Choose"}</button></div>
        </div>
        <details class="bk-fl-more"><summary>Details</summary>
          <div class="bk-fl-dets">${legDetails(x.outbound, "There")}${legDetails(x.inbound, "Back")}</div>
          <a class="link" href="${esc(x.link)}" target="_blank" rel="noopener">See this fare on Google Flights ↗</a>
        </details>
      </article>`).join("")}
    </div>
    ${commentBox}
    <div class="ob-nav">
      <button type="button" class="btn" data-act="to-route">Back to the route</button>
      <span class="grow"></span>
      <button type="button" class="btn" data-act="skip-flights">I'll enter my own times</button>
      <button type="button" class="btn primary" data-act="flights-ok"${f.chosen ? "" : " disabled"}>Continue to hotels</button>
    </div>`;
}
/* The dates being searched, with nearby days to compare on demand. */
function datesView() {
  const f = S.flights;
  const row = (dir, label) => {
    const n = f.near[dir], cur = f.dates[dir];
    let body = "";
    if (n?.loading) body = `<p class="bk-loading"><span class="bk-spin" aria-hidden="true"></span>Checking nearby days…</p>`;
    else if (n?.error) body = `<p class="ob-error">${esc(n.error)}</p>`;
    else if (n?.days) {
      const ok = n.days.filter(d => d.fastest), mins = ok.map(d => d.fastest.minutes);
      // Only point out the fastest day when the days actually differ.
      const quick = mins.length && Math.min(...mins) < Math.max(...mins) ? Math.min(...mins) : -1;
      body = `<div class="bk-days" role="group" aria-label="${esc(label)}: nearby days">${n.days.map(d => `<button type="button" class="bk-day${d.date === cur ? " on" : ""}${d.fastest?.minutes === quick ? " best" : ""}" data-date-dir="${dir}" data-date="${d.date}"${d.fastest ? "" : " disabled"} aria-pressed="${d.date === cur}">
          <b>${esc(new Date(d.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric" }))}</b>${d.fastest ? `<span>${hm(d.fastest.minutes)}</span><small>${d.fastest.stops ? d.fastest.stops + " stop" + (d.fastest.stops > 1 ? "s" : "") : "nonstop"}</small><small>${money(d.cheapest.price, n.currency)}</small>` : `<small>${d.error ? "Couldn't check" : "No flights"}</small>`}</button>`).join("")}</div>
        <p class="field-hint">Fastest flight and lowest one-way fare each day. Tap a day to search round trips with it.</p>`;
    }
    return `<div class="bk-dates-row"><span class="field-k">${esc(label)}</span><b>${esc(fmtDay(cur))}</b>${n?.days || n?.loading ? "" : `<button type="button" class="btn" data-near="${dir}">Compare nearby days</button>`}</div>${body}`;
  };
  return `<div class="bk-dates">${row("out", "Flight there")}${row("back", "Flight home")}</div>`;
}
function manualFlightsView() {
  const f = S.flights, a = S.a, lookup = f.why === "lookup";
  const ap = (k, sel) => `<select data-man="${k}-ap">${JP_AIRPORTS.map(([c, n]) => `<option value="${c}"${c === sel ? " selected" : ""}>${n} (${c})</option>`).join("")}</select>`;
  const row = (label, leg, k) => leg && lookup
    ? `<div class="bk-booked"><span class="tag y-booked">Booked</span><b>${esc(label)}: ${esc(leg.airline)} ${esc(leg.number)}</b><small>${esc(leg.from.id)} ${esc(leg.from.time)} → ${esc(leg.to.id)} ${esc(leg.to.time)}</small></div>`
    : `<div class="bk-manual"><p><b>${esc(label)}</b>${lookup ? ` — we couldn't find ${esc(k === "in" ? a.inFlight : a.outFlight)} on that date. Add it by hand.` : ""}</p>
        <div class="ob-row">
          <label class="field"><span class="field-k">${k === "in" ? "Lands at" : "Leaves from"}</span>${ap(k, k === "in" ? S.arrive[0] : S.leave[0])}</label>
          <label class="field"><span class="field-k">${k === "in" ? "Landing day" : "Take-off day"}</span><select data-man="${k}-day">${[-1, 0, 1].map(n => addDays(k === "in" ? a.start : a.end, n)).map(d => `<option value="${d}"${d === (k === "in" ? a.start : a.end) ? " selected" : ""}>${esc(fmtDay(d))}</option>`).join("")}</select></label>
          <label class="field"><span class="field-k">Time (Japan)</span><select data-man="${k}-time">${Array.from({ length: 48 }, (_, i) => `${String(i / 2 | 0).padStart(2, "0")}:${i % 2 ? "30" : "00"}`).map(t => `<option${t === (k === "in" ? "15:00" : "12:00") ? " selected" : ""}>${t}</option>`).join("")}</select></label>
        </div></div>`;
  return `<h1>Your flights</h1>
    <p class="ob-lede">${lookup ? "Here's what we found." : "Tell us roughly when you land and leave, so the first and last day fit."}</p>
    ${row("Into Japan", f.in, "in")}${row("Home", f.out, "out")}
    <div class="ob-nav"><button type="button" class="btn" data-act="${lookup ? "back" : "to-flights-options"}">Back</button><span class="grow"></span>
      <button type="button" class="btn primary" data-act="manual-ok">Continue</button></div>`;
}

/* Hotel cards: a big photo with arrows, thumbnails below, and a switch to the room's photos. */
function gallery(h, stop) {
  const sets = { hotel: h.images, room: h.roomImages || [] };
  const first = sets.hotel[0] || sets.room[0];
  return `<div class="bk-gal" data-stop="${esc(stop.id)}" data-gal="${esc(h.id)}" data-set="hotel" data-i="0">
    <div class="bk-gal-main">
      ${first ? `<img src="${esc(first.full || first.thumb)}" alt="${esc(h.name)}" loading="lazy" referrerpolicy="no-referrer">` : ""}
      <button type="button" class="bk-gal-nav prev" data-gal-step="-1" aria-label="Previous photo">‹</button>
      <button type="button" class="bk-gal-nav next" data-gal-step="1" aria-label="Next photo">›</button>
      <span class="bk-gal-n">1 / ${sets.hotel.length}</span>
    </div>
    <div class="bk-gal-tabs" role="tablist"><button type="button" class="on" data-gal-set="hotel" role="tab" aria-selected="true">Hotel · ${sets.hotel.length}</button>${sets.room.length ? `<button type="button" data-gal-set="room" role="tab" aria-selected="false">${esc(h.roomLabel || "Rooms")} · ${sets.room.length}</button>` : ""}</div>
    <div class="bk-gal-thumbs">${sets.hotel.map((im, i) => `<button type="button" data-gal-to="${i}"${i ? "" : ' class="on"'} aria-label="Photo ${i + 1}"><img src="${esc(im.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join("")}</div>
  </div>`;
}
function hotelCard(h, stop, st) {
  const on = st.chosen === h.id, cur = st.currency;
  return `<article class="bk-hotel${on ? " on" : ""}">
    ${gallery(h, stop)}
    <div class="bk-hotel-b">
      <h3>${esc(h.name)}</h3>
      <p class="bk-meta">${h.stars ? `${h.stars}-star · ` : ""}${h.rating ? `★ ${h.rating} (${h.reviews?.toLocaleString("en")})` : ""}${h.distanceKm != null && h.nearArea ? ` · ${esc(h.nearArea)}${h.distanceKm > 0.4 ? `, ${h.distanceKm < 1 ? Math.round(h.distanceKm * 1000) + " m" : h.distanceKm.toFixed(1) + " km"} away` : ""}` : ""}</p>
      ${h.headline ? `<p class="bk-head">${esc(h.headline)}</p>` : ""}
      ${h.why ? `<p>${esc(h.why)}</p>` : ""}
      ${h.quote ? `<blockquote class="bk-quote">“${esc(h.quote)}”<cite>Guest review on Google</cite></blockquote>` : ""}
      ${h.room ? `<p class="bk-room">Room to book: <b>${esc(h.room)}</b></p>` : ""}
      ${h.watch ? `<p class="bk-watch">${esc(h.watch)}</p>` : ""}
      <div class="bk-price-line"><b>${money(h.cheapest.perNight, cur)}</b> <span>per room, per night · ${money(h.cheapest.total, cur)} total</span>
        <small>Best price on ${esc(h.cheapest.source)}${h.offers.length > 1 ? ` · ${h.offers.slice(1, 3).map(o => `${esc(o.source)} ${money(o.perNight, cur)}`).join(" · ")}` : ""}</small></div>
      <div class="bk-actions">
        <button type="button" class="btn ${on ? "primary" : ""}" data-hotel="${esc(stop.id)}" data-id="${esc(h.id)}">${on ? "Chosen ✓" : "Choose this"}</button>
        <a class="btn" href="${esc(h.cheapest.link)}" target="_blank" rel="noopener" title="Book on ${esc(h.cheapest.source)}"><span>${h.cheapest.official ? "Book direct" : `Book on ${esc(h.cheapest.source)}`}</span> ↗</a>
      </div>
    </div>
  </article>`;
}
function hotelsView() {
  const need = citiesNeedingHotels();
  if (!need.some(c => S.hotels[c.id])) return prefsView();
  const all = need.every(c => S.hotels[c.id]?.chosen);
  return `<h1>Pick your hotels</h1>
    <p class="ob-lede">Three picks for each stop, checked against your priorities and recent guest reviews, with live prices from every booking site. Choose one each; you book it yourself.</p>
    ${S.booked.map(h => `<div class="bk-booked"><span class="tag y-booked">Booked</span><b>${esc(h.cityName)}: ${esc(h.name)}</b><small>${fmtDay(h.checkIn)} – ${fmtDay(h.checkOut)}</small></div>`).join("")}
    ${need.map(c => {
      const st = S.hotels[c.id] || {};
      return `<section class="bk-city-hotels"><h2>${esc(c.name)} <small>Around ${esc(areaText(c))} · ${fmtDay(c.checkIn)} – ${fmtDay(c.checkOut)} · ${c.nights} night${c.nights === 1 ? "" : "s"}</small></h2>
        ${st.loading ? spinner(`Checking prices and reviews in ${c.name}…`) : st.error ? `<p class="ob-error">${esc(st.error)}</p><div><button type="button" class="btn" data-retry-hotels="${esc(c.id)}">Try again</button></div>` : `<div class="bk-hotels">${(st.list || []).map(h => hotelCard(h, c, st)).join("")}</div>`}
      </section>`;
    }).join("")}
    <div class="ob-nav">
      <button type="button" class="btn" data-act="hotel-prefs">Change hotel preferences</button>
      <span class="grow"></span>
      <button type="button" class="btn primary" data-act="build"${all ? "" : " disabled"}>Build my itinerary</button>
    </div>`;
}
function prefsView() {
  const p = S.prefs, cur = S.a.currency || "USD", n = +S.a.adults || 2;
  if (!citiesNeedingHotels().length) return `<h1>Hotels</h1><p class="ob-lede">All your hotels are booked.</p><div class="ob-nav"><span class="grow"></span><button type="button" class="btn primary" data-act="build">Build my itinerary</button></div>`;
  return `<h1>What matters in a hotel?</h1>
    <p class="ob-lede">We'll find three for each stop: ${esc(citiesNeedingHotels().map(c => `${c.name} (${c.nights} night${c.nights === 1 ? "" : "s"})`).join(", "))}.</p>
    <div class="ob-group"><span class="field-k">Priorities <i>pick a few</i></span>
      <div class="ob-chips">${PRIORITIES.map(x => `<label class="ob-chip"><input type="checkbox" data-pri value="${esc(x)}"${p.priorities.includes(x) ? " checked" : ""}><span>${esc(x)}</span></label>`).join("")}</div></div>
    <div class="ob-group"><span class="field-k">Beds</span>
      <div class="ob-chips">${[["one_large_bed", "One large bed"], ["two_twin_beds", "Two beds"], ["family_apartment", "Apartment for a family"], ["multi_room", "Two rooms"]].map(([v, l]) => `<label class="ob-chip"><input type="radio" name="bk-bed" value="${v}"${p.bed === v ? " checked" : ""}><span>${l}</span></label>`).join("")}</div></div>
    <label class="field"><span class="field-k">Max per room, per night (${esc(cur)}) <i>optional</i></span><input type="number" id="bk-max" min="0" step="10" value="${esc(p.max)}">
      <span class="field-hint">For one room for all ${n} of you, before taxes shown by some sites.</span></label>
    <label class="field"><span class="field-k">Anything else? <i>optional</i></span><textarea id="bk-hotel-comment" rows="2" placeholder="e.g. a bathtub, more character, walking distance to Shibuya station">${esc(p.comment)}</textarea></label>
    <div class="ob-nav">
      <button type="button" class="btn" data-act="${S.flights.status === "help" && S.flights.options ? "to-flights" : "to-route"}">Back</button>
      <span class="grow"></span>
      <button type="button" class="btn primary" data-act="find-hotels">Find hotels</button>
    </div>`;
}

/* ---------- Events ---------- */
function readPrefs() {
  S.prefs.priorities = [...root.querySelectorAll("[data-pri]:checked")].map(i => i.value);
  S.prefs.bed = root.querySelector('[name="bk-bed"]:checked')?.value || S.prefs.bed;
  S.prefs.max = +$("#bk-max", root)?.value || "";
  S.prefs.comment = $("#bk-hotel-comment", root)?.value.trim() || "";
}
const galleryHotel = g => S.hotels[g.dataset.stop]?.list?.find(x => x.id === g.dataset.gal);
const gallerySetOf = (g, hotel) => g.dataset.set === "room" ? hotel.roomImages || [] : hotel.images;
function galleryShow(g, i) {
  const hotel = galleryHotel(g); if (!hotel) return;
  const set = gallerySetOf(g, hotel); if (!set.length) return;
  i = (i + set.length) % set.length;
  g.dataset.i = i;
  const img = $(".bk-gal-main img", g);
  if (img) img.src = set[i].full || set[i].thumb;
  $(".bk-gal-n", g).textContent = `${i + 1} / ${set.length}`;
  g.querySelectorAll("[data-gal-to]").forEach((b, j) => b.classList.toggle("on", j === i));
}
function gallerySet(g, name) {
  const hotel = galleryHotel(g); if (!hotel) return;
  g.dataset.set = name;
  g.querySelectorAll("[data-gal-set]").forEach(b => { b.classList.toggle("on", b.dataset.galSet === name); b.setAttribute("aria-selected", String(b.dataset.galSet === name)); });
  $(".bk-gal-thumbs", g).innerHTML = gallerySetOf(g, hotel).map((im, i) => `<button type="button" data-gal-to="${i}" aria-label="Photo ${i + 1}"><img src="${esc(im.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join("");
  galleryShow(g, 0);
}
// A photo that won't load leaves an empty thumbnail: hide it.
root.addEventListener("error", e => {
  if (e.target.tagName === "IMG" && e.target.closest(".bk-gal-thumbs")) e.target.closest("button").hidden = true;
}, true);
root.addEventListener("input", e => {
  const i = e.target.dataset.area;
  if (i == null) return;
  // Hand-edited areas keep the centres of names that didn't change; new names are searched by name.
  const c = S.route[+i];
  c.areas = e.target.value.split(",").map(n => n.trim()).filter(Boolean).slice(0, 3)
    .map(name => c.areas.find(a => a.name === name) || { name, lat: null, lng: null });
  c.areaWhy = "";
  S.hotels = {};
});
root.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || !S) return;
  const g = b.closest(".bk-gal");
  if (g && b.dataset.galStep) { galleryShow(g, +g.dataset.i + +b.dataset.galStep); return; }
  if (g && b.dataset.galTo != null) { galleryShow(g, +b.dataset.galTo); return; }
  if (g && b.dataset.galSet) { gallerySet(g, b.dataset.galSet); return; }
  if (b.dataset.vote) { answerDeck(b.dataset.vote); return; }
  if (b.dataset.near) { loadNear(b.dataset.near); return; }
  if (b.dataset.dateDir) { setFlightDate(b.dataset.dateDir, b.dataset.date); return; }
  if (b.dataset.nights != null) {
    const c = S.route[+b.dataset.nights];
    c.nights = Math.max(1, c.nights + +b.dataset.d);
    datesFromNights(); S.hotels = {}; render(); return;
  }
  if (b.dataset.flight != null) { S.flights.chosen = S.flights.options.options[+b.dataset.flight]; render(); return; }
  if (b.dataset.hotel) { S.hotels[b.dataset.hotel].chosen = b.dataset.id; render(); return; }
  if (b.dataset.retryHotels) { searchHotels(b.dataset.retryHotels); return; }
  switch (b.dataset.act) {
    case "back": ctrl.abort(); S.onBack(); break;
    case "deck-retry": S.deck.error = ""; loadDeck(); break;
    case "deck-skip": afterDeck(); break;
    case "route": proposeRoute(); break;
    case "route-update": {
      S.routeComment = $("#bk-route-comment", root).value.trim();
      if (!S.routeComment) { $("#bk-route-comment", root).focus(); return; }
      proposeRoute(); break;
    }
    case "route-ok":
      if (S.flights.status === "help" && !S.flights.chosen) { S.flights.options ? (S.stage = "flights", render()) : searchFlights(); }
      else { S.stage = "hotels"; render(); }
      break;
    case "flights": searchFlights(); break;
    case "flight-update": {
      const t = $("#bk-flight-comment", root).value.trim();
      if (!t) { $("#bk-flight-comment", root).focus(); return; }
      adjustFlights(t); break;
    }
    case "flight-reset": S.flights.filters = {}; S.flights.note = ""; searchFlights(); break;
    case "to-route": S.stage = "route"; render(); break;
    case "to-flights": S.stage = "flights"; render(); break;
    case "to-flights-options": S.flights.manual = false; render(); break;
    case "skip-flights": S.flights.chosen = null; S.flights.in = S.flights.out = null; S.flights.manual = true; S.flights.why = "self"; S.stage = "flights"; render(); break;
    case "flights-ok": fitNights(); S.hotels = {}; S.stage = "hotels"; render(); break;
    case "manual-ok": {
      for (const k of ["in", "out"]) {
        if (S.flights[k] && S.flights.why === "lookup") continue;
        const ap = root.querySelector(`[data-man="${k}-ap"]`)?.value, day = root.querySelector(`[data-man="${k}-day"]`)?.value, t = root.querySelector(`[data-man="${k}-time"]`)?.value;
        const end = { id: ap, name: ap, time: `${day} ${t}` };
        S.flights[k] = { number: k === "in" ? S.a.inFlight || "" : S.a.outFlight || "", airline: "", booked: S.flights.why === "lookup",
          ...(k === "in" ? { to: end, from: { id: S.a.inFrom } } : { from: end, to: { id: S.a.outTo } }) };
      }
      S.flights.manual = false;
      airportsFromFlights();
      if (S.route) { fitNights(); S.hotels = {}; S.stage = "hotels"; render(); } else proposeRoute();
      break;
    }
    case "hotel-prefs": S.hotels = {}; render(); break;
    case "find-hotels": readPrefs(); searchHotels(); break;
    case "build": finish(); break;
  }
});

/* Deck keys and swipes. */
document.addEventListener("keydown", e => {
  if (S?.stage !== "deck" || !S.deck.items || root.hidden || e.target.closest("input, textarea, select")) return;
  const v = { ArrowLeft: "no", ArrowDown: "maybe", ArrowRight: "yes" }[e.key];
  if (v) { e.preventDefault(); answerDeck(v); }
});
let drag = null;
root.addEventListener("pointerdown", e => { const c = e.target.closest("#bk-card"); if (c) drag = { x: e.clientX, c }; });
root.addEventListener("pointermove", e => { if (drag) drag.c.style.transform = `translateX(${e.clientX - drag.x}px) rotate(${(e.clientX - drag.x) / 25}deg)`; });
addEventListener("pointerup", e => {
  if (!drag) return;
  const dx = e.clientX - drag.x; drag.c.style.transform = ""; drag = null;
  if (Math.abs(dx) > 90) answerDeck(dx > 0 ? "yes" : "no");
});

window.TripBooking = { start };
})();
