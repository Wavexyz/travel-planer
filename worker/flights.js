/* Flights from Google Flights (SerpApi via treg). Tested against Tourmind and fli for the same
   route: identical fares to fli (both read Google Flights), broader airline coverage than
   Tourmind, and every option opens in Google Flights where the traveller compares and books.

   { mode: "search", from: "LHR", arrive: ["HND","NRT"], leave: ["KIX"], outbound, inbound,
     adults, children, cabin: 1-4, currency }  → 3 options (best, cheapest, fastest)
   { mode: "lookup", flight: "NH 212", date, from?: "LHR", to?: "LHR" } → the booked leg's times */
import { tregGet } from "./treg.js";
import { HttpError, iata, isoDate, pool, str } from "./util.js";

const ENDPOINT = "serpapi.x.google-flights";
const JAPAN_GROUPS = [["HND", "NRT"], ["KIX", "ITM"], ["NGO", "FUK", "CTS", "OKA"]];
const codes = v => [...new Set((Array.isArray(v) ? v : String(v || "").split(/[\s,]+/)).map(iata).filter(Boolean))];
const CANDIDATES = 5;
const flightNo = s => String(s || "").toUpperCase().replace(/\s+/g, "");

export async function flights(body, env, { ctx }) {
  return body.mode === "lookup" ? lookup(body, env, ctx) : search(body, env, ctx);
}

function leg(f) {
  return {
    airline: str(f.airline, 60), logo: str(f.airline_logo, 300), number: str(f.flight_number, 12),
    from: { id: f.departure_airport?.id, name: str(f.departure_airport?.name, 80), time: f.departure_airport?.time },
    to: { id: f.arrival_airport?.id, name: str(f.arrival_airport?.name, 80), time: f.arrival_airport?.time },
    minutes: f.duration, airplane: str(f.airplane, 40), legroom: str(f.legroom, 20), overnight: !!f.overnight,
  };
}
function journey(o) {
  return {
    price: o.price ?? null, minutes: o.total_duration,
    stops: Math.max(0, (o.flights?.length || 1) - 1),
    legs: (o.flights || []).map(leg),
    layovers: (o.layovers || []).map(l => ({ id: l.id, name: str(l.name, 80), minutes: l.duration, overnight: !!l.overnight })),
    notes: (o.extensions || []).map(e => str(e, 80)).slice(0, 4),
    token: o.departure_token || "",
  };
}

