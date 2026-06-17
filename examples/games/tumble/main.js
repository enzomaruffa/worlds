import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { instantiate, assetNames } from "./level.js";

// ───────────────────────────────────────────────────────────────────────────
// TUMBLE — an endless, synchronized multiplayer obstacle gauntlet on Worlds.
//
// Everyone runs the SAME global level (same seed). Drop in anytime. Clear the
// level before the timer → +1 point. The level rotates to the next when EVERY
// active player has finished OR the per-level timer runs out. Cumulative,
// always-on leaderboard. Players are non-colliding ghosts.
//
// Worlds SDK is the only backend:
//   worlds.actors("tumble")     — per-member ghost state, zone = level:segment,
//                                 so you only sync the runners near you (scales).
//   worlds.room("tumble")       — the global level clock {levelIndex, seed, endsAt}.
//   worlds.ws.channel("tumble-room") — global presence (headcount) + finish pings.
//   worlds.db "leaderboard"     — one doc/handle {handle, name, points}, atomic ++.
// ───────────────────────────────────────────────────────────────────────────

const ACTORS = "tumble";
const ROOM = "tumble";
const ROOM_CH = "tumble-room";
const LEADERBOARD = "leaderboard";

const LEVEL_MS = 80_000; // time budget per level
const SEND_HZ = 18; // client state pushes/sec (server coalesces to its flush rate)
const SEGMENT_LEN = 36; // interest-zone size along the track (ghosts sync within a segment)

const CHUNK_LEN = 26; // length of one obstacle chunk along +Z
const TRACK_HALF = 6.5; // half-width of the standard track
const SAFE_LEN = 4.5; // solid entry strip at the start of every chunk (checkpoint zone)
const VOID_Y = -11; // fall below this → respawn at last checkpoint

const GRAVITY = -34;
const MOVE_SPEED = 12.5;
const ACCEL = 90; // ground responsiveness
const JUMP_V = 13.5;

const { id, esc, toast, colorFor, uniqByHandle } = worlds;
const clientId = id();
const me = { handle: null, name: "you", color: 0xfbbf24 };

const $ = (x) => document.getElementById(x);
const dom = {
  canvas: $("scene"),
  lvlN: $("lvlN"), ptsN: $("ptsN"),
  timeBar: $("timeBar"), timeFill: $("timeBar").firstElementChild,
  finN: $("finN"), finOf: $("finOf"),
  boardList: $("boardList"),
  playerN: $("playerN"),
  msgTxt: $("msgTxt"),
  loader: $("loader"), loaderWho: $("loaderWho"), loaderErr: $("loaderErr"),
};

const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ───────────────────────────────────────────────────────────────────────────
// Seeded PRNG (every client must generate an identical level for a given seed).
// ───────────────────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedFor = (lv) => (Math.imul((lv | 0) ^ 0x9e3779b9, 2654435761) >>> 0) || 1;

// ───────────────────────────────────────────────────────────────────────────
// THREE scene
// ───────────────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a16);
scene.fog = new THREE.Fog(0x0a0a16, 70, 150);

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 400);
camera.position.set(0, 10, -14);

const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x20122e, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1d0, 1.25);
sun.position.set(-30, 60, -20);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 200;
const sc = sun.shadow.camera;
sc.left = -40; sc.right = 40; sc.top = 60; sc.bottom = -60;
scene.add(sun);

// Shared materials (recoloured per level for variety).
const matPlatform = new THREE.MeshStandardMaterial({ color: 0x2b3b6b, roughness: 0.9, metalness: 0.05 });
const matSafe = new THREE.MeshStandardMaterial({ color: 0x35507f, roughness: 0.85 });
const matHazard = new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xb01515, emissiveIntensity: 0.6, roughness: 0.45 });
const matPillar = new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x0e6a78, emissiveIntensity: 0.5, roughness: 0.45 });
const matFinish = new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x0a4020, roughness: 0.6 });
const matStart = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x3a2502, roughness: 0.7 });
const GEO_BOX = new THREE.BoxGeometry(1, 1, 1);
const GEO_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);

// ── Kenney Space Kit props (CC0) — station hardware flanking the gauntlet ──
const ASSETS = {}, ASSET_BOX = {};
// Load authored levels: the editor's live preview (localStorage) when opened
// with ?preview=1, otherwise an optional levels.json shipped in the site folder.
let shippedLevels = []; // from levels.json (optional, baked into the site)
function applyLevels(dbLevels) {
  const all = [...shippedLevels, ...(dbLevels || [])];
  LEVELS = all.length ? all : null; // none anywhere → procedural endless
}
async function loadLevels() {
  // editor preview: play just the previewed level(s), offline
  if (new URLSearchParams(location.search).has("preview")) {
    try { const raw = localStorage.getItem("tumblePreviewLevels"); if (raw) { const d = JSON.parse(raw); LEVELS = Array.isArray(d) ? d : d.levels; } } catch (_) {}
    return;
  }
  // 🌐 shared levels from worlds.db — published live by anyone, no re-deploy
  try {
    await worlds.ready;
    const col = worlds.db.collection("levels");
    const r = await col.list({ limit: 100 });
    applyLevels((r.items || []).map((it) => it.data).filter((l) => l && (l.objects || l.chunks)));
    // live: a newly published level joins the rotation (appended → indices stay stable)
    col.subscribe(async () => {
      try { const rr = await col.list({ limit: 100 }); applyLevels((rr.items || []).map((it) => it.data).filter((l) => l && (l.objects || l.chunks))); } catch (_) {}
    });
  } catch (_) { applyLevels([]); }
}

