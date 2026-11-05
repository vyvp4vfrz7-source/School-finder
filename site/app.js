// School Finder pilot: a static site, no build step. Data comes from ./data/*.json,
// produced by the pipeline in /pipeline (see README).

const PHASES = {
  primary: { label: "Primary", color: "var(--primary)", hex: "#2563eb" },
  secondary: { label: "Secondary", color: "var(--secondary)", hex: "#0f766e" },
  "all-through": { label: "All-through", color: "var(--through)", hex: "#c2410c" },
  "sixth-form": { label: "Sixth form", color: "var(--sixth)", hex: "#7c3aed" },
  nursery: { label: "Nursery", color: "var(--nursery)", hex: "#be185d" },
};
const AREA_RADIUS = 500; // metres, for crime and sold prices around a point
const RING_COLORS = ["#0f766e", "#14b8a6", "#5eead4", "#99f6e4", "#ccfbf1"];

const state = {
  schools: [],
  byUrn: new Map(),
  catchments: {},
  catchmentSources: {},
  results: { ks4: {}, ks5: {} },
  phases: new Set(["primary", "secondary", "all-through"]),
  showState: true,
  showIndep: false,
  showSpecial: false,
  onlyCatch: false,
  home: null, // {lat, lon, postcode}
  selected: null,
};
const lazy = {}; // crime, sales, coverage: loaded on first use

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtKm = (m) => (m == null ? "–" : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const fmtGBP = (n) => (n == null ? "–" : n >= 1e6 ? `£${(n / 1e6).toFixed(2)}m` : `£${Math.round(n / 1000)}k`);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const dp = (lat2 - lat1) * r, dl = (lon2 - lon1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
async function loadJSON(name) {
  try {
    const r = await fetch(`data/${name}.json`, { cache: "no-cache" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function getLazy(name) {
  if (!(name in lazy)) lazy[name] = loadJSON(name);
  return lazy[name];
}
const catLabel = (slug) => slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function restore(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }

// ---------- map ----------
// OFFLINE is set by pages that cannot reach outside services (such as a sandboxed preview):
// the map then draws homes from the sold-price data instead of map tiles, and postcodes are
// looked up in a local file instead of postcodes.io.
const OFFLINE = !!window.SF_OFFLINE;
const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([51.385, -0.24], 12);
map.attributionControl.setPrefix(false); // keep the data credits, drop the "Leaflet" library link
if (!OFFLINE) {
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
} else {
  drawOfflineBase();
}

// A street-free base map: every sold home as a faint dot, plus town names.
const TOWNS = [
  ["Kingston", 51.4123, -0.3007], ["Surbiton", 51.3937, -0.3033], ["New Malden", 51.4027, -0.2560],
  ["Tolworth", 51.3800, -0.2800], ["Chessington", 51.3600, -0.3000], ["Worcester Park", 51.3790, -0.2440],
  ["Cheam", 51.3600, -0.2140], ["Sutton", 51.3618, -0.1945], ["Carshalton", 51.3680, -0.1660],
  ["Wallington", 51.3600, -0.1500], ["Belmont", 51.3440, -0.2000], ["Norbiton", 51.4100, -0.2840],
];
const BASE_STYLE = {
  light: { land: "#f3f1ec", green: "#dcebd3", water: "#bcd7e8", rail: "#a6a29a", minor: "#ffffff", minorEdge: "#dedad2",
           mid: "#ffffff", midEdge: "#d2ccc0", major: "#fbe3a6", majorEdge: "#e2c27a", dot: "rgba(60,80,100,.22)" },
  dark: { land: "#1b2027", green: "#1f2c22", water: "#1d3242", rail: "#4a4f57", minor: "#2c333d", minorEdge: "#232931",
          mid: "#38414d", midEdge: "#2a313a", major: "#5a4a2a", majorEdge: "#3e341f", dot: "rgba(160,190,200,.28)" },
};
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
}
async function drawOfflineBase() {
  const base = await getLazy("basemap");
  if (base?.layers) {
    drawVectorBase(base);
    map.attributionControl.addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors');
  } else {
    drawHomeDots();
    map.attributionControl.addAttribution("Dots are homes sold (HM Land Registry)");
  }
  for (const [name, lat, lon] of TOWNS) {
    L.marker([lat, lon], { interactive: false, keyboard: false,
      icon: L.divIcon({ className: "", html: `<span class="town-label">${name}</span>`, iconAnchor: [30, 8] }) }).addTo(map);
  }
}

function bboxOf(flat) {
  let s = 90, w = 180, n = -90, e = -180;
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] < s) s = flat[i]; if (flat[i] > n) n = flat[i];
    if (flat[i + 1] < w) w = flat[i + 1]; if (flat[i + 1] > e) e = flat[i + 1];
  }
  return [s, w, n, e];
}

function drawVectorBase(base) {
  const layers = {};
  for (const [k, list] of Object.entries(base.layers)) layers[k] = list.map((f) => ({ f, b: bboxOf(f) }));
  const Base = L.GridLayer.extend({
    createTile(coords) {
      const tile = document.createElement("canvas");
      const size = this.getTileSize();
      const ratio = window.devicePixelRatio || 1;
      tile.width = size.x * ratio; tile.height = size.y * ratio;
      const ctx = tile.getContext("2d");
      ctx.scale(ratio, ratio);
      const st = BASE_STYLE[isDark() ? "dark" : "light"];
      const z = coords.z;
      const nw = coords.scaleBy(size);
      const sw = map.unproject(nw.add([0, size.y]), z), ne = map.unproject(nw.add([size.x, 0]), z);
      const pad = 0.002;
      const inView = (b) => !(b[2] < sw.lat - pad || b[0] > ne.lat + pad || b[3] < sw.lng - pad || b[1] > ne.lng + pad);
      const path = (f) => {
        ctx.beginPath();
        for (let i = 0; i < f.length; i += 2) {
          const p = map.project([f[i], f[i + 1]], z).subtract(nw);
          i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
        }
      };
      ctx.fillStyle = st.land; ctx.fillRect(0, 0, size.x, size.y);
      const fill = (key, color) => {
        ctx.fillStyle = color;
        for (const { f, b } of layers[key] || []) if (inView(b)) { path(f); ctx.closePath(); ctx.fill(); }
      };
      const stroke = (key, color, width, dash) => {
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.setLineDash(dash || []);
        for (const { f, b } of layers[key] || []) if (inView(b)) { path(f); ctx.stroke(); }
        ctx.setLineDash([]);
      };
      fill("green", st.green);
      fill("water", st.water);
      stroke("river", st.water, Math.max(2, (z - 10) * 1.6));
      const k = Math.max(0.4, (z - 11) * 0.9);
      if (z >= 13) { stroke("minor", st.minorEdge, 1.6 * k + 1); stroke("minor", st.minor, 1.6 * k); }
      stroke("mid", st.midEdge, 2.2 * k + 1.2); stroke("mid", st.mid, 2.2 * k);
      stroke("major", st.majorEdge, 3 * k + 1.5); stroke("major", st.major, 3 * k);
      stroke("rail", st.rail, 1.2, [4, 3]);
      return tile;
    },
  });
  new Base({ pane: "tilePane", maxZoom: 19 }).addTo(map);
}

async function drawHomeDots() {
  const sales = await getLazy("sales");
  const pts = (sales?.rows || []).map((r) => [r[0], r[1]]);
  const Dots = L.GridLayer.extend({
    createTile(coords) {
      const tile = document.createElement("canvas");
      const size = this.getTileSize();
      tile.width = size.x; tile.height = size.y;
      const ctx = tile.getContext("2d");
      ctx.fillStyle = BASE_STYLE[isDark() ? "dark" : "light"].dot;
      const nw = coords.scaleBy(size);
      const r = Math.max(1, (coords.z - 11) * 0.6);
      for (const [lat, lon] of pts) {
        const p = map.project([lat, lon], coords.z).subtract(nw);
        if (p.x < -3 || p.y < -3 || p.x > size.x + 3 || p.y > size.y + 3) continue;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.283); ctx.fill();
      }
      return tile;
    },
  });
  new Dots({ pane: "tilePane" }).addTo(map);
}

// ---------- postcodes ----------
let localPostcodes = null;
async function postcodeTable() {
  if (!localPostcodes) localPostcodes = (await loadJSON("postcodes")) || {};
  return localPostcodes;
}
const normPC = (q) => q.toUpperCase().replace(/\s+/g, "").replace(/^(.+)(\d[A-Z]{2})$/, "$1 $2");
async function lookupPostcode(q) {
  if (!OFFLINE) {
    try {
      const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(q)}`);
      const j = await r.json();
      if (j.result) return { lat: j.result.latitude, lon: j.result.longitude, postcode: j.result.postcode };
    } catch {}
  }
  const table = await postcodeTable();
  const pc = normPC(q);
  if (table[pc]) return { lat: table[pc][0], lon: table[pc][1], postcode: pc };
  // Fall back to the centre of the postcode sector or district (e.g. "KT3 3" or "KT3").
  const prefix = pc.replace(/[A-Z]{2}$/, "").trim();
  for (const pre of [prefix, prefix.split(" ")[0]]) {
    if (!pre) continue;
    const hits = Object.entries(table).filter(([k, v]) => v && (k.startsWith(pre + " ") || k.startsWith(pre)));
    if (hits.length) {
      const lat = hits.reduce((a, [, v]) => a + v[0], 0) / hits.length;
      const lon = hits.reduce((a, [, v]) => a + v[1], 0) / hits.length;
      return { lat, lon, postcode: pre.length < pc.length ? `${pre} (area centre)` : pc };
    }
  }
  return null;
}
async function nearestPostcode(lat, lon) {
  if (!OFFLINE) {
    try {
      const r = await fetch(`https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}&limit=1&radius=300`);
      const j = await r.json();
      if (j.result?.[0]?.postcode) return j.result[0].postcode;
    } catch {}
  }
  const table = await postcodeTable();
  let best = null;
  for (const [k, v] of Object.entries(table)) {
    if (!v) continue;
    const d = distM(lat, lon, v[0], v[1]);
    if (d < 300 && (!best || d < best.d)) best = { k, d };
  }
  return best?.k || null;
}
const schoolLayer = L.layerGroup().addTo(map);
const ringLayer = L.layerGroup().addTo(map);
const homeLayer = L.layerGroup().addTo(map);
const markers = new Map();

function visible(s) {
  if (!state.phases.has(s.phase)) return false;
  if (s.special && !state.showSpecial) return false;
  if (!s.special && s.independent && !state.showIndep) return false;
  if (!s.special && !s.independent && !state.showState) return false;
  if (state.onlyCatch && !state.catchments[s.urn]) return false;
  return s.lat != null;
}

function drawMarkers() {
  schoolLayer.clearLayers();
  markers.clear();
  for (const s of state.schools) {
    if (!visible(s) && state.selected !== s.urn) continue;
    const p = PHASES[s.phase] || PHASES.secondary;
    const big = s.phase !== "primary" && s.phase !== "nursery";
    const m = L.circleMarker([s.lat, s.lon], {
      radius: state.selected === s.urn ? 10 : big ? 7 : 5,
      color: "#fff", weight: 1.5, fillColor: p.hex, fillOpacity: s.independent ? 0.55 : 0.95,
    })
      .bindTooltip(esc(s.name), { direction: "top", offset: [0, -6] })
      .on("click", () => showSchool(s.urn));
    m.addTo(schoolLayer);
    markers.set(s.urn, m);
  }
}

function drawRings(urn) {
  ringLayer.clearLayers();
  const c = state.catchments[urn];
  if (!c) return;
  for (const series of c.series) {
    const years = series.years.filter((y) => y.distance).slice(-5);
    years.forEach((y, i) => {
      const latest = i === years.length - 1;
      const color = RING_COLORS[years.length - 1 - i] || RING_COLORS.at(-1);
      L.circle([series.from.lat, series.from.lon], {
        radius: y.distance, color, weight: latest ? 2.5 : 1.5, dashArray: latest ? null : "5 5",
        fill: latest, fillOpacity: 0.07, fillColor: color, interactive: false,
      }).addTo(ringLayer);
      if (latest) {
        // Label at the top of the latest ring.
        const north = y.distance / 111320;
        L.marker([series.from.lat + north, series.from.lon], {
          interactive: false,
          icon: L.divIcon({ className: "", html: `<span class="ring-label">${y.year}: ${fmtKm(y.distance)}</span>`, iconAnchor: [40, 10] }),
        }).addTo(ringLayer);
      }
    });
  }
}

function setHome(lat, lon, postcode) {
  state.home = { lat, lon, postcode };
  store("home", state.home);
  homeLayer.clearLayers();
  L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="home-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), keyboard: false })
    .bindTooltip(postcode || "Chosen point").addTo(homeLayer);
  L.circle([lat, lon], { radius: AREA_RADIUS, color: "#e11d48", weight: 1, dashArray: "3 4", fill: false, interactive: false }).addTo(homeLayer);
}

map.on("click", async (e) => {
  const { lat, lng } = e.latlng;
  const pc = await nearestPostcode(lat, lng);
  setHome(lat, lng, pc);
  showArea();
});

// ---------- admission chance ----------
function chance(series, d) {
  const yrs = series.years;
  const usable = yrs.filter((y) => y.distance || y.status === "all_offered");
  if (!usable.length) {
    const st = yrs.at(-1)?.status;
    const why = { selective: "Places by test score", faith: "Places by faith criteria", banding: "Places by banding" }[st] || "No distance figure";
    return { cls: "v-na", label: why, inside: 0, total: 0 };
  }
  const inside = usable.filter((y) => y.status === "all_offered" || d <= y.distance).length;
  const latest = usable.at(-1);
  const latestIn = latest.status === "all_offered" || d <= latest.distance;
  let cls = "v-bad", label = "Unlikely";
  if (inside === usable.length) {
    cls = "v-good";
    label = usable.every((y) => y.status === "all_offered") ? "All applicants offered" : "Likely";
  }
  else if (latestIn || inside * 2 >= usable.length) { cls = "v-warn"; label = "Borderline"; }
  return { cls, label, inside, total: usable.length };
}

// ---------- charts ----------
function lineChart(points, { fmt = (v) => v, height = 90 } = {}) {
  const pts = points.filter((p) => p.v != null);
  if (!pts.length) return '<div class="empty">No published figures.</div>';
  const W = 320, H = height, pad = { l: 28, r: 28, t: 16, b: 18 };
  const vs = pts.map((p) => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo; lo -= span * 0.15; hi += span * 0.15;
  const x = (i) => pad.l + (pts.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (pts.length - 1));
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const dots = pts.map((p, i) => `<circle class="pt" cx="${x(i)}" cy="${y(p.v)}" r="3"/>
    <text class="val" x="${x(i)}" y="${y(p.v) - 6}" text-anchor="middle">${esc(fmt(p.v))}</text>
    <text x="${x(i)}" y="${H - 4}" text-anchor="middle">${esc(p.k)}</text>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend chart">
    <line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/>
    <path class="line" d="${path}"/>${dots}</svg>`;
}

// ---------- views ----------
const panel = $("#panel");

function renderHome() {
  state.selected = null;
  ringLayer.clearLayers();
  panel.innerHTML = "";
  panel.append($("#tpl-home").content.cloneNode(true));
  const chips = $("#phase-chips");
  for (const [k, p] of Object.entries(PHASES)) {
    const b = document.createElement("button");
    b.className = "chip"; b.type = "button";
    b.setAttribute("aria-pressed", state.phases.has(k));
    b.innerHTML = `<span class="dot" style="background:${p.color}"></span>${p.label}`;
    b.onclick = () => {
      state.phases.has(k) ? state.phases.delete(k) : state.phases.add(k);
      b.setAttribute("aria-pressed", state.phases.has(k));
      refreshList();
    };
    chips.append(b);
  }
  const bind = (id, key) => {
    const el = $(id);
    el.checked = state[key];
    el.onchange = () => { state[key] = el.checked; refreshList(); };
  };
  bind("#f-state", "showState"); bind("#f-indep", "showIndep");
  bind("#f-special", "showSpecial"); bind("#f-catch", "onlyCatch");
  const sortSel = $("#sort");
  if (state.home && !sortSel.querySelector('option[value="distance"]')) {
    sortSel.insertAdjacentHTML("afterbegin", '<option value="distance">Nearest to you</option>');
  }
  sortSel.value = state.sort || (state.home ? "distance" : "name");
  sortSel.onchange = () => { state.sort = sortSel.value; refreshList(); };
  if (state.home) {
    const btn = document.createElement("button");
    btn.className = "btn ghost small";
    btn.textContent = `Back to area report${state.home.postcode ? ` for ${state.home.postcode}` : ""}`;
    btn.onclick = showArea;
    $(".intro").append(btn);
  }
  refreshList();
  panel.append(footer());
}

// Latest headline results for a school, for lists and tables.
function headline(urn) {
  const k2 = state.results.ks2?.[urn], k4 = state.results.ks4?.[urn], k5 = state.results.ks5?.[urn];
  const last = (o) => (o ? o[Object.keys(o).sort().at(-1)] : null);
  const p = last(k2), g = last(k4), a = last(k5);
  return {
    rwm: p?.rwm ?? null, em5: g?.em5 ?? null, att8: g?.att8 ?? null,
    alevel: a?.grade ?? null, aps: a?.aps ?? null,
    text: [
      p?.rwm != null ? `SATs ${Math.round(p.rwm)}% expected standard` : null,
      g?.em5 != null ? `GCSE ${Math.round(g.em5)}% grade 5+` : null,
      a?.grade ? `A level ${a.grade}` : null,
    ].filter(Boolean).join(" · "),
  };
}

function refreshList() {
  drawMarkers();
  const list = $("#school-list");
  if (!list) return;
  const sortBy = $("#sort")?.value || (state.home ? "distance" : "name");
  let items = state.schools.filter(visible).map((s) => ({
    s, d: state.home ? distM(state.home.lat, state.home.lon, s.lat, s.lon) : null, h: headline(s.urn),
  }));
  const desc = (k) => (a, b) => (b.h[k] ?? -1) - (a.h[k] ?? -1) || a.s.name.localeCompare(b.s.name);
  const sorters = {
    name: (a, b) => a.s.name.localeCompare(b.s.name),
    distance: (a, b) => (a.d ?? 0) - (b.d ?? 0),
    sats: desc("rwm"),
    gcse: desc("em5"),
    alevel: desc("aps"),
  };
  if (sortBy === "sats") items = items.filter((x) => x.h.rwm != null);
  if (sortBy === "gcse") items = items.filter((x) => x.h.em5 != null);
  if (sortBy === "alevel") items = items.filter((x) => x.h.aps != null);
  items.sort(sorters[sortBy] || sorters.name);
  const label = { name: "A to Z", distance: "nearest first", sats: "best primary SATs first", gcse: "best GCSE results first", alevel: "best A-level results first" }[sortBy];
  $("#list-count").textContent = `${items.length} schools · ${label}`;
  list.innerHTML = items.slice(0, 300).map(({ s, d, h }) => `
    <li tabindex="0" data-urn="${s.urn}">
      <span class="dot" style="background:${(PHASES[s.phase] || PHASES.secondary).color}"></span>
      <div><div class="name">${esc(s.name)}</div>
      <div class="meta">${esc(PHASES[s.phase]?.label || "")} · ${esc(s.la)}${s.independent ? " · Independent" : ""}${s.selective ? " · Selective" : ""}${state.catchments[s.urn] ? " · Catchment data" : ""}</div>
      ${h.text ? `<div class="meta results">${esc(h.text)}</div>` : ""}</div>
      ${d != null ? `<div class="right">${fmtKm(d)}</div>` : ""}
    </li>`).join("");
  list.onclick = (e) => { const li = e.target.closest("li"); if (li) showSchool(+li.dataset.urn); };
  list.onkeydown = (e) => { if (e.key === "Enter") { const li = e.target.closest("li"); if (li) showSchool(+li.dataset.urn); } };
  if (!state.schools.length) {
    list.innerHTML = '<li class="empty">School data has not been generated yet. Run the "Refresh data" workflow.</li>';
  }
}

function backButton(label, fn) {
  const b = document.createElement("button");
  b.className = "back"; b.type = "button"; b.textContent = `← ${label}`;
  b.onclick = fn;
  return b;
}

function catchmentCard(s) {
  const c = state.catchments[s.urn];
  if (!c) {
    if (s.phase === "secondary" || s.phase === "all-through") {
      return `<div class="card"><h3>Catchment</h3><div class="empty">No "last distance offered" figures collected for this school yet.</div></div>`;
    }
    return "";
  }
  const home = state.home;
  let html = `<div class="card"><h3>Estimated catchment <span class="small muted">last distance offered</span></h3>`;
  for (const series of c.series) {
    const hasDist = series.years.some((y) => y.distance);
    if (c.series.length > 1 || series.label !== "Distance places") html += `<p class="small"><strong>${esc(series.label)}</strong></p>`;
    if (home && hasDist) {
      const d = distM(home.lat, home.lon, series.from.lat, series.from.lon);
      const ch = chance(series, d);
      html += `<p>Your point is <strong>${fmtKm(d)}</strong> away: <span class="verdict ${ch.cls}">${ch.label}</span>
        <span class="small muted">inside the cut-off in ${ch.inside} of ${ch.total} years</span></p>`;
    }
    if (hasDist) {
      html += lineChart(series.years.filter((y) => y.distance).map((y) => ({ k: y.year, v: y.distance })), { fmt: (v) => (v / 1000).toFixed(2) + "km" });
    }
    html += `<table class="t"><thead><tr><th>Entry year</th><th class="n">Distance</th><th>Note</th></tr></thead><tbody>`;
    for (const y of [...series.years].reverse()) {
      const val = y.distance ? fmtKm(y.distance) : { all_offered: "All offered", selective: "Test", faith: "Faith", banding: "Banding", unclear: "Unclear" }[y.status] || "–";
      const src = state.catchmentSources[y.source];
      html += `<tr><td>${y.year}</td><td class="n">${val}</td><td class="small muted">${esc(y.note || "")}${src ? ` <a href="${esc(src.url)}" target="_blank" rel="noopener">source</a>` : ""}</td></tr>`;
    }
    html += `</tbody></table>`;
  }
  html += `<p class="note">Straight-line distance to the home of the last child offered a place on distance. Siblings, looked-after children and other priority groups are offered first, so the figure changes every year. A guide, not a guarantee.</p></div>`;
  return html;
}

function resultsCard(s) {
  const k2 = state.results.ks2?.[s.urn];
  const k4 = state.results.ks4?.[s.urn];
  const k5 = state.results.ks5?.[s.urn];
  if (!k2 && !k4 && !k5) {
    if (s.phase === "nursery") return "";
    const what = s.phase === "primary" ? "end-of-primary (SATs)" : "GCSE or A-level";
    return `<div class="card"><h3>Results</h3><div class="empty">No published ${what} results found${s.independent ? " (independent schools do not have to report them)" : s.ages?.[1] && s.ages[1] < 11 ? " (infant schools have no year 6)" : ""}.</div></div>`;
  }
  let html = `<div class="card"><h3>Results</h3>`;
  if (k2) {
    const yrs = Object.keys(k2).sort();
    const latest = k2[yrs.at(-1)];
    html += `<p class="small"><strong>End of primary, year 6 SATs</strong> (latest ${yrs.at(-1)})</p><div class="kpis">
      <div class="kpi"><div class="v">${latest.rwm != null ? latest.rwm + "%" : "–"}</div><div class="l">Expected standard in reading, writing and maths</div></div>
      <div class="kpi"><div class="v">${latest.rwmHigh != null ? latest.rwmHigh + "%" : "–"}</div><div class="l">Higher standard</div></div>
      ${latest.read != null || latest.maths != null ? `<div class="kpi"><div class="v">${latest.read ?? "–"} / ${latest.maths ?? "–"}</div><div class="l">Reading / maths score (100 = expected)</div></div>` : ""}
    </div>
    <p class="small muted">Expected standard in reading, writing and maths by year</p>${lineChart(yrs.map((y) => ({ k: y, v: k2[y].rwm })), { fmt: (v) => Math.round(v) + "%" })}`;
  }
  if (k4) {
    const yrs = Object.keys(k4).sort();
    const latest = k4[yrs.at(-1)];
    html += `<p class="small"><strong>GCSE</strong> (latest ${yrs.at(-1)})</p><div class="kpis">
      <div class="kpi"><div class="v">${latest.att8 ?? "–"}</div><div class="l">Attainment 8</div></div>
      <div class="kpi"><div class="v">${latest.em5 != null ? latest.em5 + "%" : "–"}</div><div class="l">Grade 5+ English &amp; maths</div></div>
      ${latest.p8 != null ? `<div class="kpi"><div class="v">${latest.p8 > 0 ? "+" : ""}${latest.p8}</div><div class="l">Progress 8</div></div>` : ""}
    </div>
    <p class="small muted">Attainment 8 by year</p>${lineChart(yrs.map((y) => ({ k: y, v: k4[y].att8 })), { fmt: (v) => v.toFixed(1) })}
    <p class="small muted">Grade 5+ in English and maths by year</p>${lineChart(yrs.map((y) => ({ k: y, v: k4[y].em5 })), { fmt: (v) => Math.round(v) + "%" })}`;
  }
  if (k5) {
    const yrs = Object.keys(k5).sort();
    const latest = k5[yrs.at(-1)];
    html += `<p class="small" style="margin-top:12px"><strong>A level</strong> (latest ${yrs.at(-1)})</p><div class="kpis">
      <div class="kpi"><div class="v">${latest.grade ?? latest.aps ?? "–"}</div><div class="l">Average grade${latest.aps != null ? ` (${latest.aps} points)` : ""}</div></div>
      ${latest.aab != null ? `<div class="kpi"><div class="v">${latest.aab}%</div><div class="l">AAB+ (2 facilitating)</div></div>` : ""}
      ${latest.students != null ? `<div class="kpi"><div class="v">${latest.students}</div><div class="l">A-level students</div></div>` : ""}
    </div>
    <p class="small muted">Average points per A-level entry (A* = 60, A = 50, B = 40)</p>${lineChart(yrs.map((y) => ({ k: y, v: k5[y].aps })), { fmt: (v) => v.toFixed(1) })}`;
  }
  html += `<p class="note">Year shown is the summer the tests or exams were sat. Progress 8 is not published for 2025 and 2026. Source: DfE.</p></div>`;
  return html;
}

function showSchool(urn) {
  const s = state.byUrn.get(urn);
  if (!s) return;
  state.selected = urn;
  drawMarkers();
  drawRings(urn);
  const c = state.catchments[urn];
  const latestRing = c?.series[0]?.years.filter((y) => y.distance).at(-1);
  const zoomTo = L.latLng(s.lat, s.lon);
  if (latestRing) map.fitBounds(zoomTo.toBounds(latestRing.distance * 2.3), { maxZoom: 15 });
  else map.setView(zoomTo, Math.max(map.getZoom(), 14));

  panel.innerHTML = "";
  panel.append(backButton(state.home ? "Back to area report" : "All schools", state.home ? showArea : renderHome));
  const badges = [
    PHASES[s.phase]?.label, s.ages ? `Ages ${s.ages[0]}–${s.ages[1]}` : null, s.gender && s.gender !== "Mixed" ? s.gender : "Mixed",
    s.selective ? "Selective" : null, s.religion && !/does not apply|none/i.test(s.religion) ? s.religion : null,
    s.independent ? "Independent" : null, s.sixthForm ? "Sixth form" : null, s.type,
  ].filter(Boolean);
  const div = document.createElement("div");
  div.innerHTML = `
    <h1>${esc(s.name)}</h1>
    <div class="badges">${badges.map((b) => `<span class="badge">${esc(b)}</span>`).join("")}</div>
    <p class="small muted">${esc([s.address, s.postcode].filter(Boolean).join(", "))}</p>
    ${state.home ? `<p class="small">${fmtKm(distM(state.home.lat, state.home.lon, s.lat, s.lon))} from ${esc(state.home.postcode || "your point")}</p>` : ""}
    <div class="kpis">
      ${s.pupils ? `<div class="kpi"><div class="v">${s.pupils.toLocaleString()}</div><div class="l">Pupils${s.capacity ? ` of ${s.capacity.toLocaleString()} places` : ""}</div></div>` : ""}
      ${s.fsm != null ? `<div class="kpi"><div class="v">${s.fsm}%</div><div class="l">Free school meals</div></div>` : ""}
    </div>
    ${catchmentCard(s)}
    ${resultsCard(s)}
    <div class="links">
      ${s.website ? `<a class="btn ghost small" href="${esc(/^https?:/.test(s.website) ? s.website : "https://" + s.website)}" target="_blank" rel="noopener">School website</a>` : ""}
      <a class="btn ghost small" href="https://get-information-schools.service.gov.uk/Establishments/Establishment/Details/${s.urn}" target="_blank" rel="noopener">DfE record</a>
      <a class="btn ghost small" href="https://reports.ofsted.gov.uk/search?q=${s.urn}" target="_blank" rel="noopener">Ofsted reports</a>
    </div>`;
  panel.append(div, footer());
  panel.scrollTop = 0;
}

async function showArea() {
  const h = state.home;
  if (!h) return renderHome();
  state.selected = null;
  ringLayer.clearLayers();
  drawMarkers();
  map.fitBounds(L.latLng(h.lat, h.lon).toBounds(AREA_RADIUS * 6));

  panel.innerHTML = "";
  panel.append(backButton("All schools", renderHome));
  const head = document.createElement("div");
  head.innerHTML = `<h1>Around ${esc(h.postcode || "your point")}</h1>
    <p class="small muted">Schools you could get into, and what the area is like within ${AREA_RADIUS} m.</p>`;
  panel.append(head);

  // Secondary schools with catchment data, ranked by chance then distance.
  const rows = [];
  for (const [urn, c] of Object.entries(state.catchments)) {
    const s = state.byUrn.get(+urn);
    if (!s) continue;
    const series = c.series[0];
    const d = distM(h.lat, h.lon, series.from.lat, series.from.lon);
    const ch = chance(series, d);
    const extra = c.series.slice(1).map((x) => ({ x, d: distM(h.lat, h.lon, x.from.lat, x.from.lon) }))
      .map(({ x, d }) => ({ label: x.label, ch: chance(x, d) })).find((e) => e.ch.cls === "v-good" || e.ch.cls === "v-warn");
    rows.push({ s, d: distM(h.lat, h.lon, s.lat, s.lon), ch, extra });
  }
  const rank = { "v-good": 0, "v-warn": 1, "v-bad": 2, "v-na": 3 };
  rows.sort((a, b) => Math.min(rank[a.ch.cls], a.extra ? rank[a.extra.ch.cls] : 9) - Math.min(rank[b.ch.cls], b.extra ? rank[b.extra.ch.cls] : 9) || a.d - b.d);
  const sec = document.createElement("div");
  sec.className = "card";
  sec.innerHTML = `<h3>Secondary schools: your chances</h3>
    ${rows.length ? `<table class="t"><thead><tr><th>School</th><th class="n">Distance</th><th>Chance</th></tr></thead><tbody>
    ${rows.slice(0, 14).map((r) => `<tr data-urn="${r.s.urn}" style="cursor:pointer">
      <td><a href="#" data-urn="${r.s.urn}">${esc(r.s.name)}</a>${headline(r.s.urn).text ? `<div class="small muted">${esc(headline(r.s.urn).text)}</div>` : ""}${r.extra ? `<div class="small muted">${esc(r.extra.label)}: ${r.extra.ch.label}</div>` : ""}</td>
      <td class="n">${fmtKm(r.d)}</td><td><span class="verdict ${r.ch.cls}">${r.ch.label}</span></td></tr>`).join("")}
    </tbody></table>` : '<div class="empty">Catchment data has not been generated yet.</div>'}
    <p class="note">Based on councils' "last distance offered" over the last 3 to 5 years. Grammar and faith schools allocate by test or faith, so check their admissions rules.</p>`;
  sec.onclick = (e) => { const t = e.target.closest("[data-urn]"); if (t) { e.preventDefault(); showSchool(+t.dataset.urn); } };
  panel.append(sec);

  // Nearest primaries (no catchment figures collected yet).
  const prim = state.schools.filter((s) => s.phase === "primary" && !s.independent && !s.special && s.lat)
    .map((s) => ({ s, d: distM(h.lat, h.lon, s.lat, s.lon) })).sort((a, b) => a.d - b.d).slice(0, 5);
  if (prim.length) {
    const p = document.createElement("div");
    p.className = "card";
    p.innerHTML = `<h3>Nearest state primary schools</h3><table class="t"><tbody>
      ${prim.map(({ s, d }) => `<tr><td><a href="#" data-urn="${s.urn}">${esc(s.name)}</a></td><td class="n">${fmtKm(d)}</td></tr>`).join("")}
      </tbody></table><p class="note">Primary catchment figures are the next step for this pilot.</p>`;
    p.onclick = (e) => { const t = e.target.closest("[data-urn]"); if (t) { e.preventDefault(); showSchool(+t.dataset.urn); } };
    panel.append(p);
  }

  const crimeEl = document.createElement("div"); crimeEl.className = "card"; crimeEl.innerHTML = "<h3>Crime</h3><p class='muted small'>Loading…</p>";
  const priceEl = document.createElement("div"); priceEl.className = "card"; priceEl.innerHTML = "<h3>Sold prices</h3><p class='muted small'>Loading…</p>";
  const covEl = document.createElement("div"); covEl.className = "card"; covEl.innerHTML = "<h3>Mobile signal</h3><p class='muted small'>Loading…</p>";
  const linkEl = document.createElement("div"); linkEl.className = "card";
  linkEl.innerHTML = portalLinks(h);
  panel.append(priceEl, crimeEl, covEl, linkEl, footer());
  panel.scrollTop = 0;

  renderCrime(crimeEl, h);
  renderPrices(priceEl, h);
  renderCoverage(covEl, h);
}

function portalLinks(h) {
  const out = (h.postcode || "").split(" ")[0];
  if (!out) return `<h3>Homes for sale</h3><div class="empty">Search a postcode to get links to property portals.</div>`;
  return `<h3>Homes for sale near ${esc(out)}</h3>
    <div class="links">
      <a class="btn small" href="https://www.rightmove.co.uk/property-for-sale/${encodeURIComponent(out.toUpperCase())}.html" target="_blank" rel="noopener">Rightmove</a>
      <a class="btn small" href="https://www.zoopla.co.uk/for-sale/property/${encodeURIComponent(out.toLowerCase())}/?q=${encodeURIComponent(h.postcode)}&radius=0.5" target="_blank" rel="noopener">Zoopla</a>
    </div>
    <p class="note">Live listings open on the portal's own site.</p>`;
}

// ---------- crime ----------
function crimeAround(crime, lat, lon, radius) {
  const [oLat, oLon] = crime.origin, [cLat, cLon] = crime.cell;
  const ci = Math.floor((lat - oLat) / cLat), cj = Math.floor((lon - oLon) / cLon);
  const ri = Math.ceil(radius / 111320 / cLat) + 1, rj = Math.ceil(radius / 69500 / cLon) + 1;
  const months = new Array(crime.months.length).fill(0);
  const cats = new Array(crime.categories.length).fill(0);
  for (let i = ci - ri; i <= ci + ri; i++) {
    for (let j = cj - rj; j <= cj + rj; j++) {
      const cell = crime.cells[`${i},${j}`];
      if (!cell) continue;
      const clat = oLat + (i + 0.5) * cLat, clon = oLon + (j + 0.5) * cLon;
      if (distM(lat, lon, clat, clon) > radius) continue;
      cell[0].forEach((v, k) => (months[k] += v));
      cell[1].forEach((v, k) => (cats[k] += v));
    }
  }
  return { months, cats };
}

let typicalCrime = null;
function crimeTypical(crime) {
  if (typicalCrime != null) return typicalCrime;
  // Typical 12-month count for a circle this size: median over school locations.
  const n = crime.months.length;
  const totals = state.schools.filter((s) => s.lat).map((s) => {
    const { months } = crimeAround(crime, s.lat, s.lon, AREA_RADIUS);
    return months.slice(n - 12).reduce((a, b) => a + b, 0);
  });
  typicalCrime = median(totals);
  return typicalCrime;
}

async function renderCrime(el, h) {
  const crime = await getLazy("crime");
  if (!crime) { el.innerHTML = "<h3>Crime</h3><div class='empty'>Crime data has not been generated yet.</div>"; return; }
  const { months, cats } = crimeAround(crime, h.lat, h.lon, AREA_RADIUS);
  const n = months.length;
  const sum = (a, b) => months.slice(Math.max(0, a), b).reduce((x, y) => x + y, 0);
  const last12 = sum(n - 12, n), prev12 = sum(n - 24, n - 12), prev24 = sum(n - 36, n - 24);
  const typical = crimeTypical(crime);
  const vsTyp = typical ? last12 / typical : null;
  const cls = vsTyp == null ? "v-na" : vsTyp < 0.8 ? "v-good" : vsTyp <= 1.25 ? "v-warn" : "v-bad";
  const lbl = vsTyp == null ? "" : vsTyp < 0.8 ? "Below typical" : vsTyp <= 1.25 ? "About typical" : "Above typical";
  const change = prev12 ? Math.round(((last12 - prev12) / prev12) * 100) : null;
  const top = crime.categories.map((c, i) => ({ c, v: cats[i] })).filter((x) => x.v).sort((a, b) => b.v - a.v).slice(0, 6);
  const maxV = top[0]?.v || 1;
  const yearLabel = (end) => crime.months[end - 1]?.slice(0, 7);
  el.innerHTML = `<h3>Crime within ${AREA_RADIUS} m <span class="verdict ${cls}">${lbl}</span></h3>
    <div class="kpis">
      <div class="kpi"><div class="v">${last12.toLocaleString()}</div><div class="l">Crimes, last 12 months</div></div>
      <div class="kpi"><div class="v">${change == null ? "–" : (change > 0 ? "+" : "") + change + "%"}</div><div class="l">vs previous 12 months</div></div>
      <div class="kpi"><div class="v">${typical != null ? Math.round(typical).toLocaleString() : "–"}</div><div class="l">Typical for the pilot area</div></div>
    </div>
    <p class="small muted">12-month totals, to the month shown</p>
    ${lineChart([{ k: yearLabel(n - 24), v: n >= 36 ? prev24 : null }, { k: yearLabel(n - 12), v: n >= 24 ? prev12 : null }, { k: yearLabel(n), v: last12 }], { fmt: (v) => v.toLocaleString() })}
    <p class="small muted">Most common, last 12 months</p>
    <div class="bars">${top.map((t) => `<div class="bar"><div class="lab"><span>${esc(catLabel(t.c))}</span><span>${t.v}</span></div><div class="track"><div class="fill" style="width:${(t.v / maxV) * 100}%"></div></div></div>`).join("")}</div>
    <p class="note">police.uk street-level data, ${esc(crime.months[0])} to ${esc(crime.months.at(-1))}. Locations are approximate by design. A busy high street or station nearby raises the count.</p>`;
}

// ---------- prices ----------
async function renderPrices(el, h) {
  const sales = await getLazy("sales");
  if (!sales) { el.innerHTML = "<h3>Sold prices</h3><div class='empty'>Sold price data has not been generated yet.</div>"; return; }
  const near = sales.rows.filter((r) => Math.abs(r[0] - h.lat) < 0.006 && Math.abs(r[1] - h.lon) < 0.01 && distM(h.lat, h.lon, r[0], r[1]) <= AREA_RADIUS);
  if (!near.length) { el.innerHTML = `<h3>Sold prices within ${AREA_RADIUS} m</h3><div class="empty">No recorded sales nearby.</div>`; return; }
  const latestDate = sales.rows[0][3];
  const cutoff = new Date(latestDate); cutoff.setFullYear(cutoff.getFullYear() - 2);
  const recent = near.filter((r) => new Date(r[3]) >= cutoff);
  const byType = {};
  for (const r of recent) (byType[r[4]] ||= []).push(r[2]);
  const byYear = {};
  for (const r of near) (byYear[r[3].slice(0, 4)] ||= []).push(r[2]);
  const types = sales.types;
  el.innerHTML = `<h3>Sold prices within ${AREA_RADIUS} m</h3>
    <div class="kpis">
      <div class="kpi"><div class="v">${fmtGBP(median(recent.map((r) => r[2])))}</div><div class="l">Median, last 2 years</div></div>
      <div class="kpi"><div class="v">${recent.length}</div><div class="l">Sales, last 2 years</div></div>
    </div>
    <table class="t"><thead><tr><th>Type</th><th class="n">Median</th><th class="n">Sales</th></tr></thead><tbody>
      ${Object.entries(byType).sort((a, b) => b[1].length - a[1].length).map(([t, v]) => `<tr><td>${esc(types[t] || t)}</td><td class="n">${fmtGBP(median(v))}</td><td class="n">${v.length}</td></tr>`).join("")}
    </tbody></table>
    <p class="small muted" style="margin-top:10px">Median sold price by year (all types)</p>
    ${lineChart(Object.keys(byYear).sort().map((y) => ({ k: y, v: median(byYear[y]) })), { fmt: fmtGBP })}
    <p class="small muted">Latest sales</p>
    <table class="t"><tbody>${near.slice(0, 8).map((r) => `<tr><td>${esc(r[7])}<div class="small muted">${esc(types[r[4]] || r[4])}${r[5] ? " · new build" : ""} · ${r[6] === "L" ? "leasehold" : "freehold"}</div></td><td class="n">${fmtGBP(r[2])}<div class="small muted">${esc(r[3])}</div></td></tr>`).join("")}</tbody></table>
    <p class="note">${esc(sales.attribution)} Sales to ${esc(latestDate)}.</p>`;
}

// ---------- coverage ----------
const OPERATORS = { EE: "EE", H3: "Three", TF: "O2", VO: "Vodafone" };
async function renderCoverage(el, h) {
  const cov = await getLazy("coverage");
  if (!cov || !Object.keys(cov.postcodes || {}).length) {
    el.innerHTML = `<h3>Mobile signal</h3><div class="empty">Coverage data is not loaded yet. It needs a free Ofcom API key added to the repository.</div>
      <p class="note"><a href="https://www.ofcom.org.uk/mobile-coverage-checker" target="_blank" rel="noopener">Check on Ofcom's coverage checker</a></p>`;
    return;
  }
  let best = null;
  for (const [pc, v] of Object.entries(cov.postcodes)) {
    const d = distM(h.lat, h.lon, v[0], v[1]);
    if (!best || d < best.d) best = { pc, v, d };
  }
  if (!best || best.d > 400) { el.innerHTML = "<h3>Mobile signal</h3><div class='empty'>No coverage figures for this spot yet.</div>"; return; }
  // Group fields like "EE4GDataIndoor" into operator rows.
  const rows = {};
  cov.fields.forEach((f, i) => {
    const op = Object.keys(OPERATORS).find((o) => f.startsWith(o));
    if (!op) return;
    (rows[op] ||= {})[f.slice(op.length)] = best.v[i + 2];
  });
  const cols = [...new Set(Object.values(rows).flatMap((r) => Object.keys(r)))].filter((c) => /data/i.test(c)).sort();
  el.innerHTML = `<h3>Mobile signal at ${esc(best.pc)}</h3>
    <table class="t"><thead><tr><th>Operator</th>${cols.map((c) => `<th class="n">${esc(c.replace(/([a-z])([A-Z])/g, "$1 $2"))}</th>`).join("")}</tr></thead>
    <tbody>${Object.entries(rows).map(([op, r]) => `<tr><td>${OPERATORS[op]}</td>${cols.map((c) => `<td class="n">${r[c] ?? "–"}</td>`).join("")}</tr>`).join("")}</tbody></table>
    <p class="note">Ofcom's predicted coverage score averaged over addresses in the postcode (higher is better). Predicted, not measured.</p>`;
}

function footer() {
  const f = document.createElement("div");
  f.className = "footer";
  f.innerHTML = `Pilot covering Sutton and Kingston upon Thames. Data: DfE (Get Information about Schools, Explore Education Statistics), council admissions booklets, police.uk, HM Land Registry, Ofcom, postcodes.io. Contains public sector information licensed under the Open Government Licence v3.0.`;
  return f;
}

// ---------- search ----------
$("#search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#postcode").value.trim();
  const msg = $("#search-msg");
  msg.hidden = true;
  if (!q) return;
  const hit = await lookupPostcode(q);
  if (!hit) {
    msg.textContent = OFFLINE
      ? `${q.toUpperCase()} isn't in the preview's postcode list. Try a Sutton or Kingston postcode such as KT3 3NU or SM2 6AA, or tap the map.`
      : `Couldn't find ${q.toUpperCase()}. Check the postcode, or tap the map instead.`;
    msg.hidden = false;
    return;
  }
  setHome(hit.lat, hit.lon, hit.postcode);
  showArea();
});

// ---------- boot ----------
(async function init() {
  const [schools, catchments, results] = await Promise.all([loadJSON("schools"), loadJSON("catchments"), loadJSON("results")]);
  state.schools = schools?.schools || [];
  state.byUrn = new Map(state.schools.map((s) => [s.urn, s]));
  state.catchments = catchments?.schools || {};
  state.catchmentSources = catchments?.sources || {};
  if (results) state.results = results;
  if (state.schools.length) {
    const b = L.latLngBounds(state.schools.filter((s) => s.lat).map((s) => [s.lat, s.lon]));
    map.fitBounds(b, { padding: [20, 20] });
  }
  const params = new URLSearchParams(location.search);
  const saved = restore("home");
  if (params.get("school")) {
    renderHome();
    showSchool(+params.get("school"));
  } else if (saved?.lat) {
    setHome(saved.lat, saved.lon, saved.postcode);
    showArea();
  } else {
    renderHome();
  }
})();
