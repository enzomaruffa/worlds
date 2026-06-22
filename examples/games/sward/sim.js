import * as THREE from "three";
import * as W from "./world.js";
import * as Grass from "./grass.js";
import * as El from "./elements.js";
import { PRODUCERS, emptyGoods } from "./social.js";

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

// mult = per-level cost growth: each level of an upgrade costs more than the last
// (steepened for the ~30-day pacing — repeated buys of the same thing bite harder)
export const UPGRADES = {
  rake:        { name: "Auto-rake",   icon: "🧹",   base: 50,   mult: 2.8, max: 8,  desc: "Clears stray debris on its own (faster per level)." },
  sprinkler:   { name: "Sprinkler",   icon: "💦",   base: 120,  mult: 3.3, max: 10, desc: "Keeps the soil watered — faster, lusher growth." },
  fertilizer:  { name: "Fertilizer",  icon: "🌟",   base: 220,  mult: 3.6, max: 12, desc: "Richer soil multiplies grass growth." },
  greenkeeper: { name: "Greenkeeper", icon: "🧑‍🌾", base: 900,  mult: 3.6, max: 8,  desc: "Auto-seeds grass into open ground." },
};

// gameplay state (net.js persists this; localStorage is the C4 stand-in)
export const S = {
  debris: [],                       // {id, x, z, kind, mesh, reward}
  blocked: new Uint8Array(NC),      // 1 = soil can't grow (under debris)
  water: new Float32Array(NC),      // transient moisture overlay 0..1
  upgrades: { rake: 0, sprinkler: 0, fertilizer: 0, greenkeeper: 0 },
  features: [],                     // {id, kind, x, z, stage, stageT, group}
  plotLevel: 0,                     // expansion: how many rings of land are unlocked
  unlocked: {},                     // which feature kinds the player has bought access to
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

// permanent Spore perks — survive a rewild (prestige)
export const PERKS = {
  richSoil:   { name: "Rich soil",      icon: "🌱", base: 2, mult: 1.7, max: 5, desc: "+20% grass growth per level." },
  goldenDew:  { name: "Golden dew",     icon: "💧", base: 2, mult: 1.7, max: 5, desc: "+25% Dew income per level." },
  compost:    { name: "Compost",        icon: "🪱", base: 2, mult: 1.8, max: 3, desc: "+50% Dew from clearing debris per level." },
  earlyBloom: { name: "Early bloom",    icon: "⏩", base: 5, mult: 1,   max: 1, desc: "New features start one stage ahead." },
  greenStart: { name: "Evergreen start", icon: "🌿", base: 4, mult: 1,  max: 1, desc: "Rewilded plots begin with a grassy head start." },
  greenhouse: { name: "Greenhouse",     icon: "🏡", base: 4, mult: 1.8, max: 3, desc: "Longer offline cap (+50%/lvl) & bigger AFK yield (+20%/lvl)." },
};
export const perkLvl = (k) => (G.perks && G.perks[k]) || 0;
export const perkCost = (k) => Math.round(PERKS[k].base * Math.pow(PERKS[k].mult, perkLvl(k)));
export const perkMaxed = (k) => perkLvl(k) >= PERKS[k].max;
export function buyPerk(k) {
  if (!PERKS[k] || perkMaxed(k) || (G.spores || 0) < perkCost(k)) return false;
  G.spores -= perkCost(k); G.perks[k] = perkLvl(k) + 1; return true;
}
// spores banked on rewild, from the ecosystem peak reached (+climax bonus)
export const sporesFor = (peak) => Math.floor(Math.pow(Math.max(0, peak), 1.3)) + (S.climax ? 3 : 0);
export function rewild() {
  const gain = sporesFor(G.ecoPeak || 0);
  for (const f of S.features) if (f.group) W.scene.remove(f.group);
  for (const d of S.debris) if (d.mesh) W.scene.remove(d.mesh);
  S.features.length = 0; featureRoots.length = 0; S.debris.length = 0; debrisRoots.length = 0;
  S.blocked.fill(0); S.water.fill(0); shadeF.fill(0); moistF.fill(0); pollenF.fill(0); nectarF.fill(0); fieldsDirty = true;
  Grass.coverage.fill(0); Grass.health.fill(1);
  G.spores = (G.spores || 0) + gain; G.year = (G.year || 1) + 1;
  G.dew = 0; G.ecoLevel = 0; G.ecoPeak = 0; G.goods = emptyGoods();   // keep perks, almanac, questsDone, stats
  S.upgrades = { rake: 0, sprinkler: 0, fertilizer: 0, greenkeeper: 0 }; // soft upgrades reset (perks are the permanent layer)
  S.plotLevel = 0; S.unlocked = {};
  W.setBoundary(growHalf());
  scatterDebris(15, (G.plotSeed ^ (G.year * 101)) >>> 0);
  if (perkLvl("greenStart")) { seedPatch(0, 0, 6, 0.55); seedPatch(5, 4, 3, 0.4); seedPatch(-5, -4, 3, 0.4); }
  S.lastSeen = Date.now(); Grass.rebuild();
  return gain;
}

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
  const m = W.cloneModel(kind, 1.7 + Math.random() * 1.3, { receive: true });
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
  const span = growHalf() * 2 - 2;
  for (let i = 0; i < n; i++) {
    const x = (rnd() - 0.5) * span, z = (rnd() - 0.5) * span;
    if (!insideGrowable(x, z)) continue;
    spawnDebris(x, z, DEBRIS_KINDS[(rnd() * DEBRIS_KINDS.length) | 0], "deb-" + Date.now().toString(36) + "-" + i);
  }
}
// debris littering a freshly-unlocked outer ring (called on expansion)
function scatterDebrisRing() {
  const outer = growHalf(), inner = Math.max(0, outer - RING);
  for (let i = 0; i < 9; i++) {
    let x, z, tries = 0;
    do { x = (Math.random() - 0.5) * outer * 2; z = (Math.random() - 0.5) * outer * 2; tries++; } while (Math.abs(x) < inner && Math.abs(z) < inner && tries < 24);
    if (!insideGrowable(x, z)) continue;
    spawnDebris(x, z, DEBRIS_KINDS[(Math.random() * DEBRIS_KINDS.length) | 0], "deb-" + Date.now().toString(36) + "-r" + i);
  }
}

