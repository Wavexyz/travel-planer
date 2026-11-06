"use strict";
/* Trip page — itinerary, calendar, map, place panels for the active trip. */
(() => {
const D = window.TRIP_DATA;
if (!D) return;
const P = D.places, DAYS = D.days, META = D.meta;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
function sortDayItems(a, b) {
  if (a.allDay && !b.allDay) return -1;
  if (!a.allDay && b.allDay) return 1;
  return String(a.s || "").localeCompare(String(b.s || ""));
}
function assignSids() {
  for (const day of DAYS) {
    day.items.forEach((it, i) => {
      if (!it.sid) it.sid = it.uid || `d${day.d}i${i + 1}`;
      if (it.added && !it.uid) it.uid = it.sid;
    });
  }
}
/* The trip (including every edit) is saved with TripStore. */
function savePlan() {
  window.TripStore.save(D);
  markEdited();
}
function markEdited(when = new Date()) {
  const el = document.querySelector(".edited");
  if (!el) return;
  const d = when instanceof Date ? when : new Date(when);
  if (isNaN(d)) return;
  el.textContent = "Edited " + d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function loadPlan() {
  for (const day of DAYS) {
    day.items = (day.items || []).filter(it => it && typeof it.t === "string");
    day.items.forEach(it => { if (it.p && !P[it.p]) delete it.p; });
    day.items.sort(sortDayItems);
  }
  assignSids();
  markEdited(D.updatedAt || Date.now());
}
loadPlan();

const isPhone = () => matchMedia("(max-width: 1000px)").matches;
const isWideMap = () => matchMedia("(min-width: 1380px)").matches;
const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
const pageEl = $("#page");

/* ---------- Dates & lookups ---------- */
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dateOf = iso => new Date(iso + "T12:00:00");
const fmtDay = iso => { const d = dateOf(iso); return `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`; };
const fmtDayShort = iso => { const d = dateOf(iso); return `${WD[d.getDay()]} ${d.getDate()}`; };
const toMin = t => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
const KIND_LABEL = { sight: "Sight", nature: "Nature", food: "Food", hotel: "Stay", shop: "Shopping", transport: "Transport", city: "City" };
const ICON = {
  sight: '<path d="M3 7h18M5 4h14M7 7v13M17 7v13M5 11h14"/>',
  nature: '<path d="M5 19c0-8 6-13 14-14-1 8-6 14-14 14zM5 19l7-7"/>',
  food: '<path d="M4 11h16a8 8 0 0 1-16 0zM9 4v4M15 4v4"/>',
  hotel: '<path d="M3 18v-8M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5M7 12h.01"/>',
  shop: '<path d="M6 8h12l-1 12H7zM9 8a3 3 0 0 1 6 0"/>',
  transport: '<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 11h12M9 21l1-4M15 21l-1-4"/>',
  city: '<path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  new: '<path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/>',
};
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ICON.city}</svg>`;
const ARROW = { l: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>', r: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>' };
const fmtCount = n => n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
const ratingHtml = p => p.rating ? `<span class="num"><span class="star">★</span> ${p.rating}${p.reviews ? ` (${fmtCount(p.reviews)})` : ""}</span>` : "";
const kindTag = p => `<span class="tag k-${p.kind}">${KIND_LABEL[p.kind] || "Place"}</span>`;
const gmapsUrl = p => p.url || (p.placeId
  ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.gname || p.name)}&query_place_id=${p.placeId}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}`);

/* ---------- Live place details ----------
   The trip stores a place's name, kind, coordinates and Google id. Photos,
   rating, address and reviews come from Google for this session only. */
function live(pid) {
  const p = P[pid];
  if (!p) return null;
  const g = window.TripGoogle?.cachedDetails(p.placeId);
  if (!g) return { ...p, photos: [], thumbs: [], credits: [] };
  return {
    ...p, gname: g.gname, address: g.address, rating: g.rating, reviews: g.reviews, types: g.types, url: g.url,
    desc: g.desc || "", quotes: g.quotes || [],
    photos: g.photos.map(ph => TripGoogle.photoUrl(ph, 1200)),
    thumbs: g.photos.map(ph => TripGoogle.photoUrl(ph, 240)),
    credits: g.photos.map(ph => ph.author),
  };
}
function ensurePlace(pid, full = false) {
  const p = P[pid];
  if (!p || !window.TripGoogle?.hasKey()) return Promise.resolve(null);
  return TripGoogle.details(p, { full }).then(g => {
    // A place found by name keeps its Google id, so the next session goes straight to it.
    if (g?.placeId && !p.placeId) { p.placeId = g.placeId; savePlan(); }
    return g;
  }).catch(() => null);
}
const thumbHtml = (pid, kind) => {
  const l = live(pid);
  return l?.thumbs[0]
    ? `<img class="thumb" src="${esc(l.thumbs[0])}" alt="" loading="lazy" decoding="async" data-pid="${esc(pid)}" title="Show ${esc(l.name)}">`
    : `<div class="thumb none" data-thumb="${esc(pid)}" aria-hidden="true">${icon(kind)}</div>`;
};
const ratingSlot = pid => {
  const l = live(pid);
  return l?.rating ? ratingHtml(l) : `<span data-rating="${esc(pid)}" hidden></span>`;
};
/* Fetch details only for rows that scroll into view. */
const placeObserver = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    placeObserver.unobserve(e.target);
    const pid = e.target.dataset.thumb;
    ensurePlace(pid).then(() => paintPlace(pid));
  }
}, { rootMargin: "300px" }) : null;
function hydrate(root) {
  if (!placeObserver || !window.TripGoogle?.hasKey()) return;
  $$(".thumb.none[data-thumb]", root).forEach(el => placeObserver.observe(el));
}
function paintPlace(pid) {
  const l = live(pid);
  if (!l) return;
  const sel = CSS.escape(pid);
  if (l.thumbs[0]) $$(`.thumb.none[data-thumb="${sel}"]`).forEach(el => { el.outerHTML = thumbHtml(pid); });
  if (l.rating) $$(`[data-rating="${sel}"]`).forEach(el => { el.outerHTML = ratingHtml(l); });
}

/* ---------- Trip header ---------- */
function renderHead() {
  const s = dateOf(META.start), e = dateOf(META.end);
  const sameYear = s.getFullYear() === e.getFullYear();
  const dates = `${WD[s.getDay()]} ${s.getDate()} ${MON[s.getMonth()]}${sameYear ? "" : " " + s.getFullYear()} – ${WD[e.getDay()]} ${e.getDate()} ${MON[e.getMonth()]} ${e.getFullYear()}`;
  document.title = `${META.title} · ${dates}`;
  $("#trip-crumb").textContent = `${META.emoji ? META.emoji + " " : ""}${META.title}`;
  $("#trip-version").textContent = META.version || "";
  $("#trip-version").hidden = !META.version;
  $("#trip-title").textContent = META.title;
  $("#trip-dates").innerHTML = `${esc(dates)} <span class="tm-sub">${META.days} day${META.days === 1 ? "" : "s"}, ${META.nights} night${META.nights === 1 ? "" : "s"}</span>`;
  $("#trip-route").textContent = META.routeLine || (META.route || []).join(" · ");
  $("#trip-budget").innerHTML = META.budget ? `${esc(META.budget)}${META.budgetNote ? ` <span class="tm-sub warn">${esc(META.budgetNote)}</span>` : ""}` : "";
  $("#trip-budget-row").hidden = !META.budget;
}

let VISITS = {};
function indexVisits() {
  VISITS = {};
  DAYS.forEach(day => day.items.forEach((it, i) => { if (it.p) (VISITS[it.p] ||= []).push({ day, it, i }); }));
}
indexVisits();
const kindOf = it => P[it.p]?.kind || it.c || "city";
function prevStop(pid) {
  const v = VISITS[pid]?.[0]; if (!v) return null;
  for (let i = v.i - 1; i >= 0; i--) { const q = v.day.items[i].p; if (q && q !== pid && P[q]?.lat) return P[q]; }
  const prevDay = DAYS[v.day.d - 2]; return prevDay?.stay ? P[prevDay.stay] : null;
}

