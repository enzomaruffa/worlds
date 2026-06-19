import * as THREE from "three";
import * as W from "./world.js";

// ───────────────────────────────────────────────────────────────────────────
// SWARD — a multiplayer 3D incremental grass-plot game on Worlds.
// You own an empty patch of land. Clean the dirt, grow real 3D grass, and plant
// a tiny ecosystem that evolves through living seasons under a sweeping sun.
// main.js boots the world, owns the RAF loop, and glues the systems together.
// (grass, sky, sim, elements, life, social, net land in later commits.)
// ───────────────────────────────────────────────────────────────────────────

const { id, esc, toast, colorFor } = worlds;

const $ = (x) => document.getElementById(x);
const dom = {
  canvas: $("scene"),
  ownerName: $("ownerName"), ownerDot: $("ownerDot"),
  hint: $("hint"), msgTxt: $("msgTxt"),
  loader: $("loader"), loaderWho: $("loaderWho"), loaderErr: $("loaderErr"),
};

// Shared, mutable game state — populated across systems. Persisted via net.js.
export const G = {
  me: { handle: "you", name: "you", color: "hsl(110 60% 55%)" },
  color3: new THREE.Color(0x6cc24a),
  plotIndex: 0,
  plotSeed: 1,
  dew: 0, spores: 0, ecoLevel: 0,
  tool: null,            // current palette selection
  visiting: null,        // handle of a neighbor we're viewing, or null
  booted: false,
};

function flash(text) { dom.msgTxt.textContent = text; dom.msgTxt.classList.remove("show"); void dom.msgTxt.offsetWidth; dom.msgTxt.classList.add("show"); }

// expose a couple helpers other modules will lean on
export const helpers = { flash, toast, esc };

// ── pointer → ground cursor (placement feedback; real tools wired in C4/C5) ──
let pointer = { x: 0, y: 0, on: false };
function onMove(e) {
  const t = e.touches ? e.touches[0] : e;
  pointer.x = t.clientX; pointer.y = t.clientY; pointer.on = true;
}
dom.canvas.addEventListener("pointermove", onMove);
dom.canvas.addEventListener("pointerleave", () => { pointer.on = false; });

// ── main loop ────────────────────────────────────────────────────────────────
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (pointer.on) {
    const g = W.pickGround(pointer.x, pointer.y);
    if (g && W.insidePlot(g.x, g.z)) W.setCursor(g.x, g.z, true);
    else W.setCursor(null);
  } else W.setCursor(null);

  W.tickControls();
  W.render();
}

// ── boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  try { await worlds.ready; } catch (_) {}
  try {
    const m = await worlds.me();
    if (m && m.handle) G.me = { handle: m.handle, name: m.name || m.handle, color: m.color || colorFor(m.handle) };
  } catch (_) {
    G.me = { handle: id().slice(0, 6), name: "gardener", color: colorFor(id()) };
  }
  G.color3 = new THREE.Color().setStyle(G.me.color);
  dom.ownerName.textContent = G.me.name + "'s plot";
  dom.ownerDot.style.background = G.me.color;

  // deterministic plot seed from handle (stable terrain per owner)
  let h = 0; for (const c of G.me.handle) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  G.plotSeed = h || 1;

  dom.loaderWho.innerHTML = `welcome, <b>${esc(G.me.name)}</b>`;

  W.initWorld(dom.canvas, G.plotSeed);
  W.focusCamera(0, 0, 50);

  // a few props for early visual life (debris + features expand in later commits)
  await W.loadModels(["rocks", "rocks_smallA", "rocks_smallB", "stump_round", "log", "grass"]);

  // scatter a little starter debris so the empty plot has something to clean
  scatterStarterDebris();

  G.booted = true;
  dom.loader.classList.add("hide");
  requestAnimationFrame(frame);
}

// Temporary debris scatter (real clean→Dew loop arrives in C4). Visual for now.
const debrisRoots = [];
function scatterStarterDebris() {
  const kinds = ["rocks", "rocks_smallA", "rocks_smallB", "stump_round", "log"];
  const rng = mulberry32(G.plotSeed ^ 0xABCDEF);
  for (let i = 0; i < 14; i++) {
    const x = (rng() - 0.5) * (W.PLOT - 6), z = (rng() - 0.5) * (W.PLOT - 6);
    if (!W.insidePlot(x, z)) continue;
    const kind = kinds[(rng() * kinds.length) | 0];
    const m = W.cloneModel(kind, 1.1 + rng() * 0.8, { receive: true });
    if (!m) continue;
    m.position.set(x, W.heightAt(x, z), z);
    m.rotation.y = rng() * Math.PI * 2;
    m.userData.pickId = "debris-" + i; m.userData.kind = "debris";
    W.scene.add(m); debrisRoots.push(m);
  }
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export { mulberry32, debrisRoots };

boot().catch((e) => {
  console.error(e);
  dom.loaderErr.textContent = "Failed to start: " + (e && e.message || e);
});
