import * as THREE from "three";

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
const matHazard = new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0x661010, roughness: 0.5 });
const matPillar = new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x07383f, roughness: 0.5 });
const matFinish = new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x0a4020, roughness: 0.6 });
const matStart = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x3a2502, roughness: 0.7 });
const GEO_BOX = new THREE.BoxGeometry(1, 1, 1);
const GEO_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);

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
  level.group.traverse((o) => { if (o.isMesh && o.geometry !== GEO_BOX && o.geometry !== GEO_CYL) o.geometry.dispose(); });
  level = null;
}

function buildLevel(seed, index) {
  disposeLevel();
  const rng = mulberry32(seed >>> 0);
  const group = new THREE.Group();

  // Per-level palette tint keeps successive levels feeling fresh.
  const hue = ((index * 47) % 360) / 360;
  matPlatform.color.setHSL(hue, 0.4, 0.32);
  matSafe.color.setHSL(hue, 0.45, 0.45);

  const nChunks = Math.min(5 + Math.floor((index - 1) * 0.8), 18);
  const difficulty = clamp(0.2 + index * 0.06, 0.2, 1); // ramps hazard intensity
  const chunks = [];
  const hazards = [];

  // start pad (z < 0)
  box(matStart, TRACK_HALF * 2 + 2, 1, 8, 0, -0.5, -4, group);

  const TYPES = ["GAPS", "SPINNER", "NARROW", "SLALOM", "SWEEPER"];
  for (let ci = 0; ci < nChunks; ci++) {
    const z0 = ci * CHUNK_LEN;
    let type = "FLAT";
    if (ci === 0) type = "FLAT";
    else if (ci === nChunks - 1) type = "FINISH";
    else type = TYPES[Math.floor(rng() * TYPES.length)];
    const chunk = { type, halfW: TRACK_HALF, pits: [] };

    // Solid entry strip (always safe — this is the chunk's checkpoint).
    box(matSafe, TRACK_HALF * 2, 1, SAFE_LEN, 0, -0.5, z0 + SAFE_LEN / 2, group);
    const bodyLen = CHUNK_LEN - SAFE_LEN;
    const bodyMidZ = z0 + SAFE_LEN + bodyLen / 2;

    if (type === "FLAT" || type === "FINISH") {
      box(matPlatform, TRACK_HALF * 2, 1, bodyLen, 0, -0.5, bodyMidZ, group);
      if (type === "FINISH") {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_HALF * 2, 1.4), matFinish);
        line.rotation.x = -Math.PI / 2; line.position.set(0, 0.02, z0 + SAFE_LEN + 1.2);
        group.add(line);
        for (const s of [-1, 1]) box(matFinish, 0.6, 6, 0.6, s * (TRACK_HALF - 0.4), 3, z0 + SAFE_LEN + 1.2, group);
        const banner = box(matFinish, TRACK_HALF * 2, 1.1, 0.4, 0, 6, z0 + SAFE_LEN + 1.2, group);
        banner.material = matFinish;
      }
    } else if (type === "GAPS") {
      // 1–2 pits you must jump. Draw the solid segments around them.
      const nPits = 1 + (difficulty > 0.5 ? Math.floor(rng() * 2) : 0);
      const pits = [];
      let cursor = SAFE_LEN;
      for (let p = 0; p < nPits; p++) {
        const solid = 4 + rng() * 4;
        box(matPlatform, TRACK_HALF * 2, 1, solid, 0, -0.5, z0 + cursor + solid / 2, group);
        cursor += solid;
        const gap = 3.2 + difficulty * 3.2 + rng() * 1.5;
        pits.push({ z0: cursor, z1: cursor + gap });
        cursor += gap;
      }
      box(matPlatform, TRACK_HALF * 2, 1, Math.max(2, CHUNK_LEN - cursor), 0, -0.5, z0 + cursor + Math.max(2, CHUNK_LEN - cursor) / 2, group);
      chunk.pits = pits;
    } else if (type === "NARROW") {
      const halfW = clamp(3.2 - difficulty * 1.4, 1.6, 3.2);
      chunk.halfW = halfW;
      box(matPlatform, halfW * 2, 1, bodyLen, 0, -0.5, bodyMidZ, group);
      box(matSafe, halfW * 2 + 1.2, 0.4, 1, 0, 0.2, z0 + SAFE_LEN + 0.5, group); // little ramp lip
    } else if (type === "SLALOM") {
      box(matPlatform, TRACK_HALF * 2, 1, bodyLen, 0, -0.5, bodyMidZ, group);
      const n = 3 + Math.floor(difficulty * 3);
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
      const cz = bodyMidZ;
      const arm = TRACK_HALF - 0.3;
      const bar = box(matHazard, arm * 2, 0.7, 0.7, 0, 1.1, cz, group);
      const post = new THREE.Mesh(GEO_CYL, matSafe);
      post.scale.set(0.8, 2.4, 0.8); post.position.set(0, 1.2, cz); group.add(post);
      const speed = (rng() < 0.5 ? 1 : -1) * (1.1 + difficulty * 1.3);
      hazards.push({ kind: "spinner", x: 0, z: cz, arm, speed, mesh: bar });
    } else if (type === "SWEEPER") {
      box(matPlatform, TRACK_HALF * 2, 1, bodyLen, 0, -0.5, bodyMidZ, group);
      const cz = bodyMidZ;
      const bar = box(matHazard, 2.4, 0.8, 0.7, 0, 0.6, cz, group); // LOW bar — jump it
      const amp = TRACK_HALF - 1.2;
      const speed = 1.4 + difficulty * 1.6;
      hazards.push({ kind: "sweeper", z: cz, amp, speed, mesh: bar });
    }

    chunks.push(chunk);
  }

  // finish pad past the last chunk
  box(matFinish, TRACK_HALF * 2 + 4, 1, 10, 0, -0.5, nChunks * CHUNK_LEN + 5, group);

  scene.add(group);
  level = { index, group, nChunks, chunks, hazards, finishZ: nChunks * CHUNK_LEN + 1 };
}

function groundY(x, z) {
  if (!level) return 0;
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
  for (const h of level.hazards) {
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
function makeBean(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 0.7, 4, 10), new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
  body.castShadow = true; body.position.y = 0.9;
  g.add(body);
  g.userData.mat = body.material;
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
  player.pos.set(0, 1.4, -2);
  player.vel.set(0, 0, 0);
  player.heading = 0;
  player.finished = false;
  player.checkpoint.set(0, 1.4, -2);
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
    flashMessage("LEVEL " + (s.levelIndex | 0), false);
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

  hazardEffect(player, t);

  if (player.pos.y < VOID_Y) respawn();

  // rolling checkpoint at each chunk's safe entry strip
  if (player.grounded && player.pos.z >= 0) {
    const ci = Math.floor(player.pos.z / CHUNK_LEN);
    if (ci > player.curChunk && level && ci < level.nChunks) {
      player.curChunk = ci;
      player.checkpoint.set(0, 1.4, ci * CHUNK_LEN + 2);
    }
  }

  // finish
  if (level && !player.finished && player.pos.z >= level.finishZ) onFinish();

  player.mesh.position.copy(player.pos);
  player.mesh.position.y -= 0.9; // bean origin sits at feet
  let d = player.heading - player.mesh.rotation.y;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  player.mesh.rotation.y += d * (1 - Math.exp(-14 * dt));
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

  stepPlayer(dt, t);
  stepGhosts(dt);
  stepCamera(dt);
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
  flashMessage("LEVEL " + (level ? level.index : 1), false);
  requestAnimationFrame(frame);
}

boot();
