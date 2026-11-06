"use strict";
/* Itinerary generation: questionnaire answers → a complete trip.
   1. Outline (DeepSeek): route, bases, one line per day, the day's highlights.
   2. Days (DeepSeek, a few days per call, in parallel): timed items, places, plan B.
   3. Places (Google Places): each place is matched to a Google place id and
      coordinates, so the itinerary, calendar and map all point at the same spot.
   The planning instructions come from skills/itinerary.md; the JSON contract
   below is what the page needs and stays in code. */
(() => {
const API = "/api/llm";
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
/* Through the site's backend (/api/llm), which adds the key and puts the Japan skill
   (trimmed to this traveller's interests) in front of the planning instructions. */
async function callJSON(system, user, { signal, maxTokens = 8000, scope } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let res;
      try {
        // Flash without thinking: fast, cheap and supports JSON output.
        res = await TripAPI.post(API, {
          model: "deepseek-flash", temperature: 0.6, max_tokens: maxTokens,
          response_format: { type: "json_object" }, skill: scope || {},
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }, { signal });
      } catch (e) {
        if (e.status && e.status < 500 && e.status !== 429) e.fatal = true;
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
const legText = l => l ? `${l.number || "flight"} ${l.from?.id || ""} ${l.from?.time || ""} → ${l.to?.id || ""} ${l.to?.time || ""}`.replace(/\s+/g, " ").trim() : "";
/* The traveller as the skill's TripBrief (section 2), one line per field. */
function profileText(a) {
  const list = v => (Array.isArray(v) ? v : [v]).filter(Boolean).join(", ");
  const lines = [
    `Destination: Japan`,
    datesLine(a),
    a.flights?.in && `Arrival flight: ${legText(a.flights.in)}${a.flights.in.booked ? " (booked)" : " (chosen, not booked yet)"}`,
    a.flights?.out && `Departure flight: ${legText(a.flights.out)}${a.flights.out.booked ? " (booked)" : " (chosen, not booked yet)"}`,
    `party_type: ${a.party || "couple"}; adults_count: ${a.adults || 2}${a.kids ? `; children_ages: [${a.kids}]` : ""}`,
    a.mobility && a.mobility !== "none" && `mobility_constraints: ${a.mobility}`,
    a.bed && `bed_preference: ${a.bed}`,
    `budget_tier: ${a.budgetTier || "mid_range"}${+a.maxNightly ? `; max_hotel_nightly: ${a.maxNightly} ${a.currency}` : ""}${+a.totalBudget ? `; total_land_budget: ${a.totalBudget} ${a.currency}` : ""}`,
    `pacing_style: ${a.pace || "balanced"}; crowd_sensitivity: ${a.crowds || "moderate"}; base_change_tolerance: ${a.hops || "moderate"}`,
    `dietary_restrictions: [${list(a.diet) || "omnivore"}]${a.allergies ? `; other allergies/dislikes: ${a.allergies}` : ""}${a.adventure ? `; food adventurousness: ${a.adventure}` : ""}`,
    a.food?.length && `food interests: ${list(a.food)}`,
    a.onsen && `wants_onsen_experience: ${a.onsen}${a.onsen !== "no" ? `; onsen_privacy_preference: ${a.onsenPrivacy}; tattoo_status: ${a.tattoos}` : ""}`,
    a.interestsLove?.length && `interests LOVED (anchor most days on these): ${list(a.interestsLove)}`,
    (a.interests?.length || a.interestsOther) && `interests liked (fill gaps with these): ${list([...(a.interests || []).filter(i => !(a.interestsLove || []).includes(i)), a.interestsOther])}`,
    a.visits && `japan_experience: ${{ first: "first visit — include the essential highlights", returning: "been before — skip the standard first-timer highlights unless they ask", expert: "knows Japan well — favour lesser-known places and deeper experiences" }[a.visits]}`,
    a.discovery && `discovery: ${{ icons: "famous highlights", mix: "mostly highlights plus a few hidden gems", gems: "hidden gems where locals go, few big-name sights" }[a.discovery]}`,
    a.vibe !== undefined && a.vibe !== "" && `traditional_vs_modern: ${["all traditional", "mostly traditional", "balanced", "mostly modern", "all modern"][+a.vibe] || "balanced"}`,
    a.cities?.length && `must_visit: ${list(a.cities)}`,
    a.must && `Must do: ${a.must}`,
    a.avoid && `Avoid: ${a.avoid}`,
    a.hotelPrefs?.length && `Hotel priorities: ${list(a.hotelPrefs)}`,
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
${fixedText(a)}
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
  "days": [{"d": 1, "date": "YYYY-MM-DD", "city": "city-key", "stay": "stay-key or null", "title": "Short day title", "purpose": "one sentence", "theme": "2–4 words", "walking": "Light|Moderate|Heavy", "highlights": ["Exact place name", "…"], "meals": ["Exact lunch restaurant", "Exact dinner restaurant"]}],
  "tips": ["practical tip", "…"],
  "why": ["3–6 short bullets in markdown: the key decisions that shape this plan and why (route order and nights, what you cut or swapped, date bottlenecks such as holidays or Saturdays, crowd timing, diet and onsen choices). Mention places as {{key}} when they are cities or stays."],
  "chefCard": "${a.diet?.length || a.allergies ? "a short Japanese dietary card (Japanese text, then an English line) for restaurants, per the skill's Matrix E" : "empty string"}"
}
Rules:
- "days" has exactly ${n} entries, d = 1…${n}, ${flexible ? 'on consecutive dates from "start"' : `dates ${dates[0]} … ${dates[n - 1]} in order`}.${+a.flex ? `
- They can move the trip up to ${a.flex} day${+a.flex > 1 ? "s" : ""} either way. Plan for the dates given, but if moving would clearly help (a closure, a festival, a better weekday), say so in the summary.` : ""}
- "stay" is where they sleep that night; null only on a final departure day with no night.
- "highlights" are the 1–4 main places of each day. Never repeat a highlight on another day.
- "meals" are real, specific restaurants for that day's lunch and dinner, near where they are at that time and safe for their diet. Never use a restaurant twice in the trip; use "" for a meal on a travel day with no time for it.
- 3–6 tips.`;
}

/* What the booking step already settled: the planner must build around it. */
function fixedText(a) {
  const out = [];
  if (a.flights?.in || a.flights?.out) {
    out.push("FLIGHTS (fixed)");
    if (a.flights.in) out.push(`- Arrives ${a.flights.in.to?.id} at ${a.flights.in.to?.time} (${a.flights.in.number || "flight"}). Day 1 starts on landing: plan airport transfer per section 6.`);
    if (a.flights.out) out.push(`- Departs ${a.flights.out.from?.id} at ${a.flights.out.from?.time} (${a.flights.out.number || "flight"}). Plan the last day to reach that airport 2.5 hours early.`);
  }
  if (a.route?.length) {
    out.push("ROUTE (fixed, in this order)");
    a.route.forEach(c => out.push(`- ${c.name} (key "${c.key}"): ${c.nights} night${c.nights === 1 ? "" : "s"}${c.area ? `, staying in ${c.area}` : ""}`));
  }
  if (a.hotels?.length) {
    out.push('HOTELS (fixed — use these exact names as "stays", with these keys)');
    a.hotels.forEach(h => out.push(`- key "${h.key}": ${h.name}, ${h.cityName}, check-in ${h.checkIn}, check-out ${h.checkOut}${h.booked ? " (booked)" : ""}`));
  }
  return (out.length ? "\n" + out.join("\n") + "\n" : "") + deckText(a);
}

/* What they said on the experience deck: yes = include, maybe = if it fits, no = never. */
function deckText(a) {
  const d = a.deck; if (!d) return "";
  const l = xs => xs.map(x => `${x.title} (${x.id})`).join("; ");
  return [
    d.yes?.length && `EXPERIENCES THEY SAID YES TO (include every one, using the catalog id): ${l(d.yes)}`,
    d.maybe?.length && `EXPERIENCES THEY MIGHT LIKE (include if they fit well): ${l(d.maybe)}`,
    d.no?.length && `EXPERIENCES THEY SAID NO TO (never include these or close look-alikes): ${l(d.no)}`,
  ].filter(Boolean).join("\n") + "\n";
}

/* Sources the planner may cite for an item, beyond the curated catalog. */
const CITE = ["Tabelog", "Japan-Guide", "Reddit r/JapanTravel", "Michelin Guide", "HappyCow", "Halal Gourmet Japan", "Good Coffee", "Tokyo Art Beat", "Resident Advisor", "tattoo-friendly.jp", "Ikyu", "Japan Meteorological Corp", "fuji-san.info", "Tokyo Cheapo", "Eater"];

function daysPrompt(a, outline, from, to) {
  const brief = {
    title: outline.title, cities: outline.cities, stays: outline.stays,
    days: outline.days.map(d => ({ d: d.d, date: d.date, city: d.city, stay: d.stay, title: d.title, purpose: d.purpose, highlights: d.highlights, meals: d.meals })),
  };
  const taken = outline.days.filter(d => d.d < from || d.d > to).flatMap(d => d.meals || []).filter(Boolean);
  return `TRAVELLER
${profileText(a)}
${fixedText(a)}
${taken.length ? `RESTAURANTS OTHER DAYS ALREADY USE (never use these on days ${from}–${to}): ${taken.join("; ")}\n` : ""}TRIP OUTLINE (fixed — do not change the route, stays or other days)
${JSON.stringify(brief)}

Write days ${from}–${to} in full. Reply with JSON only, in exactly this shape:
{
  "days": [{
    "d": ${from},
    "items": [{"s": "HH:MM", "e": "HH:MM", "t": "What they do, specific", "place": "place-key or null", "n": "one practical sentence", "k": "Sight|Sit-down|Browse|Experience|Walk|Booked|Travel", "c": "sight|nature|food|hotel|shop|transport|city", "mode": "walk|rail|bus|car|flight", "allDay": false,
      "src": [{"id": "JP-041"}, {"name": "Tabelog", "detail": "3.62"}]}],
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
- Lunch and dinner are the day's "meals" from the outline; where a meal is "", choose a new restaurant. Breakfast, coffee and snacks are your choice, but never a restaurant that appears on another day.
- Only check in at the stays in the outline. A day trip ends back at that night's stay; for baths on a day trip use a day-use onsen, never a ryokan "check-in".
- "t" and "n" are final text for the traveller: never think aloud, correct yourself or ask questions.
- Flights, check-in/out and hotel nights may be "allDay": true without times.
- "src" says why each item is recommended: {"id": "JP-xxx"} for an experience taken from the curated catalog in your instructions (copy the id exactly; never invent one), plus {"name", "detail"} naming the outside source behind it, from this list only: ${CITE.join(", ")}. Restaurants, cafés and bars always name Tabelog (with its score), Michelin Guide or HappyCow; sights name Japan-Guide or another listed source. "detail" is short (a Tabelog score, an award, what the source says). Use [] only for transfers and hotel breakfast.
- Every meal is a specific, real restaurant with its own place key — never "a local izakaya" or "a soba shop like…".
- Dietary restrictions are hard rules: every meal must be safe for them (see Matrix E). Never schedule a meal whose main dish they cannot eat, and never rely on "ask for…" workarounds when the standard dish breaks the rule (for a pescatarian, no chicken- or pork-broth ramen). This covers snacks and street food too.`;
}

/* ---------- Checking the plan ---------- */
const WEEKDAY = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long" });

/* Words that suggest a food stop breaks the diet. A hit is only a suspicion ("skip the pork
   skewers" is fine), so the reviewer decides. */
const MEAT = "pork|beef|chicken|duck|lamb|wagyu|sukiyaki|shabu|yakitori|yakiniku|tonkatsu|katsu|karaage|gyudon|motsu|tonkotsu|chashu|ham|bacon|sausage|kushikatsu|horumon|basashi";
const FISH = "fish|sushi|sashimi|tuna|eel|unagi|bonito|dashi|seafood|prawn|shrimp|crab|oyster|scallop|squid|octopus|takoyaki|tempura|uni|ikura";
function dietRule(diet = []) {
  const words = [];
  if (diet.some(d => ["pescatarian", "vegetarian", "vegan"].includes(d))) words.push(MEAT);
  if (diet.some(d => ["vegetarian", "vegan"].includes(d))) words.push(FISH);
  if (diet.some(d => ["no_pork", "halal"].includes(d))) words.push("pork|tonkatsu|tonkotsu|chashu|ham|bacon|katsu");
  if (diet.includes("shellfish_allergy")) words.push("prawn|shrimp|crab|lobster|oyster|scallop|clam");
  return words.length ? new RegExp(`\\b(${words.join("|")})\\w*`, "i") : null;
}

/* Problems code can find for certain (or suspects); the reviewer must look at every one. */
function knownProblems(days, places, diet) {
  const out = [], firstUse = new Map(), rule = dietRule(diet);
  for (const d of days) d.items.forEach((it, i) => {
    const at = `D${d.d}#${i}`;
    if (it.c === "food" && it.p && places[it.p]?.kind !== "hotel") {
      const seen = firstUse.get(it.p);
      if (seen && seen.d !== d.d) out.push(`${at}: ${places[it.p]?.name || it.p} is already used on day ${seen.d} — pick a different restaurant`);
      else if (!seen) firstUse.set(it.p, { d: d.d });
    }
    if (/\bor (a|an|any|one|another|nearby)\b|\ba (local|nearby|good|cosy|cozy) (izakaya|restaurant|café|cafe|bar|ramen)/i.test(it.t)) out.push(`${at}: not a specific place ("${it.t}")`);
    if (/\?\s|\? No|actually,/i.test(it.t)) out.push(`${at}: the title thinks aloud ("${it.t}")`);
    const said = `${it.t} ${it.n || ""} ${places[it.p]?.name || ""}`;
    if (rule && (it.c === "food" || /lunch|dinner|snack|stall|market|graze/i.test(it.t)) && rule.test(said)) out.push(`${at}: may not suit their diet (mentions "${rule.exec(said)[0]}") — keep it only if what they eat there is safe as served`);
    if (/check[ -]?in/i.test(it.t) && !/flight|airport|terminal/i.test(it.t) && it.p && it.p !== d.stay && places[it.p]?.kind === "hotel") out.push(`${at}: checks in at ${places[it.p]?.name}, but tonight's stay is ${places[d.stay]?.name || "elsewhere"}`);
  });
  return out;
}

const planLine = (it, i, d, places) => `D${d.d}#${i} ${it.allDay ? "all day" : `${it.s}-${it.e}`} [${it.c}] ${it.t}${it.p ? ` @ ${places[it.p]?.name || it.p}` : ""}${it.n ? ` — ${it.n.slice(0, 140)}` : ""}`;

function reviewPrompt(a, days, places, problems) {
  return `TRAVELLER
${profileText(a)}
${fixedText(a)}
THE PLAN (D<day>#<item index> time [kind] what @ place — note)
${days.map(d => `Day ${d.d}, ${WEEKDAY(d.date)} ${d.date}, in ${places[d.city]?.name || d.city}, sleeping at ${places[d.stay]?.name || "— (no night)"}
${d.items.map((it, i) => planLine(it, i, d, places)).join("\n")}`).join("\n\n")}

${problems.length ? `KNOWN PROBLEMS (fix every one)\n${problems.map(p => "- " + p).join("\n")}\n\n` : ""}Review the whole plan as a careful editor and fix only real problems:
- the diet: every meal, snack and street-food stop must be safe as served; "ask for…" workarounds don't count when the standard dish breaks the rule
- a restaurant used on more than one day; a meal that isn't one specific, real place
- something in the wrong city for that day, or too far to reach in the time given
- overlapping times, impossible transfers, or a visit outside opening hours or on its weekly closing day (check the weekday)
- checking in anywhere but that night's stay; activities before landing or after leaving for the airport
- anything they said no to, and text that thinks aloud or contradicts itself
Keep everything else exactly as it is. Replace a broken item with a better one in the same time slot, or delete it.
A replacement must pass every check itself: a restaurant used nowhere else in the plan, and a place whose main food they can eat (never a yakiniku, kushikatsu, tonkatsu or tonkotsu-ramen place with a "fish option" for someone who avoids meat).
Reply with JSON only:
{"fixes": [{"d": 3, "i": 5, "problem": "short reason",
   "item": {"s": "HH:MM", "e": "HH:MM", "t": "What they do, specific, e.g. Dinner at Sushi Saito", "place": "place-key or null", "n": "one practical sentence", "k": "Sight|Sit-down|Browse|Experience|Walk|Booked|Travel", "c": "sight|nature|food|hotel|shop|transport|city", "mode": "walk|rail|bus|car|flight", "src": [{"name": "Tabelog", "detail": "3.62"}]}
   — or "item": null to delete it}],
 "places": [{"key": "kebab-case", "name": "Exact real name", "city": "city-key", "kind": "sight|nature|food|shop|transport|hotel", "query": "name, neighbourhood, city, country"}]}
"places" lists only new places your fixes use. Existing place keys: ${Object.keys(places).join(", ")}.
Use "fixes": [] if nothing is wrong.`;
}

/* Up to two rounds: the second only when code still finds problems after the first. */
async function review(a, days, places, opts) {
  let fixed = await reviewOnce(a, days, places, opts, true);
  if (knownProblems(days, places, a.diet).length) fixed += await reviewOnce(a, days, places, opts, false);
  return fixed;
}

async function reviewOnce(a, days, places, { signal, scope }, first) {
  const problems = knownProblems(days, places, a.diet);
  if (!first && !problems.length) return 0;
  // The core rules (diet matrix, closures, transfers) without the catalog: the plan is already chosen.
  const r = await callJSON("You are the final checker for a Japan itinerary. Reply with JSON only.", reviewPrompt(a, days, places, problems),
    { signal, maxTokens: 5000, scope: { ...scope, catalog: false } });
  for (const p of r?.places || []) {
    const key = slug(p.key || p.name);
    if (!key || places[key]) continue;
    places[key] = { id: key, name: String(p.name || key).slice(0, 80), kind: KINDS.includes(p.kind) ? p.kind : "sight", city: slug(p.city), query: String(p.query || p.name).slice(0, 200) };
  }
  const known = new Set(Object.keys(places)), drop = new Set();
  let fixed = 0;
  for (const f of (Array.isArray(r?.fixes) ? r.fixes : []).slice(0, 30)) {
    const day = days.find(d => d.d === +f.d), i = +f.i;
    if (!day || !(i >= 0 && i < day.items.length)) continue;
    if (!f.item) { drop.add(day.items[i]); fixed++; continue; }
    const [item] = cleanDay({ items: [f.item] }, {}, known, places).items;
    // A malformed reply (e.g. "t": "food") would be worse than the original.
    if (item && item.t.length > 12 && !KINDS.includes(item.t.toLowerCase())) { day.items[i] = item; fixed++; }
  }
  for (const d of days) {
    d.items = d.items.filter(it => !drop.has(it));
    d.items.sort((x, y) => (x.allDay ? -1 : toMin(x.s)) - (y.allDay ? -1 : toMin(y.s)));
  }
  return fixed;
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
    const src = (Array.isArray(it.src) ? it.src : []).map(s => {
      const id = /^#?(JP-(\d{3}))$/.exec(String(s?.id || ""));
      if (id && +id[2] >= 1 && +id[2] <= 300) return { id: id[1] };
      if (s?.name && CITE.includes(s.name)) return { name: s.name, detail: String(s.detail || "").slice(0, 40) };
      return null;
    }).filter(Boolean).slice(0, 4);
    if (src.length) item.src = src;
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
    outline.why?.length ? `## Why it looks like this\n${outline.why.map(t => `- ${t}`).join("\n")}` : "",
    outline.tips?.length ? `## Good to know\n${outline.tips.map(t => `- ${t}`).join("\n")}` : "",
    outline.chefCard ? `## Dietary card for restaurants\n${outline.chefCard}` : "",
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
  const scope = TripAPI.skillScope(a);

  // 1. Outline
  onProgress({ step: "outline", text: "Planning the route and where you'll stay…" });
  let outline;
  for (let attempt = 0; attempt < 2 && !outline; attempt++) {
    const o = await callJSON(system, outlinePrompt(a, dates), { signal, maxTokens: 7000, scope });
    if (Array.isArray(o?.days) && o.days.length >= n && Array.isArray(o.cities) && o.cities.length) outline = o;
  }
  if (!outline) throw new Error("The planner did not return a complete route. Try again.");
  if (flexible) {
    if (canStart(String(outline.start || ""))) dates = dates.map((_, i) => addDays(outline.start, i));
    a = { ...a, start: dates[0], end: dates[n - 1] };
  }
  outline.days = outline.days.slice(0, n).map((d, i) => ({ ...d, d: i + 1, date: dates[i], city: slug(d.city), stay: d.stay ? slug(d.stay) : null }));
  // Days are written in parallel batches, so the outline owns lunch and dinner: one restaurant, one meal.
  const eaten = new Set();
  outline.days.forEach(d => {
    d.meals = (Array.isArray(d.meals) ? d.meals : []).slice(0, 2).map(m => {
      const k = slug(m);
      if (!k || eaten.has(k)) return "";
      eaten.add(k);
      return String(m).slice(0, 80);
    });
  });

  const places = {};
  for (const c of outline.cities) {
    const key = slug(c.key || c.name);
    if (key) places[key] = { id: key, name: String(c.name || key), kind: "city", city: key, country: c.country || "", tz: validTz(c.timeZone) ? c.timeZone : "", query: [c.name, c.country].filter(Boolean).join(", ") };
  }
  for (const h of a.hotels || []) {
    places[h.key] = { id: h.key, name: h.name, kind: "hotel", city: slug(h.city), query: h.address ? `${h.name}, ${h.address}` : `${h.name}, ${h.cityName}, Japan`,
      ...(h.lat != null ? { lat: h.lat, lng: h.lng } : {}), booking: h.booked ? { booked: true } : { price: h.price, currency: h.currency, source: h.source, link: h.link } };
  }
  if (a.hotels?.length) outline.days.forEach(d => {
    const h = a.hotels.find(h => h.checkIn <= d.date && d.date < h.checkOut);
    d.stay = h ? h.key : null;
  });
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
    const r = await callJSON(system, daysPrompt(a, outline, from, to), { signal, scope });
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

  // 3. One more read of the whole plan, for what parallel day-writing can't see.
  onProgress({ step: "check", text: "Checking the whole plan for problems…" });
  try { await review(a, days, places, { signal, scope }); }
  catch (e) { if (e?.name === "AbortError") throw e; /* an unchecked plan is still a plan */ }

  // 4. Places on Google
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
      title: String(outline.title || "Japan").slice(0, 60), emoji: String(outline.emoji || "").slice(0, 4), version: "V1",
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
  // The chat opens with what the plan is and why it looks the way it does.
  const why = (outline.why || []).map(String).filter(Boolean).slice(0, 6);
  trip.chat = [
    { role: "ai", md: [
      outline.summary || "",
      why.length ? `**Why it looks like this**\n${why.map(w => `- ${w}`).join("\n")}` : "",
      "Ask me to change anything — swap a restaurant, slow a day down, add a day trip. I'll show the changes for you to approve first.",
    ].filter(Boolean).join("\n\n") },
  ];
  onProgress({ step: "done", text: "Your trip is ready." });
  return trip;
}

window.TripGenerator = { generate, locate, profileText, deckText };
})();
