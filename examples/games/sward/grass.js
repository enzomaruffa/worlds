import * as THREE from "three";
import { PLOT, HALF, heightAt, insidePlot, scene } from "./world.js";

// ───────────────────────────────────────────────────────────────────────────
// grass.js — the star of the show: thousands of instanced 3D blades over the
// plot, bending in a vertex-shader wind, their height + colour driven by a
// per-cell coverage/health field (owned by sim.js) and the current season.
//
//   • One InstancedMesh of a tapered blade. Wind animates on the GPU (cheap).
//   • Matrices + colours are rebuilt only when the field/season changes (rare),
//     never per-frame — so 9k blades cost almost nothing once placed.
// ───────────────────────────────────────────────────────────────────────────

export const FIELD_N = 60;                  // field grid resolution across the plot
export const CELL = PLOT / FIELD_N;
const BLADES_PER_CELL = 5;
const BLADE_H = 1.85;                        // world height of a full-grown blade (tall, lush)

// per-cell state (sim.js writes these; grass.js reads them)
export const coverage = new Float32Array(FIELD_N * FIELD_N); // 0..1 grass density
export const health = new Float32Array(FIELD_N * FIELD_N).fill(1); // 0..1 lushness

export const cellIndex = (ix, iz) => iz * FIELD_N + ix;
export const cellOf = (x, z) => {
  const ix = Math.floor((x + HALF) / CELL), iz = Math.floor((z + HALF) / CELL);
  return ix < 0 || iz < 0 || ix >= FIELD_N || iz >= FIELD_N ? -1 : cellIndex(ix, iz);
};
export const cellCenter = (ix, iz) => ({ x: (ix + 0.5) * CELL - HALF, z: (iz + 0.5) * CELL - HALF });

// season-driven palette (C3 overrides via setPalette)
let lush = new THREE.Color(0x4f9e3a);   // healthy
let dry = new THREE.Color(0xb8a24a);    // stressed / dry
let tip = new THREE.Color(0x9fe06a);    // sunlit tip tint
let windStr = 0.2;

let mesh = null, shader = null, blades = [];
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _c = new THREE.Color();