async function preloadAssets() {
  const loader = new GLTFLoader();
  const names = [
    // Space Kit station hardware
    "barrel", "barrels", "machine_generatorLarge", "machine_wireless", "satelliteDish",
    "turret_single", "structure_detailed", "rocks_smallA", "rocks_smallB", "meteor",
    "meteor_detailed", "platform_large", "monorail_trackSupport", "hangar_smallA",
    // Platformer Kit — festive obstacle-course props, hazards & collectibles
    "sign", "flag", "crate", "crate-strong", "fence-straight", "fence-corner", "poles",
    "tree", "tree-pine", "tree-pine-small", "mushrooms", "rocks", "ladder", "grass",
    "saw", "spike-block", "trap-spikes", "coin-gold",
    ...assetNames(), // every model the level catalog can place
  ];
  await Promise.all(names.map(async (n) => {
    try {
      const g = await loader.loadAsync(`./assets/${n}.glb`);
      ASSETS[n] = g.scene; ASSET_BOX[n] = new THREE.Box3().setFromObject(g.scene);
    } catch (e) { console.warn("asset failed", n, e && e.message); }
  }));
}
const modelHeight = (n) => { const b = ASSET_BOX[n]; return b ? Math.max(b.max.y - b.min.y, 1e-3) : 1; };
function placedClone(name, parent, h, x, y, z, rotY, emissive) {
  if (!ASSETS[name]) return null;
  const m = ASSETS[name].clone();
  m.scale.setScalar(h / modelHeight(name));
  m.position.set(x, y, z);
  if (rotY != null) m.rotation.y = rotY;
  m.traverse((c) => {
    if (!c.isMesh) return;
    c.castShadow = true; c.receiveShadow = false;
    if (emissive && c.material) {
      c.material = c.material.clone();
      if (c.material.color) c.material.emissive = c.material.color.clone();
      c.material.emissiveIntensity = emissive;
    }
  });
  parent.add(m);
  return m;
}

// Procedural neon-grid texture → the track reads as a polished arcade level
// instead of flat colour, and still tints per-level via material.color.
function gridTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const x = c.getContext("2d");
  x.fillStyle = "#ffffff"; x.fillRect(0, 0, 256, 256);
  x.strokeStyle = "rgba(0,0,0,0.34)"; x.lineWidth = 7;
  for (let i = 0; i <= 256; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 256); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(256, i); x.stroke(); }
  x.strokeStyle = "rgba(0,0,0,0.12)"; x.lineWidth = 2;
  for (let i = 0; i <= 256; i += 16) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 256); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(256, i); x.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); t.anisotropy = 4;
  return t;
}
const TRACK_TEX = gridTexture();
matPlatform.map = TRACK_TEX; matPlatform.metalness = 0.15; matPlatform.roughness = 0.75;
matSafe.map = TRACK_TEX;

// Deep-space gradient backdrop + a starfield that follows the runner down the track.
(function sky() {
  const c = document.createElement("canvas"); c.width = 16; c.height = 256;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#05060f"); g.addColorStop(0.55, "#0a0a1c"); g.addColorStop(1, "#1a1230");
  x.fillStyle = g; x.fillRect(0, 0, 16, 256);
  scene.background = new THREE.CanvasTexture(c);
})();
const starfield = (function () {
  const N = 700, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 120 + Math.random() * 140, th = Math.random() * 6.283, ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = Math.abs(r * Math.cos(ph)) * 0.7 + 10;
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xbcd0ff, size: 1.1, sizeAttenuation: true, transparent: true, opacity: 0.85 }));
  scene.add(pts);
  return pts;
})();

// Confetti burst on finishing a level.
const confetti = [];
function burstConfetti(at) {
  const N = 150;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), vel = new Float32Array(N * 3);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    pos[i * 3] = at.x; pos[i * 3 + 1] = at.y + 1.2; pos[i * 3 + 2] = at.z;
    vel[i * 3] = (Math.random() - 0.5) * 11; vel[i * 3 + 1] = 7 + Math.random() * 10; vel[i * 3 + 2] = (Math.random() - 0.5) * 11;
    c.setHSL(Math.random(), 0.85, 0.62); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.34, vertexColors: true, transparent: true, opacity: 1 }));
  scene.add(pts);
  confetti.push({ pts, vel, life: 0 });
}
function stepConfetti(dt) {
  for (let i = confetti.length - 1; i >= 0; i--) {
    const cf = confetti[i]; cf.life += dt;
    const p = cf.pts.geometry.attributes.position.array;
    for (let j = 0; j < p.length; j += 3) {
      cf.vel[j + 1] -= 24 * dt;
      p[j] += cf.vel[j] * dt; p[j + 1] += cf.vel[j + 1] * dt; p[j + 2] += cf.vel[j + 2] * dt;
    }
    cf.pts.geometry.attributes.position.needsUpdate = true;
    cf.pts.material.opacity = Math.max(0, 1 - cf.life / 2.3);
    if (cf.life > 2.3) { scene.remove(cf.pts); cf.pts.geometry.dispose(); cf.pts.material.dispose(); confetti.splice(i, 1); }
  }
}

function box(mat, w, h, d, x, y, z, parent) {
  const m = new THREE.Mesh(GEO_BOX, mat);
  m.scale.set(w, h, d); m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m);
  return m;
}

// ───────────────────────────────────────────────────────────────────────────
// LEVEL — built from seeded chunks. Each chunk has a solid SAFE_LEN entry strip
// (the checkpoint), then a hazard. groundY()/hazards drive gameplay.
// ───────────────────────────────────────────────────────────────────────────
let level = null; // { index, group, nChunks, chunks:[{type,halfW,pits}], hazards:[], finishZ }

function disposeLevel() {
  if (!level) return;
  scene.remove(level.group);
  // dispose ONLY per-level geometries (flagged). Shared GEO_BOX/GEO_CYL and all
  // GLB-derived geometries are reused across levels — disposing them corrupts ASSETS.
  level.group.traverse((o) => { if (o.isMesh && o.userData._disposeGeo) o.geometry.dispose(); });
  level = null;
}

// Authored level packs (from levels.json or the editor preview). When present,
// the level rotation cycles these by index instead of procedural generation;
// every client ships the same file, so index → level is identical for all.
let LEVELS = null;
const CHUNK_TYPES = ["FLAT", "GAPS", "SPINNER", "NARROW", "SLALOM", "SWEEPER", "FINISH"];

