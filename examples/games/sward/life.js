import * as THREE from "three";
import { scene, heightAt, PLOT, HALF } from "./world.js";
import * as Sim from "./sim.js";
import * as Sky from "./sky.js";

// ───────────────────────────────────────────────────────────────────────────
// life.js — the watchable payoff. Critters EMERGE from your composition (they're
// not placed): bees ferry an active hive ↔ blooming flowers, butterflies dance
// over a summer meadow, frogs settle a reedy pond, rabbits hop a lush clover
// patch. Seeing them is proof your GROW design clicked. (Live events + catchable
// moments build on this in C8.)
// ───────────────────────────────────────────────────────────────────────────

const mat = (c, e = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, emissive: e ? c : 0x000000, emissiveIntensity: e });
const SPH = new THREE.SphereGeometry(1, 8, 6);
let critters = [];

function findFeatures(kind, minStage) { return Sim.S.features.filter((f) => f.kind === kind && f.stage >= minStage); }
const near = (a) => ({ x: a.x + (Math.random() - 0.5) * 2.4, z: a.z + (Math.random() - 0.5) * 2.4 });

function makeBee() {
  const m = new THREE.Mesh(SPH, mat(0xffd24a, 0.4)); m.scale.setScalar(0.12); scene.add(m);
  return { type: "bee", mesh: m, t: Math.random(), dir: 1, a: null, b: null, sp: 0.5 + Math.random() * 0.5, bob: Math.random() * 6.28 };
}
function makeButterfly(col) {
  const g = new THREE.Group();
  for (const s of [-1, 1]) { const w = new THREE.Mesh(new THREE.CircleGeometry(0.18, 8), new THREE.MeshStandardMaterial({ color: col, side: THREE.DoubleSide, emissive: col, emissiveIntensity: 0.25, roughness: 0.6 })); w.position.x = s * 0.1; w.rotation.y = s * 0.6; g.add(w); }
  scene.add(g);
  return { type: "butterfly", mesh: g, home: null, ph: Math.random() * 6.28, flap: 0, sp: 0.5 + Math.random() };
}
function makeHopper(type, col, sc) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(SPH, mat(col)); body.scale.set(sc, sc * 0.8, sc * 1.2); g.add(body);
  if (type === "rabbit") for (const s of [-1, 1]) { const ear = new THREE.Mesh(SPH, mat(col)); ear.scale.set(0.06, 0.18, 0.06); ear.position.set(s * 0.08, sc * 0.7, -sc * 0.4); g.add(ear); }
  scene.add(g);
  return { type, mesh: g, home: null, x: 0, z: 0, tx: 0, tz: 0, hopT: Math.random() * 2, jump: 0, sp: 1 };
}
function remove(c) { scene.remove(c.mesh); }

// Rebuild the critter set to match the current ecosystem. Called on a slow cadence.
export function sync() {
  for (const c of critters) remove(c);
  critters = [];
  const season = Sky.seasonIndex();

  // bees: an active hive + blooming flowers in range
  const hives = findFeatures("hive", 2), blooms = findFeatures("flowers", 2);
  if (hives.length && blooms.length) {
    for (let i = 0; i < 8; i++) { const b = makeBee(); b.a = hives[i % hives.length]; b.b = blooms[i % blooms.length]; critters.push(b); }
  }
  // butterflies: blooming flowers, spring/summer
  if (blooms.length && (season === 0 || season === 1)) {
    for (let i = 0; i < 6; i++) { const bf = makeButterfly([0xff8fb1, 0xffd24a, 0xb98cff, 0x8fd0ff][i % 4]); bf.home = blooms[i % blooms.length]; critters.push(bf); }
  }
  // frogs: a reedy/lily pond
  for (const p of findFeatures("pond", 3)) for (let i = 0; i < 3; i++) { const f = makeHopper("frog", 0x49a36b, 0.18); f.home = p; f.x = p.x; f.z = p.z; f.tx = p.x; f.tz = p.z; critters.push(f); }
  // rabbits: lush clover
  for (const cl of findFeatures("clover", 2)) for (let i = 0; i < 2; i++) { const r = makeHopper("rabbit", 0xcbb79b, 0.22); r.home = cl; r.x = cl.x; r.z = cl.z; r.tx = cl.x; r.tz = cl.z; critters.push(r); }
}

export function update(dt, t) {
  for (const c of critters) {
    if (c.type === "bee") {
      if (!c.a || !c.b) continue;
      c.t += c.dir * c.sp * dt * 0.5; if (c.t > 1) { c.t = 1; c.dir = -1; } else if (c.t < 0) { c.t = 0; c.dir = 1; }
      c.bob += dt * 8;
      const x = c.a.x + (c.b.x - c.a.x) * c.t, z = c.a.z + (c.b.z - c.a.z) * c.t;
      c.mesh.position.set(x, heightAt(x, z) + 1.1 + Math.sin(c.bob) * 0.25, z);
    } else if (c.type === "butterfly") {
      if (!c.home) continue;
      c.ph += dt * c.sp; c.flap += dt * 14;
      const x = c.home.x + Math.cos(c.ph) * 1.6, z = c.home.z + Math.sin(c.ph * 0.8) * 1.6;
      c.mesh.position.set(x, heightAt(x, z) + 1.0 + Math.sin(c.ph * 1.7) * 0.4, z);
      c.mesh.rotation.y = c.ph; c.mesh.children[0].rotation.y = 0.6 + Math.sin(c.flap) * 0.7; c.mesh.children[1].rotation.y = -0.6 - Math.sin(c.flap) * 0.7;
    } else { // hoppers
      c.hopT -= dt;
      if (c.hopT <= 0) { c.hopT = 1.2 + Math.random() * 2; const p = near(c.home); c.tx = p.x; c.tz = p.z; c.jump = 1; }
      c.x += (c.tx - c.x) * Math.min(1, dt * 3); c.z += (c.tz - c.z) * Math.min(1, dt * 3);
      c.jump = Math.max(0, c.jump - dt * 3);
      const sc = c.type === "frog" ? 0.18 : 0.22;
      c.mesh.position.set(c.x, heightAt(c.x, c.z) + sc * 0.8 + Math.sin((1 - c.jump) * Math.PI) * c.jump * 0.6, c.z);
      c.mesh.rotation.y = Math.atan2(c.tx - c.x, c.tz - c.z);
    }
  }
  updateCatch(dt);
  const ek = currentEvent()?.key ?? null;
  if (ek !== lastEvent) { if (ek === "windstorm") Sim.scatterDebris(3, (Sky.gameNow() | 0)); lastEvent = ek; }
}
let lastEvent = null;

