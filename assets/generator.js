"use strict";
/* Itinerary generation: questionnaire answers → a complete trip.
   1. Outline (DeepSeek): route, bases, one line per day, the day's highlights.
   2. Days (DeepSeek, a few days per call, in parallel): timed items, places, plan B.
   3. Places (Google Places): each place is matched to a Google place id and
      coordinates, so the itinerary, calendar and map all point at the same spot.
   The planning instructions come from skills/itinerary.md; the JSON contract
   below is what the page needs and stays in code. */
(() => {
const API = "https://api.deepseek.com/chat/completions";
const SKILL_URL = "skills/itinerary.md";
const DAYS_PER_CALL = 3;
const KINDS = ["sight", "nature", "food", "hotel", "shop", "transport", "city"];
const MODES = ["walk", "rail", "bus", "car", "flight"];

const slug = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
const normTime = t => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ""));
  if (!m || +m[1] > 23 || +m[2] > 59) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
};
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const minLabel = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const validTz = tz => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return !!tz; } catch { return false; } };
const monthsText = ms => {
  const names = (ms || []).map(m => new Date(m + "-01T12:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }));
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0] || "";
};
const fmtDate = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

let skillText = null;
async function skill() {
  if (skillText !== null) return skillText;
  try {
    const res = await fetch(SKILL_URL, { cache: "no-cache" });
    skillText = res.ok ? (await res.text()).replace(/<!--[\s\S]*?-->/g, "").trim() : "";
  } catch { skillText = ""; }
  return skillText || "You are an expert travel planner. Plan realistic, specific, well-paced trips.";
}

/* ---------- DeepSeek ---------- */
async function callJSON(system, user, { signal, maxTokens = 8000 } = {}) {
  const key = window.TripSettings?.deepseekKey();
  if (!key) { const e = new Error("Add a DeepSeek key in Settings."); e.status = 401; throw e; }
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        // Flash without thinking: fast, cheap and supports JSON output.
        body: JSON.stringify({
          model: "deepseek-flash", thinking: { type: "disabled" }, temperature: 0.6, max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
        signal,
      });
      if (!res.ok) {
        let detail = "";
        try { const j = await res.json(); detail = j?.error?.message || ""; } catch {}
        const e = new Error(detail || "DeepSeek returned HTTP " + res.status); e.status = res.status;
        if (res.status < 500 && res.status !== 429) throw Object.assign(e, { fatal: true });
        throw e;
      }
      const j = await res.json();
      const choice = j.choices?.[0];
      if (choice?.finish_reason === "length") throw new Error("The answer was cut short.");
      return JSON.parse(choice?.message?.content || "");
    } catch (err) {
      if (err?.name === "AbortError" || err?.fatal) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/* ---------- Answers ---------- */
function datesLine(a) {
  if (a.flex === "any") {
    const asked = `${a.duration} days starting in ${monthsText(a.months)}`;
    return a.start ? `Dates: ${a.start} to ${a.end} (chosen by the planner; they asked for ${asked})` : `Dates: flexible, ${asked}`;
  }
  const f = +a.flex;
  return `Dates: ${a.start} to ${a.end}${f ? ` (can move up to ${f} day${f > 1 ? "s" : ""} either way)` : ""}`;
}
function profileText(a) {
  const who = [a.party, a.people ? `${a.people} ${+a.people === 1 ? "person" : "people"}` : "", a.kids ? `children: ${a.kids}` : ""].filter(Boolean).join(", ");
  const lines = [
    `Destination: ${a.destination}`,
    a.from && `Travelling from: ${a.from}`,
    datesLine(a),
    a.arrival && `Arrival: ${a.arrival}`,
    a.departure && `Departure: ${a.departure}`,
    who && `Travellers: ${who}`,
    (a.interests?.length || a.interestsOther) && `Interests: ${[...(a.interests || []), a.interestsOther].filter(Boolean).join(", ")}`,
    a.pace && `Pace: ${a.pace}`,
    a.walking && `Walking: ${a.walking}`,
    a.stay && `Accommodation: ${a.stay}`,
    a.transport && `Getting around: ${a.transport}`,
    a.budget && `Budget: ${a.budget} ${a.currency || ""} ${a.budgetScope || ""}`.trim(),
    a.diet && `Dietary needs: ${a.diet}`,
    a.food && `Food wishes: ${a.food}`,
    a.must && `Must do: ${a.must}`,
    a.avoid && `Avoid: ${a.avoid}`,
    a.notes && `Notes: ${a.notes}`,
  ];
  return lines.filter(Boolean).join("\n");
}

/* ---------- Prompts ---------- */
function outlinePrompt(a, dates) {
  const flexible = a.flex === "any", n = dates.length;
  const when = flexible
    ? `The dates are flexible: choose the best ${n} consecutive days for this traveller, starting on a day in ${monthsText(a.months)}, no earlier than ${dates[0]}. Weigh the weather, seasons, festivals and closures, and say in the summary why you chose them.`
    : `Plan the route for this ${n}-day trip (${dates[0]} to ${dates[n - 1]}).`;
  return `TODAY: ${new Date().toISOString().slice(0, 10)}
TRAVELLER
${profileText(a)}

${when} Reply with JSON only, in exactly this shape:
{${flexible ? `
  "start": "YYYY-MM-DD, the first day you chose",` : ""}
  "title": "Short evocative trip title, max 40 characters",
  "emoji": "one emoji",
  "summary": "3–5 sentences in markdown for the traveller: the route, why it fits them, the trade-offs. Mention cities as {{city-key}}.",
  "budget": "estimated total, e.g. ≈ US$4,200 for two",
  "budgetNote": "one short clause comparing it with their budget, or empty",
  "cities": [{"key": "kebab-case", "name": "City", "country": "Country", "timeZone": "IANA zone, e.g. Europe/Paris"}],
  "stays": [{"key": "kebab-case", "name": "Exact real hotel name", "city": "city-key", "query": "hotel name, neighbourhood, city", "why": "one sentence"}],
  "days": [{"d": 1, "date": "YYYY-MM-DD", "city": "city-key", "stay": "stay-key or null", "title": "Short day title", "purpose": "one sentence", "theme": "2–4 words", "walking": "Light|Moderate|Heavy", "highlights": ["Exact place name", "…"]}],
  "tips": ["practical tip", "…"]
}
Rules:
- "days" has exactly ${n} entries, d = 1…${n}, ${flexible ? 'on consecutive dates from "start"' : `dates ${dates[0]} … ${dates[n - 1]} in order`}.${+a.flex ? `
- They can move the trip up to ${a.flex} day${+a.flex > 1 ? "s" : ""} either way. Plan for the dates given, but if moving would clearly help (a closure, a festival, a better weekday), say so in the summary.` : ""}
- "stay" is where they sleep that night; null only on a final departure day with no night.
- "highlights" are the 1–4 main places of each day. Never repeat a highlight on another day.
- 3–6 tips.`;
}

function daysPrompt(a, outline, from, to) {
  const brief = {
    title: outline.title, cities: outline.cities, stays: outline.stays,
    days: outline.days.map(d => ({ d: d.d, date: d.date, city: d.city, stay: d.stay, title: d.title, purpose: d.purpose, highlights: d.highlights })),
  };
  return `TRAVELLER
${profileText(a)}

TRIP OUTLINE (fixed — do not change the route, stays or other days)
${JSON.stringify(brief)}

Write days ${from}–${to} in full. Reply with JSON only, in exactly this shape:
{
  "days": [{
    "d": ${from},
    "items": [{"s": "HH:MM", "e": "HH:MM", "t": "What they do, specific", "place": "place-key or null", "n": "one practical sentence", "k": "Sight|Sit-down|Browse|Experience|Walk|Booked|Travel", "c": "sight|nature|food|hotel|shop|transport|city", "mode": "walk|rail|bus|car|flight", "allDay": false}],
    "planB": ["rain or tired alternative"],
    "alts": ["place-key"],
    "spend": "the one thing worth paying for today",
    "watch": ["closure, booking or scam to watch for"]
  }],
  "places": [{"key": "kebab-case", "name": "Exact real name", "city": "city-key", "kind": "sight|nature|food|shop|transport|hotel", "query": "name, neighbourhood, city, country"}]
}
Rules:
- Items in time order; "e" after "s". Include meals, travel between areas and the return to the hotel.
- "mode" is how they get TO this item from the previous one.
- "place" is a key from "places", or a stay key or city key from the outline, or null for generic items (e.g. "Breakfast at the hotel").
- Every place you reference (items and alts) appears in "places" unless it is a stay or city from the outline.
- Use each day's highlights from the outline on that day. Do not use another day's highlights.
- Flights, check-in/out and hotel nights may be "allDay": true without times.`;
}

/* ---------- Building the trip ---------- */
function cleanDay(raw, base, known, places) {
  const items = [];
  for (const it of Array.isArray(raw?.items) ? raw.items : []) {
    if (!it || !String(it.t || "").trim()) continue;
    const item = { t: String(it.t).trim().slice(0, 140) };
    const key = slug(it.place);
    if (key && known.has(key)) item.p = key;
    if (it.n) item.n = String(it.n).slice(0, 320);
    if (it.k) item.k = String(it.k).slice(0, 20);
    const c = String(it.c || "").toLowerCase();
    item.c = KINDS.includes(c) ? c : places[item.p]?.kind || "sight";
    const mode = String(it.mode || "").toLowerCase();
    if (MODES.includes(mode)) item.mode = mode;
    let s = normTime(it.s), e = normTime(it.e);
    if (it.allDay || !s) { item.allDay = true; }
    else {
      if (!e || toMin(e) <= toMin(s)) e = minLabel(Math.min(23 * 60 + 45, toMin(s) + 60));
      item.s = s; item.e = e;
    }
    items.push(item);
  }
  return {
    ...base,
    items,
    planB: (raw?.planB || []).map(String).slice(0, 4),
    alts: (raw?.alts || []).map(slug).filter(k => known.has(k)).slice(0, 3),
    spend: String(raw?.spend || ""),
    watch: (raw?.watch || []).map(String).slice(0, 4),
  };
}

function planMarkdown(trip, outline) {
  const P = trip.places;
  const stays = new Map();
  trip.days.forEach(d => { if (d.stay) (stays.get(d.stay) || stays.set(d.stay, []).get(d.stay)).push(d.d); });
  const range = ds => ds.length > 1 ? `Days ${ds[0]}–${ds[ds.length - 1]}` : `Day ${ds[0]}`;
  return [
    `# ${trip.meta.title} — ${fmtDate(trip.meta.start)} to ${fmtDate(trip.meta.end)}`,
    `## Summary`, outline.summary || "",
    `- **${trip.meta.days} days, ${trip.meta.nights} nights:** ${trip.meta.routeLine}`,
    trip.meta.budget ? `- **Estimated cost:** ${trip.meta.budget}${trip.meta.budgetNote ? ` (${trip.meta.budgetNote})` : ""}` : "",
    `## Where you'll stay`,
    ...[...stays].map(([id, ds]) => `- {{${id}}} — ${P[P[id]?.city]?.name || P[id]?.city || ""}, ${range(ds)}${outline.stays?.find(s => slug(s.key) === id)?.why ? ": " + outline.stays.find(s => slug(s.key) === id).why : ""}`),
    `## Day by day`,
    ...trip.days.map(d => `${d.d}. **${fmtDate(d.date)}, ${d.title}:** ${d.purpose || ""}`),
    outline.tips?.length ? `## Good to know\n${outline.tips.map(t => `- ${t}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

/* Match places to Google: cities first, then everything else near its city.
   Sets placeId, lat and lng on each place in `list`; onProgress(done, total). */
async function locate(places, list, { signal, onProgress = () => {} } = {}) {
  let found = 0;
  const resolve = async (p, near) => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const hit = await TripGoogle.search(p.query || p.name, near, near ? 30000 : undefined);
      // A match far from its city is the wrong place: keep the item, drop the pin.
      if (hit && (!near || TripRouting.haversine(near, hit) < 150000)) {
        Object.assign(p, { placeId: hit.placeId, lat: hit.lat, lng: hit.lng });
      }
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) throw err;
    }
    onProgress(++found, list.length);
  };
  await pool(list.filter(p => p.kind === "city"), 4, p => resolve(p, null));
  await pool(list.filter(p => p.kind !== "city"), 4, p => resolve(p, places[p.city]?.lat != null ? places[p.city] : null));
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/**
 * generate(answers, { onProgress({ step, text, done, total, preview, range }), signal }) → trip
 * The trip is not saved; the caller decides.
 */
async function generate(a, { onProgress = () => {}, signal } = {}) {
  const flexible = a.flex === "any";
  const n = flexible ? +a.duration : Math.round((new Date(a.end + "T12:00:00") - new Date(a.start + "T12:00:00")) / 864e5) + 1;
  if (!(n >= 1 && n <= 30)) throw new Error("Choose a trip between 1 and 30 days.");
  // Flexible dates: the planner picks the start; until then, the earliest allowed day.
  const today = new Date().toLocaleDateString("en-CA");
  const canStart = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso) && iso >= today && a.months.includes(iso.slice(0, 7));
  const start = flexible ? [...a.months].sort().map(m => (m + "-01" > today ? m + "-01" : today)).find(canStart) : a.start;
  if (!start) throw new Error("Pick a month that hasn't ended yet.");
  let dates = Array.from({ length: n }, (_, i) => addDays(start, i));
  const system = await skill();

  // 1. Outline
  onProgress({ step: "outline", text: "Planning the route and where you'll stay…" });
  let outline;
  for (let attempt = 0; attempt < 2 && !outline; attempt++) {
    const o = await callJSON(system, outlinePrompt(a, dates), { signal, maxTokens: 6000 });
    if (Array.isArray(o?.days) && o.days.length >= n && Array.isArray(o.cities) && o.cities.length) outline = o;
  }
  if (!outline) throw new Error("The planner did not return a complete route. Try again.");
  if (flexible) {
    if (canStart(String(outline.start || ""))) dates = dates.map((_, i) => addDays(outline.start, i));
    a = { ...a, start: dates[0], end: dates[n - 1] };
  }
  outline.days = outline.days.slice(0, n).map((d, i) => ({ ...d, d: i + 1, date: dates[i], city: slug(d.city), stay: d.stay ? slug(d.stay) : null }));

  const places = {};
  for (const c of outline.cities) {
    const key = slug(c.key || c.name);
    if (key) places[key] = { id: key, name: String(c.name || key), kind: "city", city: key, country: c.country || "", tz: validTz(c.timeZone) ? c.timeZone : "", query: [c.name, c.country].filter(Boolean).join(", ") };
  }
  for (const s of outline.stays || []) {
    const key = slug(s.key || s.name);
    if (key && !places[key]) places[key] = { id: key, name: String(s.name || key), kind: "hotel", city: slug(s.city), query: s.query || `${s.name}, ${places[slug(s.city)]?.name || ""}` };
  }

  // 2. Days, a few per call
  const chunks = [];
  for (let d = 1; d <= n; d += DAYS_PER_CALL) chunks.push([d, Math.min(n, d + DAYS_PER_CALL - 1)]);
  let doneChunks = 0;
  const preview = {
    title: String(outline.title || ""), emoji: String(outline.emoji || "").slice(0, 4),
    days: outline.days.map(d => ({ d: d.d, date: d.date, title: String(d.title || ""), city: places[d.city]?.name || "" })),
  };
  onProgress({ step: "days", text: `Writing the days (0 of ${n})…`, done: 0, total: n, preview });
  const results = await pool(chunks, 3, async ([from, to]) => {
    const r = await callJSON(system, daysPrompt(a, outline, from, to), { signal });
    doneChunks++;
    const written = Math.min(n, chunks.slice(0, doneChunks).reduce((s, [f, t]) => s + t - f + 1, 0));
    onProgress({ step: "days", text: `Writing the days (${written} of ${n})…`, done: written, total: n, range: [from, to] });
    return r;
  });
  const rawDays = new Map();
  for (const r of results) {
    for (const p of r?.places || []) {
      const key = slug(p.key || p.name);
      if (!key || places[key]) continue;
      const kind = KINDS.includes(p.kind) ? p.kind : "sight";
      places[key] = { id: key, name: String(p.name || key).slice(0, 80), kind, city: slug(p.city), query: String(p.query || p.name).slice(0, 200) };
    }
    for (const d of r?.days || []) rawDays.set(+d.d, d);
  }
  const known = new Set(Object.keys(places));
  const days = outline.days.map(o => {
    const city = places[o.city];
    return cleanDay(rawDays.get(o.d), {
      d: o.d, date: o.date, title: String(o.title || `Day ${o.d}`), city: o.city,
      stay: o.stay && known.has(o.stay) ? o.stay : null,
      theme: o.theme || "", walking: o.walking || "", purpose: o.purpose || "",
      tz: city?.tz || "",
    }, known, places);
  });
  if (days.every(d => !d.items.length)) throw new Error("The planner returned empty days. Try again.");

  // 3. Places on Google
  const used = new Set(days.flatMap(d => [d.stay, d.city, ...d.alts, ...d.items.map(i => i.p)]).filter(Boolean));
  const todo = Object.values(places).filter(p => p.kind === "city" || used.has(p.id));
  const report = (done, total) => onProgress({ step: "places", text: `Finding places on Google Maps (${done} of ${total})…`, done, total });
  report(0, todo.length);
  await locate(places, todo, { signal, onProgress: report });

  // Keep only what the plan uses, without the planner's search hints.
  const kept = {};
  for (const p of Object.values(places)) {
    if (!used.has(p.id) && p.kind !== "city") continue;
    const { query, tz, country, ...rest } = p;
    kept[p.id] = rest;
  }
  const tz = days.find(d => d.tz)?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  days.forEach(d => { if (!d.tz) d.tz = tz; });
  const route = [];
  days.forEach(d => { const name = kept[d.city]?.name; if (name && !route.includes(name)) route.push(name); });
  const now = new Date();
  const trip = {
    id: TripStore.newId(),
    createdAt: now.toISOString(),
    meta: {
      title: String(outline.title || a.destination).slice(0, 60), emoji: String(outline.emoji || "").slice(0, 4), version: "V1",
      start: dates[0], end: dates[n - 1], days: n, nights: n - 1,
      updated: now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
      budget: String(outline.budget || ""), budgetNote: String(outline.budgetNote || ""),
      route, routeLine: route.join(" · "), timeZone: tz,
    },
    answers: a,
    profile: profileText(a),
    places: kept,
    days,
  };
  trip.plan = planMarkdown(trip, outline);
  trip.chat = [
    { role: "user", md: "Plan my trip:\n" + profileText(a).split("\n").map(l => "- " + l).join("\n") },
    { role: "ai", md: `${outline.summary || ""}\n\nThe whole plan is in the itinerary, calendar and map. Ask me to move, add or drop anything — I'll show the changes for you to approve first.` },
  ];
  onProgress({ step: "done", text: "Your trip is ready." });
  return trip;
}

window.TripGenerator = { generate, locate, profileText };
})();
