// ───────────────────────────────────────────────────────────────────────────
// TUMBLE — shared level object catalog + builder.
//
// One source of truth for "what objects can be in a level and how they look",
// imported by BOTH the game (main.js) and the 3D editor (editor.js), so the two
// can never drift. An object is `{ k, x, y, z, ry, w?, h?, d?, s?, p? }`:
//   k = kind, x/y/z = position, ry = yaw, w/h/d = box dims (boxy kinds),
//   s = uniform scale (model kinds), p = extra params (speed/axis/amp…).
// instantiate() returns { group, role, ...gameplay } — the game reads `role`
// to drive collision; the editor just shows `group`.
// ───────────────────────────────────────────────────────────────────────────
import * as THREE from "three";

// role: walk = walkable surface · start/finish = special pads · spinner/sweeper/
// pillar/kill = hazards · pad = jump boost · mover = moving platform · decor = none
export const KINDS = {
  // ── platforms (walkable) ──────────────────────────────────────────────────
  platform: { cat: "Track", label: "Platform", role: "walk", box: [13, 1, 16], color: 0x2b3b6b, grid: true },
  tile:     { cat: "Track", label: "Tile", role: "walk", box: [5, 1, 5], color: 0x2b3b6b, grid: true },
  beam:     { cat: "Track", label: "Narrow beam", role: "walk", box: [3.4, 1, 16], color: 0x35507f, grid: true },
  big:      { cat: "Track", label: "Big pad", role: "walk", box: [22, 1, 22], color: 0x2b3b6b, grid: true },
  start:    { cat: "Track", label: "Start pad", role: "start", box: [16, 1, 8], color: 0xf59e0b },
  finish:   { cat: "Track", label: "Finish pad", role: "finish", box: [16, 1, 10], color: 0x22c55e },
  // ── moving / boost / surfaces ──────────────────────────────────────────────
  mover:    { cat: "Motion", label: "Moving platform", role: "mover", box: [8, 1, 8], color: 0x7c3aed, grid: true, p: { axis: "x", amp: 7, speed: 1 } },
  jumppad:  { cat: "Motion", label: "Jump pad", role: "pad", box: [5, 0.7, 5], color: 0x22d3ee, p: { boost: 22 } },
  ice:      { cat: "Motion", label: "Ice (slippery)", role: "ice", box: [10, 1, 10], color: 0xbfe8ff, grid: true },
  bounce:   { cat: "Motion", label: "Bounce pad", role: "bounce", box: [6, 1, 6], color: 0x34d399, p: { boost: 17 } },
  conveyor: { cat: "Motion", label: "Conveyor belt", role: "conveyor", box: [6, 1, 14], color: 0x5b6472, grid: true, p: { dir: "z", speed: 7 } },
  crumble:  { cat: "Motion", label: "Crumble tile", role: "crumble", box: [5, 1, 5], color: 0xe0a341, grid: true, p: { delay: 0.45 } },
  // ── hazards ──────────────────────────────────────────────────────────────
  spinner:  { cat: "Hazard", label: "Spinner bar", role: "spinner", color: 0xef4444, p: { speed: 1.6 } },
  sweeper:  { cat: "Hazard", label: "Sweeper bar", role: "sweeper", color: 0xef4444, p: { speed: 1.8, amp: 5.5 } },
  pillar:   { cat: "Hazard", label: "Pillar", role: "pillar", color: 0x22d3ee },
  ball:     { cat: "Hazard", label: "Wrecking ball", role: "ball", model: "meteor", s: 3, p: { amp: 1.0, speed: 1.3, len: 7 } },
  boulder:  { cat: "Hazard", label: "Rolling boulder", role: "boulder", model: "meteor", s: 2.6, p: { speed: 11, span: 34 } },
  fan:      { cat: "Hazard", label: "Push fan", role: "fan", color: 0x60a5fa, p: { dir: "z", force: 22, range: 11 } },
  spikes:   { cat: "Hazard", label: "Spikes (reset)", role: "kill", model: "spike-block", s: 2.4 },
  saw:      { cat: "Hazard", label: "Saw (reset)", role: "saw", model: "saw", s: 2.2 },
  // ── decoration (Kenney — no collision) ─────────────────────────────────────
  tree:     { cat: "Decor", label: "Tree", role: "decor", model: "tree", s: 4 },
  pine:     { cat: "Decor", label: "Pine", role: "decor", model: "tree-pine", s: 4 },
  crate:    { cat: "Decor", label: "Crate", role: "decor", model: "crate", s: 1.8 },
  sign:     { cat: "Decor", label: "Sign", role: "decor", model: "sign", s: 2.2 },
  fence:    { cat: "Decor", label: "Fence", role: "decor", model: "fence-straight", s: 1.6 },
  flag:     { cat: "Decor", label: "Flag", role: "decor", model: "flag", s: 4 },
  coin:     { cat: "Decor", label: "Coin", role: "coin", model: "coin-gold", s: 1.5 },
  mushrooms:{ cat: "Decor", label: "Mushrooms", role: "decor", model: "mushrooms", s: 1.4 },
  rocks:    { cat: "Decor", label: "Rocks", role: "decor", model: "rocks", s: 2 },
  barrel:   { cat: "Decor", label: "Barrel", role: "decor", model: "barrel", s: 2 },
  dish:     { cat: "Decor", label: "Satellite dish", role: "decor", model: "satelliteDish", s: 5 },
  generator:{ cat: "Decor", label: "Generator", role: "decor", model: "machine_generatorLarge", s: 6 },
  hangar:   { cat: "Decor", label: "Hangar", role: "decor", model: "hangar_smallA", s: 10 },
};

