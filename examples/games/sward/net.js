import * as THREE from "three";
import * as W from "./world.js";
import * as El from "./elements.js";

// ───────────────────────────────────────────────────────────────────────────
// net.js — the neighborhood. Each player owns one persistent plot doc in
// worlds.db ("plots", one per handle). Plots are laid out on a deterministic
// spiral so everyone agrees who's adjacent. Neighbours render as LOD tiles
// (coverage-tinted ground + nameplate + feature markers). Live gardeners ride
// worlds.actors; watering/gifting rides a worlds.ws channel.
// Falls back to localStorage when the SDK/db is unavailable (single-player).
// ───────────────────────────────────────────────────────────────────────────

const COL = "plots", ACT = "sward", CH = "sward";
const SPACING = W.PLOT + 20;

let G = null, col = null, myId = null, chan = null, actorsNet = null;
let saveTimer = null, onListCb = null, onWaterCb = null;
const neighbors = new Map();   // handle → { data, group, offset }
const avatars = new Map();     // cid → { group, target, name }
let usingLocal = false;

// ── deterministic spiral layout ───────────────────────────────────────────────
function spiral(n) {
  if (!n) return { gx: 0, gz: 0 };
  let x = 0, z = 0, leg = 1, dir = 0, step = 0;
  const D = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (let i = 1; i <= n; i++) { x += D[dir][0]; z += D[dir][1]; if (++step === leg) { step = 0; dir = (dir + 1) % 4; if (dir % 2 === 0) leg++; } }
  return { gx: x, gz: z };
}
function offsetFor(plotIndex) {
  const me = spiral(G.plotIndex), c = spiral(plotIndex);
  return new THREE.Vector3((c.gx - me.gx) * SPACING, 0, (c.gz - me.gz) * SPACING);
}
export function plotOffset(handle) {
  if (handle === G.me.handle) return new THREE.Vector3(0, 0, 0);
  const n = neighbors.get(handle); return n ? n.offset.clone() : null;
}

// ── persistence ───────────────────────────────────────────────────────────────
const localKey = () => "sward:" + G.me.handle;
function localLoad() { try { const r = localStorage.getItem(localKey()); return r ? JSON.parse(r) : null; } catch { return null; } }
function localSave(p) { try { localStorage.setItem(localKey(), JSON.stringify(p)); } catch {} }

export async function init(g) {
  G = g;
  try {
    col = worlds.db.collection(COL);
    const mine = await col.list({ filter: { handle: G.me.handle }, limit: 1 });
    if (mine.items && mine.items[0]) { myId = mine.items[0].id; const d = mine.items[0].data; G.plotIndex = d.plotIndex ?? 0; return d; }
    const all = await col.list({ limit: 500 });
    G.plotIndex = (all.items || []).length;
    const created = await col.create({ handle: G.me.handle, name: G.me.name, color: G.me.color, plotIndex: G.plotIndex });
    myId = created.id;
    return null;
  } catch (e) {
    console.warn("[sward] db unavailable — single-player local mode", e && e.message);
    usingLocal = true; G.plotIndex = 0; return localLoad();
  }
}

function payloadOf(data) { return { ...data, handle: G.me.handle, name: G.me.name, color: G.me.color, plotIndex: G.plotIndex }; }
export function save(data) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveImmediate(data), 1500);
}
export function saveImmediate(data) {
  const payload = payloadOf(data);
  if (usingLocal || !col || !myId) return localSave(payload);
  col.replace(myId, payload).catch(() => localSave(payload));
}

// ── neighbour LOD tiles ───────────────────────────────────────────────────────
const KIND_COLOR = { tree: 0x3f9e34, pond: 0x3b86c9, flowers: 0xff8fb1, hive: 0xe6b54a, clover: 0x5fae3e, shrub: 0x9a6fd0, mushrooms: 0xd23b4e };

function nameplate(name, eco, color) {
  const c = document.createElement("canvas"); c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(12,24,16,.82)"; g.beginPath(); g.roundRect(2, 2, 252, 60, 14); g.fill();
  g.fillStyle = color; g.beginPath(); g.arc(26, 32, 9, 0, 7); g.fill();
  g.fillStyle = "#eaf5ea"; g.font = "600 26px Quicksand, sans-serif"; g.textBaseline = "middle";
  g.fillText(name.slice(0, 12), 44, 28); g.fillStyle = "#9fe06a"; g.font = "600 18px Quicksand"; g.fillText("🌿 " + eco, 44, 50);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(8, 2, 1); sp.renderOrder = 20; return sp;
}

