"use strict";
/* The site's own backend (worker/): DeepSeek, flights and hotels. Keys live on the
   server; the page only knows the public config the Worker injects (APP_CONFIG). */
(() => {
const CONFIG = window.APP_CONFIG || { server: false };

async function post(path, body, { signal } = {}) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json())?.error?.message || ""; } catch {}
    const e = new Error(msg || `The server returned HTTP ${res.status}.`);
    e.status = res.status;
    throw e;
  }
  return res;
}
const postJSON = async (path, body, opts) => (await post(path, body, opts)).json();

/* Which parts of the Japan skill a request needs, from the questionnaire answers. */
function skillScope(a = {}) {
  // The deck's "yes" and "maybe" picks bring their catalog categories along, so their full entries reach the planner.
  const picked = [...(a.deck?.yes || []), ...(a.deck?.maybe || [])].map(x => x.cat).filter(Boolean);
  const interests = [...new Set([...(a.interests || []), ...(a.food || []), ...(a.onsen === "yes" ? ["onsen_ryokan_baths"] : []), ...picked])];
  const diet = a.diet || [];
  const tags = ["indoor_rainy_day"];
  if (diet.includes("pescatarian")) tags.push("pescatarian_friendly", "seafood");
  if (diet.includes("vegetarian") || diet.includes("vegan")) tags.push("vegetarian_friendly");
  if (a.party === "family_with_kids") tags.push("family_friendly");
  if (a.party === "couple") tags.push("romantic");
  if (a.pace === "relaxed" || a.party === "seniors") tags.push("relaxed_pace");
  if (a.crowds === "high_avoid_crowds") tags.push("anti_crowd_dupe", "off_the_beaten_path");
  if (a.discovery === "gems" || a.visits === "expert" || a.visits === "returning") tags.push("off_the_beaten_path", "local_vibe");
  if (a.tattoos && a.tattoos !== "no_tattoos") tags.push("tattoo_friendly");
  return { interests, tags };
}

window.TripAPI = { config: CONFIG, post, postJSON, skillScope };
})();
