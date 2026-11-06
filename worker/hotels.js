/* Hotels for one stop from Google Hotels (SerpApi via treg), ranked with the Japan skill.
   1. Search the neighbourhood for the stay dates (4.0+ rating, within budget). Hotels far from
      the neighbourhood's centre, or at an airport, are dropped: convenience comes first.
   2. Fetch property details for the strongest 6: every booking site's live price with links,
      and the room types with their own photos. No live price anywhere = unavailable, dropped.
   3. Fetch the 10 latest Google reviews for the best 4, so the fit is checked against what
      guests actually say (cleanliness, noise, location…).
   4. DeepSeek applies the skill's hotel rules, writes a reason for every candidate and ranks them;
      the top 3 are returned. The traveller books through the link themselves.

   { city, area, areaLat, areaLng, checkIn, checkOut, adults, children: [ages], currency,
     maxPerNight, priorities: [..], bed, style, comment, profile } */
import { tregGet } from "./treg.js";
import { deepseekJSON } from "./llm.js";
import { skillText } from "./skill.js";
import { HttpError, isoDate, pool, str } from "./util.js";

const ENDPOINT = "serpapi.x.google-hotels";
const DETAILS = 6, REVIEWED = 4;
/* Booking sites we send people to: proper booking sites with support and clear cancellation, not
   price-comparison sites that bounce you elsewhere. Override with the BOOKING_SITES secret
   (comma-separated names as Google lists them). The hotel's own website is always allowed. */
const DEFAULT_SITES = ["Booking.com", "Expedia.com", "Hotels.com", "Agoda", "Trip.com", "Rakuten Travel", "Ikyu.com", "JAPANiCAN.com", "Relux"];
const siteKey = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const aspect = (p, name) => {
  const a = (p.reviews_breakdown || []).find(r => r.name === name);
  return a ? { pos: a.positive || 0, neg: a.negative || 0 } : null;
};
const km = (a, b) => {
  const r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

/* Booking sites name the same room differently ("UTSUROI - Station Side Queen Room - Non-Smoking"
   vs "-UTSUROI- (Renovated) 1 Queen Non Smoking"), so match on the words that describe it. */
const ROOM_FILLER = new Set(["room", "rooms", "non", "smoking", "nonsmoking", "no", "the", "with", "and", "a", "of", "1", "type", "only", "renovated", "view", "standard"]);
const roomWords = n => new Set(String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w && !ROOM_FILLER.has(w)));
function roomPhotos(name, all) {
  const want = roomWords(name);
  // A name made only of filler ("Standard Room") can still match itself exactly.
  if (!want.size) return [...new Set(all.filter(r => r.name === name).flatMap(r => r.images))].slice(0, 12).map(u => ({ thumb: u, full: u }));
  // Same room or a less specific name for it: "UTSUROI Queen" fits "UTSUROI Station Side Queen", but
  // "UTSUROI Queen" photos never stand in for a plain "Queen Room".
  const sim = r => { const w = roomWords(r.name); if (![...w].every(x => want.has(x))) return 0; return w.size / want.size; };
  const urls = all.map(r => ({ r, s: r.name === name ? 2 : sim(r) })).filter(x => x.s >= 0.5 && x.r.images.length)
    .sort((x, y) => y.s - x.s).flatMap(x => x.r.images);
  return [...new Set(urls)].slice(0, 12).map(u => ({ thumb: u, full: u }));
}

const SHARED = /dorm|bunk|capsule|\bbed in\b|female only|male only/i;

function offersOf(d, allowed) {
  const bySource = new Map();
  for (const o of [...(d.featured_prices || []), ...(d.prices || [])]) {
    const perNight = num(o.rate_per_night?.extracted_lowest);
    if (!o.source || perNight == null) continue;
    if (!o.official && !allowed.has(siteKey(o.source))) continue;
    const prev = bySource.get(o.source);
    if (!prev || perNight < prev.perNight || (!prev.rooms.length && o.rooms?.length)) {
      bySource.set(o.source, {
        source: o.official ? "the hotel's website" : str(o.source, 40).replace(/\.com$/i, ""), logo: str(o.logo, 300), link: str(o.link, 1200), perNight,
        total: num(o.total_rate?.extracted_lowest), official: !!o.official,
        rooms: (o.rooms || []).slice(0, 8).map(r => ({
          name: str(r.name, 90), perNight: num(r.rate_per_night?.extracted_lowest),
          images: (r.images || []).filter(u => typeof u === "string").slice(0, 8),
        })),
      });
    }
  }
  return [...bySource.values()].sort((a, b) => a.perNight - b.perNight);
}

