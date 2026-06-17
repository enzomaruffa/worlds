// ───────────────────────────────────────────────────────────────────────────
// Kart Loop — local track editor.
//
// Top-down designer for the racing tracks. Drag control points, set per-point
// elevation + bank, watch live validation (a track is "clean" only if its
// corners stay wider than the road and the loop doesn't pinch — the same checks
// that keep tracks from going "whacky"), pick a theme, then export the exact
// `TRACKS` entry to paste into main.js, or preview it in the real 3D game.
//
// Uses the SAME centripetal Catmull-Rom the game uses, so the shape matches.
// ───────────────────────────────────────────────────────────────────────────
import * as THREE from "./three.module.js";

const ROAD_HALF = 7.0;
const CURB_W = 0.9;
const SAMPLES = 400;
const FOLD_RADIUS = 0.7;               // the inner-edge taper keeps the road from folding down to ~0.6u, so anything ≥ ~1u is clean
const HAIRPIN_RADIUS = ROAD_HALF * 1.8; // below this it's a sharp hairpin — tight but totally drivable
const OVERLAP_DIST = ROAD_HALF * 0.5;   // with tapered inner edges, strands only truly overlap when this close

// ── theme presets (mirror of main.js TRACKS themes) ─────────────────────────
const THEMES = {
  "sunset-bay": { ground: 0x6aa84a, road: 0x35363d, curb: [0xd8413a, 0xf3f3f5], cone: 0xf97316, fog: [0xf6c79a, 200, 470], sky: [0x1d4e8a, 0xf3a662, 0xffd9a0], sun: [0xffe1b0, 1.2, 70, 120, 50], hemi: [0xffe3c0, 0x4a5d3a, 0.85], scenery: "trees", stands: true },
  "dust-devil": { ground: 0xceb079, road: 0x4a4438, curb: [0xd8413a, 0xf3f3f5], cone: 0xf59e0b, fog: [0xe8cfa0, 230, 540], sky: [0x4a8fd0, 0xbcd6ec, 0xe9d6ad], sun: [0xfff4d6, 1.35, 80, 130, 40], hemi: [0xdfe8ff, 0x8a7345, 0.95], scenery: "cacti", stands: false },
  "glacier-pass": { ground: 0xe8eef4, road: 0x3a3d44, curb: [0xcf3b3b, 0xffffff], cone: 0x2563eb, fog: [0xdfeaf2, 160, 400], sky: [0x6f9fd0, 0xcfe2f0, 0xeef6fb], sun: [0xeaf2ff, 1.15, -40, 120, 40], hemi: [0xeaf3ff, 0x8aa0b4, 1.0], scenery: "pines", stands: false },
  "neon-city": { ground: 0x14141c, road: 0x1c1c26, curb: [0xff2d6e, 0x22d3ee], cone: 0x22d3ee, fog: [0x0a0a16, 120, 330], sky: [0x05030f, 0x1a0f2e, 0x2a1140], sun: [0x9fb4ff, 0.7, 40, 120, -30], hemi: [0x3a2a66, 0x0a0a16, 0.7], scenery: "pylons", stands: false, neon: true },
  "speedway": { ground: 0x4f9a3f, road: 0x33343b, curb: [0xd8413a, 0xf3f3f5], cone: 0xf97316, fog: [0x9ad0e8, 230, 540], sky: [0x2b6fb0, 0x9ad0e8, 0xeef4f7], sun: [0xfff4d6, 1.3, 70, 130, 50], hemi: [0xbfe3ff, 0x4a7a3a, 0.95], scenery: "stands", stands: true },
};

