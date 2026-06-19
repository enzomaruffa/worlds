import * as THREE from "three";
import * as W from "./world.js";
import * as Grass from "./grass.js";
import * as El from "./elements.js";

// ───────────────────────────────────────────────────────────────────────────
// sim.js — the incremental engine: clean → grow → earn.
//   • debris litters the bare plot; clear it for Dew and to unblock soil
//   • seed grass; coverage spreads cell-to-cell over time
//   • coverage × health × ecosystem × sunlight generates Dew passively
//   • upgrades automate cleaning, add water, and boost growth
//   • offline catch-up advances everything by real elapsed time
// Grass coverage/health live in grass.js (the render source of truth); sim
// mutates them and asks grass.js to rebuild/retint.
// ───────────────────────────────────────────────────────────────────────────

const N = Grass.FIELD_N, NC = N * N;
const clamp = THREE.MathUtils.clamp;

// season growth + dew multipliers (index: spring, summer, autumn, winter)
const SEASON_GROW = [1.3, 1.0, 0.6, 0.22];
const SEASON_DEW = [1.15, 1.25, 0.9, 0.45];

export const UPGRADES = {
  rake:       { name: "Auto-rake", icon: "🧹", base: 40,  mult: 2.4, max: 5, desc: "Clears stray debris on its own." },
  sprinkler:  { name: "Sprinkler", icon: "💦", base: 90,  mult: 2.8, max: 5, desc: "Keeps the soil watered — faster, lusher growth." },
  fertilizer: { name: "Fertilizer", icon: "🌟", base: 150, mult: 3.2, max: 5, desc: "Richer soil multiplies grass growth." },
};

// gameplay state (net.js persists this; localStorage is the C4 stand-in)
export const S = {
  debris: [],                       // {id, x, z, kind, mesh, reward}
  blocked: new Uint8Array(NC),      // 1 = soil can't grow (under debris)
  water: new Float32Array(NC),      // transient moisture overlay 0..1
  upgrades: { rake: 0, sprinkler: 0, fertilizer: 0 },
  features: [],                     // {id, kind, x, z, stage, stageT, group}
  lastSeen: 0,
  rakeTimer: 0,
  climax: false,
};

// influence fields (recomputed from features when dirty)
const shadeF = new Float32Array(NC), moistF = new Float32Array(NC), pollenF = new Float32Array(NC), nectarF = new Float32Array(NC);
let fieldsDirty = true;
export const featureRoots = [];

let G = null, debrisRoots = [];
const DEBRIS_KINDS = ["rocks", "rocks_smallA", "rocks_smallB", "stump_round", "log"];

export const upgradeCost = (key) => {
  const u = UPGRADES[key]; const lvl = S.upgrades[key] || 0;
  return Math.round(u.base * Math.pow(u.mult, lvl));
};
export const upgradeMaxed = (key) => (S.upgrades[key] || 0) >= UPGRADES[key].max;

function cellXY(i) { return { ix: i % N, iz: (i / N) | 0 }; }
const cidx = (ix, iz) => iz * N + ix;

// ── debris ────────────────────────────────────────────────────────────────
function blockAround(x, z, r) {
  const c = Grass.cellOf(x, z); if (c < 0) return;
  const { ix, iz } = cellXY(c), rr = Math.ceil(r / Grass.CELL);
  for (let dz = -rr; dz <= rr; dz++) for (let dx = -rr; dx <= rr; dx++) {
    const nx = ix + dx, nz = iz + dz; if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
    if (dx * dx + dz * dz <= rr * rr) S.blocked[cidx(nx, nz)] = 1;
  }
}
function unblockAround(x, z, r) {
  const c = Grass.cellOf(x, z); if (c < 0) return;
  const { ix, iz } = cellXY(c), rr = Math.ceil(r / Grass.CELL);
  for (let dz = -rr; dz <= rr; dz++) for (let dx = -rr; dx <= rr; dx++) {
    const nx = ix + dx, nz = iz + dz; if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
    if (dx * dx + dz * dz <= rr * rr) S.blocked[cidx(nx, nz)] = 0;
  }
}

function spawnDebris(x, z, kind, id) {
  const m = W.cloneModel(kind, 1.0 + Math.random() * 0.8, { receive: true });
  if (!m) return null;
  m.position.set(x, W.heightAt(x, z), z);
  m.rotation.y = Math.random() * Math.PI * 2;
  m.userData.pickId = id; m.userData.kind = "debris";
  W.scene.add(m); debrisRoots.push(m);
  const d = { id, x, z, kind, mesh: m, reward: 6 + Math.floor(Math.random() * 10) };
  S.debris.push(d);
  blockAround(x, z, 1.6);
  return d;
}