// returns reward if a debris was cleared, else 0
export function clearDebris(pickId) {
  const i = S.debris.findIndex((d) => d.id === pickId);
  if (i < 0) return 0;
  const d = S.debris[i];
  if (!insideGrowable(d.x, d.z)) return 0;   // can't clear debris on land you haven't unlocked yet
  W.scene.remove(d.mesh);
  const ri = debrisRoots.indexOf(d.mesh); if (ri >= 0) debrisRoots.splice(ri, 1);
  unblockAround(d.x, d.z, 1.8);
  S.debris.splice(i, 1);
  const reward = Math.round(d.reward * (1 + 0.5 * perkLvl("compost")));
  G.dew += reward; d.reward = reward;
  if (G.stats) G.stats.debrisCleared = (G.stats.debrisCleared || 0) + 1;
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
    const ci = cidx(nx, nz); if (S.blocked[ci] || !growableCell(nx, nz)) continue;
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

// ── plot expansion (the headline Dew sink — unlock your land ring by ring) ────
const START_HALF = 9, RING = 3.5;
export const MAX_PLOT_LEVEL = Math.max(1, Math.floor((W.HALF - 1 - START_HALF) / RING)); // ~7
export const growHalf = () => Math.min(W.HALF - 1, START_HALF + (S.plotLevel || 0) * RING);
export const insideGrowable = (x, z) => { const h = growHalf(); return Math.abs(x) <= h && Math.abs(z) <= h; };
const growableCell = (ix, iz) => { const c = Grass.cellCenter(ix, iz); return insideGrowable(c.x, c.z); };
export const plotMaxed = () => (S.plotLevel || 0) >= MAX_PLOT_LEVEL;
export const expandCost = () => Math.round(450 * Math.pow(4.0, S.plotLevel || 0));
export function expandPlot() {
  if (plotMaxed() || G.dew < expandCost()) return false;
  G.dew -= expandCost(); S.plotLevel = (S.plotLevel || 0) + 1;
  W.setBoundary(growHalf());
  scatterDebrisRing();   // the freshly-unlocked ring comes with debris to clear
  return true;
}

// ── progressive feature unlocks (gate content over the long game) ─────────────
export const UNLOCK_COST = { clover: 150, flowers: 800, shrub: 3200, mushrooms: 10000, pond: 26000, tree: 80000, hive: 220000 };
export const isUnlocked = (kind) => !UNLOCK_COST[kind] || !!(S.unlocked && S.unlocked[kind]);
export const unlockCost = (kind) => UNLOCK_COST[kind] || 0;
export function unlockFeature(kind) {
  if (isUnlocked(kind) || G.dew < unlockCost(kind)) return false;
  G.dew -= unlockCost(kind); (S.unlocked = S.unlocked || {})[kind] = 1; return true;
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

// each additional feature of a kind costs more — placement is a real Dew sink
export const PLACE_MULT = 1.9;
export const placeCost = (kind) => {
  const def = El.FEATURES[kind]; if (!def) return 0;
  let have = 0; for (const f of S.features) if (f.kind === kind) have++;
  return Math.round(def.cost * Math.pow(PLACE_MULT, have));
};
export function placeFeature(kind, x, z, free) {
  const def = El.FEATURES[kind]; if (!def) return null;
  const cost = placeCost(kind);
  if (!free && (!insideGrowable(x, z) || !isUnlocked(kind) || G.dew < cost)) return null;
  if (!free) G.dew -= cost;
  const start = perkLvl("earlyBloom") ? Math.min(1, El.maxStage(kind)) : 0;
  const f = { id: "ft-" + Date.now().toString(36) + "-" + ((Math.random() * 1e6) | 0), kind, x, z, stage: start, stageT: 0 };
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
  const growth = 0.22 * SEASON_GROW[season] * fert * (0.25 + 0.75 * sun) * (1 + 0.2 * perkLvl("richSoil"));

  if (fieldsDirty) computeFields();

  // sprinkler keeps moisture topped up; manual water + rain decay slowly
  for (let i = 0; i < NC; i++) {
    if (sprinkler && !S.blocked[i] && Grass.coverage[i] > 0) S.water[i] = Math.max(S.water[i], 0.35 + 0.13 * sprinkler);
    if (env.rain) S.water[i] = 1;
    S.water[i] = Math.max(0, S.water[i] - dt * 0.05);
  }

  // grow + spread coverage (single relaxation pass into tmp, then commit)
  const keeper = S.upgrades.greenkeeper || 0;
  let green = 0;
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const i = cidx(ix, iz);
    let cov = Grass.coverage[i];
    const cap = 1 - 0.55 * Math.min(1, shadeF[i]);   // grass thins under deep canopy
    if (!S.blocked[i] && growableCell(ix, iz)) {
      const moist = 0.4 + 0.6 * Math.min(1, S.water[i] + moistF[i]);
      // greenkeeper slowly auto-seeds open ground
      if (cov <= 0.02 && keeper) cov += 0.018 * keeper * dt;
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

  // Dew (ecosystem multiplies it — the GROW payoff). Coefficient tuned so a full
  // build (max plot + all unlocks + key upgrades) paces to ~30 days of somewhat
  // active play (~10 effective h/day incl. the 8h idle cap) — see econ model.
  const dewRate = green * 0.0055 * SEASON_DEW[season] * (0.3 + 0.7 * sun) * (1 + G.ecoLevel * 0.28) * (1 + 0.25 * perkLvl("goldenDew"));
  G.dew += dewRate * dt;
  S._dewRate = dewRate;

  // goods production from mature features (tradeable in the market)
  if (G.goods) for (const p of PRODUCERS) {
    let n = 0; for (const f of S.features) if (f.kind === p.kind && f.stage >= p.stage) n++;
    if (n) G.goods[p.good] = (G.goods[p.good] || 0) + p.rate * n * dt * SEASON_DEW[season];
  }

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
    goods: Object.fromEntries(Object.entries(G.goods || {}).map(([k, v]) => [k, Math.round((v || 0) * 10) / 10])),
    almanac: [...(G.almanac || [])], questsDone: [...(G.questsDone || [])], stats: G.stats || {},
    perks: { ...(G.perks || {}) }, year: G.year || 1,
    upgrades: { ...S.upgrades }, plotLevel: S.plotLevel || 0, unlocked: { ...(S.unlocked || {}) },
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
  G.goods = saved && saved.goods ? { ...emptyGoods(), ...saved.goods } : emptyGoods();
  G.almanac = new Set((saved && saved.almanac) || []);
  G.questsDone = new Set((saved && saved.questsDone) || []);
  G.stats = (saved && saved.stats) || { debrisCleared: 0, specimensCaught: 0, neighborsWatered: 0 };
  G.perks = (saved && saved.perks) || {};
  G.year = (saved && saved.year) || 1;
  S.upgrades = { rake: 0, sprinkler: 0, fertilizer: 0, greenkeeper: 0 };
  S.plotLevel = 0; S.unlocked = {};

  if (saved && saved.debris) {
    G.dew = saved.dew || 0; G.spores = saved.spores || 0; G.ecoLevel = saved.ecoLevel || 0; G.ecoPeak = saved.ecoPeak || 0;
    S.upgrades = { rake: 0, sprinkler: 0, fertilizer: 0, greenkeeper: 0, ...(saved.upgrades || {}) };
    S.plotLevel = saved.plotLevel || 0; S.unlocked = { ...(saved.unlocked || {}) };
    for (const fs of saved.features || []) { const f = placeFeature(fs.kind, fs.x, fs.z, true); if (f) { f.stage = fs.stage | 0; f.stageT = fs.stageT || 0; placeMesh(f); } }
    for (const d of saved.debris) {
      if (!insideGrowable(d.x, d.z)) continue;   // never render debris on land that isn't unlocked
      const id = d.id || ("deb-" + Math.random().toString(36).slice(2));
      const m = W.cloneModel(d.kind, 2.0, { receive: true });
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
  W.setBoundary(growHalf());
  Grass.rebuild();   // offline catch-up is now driven by worlds.idle (see runOffline)
}

// ── idle / offline progression (driven by the worlds.idle SDK primitive) ──────
const HOUR = 3600;
export const idleCap = () => 8 * HOUR * (1 + 0.5 * perkLvl("greenhouse"));   // Greenhouse extends the cap
export const idleYieldMult = () => 1 + 0.2 * perkLvl("greenhouse");          // …and the offline yield
const avgCover = () => { let s = 0; for (let i = 0; i < Grass.coverage.length; i++) s += Grass.coverage[i]; return s / Grass.coverage.length; };
const stageSum = () => S.features.reduce((a, f) => a + f.stage, 0);

// Advance the world by `seconds` (already capped by the SDK) at an average-day
// rate, then diff into a report. Returns deltas for the "while you were away" modal.
export function runOffline(seconds) {
  const before = { dew: G.dew, goods: { ...G.goods }, cover: avgCover(), stages: stageSum() };
  const STEP = 30; let t = seconds, guard = 0;
  while (t > 0 && guard++ < 5000) { step(Math.min(STEP, t), { season: 1, sunlight: 0.5, rain: false }); t -= STEP; }
  Grass.rebuild();
  // Greenhouse boosts the offline yield: top up Dew + goods by (mult-1) × what grew
  const mult = idleYieldMult();
  if (mult > 1) {
    G.dew += (G.dew - before.dew) * (mult - 1);
    for (const k in G.goods) G.goods[k] = (G.goods[k] || 0) + ((G.goods[k] || 0) - (before.goods[k] || 0)) * (mult - 1);
  }
  const report = { secs: seconds, dew: Math.round(G.dew - before.dew), goods: {}, grass: Math.round((avgCover() - before.cover) * 100), grown: Math.max(0, stageSum() - before.stages) };
  for (const k in G.goods) { const d = Math.round((G.goods[k] || 0) - (before.goods[k] || 0)); if (d > 0) report.goods[k] = d; }
  return report;
}

export const roots = debrisRoots;