// ── the built-in tracks, to load and tweak ─────────────────────────────────
const BUILTIN = [
  { id: "sunset-bay", name: "Sunset Bay", blurb: "flowing seaside sweepers", laps: 3, themeId: "sunset-bay",
    cp: [[0, 0, 72], [40, 0.4, 66], [68, 1.4, 40], [76, 2.2, 4], [70, 2.6, -34], [46, 2.0, -64], [6, 1.0, -74], [-36, 1.4, -66], [-66, 2.2, -38], [-74, 2.0, 2], [-66, 1.0, 40], [-34, 0.3, 62]],
    bank: [0.0, 0.2, 0.5, 0.5, 0.5, 0.45, 0.1, 0.45, 0.5, 0.5, 0.4, 0.2] },
  { id: "dust-devil", name: "Dust Devil", blurb: "rolling desert flat-out", laps: 3, themeId: "dust-devil",
    cp: [[-60, 0, 86], [10, 0.5, 92], [64, 1.8, 76], [92, 3.2, 36], [88, 4.0, -16], [60, 4.2, -56], [14, 3.0, -76], [-36, 2.0, -70], [-72, 1.2, -34], [-86, 0.5, 14], [-80, 0, 56]],
    bank: [0.0, 0.1, 0.4, 0.5, 0.5, 0.45, 0.2, 0.4, 0.45, 0.4, 0.2] },
  { id: "glacier-pass", name: "Glacier Pass", blurb: "alpine climbs & drops", laps: 3, themeId: "glacier-pass",
    cp: [[0, 0, 74], [46, 1.5, 66], [70, 4.0, 34], [72, 6.5, -6], [56, 7.5, -44], [18, 6.5, -70], [-26, 5.0, -70], [-58, 3.5, -42], [-72, 2.0, -2], [-62, 1.0, 38], [-30, 0.3, 60]],
    bank: [0.0, 0.3, 0.55, 0.5, 0.6, 0.5, 0.4, 0.55, 0.5, 0.4, 0.2] },
  { id: "neon-city", name: "Neon City", blurb: "tight technical street circuit", laps: 4, themeId: "neon-city",
    cp: [[0, 0, 56], [44, 0.4, 51], [64, 1.0, 22], [64, 1.4, -20], [47, 1.6, -50], [6, 1.2, -62], [-37, 1.2, -57], [-63, 1.6, -26], [-59, 1.2, 8], [-64, 1.0, 38], [-34, 0, 55]],
    bank: [0.0, 0.3, 0.7, 0.7, 0.65, 0.4, 0.6, 0.7, 0.55, 0.6, 0.3] },
  { id: "speedway", name: "Speedway", blurb: "banked oval — pure top speed", laps: 5, themeId: "speedway",
    cp: [[0, 0, 60], [52, 0, 54], [70, 0, 20], [70, 0, -20], [52, 0, -54], [0, 0, -60], [-52, 0, -54], [-70, 0, -20], [-70, 0, 20], [-52, 0, 54]],
    bank: [0.0, 0.7, 1.0, 1.0, 0.7, 0.0, 0.7, 1.0, 1.0, 0.7] },
];

// ── state ───────────────────────────────────────────────────────────────────
function loadSavedTrack() {
  try { const r = localStorage.getItem("kartEditorTrack"); if (r) { const t = JSON.parse(r); if (t && Array.isArray(t.cp) && t.cp.length >= 4 && Array.isArray(t.bank)) return t; } } catch (_) {}
  return clone(BUILTIN[0]);
}
let track = loadSavedTrack();
let selected = -1;
let selProp = -1;                     // selected scenery prop
let geo = null;                       // sampled geometry + metrics
const view = { cx: 0, cz: 0, scale: 3 }; // world→screen
let drag = null;                      // { kind:'point'|'pan'|'prop', ... }

// scenery you can drag onto the track (model names match main.js MODELS / assets)
const PROP_CATALOG = [
  { m: "treeLarge", l: "Tree (big)", s: 7 }, { m: "treeSmall", l: "Tree (small)", s: 4 },
  { m: "tree_fat", l: "Fat tree", s: 7 }, { m: "tree_pineRoundB", l: "Pine", s: 7 }, { m: "cactus_tall", l: "Cactus", s: 6 },
  { m: "rock_largeA", l: "Rock (big)", s: 5 }, { m: "rock_smallA", l: "Rock", s: 2.5 }, { m: "log", l: "Log", s: 2 },
  { m: "stump_round", l: "Stump", s: 2 }, { m: "flower_redA", l: "Flowers", s: 1.5 }, { m: "plant_bushLarge", l: "Bush", s: 3 },
  { m: "barrel", l: "Barrel", s: 2.5 }, { m: "pylon", l: "Pylon", s: 2 }, { m: "grandStand", l: "Grandstand", s: 9 },
  { m: "satelliteDish_detailed", l: "Dish", s: 5 }, { m: "gate_complex", l: "Arch gate", s: 14 },
];
const propLabel = (m) => (PROP_CATALOG.find((p) => p.m === m) || { l: m }).l;
function props() { if (!track.props) track.props = []; return track.props; }