// curved, tapered blade standing on +Y (base at y=0, tip at y=1)
function bladeGeometry() {
  const segs = 6, w0 = 0.11;
  const pos = [], idx = [], nor = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const w = w0 * (1 - t * 0.92) + 0.006;   // taper to a fine tip
    const curve = t * t * 0.34;              // pronounced forward arc
    pos.push(-w, t, curve, w, t, curve);
    // normals tilted slightly up+forward → soft, evenly-lit, lush blades
    nor.push(0, 0.85, 0.5, 0, 0.85, 0.5);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

// precompute stable per-blade randomness (offset, yaw, height jitter)
function buildBlades() {
  blades = [];
  let seedN = 1337;
  const rnd = () => { seedN = (Math.imul(seedN, 1664525) + 1013904223) >>> 0; return seedN / 4294967296; };
  for (let iz = 0; iz < FIELD_N; iz++) {
    for (let ix = 0; ix < FIELD_N; ix++) {
      const { x: cx, z: cz } = cellCenter(ix, iz);
      if (!insidePlot(cx, cz)) continue;
      for (let b = 0; b < BLADES_PER_CELL; b++) {
        const x = cx + (rnd() - 0.5) * CELL * 0.95;
        const z = cz + (rnd() - 0.5) * CELL * 0.95;
        if (!insidePlot(x, z)) continue;
        blades.push({ x, z, ci: cellIndex(ix, iz), yaw: rnd() * Math.PI * 2, hj: 0.75 + rnd() * 0.5, wj: 0.85 + rnd() * 0.4, cj: rnd() });
      }
    }
  }
}

export function buildGrass() {
  buildBlades();
  const geo = bladeGeometry();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = { value: 0 };
    sh.uniforms.uWindStr = { value: windStr };
    sh.uniforms.uWindDir = { value: new THREE.Vector2(0.8, 0.6) };
    sh.vertexShader = "uniform float uTime;\nuniform float uWindStr;\nuniform vec2 uWindDir;\n" + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      {
        vec3 iPos = instanceMatrix[3].xyz;
        float h = position.y;
        // layered wind: a slow rolling gust sweeping across the field + fast flutter
        float gust = 0.5 + 0.5 * sin(uTime * 0.5 - (iPos.x * 0.06 + iPos.z * 0.05));
        float sway = sin(uTime * 1.6 + (iPos.x + iPos.z) * 0.35)
                   + 0.45 * sin(uTime * 2.9 + iPos.x * 0.8 - iPos.z * 0.3)
                   + 0.2  * sin(uTime * 5.1 + iPos.z * 1.4);
        float bend = sway * uWindStr * (0.55 + 0.9 * gust) * h * h;
        transformed.x += bend * uWindDir.x;
        transformed.z += bend * uWindDir.y;
        transformed.y -= bend * bend * 0.35;   // tip dips as it bends → no stretching
      }`,
    );
    shader = sh;
  };
  mat.customProgramCacheKey = () => "swardgrass";

  mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, blades.length));
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  // enable per-instance colour
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(blades.length * 3), 3);
  scene.add(mesh);
  rebuild();
  return mesh;
}

// Rebuild instance matrices + colours from the current field + season palette.
// Call when coverage/health/season change — NOT every frame.
export function rebuild() {
  if (!mesh) return;
  for (let i = 0; i < blades.length; i++) {
    const bl = blades[i];
    const cov = coverage[bl.ci], hp = health[bl.ci];
    if (cov < 0.04) {
      _m.makeScale(0, 0, 0);                 // bare dirt — hide the blade
      mesh.setMatrixAt(i, _m);
      continue;
    }
    const hy = BLADE_H * bl.hj * (0.34 + 0.78 * cov);
    const wx = bl.wj * (0.6 + 0.5 * cov);
    _p.set(bl.x, heightAt(bl.x, bl.z), bl.z);
    _q.setFromAxisAngle(_up, bl.yaw);
    _s.set(wx, hy, wx);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
    mesh.setColorAt(i, bladeColor(bl, cov, hp));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

// richer, more varied blade colour: dry→lush by health, brighter sunlit tips,
// per-blade hue + saturation + lightness jitter so the field reads alive
function bladeColor(bl, cov, hp) {
  _c.copy(dry).lerp(lush, THREE.MathUtils.clamp(hp, 0, 1));
  _c.lerp(tip, 0.14 + 0.22 * bl.cj * cov);
  _c.offsetHSL((bl.cj - 0.5) * 0.05, 0.06, (bl.cj - 0.5) * 0.12);
  return _c;
}

// Cheap colour-only refresh (no matrix rebuild) — for frequent season/time tints.
export function retint() {
  if (!mesh) return;
  for (let i = 0; i < blades.length; i++) {
    const bl = blades[i], cov = coverage[bl.ci];
    if (cov < 0.04) continue;
    mesh.setColorAt(i, bladeColor(bl, cov, health[bl.ci]));
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

// C3 calls this to retint grass per season / time of day.
export function setPalette({ lush: l, dry: d, tip: t, wind } = {}) {
  if (l != null) lush.set(l);
  if (d != null) dry.set(d);
  if (t != null) tip.set(t);
  if (wind != null) { windStr = wind; if (shader) shader.uniforms.uWindStr.value = wind; }
}

let _t = 0;
export function update(dt, windGust = 1) {
  _t += dt;
  if (shader) {
    shader.uniforms.uTime.value = _t;
    shader.uniforms.uWindStr.value = windStr * windGust;
  }
}

// convenience for early commits: fill coverage with a sampler, then rebuild
export function fillCoverage(fn) {
  for (let iz = 0; iz < FIELD_N; iz++)
    for (let ix = 0; ix < FIELD_N; ix++) {
      const { x, z } = cellCenter(ix, iz);
      coverage[cellIndex(ix, iz)] = insidePlot(x, z) ? THREE.MathUtils.clamp(fn(x, z, ix, iz), 0, 1) : 0;
    }
  rebuild();
}
