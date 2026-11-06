"use strict";
/* Trip assistant — DeepSeek chat with a browser-held key. */
(() => {
const UI = window.TripUI;
if (!UI) return;
const D = UI.D;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = UI.esc;

const API = "https://api.deepseek.com/chat/completions";
const K_CHAT = "trip-chat:" + D.id;
const msgsEl = $("#msgs");
const askEl = $("#ask");
const sendBtn = $("#send");
const noteEl = $("#chatnote");

let apiKey = TripSettings.deepseekKey();
let model = TripSettings.model();
let chatLog = loadChat();
let busy = false, controller = null, flashTimer = null, keyProblem = false;
let slot = null, slotData = null, pendingSend = null;
const slotBanner = $("#slot-banner"), slotBannerText = $("#slot-banner-text");

function loadChat() {
  try {
    const raw = localStorage.getItem(K_CHAT);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-20) : [];
  } catch { return []; }
}
function saveChat() {
  try { localStorage.setItem(K_CHAT, JSON.stringify(chatLog.slice(-20))); } catch {}
}

/* ---------- Rendering ---------- */
const DIRECTIVE = /\[\[(map|day):\s*([^\]]+)\]\]/g;
function directives(text) {
  const out = []; let m; DIRECTIVE.lastIndex = 0;
  while ((m = DIRECTIVE.exec(text))) out.push({ type: m[1], val: m[2].trim() });
  return out;
}
function stripDirectives(text) {
  return String(text).replace(DIRECTIVE, "").replace(/\[\[[^\]]*$/, "").trim();
}
function cleanForRender(text) {
  return String(text)
    .replace(DIRECTIVE, "")
    .replace(/```json[\s\S]*?```/gi, "")
    .replace(/```json[\s\S]*$/i, "")
    .replace(/\[\[[^\]]*$/, "")
    .replace(/\{\{[^}]*$/, "")
    .trim();
}
function normTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ""));
  if (!m) return "";
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}
function planMode(m) {
  const t = String(m || "").toLowerCase();
  if (/walk|foot/.test(t)) return "walk";
  if (/bus|coach/.test(t)) return "bus";
  if (/taxi|car|drive/.test(t)) return "car";
  return "rail";
}
function extractPlan(text) {
  const re = /```json\s*([\s\S]*?)```/gi;
  let last = null, m;
  while ((m = re.exec(String(text)))) last = m[1];
  if (!last) return null;
  let raw;
  try { raw = JSON.parse(last.trim()); } catch { return null; }
  const placeId = raw.placeId || raw.place || raw.place_id;
  const place = UI.P[placeId];
  if (!place) return null;
  const day = slot?.day ?? +(raw.day ?? 0);
  if (!(day >= 1 && day <= UI.DAYS.length)) return null;
  let start = normTime(raw.start), end = normTime(raw.end);
  if (!start) start = slot?.start || "";
  if (!end) end = slot?.end || "";
  if (!start || !end || end <= start) return null;
  return {
    day, start, end, placeId,
    title: String(raw.title || `Visit ${place.name}`).slice(0, 120),
    note: String(raw.note || raw.why || "").slice(0, 320),
    travelMode: planMode(raw.travelMode || raw.mode),
    travelMin: Number(raw.travelMin) || 0,
  };
}
function addMsg(role, html) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  el.innerHTML = role === "ai"
    ? `<div class="who"><span aria-hidden="true">✦</span>Trip assistant</div><div class="prose">${html}</div>`
    : `<div class="prose">${html}</div>`;
  msgsEl.appendChild(el);
  return el;
}
function lastJsonObject(text) {
  const re = /```json\s*([\s\S]*?)```/gi;
  let last = null, m;
  while ((m = re.exec(String(text)))) last = m[1];
  if (!last) return null;
  try { return JSON.parse(last.trim()); } catch { return null; }
}
function extractChanges(text) {
  const raw = lastJsonObject(text);
  if (!raw || !Array.isArray(raw.changes)) return null;
  const allowed = new Set(["add", "move", "edit", "remove"]);
  const changes = [];
  for (const c of raw.changes) {
    if (!c || !allowed.has(String(c.op).toLowerCase())) continue;
    const op = String(c.op).toLowerCase();
    const out = { ...c, op };
    if (op === "add") {
      const placeId = c.placeId || c.place;
      if (!UI.P[placeId] || !normTime(c.start) || !normTime(c.end)) continue;
      out.placeId = placeId;
      out.day = +c.day;
      if (!(out.day >= 1 && out.day <= UI.DAYS.length)) continue;
    } else {
      if (!c.sid) continue;
      out.sid = String(c.sid).trim();
    }
    if (op === "move") {
      out.day = c.day != null ? +c.day : undefined;
      if (out.day != null && !(out.day >= 1 && out.day <= UI.DAYS.length)) continue;
    }
    changes.push(out);
  }
  if (!changes.length) return null;
  return { summary: String(raw.summary || "Proposed plan changes").slice(0, 160), changes };
}
function changeItem(sid) {
  for (const day of UI.DAYS) {
    const item = day.items.find(it => it.sid === sid);
    if (item) return { day, item };
  }
  return null;
}
function changeRow(ch) {
  if (ch.op === "add") {
    const place = UI.P[ch.placeId];
    return `<div class="change-item op-add"><span class="change-op">Add</span><div><b>${esc(ch.title || place?.name || "New activity")}</b><span>Day ${ch.day} · ${esc(ch.start)}–${esc(ch.end)}${place ? " · " + esc(place.name) : ""}</span></div></div>`;
  }
  const hit = changeItem(ch.sid);
  if (!hit) return `<div class="change-item op-warn"><span class="change-op">Missing</span><div><b>Unknown item</b><span>${esc(ch.sid)} is no longer in the plan.</span></div></div>`;
  const { day, item } = hit;
  const where = `Day ${day.d} · ${item.allDay ? "all day" : `${item.s}–${item.e}`}`;
  if (ch.op === "remove") {
    return `<div class="change-item op-remove"><span class="change-op">Remove</span><div><b>${esc(item.t)}</b><span>${where}</span></div></div>`;
  }
  if (ch.op === "move") {
    const target = ch.day ? UI.DAYS.find(d => d.d === +ch.day) || day : day;
    const to = `Day ${target.d} · ${esc(ch.start || item.s)}–${esc(ch.end || item.e)}`;
    return `<div class="change-item op-move"><span class="change-op">Move</span><div><b>${esc(item.t)}</b><span>${where} → ${to}</span></div></div>`;
  }
  const parts = [];
  if (ch.title !== undefined) parts.push(`title → ${esc(ch.title)}`);
  if (ch.note !== undefined) parts.push(`note updated`);
  if (ch.start !== undefined || ch.end !== undefined) parts.push(`${esc(ch.start || item.s)}–${esc(ch.end || item.e)}`);
  if (ch.placeId) parts.push(`place → ${esc(UI.P[ch.placeId]?.name || ch.placeId)}`);
  return `<div class="change-item op-edit"><span class="change-op">Edit</span><div><b>${esc(item.t)}</b><span>${where}${parts.length ? " · " + parts.join(" · ") : ""}</span></div></div>`;
}
function appendChangeCard(prose, proposal) {
  const card = document.createElement("div");
  card.className = "plan-card change-card";
  card.innerHTML = `
    <div class="plan-h"><span class="tag">Proposed changes</span><b>${esc(proposal.summary)}</b></div>
    <p class="plan-note">Review this before applying. It changes the plan saved in this browser.</p>
    <div class="change-list">${proposal.changes.map(changeRow).join("")}</div>
    <p class="plan-warn" data-warn hidden></p>
    <div class="plan-actions">
      <button type="button" class="btn primary" data-apply>Apply changes</button>
      <button type="button" class="btn" data-discard>Discard</button>
    </div>`;
  const actions = card.querySelector(".plan-actions");
  const warn = card.querySelector("[data-warn]");
  card.querySelector("[data-apply]").onclick = () => {
    const res = UI.applyChanges(proposal.changes);
    if (!res.ok) {
      warn.hidden = false;
      warn.textContent = "Could not apply: " + res.error;
      return;
    }
    card.classList.add("done");
    warn.hidden = true;
    actions.innerHTML = "";
    const done = document.createElement("span");
    done.className = "plan-done";
    done.textContent = "Changes applied";
    actions.appendChild(done);
    [...new Set(res.touched)].sort((a, b) => a - b).forEach(dayNo => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn"; b.textContent = `Open Day ${dayNo}`;
      b.onclick = () => UI.openDay(dayNo);
      actions.appendChild(b);
    });
    const mapBtn = document.createElement("button");
    mapBtn.type = "button"; mapBtn.className = "btn"; mapBtn.textContent = "Show map";
    mapBtn.onclick = () => UI.showDayOnMap(res.focus || [...new Set(res.touched)][0]);
    actions.appendChild(mapBtn);
  };
  card.querySelector("[data-discard]").onclick = () => {
    card.classList.add("discarded");
    actions.innerHTML = '<span class="plan-discard">Changes discarded.</span>';
  };
  prose.appendChild(card);
}

const MODE_INFO = { walk: ["Walk", "walk"], rail: ["Train", "rail"], bus: ["Bus", "bus"], car: ["Taxi", "car"] };
const KIND_NAME = { sight: "Sight", nature: "Nature", food: "Food", shop: "Shopping", hotel: "Stay", transport: "Transport", city: "City" };
function formatDistance(m) {
  return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";
}
function appendPlanCard(prose, plan) {
  const place = UI.P[plan.placeId];
  const day = UI.DAYS[plan.day - 1];
  if (!place || !day) return;
  const mode = planMode(plan.travelMode);
  const [modeLabel, modeIcon] = MODE_INFO[mode] || MODE_INFO.rail;
  const card = document.createElement("div");
  card.className = "plan-card";
  card.innerHTML = `
    <div class="plan-h">
      <span class="tag k-${place.kind}">${KIND_NAME[place.kind] || "Place"}</span>
      <b>${esc(plan.title)}</b>
      <span class="plan-time num">${esc(plan.start)}–${esc(plan.end)}</span>
    </div>
    ${plan.note ? `<p>${esc(plan.note)}</p>` : ""}
    <div class="plan-meta">
      <span class="mode" data-travel><img src="icons/${modeIcon}.png" alt="">${modeLabel}${plan.travelMin ? ` ${plan.travelMin} min` : ""}</span>
      <span data-dist></span>
      ${UI.live(place.id)?.rating ? `<span><span class="star">★</span> ${UI.live(place.id).rating}</span>` : ""}
      <span>${esc(place.name)}</span>
    </div>
    <p class="plan-warn" data-warn hidden></p>
    <div class="plan-actions">
      <button type="button" class="btn primary" data-add>Add to Day ${plan.day}</button>
      <button type="button" class="btn" data-view>View place</button>
    </div>`;
  const addBtn = card.querySelector("[data-add]");
  const actions = card.querySelector(".plan-actions");
  const markAdded = () => {
    addBtn.disabled = true;
    addBtn.textContent = `Added to Day ${plan.day}`;
    card.classList.add("done");
    if (!card.querySelector("[data-openday]")) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn"; b.dataset.openday = "1";
      b.textContent = `Open Day ${plan.day}`;
      b.onclick = () => UI.openDay(plan.day);
      actions.appendChild(b);
    }
  };
  const existing = day.items.find(it => it.uid && it.p === plan.placeId && it.s === plan.start && it.e === plan.end);
  if (existing) markAdded();

  addBtn.onclick = () => {
    const item = UI.addActivity(plan);
    if (!item) return;
    markAdded();
    if (slot && slot.day === plan.day) clearSlot();
  };
  card.querySelector("[data-view]").onclick = () => UI.openPeek(plan.placeId);

  // Replace the model's estimate with the real route when we know where the
  // user will be at the start of the slot.
  const anchor = slot && slot.day === plan.day ? slotData?.anchor : null;
  if (anchor && window.TripRouting && anchor.id !== plan.placeId) {
    const iso = TripRouting.zonedISO(day.date, plan.start, day.tz || D.meta.timeZone);
    TripRouting.travel(mode, { lat: anchor.lat, lng: anchor.lng }, { lat: place.lat, lng: place.lng }, iso).then(r => {
      if (!r || !card.isConnected) return;
      const travelEl = card.querySelector("[data-travel]");
      if (travelEl) travelEl.innerHTML = `<img src="icons/${modeIcon}.png" alt="">${modeLabel} ${r.minutes} min${r.approximate ? " est." : ""}`;
      const distEl = card.querySelector("[data-dist]");
      if (distEl) distEl.textContent = formatDistance(r.distance);
      if (slot) {
        const toMin = t => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
        const free = toMin(slot.end) - toMin(slot.start);
        const activity = toMin(plan.end) - toMin(plan.start);
        const warn = card.querySelector("[data-warn]");
        if (warn) {
          if (r.minutes > free) {
            warn.textContent = `Travel alone is ${r.minutes} min — longer than this ${free} min slot.`;
            warn.hidden = false;
          } else if (r.minutes + activity > free + 5) {
            warn.textContent = `Travel ${r.minutes} min plus ${activity} min there overruns this ${free} min slot.`;
            warn.hidden = false;
          }
        }
      }
    }).catch(() => {});
  }
  prose.appendChild(card);
}

function renderAnswer(el, text, final) {
  const prose = $(".prose", el);
  prose.innerHTML = UI.md(cleanForRender(text));
  if (!final) return;
  const changes = extractChanges(text);
  const plan = changes ? null : extractPlan(text);
  if (changes) appendChangeCard(prose, changes);
  else if (plan) appendPlanCard(prose, plan);
  const acts = directives(text);
  if (!acts.length) return;
  const bar = document.createElement("div"); bar.className = "msg-actions";
  for (const a of acts) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn";
    if (a.type === "map") {
      const ids = a.val.split(/[,\s]+/).filter(Boolean).filter(id => UI.P[id]?.lat);
      if (!ids.length) continue;
      b.textContent = "Show on map";
      b.onclick = () => UI.showPlacesOnMap(ids);
    } else {
      const n = parseInt(a.val, 10);
      if (!(n >= 1 && n <= UI.DAYS.length)) continue;
      b.textContent = `Open Day ${n}`;
      b.onclick = () => UI.openDay(n);
    }
    bar.appendChild(b);
  }
  if (bar.children.length) prose.appendChild(bar);
}
function scrollChat(force = false) {
  requestAnimationFrame(() => {
    if (force || msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 180) msgsEl.scrollTop = msgsEl.scrollHeight;
  });
}
function renderSeed() {
  msgsEl.innerHTML = "";
  (D.chat || []).forEach(m => addMsg(m.role === "user" ? "user" : "ai", UI.md(m.md)));
  chatLog.forEach(m => {
    const el = addMsg(m.role === "user" ? "user" : "ai", m.role === "user" ? `<p>${esc(m.content)}</p>` : "");
    if (m.role !== "user") renderAnswer(el, m.content, true);
  });
  if (chatLog.length) msgsEl.scrollTop = msgsEl.scrollHeight; else msgsEl.scrollTop = 0;
}

/* ---------- Free-slot planning ---------- */
function updateSlotBanner() {
  if (!slot) {
    slotBanner.hidden = true;
    askEl.placeholder = "Ask anything about the trip…";
    return;
  }
  const day = UI.DAYS[slot.day - 1];
  if (!day) return;
  slotBannerText.textContent = `Day ${day.d} · ${UI.fmtDay(day.date)} · ${slot.start}–${slot.end}`;
  slotBanner.hidden = false;
  askEl.placeholder = "What would you like to do in this slot?";
}
function clearSlot() {
  slot = null; slotData = null;
  updateSlotBanner();
  renderSuggestions();
}
$("#slot-clear").addEventListener("click", clearSlot);

function requestSlot({ day, start, end, prompt }) {
  slot = { day: +day, start, end };
  slotData = null;
  const q = String(prompt || "").trim() || "Suggest something that fits this time.";
  updateSlotBanner();
  renderSuggestions();
  UI.openChat();
  if (!apiKey) {
    pendingSend = q;
    flash("Add a DeepSeek key to plan this slot.");
    settingsOpen();
    return;
  }
  askEl.value = q;
  autosize();
  send();
}

function buildSlotData(prompt) {
  if (!slot) return null;
  const day = UI.DAYS[slot.day - 1];
  if (!day) return null;
  const key = `${slot.day}|${slot.start}|${slot.end}|${String(prompt).slice(0, 90).toLowerCase()}`;
  if (slotData?.key === key) return slotData;
  const timed = day.items.filter(i => !i.allDay && i.s).sort((a, b) => String(a.s).localeCompare(String(b.s)));
  const prevItem = [...timed].reverse().find(i => i.s < slot.start) || null;
  const nextItem = timed.find(i => i.s >= slot.end) || null;
  const anchorItem = [...timed].reverse().find(i => i.s < slot.start && i.p && UI.P[i.p]?.lat) || null;
  let anchor = anchorItem ? UI.P[anchorItem.p] : null;
  if (!anchor) {
    const stayId = UI.DAYS[day.d - 2]?.stay || day.stay;
    anchor = stayId ? UI.P[stayId] : null;
  }
  if (!anchor) anchor = Object.values(UI.P).find(p => p.id === day.city && p.lat) || null;

  const q = String(prompt || "").toLowerCase();
  let kinds = ["food", "nature", "sight", "shop"];
  if (/eat|lunch|dinner|breakfast|food|restaurant|sushi|ramen|coffee|cafe|tea|drink|snack|meal/.test(q)) kinds = ["food"];
  else if (/walk|park|nature|garden|stroll|hike|forest|river/.test(q)) kinds = ["nature", "sight"];
  else if (/shop|shopping|store|market|souvenir|buy/.test(q)) kinds = ["shop"];
  else if (/museum|indoor|rain|art|history|temple|shrine/.test(q)) kinds = ["sight"];

  const visited = new Set(day.items.map(i => i.p).filter(Boolean));
  if (anchor) visited.add(anchor.id);
  const pool = Object.values(UI.P)
    .filter(p => p.lat != null && kinds.includes(p.kind) && !visited.has(p.id))
    .map(p => ({ p, dist: anchor && window.TripRouting ? TripRouting.haversine(anchor, p) : 0 }))
    .sort((a, b) => a.dist - b.dist);
  let near = pool.filter(x => x.dist <= 12000);
  if (near.length < 3) near = pool;
  const candidates = near.slice(0, 9).map(({ p, dist }) => ({
    id: p.id, name: p.name, kind: p.kind, rating: p.rating,
    dist: Math.round(dist),
    walkMin: window.TripRouting ? TripRouting.estimate("walk", dist) : Math.max(1, Math.round(dist / 78)),
    transitMin: window.TripRouting ? TripRouting.estimate("rail", dist) : Math.max(1, Math.round(dist / 750 + 8)),
    desc: p.desc ? String(p.desc).slice(0, 100) : "",
  }));
  slotData = {
    key, day, anchor, anchorName: anchor?.name || day.city,
    prevItem, nextItem, nextName: nextItem?.p ? UI.P[nextItem.p]?.name : "",
    candidates, prompt: String(prompt || ""),
  };
  return slotData;
}

function slotSection() {
  if (!slot || !slotData) return "";
  const day = UI.DAYS[slot.day - 1];
  const prev = slotData.prevItem
    ? `${slotData.prevItem.t}${slotData.prevItem.e ? ` ends ${slotData.prevItem.e}` : ""}${slotData.prevItem.p ? ` at ${UI.P[slotData.prevItem.p]?.name}` : ""}`
    : "no previous item";
  const next = slotData.nextItem
    ? `${slotData.nextItem.t}${slotData.nextItem.s ? ` starts ${slotData.nextItem.s}` : ""}${slotData.nextItem.p ? ` at ${UI.P[slotData.nextItem.p]?.name}` : ""}`
    : "nothing planned after";
  const lines = slotData.candidates.length
    ? slotData.candidates.map(c => `- ${c.id} | ${c.name} | ${c.kind}${c.rating ? " | ★" + c.rating : ""} | ${(c.dist / 1000).toFixed(1)} km | walk ~${c.walkMin} min | transit ~${c.transitMin} min`).join("\n")
    : "- (no catalogue candidates nearby)";
  return `

PLANNING A FREE SLOT
Day ${day.d}, ${UI.fmtDay(day.date)}, ${slot.start}–${slot.end}. The user asked: "${slotData.prompt}".
They will be near: ${slotData.anchorName}.
Previous: ${prev}.
Next: ${next}.

Candidates (id | name | kind | rating | straight-line distance | estimated walk | estimated transit):
${lines}

Choose one place from the catalogue that best fits the request, the slot and the travel time. Prefer a short trip and a good rating; do not send them somewhere that makes them late for the next item. The travel times above are estimates; the page will calculate the real route after your answer.
Write a short recommendation (2–4 sentences) without a travel-time number in the prose; the page shows the calculated route under your answer. Then end with exactly one fenced JSON block in this shape and nothing after it:
\`\`\`json
{"day":${slot.day},"start":"${slot.start}","end":"${slot.end}","placeId":"one-of-the-ids","title":"Short activity title","note":"One practical sentence","travelMode":"walk","travelMin":8}
\`\`\`
travelMode must be walk, rail, bus or car. If you are unsure about opening hours, say so briefly. Only include this single-add block when you are recommending something to add; for any other itinerary change use the CHANGING THE ITINERARY format above. Do not repeat the place name next to a {{id}} chip in the prose.`;
}

/* ---------- Settings ---------- */
function settingsOpen() {
  TripSettings.open({
    focus: "deepseek",
    onSaved: () => {
      if (!pendingSend || !apiKey) { pendingSend = null; return; }
      const p = pendingSend;
      pendingSend = null;
      askEl.value = p;
      autosize();
      setTimeout(() => send(), 150);
    },
  });
}
addEventListener("trip-settings", () => {
  const next = TripSettings.deepseekKey();
  if (next !== apiKey) keyProblem = false;
  apiKey = next;
  model = TripSettings.model();
  updateComposer();
});
$("#chat-settings").addEventListener("click", settingsOpen);

/* ---------- Composer ---------- */
function flash(text) {
  clearTimeout(flashTimer);
  noteEl.hidden = false;
  noteEl.textContent = text;
  flashTimer = setTimeout(() => { flashTimer = null; updateComposer(); }, 5000);
}
function updateComposer() {
  const status = $("#ai-status");
  if (busy) { status.textContent = "Thinking…"; status.className = ""; }
  else if (!apiKey) { status.textContent = "Not connected"; status.className = ""; }
  else if (keyProblem) { status.textContent = "Check API key"; status.className = "warn"; }
  else { status.textContent = model; status.className = "ok"; }
  sendBtn.setAttribute("aria-label", busy ? "Stop" : "Send");
  sendBtn.innerHTML = busy
    ? '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/></svg>'
    : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>';
  if (flashTimer) return;
  noteEl.hidden = false;
  if (!apiKey) {
    noteEl.innerHTML = `Ask your own questions — <button type="button" id="connect-key">add a DeepSeek key</button>. The rest of the page works without one.`;
  } else {
    noteEl.innerHTML = `Answers via DeepSeek · ${esc(model)}. <button type="button" id="connect-key">Settings</button>`;
  }
  $("#connect-key")?.addEventListener("click", settingsOpen);
}
function autosize() { askEl.style.height = "auto"; askEl.style.height = Math.min(140, askEl.scrollHeight) + "px"; }
askEl.addEventListener("input", autosize);
askEl.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (busy) controller?.abort(); else send(); } });
$("#composer").addEventListener("submit", e => { e.preventDefault(); if (busy) controller?.abort(); else send(); });