const $ = (id) => document.getElementById(id);
const canvas = $("edit");
const ctx = canvas.getContext("2d");

function clone(t) { return JSON.parse(JSON.stringify(t)); }
function slug(s) { return (s || "track").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "track"; }

// ── geometry: centripetal Catmull-Rom (matches the game) + metrics ──────────
function resample() {
  const pts = track.cp.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal");
  const center = curve.getSpacedPoints(SAMPLES);
  const tan = [];
  for (let i = 0; i <= SAMPLES; i++) tan.push(curve.getTangentAt((i % SAMPLES) / SAMPLES).normalize());
  const length = curve.getLength();
  const seg = length / SAMPLES;
  // asymmetric width: pull the INNER edge in on tight corners so hairpin edges
  // merge to a clean apex instead of crossing (matches main.js buildRoad).
  const rawInner = [], radii = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const a = tan[i % SAMPLES], b = tan[(i + 1) % SAMPLES];
    const ang = Math.acos(THREE.MathUtils.clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1));
    const radius = ang > 1e-4 ? seg / ang : 1e6;
    radii.push(radius);
    rawInner.push(Math.min(ROAD_HALF, Math.max(0.5, radius * 0.82)));
  }
  const left = [], right = [];
  const RW = 6;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = tan[i % SAMPLES];
    const nx = t.z, nz = -t.x; // horizontal road-right (XZ)
    const len = Math.hypot(nx, nz) || 1;
    const ux = nx / len, uz = nz / len;
    const c = center[i];
    let inner = 0; for (let k = -RW; k <= RW; k++) inner += rawInner[((i + k) % SAMPLES + SAMPLES) % SAMPLES];
    inner = Math.max(0.5, Math.min(inner / (RW * 2 + 1), radii[i] * 0.85)); // cap to local radius → 2-unit corners stay clean
    const tn = tan[(i + 4) % SAMPLES];
    const turn = Math.sign(t.x * tn.z - t.z * tn.x) || 0;
    const lh = turn < 0 ? inner : ROAD_HALF;   // right turn → left edge inner
    const rh = turn > 0 ? inner : ROAD_HALF;   // left turn → right edge inner
    left.push([c.x + ux * lh, c.z + uz * lh]);
    right.push([c.x - ux * rh, c.z - uz * rh]);
  }
  let ymin = Infinity, ymax = -Infinity, maxGrade = 0, maxCurv = 1e-9;
  for (let i = 0; i < SAMPLES; i++) {
    ymin = Math.min(ymin, center[i].y); ymax = Math.max(ymax, center[i].y);
    maxGrade = Math.max(maxGrade, Math.abs(center[i + 1].y - center[i].y) / seg);
    const a = Math.acos(THREE.MathUtils.clamp(tan[i % SAMPLES].dot(tan[(i + 1) % SAMPLES]), -1, 1));
    maxCurv = Math.max(maxCurv, a / seg);
  }
  let minSelf = Infinity;
  for (let i = 0; i < SAMPLES; i += 2) {
    for (let j = i + 20; j < SAMPLES; j += 2) {
      if (Math.min(j - i, SAMPLES - (j - i)) < 30) continue;
      const d = Math.hypot(center[i].x - center[j].x, center[i].z - center[j].z);
      if (d < minSelf) minSelf = d;
    }
  }
  geo = { center, tan, left, right, length, minRadius: 1 / maxCurv, minSelf, maxGradeDeg: Math.atan(maxGrade) * 180 / Math.PI, elev: ymax - ymin };
  syncPanel();
}

// ── canvas transforms + sizing ──────────────────────────────────────────────
function sx(x) { return (x - view.cx) * view.scale + canvas.clientWidth / 2; }
function sy(z) { return (z - view.cz) * view.scale + canvas.clientHeight / 2; }
function wx(px) { return (px - canvas.clientWidth / 2) / view.scale + view.cx; }
function wz(py) { return (py - canvas.clientHeight / 2) / view.scale + view.cz; }

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

function fitView() {
  let xmn = Infinity, xmx = -Infinity, zmn = Infinity, zmx = -Infinity;
  for (const p of track.cp) { xmn = Math.min(xmn, p[0]); xmx = Math.max(xmx, p[0]); zmn = Math.min(zmn, p[2]); zmx = Math.max(zmx, p[2]); }
  view.cx = (xmn + xmx) / 2; view.cz = (zmn + zmx) / 2;
  const m = 40;
  view.scale = Math.min(canvas.clientWidth / (xmx - xmn + m * 2), canvas.clientHeight / (zmx - zmn + m * 2));
}