export function scatterDebris(n, seed) {
  let a = (seed ^ 0xABCD) >>> 0;
  const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < n; i++) {
    const x = (rnd() - 0.5) * (W.PLOT - 7), z = (rnd() - 0.5) * (W.PLOT - 7);
    if (!W.insidePlot(x, z)) continue;
    spawnDebris(x, z, DEBRIS_KINDS[(rnd() * DEBRIS_KINDS.length) | 0], "deb-" + Date.now().toString(36) + "-" + i);
  }
}

// returns reward if a debris was cleared, else 0
export function clearDebris(pickId) {
  const i = S.debris.findIndex((d) => d.id === pickId);
  if (i < 0) return 0;
  const d = S.debris[i];
  W.scene.remove(d.mesh);
  const ri = debrisRoots.indexOf(d.mesh); if (ri >= 0) debrisRoots.splice(ri, 1);
  unblockAround(d.x, d.z, 1.8);
  S.debris.splice(i, 1);
  G.dew += d.reward;
  // tilled soil sprouts a little starter grass right away
  seedPatch(d.x, d.z, 1.4, 0.18);
  return d.reward;
}

// ── grass actions ───────────────────────────────────────────────────────────
export function seedPatch(x, z, radius, amount) {
  const c = Grass.cellOf(x, z); if (c < 0) return false;
  const { ix, iz } = cellXY(c), rr = Math.ceil(radius / Grass.CELL);
  let any = false;
  for (let dz = -rr; dz <= rr; dz++) for (let dx = -rr; dx <= rr; dx++) {
    const nx = ix + dx, nz = iz + dz; if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
    const ci = cidx(nx, nz); if (S.blocked[ci]) continue;
    if (dx * dx + dz * dz > rr * rr) continue;
    Grass.coverage[ci] = Math.max(Grass.coverage[ci], amount); any = true;
  }
  return any;
}
export function waterPatch(x, z, radius) {
  const c = Grass.cellOf(x, z); if (c < 0) return false;
  const { ix, iz } = cellXY(c), rr = Math.ceil(radius / Grass.CELL);
  for (let dz = -rr; dz <= rr; dz++) for (let dx = -rr; dx <= rr; dx++) {
    const nx = ix + dx, nz = iz + dz; if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
    if (dx * dx + dz * dz <= rr * rr) S.water[cidx(nx, nz)] = 1;
  }
  return true;
}

export function buyUpgrade(key) {
  if (!UPGRADES[key] || upgradeMaxed(key)) return false;
  const cost = upgradeCost(key);
  if (G.dew < cost) return false;
  G.dew -= cost; S.upgrades[key] = (S.upgrades[key] || 0) + 1;
  return true;
}

// ── features: free placement, influence fields, evolution ────────────────────
const sampleField = (arr, x, z) => { const c = Grass.cellOf(x, z); return c < 0 ? 0 : arr[c]; };
export const fieldsAt = (x, z) => ({ shade: sampleField(shadeF, x, z), moist: sampleField(moistF, x, z), pollen: sampleField(pollenF, x, z), nectar: sampleField(nectarF, x, z) });

function stamp(arr, x, z, radius, strength, downhill) {
  const c = Grass.cellOf(x, z); if (c < 0) return;
  const { ix, iz } = cellXY(c), rr = Math.ceil(radius / Grass.CELL), h0 = W.heightAt(x, z);
  for (let dz = -rr; dz <= rr; dz++) for (let dx = -rr; dx <= rr; dx++) {
    const nx = ix + dx, nz = iz + dz; if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
    const d = Math.sqrt(dx * dx + dz * dz); if (d > rr) continue;
    let s = strength * (1 - d / rr);
    if (downhill) { const cc = Grass.cellCenter(nx, nz); s *= THREE.MathUtils.clamp(1 + (h0 - W.heightAt(cc.x, cc.z)) * 0.6, 0.25, 2.2); } // moisture runs downhill
    const i = cidx(nx, nz); arr[i] = Math.min(1.4, arr[i] + s);
  }
}
export function computeFields() {
  shadeF.fill(0); moistF.fill(0); pollenF.fill(0); nectarF.fill(0);
  for (const f of S.features) {
    const def = El.FEATURES[f.kind];
    if (def.emits === "shade" && f.stage >= def.emitFrom) stamp(shadeF, f.x, f.z, def.radius, 0.9);
    else if (def.emits === "moist" && f.stage >= def.emitFrom) stamp(moistF, f.x, f.z, def.radius, 0.85, true);
    else if (def.emits === "pollen" && f.stage >= def.emitFrom) stamp(pollenF, f.x, f.z, def.radius, 1.0);
    else if (def.emits === "nectar" && f.stage >= def.emitFrom) stamp(nectarF, f.x, f.z, def.radius, 1.0);
  }
  fieldsDirty = false;
}