export async function hotels(b, env, { ctx, url }) {
  const city = str(b.city, 60);
  // A few good neighbourhoods per stop, not one: the best hotel may sit just across the line.
  const areas = (Array.isArray(b.areas) ? b.areas : []).map(a => ({ name: str(a?.name, 50), lat: num(+a?.lat) || null, lng: num(+a?.lng) || null })).filter(a => a.name).slice(0, 3);
  const area = areas.map(a => a.name).join(", ");
  const checkIn = isoDate(b.checkIn), checkOut = isoDate(b.checkOut);
  if (!city || !checkIn || !checkOut || checkOut <= checkIn) throw new HttpError(400, "Add the city and valid check-in and check-out dates.");
  const adults = Math.min(6, Math.max(1, +b.adults || 2));
  const kids = (Array.isArray(b.children) ? b.children : []).map(Number).filter(n => n >= 0 && n <= 17).slice(0, 4);
  const currency = str(b.currency, 3).toUpperCase() || "USD";
  const max = +b.maxPerNight > 0 ? Math.round(+b.maxPerNight) : null;
  const priorities = (Array.isArray(b.priorities) ? b.priorities : []).map(p => str(p, 40)).slice(0, 10);
  const comment = str(b.comment, 400);
  const kind = b.style === "ryokan" ? "ryokan" : b.bed === "family_apartment" ? "apartment hotel" : "hotels";
  const centres = areas.filter(a => a.lat && a.lng);
  const allowed = new Set((env.BOOKING_SITES ? env.BOOKING_SITES.split(",") : DEFAULT_SITES).map(siteKey));
  const whereOf = name => `${name && name.toLowerCase() !== city.toLowerCase() ? name + ", " : ""}${city}, Japan`;
  const where = whereOf(areas[0]?.name);
  const common = { engine: "google_hotels", hl: "en", currency, check_in_date: checkIn, check_out_date: checkOut, adults,
    children: kids.length || undefined, children_ages: kids.join(",") || undefined };

  const findOne = (what, cap, place) => tregGet(env, ctx, ENDPOINT, { ...common, q: `${what} in ${whereOf(place)}`, rating: 8, max_price: cap ? Math.round(cap) : undefined });
  // One search per neighbourhood, merged.
  const find = async (what, cap) => {
    const lists = await Promise.all((areas.length ? areas : [{ name: "" }]).map(a => findOne(what, cap, a.name).catch(() => ({}))));
    const seen = new Set();
    return { properties: lists.flatMap(l => l.properties || []).filter(p => p.property_token && !seen.has(p.property_token) && seen.add(p.property_token)) };
  };
  const quiet = priorities.some(p => /quiet/i.test(p)), central = priorities.some(p => /central|sights/i.test(p));
  const usable = p => {
    if (!p.property_token || num(p.rate_per_night?.extracted_lowest) == null) return false;
    if (p.type === "vacation rental" && b.bed !== "family_apartment") return false;
    if (/airport/i.test(p.name) && !/airport/i.test(area)) return false;
    // Skill, Matrix A: light sleepers reject hotels whose Sleep reviews are net-negative.
    const s = aspect(p, "Sleep");
    return !(quiet && s && s.neg > s.pos);
  };
  const withDistance = p => {
    const g = p.gps_coordinates;
    p._km = null; p._near = "";
    if (g?.latitude) for (const c of centres) {
      const d = km(c, { lat: g.latitude, lng: g.longitude });
      if (p._km == null || d < p._km) { p._km = d; p._near = c.name; }
    }
    return p;
  };
  let found = ((await find(kind, max && max * 1.15)).properties || []).filter(usable).map(withDistance);
  // Small places (e.g. Hakone ryokan) can leave fewer than 3: widen to any lodging and a looser budget.
  if (found.length < 4) {
    const seen = new Set(found.map(p => p.property_token));
    const more = ((await find("hotels and ryokan", max && max * 1.4)).properties || []).filter(p => usable(p) && !seen.has(p.property_token)).map(withDistance);
    found = [...found, ...more];
  }
  // Stay in (or next to) one of the neighbourhoods: within 2 km when there's enough choice, else 5 km.
  if (centres.length) {
    const near = found.filter(p => p._km == null || p._km <= 2);
    found = near.length >= 3 ? near : found.filter(p => p._km == null || p._km <= 5);
  }
  const score = p => (p.overall_rating || 0) * 2 + Math.log10((p.reviews || 1) + 1) + (p.location_rating || 0) * (central ? 0.9 : 0.5)
    - (p._km != null ? p._km * 0.6 : 0) - (max && p.rate_per_night.extracted_lowest > max ? 1.5 : 0);
  const top = found.sort((a, b) => score(b) - score(a)).slice(0, DETAILS);
  if (!top.length) throw new HttpError(404, `No available hotels matched in ${area || city} for these dates. Try a higher budget or another neighbourhood.`);

  const enriched = (await pool(top, DETAILS, async (p, i) => {
    let d = {};
    try { d = await tregGet(env, ctx, ENDPOINT, { ...common, q: `${kind} in ${where}`, property_token: p.property_token }); }
    catch { return null; }
    const offers = offersOf(d, allowed);
    if (!offers.length) return null; // no live price on a trusted site: treat as unavailable
    // Shared beds (dorms, bunks, capsules) only ever suit someone travelling alone.
    const listed = offers.reduce((n, o) => n + o.rooms.length, 0);
    if (adults + kids.length > 1) offers.forEach(o => { o.rooms = o.rooms.filter(r => !SHARED.test(r.name)); });
    const rooms = offers.flatMap(o => o.rooms).filter((r, j, all) => r.name && all.findIndex(x => x.name === r.name) === j).slice(0, 6);
    if (listed && !rooms.length) return null; // only shared beds on offer
    return {
      id: "h" + (i + 1), token: p.property_token,
      name: str(p.name, 90), type: str(p.type, 30), stars: num(p.extracted_hotel_class),
      rating: num(p.overall_rating), reviews: num(p.reviews), locationRating: num(p.location_rating),
      distanceKm: p._km != null ? Math.round(p._km * 10) / 10 : null, nearArea: p._near,
      sleep: aspect(p, "Sleep"), aspects: (d.reviews_breakdown || p.reviews_breakdown || []).slice(0, 8).map(r => ({ name: str(r.name, 30), pos: r.positive || 0, neg: r.negative || 0 })),
      description: str(p.description || d.description, 400),
      amenities: (p.amenities || []).slice(0, 14).map(a => str(a, 40)),
      nearby: (p.nearby_places || []).slice(0, 3).map(n => ({ name: str(n.name, 60), how: (n.transportations || []).map(t => `${t.type} ${t.duration}`).slice(0, 2).join(", ") })),
      images: (d.images || p.images || []).slice(0, 12).map(im => ({ thumb: str(im.thumbnail, 400), full: str(im.original_image || im.thumbnail, 400) })).filter(im => im.thumb),
      address: str(d.address, 160), lat: num(p.gps_coordinates?.latitude), lng: num(p.gps_coordinates?.longitude),
      cheapest: offers[0], offers: offers.slice(0, 5).map(({ rooms, ...o }) => o), rooms, roomOffers: offers.flatMap(o => o.rooms),
    };
  })).filter(Boolean);
  if (!enriched.length) throw new HttpError(404, `None of the top hotels in ${area || city} had live prices for these dates.`);

  // What guests say, for the strongest few.
  await pool(enriched.slice(0, REVIEWED), REVIEWED, async h => {
    try {
      // The most recent reviews, from the last 12 months only ("a year ago" and newer).
      const r = await tregGet(env, ctx, ENDPOINT, { ...common, q: `${kind} in ${where}`, engine: "google_hotels_reviews", property_token: h.token, sort_by: 2 });
      h.guestReviews = (r.reviews || []).filter(x => !/years ago/.test(x.date || "")).map(x => str(x.snippet, 400)).filter(Boolean).slice(0, 10);
    } catch { h.guestReviews = []; }
  });

  // The skill ranks every candidate and explains each, so every card shown has a reason.
  const system = await skillText(env, url.origin, { catalog: false });
  const compact = enriched.map(h => ({
    id: h.id, name: h.name, type: h.type, stars: h.stars, rating: h.rating, reviews: h.reviews, locationRating: h.locationRating,
    kmFromNearestArea: h.distanceKm, nearestArea: h.nearArea, aspects: h.aspects, perNight: h.cheapest.perNight, cheapestAt: h.cheapest.source,
    rooms: h.rooms.map(r => r.name), amenities: h.amenities, nearby: h.nearby, description: h.description, guestReviews: h.guestReviews,
  }));
  const ranked = await deepseekJSON(env, system, `Rank these hotels for this traveller's stay in ${area || city} (${city}), ${checkIn} to ${checkOut}, ${adults} adult${adults > 1 ? "s" : ""}${kids.length ? `, children aged ${kids.join(", ")}` : ""}.
TRAVELLER
${str(b.profile, 3000)}
Hotel priorities, in order: ${priorities.join(", ") || "none given"}. Bed: ${str(b.bed, 40) || "any"}. Max per room per night: ${max ? `${max} ${currency}` : "no cap"}.
${comment ? `Their own words about the hotel: "${comment}"\n` : ""}The neighbourhoods (${area || city}) were suggested by our route planner, not chosen by the traveller: never say they asked for them.

CANDIDATES (live prices in ${currency} per room per night; guestReviews are recent Google reviews)
${JSON.stringify(compact)}

Rank for convenience first (walk to a major station and the sights they'll visit), then their priorities, then the skill's rules (Matrix A room size and bed width, Matrix B onsen and tattoos).
Judge each hotel by the consensus: the review aspects (positive vs negative counts across all reviews) and what several of the recent reviews agree on. A single guest's complaint or anecdote is never a reason to warn anyone.
"watch" is only for a real, widely shared drawback that matters to this traveller (e.g. most guests find the rooms small, or the bath bans tattoos and they have tattoos), written calmly as practical advice. Leave it empty when there is none; most good hotels have none.
Reply with JSON only: {"ranked":[{"id":"h1","headline":"max 8 words","why":"1–2 short sentences to the traveller on why it suits you","quote":"one short sentence copied word for word from its guestReviews that supports the fit, or empty","watch":"one calm sentence of practical advice about a widely shared drawback, or empty","room":"the room type to book from its list, or empty"}]}
Include every candidate, best first.`, { maxTokens: 2500 });

  const byId = new Map(enriched.map(h => [h.id, h]));
  const out = [];
  for (const r of ranked.ranked || []) {
    const h = byId.get(r.id); if (!h || out.includes(h)) continue;
    // Only keep a quote that really appears in a review.
    const quote = str(r.quote, 220).replace(/^["“]|["”]$/g, "");
    const room = h.rooms.find(x => x.name === str(r.room, 90)) || h.rooms[0];
    Object.assign(h, { headline: str(r.headline, 80), why: str(r.why, 400), watch: str(r.watch, 220), room: room?.name || "",
      quote: quote && (h.guestReviews || []).some(g => g.includes(quote)) ? quote : "" });
    out.push(h);
  }
  // Anything the model skipped still needs a reason; use Google's own description.
  for (const h of enriched) if (!out.includes(h)) out.push(Object.assign(h, { why: h.why || h.description, room: h.rooms[0]?.name || "" }));
  const picks = out.slice(0, 3);

  // Photos from the hotel and booking sites only — never guests' uploads. Hotels also post their
  // social media here (portrait and square shots of guests, staff, promotions): keep wide
  // photography only, and the sections that show the place before the "At a glance" mix.
  const SECTIONS = [/exterior/i, /interior/i, /food/i, /amenit/i, /glance/i];
  await pool(picks, 3, async h => {
    // The Rooms tab shows the room we recommend, from the booking sites' photos of that room type.
    // One or two photos are often a generic shot (a lobby, the restaurant), so it takes three.
    h.roomImages = roomPhotos(h.room, h.roomOffers);
    if (h.roomImages.length < 3) h.roomImages = [];
    h.roomLabel = h.roomImages.length ? "Your room" : "Rooms";
    try {
      const r = await tregGet(env, ctx, ENDPOINT, { ...common, q: `${kind} in ${where}`, engine: "google_hotels_photos", property_token: h.token });
      const official = res => res.flatMap(re => (r.sections || []).filter(s => re.test(s.title || "")).flatMap(s => s.photos || []))
        .filter(ph => ph.source && ph.source !== "Visitor Submitted" && ph.photo_url && (!ph.width || !ph.height || ph.width >= ph.height * 1.3))
        // Professional listing photos first, then the hotel's own.
        .sort((x, y) => (y.source === "External Website") - (x.source === "External Website"))
        .map(ph => ({ thumb: str(ph.thumbnail_url || ph.photo_url, 500), full: str(ph.photo_url, 500) }));
      const seen = new Set();
      const uniq = list => list.filter(x => !seen.has(x.full) && seen.add(x.full)).slice(0, 12);
      const hotel = uniq(official(SECTIONS));
      if (hotel.length >= 3) h.images = hotel;
      // No photos of the exact room: fall back to the hotel's own bedroom photos.
      if (!h.roomImages.length) h.roomImages = uniq(official([/bedroom/i, /bathroom/i]));
    } catch { /* keep the property photos */ }
  });
  return Response.json({ city, area, checkIn, checkOut, currency, hotels: picks.map(({ token, guestReviews, aspects, rooms, roomOffers, ...h }) => h), searchedAt: new Date().toISOString() });
}