// Build ONE chunk of `type` at z0 with an explicit 0..1 `intensity`. Shared by
// the procedural generator and authored levels (the editor speaks the same types).
function buildChunk(type, ci, z0, intensity, rng, group, hazards) {
  const chunk = { type, halfW: TRACK_HALF, pits: [] };
  box(matSafe, TRACK_HALF * 2, 1, SAFE_LEN, 0, -0.5, z0 + SAFE_LEN / 2, group); // checkpoint strip
  const bodyLen = CHUNK_LEN - SAFE_LEN;
  const bodyMidZ = z0 + SAFE_LEN + bodyLen / 2;

  if (type === "FLAT" || type === "FINISH") {
    box(matPlatform, TRACK_HALF * 2, 1, bodyLen, 0, -0.5, bodyMidZ, group);
    if (type === "FINISH") {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_HALF * 2, 1.4), matFinish);
      line.rotation.x = -Math.PI / 2; line.position.set(0, 0.02, z0 + SAFE_LEN + 1.2);
      line.userData._disposeGeo = true; // per-level plane — safe to dispose
      group.add(line);
      for (const s of [-1, 1]) box(matFinish, 0.6, 6, 0.6, s * (TRACK_HALF - 0.4), 3, z0 + SAFE_LEN + 1.2, group);
      box(matFinish, TRACK_HALF * 2, 1.1, 0.4, 0, 6, z0 + SAFE_LEN + 1.2, group);
    }
  } else if (type === "GAPS") {
    const nPits = 1 + (intensity > 0.5 ? Math.floor(rng() * 2) : 0);
    const pits = [];
    let cursor = SAFE_LEN;
    for (let p = 0; p < nPits; p++) {
      const solid = 4 + rng() * 4;
      box(matPlatform, TRACK_HALF * 2, 1, solid, 0, -0.5, z0 + cursor + solid / 2, group);
      cursor += solid;
      const gap = 3.2 + intensity * 3.2 + rng() * 1.5;
      pits.push({ z0: cursor, z1: cursor + gap });
      cursor += gap;
    }
    box(matPlatform, TRACK_HALF * 2, 1, Math.max(2, CHUNK_LEN - cursor), 0, -0.5, z0 + cursor + Math.max(2, CHUNK_LEN - cursor) / 2, group);
    chunk.pits = pits;
  } else if (type === "NARROW") {
    const halfW = clamp(3.2 - intensity * 1.4, 1.6, 3.2);
    chunk.halfW = halfW;
    box(matPlatform, halfW * 2, 1, bodyLen, 0, -0.5, bodyMidZ, group);
    box(matSafe, halfW * 2 + 1.2, 0.4, 1, 0, 0.2, z0 + SAFE_LEN + 0.5, group);
  } else if (type === "SLALOM") {
    box(matPlatform, TRACK_HALF * 2, 1, bodyLen, 0, -0.5, bodyMidZ, group);
    const n = 3 + Math.floor(intensity * 3);
    for (let p = 0; p < n; p++) {
      const px = (p % 2 === 0 ? -1 : 1) * (TRACK_HALF * 0.5);
      const pz = z0 + SAFE_LEN + (bodyLen * (p + 0.5)) / n;
      const m = new THREE.Mesh(GEO_CYL, matPillar);
      m.scale.set(1.6, 3, 1.6); m.position.set(px, 1.5, pz);
      m.castShadow = true; group.add(m);
      hazards.push({ kind: "pillar", x: px, z: pz, r: 1.2 });
    }
  } else if (type === "SPINNER") {
    box(matPlatform, TRACK_HALF * 2, 1, bodyLen, 0, -0.5, bodyMidZ, group);
    const cz = bodyMidZ, arm = TRACK_HALF - 0.3;
    const bar = box(matHazard, arm * 2, 0.7, 0.7, 0, 1.1, cz, group);
    const post = new THREE.Mesh(GEO_CYL, matSafe);
    post.scale.set(0.8, 2.4, 0.8); post.position.set(0, 1.2, cz); group.add(post);
    const speed = (rng() < 0.5 ? 1 : -1) * (1.1 + intensity * 1.3);
    hazards.push({ kind: "spinner", x: 0, z: cz, arm, speed, mesh: bar });
  } else if (type === "SWEEPER") {
    box(matPlatform, TRACK_HALF * 2, 1, bodyLen, 0, -0.5, bodyMidZ, group);
    const cz = bodyMidZ;
    const bar = box(matHazard, 2.4, 0.8, 0.7, 0, 0.6, cz, group);
    const amp = TRACK_HALF - 1.2;
    const speed = 1.4 + intensity * 1.6;
    hazards.push({ kind: "sweeper", z: cz, amp, speed, mesh: bar });
  }
  return chunk;
}

// Decide the chunk plan for a level: an authored sequence (from LEVELS) or the
// procedural ramp. Returns { plan:[{type,intensity}], hue, seed, name }.
function levelPlan(index) {
  const difficulty = clamp(0.2 + index * 0.06, 0.2, 1);
  if (LEVELS && LEVELS.length) {
    const a = LEVELS[(((index - 1) % LEVELS.length) + LEVELS.length) % LEVELS.length];
    const plan = (a.chunks || []).map((c) =>
      typeof c === "string" ? { type: c, intensity: difficulty }
        : { type: c.type, intensity: c.intensity != null ? clamp(+c.intensity, 0, 1) : difficulty });
    if (!plan.length || plan[0].type !== "FLAT") plan.unshift({ type: "FLAT", intensity: 0 });
    if (plan[plan.length - 1].type !== "FINISH") plan.push({ type: "FINISH", intensity: 0 });
    return { plan, hue: a.hue != null ? a.hue : ((index * 47) % 360) / 360, seed: (a.seed != null ? a.seed : index * 2654435761) >>> 0, name: a.name || ("Level " + index) };
  }
  const nChunks = Math.min(5 + Math.floor((index - 1) * 0.8), 18);
  const TYPES = ["GAPS", "SPINNER", "NARROW", "SLALOM", "SWEEPER"];
  const r = mulberry32((index * 2654435761) >>> 0);
  const plan = [];
  for (let ci = 0; ci < nChunks; ci++) {
    const type = ci === 0 ? "FLAT" : ci === nChunks - 1 ? "FINISH" : TYPES[Math.floor(r() * TYPES.length)];
    plan.push({ type, intensity: difficulty });
  }
  return { plan, hue: ((index * 47) % 360) / 360, seed: 0, name: "Level " + index };
}

