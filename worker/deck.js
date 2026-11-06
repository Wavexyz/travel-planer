/* A quick "would you do this?" deck: ~10 experiences from the Japan skill's curated catalog that fit
   the traveller's interests, dates and places. Their yes / maybe / no answers then steer the plan
   more precisely than any category choice can.
   { interests: [tag], love: [tag], tags: [tag], start, end, cities: [..], profile } */
import { catalogRows } from "./skill.js";
import { deepseekJSON } from "./llm.js";
import { HttpError, isoDate, str } from "./util.js";

const DECK = 10;

export async function deck(b, env, { url }) {
  const interests = (Array.isArray(b.interests) ? b.interests : []).map(x => str(x, 60));
  const love = new Set((Array.isArray(b.love) ? b.love : []).map(x => str(x, 60)));
  const tags = (Array.isArray(b.tags) ? b.tags : []).map(x => str(x, 40));
  const rows = await catalogRows(env, url.origin);
  // Candidates: every row in a chosen category, plus rows elsewhere carrying one of their tags.
  const pool = rows.filter(r => interests.includes(r.cat) || tags.some(t => r.tags.includes(t)));
  if (!pool.length) throw new HttpError(404, "Pick at least one interest first.");
  const compact = pool.map(r => `${r.id} | ${r.cat}${love.has(r.cat) ? " (LOVED)" : ""} | ${r.title} | ${r.location} | ${r.timing} | ${r.pace}`).join("\n");
  const picked = await deepseekJSON(env, "You choose experiences from a curated Japan catalog for a traveller. Reply with JSON only.", `TRAVELLER
${str(b.profile, 2500)}
Trip: ${isoDate(b.start) || "?"} to ${isoDate(b.end) || "?"}. Places they want: ${(b.cities || []).map(c => str(c, 40)).join(", ") || "open — reachable on a normal Japan route"}.

CATALOG CANDIDATES (id | category | title | where | best timing | pace)
${compact}

Choose the ${DECK} experiences most worth asking them about: mostly from LOVED categories, the rest from the others; only ones that are possible on their dates (seasonal timing, festivals) and reachable from the places they want; varied (not three temples in a row); a few signature picks and a few they wouldn't find themselves.
Reply: {"picks":[{"id":"JP-001","pitch":"one vivid sentence to the traveller, max 22 words","query":"the main place's name and city, for a photo search"}]}`, { maxTokens: 1500 });
  const byId = new Map(rows.map(r => [r.id, r]));
  const items = (picked.picks || []).map(p => {
    const r = byId.get(str(p.id, 8));
    return r && { id: r.id, cat: r.cat, title: r.title, location: r.location, timing: r.timing, pace: r.pace, pitch: str(p.pitch, 200), query: str(p.query, 120) || `${r.title}, Japan` };
  }).filter(Boolean).slice(0, DECK);
  return Response.json({ items });
}