function buildNeighbor(d, offset) {
  const g = new THREE.Group(); g.position.copy(offset);
  const avg = d.cov && d.cov.length ? d.cov.reduce((a, b) => a + b, 0) / (d.cov.length * 15) : 0;
  const base = new THREE.Mesh(new THREE.BoxGeometry(W.PLOT, 2.4, W.PLOT), new THREE.MeshStandardMaterial({ color: 0x6f5238, roughness: 1 }));
  base.position.y = -1.2; base.receiveShadow = true; g.add(base);
  const top = new THREE.Mesh(new THREE.PlaneGeometry(W.PLOT - 1, W.PLOT - 1), new THREE.MeshStandardMaterial({ color: new THREE.Color(0x7a5a38).lerp(new THREE.Color(0x4f9e3a), avg), roughness: 0.95 }));
  top.rotation.x = -Math.PI / 2; top.position.y = 0.05; top.receiveShadow = true; g.add(top);
  const np = nameplate(d.name || d.handle, d.ecoLevel || 0, d.color || "#6cc24a"); np.position.set(0, 9, 0); g.add(np);
  rebuildMarkers(g, d);
  g.userData.pickPlot = d.handle;
  W.scene.add(g);
  return g;
}
function rebuildMarkers(group, d) {
  for (const m of [...group.children]) if (m.userData.marker) group.remove(m);
  const MARK = new THREE.ConeGeometry(0.7, 2.2, 6);
  for (const f of d.features || []) {
    const col = KIND_COLOR[f.kind] || 0x9fe06a;
    const mk = new THREE.Mesh(MARK, new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.25, roughness: 0.6 }));
    mk.position.set(f.x, 1.1 + f.stage * 0.5, f.z); mk.scale.setScalar(0.7 + f.stage * 0.25); mk.userData.marker = true; mk.castShadow = true; group.add(mk);
  }
}
function updateNeighbor(n, d) {
  n.data = d;
  const top = n.group.children.find((c) => c.geometry && c.geometry.type === "PlaneGeometry");
  if (top) { const avg = d.cov ? d.cov.reduce((a, b) => a + b, 0) / (d.cov.length * 15) : 0; top.material.color = new THREE.Color(0x7a5a38).lerp(new THREE.Color(0x4f9e3a), avg); }
  const np = n.group.children.find((c) => c.isSprite); if (np) { n.group.remove(np); }
  n.group.add(nameplate(d.name || d.handle, d.ecoLevel || 0, d.color || "#6cc24a"));
  n.group.children.filter((c) => c.isSprite).slice(0, -1).forEach((s) => n.group.remove(s));
  rebuildMarkers(n.group, d);
}

let refreshT = null;
async function refreshNeighbors() {
  if (!col) return;
  let items = [];
  try { items = (await col.list({ limit: 200 })).items || []; } catch { return; }
  const live = new Set();
  for (const it of items) {
    const d = it.data; if (!d || !d.handle || d.handle === G.me.handle) continue;
    live.add(d.handle);
    const off = offsetFor(d.plotIndex ?? 0);
    let n = neighbors.get(d.handle);
    if (!n) { n = { data: d, offset: off, group: buildNeighbor(d, off) }; neighbors.set(d.handle, n); }
    else { n.offset.copy(off); n.group.position.copy(off); updateNeighbor(n, d); }
  }
  for (const [h, n] of [...neighbors]) if (!live.has(h)) { W.scene.remove(n.group); neighbors.delete(h); }
  if (onListCb) onListCb(neighborList());
}
export function startNeighbors(cb) {
  onListCb = cb;
  if (!col) { if (cb) cb([]); return; }
  refreshNeighbors();
  try { col.subscribe(() => { clearTimeout(refreshT); refreshT = setTimeout(refreshNeighbors, 600); }); } catch {}
}
export function neighborList() {
  return [...neighbors.values()].map((n) => ({ handle: n.data.handle, name: n.data.name || n.data.handle, color: n.data.color || "#6cc24a", eco: n.data.ecoLevel || 0 }));
}

// ── presence (live gardeners) ─────────────────────────────────────────────────
let capGeo = null, headGeo = null;
function makeAvatar(name, color) {
  const g = new THREE.Group();
  capGeo = capGeo || new THREE.CylinderGeometry(0.5, 0.6, 1.5, 8); headGeo = headGeo || new THREE.SphereGeometry(0.5, 10, 8);
  const c = new THREE.Color().setStyle(color || "#6cc24a");
  const body = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 })); body.position.y = 0.75; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(headGeo, new THREE.MeshStandardMaterial({ color: 0xf0d8b0, roughness: 0.8 })); head.position.y = 1.8; head.castShadow = true; g.add(head);
  g.add(nameplate(name || "gardener", "", color || "#6cc24a"));
  g.children[g.children.length - 1].position.set(0, 3.0, 0);
  g.children[g.children.length - 1].scale.set(5, 1.25, 1);
  W.scene.add(g); return g;
}
export function startPresence() {
  try {
    actorsNet = worlds.actors(ACT, { rate: 8 });
    actorsNet.onChange((id, state) => {
      if (!state) return;
      let a = avatars.get(id);
      if (!a) { a = { group: makeAvatar(state.name, state.color), target: new THREE.Vector3() }; avatars.set(id, a); }
      const base = plotOffset(state.h) || new THREE.Vector3();
      a.target.set(base.x + (state.ox || 0), 0, base.z + (state.oz || 0));
    });
    actorsNet.onLeave((id) => { const a = avatars.get(id); if (a) { W.scene.remove(a.group); avatars.delete(id); } });
  } catch (e) { /* no presence offline */ }
}
let presT = 0; const presOff = { ox: (Math.random() - 0.5) * 9, oz: (Math.random() - 0.5) * 9 };
export function tickPresence(dt) {
  presT += dt;
  if (actorsNet && presT > 0.25) {
    presT = 0;
    actorsNet.set({ h: G.visiting || G.me.handle, name: G.me.name, color: G.me.color, ox: presOff.ox, oz: presOff.oz });
  }
  for (const a of avatars.values()) {
    a.group.position.lerp(a.target, Math.min(1, dt * 3));
    a.group.position.y = W.heightAt(a.group.position.x, a.group.position.z);
  }
}

// ── water / gift channel ──────────────────────────────────────────────────────
export function startChannel(onWater) {
  onWaterCb = onWater;
  try {
    chan = worlds.ws.channel(CH);
    chan.subscribe((msg) => { const p = msg && msg.payload; if (!p) return; if (p.t === "water" && p.to === G.me.handle && onWaterCb) onWaterCb(p); });
  } catch {}
}
export function water(handle, fromName) { if (chan) try { chan.publish({ t: "water", to: handle, from: G.me.handle, fromName }); } catch {} }

export const isVisiting = () => !!(G && G.visiting);
