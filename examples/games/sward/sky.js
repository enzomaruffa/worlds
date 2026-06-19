import * as THREE from "three";
import { scene, sun, hemi, ambient, HALF, PLOT, heightAt } from "./world.js";
import * as Grass from "./grass.js";

// ───────────────────────────────────────────────────────────────────────────
// sky.js — the living backdrop. Time is derived from the wall clock (so every
// client agrees with zero sync and idle progress is a pure function of elapsed
// time). Accelerated cinematic pacing: a full day in minutes, a year (4 seasons)
// in ~36 min — so you actually watch the sun sweep, dawn break, dusk fall, and
// the seasons turn. Drives sun/sky/fog/lights, grass tint, stars, fireflies and
// per-season weather particles.
// ───────────────────────────────────────────────────────────────────────────

export const DAY_MS = 180_000;          // 3 real minutes = 1 in-game day
export const DAYS_PER_SEASON = 3;
export const SEASON_MS = DAY_MS * DAYS_PER_SEASON;   // 9 min
export const YEAR_MS = SEASON_MS * 4;                // 36 min
const EPOCH = Date.UTC(2024, 0, 1);

let cfg = { epoch: EPOCH, dayMs: DAY_MS, seasonMs: SEASON_MS };
export function setClockConfig(c) { if (c) cfg = { ...cfg, ...c }; }

// optional frozen time for previews/screenshots (?at=<gameMs> in main.js)
let warpAbs = null;
export function setAbsolute(ms) { warpAbs = (ms == null || isNaN(ms)) ? null : Number(ms); }

const TAU = Math.PI * 2;
const lerp = THREE.MathUtils.lerp, clamp = THREE.MathUtils.clamp;
const smooth = (t) => t * t * (3 - 2 * t);

export const gameNow = () => (warpAbs != null ? warpAbs : Date.now() - cfg.epoch);
export const dayT = () => (gameNow() % cfg.dayMs) / cfg.dayMs;       // 0..1 within a day
export const sunHeight = () => -Math.cos(dayT() * TAU);             // -1 midnight .. +1 noon
export const daylight = () => clamp(sunHeight() * 1.35 + 0.16, 0, 1); // grass/sim "sunlight"
export const seasonIndex = () => Math.floor(gameNow() / cfg.seasonMs) % 4;
export const seasonFrac = () => (gameNow() % cfg.seasonMs) / cfg.seasonMs;
export const yearNum = () => Math.floor(gameNow() / (cfg.seasonMs * 4)) + 1;
export const isRising = () => dayT() < 0.5;

const SEASONS = [
  { name: "Spring", sky: 0x9fd9ef, lush: 0x5cc247, dry: 0xc8d36a, tip: 0xbdf06e, hemiG: 0x6f9a4c, sun: 0xfff0d6, part: "pollen", wind: 0.13 },
  { name: "Summer", sky: 0x77c2ef, lush: 0x3f9e34, dry: 0xcdb456, tip: 0x9fe06a, hemiG: 0x4f7a36, sun: 0xfff5da, part: "warm",   wind: 0.10 },
  { name: "Autumn", sky: 0xbfae8a, lush: 0x9a8f3c, dry: 0xc97a38, tip: 0xe6ab58, hemiG: 0x6e5a2e, sun: 0xffd79a, part: "leaves", wind: 0.18 },
  { name: "Winter", sky: 0xbcd0e2, lush: 0x86a17e, dry: 0xaab8a6, tip: 0xd2e6da, hemiG: 0x5c6c66, sun: 0xeaf2ff, part: "snow",   wind: 0.16 },
];
const NIGHT_SKY = new THREE.Color(0x0a1230);
const DAWN = new THREE.Color(0xffb784), DUSK = new THREE.Color(0xff7e52);

const _a = new THREE.Color(), _b = new THREE.Color(), _sky = new THREE.Color(), _sun = new THREE.Color();
function blendSeason(field) {
  const s = seasonIndex(), n = (s + 1) % 4, f = smooth(clamp((seasonFrac() - 0.7) / 0.3, 0, 1)); // ease into next near season end
  _a.set(SEASONS[s][field]); _b.set(SEASONS[n][field]);
  return _a.lerp(_b, f);
}
function blendScalar(field) {
  const s = seasonIndex(), n = (s + 1) % 4, f = smooth(clamp((seasonFrac() - 0.7) / 0.3, 0, 1));
  return lerp(SEASONS[s][field], SEASONS[n][field], f);
}

