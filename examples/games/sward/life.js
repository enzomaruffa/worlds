import * as THREE from "three";
import { scene, heightAt } from "./world.js";
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
}

export function clear() { for (const c of critters) remove(c); critters = []; }
export const count = () => critters.length;
