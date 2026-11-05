// School Finder: a static site, no build step. School data comes from ./data/*.json,
// produced by the pipeline in /pipeline (see README). Schools, results and Ofsted cover
// England and are split into map tiles; crime and sold prices are asked for live from
// police.uk and HM Land Registry when someone looks at an area.

const PHASES = {
  primary: { label: "Primary", color: "var(--primary)", hex: "#2563eb" },
  secondary: { label: "Secondary", color: "var(--secondary)", hex: "#0f766e" },
  "all-through": { label: "All-through", color: "var(--through)", hex: "#c2410c" },
  "sixth-form": { label: "Sixth form", color: "var(--sixth)", hex: "#7c3aed" },
  nursery: { label: "Nursery", color: "var(--nursery)", hex: "#be185d" },
};
const AREA_RADIUS = 500; // metres, for crime and sold prices around a point
const MIN_ZOOM = 11;     // schools are loaded and drawn from this zoom level in
const ENGLAND = [[49.9, -6.4], [55.85, 1.8]];
const RING_COLORS = ["#0f766e", "#14b8a6", "#5eead4", "#99f6e4", "#ccfbf1"];

const state = {
  schools: [],
  byUrn: new Map(),
  catchments: {},
  catchmentSources: {},
  results: { ks2: {}, ks4: {}, ks5: {} },
  ofsted: {},
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
  // A sandboxed preview passes its data in window.SF_DATA instead of files.
  if (window.SF_DATA) return window.SF_DATA[name] ?? null;
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
const map = L.map("map", { zoomControl: true, preferCanvas: true }).fitBounds(ENGLAND);
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
      const k = Math.min(2.6, Math.max(0.4, (z - 11) * 0.8));
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

// ---------- tiles ----------
// England is split into square tiles (see pipeline/tiles.py); only the ones in view load.
const tiles = { index: null, loaded: new Map() };
function tileKeys(bounds) {
  const d = tiles.index?.tileDeg || 0.25;
  const keys = [];
  for (let i = Math.floor(bounds.getSouth() / d); i <= Math.floor(bounds.getNorth() / d); i++)
    for (let j = Math.floor(bounds.getWest() / d); j <= Math.floor(bounds.getEast() / d); j++)
      if (tiles.index?.tiles?.[`${i}_${j}`]) keys.push(`${i}_${j}`);
  return keys;
}
function addTile(t) {
  if (!t) return;
  for (const s of t.schools) {
    if (state.byUrn.has(s.urn)) continue;
    state.schools.push(s);
    state.byUrn.set(s.urn, s);
  }
  for (const ks of ["ks2", "ks4", "ks5"]) Object.assign(state.results[ks], t[ks] || {});
  Object.assign(state.ofsted, t.ofsted || {});
}
function loadTile(key) {
  if (!tiles.loaded.has(key)) tiles.loaded.set(key, loadJSON(`tiles/${key}`).then(addTile));
  return tiles.loaded.get(key);
}
async function ensureTiles(bounds) {
  await Promise.all(tileKeys(bounds).map(loadTile));
}
const ensureAround = (lat, lon, m = 6000) => ensureTiles(L.latLng(lat, lon).toBounds(m * 2));
const inView = (s, b) => s.lat != null && b.contains([s.lat, s.lon]);

function drawMarkers() {
  schoolLayer.clearLayers();
  markers.clear();
  if (map.getZoom() < MIN_ZOOM - 1 && !state.selected) return;
  const b = map.getBounds().pad(0.3);
  for (const s of state.schools) {
    if (!inView(s, b)) continue;
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

let moveTimer = null;
map.on("moveend", () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(async () => {
    if (map.getZoom() >= MIN_ZOOM) await ensureTiles(map.getBounds().pad(0.2));
    if ($("#school-list")) refreshList(); else drawMarkers();
  }, 150);
});

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
    short: [
      p?.rwm != null ? `SATs ${Math.round(p.rwm)}%` : null,
      g?.em5 != null ? `GCSE ${Math.round(g.em5)}%` : null,
      a?.grade ? `A level ${a.grade}` : null,
    ].filter(Boolean).join(" · "),
  };
}