function buildLevel(seed, index) {
  disposeLevel();
  // authored object-based level (from the 3D editor) takes precedence
  const authored = LEVELS && LEVELS.length ? LEVELS[(((index - 1) % LEVELS.length) + LEVELS.length) % LEVELS.length] : null;
  if (authored && Array.isArray(authored.objects) && authored.objects.length) { buildObjectLevel(authored, index); return; }

  const { plan, hue, seed: planSeed, name } = levelPlan(index);
  const rng = mulberry32((planSeed || seed) >>> 0);
  const group = new THREE.Group();

  // Per-level palette tint keeps successive levels feeling fresh.
  matPlatform.color.setHSL(hue, 0.4, 0.32);
  matSafe.color.setHSL(hue, 0.45, 0.45);

  const nChunks = plan.length;
  const chunks = [];
  const hazards = [];

  box(matStart, TRACK_HALF * 2 + 2, 1, 8, 0, -0.5, -4, group); // start pad (z < 0)
  for (let ci = 0; ci < nChunks; ci++) {
    chunks.push(buildChunk(plan[ci].type, ci, ci * CHUNK_LEN, plan[ci].intensity, rng, group, hazards));
  }
  box(matFinish, TRACK_HALF * 2 + 4, 1, 10, 0, -0.5, nChunks * CHUNK_LEN + 5, group); // finish pad

  dressLevel(group, rng, nChunks);

  scene.add(group);
  level = { index, group, nChunks, chunks, hazards, name, finishZ: nChunks * CHUNK_LEN + 1 };
}

// Build a hand-authored level from placed objects (3D editor output). Collision
// is derived from each object's role: walkable AABBs, hazard volumes, jump pads,
// moving platforms, a start spawn and a finish zone.
function buildObjectLevel(def, index) {
  coins.length = 0; // chunk-dress coins (if any) belonged to the disposed level
  const group = new THREE.Group();
  if (def.hue != null) { matPlatform.color.setHSL(def.hue, 0.4, 0.32); matSafe.color.setHSL(def.hue, 0.45, 0.45); }
  const obj = { walk: [], movers: [], pads: [], hazards: [], coins: [], saws: [], start: null, finish: null };
  let maxZ = 8;
  for (const o of def.objects) {
    const built = instantiate(ASSETS, o);
    group.add(built.group);
    const x = o.x || 0, y = o.y || 0, z = o.z || 0;
    maxZ = Math.max(maxZ, z);
    const aabb = (w, d, top) => ({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top });
    if (built.role === "walk" || built.role === "start" || built.role === "finish") {
      const a = aabb(built.w, built.d, y + built.h / 2);
      obj.walk.push(a);
      if (built.role === "start") obj.start = { x, y: a.top + 0.9, z };
      if (built.role === "finish") obj.finish = a;
    } else if (built.role === "mover") {
      obj.movers.push({ group: built.group, base: new THREE.Vector3(x, y, z), axis: (o.p && o.p.axis) || "x",
        amp: (o.p && o.p.amp) || 7, speed: (o.p && o.p.speed) || 1, w: built.w, d: built.d, h: built.h,
        prev: new THREE.Vector3(x, y, z), delta: new THREE.Vector3(), aabb: aabb(built.w, built.d, y + built.h / 2) });
    } else if (built.role === "pad") {
      obj.pads.push({ ...aabb(built.w, built.d, y + built.h / 2), boost: (o.p && o.p.boost) || 22 });
    } else if (built.role === "spinner") {
      obj.hazards.push({ kind: "spinner", x, z, arm: 6.2, speed: (o.p && o.p.speed) || 1.6, mesh: built.bar });
    } else if (built.role === "sweeper") {
      obj.hazards.push({ kind: "sweeper", x, z, amp: (o.p && o.p.amp) || 5.5, speed: (o.p && o.p.speed) || 1.8, mesh: built.bar });
    } else if (built.role === "pillar") {
      obj.hazards.push({ kind: "pillar", x, z, r: 1.5 });
    } else if (built.role === "kill" || built.role === "saw") {
      obj.hazards.push({ kind: "kill", x, z, r: built.role === "saw" ? 2.2 : 2.0 });
      if (built.role === "saw") obj.saws.push(built.group);
    } else if (built.role === "coin") {
      obj.coins.push(built.group);
    }
  }
  scene.add(group);
  level = { index, group, name: def.name || "Level " + index, obj, finishZ: obj.finish ? obj.finish.maxZ : maxZ + 6 };
}

// per-frame: moving platforms slide, saws & coins spin
function updateObjects(dt, t) {
  if (!level || !level.obj) return;
  for (const m of level.obj.movers) {
    m.prev.copy(m.group.position);
    const off = Math.sin(t * m.speed) * m.amp;
    if (m.axis === "z") m.group.position.set(m.base.x, m.base.y, m.base.z + off);
    else m.group.position.set(m.base.x + off, m.base.y, m.base.z);
    m.delta.subVectors(m.group.position, m.prev);
    const c = m.group.position;
    m.aabb.minX = c.x - m.w / 2; m.aabb.maxX = c.x + m.w / 2;
    m.aabb.minZ = c.z - m.d / 2; m.aabb.maxZ = c.z + m.d / 2; m.aabb.top = c.y + m.h / 2;
  }
  for (const s of level.obj.saws) s.rotation.z += dt * 5;
  for (const c of level.obj.coins) c.rotation.y += dt * 3.2;
}