const SUGGEST = [
  "What if it rains?",
  "Is any day too packed?",
  `Where should we eat on Day ${Math.min(2, UI.DAYS.length)}?`,
  "What should we pack?",
];
const SUGGEST_SLOT = ["Eat somewhere local", "Walk in a park", "Coffee and a sit-down", "Something indoors"];
function renderSuggestions() {
  const list = slot ? SUGGEST_SLOT : SUGGEST;
  $("#suggest").innerHTML = list.map(s => `<button type="button">${esc(s)}</button>`).join("");
}
$("#suggest").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || busy) return;
  askEl.value = b.textContent;
  autosize();
  if (!apiKey) { settingsOpen(); return; }
  send();
});
renderSuggestions();

/* ---------- Prompt ---------- */
function systemPrompt() {
  const cat = Object.values(UI.P).map(p =>
    `${p.id} | ${p.name} | ${p.kind}${p.suggested ? " (suggested restaurant)" : ""} | ${p.city || ""}`).join("\n");
  const days = D.days.map(d => `Day ${d.d} (${UI.fmtDay(d.date)}) — ${d.title}${d.stay ? " — stay: " + d.stay : ""}\n` +
    d.items.map(i => `  ${i.sid || "?"} | ${i.allDay ? "all day" : i.s + "–" + i.e} | ${i.t}${i.p ? " [" + i.p + "]" : ""}${i.added ? " [added]" : ""}`).join("\n")).join("\n");
  const m = D.meta;
  return `You are the trip assistant inside a private trip-planning page: "${m.title}", ${UI.fmtDay(m.start)} – ${UI.fmtDay(m.end)} ${m.end.slice(0, 4)} (${m.days} days), ${m.routeLine || ""}.
What the traveller told us:
${D.profile || "(no profile)"}
Answer their questions about this trip: helpful, concise (usually under 180 words), plain markdown (short paragraphs, "- " bullets, **bold**, at most one small table). No emoji.
${m.budget ? `The estimated cost is ${m.budget}${m.budgetNote ? ` (${m.budgetNote})` : ""}. Be honest about money if they ask.` : ""}

Place mentions are interactive on the page:
- When you mention a place from the catalogue below, write it ONLY as {{id}} (for example {{fushimi-inari}}); the page shows its name and photos. Never write its name next to the tag.
- For any other real place (a restaurant, shop or sight not in the catalogue), write {{new:Exact Name|City}} so the page can link it to Google Maps. Only name places you are confident exist.
- To offer map pins, end your answer with one line [[map:id1,id2]] using catalogue ids. To offer to jump to a day, add a line [[day:N]]. Use these only when useful.
If something is uncertain or time-sensitive (prices, opening hours, tickets), say so briefly.

CHANGING THE ITINERARY
CURRENT ITINERARY below is the live plan. The long plan text is the original and may be out of date after edits; when they differ, follow CURRENT ITINERARY.
You can propose changes, but you must never say a change is done: the page shows a confirmation card and the user must approve it. Never perform or promise a silent edit.
When the user asks for a concrete change, end your answer with one fenced JSON block in this shape:
\`\`\`json
{"summary":"Short description","changes":[
  {"op":"add","day":4,"start":"16:00","end":"17:00","placeId":"catalogue-id","title":"Short title","note":"One sentence","travelMode":"walk"},
  {"op":"move","sid":"ITEM_SID","day":4,"start":"14:00","end":"15:00"},
  {"op":"edit","sid":"ITEM_SID","title":"New title","note":"New note","start":"14:00","end":"15:00"},
  {"op":"remove","sid":"ITEM_SID"}
]}
\`\`\`
- Copy sids exactly from CURRENT ITINERARY (the first field on each line). Never invent a sid.
- add: day, start, end, placeId from the catalogue, title, optional note, travelMode walk|rail|bus|car.
- move: sid, target day, new start/end.
- edit: sid plus the fields to change (title, note, start, end, optional placeId).
  If you change the airport, station or venue named in the title (for example Narita → Haneda), you must also set its catalogue placeId; never change only the wording.
- remove: sid.
- Use several entries in one changes array when the request changes several things.
- Only use this block for a requested change, never for a question. If the request is ambiguous or would obviously break the plan, ask first and do not include the block.
- When a free slot is selected, the slot instructions below take precedence for adding something to that slot.

PLACE CATALOGUE (id | name | kind | region | Google rating):
${cat}

CURRENT ITINERARY:
${days}

THE TRIP PLAN (markdown):
${D.plan || ""}${slot ? slotSection() : ""}`;
}