// asset (GLB) names every model-backed kind needs — callers preload these
export function assetNames() {
  return [...new Set(Object.values(KINDS).filter((k) => k.model).map((k) => k.model))];
}

// shared materials (so game + editor render identically), built lazily
const _mat = {};
function gridTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const x = c.getContext("2d");
  x.fillStyle = "#ffffff"; x.fillRect(0, 0, 256, 256);
  x.strokeStyle = "rgba(0,0,0,0.34)"; x.lineWidth = 7;
  for (let i = 0; i <= 256; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 256); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(256, i); x.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); t.anisotropy = 4;
  return t;
}
let _grid = null;
function matFor(def) {
  const key = def.color + (def.grid ? "g" : "") + (def.role === "kill" || def.role === "saw" ? "" : "");
  if (_mat[key]) return _mat[key];
  const m = new THREE.MeshStandardMaterial({ color: def.color, roughness: def.role === "ice" ? 0.12 : 0.7, metalness: def.role === "ice" ? 0.2 : 0.1 });
  if (def.role === "spinner" || def.role === "sweeper") { m.emissive = new THREE.Color(0xb01515); m.emissiveIntensity = 0.6; }
  if (def.role === "pillar") { m.emissive = new THREE.Color(0x0e6a78); m.emissiveIntensity = 0.5; }
  if (def.role === "ice") { m.emissive = new THREE.Color(0x2b5a7a); m.emissiveIntensity = 0.22; }
  if (def.role === "bounce") { m.emissive = new THREE.Color(0x0f7a52); m.emissiveIntensity = 0.4; }
  if (def.grid) { if (!_grid) _grid = gridTexture(); m.map = _grid; }
  _mat[key] = m;
  return m;
}

const GEO_BOX = new THREE.BoxGeometry(1, 1, 1);
const GEO_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 16);

function modelHeight(ASSETS, name) {
  const a = ASSETS && ASSETS[name];
  if (!a) return 1;
  const b = new THREE.Box3().setFromObject(a);
  return Math.max(b.max.y - b.min.y, 1e-3);
}