// Flank the gauntlet with Kenney station hardware + drifting asteroids in the
// void below — pure decoration (parented to the level group, disposed with it).
const EDGE_PROPS = ["sign", "flag", "crate", "crate-strong", "fence-straight", "poles", "tree", "tree-pine", "tree-pine-small", "mushrooms", "rocks", "ladder", "barrels", "machine_wireless"];
const coins = []; // floating collectible-look coins (decoration; spun in the loop)
function dressLevel(group, rng, nChunks) {
  coins.length = 0; // old coins lived on the disposed level group
  if (!Object.keys(ASSETS).length) return; // assets not ready yet — next rebuild dresses it
  const edgeX = TRACK_HALF + 3.0;
  for (let ci = 0; ci < nChunks; ci++) {
    for (const side of [-1, 1]) {
      if (rng() < 0.3) continue; // gaps keep it from feeling like a wall
      const z = ci * CHUNK_LEN + SAFE_LEN + rng() * (CHUNK_LEN - SAFE_LEN);
      const name = EDGE_PROPS[Math.floor(rng() * EDGE_PROPS.length)];
      const h = 2.6 + rng() * 3.2;
      placedClone(name, group, h, side * (edgeX + rng() * 3.5), 0, z, side > 0 ? -Math.PI / 2 + (rng() - 0.5) : Math.PI / 2 + (rng() - 0.5), 0.25);
    }
  }
  // glowing checkpoint posts marking each chunk's safe strip
  for (let ci = 0; ci < nChunks; ci++) {
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(GEO_CYL, matFinish);
      m.scale.set(0.35, 2.6, 0.35);
      m.position.set(side * (TRACK_HALF + 0.6), 1.0, ci * CHUNK_LEN + 0.4);
      group.add(m);
    }
  }
  // floating coins arcing over the track — pure sparkle (no scoring), spun in the loop
  if (ASSETS["coin-gold"]) {
    for (let ci = 1; ci < nChunks - 1; ci++) {
      if (rng() < 0.45) continue;
      const n = 3;
      for (let k = 0; k < n; k++) {
        const z = ci * CHUNK_LEN + SAFE_LEN + 3 + k * 3;
        const c = placedClone("coin-gold", group, 1.5, (rng() - 0.5) * TRACK_HALF, 2.2 + Math.sin(k) * 0.4, z, 0, 0.5);
        if (c) coins.push(c);
      }
    }
  }
  // flag pairs at the start and finish lines
  for (const z of [-1, nChunks * CHUNK_LEN + 1]) {
    for (const side of [-1, 1]) placedClone("flag", group, 4.5, side * (TRACK_HALF + 1.2), 0, z, side > 0 ? -1.2 : 1.2, 0.3);
  }
  // hazard dressing — saws & spikes lining the edges signal danger ahead
  const danger = ["saw", "spike-block", "trap-spikes"].filter((n) => ASSETS[n]);
  for (let ci = 2; ci < nChunks - 1 && danger.length; ci++) {
    if (rng() < 0.5) continue;
    const side = rng() < 0.5 ? -1 : 1;
    placedClone(danger[Math.floor(rng() * danger.length)], group, 2.2 + rng() * 1.6,
      side * (TRACK_HALF + 1.4), 0, ci * CHUNK_LEN + SAFE_LEN + rng() * 6, 0, 0.4);
  }
  // drifting debris in the void for depth
  const junk = ["rocks", "meteor", "rocks_smallA", "barrel"].filter((n) => ASSETS[n]);
  for (let i = 0; i < 24 && junk.length; i++) {
    const z = rng() * nChunks * CHUNK_LEN;
    const side = rng() < 0.5 ? -1 : 1;
    placedClone(junk[Math.floor(rng() * junk.length)], group, 1.5 + rng() * 4,
      side * (TRACK_HALF + 12 + rng() * 40), -8 - rng() * 26, z, rng() * 6.283);
  }
}

function groundY(x, z) {
  if (!level) return 0;
  if (level.obj) {
    let best = null;
    const consider = (a) => { if (x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ && a.top <= player.pos.y + 0.7 && (best === null || a.top > best)) best = a.top; };
    for (const a of level.obj.walk) consider(a);
    for (const m of level.obj.movers) consider(m.aabb);
    return best; // null = over the void → fall
  }
  if (z < 0) return Math.abs(x) <= TRACK_HALF + 1 ? 0 : null; // start pad
  const ci = Math.floor(z / CHUNK_LEN);
  if (ci >= level.nChunks) return Math.abs(x) <= TRACK_HALF + 2 ? 0 : null; // finish pad
  const c = level.chunks[ci];
  if (Math.abs(x) > c.halfW) return null;
  const local = z - ci * CHUNK_LEN;
  if (local < SAFE_LEN) return 0;
  for (const pit of c.pits) if (local >= pit.z0 && local <= pit.z1) return null;
  return 0;
}

// Apply hazards near the player. Returns true if the player should respawn.
function hazardEffect(p, t) {
  if (!level) return false;
  const hazards = level.obj ? level.obj.hazards : level.hazards;
  for (const h of hazards) {
    if (h.kind === "kill") {
      const dx = p.pos.x - h.x, dz = p.pos.z - h.z;
      if (Math.hypot(dx, dz) < h.r && p.pos.y < 2.2) return true; // touched a saw/spikes → reset
      continue;
    }
    if (h.kind === "pillar") {
      const dx = p.pos.x - h.x, dz = p.pos.z - h.z;
      const d = Math.hypot(dx, dz);
      if (d < h.r + 0.6 && d > 0.001) {
        const push = (h.r + 0.6 - d);
        p.pos.x += (dx / d) * push; p.pos.z += (dz / d) * push; // soft slide-off
      }
    } else if (h.kind === "spinner") {
      h.mesh.rotation.y = t * h.speed;
      const dx = p.pos.x - h.x, dz = p.pos.z - h.z;
      const d = Math.hypot(dx, dz);
      if (d < h.arm && d > 0.4 && p.pos.y < 1.8) {
        const pa = Math.atan2(dx, dz);
        let diff = Math.abs(((pa - h.mesh.rotation.y + Math.PI) % (Math.PI)) );
        diff = Math.min(diff, Math.PI - diff);
        if (diff < 0.34) { // swept by the bar → knockback
          p.vel.x += (dx / d) * 11; p.vel.z += (dz / d) * 6; p.vel.y = Math.max(p.vel.y, 6);
          kbFlash();
        }
      }
    } else if (h.kind === "sweeper") {
      const bx = Math.sin(t * h.speed) * h.amp;
      h.mesh.position.x = bx;
      if (Math.abs(p.pos.z - h.z) < 0.9 && Math.abs(p.pos.x - bx) < 1.6 && p.pos.y < 1.3) {
        p.vel.z -= 12; p.vel.y = Math.max(p.vel.y, 7); // knocked back — jump it next time
        kbFlash();
      }
    }
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// Player
// ───────────────────────────────────────────────────────────────────────────
const GEO_EYE = new THREE.SphereGeometry(0.13, 10, 10);
const GEO_PUPIL = new THREE.SphereGeometry(0.06, 8, 8);
const MAT_EYE = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
const MAT_PUPIL = new THREE.MeshStandardMaterial({ color: 0x101018, roughness: 0.5 });
function makeBean(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 0.7, 4, 10), new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
  body.castShadow = true; body.position.y = 0.9;
  // a little face so the runners read as characters, not pills (faces +Z)
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(GEO_EYE, MAT_EYE);
    eye.position.set(sx * 0.22, 1.18, 0.46);
    const pupil = new THREE.Mesh(GEO_PUPIL, MAT_PUPIL);
    pupil.position.set(sx * 0.22, 1.18, 0.57);
    g.add(eye, pupil);
  }
  g.add(body);
  g.userData.mat = body.material;
  g.userData.body = body; // for squash-stretch
  return g;
}