// ── render ──────────────────────────────────────────────────────────────────
function hex(n) { return "#" + (n >>> 0).toString(16).padStart(6, "0"); }
function render() {
  if (!geo) return;
  const th = THEMES[track.themeId] || THEMES["sunset-bay"];
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  // grass
  ctx.fillStyle = hex(new THREE.Color(th.ground).multiplyScalar(0.5).getHex());
  ctx.fillRect(0, 0, W, H);

  // road ribbon (fill between edges)
  ctx.beginPath();
  ctx.moveTo(sx(geo.left[0][0]), sy(geo.left[0][1]));
  for (let i = 1; i <= SAMPLES; i++) ctx.lineTo(sx(geo.left[i][0]), sy(geo.left[i][1]));
  for (let i = SAMPLES; i >= 0; i--) ctx.lineTo(sx(geo.right[i][0]), sy(geo.right[i][1]));
  ctx.closePath();
  ctx.fillStyle = hex(th.road);
  ctx.fill();

  // curbs (alternating stripes), with self-pinch warning colour if too tight
  const pinch = geo.minRadius < FOLD_RADIUS;
  drawEdge(geo.left, th, pinch);
  drawEdge(geo.right, th, pinch);

  // centreline (dashed), coloured by elevation
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = "rgba(232,232,236,0.5)";
  ctx.beginPath();
  for (let i = 0; i <= SAMPLES; i++) { const c = geo.center[i]; (i ? ctx.lineTo : ctx.moveTo).call(ctx, sx(c.x), sy(c.z)); }
  ctx.stroke();
  ctx.setLineDash([]);

  // start line + direction arrow at point 0 (sample 0)
  const c0 = geo.center[0], t0 = geo.tan[0];
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(sx(geo.left[0][0]), sy(geo.left[0][1]));
  ctx.lineTo(sx(geo.right[0][0]), sy(geo.right[0][1]));
  ctx.stroke();
  arrow(sx(c0.x), sy(c0.z), sx(c0.x + t0.x * 6), sy(c0.z + t0.z * 6), "#fbbf24");

  // control points
  track.cp.forEach((p, i) => {
    const x = sx(p[0]), y = sy(p[2]);
    ctx.beginPath();
    ctx.arc(x, y, i === selected ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? "#fbbf24" : (i === selected ? "#fff" : "#7dd3fc");
    ctx.fill();
    if (i === selected) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke(); }
    // elevation tick (height bar) for non-flat points
    if (Math.abs(p[1]) > 0.05) { ctx.strokeStyle = "rgba(251,191,36,0.7)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - p[1] * 2.2); ctx.stroke(); }
  });

  // scenery props (diamonds with labels)
  (track.props || []).forEach((o, i) => {
    const x = sx(o.x), y = sy(o.z), r = i === selProp ? 7 : 5;
    ctx.fillStyle = i === selProp ? "#fff" : "#34d399";
    ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill();
    if (i === selProp) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke(); }
    if (view.scale > 1.4) { ctx.fillStyle = "rgba(190,242,210,.85)"; ctx.font = "10px 'Space Grotesk',sans-serif"; ctx.textAlign = "center"; ctx.fillText(propLabel(o.model), x, y - r - 4); }
  });
}
function drawEdge(edge, th, pinch) {
  ctx.lineWidth = 3;
  for (let i = 0; i < SAMPLES; i++) {
    ctx.strokeStyle = pinch ? "#ef4444" : (Math.floor(i / 8) % 2 ? hex(th.curb[0]) : hex(th.curb[1]));
    ctx.beginPath();
    ctx.moveTo(sx(edge[i][0]), sy(edge[i][1]));
    ctx.lineTo(sx(edge[i + 1][0]), sy(edge[i + 1][1]));
    ctx.stroke();
  }
}
function arrow(x1, y1, x2, y2, col) {
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - 9 * Math.cos(a - 0.4), y2 - 9 * Math.sin(a - 0.4));
  ctx.lineTo(x2 - 9 * Math.cos(a + 0.4), y2 - 9 * Math.sin(a + 0.4));
  ctx.closePath(); ctx.fill();
}