// Build the THREE object for `o` and return it + its gameplay descriptor.
// `emissive` adds the powered-structure self-glow used in the dressed game.
export function instantiate(ASSETS, o) {
  const def = KINDS[o.k] || KINDS.platform;
  const group = new THREE.Group();
  group.position.set(o.x || 0, o.y || 0, o.z || 0);
  group.rotation.y = o.ry || 0;
  const params = Object.assign({}, def.p, o.p);
  let extra = {};

  if (def.box) {
    const w = o.w || def.box[0], h = o.h || def.box[1], d = o.d || def.box[2];
    const mesh = new THREE.Mesh(GEO_BOX, matFor(def));
    mesh.scale.set(w, h, d); mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    extra = { w, h, d };
    if (def.role === "finish") {
      const post = matFor(KINDS.finish);
      for (const s of [-1, 1]) { const m = new THREE.Mesh(GEO_BOX, post); m.scale.set(0.6, 6, 0.6); m.position.set(s * (w / 2 - 0.4), 3, 0); group.add(m); }
      const banner = new THREE.Mesh(GEO_BOX, post); banner.scale.set(w, 1.1, 0.4); banner.position.y = 6; group.add(banner);
    }
    if (def.role === "pad" || def.role === "bounce") {
      const col = def.role === "bounce" ? 0x86efac : 0x9ef6ff;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(w * 0.32, 0.2, 10, 24), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = h / 2 + 0.1; ring.userData._disposeGeo = true; group.add(ring);
    }
    if (def.role === "conveyor") {
      const chev = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
      for (let i = -1; i <= 1; i++) { const a = new THREE.Mesh(GEO_BOX, chev); a.scale.set(w * 0.5, 0.14, 0.7); a.position.set(0, h / 2 + 0.08, i * (d / 4)); group.add(a); }
    }
  } else if (def.role === "ball") {
    const len = params.len || 7;
    const pivot = new THREE.Group(); pivot.position.y = len; group.add(pivot);
    const arm = new THREE.Mesh(GEO_CYL, matFor({ color: 0x6b7280 })); arm.scale.set(0.2, len, 0.2); arm.position.y = -len / 2; pivot.add(arm);
    const a = ASSETS && ASSETS[def.model];
    let ball;
    if (a) { ball = a.clone(); ball.scale.setScalar((o.s || def.s) / modelHeight(ASSETS, def.model)); ball.traverse((c) => { if (c.isMesh) c.castShadow = true; }); }
    else ball = new THREE.Mesh(new THREE.SphereGeometry(1.6, 18, 14), matFor({ color: 0x8a8a94 }));
    ball.position.y = -len; pivot.add(ball);
    extra = { pivot, ball, len };
  } else if (def.role === "boulder") {
    const a = ASSETS && ASSETS[def.model];
    let ball;
    if (a) { ball = a.clone(); ball.scale.setScalar((o.s || def.s) / modelHeight(ASSETS, def.model)); ball.traverse((c) => { if (c.isMesh) c.castShadow = true; }); }
    else ball = new THREE.Mesh(new THREE.SphereGeometry(1.7, 18, 14), matFor({ color: 0x8a8a94 }));
    ball.position.y = 1.6; group.add(ball);
    extra = { ball };
  } else if (def.role === "fan") {
    const house = new THREE.Mesh(GEO_BOX, matFor({ color: 0x3a4250 })); house.scale.set(3.2, 3.2, 1.2); house.position.y = 1.6; house.castShadow = true; group.add(house);
    const disc = new THREE.Mesh(GEO_CYL, matFor({ color: def.color })); disc.scale.set(2.6, 0.25, 2.6); disc.rotation.x = Math.PI / 2; disc.position.set(0, 1.6, 0.7); group.add(disc);
    extra = { disc };
  } else if (def.role === "spinner") {
    const bar = new THREE.Mesh(GEO_BOX, matFor(def)); bar.scale.set(12.4, 0.7, 0.7); bar.position.y = 1.1; group.add(bar);
    const post = new THREE.Mesh(GEO_CYL, matFor(KINDS.start)); post.scale.set(0.8, 2.4, 0.8); post.position.y = 1.2; group.add(post);
    extra = { bar };
  } else if (def.role === "sweeper") {
    const bar = new THREE.Mesh(GEO_BOX, matFor(def)); bar.scale.set(2.4, 0.8, 0.7); bar.position.y = 0.6; group.add(bar);
    extra = { bar };
  } else if (def.role === "pillar") {
    const m = new THREE.Mesh(GEO_CYL, matFor(def)); m.scale.set(2.4, 3.2, 2.4); m.position.y = 1.5; m.castShadow = true; group.add(m);
  } else if (def.model) {
    const a = ASSETS && ASSETS[def.model];
    if (a) {
      const m = a.clone();
      m.scale.setScalar((o.s || def.s || 2) / modelHeight(ASSETS, def.model));
      m.traverse((c) => { if (c.isMesh) { c.castShadow = true; } });
      group.add(m);
      extra = { model: m };
    } else {
      // fallback marker so a missing asset is still placeable/visible
      const m = new THREE.Mesh(GEO_BOX, matFor({ color: 0x888892 })); m.scale.set(1.5, 1.5, 1.5); m.position.y = 0.75; group.add(m);
    }
  }
  return { group, role: def.role, kind: o.k, ...extra };
}