const player = {
  pos: new THREE.Vector3(0, 1.2, -2),
  vel: new THREE.Vector3(),
  heading: 0,
  grounded: false,
  finished: false,
  checkpoint: new THREE.Vector3(0, 1.2, -2),
  curChunk: -1,
  mesh: makeBean(0xfbbf24),
};
scene.add(player.mesh);

function resetPlayer() {
  const s = level && level.obj && level.obj.start;
  if (s) player.pos.set(s.x, s.y + 0.5, s.z); else player.pos.set(0, 1.4, -2);
  player.vel.set(0, 0, 0);
  player.heading = 0;
  player.finished = false;
  player.checkpoint.copy(player.pos);
  player.curChunk = -1;
}

function respawn() {
  player.pos.copy(player.checkpoint);
  player.vel.set(0, 0, 0);
  kbFlash();
}

let flashUntil = 0;
function kbFlash() { flashUntil = performance.now() + 220; }

// ───────────────────────────────────────────────────────────────────────────
// Ghosts (other players) over worlds.actors — dead-reckoned between updates.
// ───────────────────────────────────────────────────────────────────────────
const ghosts = new Map(); // id -> {mesh, mat, target, vel, heading, name, color, label, lastAt}

function makeLabel(text, hex) {
  const cvs = document.createElement("canvas");
  cvs.width = 256; cvs.height = 64;
  const ctx = cvs.getContext("2d");
  ctx.font = "600 30px Space Grotesk, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(0,0,0,.55)";
  ctx.fillStyle = "#" + (hex >>> 0).toString(16).padStart(6, "0");
  ctx.fillText(text.slice(0, 16), 128, 34);
  const tex = new THREE.CanvasTexture(cvs);
  tex.anisotropy = 2;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.scale.set(3.2, 0.8, 1); spr.position.y = 2.3;
  return spr;
}

function makeGhost(gid, s) {
  const color = typeof s.color === "number" ? s.color : 0x88ccff;
  const mesh = makeBean(color);
  const label = makeLabel(s.name || gid, color);
  mesh.add(label);
  scene.add(mesh);
  return { mesh, mat: mesh.userData.mat, target: new THREE.Vector3(s.x, s.y || 0, s.z), vel: { x: 0, z: 0 }, heading: s.ry || 0, name: s.name || gid, color, label, lastAt: performance.now() };
}

function upsertGhost(gid, s) {
  if (!s || typeof s.x !== "number") return;
  let g = ghosts.get(gid);
  if (!g) { g = makeGhost(gid, s); ghosts.set(gid, g); }
  g.target.set(s.x, typeof s.y === "number" ? s.y : g.target.y, s.z);
  g.vel.x = s.vx || 0; g.vel.z = s.vz || 0;
  g.heading = typeof s.ry === "number" ? s.ry : g.heading;
  g.lastAt = performance.now();
  if (typeof s.color === "number" && s.color !== g.color) { g.color = s.color; g.mat.color.setHex(s.color); }
  if (s.name && s.name !== g.name) { g.name = s.name; g.mesh.remove(g.label); g.label = makeLabel(s.name, g.color); g.mesh.add(g.label); }
}

function removeGhost(gid) {
  const g = ghosts.get(gid);
  if (!g) return;
  scene.remove(g.mesh);
  ghosts.delete(gid);
}