async function search(b, env, ctx) {
  const from = codes(b.from), arrive = codes(b.arrive).length ? codes(b.arrive) : ["HND", "NRT"];
  const leave = codes(b.leave).length ? codes(b.leave) : arrive;
  const outbound = isoDate(b.outbound), inbound = isoDate(b.inbound);
  if (!from.length) throw new HttpError(400, "Add the airport you fly from (a 3-letter code such as LHR).");
  if (!outbound || !inbound || inbound < outbound) throw new HttpError(400, "Add valid outbound and return dates.");
  const sameAirports = arrive.join() === leave.join();
  // Filters from the traveller's comments ("nonstop only", "back in under 16h", "no red-eyes"…).
  const f = b.filters || {};
  const hours = v => Array.isArray(v) && v.length === 2 && v.every(h => h >= 0 && h <= 23) ? `${v[0]},${v[1]}` : undefined;
  const codesOf = v => (Array.isArray(v) ? v : []).map(iata).filter(Boolean).join(",") || undefined;
  const filters = {
    stops: [1, 2, 3].includes(+f.stops) ? +f.stops : undefined, // 1 nonstop, 2 ≤1 stop, 3 ≤2 stops
    max_duration: +f.maxMinutes > 60 ? Math.round(+f.maxMinutes) : undefined,
    max_price: +f.maxPrice > 0 ? Math.round(+f.maxPrice) : undefined,
    include_airlines: codesOf(f.includeAirlines), exclude_airlines: f.includeAirlines?.length ? undefined : codesOf(f.excludeAirlines),
  };
  const outTimes = hours(f.outDepartHours), backTimes = hours(f.backDepartHours);
  const base = {
    ...filters,
    engine: "google_flights", hl: "en", currency: str(b.currency, 3).toUpperCase() || "USD",
    adults: Math.min(9, Math.max(1, +b.adults || 1)), children: Math.min(8, Math.max(0, +b.children || 0)),
    travel_class: [1, 2, 3, 4].includes(+b.cabin) ? +b.cabin : 1,
    ...(sameAirports
      ? { type: 1, departure_id: from.join(","), arrival_id: arrive.join(","), outbound_date: outbound, return_date: inbound, outbound_times: outTimes, return_times: backTimes }
      // treg requires these parameters to be present; SerpApi wants them empty for multi-city.
      : { type: 3, departure_id: "", arrival_id: "", outbound_date: "", multi_city_json: JSON.stringify([
          { departure_id: from.join(","), arrival_id: arrive.join(","), date: outbound, ...(outTimes ? { times: outTimes } : {}) },
          { departure_id: leave.join(","), arrival_id: from.join(","), date: inbound, ...(backTimes ? { times: backTimes } : {}) },
        ]) }),
  };
  const first = await tregGet(env, ctx, ENDPOINT, base);
  const all = [...(first.best_flights || []), ...(first.other_flights || [])].filter(o => o.price && o.departure_token);
  if (!all.length) throw new HttpError(404, Object.values(filters).some(v => v !== undefined) || outTimes || backTimes
    ? "No flights match those wishes. Try loosening one of them." : "Google Flights found no fares for these airports and dates.");

  // The first list only shows a "from" price per outbound; the real total depends on the
  // return. So complete up to 5 different outbounds, then label on the real totals.
  const seen = new Set(), cands = [];
  const key = o => (o.flights || []).map(f => f.flight_number).join("+");
  const add = o => { if (o && !seen.has(key(o)) && cands.length < CANDIDATES) { seen.add(key(o)); cands.push(o); } };
  add(first.best_flights?.find(o => o.departure_token));
  [...all].sort((a, b) => a.price - b.price).slice(0, 2).forEach(add);
  [...all].sort((a, b) => a.total_duration - b.total_duration).slice(0, 2).forEach(add);
  all.forEach(add);

  const trips = (await pool(cands, CANDIDATES, async (o, i) => {
    try {
      const second = await tregGet(env, ctx, ENDPOINT, { ...base, departure_token: o.departure_token });
      const backs = [...(second.best_flights || []), ...(second.other_flights || [])].filter(r => r.price);
      if (!backs.length) return null;
      const back = (second.best_flights || []).find(r => r.price) || backs[0];
      const out = journey(o), ret = journey(back);
      delete out.token; delete ret.token;
      return { googleBest: i === 0, price: back.price, minutes: (o.total_duration || 0) + (back.total_duration || 0), outbound: out, inbound: ret,
        link: second.search_metadata?.google_flights_url || first.search_metadata?.google_flights_url || "" };
    } catch { return null; }
  })).filter(Boolean);
  if (!trips.length) throw new HttpError(502, "Google Flights did not return the return legs. Try again.");

  // Three different trade-offs, never the same itinerary twice.
  const low = Math.min(...trips.map(t => t.price));
  const options = [], used = new Set();
  const take = (label, t) => { if (t && !used.has(t)) { used.add(t); options.push({ label, ...t }); } };
  const google = trips.find(t => t.googleBest);
  take(google?.price === low ? "Best overall · cheapest" : "Best overall", google);
  take("Cheapest", trips.find(t => t.price === low));
  take("Fastest", [...trips].filter(t => !used.has(t)).sort((a, b) => a.minutes - b.minutes)[0]);
  // Value: price plus ~$40 per hour of travel, among whatever is left.
  for (const t of [...trips].sort((a, b) => a.price + a.minutes / 1.5 - (b.price + b.minutes / 1.5))) { if (options.length >= 3) break; take("Best value", t); }
  options.forEach(o => { delete o.googleBest; });
  if (!options.length) throw new HttpError(502, "Google Flights did not return the return legs. Try again.");
  const pi = first.price_insights || {};
  return Response.json({
    currency: base.currency, options,
    insights: { lowest: pi.lowest_price ?? null, level: pi.price_level || "", typical: pi.typical_price_range || null },
    searchedAt: new Date().toISOString(),
  });
}

async function lookup(b, env, ctx) {
  const no = flightNo(b.flight), date = isoDate(b.date);
  if (!/^[A-Z0-9]{2}\d{1,4}$/.test(no) || !date) throw new HttpError(400, "Enter a flight number like NH 212 and its date.");
  const from = codes(b.from), to = codes(b.to);
  if (!from.length && !to.length) throw new HttpError(400, "Add the airport this flight leaves from or flies to.");
  // The leg that lands in (or leaves) Japan is nonstop from the airport given. Google returns
  // only ~20 itineraries per search, so search nonstop flights one airport group at a time.
  for (const group of JAPAN_GROUPS) {
    const data = await tregGet(env, ctx, ENDPOINT, {
      engine: "google_flights", hl: "en", type: 2, stops: 1, outbound_date: date,
      departure_id: (from.length ? from : group).join(","), arrival_id: (from.length ? group : to).join(","),
    });
    for (const o of [...(data.best_flights || []), ...(data.other_flights || [])]) {
      const f = (o.flights || []).find(f => flightNo(f.flight_number) === no);
      if (f) return Response.json({ found: true, leg: leg(f) });
    }
  }
  return Response.json({ found: false });
}