/* ---------- Mini markdown with place mentions ---------- */
function chip(id) {
  const p = P[id];
  if (!p) return esc(id);
  return `<span role="button" tabindex="0" class="chip k-${p.kind}" data-pid="${esc(id)}" title="Show ${esc(p.name)}">${icon(p.kind)}${esc(p.name)}</span>`;
}
function newChip(name, city) {
  const q = encodeURIComponent(name + (city ? ", " + city : ""));
  return `<a class="chip k-new" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener" title="Open in Google Maps">${icon("new")}${esc(name)}</a>`;
}
function inline(s) {
  return esc(s)
    .replace(/\{\{new:([^|}]+)(?:\|([^}]*))?\}\}/g, (_, n, c) => newChip(n.trim(), (c || "").trim()))
    .replace(/\{\{([a-z0-9-]+)\}\}/g, (_, id) => chip(id))
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
function md(src) {
  const lines = String(src ?? "").replace(/\r/g, "").split("\n"), out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^#{1,4}\s/.test(l)) { out.push(`<h3>${inline(l.replace(/^#+\s/, ""))}</h3>`); i++; continue; }
    if (/^\s*\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const head = cells(rows[0]), align = rows[1] && /^[\s|:-]+$/.test(rows[1]) ? cells(rows[1]).map(c => c.endsWith(":") ? "r" : "") : null;
      const body = rows.slice(align ? 2 : 1);
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c, j) => `<th class="${align?.[j] || ""}">${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map(r => `<tr>${cells(r).map((c, j) => `<td class="${align?.[j] || ""}">${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s/.test(l)) {
      const ordered = /^\s*\d+\./.test(l), items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s/, ""));
      out.push(`<${ordered ? "ol" : "ul"}>${items.map(t => `<li>${inline(t)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("");
}

/* ---------- Photo gallery (hover preview) ---------- */
function galleryHtml(p) {
  const ph = p.photos || [];
  if (!ph.length) return "";
  return `<div class="gal">
    <div class="strip">${ph.map((s, i) => `<img src="${esc(s)}" alt="${esc(p.name)} photo ${i + 1}" loading="lazy" decoding="async" data-i="${i}">`).join("")}</div>
    ${ph.length > 1 ? `<button type="button" class="nav prev" aria-label="Previous photo" hidden>${ARROW.l}</button><button type="button" class="nav next" aria-label="Next photo">${ARROW.r}</button>` : ""}
    <span class="count num">1 / ${ph.length}</span>
    ${ph.length > 1 ? `<div class="thumbs">${p.thumbs.map((s, i) => `<img src="${esc(s)}" alt="" data-i="${i}" class="${i ? "" : "on"}">`).join("")}</div>` : ""}
  </div>`;
}
function wireGallery(root, p) {
  const strip = $(".strip", root); if (!strip) return;
  const n = p.photos.length;
  const idx = () => Math.round(strip.scrollLeft / strip.clientWidth);
  const go = i => strip.scrollTo({ left: Math.max(0, Math.min(n - 1, i)) * strip.clientWidth, behavior: "smooth" });
  const sync = () => {
    const i = idx();
    const count = $(".count", root);
    if (count) count.textContent = `${i + 1} / ${n}`;
    $$(".thumbs img", root).forEach((t, j) => t.classList.toggle("on", j === i));
    const pv = $(".prev", root), nx = $(".next", root);
    if (pv) pv.hidden = i === 0;
    if (nx) nx.hidden = i === n - 1;
  };
  strip.addEventListener("scroll", () => requestAnimationFrame(sync), { passive: true });
  $(".prev", root)?.addEventListener("click", e => { e.stopPropagation(); go(idx() - 1); });
  $(".next", root)?.addEventListener("click", e => { e.stopPropagation(); go(idx() + 1); });
  $$(".thumbs img", root).forEach(t => t.addEventListener("click", e => { e.stopPropagation(); go(+t.dataset.i); }));
  $$(".strip img", root).forEach(im => im.addEventListener("click", e => { e.stopPropagation(); openLightbox(p.id, +im.dataset.i); }));
}

/* ---------- Hover preview ---------- */
const pop = $("#pop");
let popTimer, popHide, popFor = null;
function renderPop(p) {
  const q = p.quotes?.[0];
  pop.innerHTML = `${galleryHtml(p)}
    <div class="body">
      <h3>${esc(p.name)}</h3>
      <div class="meta">${kindTag(p)}${p.suggested ? '<span class="tag sug">Suggestion</span>' : ""}${ratingHtml(p)}${p.types?.[0] ? `<span>${esc(p.types[0])}</span>` : ""}</div>
      ${p.desc ? `<p>${esc(p.desc)}</p>` : ""}
      ${q ? `<q>${esc(q.t)}</q>` : ""}
      <div class="btns">
        <button type="button" class="btn primary" data-act="details">Open</button>
        ${p.lat ? '<button type="button" class="btn" data-act="map">Show on map</button>' : ""}
        <a class="btn" href="${gmapsUrl(p)}" target="_blank" rel="noopener">Google Maps ↗</a>
      </div>
    </div>`;
  wireGallery(pop, p);
  $('[data-act="details"]', pop).onclick = () => { hidePop(); openPeek(p.id); };
  const mb = $('[data-act="map"]', pop); if (mb) mb.onclick = () => { hidePop(); showPlaceOnMap(p.id); };
}
function showPop(anchor, pid) {
  const p = live(pid); if (!p) return;
  clearTimeout(popHide);
  if (popFor === anchor && !pop.hidden) return;
  $$(".chip.on").forEach(c => c.classList.remove("on"));
  anchor.classList?.add("on");
  popFor = anchor; renderPop(p); pop.hidden = false;
  placePop(anchor);
  if (!TripGoogle.cachedDetails(P[pid].placeId)) {
    ensurePlace(pid).then(g => {
      if (g && popFor === anchor && !pop.hidden) { renderPop(live(pid)); placePop(anchor); }
    });
  }
}
function placePop(anchor) {
  if (isPhone()) { $("#scrim").hidden = false; return; }
  const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  const x = Math.min(Math.max(8, r.left), innerWidth - w - 8);
  let y = r.bottom + 6; if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
  pop.style.left = x + "px"; pop.style.top = y + "px";
}
function hidePop() {
  pop.hidden = true; popFor?.classList?.remove("on"); popFor = null;
  if (!$("#peek").classList.contains("open")) $("#scrim").hidden = true;
}
document.addEventListener("pointerover", e => {
  if (!finePointer) return;
  const a = e.target.closest("[data-pid]");
  if (a && !a.closest("#pop, #peek")) { clearTimeout(popTimer); popTimer = setTimeout(() => showPop(a, a.dataset.pid), 300); }
  else if (e.target.closest("#pop")) clearTimeout(popHide);
});
document.addEventListener("pointerout", e => {
  if (!finePointer) return;
  const a = e.target.closest("[data-pid], #pop");
  if (!a || a.closest("#peek")) return;
  if (e.relatedTarget && (a.contains(e.relatedTarget) || e.relatedTarget.closest?.("#pop"))) return;
  clearTimeout(popTimer); popHide = setTimeout(hidePop, 250);
});
document.addEventListener("click", e => {
  const a = e.target.closest("[data-pid]");
  if (a && !a.closest("#pop")) {
    if (a.closest(".cal-wrap")) return; // calendar has its own handler
    e.preventDefault(); clearTimeout(popTimer);
    if (a.closest("#peek")) { openPeek(a.dataset.pid); return; }
    if (popFor === a && !pop.hidden) { hidePop(); openPeek(a.dataset.pid); } else showPop(a, a.dataset.pid);
    return;
  }
  if (!e.target.closest("#pop, #lb, #peek")) hidePop();
});

/* ---------- Lightbox ---------- */
let lbPlace = null, lbIdx = 0, lbReturnFocus = null;
function openLightbox(pid, i) {
  const p = live(pid); if (!p?.photos?.length) return;
  lbPlace = p; lbReturnFocus = document.activeElement;
  hidePop();
  $("#lb-title").textContent = p.name;
  $("#lb-strip").innerHTML = p.thumbs.map((s, j) => `<img src="${esc(s)}" alt="" data-i="${j}" ${j === i ? 'class="on"' : ""}>`).join("");
  $$("#lb-strip img").forEach(t => t.onclick = () => lbShow(+t.dataset.i));
  $("#lb").hidden = false; lbShow(i);
  $("#lb-close").focus();
}
function lbShow(i) {
  const n = lbPlace.photos.length; lbIdx = (i + n) % n;
  const im = $("#lb-img");
  im.src = lbPlace.photos[lbIdx]; im.alt = `${lbPlace.name} photo ${lbIdx + 1}`;
  $("#lb-count").textContent = `${lbIdx + 1} / ${n}${lbPlace.credits[lbIdx] ? " · Photo: " + lbPlace.credits[lbIdx] : ""}`;
  $$("#lb-strip img").forEach((t, j) => t.classList.toggle("on", j === lbIdx));
  $("#lb-prev").hidden = $("#lb-next").hidden = n < 2;
  const pre = lbPlace.photos[(lbIdx + 1) % n]; if (n > 1 && pre) { const x = new Image(); x.src = pre; }
}
const lbGo = d => lbShow(lbIdx + d);
function closeLightbox() { $("#lb").hidden = true; lbPlace = null; lbReturnFocus?.focus?.(); lbReturnFocus = null; }
$("#lb-prev").onclick = () => lbGo(-1); $("#lb-next").onclick = () => lbGo(1); $("#lb-close").onclick = closeLightbox;
$("#lb").addEventListener("click", e => { if (e.target.id === "lb" || e.target.classList.contains("lb-stage")) closeLightbox(); });
{
  let tx = null;
  $("#lb").addEventListener("touchstart", e => { tx = e.touches[0].clientX; }, { passive: true });
  $("#lb").addEventListener("touchend", e => {
    if (tx === null) return;
    const dx = e.changedTouches[0].clientX - tx; tx = null;
    if (Math.abs(dx) > 50) lbGo(dx < 0 ? 1 : -1);
  }, { passive: true });
}

/* ---------- Side peek ---------- */
let peekFor = null, peekReturnFocus = null;
function openPeek(pid, opts = {}) {
  if (!P[pid]) return;
  hidePop();
  if (!peekFor) peekReturnFocus = document.activeElement;
  peekFor = pid;
  renderPeek(pid);
  $("#peek-body").scrollTop = 0;
  $("#peek").classList.add("open"); $("#peek").setAttribute("aria-hidden", "false");
  $("#scrim").hidden = false;
  if (opts.hash !== false) setHash("place-" + pid);
  if (!isPhone()) $("#peek-close").focus();
  if (!TripGoogle.cachedDetails(P[pid].placeId)?.full) {
    ensurePlace(pid, true).then(g => { if (g && peekFor === pid) renderPeek(pid); });
  }
}
function renderPeek(pid) {
  const p = live(pid);
  const ph = p.photos, prev = prevStop(pid);
  const dir = p.lat && prev?.lat ? `https://www.google.com/maps/dir/?api=1&origin=${prev.lat},${prev.lng}&destination=${encodeURIComponent(p.gname || p.name)}${p.placeId ? "&destination_place_id=" + p.placeId : ""}&travelmode=transit` : null;
  const prop = (label, val) => val ? `<div class="prop"><div class="pk">${label}</div><div class="pv">${val}</div></div>` : "";
  $("#peek-gmaps").href = gmapsUrl(p);
  $("#peek-body").innerHTML = `
    ${ph.length ? `<div class="peek-cover ${ph.length === 1 ? "n1" : ph.length === 2 ? "n2" : ""}">${ph.slice(0, 3).map((s, i) => `<img src="${esc(s)}" alt="${esc(p.name)} photo ${i + 1}" ${i ? 'loading="lazy"' : ""} decoding="async" data-i="${i}">`).join("")}</div>` : ""}
    <div class="peek-in">
      <h2>${esc(p.name)}</h2>
      <div class="props">
        ${prop("Type", kindTag(p) + (p.suggested ? '<span class="tag sug">Suggestion</span>' : "") + (p.types || []).map(t => `<span class="tag">${esc(t)}</span>`).join(""))}
        ${prop("Rating", p.rating ? ratingHtml(p) + " on Google" : "")}
        ${prop("Address", p.address ? esc(p.address) : "")}
        ${prop("Google Maps", `<a href="${gmapsUrl(p)}" target="_blank" rel="noopener">Open ↗</a>${dir ? ` · <a href="${dir}" target="_blank" rel="noopener">Transit from ${esc(prev.name)} ↗</a>` : ""}`)}
        ${prop("On your trip", (VISITS[pid] || []).map(v => `<button type="button" class="visit" data-day-visit="${v.day.d}"><b>Day ${v.day.d}</b><span>${fmtDay(v.day.date)}${v.it.s ? " · " + v.it.s : ""}</span></button>`).join(""))}
      </div>
      ${p.desc ? `<p style="margin:4px 0 0">${esc(p.desc)}</p>` : ""}
      ${ph.length > 1 ? `<h4>Photos <span style="color:var(--faint);font-weight:400">${ph.length}</span></h4><div class="photos">${p.thumbs.map((s, i) => `<img src="${esc(s)}" alt="${esc(p.name)} photo ${i + 1}" loading="lazy" decoding="async" data-i="${i}">`).join("")}</div>` : ""}
      ${p.quotes?.length ? `<h4>What visitors say</h4>${p.quotes.map(q => `<div class="quote">${esc(q.t)}<small><span class="star">${"★".repeat(q.r || 0)}</span> ${esc(q.a || "Google review")}${q.d ? " · " + esc(q.d) : ""}</small></div>`).join("")}<div><a class="btn" href="${gmapsUrl(p)}" target="_blank" rel="noopener">All ${p.reviews ? fmtCount(p.reviews) + " " : ""}reviews on Google ↗</a></div>` : ""}
      ${p.lat ? '<div><button type="button" class="btn" id="peek-map">Show on map</button></div>' : ""}
      <div class="foot">${TripGoogle.hasKey() ? `Photos, rating and reviews: Google Maps${p.credits.length ? ` · Photos by ${esc([...new Set(p.credits.filter(Boolean))].slice(0, 3).join(", "))}` : ""}` : "Add a Google Maps key in Settings to see photos, ratings and reviews."}</div>
    </div>`;
  $$("#peek-body img[data-i]").forEach(im => im.onclick = () => openLightbox(pid, +im.dataset.i));
  $("#peek-map")?.addEventListener("click", () => { closePeek(); showPlaceOnMap(pid); });
  $$("#peek-body .visit").forEach(b => b.onclick = () => { closePeek(); openDay(+b.dataset.dayVisit); });
}
function closePeek(opts = {}) {
  $("#peek").classList.remove("open"); $("#peek").setAttribute("aria-hidden", "true");
  if (pop.hidden) $("#scrim").hidden = true;
  peekFor = null;
  if (opts.hash !== false && currentTab) setHash(currentTab === "itinerary" ? "day-" + itinDay : currentTab);
  peekReturnFocus?.focus?.(); peekReturnFocus = null;
}
$("#peek-close").onclick = () => closePeek();
$("#scrim").onclick = () => { hidePop(); closePeek(); };

/* ---------- Views ---------- */
let currentTab = "itinerary";
function setTab(tab, opts = {}) {
  if (!["itinerary", "calendar", "map"].includes(tab)) tab = "itinerary";
  if (currentTab !== tab && $("#peek").classList.contains("open")) closePeek({ hash: false });
  currentTab = tab;
  $$(".view").forEach(t => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
  ["itinerary", "calendar", "map"].forEach(n => $("#pane-" + n).hidden = n !== tab);
  $("#view-note").textContent = tab === "calendar" ? "Times are suggestions, except fixed ones from the plan" : tab === "map" ? (isPhone() ? "Tap a pin or a day to explore" : "Click a pin or a day to explore") : "";
  if (tab === "map") { mountMap("#slot-map"); renderMapFor(mapDay); }
  if (tab === "itinerary" && isWideMap()) { mountMap("#slot-itin"); renderMapFor(itinDay); }
  if (tab === "calendar") renderCalendar();
  if (tab !== "itinerary") pageEl.scrollTop = 0;
  setView(tab);
  if (opts.hash !== false) setHash(tab);
  if (opts.focus) $("#tab-" + tab).focus();
}
function setView(v) {
  document.body.dataset.view = v;
  $$("#mobilebar button").forEach(b => {
    if (b.dataset.view === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
}
$$(".view").forEach(t => t.onclick = () => { setTab(t.dataset.tab); store.set("trip-tab", t.dataset.tab); });
$$("#mobilebar button").forEach(b => b.onclick = () => {
  if (b.dataset.view === "chat") setView("chat"); else setTab(b.dataset.view);
});
/* Left/right arrows move between tabs when the tablist has focus. */
$(".views").addEventListener("keydown", e => {
  if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const tabs = $$(".view");
  const i = tabs.findIndex(t => t.getAttribute("aria-selected") === "true");
  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
  e.preventDefault(); setTab(next.dataset.tab, { focus: true });
});

/* ---------- Itinerary ---------- */
let itinDay = 1, mapDay = 0;
function dayChips(el, withTrip, onPick) {
  el.innerHTML = (withTrip ? `<button type="button" class="daychip" data-day="0">Whole trip</button>` : "") +
    DAYS.map(d => `<button type="button" class="daychip num" data-day="${d.d}">${fmtDayShort(d.date)}</button>`).join("");
  el.onclick = e => { const b = e.target.closest(".daychip"); if (b) onPick(+b.dataset.day); };
}
function markChip(el, n) {
  $$(".daychip", el).forEach(c => c.classList.toggle("on", +c.dataset.day === n));
  const on = $(`.daychip[data-day="${n}"]`, el);
  if (on) el.scrollTo({ left: on.offsetLeft - el.clientWidth / 2 + on.clientWidth / 2, behavior: "smooth" });
}
function renderItinerary() {
  $("#itin-list").innerHTML = DAYS.map(day => {
    const items = day.items.map(it => {
      const p = P[it.p] || {};
      const ytag = it.k ? `<span class="tag y-${String(it.k).toLowerCase().replace(/\s+/g, "-")}">${esc(it.k)}</span>` : "";
      return `${it.tr ? `<div class="leg">${icon("transport")}<span>${esc(it.tr)}</span></div>` : ""}
      <div class="row" data-sid="${it.sid ? esc(it.sid) : ""}">
        <div class="t">${it.allDay ? "<b>All day</b>" : `<b>${it.approx ? "~" : ""}${it.s}</b>${it.e}`}</div>
        ${it.p ? thumbHtml(it.p, kindOf(it)) : `<div class="thumb none" aria-hidden="true">${icon(kindOf(it))}</div>`}
        <div style="min-width:0">
          <h3>${esc(it.t)}</h3>
          <div class="meta">${ytag}${it.p ? chip(it.p) + ratingSlot(it.p) : ""}${p.suggested ? '<span class="tag sug">Suggestion</span>' : ""}${it.added ? `<span class="tag added">Added</span><button type="button" class="added-x" data-remove="${esc(it.sid)}" aria-label="Remove ${esc(it.t)}" title="Remove this added activity">×</button>` : ""}</div>
          ${it.n ? `<p>${esc(it.n)}</p>` : ""}
        </div>
      </div>`;
    }).join("");
    return `<details class="day" id="day-${day.d}" data-day="${day.d}" open>
      <summary><span class="tri" aria-hidden="true">${ARROW.r}</span><h2>${esc(day.title)}</h2><span class="when">Day ${day.d} · ${fmtDay(day.date)}${day.city && P[day.city] ? `<b>${esc(P[day.city].name)}</b>` : ""}</span></summary>
      <div class="day-body">
        ${day.purpose ? `<p class="purpose">${esc(day.purpose)}</p>` : ""}
        ${day.stay ? `<div class="callout"><span class="emo" aria-hidden="true">${icon("hotel")}</span><div>Tonight: ${chip(day.stay)}</div></div>` : ""}
        ${items}
        ${planB(day)}
      </div>
    </details>`;
  }).join("");
  dayChips($("#itin-days"), false, n => openDay(n));
  markChip($("#itin-days"), itinDay);
  hydrate($("#itin-list"));
}
{
  let raf;
  pageEl.addEventListener("scroll", () => {
    if (currentTab !== "itinerary") return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      let cur = 1;
      for (const s of $$(".day")) { if (s.getBoundingClientRect().top <= 140) cur = +s.dataset.day; else break; }
      if (cur !== itinDay) { itinDay = cur; markChip($("#itin-days"), cur); renderMapFor(cur); }
    });
  }, { passive: true });
}
function normTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ""));
  if (!m) return "";
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}
function normMode(m) {
  const t = String(m || "").toLowerCase();
  if (/walk|foot/.test(t)) return "walk";
  if (/bus|coach/.test(t)) return "bus";
  if (/taxi|car|drive/.test(t)) return "car";
  return "rail";
}
function itemTag(kind) {
  return kind === "food" ? "Sit-down" : kind === "nature" ? "Walk" : kind === "shop" ? "Browse" : kind === "sight" ? "Sight" : "";
}
function findPlanItem(sid) {
  for (const day of DAYS) {
    const index = day.items.findIndex(it => it.sid === sid);
    if (index >= 0) return { day, item: day.items[index], index };
  }
  return null;
}
function applyChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) return { ok: false, error: "No changes to apply." };
  const backup = DAYS.map(day => ({ ...day, items: day.items.map(it => ({ ...it })) }));
  const added = [], touched = new Set();
  let focusDay = null;
  try {
    for (const raw of changes) {
      const op = String(raw?.op || "").toLowerCase();
      if (op === "add") {
        const day = DAYS.find(d => d.d === +raw.day);
        if (!day) throw new Error("That day is not in the trip.");
        const place = P[raw.placeId || raw.place];
        if (!place) throw new Error("That place is not in the catalogue.");
        const s = normTime(raw.start), e = normTime(raw.end);
        if (!s || !e || e <= s) throw new Error("The new activity needs a valid start and end time.");
        if (day.items.some(it => it.p === place.id && it.s === s && it.e === e)) {
          throw new Error(`That activity is already on Day ${day.d}.`);
        }
        const sid = raw.sid || "add-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
        if (findPlanItem(sid)) throw new Error("That activity id already exists.");
        const item = {
          sid, uid: sid, s, e, p: place.id,
          t: String(raw.title || `Visit ${place.name}`).slice(0, 120),
          n: String(raw.note || "").slice(0, 320),
          k: itemTag(place.kind), c: place.kind, added: true,
          mode: raw.travelMode ? normMode(raw.travelMode) : undefined,
          addTravel: Number.isFinite(+raw.travelMin) ? Math.round(+raw.travelMin) : undefined,
        };
        day.items.push(item); added.push(item); touched.add(day.d);
        if (focusDay == null) focusDay = day.d;
      } else if (op === "remove") {
        const hit = findPlanItem(raw.sid);
        if (!hit) throw new Error(`Could not find the item ${raw.sid || ""}.`);
        hit.day.items.splice(hit.index, 1); touched.add(hit.day.d);
        if (focusDay == null) focusDay = hit.day.d;
      } else if (op === "move") {
        const hit = findPlanItem(raw.sid);
        if (!hit) throw new Error(`Could not find the item ${raw.sid || ""}.`);
        const target = raw.day ? DAYS.find(d => d.d === +raw.day) : hit.day;
        if (!target) throw new Error("The target day is not in the trip.");
        const item = hit.item;
        const s = raw.start ? normTime(raw.start) : item.s;
        const e = raw.end ? normTime(raw.end) : item.e;
        if (!item.allDay || raw.start || raw.end) {
          if (!s || !e || e <= s) throw new Error("The new time is not valid.");
        }
        if (s) item.s = s;
        if (e) item.e = e;
        if (target.d !== hit.day.d) {
          hit.day.items.splice(hit.index, 1);
          target.items.push(item);
          touched.add(hit.day.d); touched.add(target.d);
        } else touched.add(hit.day.d);
        if (focusDay == null) focusDay = target.d;
      } else if (op === "edit") {
        const hit = findPlanItem(raw.sid);
        if (!hit) throw new Error(`Could not find the item ${raw.sid || ""}.`);
        const item = hit.item;
        if (raw.placeId) {
          const place = P[raw.placeId];
          if (!place) throw new Error("That place is not in the catalogue.");
          item.p = place.id; item.c = place.kind; item.k = itemTag(place.kind);
        }
        if (raw.title !== undefined) item.t = String(raw.title).slice(0, 120);
        if (raw.note !== undefined) item.n = String(raw.note).slice(0, 320);
        if (raw.start !== undefined || raw.end !== undefined) {
          const s = raw.start !== undefined ? normTime(raw.start) : item.s;
          const e = raw.end !== undefined ? normTime(raw.end) : item.e;
          if (!item.allDay && (!s || !e || e <= s)) throw new Error("The new time is not valid.");
          if (s) item.s = s;
          if (e) item.e = e;
        }
        if (raw.travelMode !== undefined) item.mode = normMode(raw.travelMode);
        touched.add(hit.day.d);
        if (focusDay == null) focusDay = hit.day.d;
      } else {
        throw new Error("Unknown change type.");
      }
    }
    DAYS.forEach(day => day.items.sort(sortDayItems));
    const first = focusDay || [...touched].sort((a, b) => a - b)[0];
    indexVisits();
    savePlan();
    renderItinerary();
    if (currentTab === "calendar") renderCalendar();
    invalidateRoutes();
    if (first) {
      // Make the map follow the edit, even if it was on the whole-trip view,
      // another day, or had not been opened yet.
      mapDay = first;
      itinDay = first;
      markChip($("#itin-days"), first);
      updateStopList();
      markChip($("#map-days"), first);
      if (map) renderMapFor(first);
      if (currentTab === "itinerary" && !isPhone()) {
        requestAnimationFrame(() => {
          const sec = $("#day-" + first);
          if (sec) pageEl.scrollTo({ top: pageEl.scrollTop + sec.getBoundingClientRect().top - 128, behavior: "smooth" });
        });
      }
    } else if (map) {
      renderMapFor(currentTab === "map" ? mapDay : itinDay);
    }
    return { ok: true, added, touched: [...touched], focus: first };
  } catch (err) {
    DAYS.length = 0;
    backup.forEach(day => DAYS.push(day));
    indexVisits();
    try { renderItinerary(); } catch {}
    return { ok: false, error: err?.message || "Could not apply the changes." };
  }
}
function addActivity(plan) {
  const res = applyChanges([{
    op: "add", day: plan.day, start: plan.start, end: plan.end,
    placeId: plan.placeId || plan.place, title: plan.title, note: plan.note,
    travelMode: plan.travelMode, travelMin: plan.travelMin,
  }]);
  return res.ok ? res.added[0] : null;
}
function removeActivity(sid) {
  return applyChanges([{ op: "remove", sid }]).ok;
}
$("#itin-list").addEventListener("click", e => {
  const b = e.target.closest("[data-remove]");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  removeActivity(b.dataset.remove);
});

function planB(day) {
  const parts = [];
  if (day.planB?.length || day.alts?.length) parts.push(`<h4>If it rains or you're tired</h4>${day.planB?.length ? `<ul>${day.planB.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}${day.alts?.length ? `<div class="alts">Alternatives: ${day.alts.map(chip).join("")}</div>` : ""}`);
  if (day.spend) parts.push(`<h4>Worth spending on</h4><div>${esc(day.spend)}</div>`);
  if (day.watch?.length) parts.push(`<h4>Watch out</h4><ul>${day.watch.map(t => `<li>${esc(t)}</li>`).join("")}</ul>`);
  return parts.length ? `<div class="planb">${parts.join("")}</div>` : "";
}
function openDay(n, opts = {}) {
  if ($("#peek").classList.contains("open")) closePeek({ hash: false });
  if (currentTab !== "itinerary") setTab("itinerary", { hash: false });
  const sec = $("#day-" + n); if (!sec) return;
  sec.open = true;
  pageEl.scrollTo({ top: pageEl.scrollTop + sec.getBoundingClientRect().top - 128, behavior: opts.instant ? "auto" : "smooth" });
  itinDay = n; markChip($("#itin-days"), n); renderMapFor(n);
  if (opts.hash !== false) setHash("day-" + n);
}

/* ---------- Calendar ---------- */
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (iso, n) => { const d = dateOf(iso); d.setDate(d.getDate() + n); return isoOf(d); };
/* Monday-based weeks covering the whole trip. */
const WEEKS = (() => {
  const first = dateOf(DAYS[0].date);
  let w = addDays(isoOf(first), -((first.getDay() + 6) % 7));
  const out = [];
  for (; w <= DAYS[DAYS.length - 1].date; w = addDays(w, 7)) out.push(w);
  return out;
})();
let calIdx = 0, calDayIdx = 0, calRenderQueued = false;
const H0 = 5, H1 = 24;
const calPhone = () => matchMedia("(max-width: 700px)").matches;
const todayISO = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

/* Spread overlapping events into lanes, like a real calendar. */
function layoutEvents(evs) {
  const sorted = [...evs].sort((a, b) => a.start - b.start || b.end - a.end);
  const clusters = []; let cur = [], curEnd = -1;
  for (const e of sorted) {
    if (cur.length && e.start >= curEnd) { clusters.push(cur); cur = []; curEnd = -1; }
    cur.push(e); curEnd = Math.max(curEnd, e.end);
  }
  if (cur.length) clusters.push(cur);
  for (const cluster of clusters) {
    const laneEnds = [];
    for (const e of cluster) {
      let lane = laneEnds.findIndex(t => t <= e.start);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = e.end; e.lane = lane;
    }
    const lanes = laneEnds.length;
    for (const e of cluster) e.lanes = lanes;
  }
  return sorted;
}

function renderCalendar() {
  const phone = calPhone();
  const dates = phone ? [DAYS[calDayIdx].date] : Array.from({ length: 7 }, (_, i) => addDays(WEEKS[calIdx], i));
  const byDate = Object.fromEntries(DAYS.map(d => [d.date, d]));
  $("#cal-title").textContent = phone
    ? `Day ${DAYS[calDayIdx].d} · ${fmtDay(DAYS[calDayIdx].date)}`
    : `Week ${calIdx + 1} · ${fmtDay(dates[0])} – ${fmtDay(dates[6])}`;
  $("#cal-hint").textContent = phone
    ? "Tap a free time to plan something, or tap a block for details."
    : "Drag across a free time range (or click a time) to plan something; click a block for details.";
  const hours = [];
  for (let h = H0; h < H1; h++) hours.push(`<div class="cal-hour">${String(h).padStart(2, "0")}:00</div>`);
  const colH = `height:calc(${H1 - H0} * var(--hh))`;
  const head = dates.map(iso => {
    const d = dateOf(iso), day = byDate[iso];
    return `<div class="cal-colhead ${day ? "" : "off"} ${iso === todayISO ? "today" : ""}">${WD[d.getDay()]}<b class="num">${d.getDate()}</b><span class="dn">${day ? `Day ${day.d}` : "Not on trip"}</span></div>`;
  }).join("");
  // All-day events live in a fixed bar above the scrolling hours, so the
  // hotel or flight stays visible when the grid scrolls to the evening.
  const allDay = new Map(), looseAllDay = [];
  dates.forEach(iso => {
    const day = byDate[iso]; if (!day) return;
    day.items.filter(i => i.allDay).forEach(i => {
      if (i.p) {
        if (!allDay.has(i.p)) allDay.set(i.p, { pid: i.p, t: P[i.p]?.name || i.t, kind: P[i.p]?.kind || "city", days: [] });
        allDay.get(i.p).days.push(day.d);
      } else looseAllDay.push({ t: i.t, kind: kindOf(i), days: [day.d] });
    });
    if (day.stay) {
      if (!allDay.has(day.stay)) allDay.set(day.stay, { pid: day.stay, t: P[day.stay]?.name || "Hotel", kind: "hotel", days: [] });
      allDay.get(day.stay).days.push(day.d);
    }
  });
  const dayRange = ds => ds.length > 1 ? `Days ${Math.min(...ds)}–${Math.max(...ds)}` : `Day ${ds[0]}`;
  const allDayItems = [
    ...[...allDay.values()].map(s => `<button type="button" class="allday-ev k-${s.kind}" data-pid="${s.pid}" title="${esc(s.t)} · ${dayRange(s.days)}">${s.kind === "hotel" ? icon("hotel") : ""}${esc(s.t)}<small>${dayRange(s.days)}</small></button>`),
    ...looseAllDay.map(s => `<button type="button" class="allday-ev k-${s.kind}" data-cal-day="${s.days[0]}" title="${esc(s.t)}">${esc(s.t)}<small>${dayRange(s.days)}</small></button>`),
  ];
  $("#cal-alldaybar").innerHTML = allDayItems.join("");
  const cols = dates.map(iso => {
    const day = byDate[iso];
    if (!day) return `<div class="cal-col off" style="${colH}"></div>`;
    const raw = day.items.filter(i => !i.allDay && i.s && i.e).map(it => {
      const start = toMin(it.s), end = Math.max(toMin(it.e), start + 20);
      return { ...it, start, end };
    });
    const evs = layoutEvents(raw).map(it => {
      const top = (it.start - H0 * 60) / 60, hgt = (it.end - it.start) / 60;
      const lanes = it.lanes || 1, lane = it.lane || 0;
      const left = `calc(${(lane / lanes) * 100}% + 1px)`;
      const width = `calc(${100 / lanes}% - 3px)`;
      const px = hgt * 56;
      const sizeCls = px < 38 ? "tiny" : px > 92 ? "tall" : "";
      return `<button type="button" class="ev k-${kindOf(it)} ${sizeCls}" ${it.p ? `data-pid="${it.p}"` : `data-cal-day="${day.d}"`} title="${esc(it.t)} — ${it.s}–${it.e}" style="top:calc(${top} * var(--hh));height:calc(${hgt} * var(--hh) - 2px);left:${left};width:${width}"><b>${esc(it.t)}</b><span>${it.s}–${it.e}</span></button>`;
    }).join("");
    return `<div class="cal-col" data-day="${day.d}" style="${colH}">${evs}</div>`;
  }).join("");
  $("#cal-scroll").innerHTML = `<div class="cal-grid" style="--cols:${dates.length}">
    <div class="cal-colhead"></div>${head}
    <div>${hours.join("")}</div>${cols}</div>`;
  $("#cal-prev").disabled = calPhone() ? calDayIdx === 0 : calIdx === 0;
  $("#cal-next").disabled = calPhone() ? calDayIdx === DAYS.length - 1 : calIdx === WEEKS.length - 1;
  // Open on the first event rather than at 05:00.
  let earliest = H1 * 60;
  dates.forEach(iso => { const day = byDate[iso]; if (day) day.items.forEach(i => { if (!i.allDay && i.s) earliest = Math.min(earliest, toMin(i.s)); }); });
  const startMin = earliest < H1 * 60 ? Math.max(H0 * 60, earliest - 45) : 8 * 60;
  $("#cal-scroll").scrollTop = Math.max(0, ((startMin - H0 * 60) / 60) * 56 - 4);
}
function calClick(e) {
  if (suppressCalClick) { suppressCalClick = false; e.stopPropagation(); return; }
  const b = e.target.closest("button[data-pid], button[data-cal-day]");
  if (!b) return;
  e.stopPropagation();
  if (b.dataset.pid) openPeek(b.dataset.pid);
  else openDay(+b.dataset.calDay);
}
$("#cal-scroll").addEventListener("click", calClick);
$("#cal-alldaybar").addEventListener("click", calClick);
/* ---------- Select a period and plan it ---------- */
const slotDialog = $("#slot-dialog");
const slotStartEl = $("#slot-start"), slotEndEl = $("#slot-end"), slotPromptEl = $("#slot-prompt");
const slotWarnEl = $("#slot-warn");
let slotSelEl = null, slotDrag = null, slotReturnFocus = null, suppressCalClick = false;
const slotDaySelect = $("#slot-day-select");
slotDaySelect.innerHTML = DAYS.map(d => `<option value="${d.d}">Day ${d.d} · ${fmtDay(d.date)}</option>`).join("");

function calHourHeight(col) {
  const grid = col.closest(".cal-grid");
  return parseFloat(getComputedStyle(grid).getPropertyValue("--hh")) || 56;
}
function snapMin(m) {
  const clamped = Math.max(H0 * 60, Math.min(23 * 60 + 45, m));
  return Math.round(clamped / 15) * 15;
}
function minLabel(m) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function yToMin(col, clientY) {
  const rect = col.getBoundingClientRect();
  const hh = calHourHeight(col);
  const rel = Math.max(0, Math.min(rect.height, clientY - rect.top));
  return snapMin(H0 * 60 + (rel / hh) * 60);
}
function renderCalSel(col, start, end) {
  if (!slotSelEl) { slotSelEl = document.createElement("div"); slotSelEl.className = "cal-sel"; }
  if (slotSelEl.parentElement !== col) col.appendChild(slotSelEl);
  const hh = calHourHeight(col);
  slotSelEl.style.top = `${((start - H0 * 60) / 60) * hh}px`;
  slotSelEl.style.height = `${Math.max(18, ((end - start) / 60) * hh - 2)}px`;
  slotSelEl.textContent = `${minLabel(start)}–${minLabel(end)}`;
}
function clearCalSel() {
  if (slotSelEl) slotSelEl.remove();
  slotSelEl = null;
}
function updateSlotOverlap() {
  const d = DAYS.find(x => x.d === +slotDaySelect.value);
  const start = normTime(slotStartEl.value), end = normTime(slotEndEl.value);
  if (!d || !start || !end || end <= start) { slotWarnEl.hidden = true; return; }
  const overlaps = d.items.filter(it => !it.allDay && it.s && it.e && it.s < end && it.e > start);
  if (!overlaps.length) { slotWarnEl.hidden = true; return; }
  slotWarnEl.hidden = false;
  slotWarnEl.textContent = `This overlaps ${overlaps.map(it => `${it.t.length > 55 ? it.t.slice(0, 55) + "…" : it.t} (${it.s}–${it.e})`).join("; ")}. You can still add something, or adjust the times.`;
}
function openSlotDialog(day, start, end) {
  const d = DAYS.find(x => x.d === +day);
  if (!d) return;
  start = typeof start === "string" ? toMin(start) : +start;
  end = typeof end === "string" ? toMin(end) : +end;
  if (!Number.isFinite(start)) start = 12 * 60;
  if (!Number.isFinite(end)) end = start + 60;
  const s = Math.max(H0 * 60, Math.min(start, 23 * 60));
  let e = Math.max(s + 15, Math.min(end, 23 * 60 + 45));
  if (e <= s) e = Math.min(23 * 60 + 45, s + 60);
  $("#slot-day").textContent = `Day ${d.d} · ${fmtDay(d.date)}`;
  slotDaySelect.value = String(d.d);
  slotStartEl.value = minLabel(s);
  slotEndEl.value = minLabel(e);
  slotPromptEl.value = "";
  $("#slot-status").textContent = "";
  $("#slot-status").className = "settings-status";
  slotDialog.dataset.day = d.d;
  slotReturnFocus = document.activeElement;
  if (typeof slotDialog.showModal === "function") slotDialog.showModal(); else slotDialog.setAttribute("open", "");
  updateSlotOverlap();
  setTimeout(() => slotPromptEl.focus(), 40);
}
function closeSlotDialog() {
  if (slotDialog.open) slotDialog.close(); else slotDialog.removeAttribute("open");
  clearCalSel();
  slotReturnFocus?.focus?.();
  slotReturnFocus = null;
}
function initCalendarSelection() {
  const scroll = $("#cal-scroll");
  scroll.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    const col = e.target.closest(".cal-col");
    if (!col || !col.dataset.day) return;
    const onEvent = !!e.target.closest(".ev");
    const start = yToMin(col, e.clientY);
    const touch = e.pointerType === "touch";
    const state = { col, day: +col.dataset.day, start, startY: e.clientY, end: start + 60, moved: false, touch, onEvent };
    slotDrag = state;
    if (!touch && !onEvent) {
      e.preventDefault();
      renderCalSel(col, start, start + 60);
    }
    const move = ev => {
      if (!slotDrag) return;
      const dy = Math.abs(ev.clientY - state.startY);
      if (touch) { if (dy > 10) state.moved = true; return; }
      if (dy > 3) state.moved = true;
      let end = yToMin(col, ev.clientY);
      if (end <= start) end = start + 15;
      state.end = end;
      renderCalSel(col, start, end);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      if (!slotDrag) return;
      if (touch && state.moved) { slotDrag = null; return; }
      if (state.onEvent && !state.moved) { slotDrag = null; clearCalSel(); return; }
      let end = state.moved ? state.end : state.start + 60;
      if (end <= state.start) end = state.start + 15;
      end = Math.min(end, 23 * 60 + 45);
      if (end <= state.start) { state.start = Math.max(H0 * 60, end - 60); }
      if (state.moved) {
        suppressCalClick = true;
        setTimeout(() => { suppressCalClick = false; }, 500);
      }
      clearCalSel();
      slotDrag = null;
      openSlotDialog(state.day, state.start, end);
    };
    const cancel = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      slotDrag = null;
      clearCalSel();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
    document.addEventListener("pointercancel", cancel);
  });
}
initCalendarSelection();
$("#slot-form").addEventListener("submit", e => {
  e.preventDefault();
  const start = normTime(slotStartEl.value), end = normTime(slotEndEl.value);
  const status = $("#slot-status");
  if (!start || !end || end <= start) {
    status.textContent = "Choose an end time after the start.";
    status.className = "settings-status bad";
    return;
  }
  const day = +slotDaySelect.value;
  const prompt = slotPromptEl.value.trim() || "Suggest something that fits this time.";
  slotDialog.close();
  clearCalSel();
  if (window.TripAssistant?.requestSlot) window.TripAssistant.requestSlot({ day, start, end, prompt });
});
$("#slot-chips").addEventListener("click", e => {
  const b = e.target.closest("[data-fill]");
  if (!b) return;
  slotPromptEl.value = b.dataset.fill;
  slotPromptEl.focus();
});
$("#slot-close").addEventListener("click", closeSlotDialog);
$("#slot-cancel").addEventListener("click", closeSlotDialog);
slotDialog.addEventListener("close", clearCalSel);
slotDialog.addEventListener("click", e => { if (e.target === slotDialog) closeSlotDialog(); });
slotDaySelect.addEventListener("change", () => {
  const d = DAYS.find(x => x.d === +slotDaySelect.value);
  if (d) $("#slot-day").textContent = `Day ${d.d} · ${fmtDay(d.date)}`;
  updateSlotOverlap();
});
slotStartEl.addEventListener("change", updateSlotOverlap);
slotEndEl.addEventListener("change", updateSlotOverlap);
$("#cal-add").onclick = () => {
  const isoDates = calPhone() ? [DAYS[calDayIdx].date] : Array.from({ length: 7 }, (_, i) => addDays(WEEKS[calIdx], i));
  const day = isoDates.map(iso => DAYS.find(d => d.date === iso)).find(Boolean) || DAYS[0];
  openSlotDialog(day.d, 12 * 60, 13 * 60);
};
$("#cal-prev").onclick = () => { if (calPhone()) calDayIdx = Math.max(0, calDayIdx - 1); else calIdx = Math.max(0, calIdx - 1); renderCalendar(); };
$("#cal-next").onclick = () => { if (calPhone()) calDayIdx = Math.min(DAYS.length - 1, calDayIdx + 1); else calIdx = Math.min(WEEKS.length - 1, calIdx + 1); renderCalendar(); };
$("#legend").innerHTML = ["sight", "nature", "food", "shop", "transport", "hotel"].map(k => `<span class="tag k-${k}">${KIND_LABEL[k]}</span>`).join("");
addEventListener("resize", () => {
  if (calRenderQueued) return;
  calRenderQueued = true;
  requestAnimationFrame(() => { calRenderQueued = false; if (currentTab === "calendar") renderCalendar(); });
});

/* ---------- Map (Google Maps) ---------- */
let map = null, markers = [], routeOverlays = [], mapReady = false, mapLoading = false, pendingRender = null;
const readyQueue = [];
const dark = () => document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
const ROUTE_STYLE = {
  walk: { color: "#2f9e44", width: 3.4, dash: "dot" },
  rail: { color: "#2383e2", width: 4.2 },
  bus: { color: "#e8590c", width: 4.0 },
  car: { color: "#7048e8", width: 3.0, dash: "dash" },
  flight: { color: "#868e96", width: 2.2, dash: "dash" },
};

async function initMap() {
  if (map || mapLoading) return;
  if (!TripGoogle.hasKey()) {
    setMapStatus("Add a Google Maps key in Settings to see the map.", true);
    $("#map").innerHTML = '<p class="map-empty">Add a Google Maps key in Settings to see the map.</p>';
    return;
  }
  mapLoading = true;
  try {
    await TripGoogle.loadMaps();
    const { Map } = await google.maps.importLibrary("maps");
    await google.maps.importLibrary("marker");
    const start = STOP_LIST[0] ? P[STOP_LIST[0].id] : null;
    map = new Map($("#map"), {
      mapId: TripGoogle.mapId(), colorScheme: dark() ? "DARK" : "LIGHT",
      center: start ? { lat: start.lat, lng: start.lng } : { lat: 20, lng: 0 }, zoom: start ? 6 : 2,
      disableDefaultUI: true, zoomControl: true, gestureHandling: "greedy", clickableIcons: false,
    });
    map.addListener("idle", avoidPinOverlap);
    map.addListener("zoom_changed", avoidPinOverlap);
    mapReady = true;
    setMapStatus("");
    readyQueue.splice(0).forEach(fn => fn());
    if (pendingRender !== null) { const n = pendingRender; pendingRender = null; renderMapFor(n); }
  } catch {
    setMapStatus("Google Maps could not load. Check the key in Settings.", true);
  } finally { mapLoading = false; }
}
addEventListener("google-auth-failed", () => setMapStatus("Google rejected the Maps key. Check it in Settings.", true));
addEventListener("google-error", e => {
  const box = $("#google-error");
  box.querySelector("ul").insertAdjacentHTML("beforeend", `<li><b>${esc(e.detail.api)}:</b> ${esc(e.detail.message)}</li>`);
  box.hidden = false;
});
$("#google-error-settings").addEventListener("click", () => TripSettings.open({ focus: "google" }));
$("#google-error-close").addEventListener("click", () => { $("#google-error").hidden = true; });
function whenMapReady(fn) { mapReady ? fn() : readyQueue.push(fn); }
function mountMap(sel) {
  const slot = $(sel), mapEl = $("#map"); if (!slot || !mapEl) return;
  mapEl.hidden = false;
  slot.appendChild(mapEl);
  initMap();
}
function clearMarkers() { markers.forEach(m => { m.marker.map = null; }); markers = []; }
function addPin(p, label, cls = "", onClick, markerOpts = {}) {
  const { prio = 50 } = markerOpts;
  const el = document.createElement("button");
  el.type = "button";
  el.className = `pin k-${p.kind} ${cls}`.trim(); el.innerHTML = label; el.dataset.mpid = p.id;
  el.dataset.prio = prio;
  el.setAttribute("aria-label", p.name);
  el.onclick = e => { e.stopPropagation(); onClick ? onClick() : showPop(el, p.id); };
  if (finePointer && !onClick) { el.onmouseenter = () => { clearTimeout(popTimer); popTimer = setTimeout(() => showPop(el, p.id), 200); }; el.onmouseleave = () => { clearTimeout(popTimer); popHide = setTimeout(hidePop, 250); }; }
  const marker = new google.maps.marker.AdvancedMarkerElement({ map, position: { lat: p.lat, lng: p.lng }, content: el, zIndex: 1000 - prio });
  markers.push({ marker, el });
}

/* At country zoom several stops land on the same pixels. Keep the most important
   pins visible and let the stop list stand in for the rest. */
let pinRaf = 0;
function avoidPinOverlap() {
  if (!map) return;
  cancelAnimationFrame(pinRaf);
  pinRaf = requestAnimationFrame(() => {
    const pins = [...markers].sort((a, b) => (+a.el.dataset.prio || 50) - (+b.el.dataset.prio || 50));
    const boxes = [];
    pins.forEach(m => { m.el.style.visibility = ""; });
    for (const m of pins) {
      const r = m.el.getBoundingClientRect();
      if (!r.width) continue;
      const hit = boxes.some(b => !(r.right + 2 < b.left || r.left - 2 > b.right || r.bottom + 2 < b.top || r.top - 2 > b.bottom));
      if (hit) m.el.style.visibility = "hidden"; else boxes.push(r);
    }
  });
}
/* Fit points given as [lng, lat]. */
function fitTo(pts, padding = 60, maxZoom = 15) {
  if (!map || !pts.length) return;
  if (pts.length === 1) { map.panTo({ lat: pts[0][1], lng: pts[0][0] }); map.setZoom(Math.min(maxZoom, 14)); return; }
  const b = new google.maps.LatLngBounds();
  pts.forEach(([lng, lat]) => b.extend({ lat, lng }));
  map.fitBounds(b, padding);
  google.maps.event.addListenerOnce(map, "idle", () => { if (map.getZoom() > maxZoom) map.setZoom(maxZoom); });
}
function flyTo(p, zoom) { if (!map) return; map.panTo({ lat: p.lat, lng: p.lng }); map.setZoom(zoom); }


let mapToken = 0, routeTimer = 0, routesFor = null, routesHave = false;

function placePt(id) {
  const p = P[id];
  return p?.lat != null ? { id, lat: p.lat, lng: p.lng, name: p.name } : null;
}
function legKind(text, meters) {
  const t = String(text || "").toLowerCase();
  const flight = /\b(flight|fly|plane)\b/.test(t);
  const rail = /\b(shinkansen|train|rail|railway|metro|subway|underground|tube|monorail|tram|ropeway|ferry)\b/.test(t);
  const bus = /\b(bus|coach|shuttle)\b/.test(t);
  const car = /\b(taxi|cab|car|drive|uber)\b/.test(t);
  const walk = /\b(walk|walking|foot|stroll|hike)\b/.test(t);
  if (flight) return "flight";
  if (meters > 3000) {
    if (rail) return "rail";
    if (bus) return "bus";
    if (car) return "car";
    if (walk) return "walk";
  } else {
    if (walk) return "walk";
    if (bus) return "bus";
    if (rail) return "rail";
    if (car) return "car";
  }
  return meters < 2200 ? "walk" : "rail";
}
function departISOFor(day, time) {
  return TripRouting.zonedISO(day.date, time, day.tz || META.timeZone);
}
function routeFeature(l, leg, day, r) {
  if (!l.coordinates || l.coordinates.length < 2) return null;
  return {
    type: "Feature",
    properties: {
      kind: l.kind,
      duration: Math.max(1, Math.round(l.duration ?? r.duration ?? 0)),
      distance: Math.round(l.distance || 0),
      approx: !!(r.approximate || l.approximate),
      from: l.from || leg.from.name, to: l.to || leg.to.name,
      line: l.line || "", day: day?.d ?? 0,
    },
    geometry: { type: "LineString", coordinates: l.coordinates },
  };
}
function combineRoutes(results, day) {
  const features = [];
  let approximate = false;
  for (const { leg, r } of results) {
    if (!r) { approximate = true; continue; }
    if (r.approximate) approximate = true;
    for (const l of r.legs || []) {
      const f = routeFeature(l, leg, day, r);
      if (f) features.push(f);
    }
  }
  return { features, approximate };
}

async function buildDayRoute(day) {
  if (!window.TripRouting) return { features: [], approximate: true };
  const prevStay = DAYS[day.d - 2]?.stay;
  const origin = prevStay ? placePt(prevStay) : null;
  const legs = [];
  let prev = null, pending = [];
  for (const it of day.items) {
    const txt = [it.t, it.n, it.tr].filter(Boolean).join(". ");
    if (!it.p || !P[it.p]?.lat || it.allDay) {
      if (txt) pending.push({ text: txt, s: it.s });
      continue;
    }
    const cur = placePt(it.p);
    if (!cur) continue;
    if (!prev) {
      if (origin && origin.id !== cur.id) {
        const meters = TripRouting.haversine(origin, cur);
        if (meters > 250) {
          const text = [...pending.map(p => p.text), txt].join(". ");
          const time = pending.find(p => p.s)?.s || it.s || "09:00";
          legs.push({ from: origin, to: cur, kind: it.mode || legKind(text, meters), time, text });
        }
      }
    } else if (prev.id !== cur.id) {
      const meters = TripRouting.haversine(prev, cur);
      if (meters > 30) {
        const current = [...pending.map(p => p.text), txt].join(". ");
        const text = meters > 3000 ? [prev.text, current].join(". ") : current;
        const time = pending.find(p => p.s)?.s || prev.end || it.s || "09:00";
        legs.push({ from: prev, to: cur, kind: it.mode || legKind(text, meters), time, text });
      }
    }
    prev = { ...cur, text: txt, end: it.e || it.s };
    pending = [];
  }
  if (!legs.length) return { features: [], approximate: false };
  const results = await Promise.all(legs.map(async leg => ({
    leg,
    r: await TripRouting.routeLeg({ kind: leg.kind, from: leg.from, to: leg.to, departISO: departISOFor(day, leg.time) }),
  })));
  return combineRoutes(results, day);
}

/* Whole trip: one leg per change of base, by the mode the day's plan mentions. */
async function buildTripRoute() {
  if (!window.TripRouting) return { features: [], approximate: true };
  const pairs = [], seen = new Set();
  for (let i = 1; i < BASES.length; i++) {
    const a = placePt(BASES[i - 1].id), b = placePt(BASES[i].id);
    const k = BASES[i - 1].id + ">" + BASES[i].id;
    if (!a || !b || seen.has(k)) continue;
    seen.add(k);
    const day = DAYS[BASES[i].days[0] - 1];
    const meters = TripRouting.haversine(a, b);
    const text = day.items.filter(it => it.c === "transport" || it.mode).map(it => [it.t, it.mode].join(" ")).join(". ");
    let kind = meters > 1000000 ? "flight" : legKind(text, meters);
    if (kind === "walk") kind = "rail";
    pairs.push({ a, b, kind, day });
  }
  const results = await Promise.all(pairs.map(async p => ({
    leg: { from: p.a, to: p.b, kind: p.kind, text: "" },
    r: await TripRouting.routeLeg({ kind: p.kind, from: p.a, to: p.b, departISO: departISOFor(p.day, "09:00") }),
  })));
  return combineRoutes(results, null);
}

function setRouteData(features) {
  routeOverlays.forEach(o => { if (o.setMap) o.setMap(null); else o.map = null; });
  routeOverlays = [];
  if (map) {
    const casing = dark() ? "#191919" : "#ffffff";
    for (const f of features) {
      const path = f.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const st = ROUTE_STYLE[f.properties.kind] || ROUTE_STYLE.rail;
      const color = f.properties.approx ? (dark() ? "#ced4da" : "#495057") : st.color;
      const dash = f.properties.approx ? "dash" : st.dash;
      routeOverlays.push(new google.maps.Polyline({ map, path, clickable: false, zIndex: 1, strokeColor: casing, strokeOpacity: .9, strokeWeight: st.width + 4 }));
      const symbol = dash === "dot"
        ? { path: google.maps.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeOpacity: 0, scale: st.width / 1.7 }
        : { path: "M 0,-1 0,1", strokeColor: color, strokeOpacity: 1, strokeWeight: st.width, scale: 2.5 };
      routeOverlays.push(new google.maps.Polyline({
        map, path, clickable: false, zIndex: 2, strokeColor: color, strokeWeight: st.width, strokeOpacity: dash ? 0 : .95,
        icons: dash ? [{ icon: symbol, offset: "0", repeat: dash === "dot" ? "9px" : "14px" }] : [],
      }));
      // A mode badge in the middle of each leg that is long enough to read.
      if (f.properties.distance > 400 || f.properties.kind === "flight") {
        const img = document.createElement("img");
        img.src = `icons/${f.properties.kind}.png`; img.alt = ""; img.className = "route-badge";
        routeOverlays.push(new google.maps.marker.AdvancedMarkerElement({ map, position: path[Math.floor(path.length / 2)], content: img, zIndex: 3 }));
      }
    }
  }
  routesHave = features.length > 0;
  const legend = $("#route-legend");
  if (legend) legend.hidden = !routesHave || currentTab !== "map";
}
function setMapStatus(text, warn = false) {
  const el = $("#map-status");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "map-status" + (warn ? " warn" : "");
}
function invalidateRoutes() { routesFor = null; routesHave = false; }

function renderMapFor(n) {
  if (!map || !mapReady) { pendingRender = n; return; }
  const token = ++mapToken;
  clearMarkers();
  const ll = id => [P[id].lng, P[id].lat];
  let pts = [];
  if (!n) {
    STOP_LIST.forEach(s => addPin(P[s.id], String(s.n), "", null, { prio: s.n }));
    pts = STOP_LIST.map(s => ll(s.id));
    fitTo(pts, 60, 11);
  } else {
    const day = DAYS[n - 1]; if (!day) { renderMapFor(0); return; }
    const seen = [];
    day.items.forEach(it => { if (it.p && P[it.p]?.lat && !it.allDay && !seen.includes(it.p)) seen.push(it.p); });
    if (!seen.length) { renderMapFor(0); return; }
    seen.forEach((id, i) => addPin(P[id], String(i + 1), "", null, { prio: i + 1 }));
    pts = seen.map(ll);
    fitTo(pts, { top: 60, bottom: 50, left: 50, right: 50 }, 15);
  }
  setTimeout(avoidPinOverlap, 60);
  if (routesFor === n && routesHave) {
    const legend = $("#route-legend");
    if (legend) legend.hidden = currentTab !== "map";
    setMapStatus("");
    return;
  }
  routesFor = n;
  setRouteData([]);
  setMapStatus("Drawing travel routes…");
  clearTimeout(routeTimer);
  routeTimer = setTimeout(async () => {
    if (token !== mapToken) return;
    let result;
    try { result = n ? await buildDayRoute(DAYS[n - 1]) : await buildTripRoute(); }
    catch { result = { features: [], approximate: true }; }
    if (token !== mapToken) return;
    setRouteData(result.features);
    if (result.features.length) {
      const routePts = result.features.flatMap(f => f.geometry.coordinates);
      fitTo([...pts, ...routePts], 60, n ? 15 : 11);
    }
    if (result.features.length && result.approximate) setMapStatus("Some legs could not be routed — showing direct lines.", true);
    else setMapStatus("");
  }, 220);
}
function pickMapDay(n) { mapDay = n; markChip($("#map-days"), n); updateStopList(); renderMapFor(n); }
function showDayOnMap(n) {
  n = +n;
  if (!(n >= 1 && n <= DAYS.length)) n = itinDay || 1;
  mapDay = n; itinDay = n;
  markChip($("#map-days"), n); markChip($("#itin-days"), n); updateStopList();
  setTab("map");
  updateStopList();
}
function showPlaceOnMap(pid) {
  const p = P[pid]; if (!p?.lat) return;
  const v = VISITS[pid]?.[0];
  const wideItin = currentTab === "itinerary" && matchMedia("(min-width: 1380px)").matches;
  if (wideItin) renderMapFor(v ? v.day.d : itinDay);
  else { setTab("map"); pickMapDay(v ? v.day.d : 0); }
  whenMapReady(() => setTimeout(() => {
    if (!markers.some(m => m.el.dataset.mpid === pid)) addPin(p, "•");
    flyTo(p, Math.max(map.getZoom(), 14));
    markers.forEach(m => m.el.classList.toggle("hl", m.el.dataset.mpid === pid));
  }, 750));
}
function showPlacesOnMap(ids) {
  ids = (ids || []).filter(id => P[id]?.lat); if (!ids.length) return;
  setTab("map"); mapDay = 0; markChip($("#map-days"), 0); updateStopList();
  mapToken++; clearTimeout(routeTimer);
  invalidateRoutes();
  whenMapReady(() => {
    pendingRender = null;
    clearMarkers();
    setRouteData([]);
    setMapStatus("");
    const legend = $("#route-legend"); if (legend) legend.hidden = true;
    ids.forEach((id, i) => addPin(P[id], String(i + 1), "", null, { prio: i + 1 }));
    fitTo(ids.map(id => [P[id].lng, P[id].lat]), 60, 15);
  });
}
dayChips($("#map-days"), true, pickMapDay);
markChip($("#map-days"), 0);

/* Bases: consecutive nights in the same place (a city on a day with no hotel). */
const BASES = [];
for (const day of DAYS) {
  const id = day.stay && P[day.stay]?.lat != null ? day.stay : P[day.city]?.lat != null ? day.city : null;
  if (!id) continue;
  const last = BASES[BASES.length - 1];
  // A last day without a hotel, in the same city, still belongs to that base.
  const sameCity = last && !day.stay && (P[last.id].kind === "city" ? last.id : P[last.id].city) === day.city;
  if (last?.id === id || sameCity) last.days.push(day.d); else BASES.push({ id, days: [day.d] });
}
const baseName = id => { const p = P[id]; return p.kind === "city" ? p.name : P[p.city]?.name || p.name; };
/* Whole-trip stop list: names next to numbered pins, without colliding map labels. */
const STOP_LIST = (() => {
  const byId = new Map();
  BASES.forEach(b => { if (!byId.has(b.id)) byId.set(b.id, []); byId.get(b.id).push(b.days); });
  return [...byId].map(([id, runs], i) => {
    const total = runs.reduce((s, r) => s + r.length, 0);
    const span = runs.map(r => r.length > 1 ? `${r[0]}–${r[r.length - 1]}` : `${r[0]}`).join(" · ");
    return { id, label: baseName(id), days: (total > 1 ? "Days " : "Day ") + span, day: runs[0][0], n: i + 1 };
  });
})();
function renderStopList() {
  const list = $("#map-stops");
  if (!list) return;
  list.innerHTML = STOP_LIST.map(s => `<button type="button" class="stop k-${P[s.id].kind}" data-stop="${s.n}" aria-label="${esc(s.label)}, ${esc(s.days)}"><b>${s.n}</b>${esc(s.label)} <small>${esc(s.days)}</small></button>`).join("");
  list.onclick = e => {
    const b = e.target.closest("[data-stop]"); if (!b) return;
    const s = STOP_LIST.find(x => String(x.n) === b.dataset.stop); if (!s || !map) return;
    $$("#map-stops .stop").forEach(x => x.classList.toggle("on", x === b));
    flyTo(P[s.id], 11);
  };
}
function renderDayStopList(n) {
  const list = $("#map-stops"), day = DAYS[n - 1];
  if (!list || !day) return;
  const seen = [];
  for (const it of day.items) {
    if (!it.p || !P[it.p]?.lat || it.allDay) continue;
    if (seen.some(x => x.id === it.p)) continue;
    seen.push({ id: it.p, s: it.s });
  }
  list.innerHTML = `<span class="map-day-title">Day ${day.d} · ${esc(day.title)}</span>` +
    seen.map((x, i) => `<button type="button" class="stop k-${P[x.id].kind}" data-daypid="${esc(x.id)}" aria-label="${esc(P[x.id].name)}, ${esc(x.s || "")}"><b>${i + 1}</b>${esc(P[x.id].name)} <small>${esc(x.s || "")}</small></button>`).join("");
  list.onclick = e => {
    const b = e.target.closest("[data-daypid]"); if (!b || !map) return;
    const place = P[b.dataset.daypid]; if (!place) return;
    $$("#map-stops .stop").forEach(x => x.classList.toggle("on", x === b));
    flyTo(place, Math.max(map.getZoom(), 14));
  };
}
function updateStopList() {
  const el = $("#map-stops"); if (!el) return;
  if (mapDay === 0) { renderStopList(); el.hidden = false; }
  else { renderDayStopList(mapDay); el.hidden = false; }
}
renderStopList(); updateStopList();

/* ---------- Hash routes (#calendar, #day-3, #place-kyoto) ---------- */
let suppressHash = false;
function setHash(route) {
  const next = route ? "#" + route : location.pathname + location.search;
  suppressHash = true;
  try { history.replaceState(null, "", next); } finally { setTimeout(() => { suppressHash = false; }, 0); }
}
function applyRoute() {
  if (suppressHash) return;
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h) return;
  if (["itinerary", "calendar", "map"].includes(h)) { setTab(h, { hash: false }); return; }
  const m = /^day-(\d+)$/.exec(h);
  if (m) { itinDay = +m[1]; setTab("itinerary", { hash: false }); openDay(itinDay, { hash: false }); return; }
  if (h.startsWith("place-")) {
    const id = h.slice(6);
    if (P[id]) openPeek(id, { hash: false });
  }
}
addEventListener("hashchange", applyRoute);

/* ---------- Keyboard ---------- */
document.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".chip[data-pid]")) {
    e.preventDefault(); showPop(e.target, e.target.dataset.pid); return;
  }
  if (!$("#lb").hidden) {
    if (e.key === "ArrowLeft") lbGo(-1); else if (e.key === "ArrowRight") lbGo(1); else if (e.key === "Escape") closeLightbox();
    return;
  }
  if (e.key === "Escape") { hidePop(); if ($("#peek").classList.contains("open")) closePeek(); }
});

/* ---------- Chat open/close (desktop) ---------- */
function setChatOpen(open) {
  if (isPhone()) { if (!open) setView(currentTab); else setView("chat"); return; }
  document.body.classList.toggle("chat-closed", !open);
  store.set("trip-chat-open", open);
}
matchMedia("(min-width: 1380px)").addEventListener?.("change", e => {
  if (e.matches && currentTab === "itinerary") { mountMap("#slot-itin"); renderMapFor(itinDay); }
});

/* ---------- Print ---------- */
let printOpen = [];
function beforePrint() {
  printOpen = $$(".day").filter(d => !d.open).map(d => d.dataset.day);
  $$(".day").forEach(d => d.open = true);
}
function afterPrint() { printOpen.forEach(n => { const d = $("#day-" + n); if (d) d.open = false; }); printOpen = []; }
addEventListener("beforeprint", beforePrint);
addEventListener("afterprint", afterPrint);

/* ---------- Boot ---------- */
renderHead();
renderItinerary();
const hashRoute = decodeURIComponent(location.hash.slice(1));
const storedTab = store.get("trip-tab", "itinerary");
setTab(["itinerary", "calendar", "map"].includes(hashRoute) ? hashRoute : storedTab, { hash: false });
if (isPhone()) setView(["calendar", "map"].includes(currentTab) ? currentTab : "itinerary");
if (hashRoute.startsWith("day-") || hashRoute.startsWith("place-")) applyRoute();
if (store.get("trip-chat-open", true) === false) document.body.classList.add("chat-closed");
$("#chat-close").onclick = () => setChatOpen(false);
$("#chat-open").onclick = () => setChatOpen(true);
$("#print").onclick = () => window.print();

function openChat() {
  setChatOpen(true);
  if (isPhone()) setView("chat");
}

/* Expose what the assistant needs. */
window.TripUI = {
  D, P, DAYS, META, md, inline, chip, esc, fmtDay, kindOf, gmapsUrl, live, ensurePlace,
  openDay, openPeek, closePeek, showPlacesOnMap, showPop, hidePop, isPhone,
  addActivity, removeActivity, applyChanges, showDayOnMap, openChat, openSlotDialog,
  get currentTab() { return currentTab; },
};
})();