// ── panel ────────────────────────────────────────────────────────────────────
function syncPanel() {
  $("mName").value = track.name;
  $("mBlurb").value = track.blurb;
  $("mLaps").value = track.laps;
  $("mTheme").value = track.themeId;

  const m = geo;
  // Tight corners (hairpins) are GOOD — only flag a corner that physically folds
  // the road in on itself, or two strands that actually cross. Everything else
  // is clean; a sharp-but-valid corner gets a friendly hairpin call-out.
  const folds = m.minRadius < FOLD_RADIUS;
  const crosses = m.minSelf < OVERLAP_DIST;
  const hairpin = m.minRadius < HAIRPIN_RADIUS;
  $("metrics").innerHTML = [
    metric("Length", m.length.toFixed(0) + " u", "ok"),
    metric("Tightest corner", m.minRadius.toFixed(1) + " u", folds ? "bad" : hairpin ? "warn" : "ok", "folds < " + FOLD_RADIUS.toFixed(1)),
    metric("Closest self-gap", m.minSelf.toFixed(1) + " u", crosses ? "bad" : "ok", "crosses < " + OVERLAP_DIST.toFixed(0)),
    metric("Max grade", m.maxGradeDeg.toFixed(0) + "°", m.maxGradeDeg < 22 ? "ok" : "warn"),
    metric("Elevation range", m.elev.toFixed(1) + " u", "ok"),
    metric("Control points", String(track.cp.length), "ok"),
  ].join("");
  const v = $("verdict");
  if (folds) { v.className = "issues"; v.textContent = "✗ that corner folds the road over itself — ease it out a touch"; }
  else if (crosses) { v.className = "issues"; v.textContent = "✗ two parts of the track cross — pull them apart"; }
  else if (hairpin) { v.className = "clean"; v.textContent = "✓ CLEAN — sharp hairpin in there 🌀 nice"; }
  else { v.className = "clean"; v.textContent = "✓ CLEAN — corners clear the road"; }

  const ptSec = $("ptSec");
  if (selected >= 0) {
    ptSec.classList.remove("hidden");
    $("ptIdx").textContent = "#" + selected + (selected === 0 ? " (start)" : "");
    $("ptY").value = track.cp[selected][1];
    $("ptYV").textContent = track.cp[selected][1].toFixed(1);
    $("ptBank").value = track.bank[selected];
    $("ptBankV").textContent = (+track.bank[selected]).toFixed(2);
    $("ptDel").disabled = track.cp.length <= 6;
  } else ptSec.classList.add("hidden");

  const propSec = $("propSec");
  if (selProp >= 0 && track.props && track.props[selProp]) {
    propSec.classList.remove("hidden");
    const o = track.props[selProp];
    $("prModel").textContent = propLabel(o.model);
    $("prY").value = o.y || 0; $("prYV").textContent = (o.y || 0).toFixed(1);
    $("prRot").value = o.ry || 0; $("prRotV").textContent = ((o.ry || 0) * 57.3).toFixed(0) + "°";
    $("prScale").value = o.s || 4; $("prScaleV").textContent = (o.s || 4).toFixed(1);
  } else propSec.classList.add("hidden");

  $("export").value = exportText();
}
function metric(k, v, state, hint) {
  return `<div class="metric"><span class="k">${k}${hint ? ` <span style="color:var(--dim)">(${hint})</span>` : ""}</span><span class="v ${state}">${v}</span></div>`;
}