function stepGhosts(dt) {
  const now = performance.now();
  for (const [gid, g] of ghosts) {
    if (now - g.lastAt > 6000) { removeGhost(gid); continue; } // stale fallback
    g.target.x += g.vel.x * dt; // dead reckoning: keep moving between packets
    g.target.z += g.vel.z * dt;
    const a = 1 - Math.exp(-12 * dt);
    g.mesh.position.lerp(g.target, a);
    let d = g.heading - g.mesh.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    g.mesh.rotation.y += d * a;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Networking glue: actors + room clock + presence/finish + leaderboard
// ───────────────────────────────────────────────────────────────────────────
let net = null; // worlds.actors
let lvlRoom = null; // worlds.room
let roomCh = null; // presence + fin pings
let endsAt = Date.now() + LEVEL_MS;
let activeHandles = new Set();
let finishers = new Set(); // handles that cleared the CURRENT level
let advancing = false;

let lastSet = 0;
function publishState(now) {
  if (!net) return;
  if (now - lastSet < 1000 / SEND_HZ) return;
  lastSet = now;
  const seg = Math.floor(player.pos.z / SEGMENT_LEN);
  net.set({
    x: r3(player.pos.x), y: r3(player.pos.y), z: r3(player.pos.z), ry: r3(player.heading),
    vx: r3(player.vel.x), vz: r3(player.vel.z),
    lvl: level ? level.index : 0, seg, color: me.color, name: me.name, fin: player.finished,
  });
}

function applyRoom(s) {
  if (!s) return;
  endsAt = s.endsAt || Date.now() + LEVEL_MS;
  if (!level || s.levelIndex !== level.index) {
    buildLevel(s.seed >>> 0, s.levelIndex | 0);
    resetPlayer();
    finishers = new Set();
    flashMessage(LEVELS ? (level.name || "LEVEL " + level.index) : "LEVEL " + (s.levelIndex | 0), false);
    updateHud();
  }
}

async function tryAdvance() {
  if (advancing || !lvlRoom) return;
  const cur = lvlRoom.state;
  if (!cur) return;
  advancing = true;
  const next = (cur.levelIndex | 0) + 1;
  try {
    const ok = await lvlRoom.set({ levelIndex: next, seed: seedFor(next), endsAt: Date.now() + LEVEL_MS });
    if (ok === false) await lvlRoom.refetch(); // someone else advanced — take theirs
  } catch (_) { /* transient; the next tick retries */ }
  setTimeout(() => { advancing = false; }, 1500);
}

function maybeAllFinish() {
  if (activeHandles.size < 1) return;
  for (const h of activeHandles) if (!finishers.has(h)) return;
  tryAdvance(); // everyone present has cleared it — roll early
}

// ── leaderboard (cumulative points) ──
let board = null, myDocId = null, myPoints = 0, rows = [];
async function initBoard() {
  try { board = worlds.db.collection(LEADERBOARD); } catch (_) { return; }
  await refreshBoard();
  const mine = rows.find((r) => r.handle === me.handle);
  if (mine) { myDocId = mine._id; myPoints = mine.points; }
  try { board.subscribe(() => refreshBoard()); } catch (_) {}
  updateHud();
}
async function refreshBoard() {
  if (!board) return;
  try {
    const res = await board.list({ sort: "-points", limit: 12 });
    rows = (res.items || [])
      .map((it) => ({ _id: it.id, handle: it.data?.handle, name: it.data?.name || it.data?.handle || "runner", points: it.data?.points || 0 }))
      .filter((r) => r.handle);
    const mine = rows.find((r) => r.handle === me.handle);
    if (mine) { myDocId = mine._id; myPoints = Math.max(myPoints, mine.points); }
    renderBoard();
    updateHud();
  } catch (_) {}
}
async function scorePoint() {
  myPoints += 1; updateHud();
  if (!board) return;
  try {
    if (!myDocId) {
      const res = await board.list({ filter: { handle: me.handle }, limit: 1 });
      if (res.items && res.items[0]) myDocId = res.items[0].id;
    }
    if (myDocId) await board.increment(myDocId, "points", 1);
    else { const doc = await board.create({ handle: me.handle, name: me.name, points: 1 }); myDocId = doc.id; }
  } catch (_) { /* a missed point is not worth crashing over */ }
}

function onFinish() {
  if (player.finished) return;
  player.finished = true;
  finishers.add(me.handle);
  flashMessage("FINISHED!  +1", true);
  burstConfetti(player.pos);
  scorePoint();
  try { roomCh && roomCh.publish({ t: "fin", handle: me.handle, lvl: level ? level.index : 0 }); } catch (_) {}
  updateHud();
  maybeAllFinish();
}

// ───────────────────────────────────────────────────────────────────────────
// HUD
// ───────────────────────────────────────────────────────────────────────────
let msgTimer = null;
function flashMessage(text, win) {
  dom.msgTxt.textContent = text;
  dom.msgTxt.classList.toggle("win", !!win);
  dom.msgTxt.classList.remove("show");
  void dom.msgTxt.offsetWidth; // restart animation
  dom.msgTxt.classList.add("show");
}

function renderBoard() {
  if (!rows.length) { dom.boardList.innerHTML = '<li class="empty">no points yet — finish a level!</li>'; return; }
  dom.boardList.innerHTML = rows.slice(0, 8).map((r, i) =>
    `<li class="${r.handle === me.handle ? "me" : ""}"><span class="pos">${i + 1}</span><span class="who">${esc(r.name)}</span><span class="pts">${r.points}</span></li>`
  ).join("");
}

function updateHud() {
  if (level) dom.lvlN.textContent = String(level.index);
  dom.ptsN.textContent = String(myPoints);
  const n = Math.max(1, activeHandles.size);
  dom.playerN.textContent = String(n);
  dom.finOf.textContent = String(activeHandles.size || 1);
  let done = 0;
  for (const h of activeHandles) if (finishers.has(h)) done++;
  dom.finN.textContent = String(done);
}

function tickTimerBar() {
  const remain = clamp((endsAt - Date.now()) / LEVEL_MS, 0, 1);
  dom.timeFill.style.width = (remain * 100).toFixed(1) + "%";
  dom.timeBar.classList.toggle("low", endsAt - Date.now() < 10_000);
}

// ───────────────────────────────────────────────────────────────────────────
// Input (keyboard + touch)
// ───────────────────────────────────────────────────────────────────────────
const input = { fwd: false, back: false, left: false, right: false, jump: false };
const keyMap = {
  KeyW: "fwd", ArrowUp: "fwd", KeyS: "back", ArrowDown: "back",
  KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
  Space: "jump",
};
addEventListener("keydown", (e) => { const k = keyMap[e.code]; if (k) { input[k] = true; if (e.code === "Space") e.preventDefault(); } });
addEventListener("keyup", (e) => { const k = keyMap[e.code]; if (k) input[k] = false; });

const isTouch = matchMedia("(pointer: coarse)").matches;
if (isTouch) document.body.classList.add("touch");
function bindBtn(elId, key) {
  const el = $(elId); if (!el) return;
  const on = (e) => { e.preventDefault(); input[key] = true; el.classList.add("held"); };
  const off = (e) => { e.preventDefault(); input[key] = false; el.classList.remove("held"); };
  el.addEventListener("pointerdown", on); el.addEventListener("pointerup", off);
  el.addEventListener("pointerleave", off); el.addEventListener("pointercancel", off);
}
bindBtn("btnUp", "fwd"); bindBtn("btnDown", "back"); bindBtn("btnLeft", "left"); bindBtn("btnRight", "right"); bindBtn("btnJump", "jump");

// ───────────────────────────────────────────────────────────────────────────
// Simulation step
// ───────────────────────────────────────────────────────────────────────────
function stepPlayer(dt, t) {
  const mx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const mz = (input.fwd ? 1 : 0) - (input.back ? 1 : 0);
  // accelerate toward desired horizontal velocity
  const wantX = mx * MOVE_SPEED, wantZ = mz * MOVE_SPEED;
  const k = 1 - Math.exp(-(ACCEL / MOVE_SPEED) * dt);
  player.vel.x += (wantX - player.vel.x) * (player.grounded ? k : k * 0.35);
  player.vel.z += (wantZ - player.vel.z) * (player.grounded ? k : k * 0.35);
  if (mx || mz) player.heading = Math.atan2(player.vel.x, player.vel.z);

  if (input.jump && player.grounded) { player.vel.y = JUMP_V; player.grounded = false; }
  player.vel.y += GRAVITY * dt;

  player.pos.x += player.vel.x * dt;
  player.pos.y += player.vel.y * dt;
  player.pos.z += player.vel.z * dt;

  // ground collision
  const gy = groundY(player.pos.x, player.pos.z);
  if (gy !== null && player.pos.y <= gy + 0.9 && player.vel.y <= 0.01) {
    player.pos.y = gy + 0.9; player.vel.y = 0; player.grounded = true;
  } else {
    player.grounded = false;
  }

  if (hazardEffect(player, t)) { respawn(); return; } // touched a kill hazard
  if (player.pos.y < VOID_Y) respawn();

  if (level && level.obj) {
    // ride moving platforms you're standing on
    if (player.grounded) for (const m of level.obj.movers) {
      const a = m.aabb;
      if (player.pos.x >= a.minX && player.pos.x <= a.maxX && player.pos.z >= a.minZ && player.pos.z <= a.maxZ && Math.abs(a.top + 0.9 - player.pos.y) < 0.25) {
        player.pos.x += m.delta.x; player.pos.z += m.delta.z;
      }
    }
    // jump pads fling you skyward
    if (player.grounded) for (const p of level.obj.pads) {
      if (player.pos.x >= p.minX && player.pos.x <= p.maxX && player.pos.z >= p.minZ && player.pos.z <= p.maxZ) {
        player.vel.y = p.boost; player.grounded = false; kbFlash(); break;
      }
    }
    // forgiving checkpoint: remember the last solid spot you stood on
    if (player.grounded) player.checkpoint.set(player.pos.x, player.pos.y, player.pos.z);
    // finish zone
    const f = level.obj.finish;
    if (f && !player.finished && player.pos.x >= f.minX && player.pos.x <= f.maxX && player.pos.z >= f.minZ && player.pos.z <= f.maxZ) onFinish();
  } else {
    // rolling checkpoint at each chunk's safe entry strip
    if (player.grounded && player.pos.z >= 0) {
      const ci = Math.floor(player.pos.z / CHUNK_LEN);
      if (ci > player.curChunk && level && ci < level.nChunks) {
        player.curChunk = ci;
        player.checkpoint.set(0, 1.4, ci * CHUNK_LEN + 2);
      }
    }
    if (level && !player.finished && player.pos.z >= level.finishZ) onFinish();
  }

  player.mesh.position.copy(player.pos);
  player.mesh.position.y -= 0.9; // bean origin sits at feet
  let d = player.heading - player.mesh.rotation.y;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  player.mesh.rotation.y += d * (1 - Math.exp(-14 * dt));
  // squash & stretch — stretch tall while airborne, squash on the ground
  const body = player.mesh.userData.body;
  if (body) {
    const stretch = player.grounded ? -0.12 : clamp(player.vel.y * 0.018, -0.16, 0.28);
    body.scale.set(1 - stretch * 0.6, 1 + stretch, 1 - stretch * 0.6);
  }
  // knockback flash tint
  player.mesh.userData.mat.emissive.setHex(performance.now() < flashUntil ? 0x661010 : 0x000000);
}

const camGoal = new THREE.Vector3();
const lookGoal = new THREE.Vector3();
const lookCur = new THREE.Vector3();
let lookInit = false;
function stepCamera(dt) {
  camGoal.set(player.pos.x * 0.55, player.pos.y + 9.5, player.pos.z - 13);
  camera.position.lerp(camGoal, 1 - Math.exp(-6 * dt));
  lookGoal.set(player.pos.x * 0.35, player.pos.y + 1.5, player.pos.z + 7);
  if (!lookInit) { lookCur.copy(lookGoal); lookInit = true; }
  lookCur.lerp(lookGoal, 1 - Math.exp(-7 * dt));
  camera.lookAt(lookCur);
}

// ───────────────────────────────────────────────────────────────────────────
// Main loop
// ───────────────────────────────────────────────────────────────────────────
let lastT = performance.now();
let rotCheck = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  const t = now / 1000;

  updateObjects(dt, t);
  stepPlayer(dt, t);
  stepGhosts(dt);
  stepCamera(dt);
  stepConfetti(dt);
  for (const c of coins) { c.rotation.y += dt * 3.2; c.position.y += Math.sin(t * 2 + c.position.z) * dt * 0.3; } // shimmer
  starfield.position.set(player.pos.x, 0, player.pos.z); // keep the stars wrapped around the runner
  publishState(now);
  tickTimerBar();

  // rotation: any client past the deadline tries to advance (conflict-guarded)
  if (now - rotCheck > 400) {
    rotCheck = now;
    if (lvlRoom && lvlRoom.state && Date.now() >= endsAt) tryAdvance();
  }

  renderer.render(scene, camera);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

// ───────────────────────────────────────────────────────────────────────────
// Boot
// ───────────────────────────────────────────────────────────────────────────
async function boot() {
  resize();
  await preloadAssets(); // station props ready before the first level builds
  await loadLevels();    // authored level pack (levels.json) or editor preview
  try {
    const who = await worlds.me();
    me.handle = who.handle; me.name = who.name || who.handle || "you";
    const c = new THREE.Color(colorFor(me.handle)); // deterministic per-handle color
    me.color = c.getHex();
    player.mesh.userData.mat.color.setHex(me.color);
    dom.loaderWho.innerHTML = "running as <b>" + esc(me.name) + "</b>";
  } catch (e) {
    dom.loaderErr.textContent = "couldn't load your identity — playing as guest.";
    me.handle = "guest-" + clientId.slice(0, 4); me.name = "guest";
  }

  // global level clock
  lvlRoom = worlds.room(ROOM, { initial: () => ({ levelIndex: 1, seed: seedFor(1), endsAt: Date.now() + LEVEL_MS }) });
  try { await lvlRoom.ready; } catch (_) {}
  lvlRoom.onChange((s) => applyRoom(s && s.state));
  applyRoom(lvlRoom.state || { levelIndex: 1, seed: seedFor(1), endsAt: Date.now() + LEVEL_MS });

  // ghosts
  net = worlds.actors(ACTORS, { zoneKey: (s) => s.lvl + ":" + s.seg, rate: 15 });
  net.onChange((gid, s) => { if (gid !== clientId) upsertGhost(gid, s); });
  net.onLeave((gid) => removeGhost(gid));

  // presence (headcount) + finish pings
  roomCh = worlds.ws.channel(ROOM_CH);
  activeHandles.add(me.handle);
  roomCh.presence((list) => {
    activeHandles = new Set(uniqByHandle(list || []).map((m) => m.handle));
    activeHandles.add(me.handle);
    updateHud();
    maybeAllFinish();
  });
  roomCh.subscribe((msg) => {
    const p = msg && msg.payload;
    if (p && p.t === "fin" && level && p.lvl === level.index && typeof p.handle === "string") {
      finishers.add(p.handle); updateHud(); maybeAllFinish();
    }
  });
  // keep self in presence + announce liveness
  setInterval(() => { try { roomCh.publish({ t: "hi", handle: me.handle }); } catch (_) {} }, 4000);

  await initBoard();

  dom.loader.classList.add("hide");
  flashMessage(level && level.name && LEVELS ? level.name : "LEVEL " + (level ? level.index : 1), false);
  requestAnimationFrame(frame);
}

boot();
