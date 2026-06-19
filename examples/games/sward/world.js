import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// ───────────────────────────────────────────────────────────────────────────
// world.js — the Three.js stage for a plot of land.
//   • a gently rolling heightmap "plot" (deterministic value noise per plotSeed)
//   • orbit-overview camera (you look DOWN at your patch, you don't walk it)
//   • raycasting helpers: pick the ground (place) and pick objects (clean/inspect)
//   • a soft placement cursor ring
//   • a tiny glTF model registry (clone + auto-scale by height)
// Lights live here but are *driven* by sky.js (sun sweeps, colour, season).
// ───────────────────────────────────────────────────────────────────────────

export const PLOT = 72;          // plot side length, world units (big — unlocked ring by ring)
export const HALF = PLOT / 2;
export const HILL = 3.0;         // peak-to-trough terrain height
const SEG = 128;                 // ground mesh resolution

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87bde6);
scene.fog = new THREE.Fog(0x87bde6, PLOT * 1.6, PLOT * 4.2);

export const camera = new THREE.PerspectiveCamera(52, 1, 0.2, 600);
camera.position.set(0, 34, 40);

// lights — sky.js mutates colour/intensity/position every frame
export const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x4a5b3a, 0.85);
export const sun = new THREE.DirectionalLight(0xfff1d0, 1.5);
export const ambient = new THREE.AmbientLight(0xffffff, 0.12);

let renderer = null, controls = null, groundMesh = null, cursor = null;
let plotSeed = 1;

// ── deterministic 2D value noise (terrain shape; stable per plotSeed) ─────────
function hash2(ix, iz) {
  let h = (Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(plotSeed, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const n00 = hash2(x0, z0), n10 = hash2(x0 + 1, z0), n01 = hash2(x0, z0 + 1), n11 = hash2(x0 + 1, z0 + 1);
  const a = n00 + (n10 - n00) * sx, b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sz;
}
// Height at world (x,z). Edges ease down so the plot reads as a raised patch.
export function heightAt(x, z) {
  const f = 0.085;
  let h = vnoise(x * f, z * f) * 1.0 + vnoise(x * f * 2.7 + 11, z * f * 2.7 - 5) * 0.34;
  h = h / 1.34;                       // → ~0..1
  const edge = Math.max(Math.abs(x), Math.abs(z)) / HALF;
  const falloff = THREE.MathUtils.clamp(1 - Math.pow(Math.max(0, edge - 0.78) / 0.22, 1.6), 0, 1);
  return (h - 0.5) * HILL * 2 * (0.35 + 0.65 * falloff) - (1 - falloff) * 1.6;
}
export const insidePlot = (x, z) => Math.abs(x) <= HALF - 1.2 && Math.abs(z) <= HALF - 1.2;

// ── procedural soil texture ───────────────────────────────────────────────
function soilTexture() {
  const s = 256, c = document.createElement("canvas"); c.width = c.height = s;
  const g = c.getContext("2d");
  g.fillStyle = "#6f5238"; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = Math.random() * 2.2 + 0.4;
    const t = Math.random();
    g.fillStyle = t < .5 ? "rgba(60,42,28,.5)" : t < .8 ? "rgba(120,92,62,.45)" : "rgba(40,30,20,.55)";
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(7, 7);
  tex.anisotropy = 4;
  return tex;
}

function buildGround() {
  const geo = new THREE.PlaneGeometry(PLOT, PLOT, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: soilTexture(), roughness: 1, metalness: 0, color: 0xb89878 });
  groundMesh = new THREE.Mesh(geo, mat);
  groundMesh.receiveShadow = true;
  groundMesh.name = "ground";
  scene.add(groundMesh);

  // a low earthen rim + corner posts so the plot reads as "owned"
  const rim = new THREE.Group();
  const postGeo = new THREE.CylinderGeometry(0.34, 0.4, 2.0, 7);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.95 });
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [sx, sz] of corners) {
    const x = sx * (HALF - 0.6), z = sz * (HALF - 0.6);
    const p = new THREE.Mesh(postGeo, postMat);
    p.position.set(x, heightAt(x, z) + 0.7, z); p.castShadow = true; p.receiveShadow = true;
    rim.add(p);
  }
  scene.add(rim);

  // skirt: dark sides so the raised plot doesn't look like a floating sheet
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0x3c2c1e, roughness: 1 });
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(PLOT, 8, PLOT), skirtMat);
  skirt.position.y = -4 - 1.2; scene.add(skirt);
}