// ── export ────────────────────────────────────────────────────────────────────
function r2(n) { return Math.round(n * 10) / 10; }
function themeLiteral(th) {
  const h = (n) => "0x" + (n >>> 0).toString(16).padStart(6, "0");
  return `{ ground: ${h(th.ground)}, road: ${h(th.road)}, curb: [${h(th.curb[0])}, ${h(th.curb[1])}], cone: ${h(th.cone)}, ` +
    `fog: [${h(th.fog[0])}, ${th.fog[1]}, ${th.fog[2]}], sky: [${h(th.sky[0])}, ${h(th.sky[1])}, ${h(th.sky[2])}], ` +
    `sun: [${h(th.sun[0])}, ${th.sun[1]}, ${th.sun[2]}, ${th.sun[3]}, ${th.sun[4]}], hemi: [${h(th.hemi[0])}, ${h(th.hemi[1])}, ${th.hemi[2]}], ` +
    `scenery: "${th.scenery}", stands: ${!!th.stands}${th.neon ? ", neon: true" : ""} }`;
}
function exportText() {
  const th = THEMES[track.themeId];
  const cp = track.cp.map((p) => `[${r2(p[0])}, ${r2(p[1])}, ${r2(p[2])}]`).join(", ");
  const bank = track.bank.map((b) => +(+b).toFixed(2)).join(", ");
  const props = (track.props || []).map((o) =>
    `{ model: "${o.model}", x: ${r2(o.x)}, z: ${r2(o.z)}, y: ${r2(o.y || 0)}, ry: ${r2(o.ry || 0)}, s: ${r2(o.s || 4)} }`).join(", ");
  return `{
  id: "${slug(track.name)}", name: "${track.name}", blurb: "${track.blurb}", laps: ${track.laps},
  cp: [${cp}],
  bank: [${bank}],
  props: [${props}],
  theme: ${themeLiteral(th)},
},`;
}

// ── interaction ──────────────────────────────────────────────────────────────
function pointAt(px, py) {
  for (let i = 0; i < track.cp.length; i++) {
    if (Math.hypot(px - sx(track.cp[i][0]), py - sy(track.cp[i][2])) < 12) return i;
  }
  return -1;
}
function nearestCenterIndex(x, z) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < SAMPLES; i++) { const c = geo.center[i]; const d = (c.x - x) ** 2 + (c.z - z) ** 2; if (d < bd) { bd = d; bi = i; } }
  return { i: bi, dist: Math.sqrt(bd) };
}
function propAt(px, py) {
  const ps = track.props || [];
  for (let i = ps.length - 1; i >= 0; i--) if (Math.hypot(px - sx(ps[i].x), py - sy(ps[i].z)) < 11) return i;
  return -1;
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const px = e.offsetX, py = e.offsetY;
  const ph = propAt(px, py);
  if (ph >= 0) { selProp = ph; selected = -1; drag = { kind: "prop" }; render(); syncPanel(); return; }
  const hit = pointAt(px, py);
  if (hit >= 0) { selected = hit; selProp = -1; drag = { kind: "point" }; render(); syncPanel(); return; }
  // click on/near the road → insert a point in the right segment
  const x = wx(px), z = wz(py);
  const near = nearestCenterIndex(x, z);
  if (near.dist < ROAD_HALF + 6 / view.scale + 4) {
    const segCount = track.cp.length;
    const after = Math.floor((near.i / SAMPLES) * segCount);
    const y = (track.cp[after % segCount][1] + track.cp[(after + 1) % segCount][1]) / 2;
    const bank = (track.bank[after % segCount] + track.bank[(after + 1) % segCount]) / 2;
    track.cp.splice(after + 1, 0, [r2(x), r2(y), r2(z)]);
    track.bank.splice(after + 1, 0, +bank.toFixed(2));
    selected = after + 1;
    drag = { kind: "point" };
    resample(); render();
    return;
  }
  drag = { kind: "pan", x0: px, y0: py, cx: view.cx, cz: view.cz };
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (drag.kind === "prop" && selProp >= 0) {
    const o = track.props[selProp];
    o.x = r2(wx(e.offsetX)); o.z = r2(wz(e.offsetY));
    render(); $("export").value = exportText();
  } else if (drag.kind === "point" && selected >= 0) {
    track.cp[selected][0] = r2(wx(e.offsetX));
    track.cp[selected][2] = r2(wz(e.offsetY));
    resample(); render();
  } else if (drag.kind === "pan") {
    view.cx = drag.cx - (e.offsetX - drag.x0) / view.scale;
    view.cz = drag.cz - (e.offsetY - drag.y0) / view.scale;
    render();
  }
});
canvas.addEventListener("pointerup", () => { drag = null; });
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const bx = wx(e.offsetX), bz = wz(e.offsetY);
  view.scale = Math.max(0.6, Math.min(14, view.scale * (e.deltaY > 0 ? 0.9 : 1.1)));
  view.cx = bx - (e.offsetX - canvas.clientWidth / 2) / view.scale;
  view.cz = bz - (e.offsetY - canvas.clientHeight / 2) / view.scale;
  render();
}, { passive: false });
addEventListener("keydown", (e) => {
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  if (selProp >= 0) { track.props.splice(selProp, 1); selProp = -1; render(); syncPanel(); return; }
  if (selected >= 0 && track.cp.length > 6) {
    track.cp.splice(selected, 1); track.bank.splice(selected, 1);
    selected = -1; resample(); render();
  }
});