function gateMet(gate, x, z, season) {
  if (!gate) return true;
  if (gate.season && !gate.season.includes(season)) return false;
  if (gate.notSeason && gate.notSeason.includes(season)) return false;
  const fx = fieldsAt(x, z);
  if (gate.shade && fx.shade < 0.25) return false;
  if (gate.moist && fx.moist < 0.25) return false;
  if (gate.pollen && fx.pollen < 0.25) return false;
  if (gate.nectar && fx.nectar < 0.25) return false;
  return true;
}

function placeMesh(f) {
  if (f.group) W.scene.remove(f.group);
  const g = El.stageMesh(f.kind, f.stage);
  g.position.set(f.x, W.heightAt(f.x, f.z), f.z);
  g.userData.pickId = f.id; g.userData.kind = "feature";
  W.scene.add(g); f.group = g;
  const old = featureRoots.findIndex((r) => r.userData.pickId === f.id);
  if (old >= 0) featureRoots.splice(old, 1);
  featureRoots.push(g);
}

export function placeFeature(kind, x, z, free) {
  const def = El.FEATURES[kind]; if (!def) return null;
  if (!free) { if (G.dew < def.cost) return null; G.dew -= def.cost; }
  const f = { id: "ft-" + Date.now().toString(36) + "-" + ((Math.random() * 1e6) | 0), kind, x, z, stage: 0, stageT: 0 };
  S.features.push(f); placeMesh(f); fieldsDirty = true;
  // clear grass + block right under a placed feature so it sits cleanly
  return f;
}
export function moveFeature(id, x, z) {
  const f = S.features.find((q) => q.id === id); if (!f) return;
  f.x = x; f.z = z; if (f.group) f.group.position.set(x, W.heightAt(x, z), z); fieldsDirty = true;
}
export function removeFeature(id) {
  const i = S.features.findIndex((q) => q.id === id); if (i < 0) return;
  const f = S.features[i];
  if (f.group) W.scene.remove(f.group);
  const ri = featureRoots.findIndex((r) => r.userData.pickId === id); if (ri >= 0) featureRoots.splice(ri, 1);
  G.dew += Math.round(El.FEATURES[f.kind].cost * 0.4);   // partial refund
  S.features.splice(i, 1); fieldsDirty = true;
}
export const featureById = (id) => S.features.find((q) => q.id === id);

function evolve(dt, season) {
  for (const f of S.features) {
    const def = El.FEATURES[f.kind];
    if (f.stage >= def.stages.length - 1) continue;
    const st = def.stages[f.stage];
    if (!st.t) continue;
    const met = gateMet(st.gate, f.x, f.z, season);
    const rate = (1 / st.t) * SEASON_GROW[season] * (met ? 1 : 0.04);   // stalls (GROW "stuck") if gate unmet
    f.stageT += rate * dt;
    if (f.stageT >= 1 && met) { f.stageT = 0; f.stage++; placeMesh(f); fieldsDirty = true; }
    else if (f.stageT > 1) f.stageT = 1;
  }
}

// ── ecosystem level + synergies ───────────────────────────────────────────────
export function ecosystem() {
  let pts = (S._green || 0) * 0.4;
  const have = {}; // kind → max stage present
  for (const f of S.features) { pts += (f.stage + 1) * 2; have[f.kind] = Math.max(have[f.kind] ?? -1, f.stage); }
  // synergy bonuses
  if ((have.hive ?? -1) >= 2 && (have.flowers ?? -1) >= 2) pts += 16;     // pollination
  if ((have.pond ?? -1) >= 2) pts += 8;                                   // wetland
  if ((have.tree ?? -1) >= 3 && (have.mushrooms ?? -1) >= 1) pts += 10;   // shaded grove
  if ((have.clover ?? -1) >= 2) pts += 6;
  if ((have.pond ?? -1) >= 1 && (have.tree ?? -1) >= 3 && (have.flowers ?? -1) >= 2) pts += 24; // thriving biome
  const lvl = Math.floor(Math.sqrt(Math.max(0, pts)) / 2.2);
  G.ecoLevel = lvl;
  G.ecoPeak = Math.max(G.ecoPeak || 0, lvl);
  // climax: every placed feature at its top stage (and at least 4 of them)
  S.climax = S.features.length >= 4 && S.features.every((f) => f.stage >= El.FEATURES[f.kind].stages.length - 1);
  return lvl;
}