function refreshList() {
  drawMarkers();
  const list = $("#school-list");
  if (!list) return;
  const sortBy = $("#sort")?.value || (state.home ? "distance" : "name");
  const zoomedOut = map.getZoom() < MIN_ZOOM;
  const view = map.getBounds();
  let items = (zoomedOut ? [] : state.schools.filter((s) => inView(s, view) && visible(s))).map((s) => ({
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
  $("#list-count").textContent = zoomedOut ? "Schools" : `${items.length} schools in view · ${label}`;
  list.innerHTML = items.slice(0, 300).map(({ s, d, h }) => `
    <li tabindex="0" data-urn="${s.urn}">
      <span class="dot" style="background:${(PHASES[s.phase] || PHASES.secondary).color}"></span>
      <div><div class="name">${esc(s.name)}</div>
      <div class="meta">${esc(PHASES[s.phase]?.label || "")} · ${esc(s.town || s.la)}${s.independent ? " · Independent" : ""}${s.selective ? " · Selective" : ""}${state.catchments[s.urn] ? " · Catchment data" : ""}</div>
      ${h.text || ofstedShort(s.urn) ? `<div class="meta results">${esc([h.text, ofstedShort(s.urn)].filter(Boolean).join(" · "))}</div>` : ""}</div>
      ${d != null ? `<div class="right">${fmtKm(d)}</div>` : ""}
    </li>`).join("");
  list.onclick = (e) => { const li = e.target.closest("li"); if (li) showSchool(+li.dataset.urn); };
  list.onkeydown = (e) => { if (e.key === "Enter") { const li = e.target.closest("li"); if (li) showSchool(+li.dataset.urn); } };
  if (!tiles.index) {
    list.innerHTML = '<li class="empty">School data has not been generated yet. Run the "Refresh data" workflow.</li>';
  } else if (zoomedOut) {
    list.innerHTML = `<li class="empty">Search for a postcode, town or school, or zoom in on the map, to list the schools there. ${tiles.index.schools.toLocaleString()} schools across England.</li>`;
  } else if (!items.length) {
    list.innerHTML = '<li class="empty">No schools match these filters in this part of the map.</li>';
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
      return `<div class="card"><h3>Catchment</h3><div class="empty">No "last distance offered" figures collected for this school yet. Catchment estimates cover Sutton and Kingston upon Thames so far; elsewhere, check the council's admissions booklet.</div></div>`;
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

// ---------- Ofsted ----------
const GRADE_CLASS = {
  Outstanding: "v-good", Good: "v-good", Exceptional: "v-good", "Strong standard": "v-good", Met: "v-good",
  "Expected standard": "v-na", "Requires improvement": "v-warn", "Needs attention": "v-warn",
  Inadequate: "v-bad", "Urgent improvement": "v-bad", "Not met": "v-bad",
};
const gradeClass = (g) => GRADE_CLASS[g] || Object.entries(GRADE_CLASS).find(([k]) => g?.toLowerCase().startsWith(k.toLowerCase()))?.[1] || "v-na";
function ofstedShort(urn) {
  const o = state.ofsted[urn];
  if (!o) return "";
  const yr = o.date ? o.date.slice(0, 4) : "";
  if (o.g.overall) return `Ofsted ${o.g.overall}${yr ? ` (${yr})` : ""}`;
  return o.scheme === "report-card" ? `Ofsted report card${yr ? ` ${yr}` : ""}` : `Ofsted inspected${yr ? ` ${yr}` : ""}`;
}
function ofstedCard(s) {
  const o = state.ofsted[s.urn];
  const link = `<a href="https://reports.ofsted.gov.uk/search?q=${s.urn}" target="_blank" rel="noopener">Read the reports on Ofsted</a>`;
  if (!o) {
    if (s.independent) return `<div class="card"><h3>Inspection</h3><div class="empty">Independent schools are inspected by Ofsted or the Independent Schools Inspectorate; their outcomes are not in Ofsted's state school file.</div><p class="note">${link}</p></div>`;
    return `<div class="card"><h3>Ofsted</h3><div class="empty">No inspection outcome in Ofsted's latest file (new schools often have not been inspected yet).</div><p class="note">${link}</p></div>`;
  }
  const labels = tiles.index?.ofstedLabels || {};
  const rows = Object.entries(o.g).map(([k, g]) => `<tr><td>${esc(labels[k] || k)}</td><td><span class="verdict ${gradeClass(g)}">${esc(g)}</span></td></tr>`).join("");
  const scheme = o.scheme === "report-card"
    ? "Report card (the 5-point scale used since November 2025)."
    : o.g.overall ? "Graded inspection with an overall grade (used until August 2024)."
    : "Graded inspection without an overall grade (September 2024 to November 2025).";
  return `<div class="card"><h3>Ofsted${o.date ? ` <span class="small muted">inspected ${esc(o.date)}</span>` : ""}</h3>
    <table class="t"><tbody>${rows}</tbody></table>
    <p class="note">${scheme} ${link}.</p></div>`;
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
    ${ofstedCard(s)}
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
  map.fitBounds(L.latLng(h.lat, h.lon).toBounds(AREA_RADIUS * 6));
  panel.innerHTML = '<p class="muted small">Loading schools…</p>';
  await ensureAround(h.lat, h.lon);
  drawMarkers();

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
    if (!s || distM(h.lat, h.lon, s.lat, s.lon) > 8000) continue;
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
  if (!rows.length) {
    // Outside the catchment pilot: nearest state secondaries with results and Ofsted.
    const near = state.schools.filter((s) => (s.phase === "secondary" || s.phase === "all-through") && !s.independent && !s.special && s.lat)
      .map((s) => ({ s, d: distM(h.lat, h.lon, s.lat, s.lon) })).sort((a, b) => a.d - b.d).slice(0, 8);
    sec.innerHTML = `<h3>Nearest state secondary schools</h3>
      ${near.length ? `<table class="t"><thead><tr><th>School</th><th class="n">Distance</th></tr></thead><tbody>
      ${near.map(({ s, d }) => `<tr><td><a href="#" data-urn="${s.urn}">${esc(s.name)}</a>
        <div class="small muted">${esc([headline(s.urn).short, ofstedShort(s.urn), s.selective ? "Selective" : null, s.religion].filter(Boolean).join(" · "))}</div></td>
        <td class="n">${fmtKm(d)}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">No state secondary schools found within 6 km.</div>'}
      <p class="note">Catchment estimates ("last distance offered") cover Sutton and Kingston upon Thames so far. Councils publish these figures in their admissions booklets, and we are adding areas one by one.</p>`;
  } else sec.innerHTML = `<h3>Secondary schools: your chances</h3>
    ${rows.length ? `<table class="t"><thead><tr><th>School</th><th class="n">Distance</th><th>Chance</th></tr></thead><tbody>
    ${rows.slice(0, 14).map((r) => `<tr data-urn="${r.s.urn}" style="cursor:pointer">
      <td><a href="#" data-urn="${r.s.urn}">${esc(r.s.name)}</a>${headline(r.s.urn).short || ofstedShort(r.s.urn) ? `<div class="small muted">${esc([headline(r.s.urn).short, ofstedShort(r.s.urn)].filter(Boolean).join(" · "))}</div>` : ""}${r.extra ? `<div class="small muted">${esc(r.extra.label)}: ${r.extra.ch.label}</div>` : ""}</td>
      <td class="n">${fmtKm(r.d)}</td><td><span class="verdict ${r.ch.cls}">${r.ch.label}</span></td></tr>`).join("")}
    </tbody></table>` : '<div class="empty">Catchment data has not been generated yet.</div>'}
    <p class="note">GCSE is the share of pupils with grade 5 or above in English and maths. Chances are based on councils' "last distance offered" over the last 3 to 5 years. Grammar and faith schools allocate by test or faith, so check their admissions rules.</p>`;
  sec.onclick = (e) => { const t = e.target.closest("[data-urn]"); if (t) { e.preventDefault(); showSchool(+t.dataset.urn); } };
  panel.append(sec);

  // Nearest primaries (no catchment figures collected yet).
  const prim = state.schools.filter((s) => s.phase === "primary" && !s.independent && !s.special && s.lat)
    .map((s) => ({ s, d: distM(h.lat, h.lon, s.lat, s.lon) })).sort((a, b) => a.d - b.d).slice(0, 5);
  if (prim.length) {
    const p = document.createElement("div");
    p.className = "card";
    p.innerHTML = `<h3>Nearest state primary schools</h3><table class="t"><tbody>
      ${prim.map(({ s, d }) => `<tr><td><a href="#" data-urn="${s.urn}">${esc(s.name)}</a>${headline(s.urn).short || ofstedShort(s.urn) ? `<div class="small muted">${esc([headline(s.urn).short, ofstedShort(s.urn)].filter(Boolean).join(" · "))}</div>` : ""}</td><td class="n">${fmtKm(d)}</td></tr>`).join("")}
      </tbody></table><p class="note">Primary catchment figures are not collected yet.</p>`;
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
// Live: police.uk is asked for each of the last 36 months inside a small square around the
// point, and crimes further than AREA_RADIUS are dropped. Offline (the sandboxed preview),
// the precomputed pilot grid in data/crime.json is used instead.
const POLICE = "https://data.police.uk/api";
const liveCache = new Map();
function boxAround(lat, lon, m) {
  const dLat = m / 111320, dLon = m / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
async function liveCrime(lat, lon) {
  const key = `crime:${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (liveCache.has(key)) return liveCache.get(key);
  const job = (async () => {
    const dates = await (await fetch(`${POLICE}/crimes-street-dates`)).json();
    const ms = [...new Set(dates.map((d) => d.date))].sort().slice(-36);
    const [s, w, n, e] = boxAround(lat, lon, AREA_RADIUS);
    const poly = `${s.toFixed(5)},${w.toFixed(5)}:${s.toFixed(5)},${e.toFixed(5)}:${n.toFixed(5)},${e.toFixed(5)}:${n.toFixed(5)},${w.toFixed(5)}`;
    const cats = {};
    // Four at a time keeps well under police.uk's limit of 15 requests a second.
    const months = await pool(ms, 4, async (m, i) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await fetch(`${POLICE}/crimes-street/all-crime?poly=${poly}&date=${m}`);
        if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1))); continue; }
        if (!r.ok) return null;
        let c = 0;
        for (const x of await r.json()) {
          const la = +x.location?.latitude, lo = +x.location?.longitude;
          if (!la || distM(lat, lon, la, lo) > AREA_RADIUS) continue;
          c++;
          if (i >= ms.length - 12) cats[x.category] = (cats[x.category] || 0) + 1;
        }
        return c;
      }
      return null;
    });
    if (months.every((v) => v == null)) throw new Error("police.uk returned nothing");
    return { labels: ms, months: months.map((v) => v ?? 0), cats, gaps: months.filter((v) => v == null).length, live: true };
  })();
  liveCache.set(key, job);
  job.catch(() => liveCache.delete(key));
  return job;
}
function crimeAround(crime, lat, lon, radius) {
  const [oLat, oLon] = crime.origin, [cLat, cLon] = crime.cell;
  const ci = Math.floor((lat - oLat) / cLat), cj = Math.floor((lon - oLon) / cLon);
  const ri = Math.ceil(radius / 111320 / cLat) + 1, rj = Math.ceil(radius / 69500 / cLon) + 1;
  const months = new Array(crime.months.length).fill(0);
  const cats = new Array(crime.categories.length).fill(0);
  let hit = false;
  for (let i = ci - ri; i <= ci + ri; i++) {
    for (let j = cj - rj; j <= cj + rj; j++) {
      const cell = crime.cells[`${i},${j}`];
      if (!cell) continue;
      const clat = oLat + (i + 0.5) * cLat, clon = oLon + (j + 0.5) * cLon;
      if (distM(lat, lon, clat, clon) > radius) continue;
      hit = true;
      cell[0].forEach((v, k) => (months[k] += v));
      cell[1].forEach((v, k) => (cats[k] += v));
    }
  }
  return { months, cats, hit };
}
async function storedCrime(lat, lon) {
  const crime = await getLazy("crime");
  if (!crime) return null;
  const { months, cats, hit } = crimeAround(crime, lat, lon, AREA_RADIUS);
  if (!hit) return null;
  return { labels: crime.months, months, cats: Object.fromEntries(crime.categories.map((c, i) => [c, cats[i]])), live: false };
}
// Where a 12-month count sits among school neighbourhoods across England (0 to 100).
function crimePercentile(base, total) {
  const p = base?.percentiles;
  if (!p?.length) return null;
  let i = 0;
  while (i < p.length - 1 && p[i + 1] <= total) i++;
  return Math.min(100, i * 5);
}

async function renderCrime(el, h) {
  el.innerHTML = `<h3>Crime within ${AREA_RADIUS} m</h3><p class="muted small">${OFFLINE ? "Loading…" : "Asking police.uk for the last three years…"}</p>`;
  let data = null;
  if (!OFFLINE) { try { data = await liveCrime(h.lat, h.lon); } catch (e) { console.warn(e); } }
  if (!data) data = await storedCrime(h.lat, h.lon);
  if (!data) {
    el.innerHTML = `<h3>Crime</h3><div class="empty">${OFFLINE ? "This preview has crime figures for Sutton and Kingston only; the live site asks police.uk for any address in England." : "police.uk did not answer just now. Try again in a minute."}</div>
      <p class="note"><a href="https://www.police.uk/" target="_blank" rel="noopener">Check on police.uk</a></p>`;
    return;
  }
  const { months, labels } = data;
  const n = months.length;
  const sum = (a, b) => months.slice(Math.max(0, a), b).reduce((x, y) => x + y, 0);
  const last12 = sum(n - 12, n), prev12 = sum(n - 24, n - 12), prev24 = sum(n - 36, n - 24);
  const base = await getLazy("crime_baseline");
  const pct = crimePercentile(base, last12);
  const cls = pct == null ? "v-na" : pct < 40 ? "v-good" : pct <= 70 ? "v-warn" : "v-bad";
  const lbl = pct == null ? "" : pct < 40 ? "Quieter than most" : pct <= 70 ? "About typical" : "Busier than most";
  const change = prev12 ? Math.round(((last12 - prev12) / prev12) * 100) : null;
  const top = Object.entries(data.cats).map(([c, v]) => ({ c, v })).filter((x) => x.v).sort((a, b) => b.v - a.v).slice(0, 6);
  const maxV = top[0]?.v || 1;
  const yearLabel = (end) => labels[end - 1]?.slice(0, 7);
  el.innerHTML = `<h3>Crime within ${AREA_RADIUS} m ${lbl ? `<span class="verdict ${cls}">${lbl}</span>` : ""}</h3>
    <div class="kpis">
      <div class="kpi"><div class="v">${last12.toLocaleString()}</div><div class="l">Crimes, last 12 months</div></div>
      <div class="kpi"><div class="v">${change == null ? "–" : (change > 0 ? "+" : "") + change + "%"}</div><div class="l">vs previous 12 months</div></div>
      ${pct != null ? `<div class="kpi"><div class="v">${base.percentiles[10].toLocaleString()}</div><div class="l">Typical school neighbourhood in England</div></div>` : ""}
    </div>
    ${pct != null ? `<p class="small">More crime than around ${pct}% of school neighbourhoods in England.</p>` : ""}
    <p class="small muted">12-month totals, to the month shown</p>
    ${lineChart([{ k: yearLabel(n - 24), v: n >= 36 ? prev24 : null }, { k: yearLabel(n - 12), v: n >= 24 ? prev12 : null }, { k: yearLabel(n), v: last12 }], { fmt: (v) => v.toLocaleString() })}
    <p class="small muted">Most common, last 12 months</p>
    <div class="bars">${top.map((t) => `<div class="bar"><div class="lab"><span>${esc(catLabel(t.c))}</span><span>${t.v}</span></div><div class="track"><div class="fill" style="width:${(t.v / maxV) * 100}%"></div></div></div>`).join("")}</div>
    <p class="note">police.uk street-level data, ${esc(labels[0])} to ${esc(labels.at(-1))}${data.live ? ", fetched live" : ""}${data.gaps ? ` (${data.gaps} months did not load)` : ""}. Locations are approximate by design. A busy high street or station nearby raises the count.${pct != null ? ` England comparison from ${base.samples} school neighbourhoods.` : ""}</p>`;
}

// ---------- prices ----------
// Live: postcodes.io lists the postcodes within AREA_RADIUS, then HM Land Registry's
// SPARQL endpoint returns their sales. Offline, the pilot's data/sales.json is used.
const LR_SPARQL = "https://landregistry.data.gov.uk/landregistry/query";
const LR_TYPES = { detached: "D", "semi-detached": "S", terraced: "T", "flat-maisonette": "F", otherPropertyType: "O" };
const SALE_TYPES = { D: "Detached", S: "Semi-detached", T: "Terraced", F: "Flat", O: "Other" };
async function livePrices(lat, lon) {
  const key = `prices:${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (liveCache.has(key)) return liveCache.get(key);
  const job = (async () => {
    const pr = await (await fetch(`https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}&radius=${AREA_RADIUS}&limit=100`)).json();
    const pcs = (pr.result || []).map((p) => [p.postcode, p.latitude, p.longitude]);
    if (!pcs.length) return { rows: [], capped: false };
    const where = Object.fromEntries(pcs.map(([pc, la, lo]) => [pc, [la, lo]]));
    const since = `${new Date().getFullYear() - 5}-01-01`;
    const q = `PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?pc ?price ?date ?type ?newBuild ?estate ?paon ?saon ?street WHERE {
  VALUES ?pc { ${pcs.map(([pc]) => `"${pc.replace(/[^A-Z0-9 ]/gi, "")}"^^xsd:string`).join(" ")} }
  ?addr lrcommon:postcode ?pc .
  ?tx lrppi:propertyAddress ?addr ; lrppi:pricePaid ?price ; lrppi:transactionDate ?date ;
      lrppi:propertyType ?type ; lrppi:transactionCategory lrppi:standardPricePaidTransaction .
  OPTIONAL { ?tx lrppi:newBuild ?newBuild } OPTIONAL { ?tx lrppi:estateType ?estate }
  OPTIONAL { ?addr lrcommon:paon ?paon } OPTIONAL { ?addr lrcommon:saon ?saon } OPTIONAL { ?addr lrcommon:street ?street }
  FILTER (?date >= "${since}"^^xsd:date)
} ORDER BY DESC(?date) LIMIT 3000`;
    const r = await fetch(LR_SPARQL, { method: "POST", body: new URLSearchParams({ query: q }), headers: { Accept: "application/sparql-results+json" } });
    if (!r.ok) throw new Error(`Land Registry HTTP ${r.status}`);
    const j = await r.json();
    const v = (b, k) => b[k]?.value ?? "";
    const title = (t) => t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    const rows = j.results.bindings.map((b) => {
      const pc = v(b, "pc"), loc = where[pc] || [lat, lon];
      const saon = v(b, "saon"), paon = v(b, "paon"), street = title(v(b, "street"));
      return [loc[0], loc[1], +v(b, "price"), v(b, "date").slice(0, 10), LR_TYPES[v(b, "type").split("/").pop()] || "O",
        v(b, "newBuild") === "true" ? 1 : 0, v(b, "estate").endsWith("leasehold") ? "L" : "F",
        [saon ? saon + "," : "", paon, street].filter(Boolean).join(" "), pc];
    });
    return { rows, capped: pcs.length >= 100, live: true };
  })();
  liveCache.set(key, job);
  job.catch(() => liveCache.delete(key));
  return job;
}
async function storedPrices(h) {
  const sales = await getLazy("sales");
  if (!sales) return null;
  const rows = sales.rows.filter((r) => Math.abs(r[0] - h.lat) < 0.006 && Math.abs(r[1] - h.lon) < 0.01 && distM(h.lat, h.lon, r[0], r[1]) <= AREA_RADIUS);
  if (!rows.length && !sales.rows.some((r) => distM(h.lat, h.lon, r[0], r[1]) < 3000)) return null; // outside the pilot
  return { rows, live: false };
}

async function renderPrices(el, h) {
  el.innerHTML = `<h3>Sold prices within ${AREA_RADIUS} m</h3><p class="muted small">${OFFLINE ? "Loading…" : "Asking HM Land Registry…"}</p>`;
  let data = null;
  if (!OFFLINE) { try { data = await livePrices(h.lat, h.lon); } catch (e) { console.warn(e); } }
  if (!data) data = await storedPrices(h);
  if (!data) {
    el.innerHTML = `<h3>Sold prices</h3><div class="empty">${OFFLINE ? "This preview has sold prices for Sutton and Kingston only; the live site asks HM Land Registry for any address in England." : "HM Land Registry did not answer just now. Try again in a minute."}</div>`;
    return;
  }
  const near = [...data.rows].sort((a, b) => (a[3] < b[3] ? 1 : -1));
  if (!near.length) { el.innerHTML = `<h3>Sold prices within ${AREA_RADIUS} m</h3><div class="empty">No recorded sales nearby in the last five years.</div>`; return; }
  const latestDate = near[0][3];
  const cutoff = new Date(latestDate); cutoff.setFullYear(cutoff.getFullYear() - 2);
  const recent = near.filter((r) => new Date(r[3]) >= cutoff);
  const byType = {};
  for (const r of recent) (byType[r[4]] ||= []).push(r[2]);
  const byYear = {};
  for (const r of near) (byYear[r[3].slice(0, 4)] ||= []).push(r[2]);
  el.innerHTML = `<h3>Sold prices within ${AREA_RADIUS} m</h3>
    <div class="kpis">
      <div class="kpi"><div class="v">${fmtGBP(median(recent.map((r) => r[2])))}</div><div class="l">Median, last 2 years</div></div>
      <div class="kpi"><div class="v">${recent.length}</div><div class="l">Sales, last 2 years</div></div>
    </div>
    <table class="t"><thead><tr><th>Type</th><th class="n">Median</th><th class="n">Sales</th></tr></thead><tbody>
      ${Object.entries(byType).sort((a, b) => b[1].length - a[1].length).map(([t, v]) => `<tr><td>${esc(SALE_TYPES[t] || t)}</td><td class="n">${fmtGBP(median(v))}</td><td class="n">${v.length}</td></tr>`).join("")}
    </tbody></table>
    <p class="small muted" style="margin-top:10px">Median sold price by year (all types)</p>
    ${lineChart(Object.keys(byYear).sort().map((y) => ({ k: y, v: median(byYear[y]) })), { fmt: fmtGBP })}
    <p class="small muted">Latest sales</p>
    <table class="t"><tbody>${near.slice(0, 8).map((r) => `<tr><td>${esc(r[7])}<div class="small muted">${esc(SALE_TYPES[r[4]] || r[4])}${r[5] ? " · new build" : ""} · ${r[6] === "L" ? "leasehold" : "freehold"}</div></td><td class="n">${fmtGBP(r[2])}<div class="small muted">${esc(r[3])}</div></td></tr>`).join("")}</tbody></table>
    <p class="note">Contains HM Land Registry data © Crown copyright and database right ${new Date().getFullYear()}. Sales to ${esc(latestDate)}${data.live ? ", fetched live" : ""}.${data.capped ? " Busy area: the nearest 100 postcodes are included." : ""}</p>`;
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
  if (!best || best.d > 400) {
    el.innerHTML = `<h3>Mobile signal</h3><div class="empty">Coverage figures are collected for Sutton and Kingston only so far.</div>
      <p class="note"><a href="https://www.ofcom.org.uk/mobile-coverage-checker" target="_blank" rel="noopener">Check this postcode on Ofcom's coverage checker</a></p>`;
    return;
  }
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
  f.innerHTML = `Schools, results and Ofsted for all of England; catchment estimates for Sutton and Kingston upon Thames. Data: DfE (Get Information about Schools, Explore Education Statistics), Ofsted, council admissions booklets, police.uk, HM Land Registry, Ofcom, postcodes.io. Contains public sector information licensed under the Open Government Licence v3.0.`;
  return f;
}

// ---------- search ----------
// One box for a postcode, a postcode district (e.g. "KT3"), a town or a school name.
const PC_FULL = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const PC_OUT = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const PHASE_FROM_CODE = { p: "primary", s: "secondary", a: "all-through", 6: "sixth-form", n: "nursery" };
async function findSchools(q) {
  const idx = await getLazy("search");
  if (!idx) return [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const r of idx.rows) {
    const name = r[1].toLowerCase();
    if (words.every((w) => name.includes(w))) hits.push(r);
    if (hits.length > 400) break;
  }
  const ql = q.toLowerCase();
  hits.sort((a, b) => (b[1].toLowerCase().startsWith(ql) - a[1].toLowerCase().startsWith(ql)) || a[1].localeCompare(b[1]));
  return hits.slice(0, 12);
}
async function findPlaces(q) {
  if (OFFLINE) return [];
  try {
    const j = await (await fetch(`https://api.postcodes.io/places?q=${encodeURIComponent(q)}&limit=20`)).json();
    const seen = new Set();
    return (j.result || [])
      .filter((p) => p.country === "England" && /city|town|village|suburban|hamlet/i.test(p.local_type || ""))
      .filter((p) => { const k = `${p.name_1}|${p.county_unitary || p.district_borough}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 6)
      .map((p) => ({ name: p.name_1, where: p.county_unitary || p.district_borough || p.region || "", lat: p.latitude, lon: p.longitude }));
  } catch { return []; }
}
async function lookupOutcode(q) {
  if (OFFLINE) return lookupPostcode(q);
  try {
    const j = await (await fetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(q)}`)).json();
    if (j.result) return { lat: j.result.latitude, lon: j.result.longitude, postcode: j.result.outcode.toUpperCase() };
  } catch {}
  return null;
}
async function openSchool(urn, lat, lon) {
  if (lat != null) { await ensureAround(lat, lon, 2000); map.setView([lat, lon], 15); }
  if (!state.byUrn.has(urn)) {
    const idx = await getLazy("search");
    const r = idx?.rows.find((x) => x[0] === urn);
    if (r) await ensureAround(r[4], r[5], 2000);
  }
  if (state.byUrn.has(urn)) showSchool(urn);
}
function showSearchResults(q, places, schools) {
  state.selected = null;
  panel.innerHTML = "";
  panel.append(backButton(state.home ? "Back to area report" : "All schools", state.home ? showArea : renderHome));
  const div = document.createElement("div");
  div.innerHTML = `<h1>Results for “${esc(q)}”</h1>
    ${places.length ? `<div class="card"><h3>Places</h3><ul class="school-list">${places.map((p, i) => `<li tabindex="0" data-place="${i}"><div><div class="name">${esc(p.name)}</div><div class="meta">${esc(p.where)}</div></div></li>`).join("")}</ul></div>` : ""}
    ${schools.length ? `<div class="card"><h3>Schools</h3><ul class="school-list">${schools.map((r) => `<li tabindex="0" data-urn="${r[0]}"><span class="dot" style="background:${(PHASES[PHASE_FROM_CODE[r[3]]] || PHASES.secondary).color}"></span><div><div class="name">${esc(r[1])}</div><div class="meta">${esc(PHASES[PHASE_FROM_CODE[r[3]]]?.label || "")} · ${esc(r[2] || "")}${r[6] ? " · Independent" : ""}</div></div></li>`).join("")}</ul></div>` : ""}
    ${!places.length && !schools.length ? `<div class="empty">Nothing found. Try a full postcode, a town, or part of a school's name.</div>` : ""}`;
  const pick = (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    if (li.dataset.place != null) {
      const p = places[+li.dataset.place];
      map.setView([p.lat, p.lon], 13);
      renderHome();
    } else {
      const r = schools.find((x) => x[0] === +li.dataset.urn);
      openSchool(r[0], r[4], r[5]);
    }
  };
  div.onclick = pick;
  div.onkeydown = (e) => { if (e.key === "Enter") pick(e); };
  panel.append(div, footer());
  panel.scrollTop = 0;
}

$("#search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#postcode").value.trim();
  const msg = $("#search-msg");
  msg.hidden = true;
  if (!q) return;
  if (PC_FULL.test(q) || PC_OUT.test(q)) {
    const hit = PC_FULL.test(q) ? await lookupPostcode(q) : await lookupOutcode(q);
    if (hit) {
      setHome(hit.lat, hit.lon, hit.postcode);
      showArea();
      return;
    }
    if (PC_FULL.test(q)) {
      msg.textContent = OFFLINE
        ? `${q.toUpperCase()} isn't in the preview's postcode list. Try a Sutton or Kingston postcode such as KT3 3NU, search a town or school, or tap the map.`
        : `Couldn't find ${q.toUpperCase()}. Check the postcode, or tap the map instead.`;
      msg.hidden = false;
      return;
    }
  }
  const [places, schools] = await Promise.all([findPlaces(q), findSchools(q)]);
  showSearchResults(q, places, schools);
});

// ---------- boot ----------
(async function init() {
  const [index, catchments, base] = await Promise.all([loadJSON("index"), loadJSON("catchments"), getLazy("crime_baseline")]);
  tiles.index = index;
  state.catchments = catchments?.schools || {};
  state.catchmentSources = catchments?.sources || {};
  const params = new URLSearchParams(location.search);
  const saved = restore("home");
  if (params.get("school")) {
    renderHome();
    openSchool(+params.get("school"));
  } else if (saved?.lat) {
    setHome(saved.lat, saved.lon, saved.postcode);
    showArea();
  } else {
    renderHome();
  }
})();