// ── panel inputs ──────────────────────────────────────────────────────────────
$("mName").addEventListener("input", (e) => { track.name = e.target.value; track.id = slug(track.name); $("export").value = exportText(); });
$("mBlurb").addEventListener("input", (e) => { track.blurb = e.target.value; $("export").value = exportText(); });
$("mLaps").addEventListener("input", (e) => { track.laps = Math.max(1, +e.target.value || 1); $("export").value = exportText(); });
$("mTheme").addEventListener("change", (e) => { track.themeId = e.target.value; render(); $("export").value = exportText(); });
$("ptY").addEventListener("input", (e) => { if (selected < 0) return; track.cp[selected][1] = +e.target.value; $("ptYV").textContent = (+e.target.value).toFixed(1); resample(); render(); });
$("ptBank").addEventListener("input", (e) => { if (selected < 0) return; track.bank[selected] = +e.target.value; $("ptBankV").textContent = (+e.target.value).toFixed(2); $("export").value = exportText(); });
$("ptDel").addEventListener("click", () => { if (selected >= 0 && track.cp.length > 6) { track.cp.splice(selected, 1); track.bank.splice(selected, 1); selected = -1; resample(); render(); } });

$("loadBtn").addEventListener("click", () => { track = clone(BUILTIN.find((t) => t.id === $("loadSel").value) || BUILTIN[0]); selected = -1; selProp = -1; fitView(); resample(); render(); });
$("newBtn").addEventListener("click", () => {
  track = { id: "new-track", name: "New Track", blurb: "a fresh layout", laps: 3, themeId: $("mTheme").value || "sunset-bay",
    cp: [[0, 0, 50], [50, 0, 30], [55, 0, -25], [10, 0, -55], [-45, 0, -35], [-55, 0, 25]],
    bank: [0, 0.3, 0.4, 0.4, 0.3, 0.3], props: [] };
  selected = -1; selProp = -1; fitView(); resample(); render();
});
$("copyBtn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(exportText()); flash($("copyBtn"), "Copied!"); }
  catch (_) { $("export").select(); document.execCommand("copy"); flash($("copyBtn"), "Copied!"); }
});
$("previewBtn").addEventListener("click", () => {
  const th = THEMES[track.themeId];
  const t = { id: slug(track.name), name: track.name, blurb: track.blurb, laps: track.laps, cp: track.cp, bank: track.bank.map(Number), props: track.props || [], theme: th };
  localStorage.setItem("kartPreviewTrack", JSON.stringify(t));
  window.open("index.html?preview=1", "_blank");
});
function flash(btn, txt) { const o = btn.textContent; btn.textContent = txt; setTimeout(() => (btn.textContent = o), 1100); }

// ── scenery prop catalog + inspector ──────────────────────────────────────────
function buildPropPalette() {
  const host = $("propPal"); if (!host) return;
  host.innerHTML = PROP_CATALOG.map((p) => `<button data-m="${p.m}">${p.l}</button>`).join("");
  host.querySelectorAll("button").forEach((b) => b.onclick = () => addProp(b.dataset.m));
}
function addProp(model) {
  const def = PROP_CATALOG.find((p) => p.m === model) || { s: 4 };
  props().push({ model, x: r2(view.cx), z: r2(view.cz), y: 0, ry: 0, s: def.s });
  selProp = track.props.length - 1; selected = -1;
  render(); syncPanel();
}
$("prY").addEventListener("input", (e) => { if (selProp < 0) return; track.props[selProp].y = +e.target.value; $("prYV").textContent = (+e.target.value).toFixed(1); $("export").value = exportText(); });
$("prRot").addEventListener("input", (e) => { if (selProp < 0) return; track.props[selProp].ry = +e.target.value; $("prRotV").textContent = (+e.target.value * 57.3).toFixed(0) + "°"; $("export").value = exportText(); });
$("prScale").addEventListener("input", (e) => { if (selProp < 0) return; track.props[selProp].s = +e.target.value; $("prScaleV").textContent = (+e.target.value).toFixed(1); $("export").value = exportText(); });
$("prDel").addEventListener("click", () => { if (selProp >= 0) { track.props.splice(selProp, 1); selProp = -1; render(); syncPanel(); } });