export function clear() { for (const c of critters) remove(c); critters = []; clearCatch(); }
export const count = () => critters.length;
export const activeTypes = () => new Set(critters.map((c) => c.type));

// ── live events (deterministic from the shared clock) ─────────────────────────
export const EVENTS = [
  { key: "shower",    name: "Spring shower",     icon: "🌧️", seasons: [0], win: [0.34, 0.58], rain: true },
  { key: "migration", name: "Monarch migration", icon: "🦋", seasons: [1], win: [0.3, 0.72] },
  { key: "fireflies", name: "Firefly night",     icon: "✨", seasons: [0, 1], win: [0.82, 0.98] },
  { key: "windstorm", name: "Autumn windstorm",  icon: "🍂", seasons: [2], win: [0.4, 0.62] },
  { key: "frost",     name: "First frost",       icon: "❄️", seasons: [3], win: [0.18, 0.42] },
  { key: "festival",  name: "Bloom festival",    icon: "🎏", seasons: [0, 1, 2], win: [0.46, 0.64] },
];
function hashInt(n) { n = (n ^ 0x9e3779b9) >>> 0; n = Math.imul(n ^ (n >>> 16), 0x45d9f3b) >>> 0; return (n ^ (n >>> 16)) >>> 0; }
export function currentEvent() {
  const day = Math.floor(Sky.gameNow() / Sky.DAY_MS), season = Sky.seasonIndex(), t = Sky.dayT();
  const elig = EVENTS.filter((e) => !e.seasons || e.seasons.includes(season));
  if (!elig.length) return null;
  const e = elig[hashInt(day * 7 + season) % elig.length];
  return (t > e.win[0] && t < e.win[1]) ? e : null;
}
export const isRaining = () => { const e = currentEvent(); return !!(e && e.rain); };

// ── catchable critters ("a bug flies by") ─────────────────────────────────────
export const catchRoots = [];
let catchT = 2;
const CATCH = {
  monarch:  { name: "monarch", icon: "🦋", dew: 26, color: 0xff8a3c },
  firefly:  { name: "firefly", icon: "✨", dew: 16, color: 0xc8ff7a, glow: true },
  ladybug:  { name: "ladybug", icon: "🐞", dew: 20, color: 0xe23b3b },
  dragonfly:{ name: "dragonfly", icon: "🪰", dew: 22, color: 0x6fd0e6 },
};
function spawnCatchable(type) {
  const def = CATCH[type]; if (!def) return;
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), new THREE.MeshStandardMaterial({ color: def.color, emissive: def.color, emissiveIntensity: def.glow ? 0.9 : 0.45, roughness: 0.5 }));
  const side = Math.random() < 0.5 ? -1 : 1;
  const z = (Math.random() - 0.5) * PLOT * 0.7;
  m.position.set(side * (HALF + 3), 4 + Math.random() * 4, z);
  m.userData.pickId = "catch-" + Date.now().toString(36) + (Math.random() * 1000 | 0); m.userData.kind = "catch";
  m.userData.vx = -side * (3 + Math.random() * 2); m.userData.ph = Math.random() * 6.28; m.userData.ttl = 14; m.userData.type = type;
  scene.add(m); catchRoots.push(m);
}
export function tryCatch(id) {
  const i = catchRoots.findIndex((m) => m.userData.pickId === id); if (i < 0) return null;
  const m = catchRoots[i], def = CATCH[m.userData.type];
  scene.remove(m); catchRoots.splice(i, 1);
  return { type: m.userData.type, name: def.name, icon: def.icon, dew: def.dew, specimen: true };
}
function clearCatch() { for (const m of catchRoots) scene.remove(m); catchRoots.length = 0; }
function updateCatch(dt) {
  const ev = currentEvent();
  catchT -= dt;
  if (catchT <= 0) {
    const migrating = ev && ev.key === "migration", night = Sky.dayT() > 0.8 || Sky.dayT() < 0.18;
    catchT = migrating ? 1.2 + Math.random() * 1.5 : 6 + Math.random() * 8;
    if (catchRoots.length < (migrating ? 6 : 2)) {
      const type = migrating ? "monarch" : night ? "firefly" : ["ladybug", "monarch", "dragonfly"][Math.random() * 3 | 0];
      spawnCatchable(type);
    }
  }
  for (let i = catchRoots.length - 1; i >= 0; i--) {
    const m = catchRoots[i]; m.userData.ttl -= dt; m.userData.ph += dt * 4;
    m.position.x += m.userData.vx * dt; m.position.y += Math.sin(m.userData.ph) * dt * 1.2;
    if (m.userData.ttl <= 0 || Math.abs(m.position.x) > HALF + 5) { scene.remove(m); catchRoots.splice(i, 1); }
  }
}