/* ---------- Errors ---------- */
function friendlyError(err) {
  if (err?.name === "AbortError") return "";
  if (err?.status === 401) return "DeepSeek rejected that API key. Check it in Settings.";
  if (err?.status === 402) return "This DeepSeek account is out of credit. Top up at platform.deepseek.com.";
  if (err?.status === 400) return "DeepSeek could not answer that request." + (err.message ? " " + err.message : "");
  if (err?.status === 429) return "DeepSeek is rate-limiting requests. Wait a moment and try again.";
  if (err?.status >= 500) return "DeepSeek is having a problem right now. Try again in a minute.";
  if (err instanceof TypeError) return "Could not reach api.deepseek.com. Check your connection and try again.";
  return err?.message || "Something went wrong reaching DeepSeek. Try again.";
}
async function readError(res) {
  let detail = "";
  try { const j = await res.json(); detail = j?.error?.message || j?.message || ""; } catch {}
  const e = new Error(detail); e.status = res.status; return e;
}

/* ---------- Send ---------- */
async function send() {
  const q = askEl.value.trim();
  if (!q || busy) return;
  if (!apiKey) { settingsOpen(); return; }
  if (slot) {
    try { slotData = buildSlotData(q); updateSlotBanner(); }
    catch { slotData = null; }
  }
  askEl.value = ""; autosize();

  const userEl = addMsg("user", `<p>${esc(q)}</p>`);
  chatLog.push({ role: "user", content: q });
  saveChat();
  scrollChat(true);

  const el = addMsg("ai", '<p class="thinking">Thinking</p>');
  const prose = $(".prose", el);
  let text = "", reasoning = "", truncated = false, raf = 0, finished = false;
  const paint = () => {
    if (raf || finished) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (finished) return;
      prose.innerHTML = UI.md(cleanForRender(text));
      scrollChat();
    });
  };

  busy = true; updateComposer();
  controller = new AbortController();

  try {
    const context = [
      { role: "system", content: systemPrompt() },
      ...chatLog.slice(-12).map(m => ({ role: m.role, content: m.role === "assistant" ? cleanForRender(m.content) : m.content })),
    ];
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({ model, messages: context, stream: true, ...(model === "deepseek-v4-pro" ? { max_tokens: 6000 } : { thinking: { type: "disabled" }, temperature: 0.4, max_tokens: 1600 }) }),
      signal: controller.signal,
    });
    if (!res.ok) throw await readError(res);
    if (!res.body) throw new Error("This browser could not read DeepSeek's stream.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", done = false;
    while (!done) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { done = true; break; }
        try {
          const j = JSON.parse(data);
          if (j.error) { const e = new Error(j.error.message || ""); e.status = j.error.code; throw e; }
          const choice = j.choices?.[0];
          const delta = choice?.delta;
          if (delta?.reasoning_content) {
            reasoning += delta.reasoning_content;
            if (!text) prose.innerHTML = '<p class="thinking">Thinking it through</p>';
          }
          if (delta?.content) {
            text += delta.content;
            paint();
          }
          if (choice?.finish_reason === "length") truncated = true;
        } catch (err) { if (err?.status) throw err; /* ignore keep-alive fragments */ }
      }
    }
    finished = true;
    cancelAnimationFrame(raf);
    if (!text.trim()) {
      el.remove();
      chatLog.pop(); saveChat();
      flash("DeepSeek returned an empty answer. Try asking again.");
      return;
    }
    renderAnswer(el, text, true);
    if (truncated) prose.insertAdjacentHTML("beforeend", '<p class="err">The answer was cut short. Ask for less at a time.</p>');
    chatLog.push({ role: "assistant", content: text });
    saveChat();
    scrollChat(true);
  } catch (err) {
    finished = true;
    cancelAnimationFrame(raf);
    const msg = friendlyError(err);
    if (err?.status === 401) { keyProblem = true; updateComposer(); }
    if (msg) {
      if (text.trim()) {
        renderAnswer(el, text, true);
        prose.insertAdjacentHTML("beforeend", `<p class="err">${esc(msg)}</p>`);
        chatLog.push({ role: "assistant", content: text });
        saveChat();
      } else {
        prose.innerHTML = `<p class="err">${esc(msg)}</p>`;
        chatLog.pop(); saveChat();
      }
    } else {
      // stopped by the user
      if (text.trim()) {
        renderAnswer(el, text, true);
        prose.insertAdjacentHTML("beforeend", '<p class="err">Stopped.</p>');
        chatLog.push({ role: "assistant", content: text });
        saveChat();
      } else {
        el.remove();
        chatLog.pop(); saveChat();
      }
    }
    scrollChat();
  } finally {
    busy = false; controller = null; updateComposer();
  }
}

/* ---------- Boot ---------- */
renderSeed();
updateComposer();
if (apiKey) $("#ai-status").classList.add("ok");
addEventListener("storage", e => {
  if (e.key === TripSettings.K_DS) {
    apiKey = TripSettings.deepseekKey();
    updateComposer();
  }
});
window.TripAssistant = { openSettings: settingsOpen, requestSlot, clearSlot };
})();