// ── init ──────────────────────────────────────────────────────────────────────
function buildSelects() {
  $("mTheme").innerHTML = Object.keys(THEMES).map((k) => `<option value="${k}">${k}</option>`).join("");
  $("loadSel").innerHTML = BUILTIN.map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
}
buildSelects();
buildPropPalette();
// autosave the working track so a reload never loses your layout
let _lastSaved = "";
setInterval(() => { try { const s = JSON.stringify(track); if (s !== _lastSaved) { localStorage.setItem("kartEditorTrack", s); _lastSaved = s; } } catch (_) {} }, 1500);

// ── 🌐 shared garage (worlds.db — live, deploy-free) ──────────────────────────
function trackForDb() {
  return {
    id: slug(track.name), name: track.name, blurb: track.blurb, laps: track.laps, themeId: track.themeId,
    cp: track.cp.map((p) => [r2(p[0]), r2(p[1]), r2(p[2])]),
    bank: track.bank.map((b) => +(+b).toFixed(2)),
    props: (track.props || []).map((o) => ({ model: o.model, x: r2(o.x), z: r2(o.z), y: r2(o.y || 0), ry: r2(o.ry || 0), s: r2(o.s || 4) })),
    theme: THEMES[track.themeId],
  };
}
const validTrackData = (d) => d && Array.isArray(d.cp) && d.cp.length >= 4 && Array.isArray(d.bank);
let tracksCol = null;
async function initShared() {
  try { await worlds.ready; tracksCol = worlds.db.collection("tracks"); } catch (_) { return; }
  refreshShared();
  try { tracksCol.subscribe(() => refreshShared()); } catch (_) {}
}
$("pubBtn").addEventListener("click", async () => {
  if (!tracksCol) { flash($("pubBtn"), "sign in to publish"); return; }
  const data = trackForDb();
  try {
    if (track._docId) { await tracksCol.update(track._docId, data); flash($("pubBtn"), "Updated for all ✓"); }
    else { const doc = await tracksCol.create(data); track._docId = doc.id; flash($("pubBtn"), "Published to all ✓"); }
    refreshShared();
  } catch (_) { flash($("pubBtn"), "publish failed"); }
});
function refreshShared() {
  const host = $("sharedList"); if (!host || !tracksCol) return;
  tracksCol.list({ limit: 100 }).then((res) => {
    const items = res.items || [];
    if (!items.length) { host.innerHTML = '<span class="note">no shared tracks yet — publish one!</span>'; return; }
    host.innerHTML = "";
    for (const it of items) {
      const row = document.createElement("div"); row.className = "row"; row.style.margin = "0";
      const span = document.createElement("span");
      span.style.cssText = "flex:1;min-width:0;font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:" + (it.id === track._docId ? "var(--gold-bright)" : "var(--muted)");
      span.textContent = (it.data && it.data.name) || "track";
      const edit = document.createElement("button"); edit.textContent = "Edit"; edit.style.cssText = "flex:0;min-width:0;padding:.25rem .5rem;font-size:.74rem"; edit.onclick = () => loadShared(it);
      const del = document.createElement("button"); del.textContent = "✕"; del.className = "danger"; del.style.cssText = "flex:0;min-width:0;padding:.25rem .5rem;font-size:.74rem"; del.onclick = async () => { try { await tracksCol.delete(it.id); refreshShared(); } catch (_) {} };
      row.append(span, edit, del); host.appendChild(row);
    }
  }).catch(() => {});
}
function loadShared(it) {
  const d = it.data || {};
  if (!validTrackData(d)) return;
  track = { id: d.id || slug(d.name || "track"), name: d.name || "Track", blurb: d.blurb || "", laps: d.laps || 3,
    themeId: THEMES[d.themeId] ? d.themeId : "sunset-bay", cp: d.cp, bank: d.bank, props: Array.isArray(d.props) ? d.props : [], _docId: it.id };
  selected = -1; selProp = -1; fitView(); resample(); render(); syncPanel();
}
initShared();
addEventListener("resize", resize);
// initial layout pass after the canvas has its size
requestAnimationFrame(() => { resize(); fitView(); resample(); render(); });