// ── particle systems ─────────────────────────────────────────────────────────
let stars = null, fireflies = null, weather = null, wmeta = null, fmeta = null;

function makePoints(count, size, color, additive) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const mat = new THREE.PointsMaterial({ size, color, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true });
  if (additive) mat.blending = THREE.AdditiveBlending;
  const p = new THREE.Points(geo, mat); p.frustumCulled = false; scene.add(p);
  return p;
}

function initParticles() {
  // stars on an upper dome
  stars = makePoints(420, 0.5, 0xffffff, true);
  const sp = stars.geometry.attributes.position.array;
  for (let i = 0; i < 420; i++) {
    const u = Math.random(), v = Math.random() * 0.5;            // upper hemisphere
    const th = u * TAU, ph = Math.acos(1 - v), R = 230;
    sp[i * 3] = Math.sin(ph) * Math.cos(th) * R;
    sp[i * 3 + 1] = Math.cos(ph) * R + 30;
    sp[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * R;
  }
  // fireflies drifting low over the plot
  fireflies = makePoints(64, 0.5, 0xc8ff7a, true);
  fmeta = [];
  const fp = fireflies.geometry.attributes.position.array;
  for (let i = 0; i < 64; i++) {
    const x = (Math.random() - 0.5) * PLOT, z = (Math.random() - 0.5) * PLOT;
    fmeta.push({ x, z, y: 0.8 + Math.random() * 3, ph: Math.random() * TAU, sp: 0.4 + Math.random() * 0.7, blink: Math.random() * TAU });
    fp[i * 3] = x; fp[i * 3 + 1] = fmeta[i].y; fp[i * 3 + 2] = z;
  }
  // weather (season): falling/drifting flakes
  weather = makePoints(260, 0.5, 0xffffff, false);
  wmeta = [];
  const wp = weather.geometry.attributes.position.array;
  for (let i = 0; i < 260; i++) {
    const x = (Math.random() - 0.5) * PLOT, z = (Math.random() - 0.5) * PLOT, y = Math.random() * 26;
    wmeta.push({ x, z, y, vx: (Math.random() - 0.5), vy: -(0.6 + Math.random()), sway: Math.random() * TAU, swaySp: 0.5 + Math.random() });
    wp[i * 3] = x; wp[i * 3 + 1] = y; wp[i * 3 + 2] = z;
  }
}

function updateFireflies(dt, t, night) {
  const arr = fireflies.geometry.attributes.position.array;
  const summer = seasonIndex() === 1 ? 1.3 : seasonIndex() === 3 ? 0.3 : 1;
  for (let i = 0; i < fmeta.length; i++) {
    const f = fmeta[i];
    f.ph += dt * f.sp; f.blink += dt * (1.5 + f.sp);
    f.x += Math.cos(f.ph) * dt * 1.4; f.z += Math.sin(f.ph * 0.7) * dt * 1.4;
    if (f.x > HALF) f.x = -HALF; if (f.x < -HALF) f.x = HALF;
    if (f.z > HALF) f.z = -HALF; if (f.z < -HALF) f.z = HALF;
    const y = heightAt(f.x, f.z) + f.y + Math.sin(f.ph * 1.3) * 0.5;
    arr[i * 3] = f.x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = f.z;
  }
  fireflies.geometry.attributes.position.needsUpdate = true;
  fireflies.material.opacity = night * 0.9 * summer;
}

function updateWeather(dt, t) {
  const part = SEASONS[seasonIndex()].part;
  const arr = weather.geometry.attributes.position.array;
  let show = 1, fall = 1, sway = 1, col = 0xffffff, size = 0.5, count = wmeta.length;
  if (part === "snow") { col = 0xffffff; size = 0.55; fall = 0.6; sway = 0.8; }
  else if (part === "leaves") { col = 0xd8843a; size = 0.6; fall = 0.9; sway = 2.2; }
  else if (part === "pollen") { col = 0xfff2a8; size = 0.32; fall = 0.18; sway = 1.4; count = wmeta.length * 0.5; }
  else { col = 0xfff0c0; size = 0.3; fall = 0.1; sway = 1.0; count = wmeta.length * 0.25; show = 0.5; } // summer: sparse motes
  weather.material.color.setHex(col); weather.material.size = size; weather.material.opacity = 0.7 * show;
  for (let i = 0; i < wmeta.length; i++) {
    const w = wmeta[i];
    if (i >= count) { arr[i * 3 + 1] = -999; continue; }   // hide extras
    w.sway += dt * w.swaySp;
    w.y += w.vy * fall * dt * 4;
    w.x += (w.vx + Math.sin(w.sway) * sway) * dt;
    const floor = heightAt(w.x, w.z);
    if (w.y < floor) { w.y = 22 + Math.random() * 6; w.x = (Math.random() - 0.5) * PLOT; w.z = (Math.random() - 0.5) * PLOT; }
    if (w.x > HALF) w.x -= PLOT; if (w.x < -HALF) w.x += PLOT;
    arr[i * 3] = w.x; arr[i * 3 + 1] = w.y; arr[i * 3 + 2] = w.z;
  }
  weather.geometry.attributes.position.needsUpdate = true;
}

// ── public ────────────────────────────────────────────────────────────────────
export function initSky() { initParticles(); applyTint(true); }

let lastTint = -1;
function applyTint(force) {
  const sIdx = seasonIndex() + seasonFrac();
  if (!force && Math.abs(sIdx - lastTint) < 0.01) return;
  lastTint = sIdx;
  Grass.setPalette({ lush: blendSeason("lush").getHex(), dry: blendSeason("dry").getHex(), tip: blendSeason("tip").getHex(), wind: blendScalar("wind") });
  Grass.retint();
}

let tintT = 0;
export function update(dt) {
  const t = gameNow() / 1000;
  const dl = daylight(), sh = sunHeight();
  const night = clamp(1 - dl * 1.5, 0, 1);

  // sky colour: night → season-day, with a warm glow near the horizon
  _sky.copy(NIGHT_SKY).lerp(blendSeason("sky"), smooth(dl));
  const horizon = clamp(1 - Math.abs(sh) / 0.34, 0, 1) * (sh > -0.35 ? 1 : 0);
  _sky.lerp(isRising() ? DAWN : DUSK, horizon * 0.55);
  scene.background.copy(_sky);
  if (scene.fog) scene.fog.color.copy(_sky);
  scene.fog.near = PLOT * 1.5; scene.fog.far = PLOT * (3.0 + dl * 1.6);

  // sun arc (east → zenith → west) + warm-to-white colour by altitude
  const ang = dayT() * TAU;
  sun.position.set(Math.sin(ang) * 78, Math.max(-12, sh * 74) + 7, Math.cos(ang) * 52);
  sun.target.position.set(0, 0, 0); sun.target.updateMatrixWorld();
  _sun.set(0xff8a3c).lerp(_a.set(SEASONS[seasonIndex()].sun), clamp(sh, 0, 1));
  sun.color.copy(_sun);
  sun.intensity = 0.1 + 1.55 * dl;
  sun.castShadow = dl > 0.05;

  hemi.color.copy(blendSeason("sky")); hemi.groundColor.copy(blendSeason("hemiG"));
  hemi.intensity = 0.22 + 0.62 * dl;
  ambient.intensity = 0.05 + 0.12 * dl;

  // particles
  if (stars) stars.material.opacity = night * 0.9;
  if (fireflies) updateFireflies(dt, t, night);
  if (weather) updateWeather(dt, t);

  // grass tint (throttled — cheap colour-only refresh)
  tintT += dt;
  if (tintT > 0.4) { tintT = 0; applyTint(false); }
}

// HUD helpers
export function seasonName() { return SEASONS[seasonIndex()].name; }
export function todName() {
  const t = dayT();
  if (t < 0.21) return "night"; if (t < 0.31) return "dawn"; if (t < 0.46) return "morning";
  if (t < 0.54) return "noon"; if (t < 0.69) return "afternoon"; if (t < 0.79) return "dusk";
  return "night";
}
export function sunIcon() {
  const t = dayT();
  if (t < 0.22 || t >= 0.8) return "🌙"; if (t < 0.31) return "🌅"; if (t < 0.69) return "☀️"; if (t < 0.8) return "🌇"; return "🌙";
}
