import * as THREE from "three";
import { cloneModel, ASSETS } from "./world.js";

// ───────────────────────────────────────────────────────────────────────────
// elements.js — the GROW catalog. Each FEATURE is a discrete thing you place
// freely on the plot; it evolves through visible 3D STAGES, gated by time +
// season + a SPATIAL condition (shade / moisture / pollination). Order and
// position decide how high the whole ecosystem climbs.
//
// Data-only catalog + small procedural mesh builders (stage → THREE.Group).
// sim.js owns the live instances, the influence fields, and the evolution tick.
// ───────────────────────────────────────────────────────────────────────────

const mat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: o.r ?? 0.85, metalness: o.m ?? 0, transparent: o.t || false, opacity: o.o ?? 1, emissive: o.e ?? 0x000000, emissiveIntensity: o.ei ?? 0 });

function addModel(group, name, h, opts) {
  const m = cloneModel(name, h, opts || {});
  if (m) group.add(m);
  return m;
}
function scatter(group, builder, n, spread, yJit) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random(), r = spread * (0.2 + Math.random() * 0.8);
    const o = builder(); if (!o) continue;
    o.position.set(Math.cos(a) * r, (yJit ? Math.random() * yJit : 0), Math.sin(a) * r);
    o.rotation.y = Math.random() * 6.28; group.add(o);
  }
}

// ── procedural builders ──────────────────────────────────────────────────────
const REED = new THREE.ConeGeometry(0.06, 1.1, 5);
const LILY = new THREE.CircleGeometry(0.34, 10);
const PETAL = new THREE.SphereGeometry(0.12, 6, 5);
const BERRY = new THREE.SphereGeometry(0.1, 6, 5);

function pond(stage) {
  const g = new THREE.Group();
  const R = [1.2, 2.1, 2.4, 2.7][stage] || 1.2;
  const water = new THREE.Mesh(new THREE.CircleGeometry(R, 26), mat(0x3b86c9, { r: 0.12, m: 0.2, t: true, o: 0.86 }));
  water.rotation.x = -Math.PI / 2; water.position.y = 0.04; water.receiveShadow = true; g.add(water);
  const ring = new THREE.Mesh(new THREE.RingGeometry(R, R + 0.45, 26), mat(0x5a4632, { r: 1 }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; g.add(ring);
  if (stage >= 2) for (let i = 0; i < 10; i++) { const a = i / 10 * 6.28, m = new THREE.Mesh(REED, mat(0x4e8f3a, { r: 0.9 })); m.position.set(Math.cos(a) * R * 0.92, 0.55, Math.sin(a) * R * 0.92); m.castShadow = true; g.add(m); }
  if (stage >= 3) for (let i = 0; i < 4; i++) { const a = Math.random() * 6.28, r = Math.random() * R * 0.6, l = new THREE.Mesh(LILY, mat(0x3f8b46, { r: 0.8 })); l.rotation.x = -Math.PI / 2; l.position.set(Math.cos(a) * r, 0.06, Math.sin(a) * r); g.add(l); }
  return g;
}
function hive(stage) {
  const g = new THREE.Group();
  const col = stage >= 3 ? 0xe6b54a : 0xcaa15a;
  const glow = stage >= 3 ? 0.25 : 0;
  for (let i = 0; i < 4; i++) { const r = 0.5 - i * 0.09, ring = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 0.06, 0.26, 12), mat(col, { r: 0.8, e: glow ? 0xffae2e : 0x000000, ei: glow })); ring.position.y = 0.15 + i * 0.24; ring.castShadow = true; g.add(ring); }
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.08, 8), mat(0x201306)); hole.position.set(0, 0.3, 0.5); g.add(hole);
  return g;
}
function clover(stage) {
  const g = new THREE.Group();
  const n = [10, 22, 40][stage] || 10, R = [0.9, 1.6, 2.2][stage] || 0.9;
  for (let i = 0; i < n; i++) { const a = Math.random() * 6.28, r = Math.random() * R, leaf = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 4), mat(0x5fae3e, { r: 0.85 })); leaf.scale.y = 0.5; leaf.position.set(Math.cos(a) * r, 0.1, Math.sin(a) * r); g.add(leaf); }
  return g;
}
function flowers(stage) {
  const g = new THREE.Group();
  const cols = [0xff7eb0, 0xffd24a, 0xb98cff, 0xff6f5e, 0xfff0a0];
  const n = [6, 10, 16, 26][stage] || 6, R = [0.7, 1.0, 1.4, 2.2][stage] || 0.7;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.28, r = Math.random() * R, x = Math.cos(a) * r, z = Math.sin(a) * r;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 4), mat(0x4e8f3a)); stem.position.set(x, 0.25, z); g.add(stem);
    if (stage >= 1) { const head = new THREE.Mesh(PETAL, mat(stage >= 2 ? cols[i % cols.length] : 0x7faf56, { r: 0.7, e: stage >= 2 ? cols[i % cols.length] : 0, ei: stage >= 2 ? 0.12 : 0 })); head.scale.setScalar(stage >= 2 ? 1 : 0.6); head.position.set(x, 0.52, z); g.add(head); }
  }
  return g;
}
function mushrooms(stage) {
  const g = new THREE.Group();
  const n = [3, 6, 11][stage] || 3;
  scatter(g, () => cloneModel("mushrooms", 0.5 + Math.random() * 0.4, { receive: true }), n, [0.5, 0.9, 1.4][stage] || 0.6, 0);
  return g;
}
function shrub(stage) {
  const g = new THREE.Group();
  addModel(g, "plant_bushLarge", 1.6 + stage * 0.3, { receive: true });
  if (stage >= 1) for (let i = 0; i < (stage >= 2 ? 12 : 6); i++) { const a = Math.random() * 6.28, r = 0.4 + Math.random() * 0.5, b = new THREE.Mesh(BERRY, mat(stage >= 2 ? 0xd23b4e : 0xe7d27a, { r: 0.6, e: stage >= 2 ? 0x6e1822 : 0, ei: 0.15 })); b.position.set(Math.cos(a) * r, 0.7 + Math.random() * 0.7, Math.sin(a) * r); g.add(b); }
  return g;
}
function tree(stage) {
  const g = new THREE.Group();
  const spec = [["treeSmall", 1.0], ["treeSmall", 2.2], ["tree", 3.6], ["tree", 5.4], ["treeLarge", 7.2]][stage] || ["treeSmall", 1.0];
  if (!addModel(g, spec[0], spec[1], { receive: true })) {
    // fallback procedural tree if GLB missing
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, spec[1] * 0.5, 6), mat(0x6b4a2c)); trunk.position.y = spec[1] * 0.25; trunk.castShadow = true; g.add(trunk);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(spec[1] * 0.35, 8, 6), mat(0x4e8f3a)); crown.position.y = spec[1] * 0.6; crown.castShadow = true; g.add(crown);
  }
  return g;
}