// ── the tick ──────────────────────────────────────────────────────────────
// One growth step over `dt` seconds at the given environment. Pure on the field
// + currencies, so offline catch-up just calls it with a big (chunked) dt.
const tmp = new Float32Array(NC);
export function step(dt, env) {
  const season = env.season | 0;
  const sun = env.sunlight;
  const fert = 1 + 0.5 * (S.upgrades.fertilizer || 0);
  const sprinkler = (S.upgrades.sprinkler || 0);
  const growth = 0.22 * SEASON_GROW[season] * fert * (0.25 + 0.75 * sun);

  if (fieldsDirty) computeFields();

  // sprinkler keeps moisture topped up; manual water + rain decay slowly
  for (let i = 0; i < NC; i++) {
    if (sprinkler && !S.blocked[i] && Grass.coverage[i] > 0) S.water[i] = Math.max(S.water[i], 0.35 + 0.13 * sprinkler);
    if (env.rain) S.water[i] = 1;
    S.water[i] = Math.max(0, S.water[i] - dt * 0.05);
  }

  // grow + spread coverage (single relaxation pass into tmp, then commit)
  let green = 0;
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const i = cidx(ix, iz);
    let cov = Grass.coverage[i];
    const cap = 1 - 0.55 * Math.min(1, shadeF[i]);   // grass thins under deep canopy
    if (!S.blocked[i]) {
      const moist = 0.4 + 0.6 * Math.min(1, S.water[i] + moistF[i]);
      // self-growth toward the (shade-limited) cap if already seeded
      if (cov > 0.02) cov += growth * moist * dt * (cap - cov);
      // spread from neighbours
      let nb = 0;
      if (ix > 0) nb = Math.max(nb, Grass.coverage[i - 1]);
      if (ix < N - 1) nb = Math.max(nb, Grass.coverage[i + 1]);
      if (iz > 0) nb = Math.max(nb, Grass.coverage[i - N]);
      if (iz < N - 1) nb = Math.max(nb, Grass.coverage[i + N]);
      if (nb > 0.35 && cov < nb && cov < cap) cov += growth * moist * dt * 0.5 * (nb - cov);
    } else cov = 0;
    tmp[i] = clamp(cov, 0, cap);

    // health drifts toward a target set by sun/water/season
    const target = clamp(0.35 + 0.4 * sun + 0.3 * S.water[i] - (season === 3 ? 0.35 : 0) - (season === 2 ? 0.12 : 0), 0.05, 1);
    Grass.health[i] += (target - Grass.health[i]) * Math.min(1, dt * 0.4);
    green += tmp[i] * Grass.health[i];
  }
  Grass.coverage.set(tmp);
  S._green = green;

  // features evolve; ecosystem level recomputed from stages + synergies + green
  evolve(dt, season);
  ecosystem();

  // Dew (ecosystem multiplies it — the GROW payoff)
  const dewRate = green * 0.02 * SEASON_DEW[season] * (0.3 + 0.7 * sun) * (1 + G.ecoLevel * 0.28);
  G.dew += dewRate * dt;
  S._dewRate = dewRate;

  // auto-rake
  if (S.upgrades.rake && S.debris.length) {
    S.rakeTimer += dt;
    const period = 6 / (S.upgrades.rake);   // faster with levels
    if (S.rakeTimer >= period) { S.rakeTimer = 0; clearDebris(S.debris[0].id); }
  }
}

export const ecoFromGreen = (green) => Math.floor(Math.sqrt(Math.max(0, green)) / 6);
export const dewRate = () => S._dewRate || 0;
export const greenPct = () => clamp((S._green || 0) / Math.max(1, countGrowable()), 0, 1);
let _growable = -1;
function countGrowable() {
  if (_growable >= 0) return _growable;
  let n = 0; for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const cc = Grass.cellCenter(ix, iz); if (W.insidePlot(cc.x, cc.z)) n++;
  }
  return (_growable = n);
}

