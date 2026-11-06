/* The Japan country skill (skills/japan.md), trimmed per request.
   Every call gets the core rules (sections 1–4, 6, 7). The 300-experience catalog
   (section 5) is added only for the categories the traveller picked, plus rows from
   other categories that carry one of their secondary tags. In testing this kept
   itinerary quality with ~43% fewer input tokens than sending the whole file. */
let parsed = null;

async function load(env, origin) {
  if (parsed) return parsed;
  const res = await env.ASSETS.fetch(new Request(new URL("/skills/japan.md", origin)));
  if (!res.ok) throw new Error("skills/japan.md is missing");
  const lines = (await res.text()).split("\n");
  const catStart = lines.findIndex(l => l.startsWith("### Category 1:"));
  const sec6 = lines.findIndex(l => l.startsWith("## 6."));
  const core = [...lines.slice(0, catStart), ...lines.slice(sec6)].join("\n");
  const cats = [];
  let cur = null;
  for (const l of lines.slice(catStart, sec6)) {
    if (l.startsWith("### Category")) { cur = { head: l, tag: "", rows: [] }; cats.push(cur); continue; }
    if (!cur) continue;
    const m = /Module Tag:\*\s*`([^`]+)`/.exec(l);
    if (m) cur.tag = m[1];
    cur.rows.push(l);
  }
  parsed = { core, cats };
  return parsed;
}

/* The catalog as rows: { id, cat, title, desc, location, timing, pace, tags }. */
export async function catalogRows(env, origin) {
  const { cats } = await load(env, origin);
  const out = [];
  for (const c of cats) for (const r of c.rows) {
    const cells = r.split("|").map(x => x.trim());
    const id = /#(JP-\d{3})/.exec(cells[1] || "")?.[1];
    if (!id) continue;
    const [title, ...rest] = (cells[2] || "").split("<br>");
    out.push({ id, cat: c.tag, title: title.replace(/\*\*/g, "").trim(), desc: rest.join(" ").replace(/\*\*/g, "").trim(),
      location: cells[3] || "", timing: cells[4] || "", pace: cells[5] || "", tags: (cells[6] || "").replace(/`/g, "") });
  }
  return out;
}

/* Everything the model writes is shown to the traveller, so the skill's internal vocabulary stays internal. */
const VOICE = `

## Writing for the traveller
Everything you write is read by the traveller. Use plain language and "you". Never mention this skill, its sections or matrices, field names (party_type, TripBrief…), internal codes (NRT_T3, HND), or raw review counts like "11 pos / 2 neg"; say "Narita Terminal 3", "Haneda", "guests say it's quiet".`;

/* scope: { interests: [category tag], tags: [secondary tag], catalog: true|false } */
export async function skillText(env, origin, scope = {}) {
  const { core, cats } = await load(env, origin);
  if (scope.catalog === false) return core + VOICE;
  const interests = new Set(scope.interests || []), tags = scope.tags || [];
  const out = [];
  for (const c of cats) {
    if (interests.has(c.tag)) { out.push(c.head, ...c.rows); continue; }
    const extra = c.rows.filter(r => r.startsWith("| **`#JP") && tags.some(t => r.includes("`" + t)));
    if (extra.length) out.push(`${c.head} (only rows matching this traveller's secondary tags)`, "| ID | Experience | Location | Timing | Pace | Tags |", "|---|---|---|---|---|---|", ...extra);
  }
  return `${core}\n\n## Curated catalog for this traveller (from section 5)\n${out.join("\n") || "(no matching categories: plan from the rules above)"}${VOICE}`;
}