// ── catalog ───────────────────────────────────────────────────────────────────
// stage: { name, t (sec to next), gate? } ; gate flags read by sim's evolution tick
export const FEATURES = {
  tree: {
    name: "Tree", icon: "🌳", cost: 60, radius: 6, build: tree,
    emits: "shade", emitFrom: 3,                   // casts shade from "mature"
    stages: [
      { name: "seedling", t: 35 }, { name: "sapling", t: 55, gate: { notSeason: [3] } },
      { name: "young", t: 75, gate: { notSeason: [3] } }, { name: "mature", t: 110, gate: { notSeason: [3] } },
      { name: "ancient" },
    ],
  },
  pond: {
    name: "Pond", icon: "💧", cost: 80, radius: 8, build: pond,
    emits: "moist", emitFrom: 1,
    stages: [{ name: "puddle", t: 30 }, { name: "pond", t: 55 }, { name: "reeds", t: 80 }, { name: "lilies & frogs" }],
  },
  flowers: {
    name: "Wildflowers", icon: "🌸", cost: 45, radius: 3, build: flowers,
    emits: "nectar", emitFrom: 2,
    stages: [{ name: "seeds", t: 28 }, { name: "buds", t: 45, gate: { notSeason: [3] } },
      { name: "bloom", t: 70, gate: { season: [0, 1] } }, { name: "spreading meadow", gate: { pollen: true } }],
  },
  hive: {
    name: "Beehive", icon: "🐝", cost: 110, radius: 7, build: hive,
    emits: "pollen", emitFrom: 2,
    stages: [{ name: "empty", t: 25 }, { name: "scouting", t: 45, gate: { nectar: true } },
      { name: "active", t: 80, gate: { nectar: true } }, { name: "honey", t: 120, gate: { nectar: true } }, { name: "swarm" }],
  },
  clover: {
    name: "Clover", icon: "🍀", cost: 35, radius: 4, build: clover,
    stages: [{ name: "sprig", t: 30 }, { name: "patch", t: 55 }, { name: "lush" }],
  },
  shrub: {
    name: "Berry shrub", icon: "🫐", cost: 55, radius: 2, build: shrub,
    stages: [{ name: "shrub", t: 40 }, { name: "flowering", t: 65, gate: { season: [0, 1] } }, { name: "berries" }],
  },
  mushrooms: {
    name: "Mushrooms", icon: "🍄", cost: 40, radius: 2, build: mushrooms,
    stages: [{ name: "spores", t: 30, gate: { shade: true } }, { name: "caps", t: 55, gate: { shade: true } }, { name: "fairy ring" }],
  },
};
export const FEATURE_KEYS = Object.keys(FEATURES);

// emergent critters (life.js spawns these from ecosystem conditions; data here)
export const CRITTERS = {
  bee: { from: "pollen+nectar", color: 0xffd24a, count: 8 },
  frog: { from: "pond:3", color: 0x49a36b, count: 3 },
  butterfly: { from: "flowers:2+summer", color: 0xff8fb1, count: 6 },
  rabbit: { from: "clover:2", color: 0xcbb79b, count: 2 },
  bird: { from: "tree:3", color: 0x6fa8dc, count: 3 },
};

// models the catalog needs preloaded
export const MODEL_NAMES = ["treeSmall", "tree", "treeLarge", "tree_fat", "plant_bushLarge", "mushrooms", "flower_redA"];

export function stageMesh(kind, stage) {
  const f = FEATURES[kind]; if (!f) return new THREE.Group();
  const g = f.build(Math.min(stage, f.stages.length - 1));
  g.traverse((c) => { if (c.isMesh) { c.castShadow = c.castShadow || true; } });
  return g;
}
export const maxStage = (kind) => FEATURES[kind].stages.length - 1;
export const stageName = (kind, s) => FEATURES[kind].stages[Math.min(s, maxStage(kind))].name;