// ── persistence (compact field summary + features later) ─────────────────────
export function serialize() {
  // store a downsampled 24×24 coverage so neighbour plots + reloads are cheap
  const D = 24, cov = new Array(D * D);
  for (let z = 0; z < D; z++) for (let x = 0; x < D; x++) {
    const ix = Math.floor(x / D * N), iz = Math.floor(z / D * N);
    cov[z * D + x] = Math.round(Grass.coverage[cidx(ix, iz)] * 15);   // 0..15 → compact
  }
  return {
    dew: Math.round(G.dew), spores: G.spores | 0, ecoLevel: G.ecoLevel | 0, ecoPeak: G.ecoPeak | 0,
    upgrades: { ...S.upgrades },
    debris: S.debris.map((d) => ({ x: +d.x.toFixed(2), z: +d.z.toFixed(2), kind: d.kind, id: d.id, reward: d.reward })),
    features: S.features.map((f) => ({ kind: f.kind, x: +f.x.toFixed(2), z: +f.z.toFixed(2), stage: f.stage, stageT: +(f.stageT || 0).toFixed(3) })),
    cov, covD: D, lastSeen: Date.now(),
  };
}
export function applyCoverageSummary(cov, D) {
  if (!cov) return;
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const x = Math.floor(ix / N * D), z = Math.floor(iz / N * D);
    const v = (cov[z * D + x] || 0) / 15;
    if (!S.blocked[cidx(ix, iz)]) Grass.coverage[cidx(ix, iz)] = v;
  }
}

// ── init + offline catch-up ───────────────────────────────────────────────────
export function init(g, saved) {
  G = g;
  for (const f of S.features) if (f.group) W.scene.remove(f.group);
  debrisRoots.length = 0; S.debris.length = 0; S.features.length = 0; featureRoots.length = 0;
  S.blocked.fill(0); S.water.fill(0); shadeF.fill(0); moistF.fill(0); pollenF.fill(0); nectarF.fill(0);
  Grass.coverage.fill(0); Grass.health.fill(1);
  G.ecoPeak = 0; fieldsDirty = true;

  if (saved && saved.debris) {
    G.dew = saved.dew || 0; G.spores = saved.spores || 0; G.ecoLevel = saved.ecoLevel || 0; G.ecoPeak = saved.ecoPeak || 0;
    S.upgrades = { rake: 0, sprinkler: 0, fertilizer: 0, ...(saved.upgrades || {}) };
    for (const fs of saved.features || []) { const f = placeFeature(fs.kind, fs.x, fs.z, true); if (f) { f.stage = fs.stage | 0; f.stageT = fs.stageT || 0; placeMesh(f); } }
    for (const d of saved.debris) {
      const id = d.id || ("deb-" + Math.random().toString(36).slice(2));
      const m = W.cloneModel(d.kind, 1.0, { receive: true });
      if (m) { m.position.set(d.x, W.heightAt(d.x, d.z), d.z); m.rotation.y = Math.random() * 6.28; m.userData.pickId = id; m.userData.kind = "debris"; W.scene.add(m); debrisRoots.push(m); }
      S.debris.push({ id, x: d.x, z: d.z, kind: d.kind, mesh: m, reward: d.reward || 8 });
      blockAround(d.x, d.z, 1.6);
    }
    applyCoverageSummary(saved.cov, saved.covD || 24);
    S.lastSeen = saved.lastSeen || Date.now();
  } else {
    scatterDebris(15, g.plotSeed);
    S.lastSeen = Date.now();
  }
  Grass.rebuild();
  return offlineCatchUp(saved);
}

// Advance the sim by real elapsed time since lastSeen, capped, in coarse chunks.
function offlineCatchUp(saved) {
  if (!saved || !S.lastSeen) return null;
  const elapsed = Math.max(0, Math.min(8 * 3600, (Date.now() - S.lastSeen) / 1000));   // cap 8h
  if (elapsed < 30) return null;
  const dewBefore = G.dew;
  // average day → sun ~0.45, neutral season blend; chunk in 30s steps (cap iterations)
  const STEP = 30; let t = elapsed, guard = 0;
  while (t > 0 && guard++ < 2000) {
    step(Math.min(STEP, t), { season: 1, sunlight: 0.5, rain: false });
    t -= STEP;
  }
  Grass.rebuild();
  return { secs: elapsed, dew: Math.round(G.dew - dewBefore) };
}

export const roots = debrisRoots;