// ── placement cursor (a soft ring on the ground) ────────────────────────────
function buildCursor() {
  cursor = new THREE.Mesh(
    new THREE.RingGeometry(0.7, 1.0, 28),
    new THREE.MeshBasicMaterial({ color: 0x9fe06a, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false }),
  );
  cursor.rotation.x = -Math.PI / 2;
  cursor.renderOrder = 5;
  scene.add(cursor);
}
export function setCursor(x, z, ok, radius = 1) {
  if (!cursor) return;
  if (x == null) { cursor.material.opacity = 0; return; }
  cursor.position.set(x, heightAt(x, z) + 0.06, z);
  cursor.scale.setScalar(radius);
  cursor.material.opacity = 0.55;
  cursor.material.color.setHex(ok ? 0x9fe06a : 0xff8fb1);
}

// ── plot boundary fence (marks the unlocked land; moves out on expansion) ────
let boundary = null;
const postGeoB = new THREE.CylinderGeometry(0.13, 0.17, 1.1, 6);
const postMatB = new THREE.MeshStandardMaterial({ color: 0x6f4a28, roughness: 0.9 });
export function setBoundary(h) {
  if (!boundary) { boundary = new THREE.Group(); scene.add(boundary); }
  while (boundary.children.length) boundary.remove(boundary.children[0]);
  const perSide = 14;
  for (let s = 0; s < 4; s++) for (let i = 0; i < perSide; i++) {
    const t = (i / perSide) * 2 - 1;
    let x, z;
    if (s === 0) { x = t * h; z = -h; } else if (s === 1) { x = t * h; z = h; }
    else if (s === 2) { x = -h; z = t * h; } else { x = h; z = t * h; }
    const p = new THREE.Mesh(postGeoB, postMatB);
    p.position.set(x, heightAt(x, z) + 0.5, z); p.castShadow = true; p.receiveShadow = true;
    boundary.add(p);
  }
}

// ── raycasting ──────────────────────────────────────────────────────────────
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function toNdc(clientX, clientY) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
}
export function pickGround(clientX, clientY) {
  if (!groundMesh) return null;
  toNdc(clientX, clientY); ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(groundMesh, false)[0];
  return hit ? { x: hit.point.x, z: hit.point.z, point: hit.point } : null;
}
export function pickObjects(clientX, clientY, roots) {
  if (!roots || !roots.length) return null;
  toNdc(clientX, clientY); ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(roots, true);
  for (const h of hits) {
    let o = h.object;
    while (o && !o.userData.pickId && o.parent) o = o.parent;
    if (o && o.userData.pickId) return { pickId: o.userData.pickId, kind: o.userData.kind, object: o, point: h.point };
  }
  return null;
}

// ── glTF model registry ──────────────────────────────────────────────────────
export const ASSETS = {}, ASSET_BOX = {};
export async function loadModels(names) {
  const loader = new GLTFLoader();
  await Promise.all(names.map(async (n) => {
    try {
      const g = await loader.loadAsync(`./assets/${n}.glb`);
      ASSETS[n] = g.scene; ASSET_BOX[n] = new THREE.Box3().setFromObject(g.scene);
    } catch (e) { console.warn("[sward] asset failed", n, e && e.message); }
  }));
}
export const modelHeight = (n) => { const b = ASSET_BOX[n]; return b ? Math.max(b.max.y - b.min.y, 1e-3) : 1; };
export function cloneModel(name, targetHeight, opts = {}) {
  if (!ASSETS[name]) return null;
  const m = ASSETS[name].clone(true);
  if (targetHeight) m.scale.setScalar(targetHeight / modelHeight(name));
  m.traverse((c) => {
    if (!c.isMesh) return;
    c.castShadow = opts.cast !== false;
    c.receiveShadow = !!opts.receive;
    if (opts.tint) { c.material = c.material.clone(); c.material.color = new THREE.Color(opts.tint); }
  });
  return m;
}

// ── init / loop ──────────────────────────────────────────────────────────────
export function initWorld(canvas, seed = 1) {
  plotSeed = seed >>> 0 || 1;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  sun.position.set(-34, 56, 28);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 5; sun.shadow.camera.far = 260;
  const sc = sun.shadow.camera; sc.left = -HALF - 8; sc.right = HALF + 8; sc.top = HALF + 8; sc.bottom = -HALF - 8;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target, hemi, ambient);

  buildGround();
  buildCursor();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 16; controls.maxDistance = 150;
  controls.maxPolarAngle = Math.PI * 0.49;   // allow a lower, more cinematic angle
  controls.minPolarAngle = Math.PI * 0.1;
  controls.enablePan = false;
  controls.rotateSpeed = 0.7;

  resize();
  window.addEventListener("resize", resize);
  return { renderer, controls };
}
export function resize() {
  if (!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
export function focusCamera(x, z, dist = 78) {
  if (!controls) return;
  controls.target.set(x, 0, z);
  camera.position.set(x + dist * 0.18, dist * 0.6, z + dist * 0.9);   // lower, more cinematic 3/4 view
}
export function setControlsEnabled(b) { if (controls) controls.enabled = b; }
export function tickControls() { if (controls) controls.update(); }
export function render() { if (renderer) renderer.render(scene, camera); }
export const getRenderer = () => renderer;
