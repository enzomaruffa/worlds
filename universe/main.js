// the universe — a Worlds site, built only on the public API (worlds.js + /api/v1/universe).
// Custom shaders: sun surface, planet atmospheres, animated oceans, twinkling stars, nebula sky.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// display font for in-world star/system labels; falls back to mono until the webfont lands
const LABEL_FONT = `"Space Grotesk", ui-monospace, monospace`;
if (document.fonts?.load) document.fonts.load('600 44px "Space Grotesk"').catch(() => {});

// ---------- Kenney models (CC0, kenney.nl — Space Kit + Nature Kit) ----------
const ASSETS = {};
const ASSET_BOX = {}; // bounding box per model, so we can height-normalize across species
async function preload() {
  const loader = new GLTFLoader();
  const names = [
    "craft_speederA", "craft_cargoA", "meteor", "meteor_detailed", "rock_crystalsLargeA",
    "satelliteDish_detailed", "tree_default", "tree_oak", "tree_palmTall", "tree_pineRoundA",
    "tree_default_fall", "tree_default_dark", "cactus_tall",
  ];
  await Promise.all(names.map(async (n) => {
    const gltf = await loader.loadAsync(`./assets/${n}.glb`);
    ASSETS[n] = gltf.scene;
    ASSET_BOX[n] = new THREE.Box3().setFromObject(gltf.scene);
  }));
}
function modelHeight(name) {
  const b = ASSET_BOX[name];
  return Math.max(b.max.y - b.min.y, 1e-3);
}
function randomUnit(rng) {
  const th = rng() * 6.283185, z = 2 * rng() - 1, r = Math.sqrt(Math.max(0, 1 - z * z));
  return new THREE.Vector3(r * Math.cos(th), z, r * Math.sin(th));
}

// Instance every sub-mesh of a GLB across a list of matrices (one draw call per material).
function instancedFromGLB(template, matrices, group) {
  template.updateMatrixWorld(true);
  template.traverse((child) => {
    if (!child.isMesh) return;
    const inst = new THREE.InstancedMesh(child.geometry, child.material, matrices.length);
    const local = child.matrixWorld.clone();
    const m = new THREE.Matrix4();
    for (let i = 0; i < matrices.length; i++) {
      m.multiplyMatrices(matrices[i], local);
      inst.setMatrixAt(i, m);
    }
    group.add(inst);
  });
}

// ---------- seeded helpers (planets must look identical on every visit) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function noise3(seed) {
  const h = (x, y, z) => {
    let n = x * 374761393 + y * 668265263 + z * 1274126177 + seed * 144665;
    n = (n ^ (n >> 13)) * 1274126177;
    return (((n ^ (n >> 16)) >>> 0) % 1024) / 1024;
  };
  const sm = (t) => t * t * (3 - 2 * t);
  return (px, py, pz) => {
    const xi = Math.floor(px), yi = Math.floor(py), zi = Math.floor(pz);
    const xf = sm(px - xi), yf = sm(py - yi), zf = sm(pz - zi);
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(h(xi, yi, zi), h(xi + 1, yi, zi), xf), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), xf), yf),
      l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), xf), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), xf), yf),
      zf,
    );
  };
}
function fbm(noise, p, octaves = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    v += amp * noise(p.x * f, p.y * f, p.z * f);
    amp *= 0.5; f *= 2.1;
  }
  return v;
}

// GLSL noise shared by the shaders below
const GLSL_NOISE = /* glsl */ `
  vec3 nhash3(vec3 p){ p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6))); return fract(sin(p)*43758.5453123); }
  float vnoise(vec3 p){
    vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
    float a = nhash3(i+vec3(0,0,0)).x, b = nhash3(i+vec3(1,0,0)).x, c = nhash3(i+vec3(0,1,0)).x, d = nhash3(i+vec3(1,1,0)).x;
    float e = nhash3(i+vec3(0,0,1)).x, g = nhash3(i+vec3(1,0,1)).x, h = nhash3(i+vec3(0,1,1)).x, k = nhash3(i+vec3(1,1,1)).x;
    return mix(mix(mix(a,b,f.x),mix(c,d,f.x),f.y), mix(mix(e,g,f.x),mix(h,k,f.x),f.y), f.z);
  }
  float gfbm(vec3 p){ float v=0.0, a=0.5; for(int i=0;i<5;i++){ v+=a*vnoise(p); p*=2.1; a*=0.5; } return v; }
`;

// ---------- scene ----------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 6000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// ACES filmic tone mapping: compresses HDR highlights so flying close to a star
// rolls off smoothly instead of blowing out to pure white.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
document.body.appendChild(renderer.domElement);

// Post-processing (bloom + god rays + tone-map). Guarded: Safari's stricter WebGL
// (float render targets / GLSL) can throw here; if so we fall back to a plain render
// so the universe still loads (just without the glow) instead of going blank.
let composer = null;
let godrayPass = null;
let warpBlurPass = null;
try {
composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

// FTL radial blur — during a jump the whole frame smears outward from center, dragging
// every star and planet into Star-Wars hyperspace streaks. Off (passthrough) at rest.
warpBlurPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uWarp: { value: 0 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uWarp; uniform vec2 uCenter; varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      if (uWarp <= 0.001) { gl_FragColor = base; return; }
      vec2 dir = vUv - uCenter;
      float jit = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
      vec3 acc = base.rgb; float total = 1.0;
      for (int i = 1; i <= 28; i++) {
        float t = (float(i) - jit) / 28.0;
        vec3 s = texture2D(tDiffuse, vUv - dir * t * uWarp * 0.28).rgb;
        float w = 1.0 - t;
        acc += s * w; total += w;
      }
      gl_FragColor = vec4(acc / total, base.a);
    }`,
});
composer.addPass(warpBlurPass);
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.8, 0.8, 0.78));

// shader-based volumetric god rays (radial light scatter from the nearest star)
godrayPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uIntensity: { value: 0 },
    uColor: { value: new THREE.Color(0xffe0a0) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uIntensity; uniform vec3 uColor;
    varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      if (uIntensity <= 0.001) { gl_FragColor = base; return; }
      vec2 delta = (uSun - vUv) / 48.0 * 0.9;
      // per-pixel jitter on the start step turns the marching banding (the striped
      // "comb" beam) into invisible noise; higher threshold means only a star is
      // bright enough to ray — the ship's own flame no longer smears into combs.
      float jit = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
      vec2 uv = vUv + delta * jit; float decay = 1.0; vec3 acc = vec3(0.0);
      for (int i = 0; i < 48; i++) {
        uv += delta;
        vec3 s = texture2D(tDiffuse, uv).rgb;
        float b = max(s.r, max(s.g, s.b));
        acc += s * smoothstep(0.72, 1.3, b) * decay;
        decay *= 0.95;
      }
      acc /= 48.0;
      gl_FragColor = base + vec4(acc * uColor * uIntensity * 1.8, 0.0);
    }`,
});
composer.addPass(godrayPass);

// soft cinematic vignette — gently darkens the frame corners for depth + framing
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.85, 0.30, dot(d, d) * 2.0);  // 1 in the center → 0 at the corners
      base.rgb *= mix(0.82, 1.0, v);                      // corners ~18% darker; center untouched
      gl_FragColor = base;
    }`,
}));

composer.addPass(new OutputPass()); // tone-maps + sRGB at the very end (single pass)
} catch (e) {
  console.warn("postprocessing unavailable — plain render fallback (Safari?):", e);
  composer = null;
  godrayPass = null;
  warpBlurPass = null;
}

scene.add(new THREE.HemisphereLight(0x404a66, 0x080810, 1.4));

const uTime = { value: 0 };

// ---------- nebula sky (fbm gradient on an inverted sphere) ----------
{
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTime },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      ${GLSL_NOISE}
      varying vec3 vDir; uniform float uTime;
      void main(){
        float n1 = gfbm(vDir * 3.0 + vec3(13.7));
        float n2 = gfbm(vDir * 5.5 - vec3(7.1));
        vec3 col = vec3(0.012, 0.012, 0.022);
        col += vec3(0.10, 0.05, 0.18) * smoothstep(0.55, 0.95, n1);   // violet drift
        col += vec3(0.03, 0.09, 0.16) * smoothstep(0.60, 0.95, n2);   // teal drift
        col += vec3(0.16, 0.10, 0.05) * smoothstep(0.78, 1.0, gfbm(vDir*2.2)); // faint amber core
        // ordered-ish dither: breaks up the 8-bit banding that dark gradients show on most displays
        float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        col += (dither - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(2800, 32, 32), mat));
}

// ---------- twinkling stars (shader points) ----------
let starMat = null;
{
  const n = 5000;
  const pos = new Float32Array(n * 3), phase = new Float32Array(n), mag = new Float32Array(n), tint = new Float32Array(n * 3);
  const rng = mulberry32(42);
  for (let i = 0; i < n; i++) {
    const r = 1000 + rng() * 1600, th = rng() * Math.PI * 2, ph = Math.acos(2 * rng() - 1);
    pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)], i * 3);
    phase[i] = rng() * 6.28;
    mag[i] = 0.6 + rng() * 1.8;
    // realistic-ish stellar tints: mostly blue-white, with a sprinkling of gold/amber/cyan/rose
    const u = rng();
    let cr, cg, cb;
    if (u < 0.50)      { cr = 0.82; cg = 0.88; cb = 1.00; } // blue-white (most common)
    else if (u < 0.70) { cr = 1.00; cg = 1.00; cb = 1.00; } // pure white
    else if (u < 0.84) { cr = 1.00; cg = 0.92; cb = 0.74; } // warm gold
    else if (u < 0.93) { cr = 1.00; cg = 0.78; cb = 0.52; } // amber
    else if (u < 0.98) { cr = 0.70; cg = 0.92; cb = 1.00; } // icy cyan
    else               { cr = 1.00; cg = 0.72; cb = 0.66; } // faint rose
    tint.set([cr, cg, cb], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
  g.setAttribute("mag", new THREE.BufferAttribute(mag, 1));
  g.setAttribute("tint", new THREE.BufferAttribute(tint, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime, uWarp: { value: 0 } },
    vertexShader: `
      attribute float phase; attribute float mag; attribute vec3 tint;
      varying float vA; varying float vWarp; varying vec3 vTint;
      uniform float uTime; uniform float uWarp;
      void main(){
        vA = 0.35 + 0.65 * abs(sin(uTime * (0.4 + mag*0.3) + phase));
        vWarp = uWarp;
        vTint = tint;
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = mag * 2.6 * (600.0 / -mv.z) * (1.0 + uWarp * 3.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA; varying float vWarp; varying vec3 vTint;
      void main(){
        vec2 d2 = gl_PointCoord - 0.5;
        // stretch into long hyperspace streaks as warp ramps up
        d2.x /= (1.0 + vWarp * 7.0);
        float d = length(d2);
        if (d > 0.5) discard;
        // each star keeps its own tint; during FTL they all blue-shift to a hot core
        vec3 col = mix(vTint, vec3(0.78, 0.9, 1.0), vWarp);
        gl_FragColor = vec4(col, (vA + vWarp * 0.9) * smoothstep(0.5, 0.0, d));
      }`,
  });
  starMat = mat;
  scene.add(new THREE.Points(g, mat));
}

// ---------- hyperspace: a Star-Wars streak tunnel that screams past during FTL ----------
// A camera-locked tube of light-lines. At rest they're invisible; as warp ramps they
// stretch into long streaks rushing past the whole screen (radiating from straight ahead).
let warpMat = null, warpField = null;
{
  const N = 1700;
  const seed = new Float32Array(N * 2 * 3);  // per-vertex base: (x, y, zPhase)
  const along = new Float32Array(N * 2);     // 0 = head, 1 = tail
  for (let i = 0; i < N; i++) {
    const ang = Math.random() * Math.PI * 2;
    const rad = 4 + Math.random() * 120;
    const x = Math.cos(ang) * rad, y = Math.sin(ang) * rad;
    const zph = Math.random();
    for (let v = 0; v < 2; v++) {
      const idx = i * 2 + v;
      seed[idx * 3] = x; seed[idx * 3 + 1] = y; seed[idx * 3 + 2] = zph;
      along[idx] = v;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3)); // placeholder
  geo.setAttribute("seed", new THREE.BufferAttribute(seed, 3));
  geo.setAttribute("along", new THREE.BufferAttribute(along, 1));
  warpMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime, uWarp: { value: 0 } },
    vertexShader: `
      attribute vec3 seed; attribute float along;
      uniform float uTime; uniform float uWarp; varying float vA;
      void main(){
        float span = 700.0, speed = 1100.0;
        // head scrolls toward the camera along local -Z (forward); tail trails behind it
        float headZ = -span + mod(seed.z * span + uTime * speed, span);
        float len = 5.0 + uWarp * 230.0;
        float z = headZ - along * len;
        float depth = clamp((-z) / span, 0.0, 1.0);
        // fade in past the near plane, fade out toward the far end; tail dimmer than head
        vA = uWarp * smoothstep(0.0, 0.05, depth) * smoothstep(1.0, 0.6, depth) * (along < 0.5 ? 1.0 : 0.3);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(seed.xy, z, 1.0);
      }`,
    fragmentShader: `
      varying float vA;
      void main(){ if (vA <= 0.002) discard; gl_FragColor = vec4(0.82, 0.9, 1.0, vA); }`,
  });
  warpField = new THREE.LineSegments(geo, warpMat);
  warpField.frustumCulled = false;
  warpField.renderOrder = 5;
  scene.add(warpField);
}

// ---------- the core: a MASSIVE golden black hole at the edge of known space ----------
// It pulls hard (BH_MASS), and crossing the event horizon (EH_R) doesn't kill you —
// it spaghettifies you and spits you out at the home star (a wormhole shortcut home).
const CORE_POS = new THREE.Vector3(-1500, 90, 1500);
const BH_MASS = 58000;     // far heavier than any star — felt from ~800 units out
const EH_R = 96;           // event-horizon radius: cross it → wormhole jump home
let coreDisk = null;
{
  coreDisk = new THREE.Mesh(new THREE.RingGeometry(105, 400, 256, 1), new THREE.ShaderMaterial({
    side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `${GLSL_NOISE}
      varying vec2 vUv; uniform float uTime;
      void main(){
        vec2 c = vUv - 0.5; float ang = atan(c.y, c.x); float r = length(c) * 2.0;
        float swirl  = gfbm(vec3(cos(ang)*5.0,  sin(ang)*5.0,  r*7.0 - uTime*1.3));
        float swirl2 = gfbm(vec3(cos(ang)*12.0, sin(ang)*12.0, r*3.0 + uTime*0.6));
        // doppler beaming: the side spinning toward us blazes brighter
        float doppler = 0.55 + 0.85 * (0.5 + 0.5 * sin(ang + 0.6));
        // gold-hot inner accretion → deep amber outer (a golden hole, no violet)
        vec3 hot = vec3(1.0,0.96,0.66), cool = vec3(1.0,0.42,0.06);
        vec3 col = mix(hot, cool, smoothstep(0.0,1.0,r)) * (0.5 + 0.85*swirl + 0.3*swirl2) * doppler;
        col += hot * smoothstep(0.28, 0.0, r) * 0.45;   // brighter inner rim by the horizon
        float edge = smoothstep(0.0, 0.07, r) * smoothstep(1.0, 0.72, r);
        gl_FragColor = vec4(col * edge * 1.45, edge * 0.95);
      }`,
  }));
  coreDisk.position.copy(CORE_POS); coreDisk.rotation.set(Math.PI / 2 - 0.4, 0, 0.3);
  scene.add(coreDisk);
  const eh = new THREE.Mesh(new THREE.SphereGeometry(EH_R * 0.92, 64, 64), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  eh.position.copy(CORE_POS); scene.add(eh);
  // photon ring: a thin blazing ring hugging the horizon
  const photon = new THREE.Mesh(new THREE.TorusGeometry(EH_R * 1.02, 3.4, 16, 220),
    new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, blending: THREE.AdditiveBlending }));
  photon.position.copy(CORE_POS); photon.rotation.set(Math.PI / 2 - 0.4, 0, 0.3); scene.add(photon);
  // soft lensing glow so the hole reads as colossal from across the map
  const glow = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 32), new THREE.MeshBasicMaterial({
    color: 0xffb347, transparent: true, opacity: 0.04, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glow.position.copy(CORE_POS); scene.add(glow);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(EH_R * 1.22, 32, 32), new THREE.MeshBasicMaterial({
    color: 0xffd27a, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  halo.position.copy(CORE_POS); scene.add(halo);
  const bhLight = new THREE.PointLight(0xffb84d, 1400, 1800, 2);
  bhLight.position.copy(CORE_POS); scene.add(bhLight);
}

// ---------- shooting stars / comets ----------
const shootingStars = [];
let nextShoot = 2;
function spawnShootingStar() {
  const from = camera.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 500, Math.random() * 220 + 40, (Math.random() - 0.5) * 500));
  const dir = new THREE.Vector3(Math.random() - 0.5, -(Math.random() * 0.5 + 0.25), Math.random() - 0.5).normalize();
  const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), from.clone().addScaledVector(dir, -18)]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xcfe8ff, transparent: true, blending: THREE.AdditiveBlending }));
  line.frustumCulled = false;
  scene.add(line);
  shootingStars.push({ line, head: from, dir, t: 0, speed: 200 + Math.random() * 140 });
}
function updateShootingStars(dt) {
  nextShoot -= dt;
  if (nextShoot <= 0) { spawnShootingStar(); nextShoot = 1.5 + Math.random() * 3.5; }
  for (let i = shootingStars.length - 1; i >= 0; i--) {
    const s = shootingStars[i];
    s.t += dt;
    s.head.addScaledVector(s.dir, s.speed * dt);
    s.line.geometry.setFromPoints([s.head.clone(), s.head.clone().addScaledVector(s.dir, -18)]);
    s.line.material.opacity = Math.max(0, 1 - s.t / 1.4);
    if (s.t > 1.4) { scene.remove(s.line); s.line.geometry.dispose(); shootingStars.splice(i, 1); }
  }
}

// ---------- star systems: one star per site CATEGORY, hello.world at the center ----------
// (biome stays a per-planet visual trait; the system you orbit is what your site is FOR)
const SYSTEMS = {
  misc:        { title: "home",            tag: "the heart of it all",     pos: new THREE.Vector3(0, 0, 0),         hot: 0xffd84d, deep: 0xf25a05, starR: 40, codex: "Where the first signal was lit. Every road in the sky still bends quietly back toward it." },
  games:       { title: "the arcade",      tag: "where games are born",    pos: new THREE.Vector3(760, 30, -240),   hot: 0xff8ad8, deep: 0x86198f, starR: 32, codex: "A perpetual festival-belt whose citizens insist that losing is merely a slower kind of winning." },
  work:        { title: "mission control", tag: "mission-critical orbit",  pos: new THREE.Vector3(-760, -40, -320), hot: 0xdff1ff, deep: 0x1d4ed8, starR: 32, codex: "Run on tides of quarterly ritual. Nothing launches here without three blessings and a checklist." },
  tools:       { title: "the workshop",    tag: "forge of useful things",  pos: new THREE.Vector3(240, 55, 820),    hot: 0xffd27a, deep: 0xb45309, starR: 32, codex: "A forge-cluster of tinkerers. Half their inventions exist only to help build the other half." },
  experiments: { title: "the lab",         tag: "here be dragons",         pos: new THREE.Vector3(-340, -20, 780),  hot: 0x9affe2, deep: 0x0f766e, starR: 32, codex: "A quarantined reactor-belt where unfinished physics is left running overnight. The dragons, they insist, are a feature." },
};

function makeStar(sys, name) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime, uHot: { value: new THREE.Color(sys.hot) }, uDeep: { value: new THREE.Color(sys.deep) } },
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      ${GLSL_NOISE}
      varying vec3 vP; uniform float uTime; uniform vec3 uHot; uniform vec3 uDeep;
      void main(){
        float n = gfbm(vP * 4.0 + vec3(uTime*0.10, uTime*0.07, 0.0));
        n += 0.5 * gfbm(vP * 9.0 - vec3(0.0, uTime*0.15, uTime*0.05));
        vec3 col = mix(uDeep, uHot, smoothstep(0.35, 1.05, n));
        col += vec3(1.0) * smoothstep(1.0, 1.3, n) * 0.4;   // subtler white-hot flecks
        gl_FragColor = vec4(col * 1.05, 1.0);
      }`,
  });
  const star = new THREE.Mesh(new THREE.SphereGeometry(sys.starR, 64, 64), mat);
  star.position.copy(sys.pos);
  scene.add(star);

  const corona = new THREE.Mesh(
    new THREE.SphereGeometry(sys.starR, 48, 48),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(sys.hot) } },
      vertexShader: `varying vec3 vN; varying vec3 vV;
        void main(){ vec4 wp = modelMatrix * vec4(position*1.45,1.0); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vV; uniform vec3 uColor;
        void main(){ float rim = pow(1.0 - abs(dot(vN, vV)), 2.2); gl_FragColor = vec4(uColor * rim * 1.3, rim); }`,
    }),
  );
  corona.position.copy(sys.pos);
  scene.add(corona);

  const l = label(name, sys.starR + 6, sys.hot);
  l.position.add(sys.pos);
  l.scale.multiplyScalar(1.4);
  scene.add(l);
  if (sys.tag) {
    const sub = label(sys.tag, sys.starR + 2, 0xa1a1aa);
    sub.position.add(sys.pos);
    sub.scale.multiplyScalar(0.7);
    scene.add(sub);
  }

  const light = new THREE.PointLight(sys.hot, 5200, 0, 1.8);
  light.position.copy(sys.pos);
  scene.add(light);

  starBodies.push({ pos: sys.pos.clone(), r: sys.starR, mass: sys.starR * 9, hot: sys.hot, title: sys.title, tag: sys.tag, codex: sys.codex });
}
const starBodies = [];
// declared before the makeStar() calls below — makeStar → label → _labelTextures,
// so a `const` declared after the calls would throw a TDZ ReferenceError at init.
const _labelTextures = [];

makeStar(SYSTEMS.misc, "hello.world");
for (const [key, sys] of Object.entries(SYSTEMS)) {
  if (key !== "misc") makeStar(sys, sys.title);
}

function label(text, y, color = 0xe4e4e7) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 96;
  const ctx = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  const draw = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = `600 44px ${LABEL_FONT}`;
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,.9)"; ctx.shadowBlur = 12;
    ctx.fillStyle = `#${new THREE.Color(color).getHexString()}`;
    ctx.fillText(text, 256, 60);
    tex.needsUpdate = true;
  };
  draw();
  _labelTextures.push(draw);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(26, 4.9, 1);
  sprite.position.y = y;
  return sprite;
}
// once the display webfont lands, repaint any labels drawn with the mono fallback
document.fonts?.ready?.then(() => { for (const draw of _labelTextures) draw(); });

// Pilot name tags: SCREEN-SPACE (sizeAttenuation:false) so they don't balloon up
// close. Scaled per-frame by distance (see the pilot loop) → bigger far, smaller
// near, so you can spot far-off players and nearby ones don't dominate the view.
const PILOT_LABEL_W = 0.30, PILOT_LABEL_H = 0.056; // base screen size
function screenLabel(text, colorHex) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 96;
  const ctx = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  const draw = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = `600 44px ${LABEL_FONT}`;
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,.95)"; ctx.shadowBlur = 14;
    ctx.fillStyle = `#${new THREE.Color(colorHex).getHexString()}`;
    ctx.fillText(text, 256, 60);
    tex.needsUpdate = true;
  };
  draw();
  _labelTextures.push(draw);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false,
  }));
  sprite.scale.set(PILOT_LABEL_W, PILOT_LABEL_H, 1);
  sprite.position.y = 2.9;
  sprite.renderOrder = 6;
  return sprite;
}

// ---------- atmosphere + ocean shaders ----------
function atmosphere(radius, colorHex) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.3, 40, 40),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(colorHex) } },
      vertexShader: `varying vec3 vN; varying vec3 vW;
        void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz; vN = normalize(mat3(modelMatrix)*normal); gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vW; uniform vec3 uColor;
        void main(){
          vec3 v = normalize(cameraPosition - vW);
          // wider, brighter halo + a soft inner wash so worlds glow against the void
          float rim = pow(1.0 - abs(dot(vN, v)), 2.1);
          gl_FragColor = vec4(uColor * (rim * 1.5 + 0.05), rim * 1.05);
        }`,
    }),
  );
}

function oceanShell(radius, colorHex) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.003, 48, 48),
    new THREE.ShaderMaterial({
      transparent: true,
      uniforms: { uTime, uColor: { value: new THREE.Color(colorHex) } },
      vertexShader: `
        ${GLSL_NOISE}
        uniform float uTime; varying vec3 vN; varying vec3 vW;
        void main(){
          vec3 p = position * (1.0 + 0.004 * vnoise(normalize(position)*22.0 + uTime*0.5));
          vec4 wp = modelMatrix * vec4(p,1.0);
          vW = wp.xyz; vN = normalize(mat3(modelMatrix)*normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        ${GLSL_NOISE}
        uniform float uTime; uniform vec3 uColor; varying vec3 vN; varying vec3 vW;
        void main(){
          vec3 v = normalize(cameraPosition - vW);
          vec3 lightDir = normalize(-vW);                 // the sun sits at the origin
          float fres = pow(1.0 - abs(dot(vN, v)), 2.0);
          float spec = pow(max(dot(reflect(-lightDir, vN), v), 0.0), 40.0);
          float sparkle = smoothstep(0.72, 1.0, vnoise(vW*1.4 + uTime*0.7));
          vec3 col = uColor * (0.55 + 0.45 * max(dot(vN, lightDir), 0.0));
          col += vec3(1.0) * spec * 0.7 + uColor * fres * 0.6 + vec3(0.9) * sparkle * 0.08;
          gl_FragColor = vec4(col, 0.62);
        }`,
    }),
  );
}

// banded ring shader (Saturn-style) for large planets
function makePlanetRing(radius, colorHex) {
  const geo = new THREE.RingGeometry(radius * 1.4, radius * 2.3, 96, 1);
  // remap UV.x to radial distance so the shader can band by radius
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  const c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    c.fromBufferAttribute(pos, i);
    const r = (c.length() - radius * 1.4) / (radius * 0.9); // 0..1 inner→outer
    uv.setXY(i, r, 0);
  }
  return new THREE.Mesh(geo, new THREE.ShaderMaterial({
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color(colorHex) } },
    vertexShader: `varying float vR; void main(){ vR = uv.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying float vR; uniform vec3 uColor;
      void main(){
        float bands = 0.5 + 0.5 * sin(vR * 60.0) * sin(vR * 23.0 + 1.3);
        float edge = smoothstep(0.0, 0.06, vR) * smoothstep(1.0, 0.9, vR);
        float a = edge * (0.25 + 0.45 * bands);
        gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.3 * bands), a);
      }`,
  }));
}

// ---------- procedural planets with forests + clouds ----------
// `ocean` is sea level on a 0..1 elevation field. Land rises above it, sea floor
// dips below a sea sphere at exactly radius — so coastlines are crisp and nothing
// green ever sits on water.
const BIOMES = {
  lush:        { sea: 0x16407a, beach: 0xd9c58b, mid: 0x2f9e44, high: 0x6b6a52, peak: 0xf1f5f9, ocean: 0.50, atmo: 0x6ab7ff, treeDensity: 1.0 },
  desert:      { sea: 0x2f6f7a, beach: 0xe3c987, mid: 0xd9a049, high: 0x9a6b2f, peak: 0xf3e0b5, ocean: 0.34, atmo: 0xffb56b, treeDensity: 0.30 },
  ice:         { sea: 0x2f6aa0, beach: 0xcfe8ff, mid: 0xdbeafe, high: 0xa9c7e8, peak: 0xffffff, ocean: 0.44, atmo: 0xbfe3ff, treeDensity: 0.45 },
  volcanic:    { sea: 0x3a1d12, beach: 0x5a3320, mid: 0x57534e, high: 0x3a2218, peak: 0xff7043, ocean: 0.42, atmo: 0xff6b4a, treeDensity: 0.20 },
  archipelago: { sea: 0x0e6e8c, beach: 0xe7d8a1, mid: 0x15803d, high: 0x4a6b3a, peak: 0xf8fafc, ocean: 0.60, atmo: 0x67e8f9, treeDensity: 0.95 },
};

const CLOUD_GEO = new THREE.IcosahedronGeometry(1, 1);

// Biome → Kenney tree models (Nature Kit)
const BIOME_TREES = {
  lush: ["tree_default", "tree_oak", "tree_default_fall"],
  archipelago: ["tree_palmTall", "tree_default"],
  ice: ["tree_pineRoundA"],
  desert: ["cactus_tall"],
  volcanic: ["tree_default_dark"],
};

// shared elevation field — terrain, sea level, tree placement and dishes all agree
function elevation(noise, dir) {
  const continents = fbm(noise, dir.clone().multiplyScalar(1.7), 5);
  const mountains = fbm(noise, dir.clone().multiplyScalar(4.3), 4);
  return Math.min(continents * 0.78 + mountains * 0.30, 0.999);
}
const landFrac = (e, sea) => Math.max(0, (e - sea) / (1 - sea));
function heightAt(radius, e, sea) {
  if (e < sea) return radius * (0.93 + (e / sea) * 0.06);            // sea floor dips below 1.0
  return radius * (1.0 + Math.pow(landFrac(e, sea), 1.25) * 0.30);    // land rises up to +30%
}

function plantForest(spinner, samples, biomeName, rng, radius) {
  if (samples.length < 3) return;
  const species = BIOME_TREES[biomeName] ?? BIOME_TREES.lush;
  const up = new THREE.Vector3(0, 1, 0);
  const buckets = new Map(species.map((n) => [n, []]));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const twist = new THREE.Quaternion();
  samples.forEach((smp, i) => {
    const name = species[i % species.length];
    if (!ASSETS[name]) return;
    const target = radius * (0.085 + rng() * 0.05); // 8.5–13.5% of planet radius tall
    s.setScalar(target / modelHeight(name));
    q.setFromUnitVectors(up, smp.dir);
    q.multiply(twist.setFromAxisAngle(up, rng() * 6.283));
    m.compose(smp.point, q, s);
    buckets.get(name).push(m.clone());
  });
  for (const [name, mats] of buckets) if (mats.length) instancedFromGLB(ASSETS[name], mats, spinner);
}

function makePlanet(site) {
  const u = site.universe ?? { seed: 1, biome: "lush", pos: [0.5, 0, 0.5] };
  const rng = mulberry32(u.seed);
  const noise = noise3(u.seed);
  const biomeName = u.biome ?? "lush";
  const biome = BIOMES[biomeName] ?? BIOMES.lush;
  const sea = biome.ocean;
  const radius = 7.5 + Math.min((site.visits_30d ?? 0) / 40, 9) + rng() * 2.5; // bigger, chunkier worlds
  const activity = Math.min((site.visits_30d ?? 0) / 200, 1);
  const sys = SYSTEMS[site.category] ?? SYSTEMS.misc; // the star this world orbits

  // terrain mesh
  const geo = new THREE.IcosahedronGeometry(radius, 6);
  const posAttr = geo.getAttribute("position");
  const colors = new Float32Array(posAttr.count * 3);
  const v = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i);
    const dir = v.clone().normalize();
    const e = elevation(noise, dir);
    v.copy(dir).multiplyScalar(heightAt(radius, e, sea));
    posAttr.setXYZ(i, v.x, v.y, v.z);
    const lf = landFrac(e, sea);
    const polar = Math.abs(dir.y) > 0.82;
    if (e < sea) col.setHex(biome.sea).multiplyScalar(0.7 + 0.3 * (e / sea)); // depth shading
    else if (lf < 0.05) col.setHex(biome.beach);
    else if (polar || lf > 0.72) col.setHex(biome.peak);
    else if (lf < 0.45) col.setHex(biome.mid);
    else col.setHex(biome.high);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  // tree samples: random directions kept only on dry, non-polar, non-rocky land
  const treeSamples = [];
  const tRng = mulberry32((u.seed ^ 0x9e3779b9) >>> 0);
  const wanted = Math.floor(200 * biome.treeDensity * (0.55 + activity));
  for (let a = 0; treeSamples.length < wanted && a < wanted * 8; a++) {
    const dir = randomUnit(tRng);
    const e = elevation(noise, dir);
    if (e < sea) continue;                       // never on water
    const lf = landFrac(e, sea);
    if (lf < 0.07 || lf > 0.6) continue;         // skip beaches' edge and rocky peaks
    if (Math.abs(dir.y) > 0.78) continue;        // skip ice caps
    treeSamples.push({ dir, point: dir.clone().multiplyScalar(heightAt(radius, e, sea)) });
  }

  const group = new THREE.Group();
  group.userData.site = site;

  // spinner: everything fixed to the surface rotates together
  const spinner = new THREE.Group();
  const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92 });
  // busy worlds glow with city lights on their night side
  if ((site.visits_30d ?? 0) > 30) {
    terrainMat.onBeforeCompile = (sh) => {
      sh.uniforms.uSun = { value: sys.pos };
      sh.uniforms.uTime = uTime;
      sh.vertexShader = "varying vec3 vWPos; varying vec3 vWNorm;\n" +
        sh.vertexShader.replace("#include <begin_vertex>",
          "#include <begin_vertex>\n vWPos = (modelMatrix*vec4(transformed,1.0)).xyz; vWNorm = mat3(modelMatrix)*normal;");
      sh.fragmentShader = "uniform vec3 uSun; uniform float uTime; varying vec3 vWPos; varying vec3 vWNorm;\n" +
        GLSL_NOISE +
        sh.fragmentShader.replace("#include <dithering_fragment>",
          `#include <dithering_fragment>
           { vec3 sd = normalize(uSun - vWPos);
             float night = smoothstep(0.12, -0.28, dot(normalize(vWNorm), sd));
             float land = step(0.16, vColor.g);
             float cities = smoothstep(0.80, 0.96, vnoise(vWPos * 2.3)) * land;
             float flick = 0.7 + 0.3 * sin(uTime * 3.0 + vWPos.x * 12.0);
             gl_FragColor.rgb += vec3(1.0, 0.82, 0.45) * night * cities * 1.7 * flick; }`);
    };
  }
  const terrain = new THREE.Mesh(geo, terrainMat);
  spinner.add(terrain);
  spinner.add(oceanShell(radius, biome.sea));
  plantForest(spinner, treeSamples, biomeName, rng, radius);

  // busy worlds earn a satellite dish, seated on real land
  if ((site.visits_30d ?? 0) > 50 && ASSETS.satelliteDish_detailed && treeSamples.length) {
    const dish = ASSETS.satelliteDish_detailed.clone();
    const spot = treeSamples[Math.floor(rng() * treeSamples.length)];
    dish.scale.setScalar((radius * 0.18) / modelHeight("satelliteDish_detailed"));
    dish.position.copy(spot.point);
    dish.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), spot.dir);
    spinner.add(dish);
  }
  group.add(spinner);

  group.add(atmosphere(radius, biome.atmo));

  // clouds: low-poly puffs that drift above the peaks, sized to the planet
  const cloudCount = 4 + Math.floor(rng() * 6);
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, flatShading: true });
  const clouds = new THREE.InstancedMesh(CLOUD_GEO, cloudMat, cloudCount);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  for (let i = 0; i < cloudCount; i++) {
    const dir = new THREE.Vector3(rng() - 0.5, (rng() - 0.5) * 0.7, rng() - 0.5).normalize();
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    s.set(radius * (0.18 + rng() * 0.12), radius * 0.05, radius * (0.12 + rng() * 0.08));
    m.compose(dir.multiplyScalar(radius * 1.36), q, s);
    clouds.setMatrixAt(i, m);
  }
  clouds.userData.spin = 0.02 + rng() * 0.03;
  group.add(clouds);

  const recent = site.updated_at && Date.now() - new Date(site.updated_at).getTime() < 7 * 864e5;
  if (recent) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 1.6, radius * 2.0, 64),
      new THREE.MeshBasicMaterial({ color: 0xe5a00d, side: THREE.DoubleSide, transparent: true, opacity: 0.5 }),
    );
    ring.rotation.x = Math.PI / 2.4;
    group.add(ring);
  }

  // big worlds get a banded Saturn ring (its own shader)
  if (radius > 8.5 && rng() < 0.7) {
    const ring = makePlanetRing(radius, biome.atmo);
    ring.rotation.x = Math.PI / 2 + (rng() - 0.5) * 0.6;
    ring.rotation.y = (rng() - 0.5) * 0.4;
    group.add(ring);
  }

  const moons = Math.min((site.contributors?.length ?? 1) - 1, 3);
  for (let mn = 0; mn < moons; mn++) {
    const moon = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.16, 1),
      new THREE.MeshStandardMaterial({ color: 0xd4d4d8, flatShading: true }));
    moon.userData.orbit = { r: radius * (2.1 + mn * 0.55), speed: 0.6 + mn * 0.3, phase: rng() * 7 };
    group.add(moon);
  }

  const nameLabel = label(site.name, radius * 1.45, 0xffffff);
  const lw = Math.min(Math.max(radius * 0.8, 5), 12);
  nameLabel.scale.set(lw, lw * 0.19, 1);
  group.add(nameLabel);

  // planets orbit their category's star (biome stays a visual trait)
  const [px, , pz] = u.pos;
  const orbitR = 170 + Math.hypot(px, pz) * 200; // spread well clear of the stars — room to fly
  const angle = Math.atan2(pz, px) + rng() * 0.3;
  group.userData = { site, sys, orbitR, angle, speed: 0.016 / Math.sqrt(orbitR / 40), spin: 0.08 + rng() * 0.16, y: (rng() - 0.5) * 20, scaleIn: 0, spinner, clouds, bodyR: radius * 1.3, mass: radius * 1.4 };
  group.scale.setScalar(0.001);

  const line = new THREE.Mesh(
    new THREE.TorusGeometry(orbitR, 0.05, 6, 160),
    new THREE.MeshBasicMaterial({ color: 0x52525b, transparent: true, opacity: 0.25 }),
  );
  line.rotation.x = Math.PI / 2;
  line.position.copy(sys.pos);
  line.position.y += group.userData.y;
  scene.add(line);

  scene.add(group);
  return group;
}

const planets = new Map();

function upsertPlanet(site) {
  // the universe itself is the meta-world — it IS the black hole at the core,
  // not a planet orbiting inside itself.
  if (site.name === "universe") return;
  const existing = planets.get(site.name);
  if (existing) {
    existing.userData.site = site;
    return;
  }
  planets.set(site.name, makePlanet(site));
  updatePilotCount();
}

// ---------- the ship (Kenney speeder) + engine trail ----------
const ship = new THREE.Group();
ship.position.set(0, 14, 120);
scene.add(ship);
let enginePoint = new THREE.Vector3(0, 0, 1.2); // rear nozzle, ship-local
let flameMesh = null, innerFlame = null, engineLight = null;
const navLights = [];
let shipRadius = 1.5; // for collisions

function flameCone(rTop, h, color, opacity) {
  const geo = new THREE.ConeGeometry(rTop, h, 16);
  geo.translate(0, h / 2, 0); // base at origin, tip at +Y
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  m.rotation.x = Math.PI / 2; // tip points +Z (backwards)
  return m;
}

function buildShip() {
  const speeder = ASSETS.craft_speederA.clone();
  // Kenney speeders face -Z natively, which is our flight direction — no flip.
  speeder.scale.setScalar(1.6);
  speeder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(speeder);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  speeder.position.set(-center.x, -center.y, -center.z); // center model on ship origin
  shipRadius = Math.max(size.x, size.z) * 0.5;
  // rear of the hull is +Z, behind the nose at -Z
  enginePoint = new THREE.Vector3(0, 0, size.z * 0.42);

  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), new THREE.MeshBasicMaterial({ color: 0x9fe8ff }));
  glow.position.copy(enginePoint);

  // layered thruster flame: cyan outer + white-hot inner core
  flameMesh = flameCone(0.26, 1.1, 0x4aa8ff, 0.8); flameMesh.position.copy(enginePoint); flameMesh.scale.set(1, 0.25, 1);
  innerFlame = flameCone(0.13, 0.7, 0xeaf6ff, 0.95); innerFlame.position.copy(enginePoint); innerFlame.scale.set(1, 0.25, 1);

  // engine light that actually casts onto nearby space + the hull, pulsing with thrust
  engineLight = new THREE.PointLight(0x6cc6ff, 0, 16, 2);
  engineLight.position.copy(enginePoint);

  const fill = new THREE.PointLight(0xaaccff, 14, 14, 2); // cockpit fill so the speeder reads when backlit
  fill.position.set(0, size.y, 0);

  // navigation blinkers on the wingtips (port red, starboard green) — classic flight feel
  for (const [x, col] of [[-size.x * 0.46, 0xff4d4d], [size.x * 0.46, 0x4dff7a]]) {
    const nav = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), new THREE.MeshBasicMaterial({ color: col }));
    nav.position.set(x, 0.05, size.z * 0.05);
    navLights.push(nav);
    ship.add(nav);
  }

  // collision shield: a fresnel bubble that flashes on impact
  shieldMesh = new THREE.Mesh(
    new THREE.SphereGeometry(shipRadius * 1.6, 24, 24),
    new THREE.ShaderMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      uniforms: { uHit: { value: 0 } },
      vertexShader: `varying vec3 vN; varying vec3 vV;
        void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vV; uniform float uHit;
        void main(){ float rim = pow(1.0 - abs(dot(vN, vV)), 3.0); gl_FragColor = vec4(vec3(0.5,0.85,1.0) * rim * uHit, rim * uHit); }`,
    }),
  );
  ship.add(speeder, glow, flameMesh, innerFlame, engineLight, fill, shieldMesh);
}

// ---------- SFX: Kenney CC0 sound packs (Sci-Fi + Interface) ----------
const audio = { ctx: null, master: null, buffers: {}, engineGain: null, engineSrc: null };
async function initAudio() {
  if (audio.ctx) { if (audio.ctx.state === "suspended") audio.ctx.resume(); return; }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const master = ctx.createGain(); master.gain.value = 0.6; master.connect(ctx.destination);
  audio.ctx = ctx; audio.master = master;
  await Promise.all(["engine", "warp", "impact", "thrust", "select"].map(async (n) => {
    try {
      const buf = await fetch(`./assets/sfx/${n}.ogg`).then((r) => r.arrayBuffer());
      audio.buffers[n] = await ctx.decodeAudioData(buf);
    } catch { /* a missing sound just goes silent */ }
  }));
  if (audio.buffers.engine) {
    const src = ctx.createBufferSource(); src.buffer = audio.buffers.engine; src.loop = true;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    src.connect(g); g.connect(master); src.start();
    audio.engineSrc = src; audio.engineGain = g;
  }
  // generative ambient space drone: detuned low sines through a slow lowpass
  const droneG = ctx.createGain(); droneG.gain.value = 0.06; droneG.connect(master);
  const dlp = ctx.createBiquadFilter(); dlp.type = "lowpass"; dlp.frequency.value = 240; dlp.connect(droneG);
  [55, 82.5, 110].forEach((f, i) => {
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f;
    const og = ctx.createGain(); og.gain.value = 0.4; o.connect(og); og.connect(dlp); o.start();
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.04 + i * 0.025;
    const lg = ctx.createGain(); lg.gain.value = 4; lfo.connect(lg); lg.connect(o.detune); lfo.start();
  });
}
function playSfx(name, vol = 0.6, rate = 1) {
  if (!audio.ctx || !audio.buffers[name]) return;
  const src = audio.ctx.createBufferSource(); src.buffer = audio.buffers[name]; src.playbackRate.value = rate;
  const g = audio.ctx.createGain(); g.gain.value = vol;
  src.connect(g); g.connect(audio.master); src.start();
}
const blip = () => playSfx("select", 0.5, 1.3);   // planet select
const warpSound = () => playSfx("warp", 0.7);      // jump / autopilot
const thud = () => playSfx("impact", 0.85);        // collision
let shieldMesh = null;

// ---------- asteroid belt + mothership ----------
function buildBelt() {
  const rng = mulberry32(777);
  const beltR = 70;
  for (const name of ["meteor", "meteor_detailed"]) {
    const matrices = [];
    for (let i = 0; i < 70; i++) {
      const a = rng() * 6.283;
      const r = beltR + (rng() - 0.5) * 9;
      const p = new THREE.Vector3(Math.cos(a) * r, (rng() - 0.5) * 5, Math.sin(a) * r);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 6, rng() * 6, rng() * 6));
      const s = new THREE.Vector3().setScalar(0.4 + rng() * 1.3);
      matrices.push(new THREE.Matrix4().compose(p, q, s));
    }
    const beltGroup = new THREE.Group();
    instancedFromGLB(ASSETS[name], matrices, beltGroup);
    beltGroup.userData.spin = name === "meteor" ? 0.012 : 0.009;
    belts.push(beltGroup);
    scene.add(beltGroup);
  }
  // a couple of crystal rocks drifting closer in
  const matrices = [];
  for (let i = 0; i < 6; i++) {
    const a = rng() * 6.283, r = 48 + rng() * 8;
    matrices.push(new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * r, (rng() - 0.5) * 10, Math.sin(a) * r),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 6, rng() * 6, rng() * 6)),
      new THREE.Vector3().setScalar(1.2 + rng()),
    ));
  }
  const rocks = new THREE.Group();
  instancedFromGLB(ASSETS.rock_crystalsLargeA, matrices, rocks);
  rocks.userData.spin = -0.006;
  belts.push(rocks);
  scene.add(rocks);

  // the mothership lazily circles hello.world
  mothership = ASSETS.craft_cargoA.clone();
  mothership.scale.setScalar(2.4);
  scene.add(mothership);
}
const belts = [];
let mothership = null;

const TRAIL_N = 90;
const trailPos = new Float32Array(TRAIL_N * 3);
const trailAge = new Float32Array(TRAIL_N).fill(1);
let trailHead = 0;
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
trailGeo.setAttribute("age", new THREE.BufferAttribute(trailAge, 1));
trailGeo.attributes.position.setUsage(THREE.DynamicDrawUsage); // rewritten every frame
trailGeo.attributes.age.setUsage(THREE.DynamicDrawUsage);
const trail = new THREE.Points(trailGeo, new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `attribute float age; varying float vA;
    void main(){ vA = 1.0 - age; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = (1.0-age) * 9.0 * (120.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying float vA;
    void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5) discard; gl_FragColor = vec4(vec3(0.45,0.8,1.0)*vA*1.6, vA*smoothstep(0.5,0.0,d)); }`,
}));
trail.frustumCulled = false;
scene.add(trail);

const vel = new THREE.Vector3();
let pitch = -0.08, yaw = 0;

const keys = new Set();
addEventListener("keydown", (e) => { initAudio(); keys.add(e.code); });
addEventListener("keyup", (e) => keys.delete(e.code));
let dragging = null;
renderer.domElement.addEventListener("pointerdown", (e) => { initAudio(); dragging = { x: e.clientX, y: e.clientY, moved: 0 }; });
addEventListener("pointermove", (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - dragging.x) * 0.003;
  pitch = Math.max(Math.min(pitch - (e.clientY - dragging.y) * 0.003, 1.2), -1.2);
  dragging.moved += Math.abs(e.clientX - dragging.x) + Math.abs(e.clientY - dragging.y);
  dragging.x = e.clientX; dragging.y = e.clientY;
});
addEventListener("pointerup", (e) => {
  if (dragging && dragging.moved < 6) pick(e.clientX, e.clientY);
  dragging = null;
});
// virtual flight joystick: drag to steer (x→yaw, y→pitch) and thrust (displacement)
const joy = { x: 0, y: 0, active: false };
{
  const joyEl = document.getElementById("joystick");
  const stickEl = document.getElementById("stick");
  const move = (cx, cy) => {
    const r = joyEl.getBoundingClientRect();
    const R = r.width * 0.34; // larger throw → less twitchy
    let dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
    const m = Math.hypot(dx, dy) || 1, cl = Math.min(m, R);
    dx = (dx / m) * cl; dy = (dy / m) * cl;
    stickEl.style.transform = `translate(${dx}px, ${dy}px)`;
    joy.x = dx / R; joy.y = dy / R;
  };
  const end = () => { joy.active = false; joy.x = 0; joy.y = 0; stickEl.style.transform = "translate(0,0)"; };
  joyEl.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); initAudio(); joy.active = true; try { joyEl.setPointerCapture(e.pointerId); } catch { /* synthetic/no-op */ } move(e.clientX, e.clientY); });
  joyEl.addEventListener("pointermove", (e) => { if (joy.active) { e.preventDefault(); move(e.clientX, e.clientY); } });
  joyEl.addEventListener("pointerup", end);
  joyEl.addEventListener("pointercancel", end);
}

// ---------- picking + card ----------
const raycaster = new THREE.Raycaster();
const card = document.getElementById("card");
let flyTarget = null;
let focusTarget = null;          // a world we're "frozen" facing (card open, gravity paused)
const _faceDir = new THREE.Vector3();

function pick(cx, cy) {
  raycaster.setFromCamera(new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1), camera);
  // click another pilot → follow them
  const pilotGroups = [...pilots.values()].map((p) => p.group);
  if (pilotGroups.length) {
    const ph = raycaster.intersectObjects(pilotGroups, true);
    if (ph.length) {
      let o = ph[0].object;
      while (o && !o.userData.pilotKey) o = o.parent;
      if (o) { following = o.userData.pilotKey; flyTarget = null; toast(`▸ following <b style="color:#7dd3fc">@${o.userData.handle}</b> — click empty space to break off`); blip(); return; }
    }
  }
  const hits = raycaster.intersectObjects([...planets.values()], true);
  if (!hits.length) { following = null; return; } // clicking the void stops following
  let o = hits[0].object;
  while (o && !o.userData.site) o = o.parent; // walk up to the planet group
  if (!o) return;
  following = null;
  showCard(o.userData.site);
  flyTarget = o;
  focusTarget = o;       // glide in, then freeze facing it
  blip();
  warpSound();
}

// AI-generated "civilization lore" per world (worlds.ai, with a rich local fallback).
// Generated once, then persisted in our own worlds.db so every later visit — and every
// other pilot — reads it back instead of re-billing the model. Each entry has three parts:
// a civilization name, one vivid biome-aware sentence, and a quirky local custom.
// Regenerates only if the underlying site's description changes.
const loreCache = new Map();
const loreStore = worlds.db.collection("lore");

// cheap deterministic string hash → stable-but-varied fallback picks per world
function loreHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// fallback civ names keyed by the planet's biome (so the people match the world you see)
const LORE_BIOME = {
  lush:        { civ: ["The Verdant Choir", "The Moss-Weavers", "The Canopy-Kin", "The Green-Blooded"] },
  desert:      { civ: ["The Dune-Wardens", "The Glasslight Caravans", "The Sun-Parched", "The Mirage-Smiths"] },
  ice:         { civ: ["The Frostbound", "The Pale Cartographers", "The Rime-Singers", "The Glacier-Keepers"] },
  volcanic:    { civ: ["The Ember Choir", "The Forge-Kin", "The Ashwalkers", "The Cinder-Smiths"] },
  archipelago: { civ: ["The Tide-Readers", "The Reef-Builders", "The Saltborn", "The Lantern-Fishers"] },
};
const LORE_BY = {
  games: [
    "a restless world of arcade-cantinas where the locals never stop playing",
    "a neon carnival-moon that keeps score of absolutely everything, including sleep",
    "a planet of perpetual tournaments where the losers write the next set of rules",
  ],
  work: [
    "a disciplined colony of dashboard-temples that runs on quarterly tides",
    "a world of orderly spires where every citizen owns at least one checklist",
    "a clockwork settlement that schedules its sunrises a full sprint in advance",
  ],
  tools: [
    "tinkerer-clans forge small useful miracles in its orbital workshops",
    "a planet of patient artificers who fix things that were never quite broken",
    "a world held together by clever brackets and a great deal of well-loved tape",
  ],
  experiments: [
    "an unstable world where the laws of physics are still politely under review",
    "a planet that reboots its own gravity whenever the locals get bored",
    "a frontier lab-world where every sunset is, technically, a prototype",
  ],
  misc: [
    "a frontier settlement that proudly refuses to fit into any category",
    "a wandering world that changed its mind about what it wanted to be",
    "an oddball colony that files itself under 'miscellaneous' with enormous pride",
  ],
};
const LORE_CUSTOM = [
  "every deploy is announced with a small, sincere song",
  "they bury their bugs at sea and never speak of them again",
  "newcomers are gifted a name and a slightly broken tool",
  "they keep time by how often the home star blinks",
  "all disputes are settled by a friendly game and a long, fond silence",
  "they leave one light on for travelers who haven't shipped yet",
  "the calendar has thirteen Fridays and no Mondays at all",
  "elders are simply whoever has kept a tab open the longest",
];

function localLore(site) {
  const biome = site.universe?.biome || "lush";
  const b = LORE_BIOME[biome] ?? LORE_BIOME.lush;
  const cat = LORE_BY[site.category] ? site.category : "misc";
  const h = loreHash(site.name || "world");
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return {
    civ: `${b.civ[h % b.civ.length]} of ${site.name}.world`,
    lore: cap(LORE_BY[cat][(h >>> 3) % LORE_BY[cat].length]) + ".",
    custom: LORE_CUSTOM[(h >>> 7) % LORE_CUSTOM.length],
  };
}

// parse the model's three-line reply into {civ, lore, custom}; tolerant of labels/quotes/bullets
function parseLore(text) {
  const lines = String(text).split("\n").map((l) =>
    l.trim().replace(/^(line\s*\d+\s*[:.)\-]*|[-*•]\s*|\d+\s*[:.)\-]\s*)/i, "").replace(/^["']|["']$/g, "").trim()
  ).filter(Boolean);
  if (lines.length < 2) return null;
  return { civ: lines[0], lore: lines[1], custom: lines[2] || "" };
}

async function loadLore(site) {
  if (loreCache.has(site.name)) return loreCache.get(site.name);
  const desc = site.description || "";

  let stored;
  try {
    stored = (await loreStore.list({ filter: { site: site.name }, limit: 1 })).items[0];
  } catch { /* db unavailable → just generate */ }
  if (stored && stored.data.lore && stored.data.desc === desc) {
    // structured records read straight back; legacy (sentence-only) records keep their AI
    // sentence and borrow a civ + custom from the local pool so the card still fills out.
    const d = stored.data;
    const out = d.civ ? { civ: d.civ, lore: d.lore, custom: d.custom || "" } : { ...localLore(site), lore: d.lore };
    loreCache.set(site.name, out);
    return out;
  }

  let lore = null;
  try {
    const biome = site.universe?.biome || "lush";
    const res = await worlds.ai.complete({
      prompt: `Invent lore for a planet representing an internal tool, on a ${biome} world. Name: ${site.name}. Category: ${site.category}. About: ${desc || "unknown"}.\nReturn exactly three lines, no labels, no numbering, no quotes:\n1) the civilization's name (2-4 words, evocative)\n2) one vivid, playful sci-fi sentence about them (max 18 words)\n3) one quirky local custom (max 12 words)`,
      model: "fast", max_tokens: 110,
    });
    lore = parseLore(res.text || "");
  } catch { /* fall back, don't persist */ }

  if (lore) {
    const rec = { site: site.name, desc, civ: lore.civ, lore: lore.lore, custom: lore.custom };
    (stored ? loreStore.replace(stored.id, rec) : loreStore.create(rec)).catch(() => {});
  } else {
    lore = localLore(site);
  }
  loreCache.set(site.name, lore);
  return lore;
}

let cardSite = null;
function showCard(site) {
  cardSite = site;
  card.style.display = "block";
  document.getElementById("cardName").textContent = `${site.name}.world`;
  document.getElementById("cardMeta").textContent = `by @${site.creator.handle} · ▲ ${site.visits_30d ?? 0} visits · ${String(site.updated_at).slice(0, 10)}`;
  document.getElementById("cardDesc").textContent = site.description || "no description (yet)";
  const v = document.getElementById("cardVisit");
  v.href = site.url;
  v.textContent = "dive in →";
  const loreEl = document.getElementById("cardLore");
  loreEl.textContent = "✦ summoning lore…";
  loadLore(site).then((L) => {
    if (!(cardSite && cardSite.name === site.name)) return;
    loreEl.innerHTML =
      `<span class="loreCiv">${esc(L.civ)}</span>✦ ${esc(L.lore)}` +
      (L.custom ? `<span class="loreCustom">⚙ ${esc(L.custom)}</span>` : "");
  });
}
// Release a focused world. shove=true (LEAVING — thrust away) turns the ship OUTWARD
// and pushes off so you sail away instead of straight back into the surface. shove=false
// (CLOSING the card) just dismisses the panel and lets free-flight resume where you are —
// no kick, no reorient (per design: closing ≠ leaving).
function releaseFocus(shove = true) {
  card.style.display = "none";
  cardSite = null;
  const p = focusTarget;
  focusTarget = null;
  if (!p || !shove) return;
  const out = ship.position.clone().sub(p.position);
  if (out.lengthSq() < 1e-4) out.set(0, 0, 1);
  out.normalize();
  vel.addScaledVector(out, 60);
  yaw = Math.atan2(out.x, -out.z);
  pitch = Math.max(-0.5, Math.min(0.5, Math.asin(Math.max(-1, Math.min(1, out.y)))));
}
// Closing the card just dismisses it — doesn't shove you off the planet.
document.getElementById("cardClose").onclick = () => { flyTarget = null; releaseFocus(false); };

// Cross the black hole's event horizon → wormhole shortcut to the home star. No death,
// just a flash + a jump back to the heart of the universe.
function wormholeJump() {
  const sun = SYSTEMS.misc.pos;
  const dest = sun.clone().add(new THREE.Vector3(0, 50, SYSTEMS.misc.starR * 6 + 60));
  ship.position.copy(dest);
  vel.set(0, 0, 0);
  flyTarget = null; focusTarget = null; following = null;
  const dir = sun.clone().sub(dest).normalize();
  yaw = Math.atan2(dir.x, -dir.z);
  pitch = Math.max(-0.5, Math.min(0.5, Math.asin(Math.max(-1, Math.min(1, dir.y)))));
  if (typeof flashEl !== "undefined" && flashEl) {
    flashEl.style.opacity = "1";
    setTimeout(() => { flashEl.style.opacity = "0"; }, 90);
  }
  warpSound();
  toast(`🌀 <b>${randOf(["spaghettified", "folded sideways", "unwound", "compressed", "politely disassembled"])}</b> — the wormhole spits you out at the home star`);
}

// ---------- toasts ----------
// opts.wide → a roomier, wrapping card (sits just under the compass) for multi-line
// lore like codex entries and intercepted transmissions; default is the slim ellipsised pill.
function toast(html, ms = 4200, opts = {}) {
  const el = document.createElement("div");
  el.style.cssText = opts.wide
    ? "position:absolute;top:46px;left:50%;transform:translateX(-50%);background:rgba(14,14,18,.94);border:1px solid #3f3f46;border-radius:12px;padding:9px 16px;font:11.5px/1.5 ui-monospace,monospace;color:#e4e4e7;pointer-events:none;transition:opacity .4s;max-width:min(440px,86vw);text-align:center"
    : "position:absolute;top:14px;left:50%;transform:translateX(-50%);background:rgba(16,16,18,.92);border:1px solid #3f3f46;border-radius:999px;padding:8px 16px;font:12px ui-monospace,monospace;color:#e4e4e7;pointer-events:none;transition:opacity .4s;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis";
  el.innerHTML = html;
  document.getElementById("hud").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 400); }, ms);
}
// pick a random element (named randOf so it never collides with the raycaster pick())
const randOf = (a) => a[Math.floor(Math.random() * a.length)];

// ---------- star-system codex: a short lore blurb the first time you drift near a star ----------
let nearSystem = null; // title of the system the ship is currently inside (debounces re-fires)
function updateCodex() {
  let inRange = null;
  for (const b of starBodies) {
    // generous radius: stars sit ~800u apart, and the "warp here" vantage parks you at
    // starR*6, so starR*8 reliably triggers on arrival without ever overlapping neighbours.
    if (ship.position.distanceTo(b.pos) < b.r * 8) { inRange = b; break; }
  }
  const key = inRange?.title ?? null;
  if (key === nearSystem) return;
  nearSystem = key;
  if (inRange && inRange.codex && !introActive && !cardSite) revealCodex(inRange);
}

// ---------- ambient "intercepted transmissions": flavor chatter that drifts in over time ----------
// Mostly a curated pool (free, instant), templated with real world/pilot names. ~1 in 5 is a
// fresh AI line about a real world — cached to worlds.db so we never re-bill for the same world.
const TRANSMISSIONS = [
  "the {world} relay insists its reactor is 'fine, probably' — telemetry strongly disagrees",
  "intercepted: {world} has formally declared its coffee supply a strategic resource",
  "distress ping from {world}: 'we shipped it. send snacks. send help.'",
  "navigation buoy: mind the gravity wells near {world}, they have opinions",
  "{world} is broadcasting its changelog on every frequency again. nobody can stop them",
  "weather over {world}: scattered outages, clearing into a heroic patch by dusk",
  "trade notice: {world} will swap one (1) elegant abstraction for any working duct tape",
  "{world} reports its tests are green. the tests report otherwise. an inquiry is ongoing",
  "lost & found near {world}: one semicolon, lightly used, surprisingly important",
  "rumor from {world}: the staging moon achieved sentience and immediately asked for a raise",
  "{pilot} was last seen orbiting {world}, transmitting nothing but extremely confident jazz",
  "all pilots: {pilot} is doing loops near {world} again. wave if you pass",
  "long-range scan: a new star is forming somewhere out past the workshop belt",
  "reminder from mission control: a deploy is a promise you make to your future self",
  "the lab requests that everyone please stop poking the experimental gravity. it remembers",
  "the arcade has extended happy hour to all hours. this is now simply 'the hour'",
];
const txStore = worlds.db.collection("transmission");
const txCache = new Map();
async function transmissionFor(world) {
  if (txCache.has(world)) return txCache.get(world);
  try {
    const stored = (await txStore.list({ filter: { world }, limit: 1 })).items[0];
    if (stored?.data?.tx) { txCache.set(world, stored.data.tx); return stored.data.tx; }
  } catch { /* db down → just generate */ }
  const res = await worlds.ai.complete({
    prompt: `Write one short intercepted radio transmission overheard from the planet "${world}.world" in a playful sci-fi galaxy. Max 16 words. In-universe, no preamble, no quotes.`,
    model: "fast", max_tokens: 40,
  });
  const tx = (res.text || "").trim().replace(/^["']|["']$/g, "");
  if (tx) { txCache.set(world, tx); txStore.create({ world, tx }).catch(() => {}); }
  return tx;
}
const txWorld = () => { const n = [...planets.keys()]; return n.length ? `${randOf(n)}.world` : "an unnamed world"; };
const txPilot = () => { const p = [...pilots.values()]; return p.length ? `@${p[Math.floor(Math.random() * p.length)].group.userData.handle}` : "a silent pilot"; };
function showTx(text) { toast(`📡 <span style="color:#7dd3fc">intercepted transmission</span><br><span style="color:#cbd5e1">${esc(text)}</span>`, 6500, { wide: true }); }
async function emitTransmission() {
  const names = [...planets.keys()];
  // sometimes a fresh AI rumor linking two real worlds (relationship lore)
  if (names.length >= 2 && Math.random() < 0.22) {
    try {
      const a = randOf(names); let b = randOf(names), guard = 0;
      while (b === a && guard++ < 6) b = randOf(names);
      if (b !== a) { const r = await rumorFor(a, b); if (r) return showTx(r); }
    } catch { /* fall through */ }
  }
  // or a fresh AI line about a single real world (cached so it's a one-time cost)
  if (names.length && Math.random() < 0.28) {
    try {
      const tx = await transmissionFor(randOf(names));
      if (tx) return showTx(tx);
    } catch { /* fall through to the curated pool */ }
  }
  const line = randOf(TRANSMISSIONS).replaceAll("{world}", txWorld()).replaceAll("{pilot}", txPilot());
  showTx(line);
}
let nextTx = 35 + Math.random() * 30; // first transmission lands ~35–65s in
function updateTransmissions(dt) {
  if (introActive || cardSite || nearSystem) return; // don't talk over the intro / a card / a codex
  nextTx -= dt;
  if (nextTx > 0) return;
  nextTx = 55 + Math.random() * 45; // then every ~55–100s
  emitTransmission();
}

// ---------- more AI lore: cached generators for codex, world hails, rumors, pilot dossiers ----------
// One helper for all of them: check memory → check worlds.db → generate once → persist. Keyed so
// the model is billed at most once per subject, ever (and every pilot reads the same canon back).
async function cachedAI(store, cache, key, rec, prompt, maxTokens = 50) {
  if (cache.has(key)) return cache.get(key);
  try {
    const stored = (await store.list({ filter: rec, limit: 1 })).items[0];
    if (stored?.data?.text) { cache.set(key, stored.data.text); return stored.data.text; }
  } catch { /* db down → just generate */ }
  let text = "";
  try {
    const res = await worlds.ai.complete({ prompt, model: "fast", max_tokens: maxTokens });
    text = (res.text || "").trim().replace(/^["']|["']$/g, "");
  } catch { /* AI down → caller falls back */ }
  if (text) { cache.set(key, text); store.create({ ...rec, text }).catch(() => {}); }
  return text;
}

// AI-deepened star-system codex (falls back to the hand-written blurb if AI is unavailable)
const codexStore = worlds.db.collection("codex"), codexCache = new Map();
function codexFor(b) {
  return cachedAI(codexStore, codexCache, b.title, { system: b.title },
    `Expand this star-system codex into 1–2 vivid, in-universe sentences. System: "${b.title}" (${b.tag}). Seed: ${b.codex} Keep the playful sci-fi tone. No preamble, no quotes.`, 90)
    .then((t) => t || b.codex);
}

// a civilization's greeting, hailed as you approach one of its worlds (once per world per session)
const hailStore = worlds.db.collection("hail"), hailCache = new Map(), hailed = new Set();
let lastHail = -99;
function hailFor(site) {
  const biome = site.universe?.biome || "lush";
  return cachedAI(hailStore, hailCache, site.name, { world: site.name },
    `A pilot is approaching the planet "${site.name}.world" (a ${biome} world). Write the short in-character greeting its inhabitants broadcast to arriving ships. Max 14 words, playful sci-fi, no preamble, no quotes.`, 50);
}

// a juicy rumor linking two real worlds (relationship lore)
const rumorStore = worlds.db.collection("rumor"), rumorCache = new Map();
function rumorFor(a, c) {
  const key = [a, c].sort().join("~");
  return cachedAI(rumorStore, rumorCache, key, { pair: key },
    `Invent a short, juicy rumor about the relationship between two planets, "${a}.world" and "${c}.world", in a playful sci-fi galaxy. Max 18 words, no preamble, no quotes.`, 60);
}

// an AI "pilot dossier" (a callsign + a wry detail) for a pilot who just dropped in
const dossierStore = worlds.db.collection("dossier"), dossierCache = new Map();
function dossierFor(handle) {
  return cachedAI(dossierStore, dossierCache, handle, { handle },
    `Invent a one-line sci-fi pilot dossier — a callsign plus one wry detail — for a pilot called "@${handle}". Max 14 words, no preamble, no quotes.`, 45);
}

// resolve a system's codex (cached AI, or its static seed) then surface it — bailing if the
// pilot already drifted on to another system before the model answered.
function revealCodex(b) {
  const c = `#${new THREE.Color(b.hot).getHexString()}`, title = b.title, tag = b.tag;
  codexFor(b).then((text) => {
    if (nearSystem !== title) return;
    toast(`<b style="color:${c};letter-spacing:.06em">✦ ${esc(title.toUpperCase())}</b> · <i style="color:#a1a1aa">${esc(tag)}</i><br><span style="color:#c4b5fd">${esc(text)}</span>`, 7000, { wide: true });
  });
}

// ---------- live deploy supernova (dogfoods worlds.db realtime) ----------
const novas = [];
function spawnNova(pos, colorHex) {
  const mat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 24), mat);
  mesh.position.copy(pos);
  scene.add(mesh);
  novas.push({ mesh, t: 0 });
}
function updateNovas(dt) {
  for (let i = novas.length - 1; i >= 0; i--) {
    const n = novas[i];
    n.t += dt;
    const s = 1 + n.t * 70;
    n.mesh.scale.setScalar(s);
    n.mesh.material.opacity = Math.max(0, 1 - n.t / 1.1);
    if (n.t > 1.1) { scene.remove(n.mesh); novas.splice(i, 1); }
  }
}

// ---------- dive: fly into a planet → open the real site ----------
const divePrompt = document.getElementById("dive");
const flashEl = document.getElementById("flash");
let nearPlanet = null;        // planet group within dive range
let dive = null;              // { group, t }
const DIVE_DUR = 0.9;
function startDive(group) {
  if (dive || !group?.userData?.site) return;
  dive = { group, t: 0 };
  flyTarget = null;
  focusTarget = null;
  card.style.display = "none"; cardSite = null;   // "walk in" closes the modal
  divePrompt.style.display = "none";
  warpSound();
  playSfx("thrust", 0.5, 0.8);
}
divePrompt.addEventListener("click", () => startDive(nearPlanet));
document.getElementById("cardVisit").addEventListener("click", (e) => {
  e.preventDefault();
  const g = cardSite && planets.get(cardSite.name);
  if (g) startDive(g); else if (cardSite) window.open(cardSite.url, "_blank");
});
addEventListener("keydown", (e) => { if (e.code === "Enter" && nearPlanet && !dive) startDive(nearPlanet); });

// ---------- data: the public API, nothing else ----------
async function load() {
  const res = await fetch("/api/v1/universe", { headers: { "x-worlds-csrf": "1" } });
  if (!res.ok) return;
  for (const site of (await res.json()).items) upsertPlanet(site);
}
// the platform writes site metadata into home's "sites" collection;
// any world may READ it cross-site — that's the whole public contract we need.
let liveReady = false;
setTimeout(() => { liveReady = true; }, 4000); // ignore any initial backlog; only celebrate fresh deploys
worlds.db.site("home").collection("sites").subscribe((ev) => {
  if (!ev.doc?.name || !Object.keys(ASSETS).length) return;
  upsertPlanet({ universe: null, ...ev.doc });
  if (!liveReady) return;
  const g = planets.get(ev.doc.name);
  const sys = SYSTEMS[ev.doc.category] ?? SYSTEMS.misc;
  // a star is born — supernova at the planet (once it's positioned) + a toast
  setTimeout(() => {
    const pos = g && g.position.lengthSq() > 1 ? g.position : sys.pos;
    spawnNova(pos, sys.hot);
    playSfx("warp", 0.6);
  }, 80);
  toast(`✦ <b style="color:#e5a00d">@${ev.doc.creator?.handle ?? "someone"}</b> just launched <b style="color:#e5a00d">${ev.doc.name}.world</b> — ${randOf(["the sky gained a star", "a new world ignites", "another light in the dark", "the galaxy just got bigger"])}`);
  // a beat later, the newborn world's first lore drifts in (reuses the cached AI civilization lore)
  setTimeout(() => {
    loadLore({ universe: null, ...ev.doc }).then((L) => {
      if (L?.civ) toast(`✦ <span style="color:#e5a00d">first signal · ${esc(ev.doc.name)}.world</span><br><b style="color:#c4b5fd">${esc(L.civ)}</b><br><span style="color:#cbd5e1">${esc(L.lore)}</span>`, 7000, { wide: true });
    }).catch(() => {});
  }, 2600);
});

// ---------- other pilots, live over worlds.ws ----------
const pilotId = worlds.id(); // stable per-tab id — also the ships-actor cid, so comms can match a ship
const pilots = new Map(); // cid -> {group, label, target:{p,q}, seen}
// Ship poses ride worlds.actors (one zone, the whole universe): a joiner gets an
// instant snapshot of everyone flying, and the server coalesces + rate-caps the
// fan-out instead of every pilot blasting every other on a raw channel.
const shipsNet = worlds.actors("ships", { rate: 8 });

function pilotShip(handle, key) {
  const g = new THREE.Group();
  const speeder = ASSETS.craft_speederA.clone();
  speeder.scale.setScalar(1.5);
  let hue = 0;
  for (const ch of key) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const color = new THREE.Color().setHSL(hue / 360, 0.75, 0.6);
  speeder.traverse((c) => { if (c.isMesh) { c.material = c.material.clone(); c.material.color.offsetHSL(hue / 360, 0.15, 0); } });
  g.add(speeder);
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 10), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
  glow.position.set(0, 0, 1.4);
  g.add(glow, new THREE.PointLight(color, 6, 16, 2));
  const nameSprite = screenLabel(`@${handle}`, color.getHex());
  g.add(nameSprite);
  g.userData.pilotKey = key; g.userData.handle = handle; g.userData.color = color;
  scene.add(g);

  // colored engine trail so other pilots streak through space too
  const N = 40, pos = new Float32Array(N * 3), age = new Float32Array(N).fill(1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("age", new THREE.BufferAttribute(age, 1));
  geo.attributes.position.setUsage(THREE.DynamicDrawUsage); // rewritten every frame
  geo.attributes.age.setUsage(THREE.DynamicDrawUsage);
  const line = new THREE.Points(geo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: color } },
    vertexShader: `attribute float age; varying float vA; void main(){ vA=1.0-age; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=(1.0-age)*7.0*(120.0/-mv.z); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ float d=length(gl_PointCoord-0.5); if(d>0.5)discard; gl_FragColor=vec4(uColor*vA*1.6, vA*smoothstep(0.5,0.0,d)); }`,
  }));
  line.frustumCulled = false;
  scene.add(line);
  return { group: g, color, label: nameSprite, trail: { line, geo, pos, age, head: 0 }, lastHi: 0 };
}

// A pilot (id = its cid = its pilotId) updated its pose. The SDK filters our own.
shipsNet.onChange((cid, d, meta) => {
  if (!d || !d.p || !Object.keys(ASSETS).length) return;
  const handle = (meta && meta.handle) || cid;
  let p = pilots.get(cid);
  if (!p) {
    p = pilotShip(handle, cid);
    p.target = { p: d.p, q: d.q };
    p.group.position.fromArray(d.p);
    pilots.set(cid, p);
    rosterDirty = true;
    updatePilotCount();
    toast(`▸ <b style="color:#7dd3fc">@${esc(handle)}</b> ${randOf(["entered the universe", "dropped out of warp", "materialized from the void", "took the helm", "is now adrift among the stars"])}`);
    // a beat later, an AI "dossier" on the new arrival (cached per handle; the await spaces it out)
    dossierFor(handle).then((d) => { if (d) toast(`🛰 <span style="color:#7dd3fc">dossier · @${esc(handle)}</span><br><span style="color:#cbd5e1">${esc(d)}</span>`, 6500, { wide: true }); });
  }
  p.target = { p: d.p, q: d.q };
  p.seen = performance.now();
});
// A pilot disconnected (or left) — tear down its ship.
shipsNet.onLeave((cid) => {
  const p = pilots.get(cid);
  if (!p) return;
  scene.remove(p.group); scene.remove(p.trail.line);
  pilots.delete(cid);
  rosterDirty = true;
  updatePilotCount();
});

function updatePilotCount() {
  document.getElementById("count").textContent =
    `${planets.size} worlds · ${pilots.size + 1} pilot${pilots.size ? "s" : ""} flying`;
}

let lastBroadcast = 0;
function broadcastShip(now) {
  if (now - lastBroadcast < 120) return;
  lastBroadcast = now;
  shipsNet.set({ p: ship.position.toArray(), q: ship.quaternion.toArray() });
}

// ---------- comms: chat, emotes, pings, follow (all over worlds.ws) ----------
const commsChannel = worlds.ws.channel("comms");
const hud = document.getElementById("hud");
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
let following = null;
// persistent "you're following @x" badge so the follow feature is obvious
const followBadge = document.createElement("div");
followBadge.style.cssText = "position:absolute;bottom:18px;left:50%;transform:translateX(-50%);background:rgba(8,20,30,.92);border:1px solid #2563eb;border-radius:999px;padding:7px 15px;font:600 12px ui-monospace,monospace;color:#7dd3fc;pointer-events:none;display:none;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis;box-shadow:0 6px 20px rgba(0,0,0,.45)";
hud.appendChild(followBadge);

const bubbles = [];
function showBubble(getPos, html, emote, ms) {
  const el = document.createElement("div");
  el.className = "bubble" + (emote ? " emote" : "");
  el.innerHTML = html;
  hud.appendChild(el);
  bubbles.push({ el, getPos, until: performance.now() + ms });
}
function updateBubbles() {
  const v = new THREE.Vector3();
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    if (performance.now() > b.until) { b.el.style.opacity = "0"; if (performance.now() > b.until + 350) { b.el.remove(); bubbles.splice(i, 1); } continue; }
    v.copy(b.getPos()).add(new THREE.Vector3(0, 4, 0)).project(camera);
    if (v.z > 1) { b.el.style.display = "none"; continue; }
    b.el.style.display = "block";
    b.el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
    b.el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
  }
}

const beacons = [];
function dropBeacon(pos, who) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(6, 0.4, 8, 48),
    new THREE.MeshBasicMaterial({ color: 0xe5a00d, transparent: true, blending: THREE.AdditiveBlending }));
  ring.position.copy(pos); ring.rotation.x = Math.PI / 2; scene.add(ring);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 140, 8),
    new THREE.MeshBasicMaterial({ color: 0xe5a00d, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending }));
  beam.position.copy(pos).add(new THREE.Vector3(0, 70, 0)); scene.add(beam);
  beacons.push({ ring, beam, pos: pos.clone(), who, t: 0 });
  toast(`⚑ <b style="color:#e5a00d">@${who}</b> ${randOf(["pinged a spot — follow the beam", "dropped a beacon — come see", "marked coordinates — follow the light", "lit a flare in the dark"])}`);
}
function updateBeacons(dt) {
  for (let i = beacons.length - 1; i >= 0; i--) {
    const b = beacons[i]; b.t += dt;
    b.ring.scale.setScalar(1 + Math.sin(b.t * 4) * 0.18);
    const fade = b.t > 27 ? Math.max(0, (30 - b.t) / 3) : 1;
    b.ring.material.opacity = fade; b.beam.material.opacity = 0.3 * fade;
    if (b.t > 30) { scene.remove(b.ring); scene.remove(b.beam); beacons.splice(i, 1); }
  }
}

commsChannel.subscribe((msg) => {
  const d = msg.payload;
  if (!d || d.id === pilotId) return; // own messages are shown locally
  // comms `id` is the sender's pilotId === its ships-actor cid, so look the ship up directly.
  const getPos = pilots.has(d.id) ? () => pilots.get(d.id)?.group.position ?? ship.position : null;
  if (d.type === "chat" && getPos) showBubble(getPos, `<b>@${esc(msg.from.handle)}</b>${esc(d.text)}`, false, 5200);
  else if (d.type === "emote" && getPos) showBubble(getPos, d.emoji, true, 2400);
  else if (d.type === "ping" && Array.isArray(d.p)) dropBeacon(new THREE.Vector3().fromArray(d.p), msg.from.handle);
});

// emote bar
document.querySelectorAll("#emotebar [data-emote]").forEach((b) => {
  b.onclick = () => {
    initAudio();
    const e = b.dataset.emote;
    showBubble(() => ship.position, e, true, 2400);
    commsChannel.publish({ type: "emote", emoji: e, id: pilotId });
    playSfx("select", 0.4, 1.6);
  };
});
document.getElementById("pingBtn").onclick = () => {
  initAudio();
  const p = ship.position.toArray();
  dropBeacon(ship.position.clone(), "you");
  commsChannel.publish({ type: "ping", p, id: pilotId });
  warpSound();
};

// chat line (press T to open)
const chatline = document.getElementById("chatline");
const chatInput = document.getElementById("chatInput");
addEventListener("keydown", (e) => {
  if (e.code === "KeyT" && chatline.style.display !== "block" && document.activeElement?.tagName !== "INPUT") {
    e.preventDefault(); chatline.style.display = "block"; chatInput.focus();
  } else if (e.code === "Escape") { chatline.style.display = "none"; chatInput.blur(); }
});
document.getElementById("chatToggle").addEventListener("click", () => {
  initAudio();
  const open = chatline.style.display === "block";
  chatline.style.display = open ? "none" : "block";
  if (!open) chatInput.focus();
});
chatInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.code === "Enter") {
    const txt = chatInput.value.trim();
    if (txt) { showBubble(() => ship.position, `<b>you</b>${esc(txt)}`, false, 5200); commsChannel.publish({ type: "chat", text: txt, id: pilotId }); }
    chatInput.value = ""; chatline.style.display = "none"; chatInput.blur();
  }
});

// ---------- live pilot roster ----------
let rosterDirty = true, lastRoster = 0;
const rosterStyle = document.createElement("style");
rosterStyle.textContent = `
  #roster { position:absolute; top:14px; right:14px; width:196px; background:rgba(16,16,18,.78); border:1px solid #3f3f46; border-radius:10px; padding:8px 10px; pointer-events:auto; font:11px ui-monospace,monospace; }
  #roster h4 { margin:0 0 6px; color:#71717a; font-family:"Space Grotesk",ui-sans-serif,sans-serif; font-size:10px; letter-spacing:.2em; text-transform:uppercase; font-weight:700; }
  #roster .row { display:flex; align-items:center; gap:7px; padding:3px 0; cursor:pointer; }
  #roster .row:hover .who { color:#fff; }
  #roster .dot { width:9px; height:9px; border-radius:50%; flex:none; box-shadow:0 0 6px currentColor; }
  #roster .who { color:#e4e4e7; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #roster .where { color:#71717a; font-size:9px; }
  @media (max-width:680px){ #roster{ display:none; } }
`;
document.head.appendChild(rosterStyle);
const rosterEl = document.createElement("div");
rosterEl.id = "roster";
document.getElementById("hud").appendChild(rosterEl);

function whereLabel(pos) {
  let best = "deep space", bd = 320;
  for (const [k, s] of Object.entries(SYSTEMS)) { const d = pos.distanceTo(s.pos); if (d < bd) { bd = d; best = k === "misc" ? "home" : s.title; } }
  if (pos.distanceTo(CORE_POS) < 320) best = "the universe";
  return best;
}
function updateRoster() {
  let html = `<h4>pilots · ${pilots.size + 1} flying</h4>`;
  html += `<div class="row"><span class="dot" style="background:#9fe8ff;color:#9fe8ff"></span><span class="who">you</span><span class="where">${whereLabel(ship.position)}</span></div>`;
  for (const [key, p] of pilots) {
    const c = "#" + p.color.getHexString();
    html += `<div class="row" data-key="${key}"><span class="dot" style="background:${c};color:${c}"></span><span class="who">@${esc(p.group.userData.handle)}</span><span class="where">${whereLabel(p.group.position)}</span></div>`;
  }
  rosterEl.innerHTML = html;
}
rosterEl.addEventListener("click", (e) => {
  const row = e.target.closest(".row[data-key]");
  if (!row) return;
  const key = row.dataset.key;
  if (pilots.get(key)) { following = key; toast(`▸ following <b style="color:#7dd3fc">@${esc(pilots.get(key).group.userData.handle)}</b> — click the void to break off`); blip(); }
});

// ---------- digital compass ----------
const compassEl = document.getElementById("compass");
function updateCompass(forward) {
  const heading = Math.atan2(forward.x, forward.z);
  const arc = Math.PI * 0.6, halfW = compassEl.clientWidth / 2;
  const pts = [];
  for (const [k, sys] of Object.entries(SYSTEMS)) pts.push({ pos: sys.pos, label: k === "misc" ? "HOME" : k.toUpperCase().slice(0, 4), color: `#${new THREE.Color(sys.hot).getHexString()}` });
  pts.push({ pos: CORE_POS, label: "UNIV", color: "#c4b5fd" });
  for (const b of beacons) pts.push({ pos: b.pos, label: "PING", color: "#e5a00d" });
  if (following && pilots.get(following)) pts.push({ pos: pilots.get(following).group.position, label: "@" + pilots.get(following).group.userData.handle, color: "#7dd3fc" });
  let html = '<div class="needle"></div>';
  const tmp = new THREE.Vector3();
  for (const p of pts) {
    tmp.subVectors(p.pos, ship.position);
    let rel = Math.atan2(tmp.x, tmp.z) - heading;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    while (rel < -Math.PI) rel += 2 * Math.PI;
    if (Math.abs(rel) > arc) continue;
    const x = halfW + (rel / arc) * halfW;
    html += `<div class="tick" style="left:${x}px;color:${p.color}">${p.label}</div>`;
  }
  compassEl.innerHTML = html;
}

// ---------- wayfinding HUD: edge arrows + systems bar ----------
const navStyle = document.createElement("style");
navStyle.textContent = `
  #systems { position: absolute; top: 44px; left: 14px; display: flex; flex-direction: column; gap: 6px; pointer-events: auto; }
  #systems button { text-align: left; font: 600 11px "Space Grotesk", ui-sans-serif, sans-serif; letter-spacing: .04em; background: rgba(16,16,18,.8); border: 1px solid #3f3f46; color: #a1a1aa; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
  #systems button:hover { border-color: currentColor; }
  .navArrow { position: absolute; font: 700 11px ui-monospace, monospace; pointer-events: auto; cursor: pointer; white-space: nowrap; text-shadow: 0 0 8px #000; }
`;
document.head.appendChild(navStyle);
const systemsBar = document.createElement("div");
systemsBar.id = "systems";
document.getElementById("hud").appendChild(systemsBar);

const navArrows = new Map();
for (const [key, sys] of Object.entries(SYSTEMS)) {
  const color = `#${new THREE.Color(sys.hot).getHexString()}`;
  const btn = document.createElement("button");
  btn.style.color = color;
  btn.textContent = key === "misc" ? "☀ hello.world · home" : `★ ${sys.title} · ${key}`;
  btn.onclick = () => { initAudio(); warpSound(); flyTarget = { position: sys.pos.clone(), offset: new THREE.Vector3(0, 16, sys.starR * 6) }; };
  systemsBar.appendChild(btn);

  const arrow = document.createElement("div");
  arrow.className = "navArrow";
  arrow.style.color = color;
  arrow.onclick = btn.onclick;
  document.getElementById("hud").appendChild(arrow);
  navArrows.set(key, arrow);
}

// "the core" is a destination too
{
  const btn = document.createElement("button");
  btn.style.color = "#c4b5fd";
  btn.textContent = "◍ the universe · black hole";
  btn.onclick = () => { initAudio(); warpSound(); flyTarget = { position: CORE_POS.clone(), offset: new THREE.Vector3(0, 320, 980) }; };
  systemsBar.appendChild(btn);
}

function updateNav() {
  for (const [key, sys] of Object.entries(SYSTEMS)) {
    const arrow = navArrows.get(key);
    const dist = Math.round(ship.position.distanceTo(sys.pos));
    const v = sys.pos.clone().project(camera);
    const behind = v.z > 1;
    const off = behind || Math.abs(v.x) > 0.92 || Math.abs(v.y) > 0.88;
    if (!off && dist < 4000) {
      arrow.style.display = "none";
      continue;
    }
    // clamp to screen edge, point the way
    let x = behind ? -v.x : v.x, y = behind ? -v.y : v.y;
    const m = Math.max(Math.abs(x) / 0.92, Math.abs(y) / 0.85, 0.0001);
    x /= m; y /= m;
    const px = (x * 0.5 + 0.5) * innerWidth, py = (-y * 0.5 + 0.5) * innerHeight;
    const ang = Math.atan2(-(y), x);
    arrow.style.display = "block";
    arrow.style.left = `${Math.min(Math.max(px - 30, 8), innerWidth - 130)}px`;
    arrow.style.top = `${Math.min(Math.max(py - 8, 40), innerHeight - 30)}px`;
    const chevron = Math.abs(x) >= Math.abs(y) ? (x > 0 ? "▶" : "◀") : (y > 0 ? "▲" : "▼");
    arrow.textContent = `${chevron} ${key === "misc" ? "home" : sys.title} · ${dist}u`;
    void ang;
  }
}

// ---------- AI navigator: "ask the universe" (dogfoods worlds.ai) ----------
function localMatch(query, catalog) {
  const terms = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  let best = null, bestScore = -1;
  for (const s of catalog) {
    const hay = `${s.name} ${s.category} ${s.description}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += hay.includes(` ${t}`) || s.name.includes(t) ? 2 : 1;
    if (s.category && terms.some((t) => s.category.includes(t))) score += 2;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore > 0 ? best : catalog[Math.floor(Math.random() * catalog.length)];
}

const askForm = document.getElementById("ask");
const askInput = document.getElementById("askInput");
askForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  initAudio();
  const q = askInput.value.trim();
  if (!q || !planets.size) return;
  const catalog = [...planets.values()].map((g) => g.userData.site).map((s) => ({ name: s.name, category: s.category, description: s.description || "" }));
  askInput.disabled = true;
  askInput.value = "✦ consulting the universe…";

  let target = null, why = "";
  try {
    const prompt = `You navigate an internal website universe. Available worlds:\n${catalog.map((s) => `- ${s.name} [${s.category}]: ${s.description}`).join("\n")}\n\nThe pilot asks: "${q}"\nReply with ONLY JSON {"site":"<exact world name from the list>","why":"<reason, max 8 words>"}.`;
    const res = await worlds.ai.complete({ prompt, model: "fast", max_tokens: 90 });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (m) { const j = JSON.parse(m[0]); target = catalog.find((s) => s.name === j.site); why = (j.why || "").slice(0, 60); }
  } catch { /* AI not configured or failed — fall back to local search */ }
  if (!target) { target = localMatch(q, catalog); why = why || "closest match"; }

  askInput.disabled = false;
  askInput.value = "";
  askInput.blur();
  const g = planets.get(target.name);
  if (g) { flyTarget = g; focusTarget = g; showCard(g.userData.site); warpSound(); toast(`▸ navigating to <b style="color:#e5a00d">${target.name}.world</b> — ${why}`); }
});

// assets first — planets plant Kenney forests at build time
preload().then(() => {
  buildShip();
  buildBelt();
  return load();
});

// ---------- cinematic cold open (once per session — diving navigates away & back) ----------
const introEl = document.getElementById("intro");
let introActive = !sessionStorage.getItem("world-seen");
let introT = 0;
const INTRO_DUR = 5.0;
// cinematic camera state
let camShake = 0, prevYaw = 0, bank = 0;
if (introActive) {
  sessionStorage.setItem("world-seen", "1");
  requestAnimationFrame(() => introEl.classList.add("go"));
} else {
  introEl.classList.add("done");
}
function endIntro() {
  if (!introActive || introT < 1.4) return; // ignore stray load-time events
  introActive = false;
  introEl.classList.add("done");
}
addEventListener("keydown", endIntro);
renderer.domElement.addEventListener("pointerdown", endIntro);

// ---------- loop ----------
const clock = new THREE.Clock();
let lastThud = 0;
let wasThrust = false;
let wasFly = false;
// reused scratch to avoid per-frame allocations in the hot loop
const _forward = new THREE.Vector3(), _camGoal = new THREE.Vector3(), _camLook = new THREE.Vector3(), _vp = new THREE.Vector3();
const _pq = new THREE.Quaternion(), _back = new THREE.Vector3();
// per-frame scratch — reused every tick so the render loop allocates nothing
const _euler = new THREE.Euler(0, 0, 0, "YXZ"), _quat = new THREE.Quaternion();
const _accel = new THREE.Vector3(), _to = new THREE.Vector3(), _push = new THREE.Vector3(), _collTmp = new THREE.Vector3();
const _goal = new THREE.Vector3(), _engTmp = new THREE.Vector3(), _tmpv = new THREE.Vector3();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  uTime.value = clock.elapsedTime;
  const t = clock.elapsedTime;

  for (const g of planets.values()) {
    const d = g.userData;
    d.angle += d.speed * dt;
    g.position.set(
      d.sys.pos.x + Math.cos(d.angle) * d.orbitR,
      d.sys.pos.y + d.y,
      d.sys.pos.z + Math.sin(d.angle) * d.orbitR,
    );
    if (d.spinner) d.spinner.rotation.y += d.spin * dt;
    if (d.clouds) d.clouds.rotation.y += d.clouds.userData.spin * dt;
    if (d.scaleIn < 1) {
      d.scaleIn = Math.min(d.scaleIn + dt * 1.4, 1);
      g.scale.setScalar(Math.max(1 - (1 - d.scaleIn) ** 3, 0.001));
    }
    for (const child of g.children) {
      if (child.userData.orbit) {
        const o = child.userData.orbit;
        child.position.set(Math.cos(t * o.speed + o.phase) * o.r, 0.3, Math.sin(t * o.speed + o.phase) * o.r);
      }
    }
  }

  for (const b of belts) b.rotation.y += b.userData.spin * dt;
  if (mothership) {
    const ma = t * 0.05;
    mothership.position.set(Math.cos(ma) * 26, 4, Math.sin(ma) * 26);
    mothership.rotation.y = -ma - Math.PI / 2;
  }
  if (coreDisk) coreDisk.rotation.z += dt * 0.12;
  updateShootingStars(dt);
  updateBeacons(dt);
  updateNovas(dt);
  updateCodex();
  updateTransmissions(dt);

  // joystick steers (with a deadzone, gentler gain); drag-look + keys also steer
  if (joy.active) {
    const dz = 0.16;
    const sx = Math.abs(joy.x) > dz ? joy.x : 0;
    const sy = Math.abs(joy.y) > dz ? joy.y : 0;
    yaw -= sx * 1.3 * dt;
    pitch = Math.max(-1.2, Math.min(1.2, pitch - sy * 1.3 * dt));
  }
  // keyboard flight: WASD (A/D turn, W/S thrust+reverse) + R/F pitch + arrows — fly with no mouse
  const kYaw = (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0) - (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0);
  if (kYaw) yaw += kYaw * 1.7 * dt;
  const kPitch = (keys.has("KeyR") ? 1 : 0) - (keys.has("KeyF") ? 1 : 0);
  if (kPitch) pitch = Math.max(-1.2, Math.min(1.2, pitch + kPitch * 1.4 * dt));
  // ease the ship to face the world/system we clicked or warped to — so an FTL jump
  // flies toward it head-on (not sliding sideways) and stays centered in frame.
  const faceTarget = focusTarget || flyTarget;
  if (faceTarget && faceTarget.position && !dive) {
    _faceDir.subVectors(faceTarget.position, ship.position);
    if (_faceDir.lengthSq() > 1e-4) {
      _faceDir.normalize();
      const ty = Math.atan2(_faceDir.x, -_faceDir.z);
      const tp = Math.max(-1.2, Math.min(1.2, Math.asin(Math.max(-1, Math.min(1, _faceDir.y)))));
      let d = ty - yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      const e = 1 - Math.exp(-(flyTarget ? 8 : 5) * dt);
      yaw += d * e;
      pitch += (tp - pitch) * e;
    }
  }
  // ship orientation
  _euler.set(pitch, yaw, 0);
  _quat.setFromEuler(_euler);
  ship.quaternion.slerp(_quat, 1 - Math.exp(-8 * dt));
  const forward = _forward.set(0, 0, -1).applyQuaternion(ship.quaternion);
  const keyThrust = keys.has("KeyW") || keys.has("Space") || keys.has("ArrowUp");
  const driveAmt = Math.max(keyThrust ? 1 : 0, joy.active ? Math.min(Math.hypot(joy.x, joy.y), 1) : 0);
  const thrust = driveAmt > 0.12;

  if (dive) {
    // wormhole dive: rush into the planet, white out, then enter the real site
    dive.t += dt;
    const k = dive.t / DIVE_DUR;
    ship.position.lerp(dive.group.position, 1 - Math.exp(-5 * dt));
    flashEl.style.opacity = String(Math.min(1, k * 1.4));
    if (dive.t >= DIVE_DUR) { location.href = dive.group.userData.site.url; dive.t = -999; }
  } else if (flyTarget && !thrust) {
    // autopilot warp: overrides physics, glides to a vantage point outside the body
    let goal;
    if (flyTarget.offset) {
      goal = _goal.copy(flyTarget.position).add(flyTarget.offset);
    } else {
      const br = flyTarget.userData.bodyR ?? 6;
      goal = _goal.set(flyTarget.position.x, flyTarget.position.y + br * 0.5, flyTarget.position.z + br + shipRadius + 10);
    }
    const k = ship.position.distanceTo(goal) > 120 ? 0.9 : 1.6;
    ship.position.lerp(goal, 1 - Math.exp(-k * dt));
    vel.multiplyScalar(Math.exp(-4 * dt)); // bleed residual momentum
    if (ship.position.distanceTo(goal) < 2) flyTarget = null;
  } else if (focusTarget && !thrust) {
    // frozen hold: keep a vantage just off the world, no gravity/drift, facing it,
    // until the pilot dives in ("walk"), closes the card, or thrusts away.
    const br = focusTarget.userData.bodyR ?? 6;
    const goal = _goal.set(focusTarget.position.x, focusTarget.position.y + br * 0.5, focusTarget.position.z + br + shipRadius + 10);
    ship.position.lerp(goal, 1 - Math.exp(-3 * dt));
    vel.multiplyScalar(Math.exp(-6 * dt));
  } else if (following && pilots.get(following) && !thrust) {
    // formation flight: trail behind the followed pilot
    const lead = pilots.get(following).group;
    const goal = _goal.set(0, 5, 20).applyQuaternion(lead.quaternion).add(lead.position);
    ship.position.lerp(goal, 1 - Math.exp(-3 * dt));
    ship.quaternion.slerp(lead.quaternion, 1 - Math.exp(-3 * dt));
    vel.multiplyScalar(Math.exp(-3 * dt));
  } else {
    // manual flight with gravity. Thrust ALWAYS wins: drop any autopilot/focus so
    // holding W always drives forward (releaseFocus turns us outward first).
    if (thrust) { flyTarget = null; following = null; if (focusTarget) releaseFocus(); }
    if (driveAmt > 0.05) vel.addScaledVector(forward, 70 * driveAmt * dt);
    if (keys.has("KeyS") || keys.has("ArrowDown")) vel.addScaledVector(forward, -34 * dt);
    const G = 48; _accel.set(0, 0, 0);
    const pullFrom = (pos, mass, cap = 22, min = 36, cull2 = Infinity) => {
      _to.subVectors(pos, ship.position);
      const ls = _to.lengthSq();
      if (ls > cull2) return;   // far bodies pull negligibly — skip the normalize/divide
      const d2 = Math.max(ls, min);
      _accel.addScaledVector(_to.normalize(), Math.min((G * mass) / d2, cap));
    };
    for (const b of starBodies) pullFrom(b.pos, b.mass);
    for (const g of planets.values()) pullFrom(g.position, g.userData.mass, 22, 36, 810000); // ~900u cull
    pullFrom(CORE_POS, BH_MASS, 75, 144);   // the black hole pulls hard, from far away
    vel.addScaledVector(_accel, dt);
    vel.multiplyScalar(Math.exp(-0.85 * dt));
    ship.position.addScaledVector(vel, dt);
  }

  // cross the event horizon → wormhole jump to the home star (a shortcut, not death)
  if (!dive && ship.position.distanceTo(CORE_POS) < EH_R + shipRadius) wormholeJump();

  // soft collisions: every body is wrapped in a cushion shell — a repulsor field that
  // eases you to a stop before the surface — instead of a hard wall that snaps your
  // position and kicks you back. softHit (0→1) tracks how deep into the cushion you are
  // (drives a gentle shield glow); a true surface contact gives a small shake + thud.
  let softHit = 0, hardHit = false;
  if (!dive) {
    const resolve = (pos, surf) => {
      _push.subVectors(ship.position, pos);
      const dist = _push.length() || 1e-3;
      const cushion = Math.max(4, Math.min(30, surf * 0.18)); // soft shell thickness
      const soft = surf + cushion;
      if (dist >= soft) return;
      _push.multiplyScalar(1 / dist);          // outward unit normal
      const pen = (soft - dist) / cushion;     // 0 at shell edge → 1 at surface → >1 inside
      const into = vel.dot(_push);             // < 0 ⇒ heading into the body
      if (dist > surf) {
        // inside the cushion: a gentle spring nudges you out and bleeds inward speed —
        // no snap, no thud. Ramps with pen² so the shell edge is feather-soft.
        const k = pen * pen;
        vel.addScaledVector(_push, k * 100 * dt);                   // soft repulsor (beats gravity)
        if (into < 0) vel.addScaledVector(_push, -into * k * 0.6);  // ease away inward motion
        softHit = Math.max(softHit, Math.min(1, pen));
      } else {
        // punched through (came in hot): ease back to the surface and zero the inward
        // component — no rebound, so you slide along the surface instead of pinging off.
        ship.position.lerp(_collTmp.copy(pos).addScaledVector(_push, surf), 1 - Math.exp(-14 * dt));
        if (into < 0) vel.addScaledVector(_push, -into);
        flyTarget = null;
        softHit = 1; hardHit = true;
      }
    };
    for (const b of starBodies) resolve(b.pos, b.r * 1.1 + shipRadius);
    for (const g of planets.values()) resolve(g.position, g.userData.bodyR + shipRadius);
  }
  // shield shimmers as it absorbs the cushion; only a real surface hit shakes + thuds (gently now)
  if (shieldMesh && softHit > 0.001) shieldMesh.material.uniforms.uHit.value = Math.max(shieldMesh.material.uniforms.uHit.value, softHit);
  if (hardHit) {
    camShake = Math.max(camShake, 0.22);
    if (t - lastThud > 0.35) { thud(); lastThud = t; }
  }
  if (shieldMesh) shieldMesh.material.uniforms.uHit.value *= Math.exp(-6 * dt);

  // dive proximity prompt
  if (!dive && !flyTarget && !focusTarget && !cardSite && !introActive && planets.size) {
    let best = Infinity, bp = null;
    for (const g of planets.values()) {
      const d = ship.position.distanceTo(g.position) - g.userData.bodyR;
      if (d < best) { best = d; bp = g; }
    }
    if (bp && best < shipRadius * 7) {
      nearPlanet = bp;
      divePrompt.style.display = "block";
      divePrompt.textContent = `↵ DIVE INTO ${bp.userData.site.name.toUpperCase()}`;
      // first close pass to a world → its people hail you (once per world, throttled so a dense
      // cluster doesn't spam the model — cached to worlds.db so repeat visits are free)
      const site = bp.userData.site;
      if (!hailed.has(site.name) && t - lastHail > 6) {
        hailed.add(site.name); lastHail = t;
        const c = `#${new THREE.Color((SYSTEMS[site.category] ?? SYSTEMS.misc).hot).getHexString()}`;
        hailFor(site).then((h) => { if (h && nearPlanet === bp) toast(`📡 <span style="color:${c}">${esc(site.name)}.world hails you</span><br><span style="color:#cbd5e1">“${esc(h)}”</span>`, 6000, { wide: true }); });
      }
    } else { nearPlanet = null; divePrompt.style.display = "none"; }
  } else if (!dive) {
    nearPlanet = null; divePrompt.style.display = "none";
  }

  // engine trail from the actual nozzle
  const eng = _engTmp.copy(enginePoint).applyQuaternion(ship.quaternion).add(ship.position);
  for (let i = 0; i < TRAIL_N; i++) trailAge[i] = Math.min(trailAge[i] + dt * 1.2, 1);
  if (thrust || vel.lengthSq() > 6 || flyTarget) {
    trailPos.set([eng.x, eng.y, eng.z], trailHead * 3);
    trailAge[trailHead] = 0;
    trailHead = (trailHead + 1) % TRAIL_N;
  }
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.attributes.age.needsUpdate = true;

  // thruster flame layers + engine light follow thrust
  const burning = thrust || flyTarget || dive;
  if (flameMesh) {
    const target = burning ? 1.0 + Math.sin(t * 40) * 0.28 : 0.22;
    flameMesh.scale.y += (target - flameMesh.scale.y) * Math.min(1, dt * 14);
    innerFlame.scale.y += (target * 0.8 - innerFlame.scale.y) * Math.min(1, dt * 16);
    flameMesh.material.opacity = burning ? 0.85 : 0.3;
    innerFlame.material.opacity = burning ? 0.95 : 0.4;
  }
  if (engineLight) engineLight.intensity += ((burning ? 9 : 2.5) - engineLight.intensity) * Math.min(1, dt * 10);
  // navigation blinkers
  for (let i = 0; i < navLights.length; i++) {
    const on = (Math.sin(t * 3 + i * Math.PI) > 0.4) ? 1 : 0.06;
    navLights[i].material.color.multiplyScalar(1); // keep hue
    navLights[i].scale.setScalar(0.6 + on);
    navLights[i].material.opacity = on;
    navLights[i].material.transparent = true;
  }

  // audio: engine loop gain/pitch track speed; thrust burst on press; warp streak on the stars
  const speed = vel.length() + (flyTarget ? 60 : 0);
  if (audio.engineGain) {
    const g = thrust || flyTarget ? 0.55 : 0.12 + Math.min(speed / 300, 0.18);
    audio.engineGain.gain.setTargetAtTime(g, audio.ctx.currentTime, 0.12);
    audio.engineSrc.playbackRate.setTargetAtTime(0.85 + Math.min(speed / 120, 0.7), audio.ctx.currentTime, 0.15);
  }
  if (thrust && !wasThrust) playSfx("thrust", 0.4);
  wasThrust = thrust;
  // FTL: an active jump (flyTarget) forces the star-streak on; fast manual flight ramps it too.
  if (flyTarget && !wasFly) { if (flashEl) { flashEl.style.opacity = "0.32"; setTimeout(() => { flashEl.style.opacity = "0"; }, 110); } }
  wasFly = !!flyTarget;
  if (starMat) {
    const targetWarp = flyTarget ? 0.62 : Math.max(0, Math.min((speed - 110) / 260, 1));
    const rate = flyTarget ? 5 : 4;
    starMat.uniforms.uWarp.value += (targetWarp - starMat.uniforms.uWarp.value) * Math.min(1, dt * rate);
  }
  // follow badge: visible while trailing another pilot; clears if they leave
  if (following && pilots.get(following)) {
    followBadge.style.display = "block";
    followBadge.innerHTML = `▸ following <b>@${esc(pilots.get(following).group.userData.handle)}</b> · tap empty space to break off`;
  } else {
    if (following && !pilots.get(following)) following = null;
    followBadge.style.display = "none";
  }

  // other pilots: broadcast mine, glide theirs toward their last report
  broadcastShip(performance.now());
  for (const [key, p] of pilots) {
    if (performance.now() - (p.seen ?? 0) > 8000) {
      scene.remove(p.group); scene.remove(p.trail.line);
      pilots.delete(key);
      rosterDirty = true;
      if (following === key) following = null;
      updatePilotCount();
      continue;
    }
    p.group.position.lerp(_tmpv.fromArray(p.target.p), 1 - Math.exp(-6 * dt));
    p.group.quaternion.slerp(_pq.fromArray(p.target.q), 1 - Math.exp(-6 * dt));
    if (p.label) {
      // bigger far, smaller close — spot distant pilots, don't get crowded up close
      const f = Math.max(0.55, Math.min(2.6, camera.position.distanceTo(p.group.position) / 55));
      p.label.scale.set(PILOT_LABEL_W * f, PILOT_LABEL_H * f, 1);
    }
    // their engine trail
    const tr = p.trail;
    for (let i = 0; i < tr.age.length; i++) tr.age[i] = Math.min(tr.age[i] + dt * 1.2, 1);
    _back.set(0, 0, 1.3).applyQuaternion(p.group.quaternion).add(p.group.position);
    tr.pos.set([_back.x, _back.y, _back.z], tr.head * 3);
    tr.age[tr.head] = 0;
    tr.head = (tr.head + 1) % tr.age.length;
    tr.geo.attributes.position.needsUpdate = true;
    tr.geo.attributes.age.needsUpdate = true;
    // proximity high-five
    const dist = ship.position.distanceTo(p.group.position);
    if (dist < 16 && t - p.lastHi > 8) {
      p.lastHi = t;
      showBubble(() => ship.position, "🤝", true, 1800);
      showBubble(() => p.group.position, "🤝", true, 1800);
      spawnNova(p.group.position.clone().lerp(ship.position, 0.5), p.color.getHex());
      playSfx("select", 0.5, 1.2);
      toast(`🤝 ${randOf(["high-five with", "fly-by salute to", "wings waggled at", "warp-five with"])} <b style="color:#7dd3fc">@${esc(p.group.userData.handle)}</b>`);
    }
  }
  if (rosterDirty || t - lastRoster > 0.5) { updateRoster(); lastRoster = t; rosterDirty = false; }

  updateNav();

  // ---- god rays aimed at the nearest on-screen star ----
  if (godrayPass) {
    let near = null, nd = Infinity;
    for (const b of starBodies) { const d = camera.position.distanceTo(b.pos); if (d < nd) { nd = d; near = b; } }
    let gi = 0;
    if (near) {
      const sp = near.pos.clone().project(camera);
      if (sp.z < 1 && Math.abs(sp.x) < 1.3 && Math.abs(sp.y) < 1.3) {
        godrayPass.uniforms.uSun.value.set(sp.x * 0.5 + 0.5, -sp.y * 0.5 + 0.5);
        godrayPass.uniforms.uColor.value.set(near.hot);
        gi = 0.3 + 0.4 * (1 - Math.min(Math.hypot(sp.x, sp.y) / 1.3, 1));
      }
    }
    godrayPass.uniforms.uIntensity.value += (gi - godrayPass.uniforms.uIntensity.value) * Math.min(1, dt * 5);
  }

  // ---- cinematic camera: speed-FOV, banking, shake, FTL punch ----
  // FTL jumps punch the FOV way out + shake the rig for a real hyperspace kick.
  const targetFov = 70 + Math.min(speed, 140) / 140 * 20 + (dive ? 30 : 0) + (flyTarget ? 15 : 0);
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * (flyTarget ? 5 : 4));
  camera.updateProjectionMatrix();
  const dYaw = yaw - prevYaw; prevYaw = yaw;
  bank += (Math.max(-0.5, Math.min(0.5, -dYaw * 9)) - bank) * Math.min(1, dt * 6);
  camShake = Math.max(camShake * Math.exp(-3 * dt), flyTarget ? 0.025 : (thrust && !introActive ? 0.04 : 0));

  if (introActive) {
    // sweeping orbit-arc fly-in: spiral around hello.world, settle behind the ship
    introT += dt;
    const e = 1 - (1 - Math.min(introT / INTRO_DUR, 1)) ** 3;
    const ang = -1.6 + e * 2.3, rad = 620 - e * 594, hgt = 240 - e * 232;
    const arc = new THREE.Vector3(Math.cos(ang) * rad, hgt, Math.sin(ang) * rad);
    const end = ship.position.clone().addScaledVector(forward, -14).add(new THREE.Vector3(0, 4.5, 0));
    camera.position.lerpVectors(arc, end, e * e);
    camera.lookAt(_camLook.set(0, 0, 0).lerp(ship.position, e));
    if (introT >= INTRO_DUR) endIntro();
  } else {
    _camGoal.copy(ship.position).addScaledVector(forward, dive ? -8 : -14);
    _camGoal.y += 4.5;
    if (camShake > 0.001) _camGoal.x += (Math.random() - 0.5) * camShake * 6, _camGoal.y += (Math.random() - 0.5) * camShake * 6, _camGoal.z += (Math.random() - 0.5) * camShake * 6;
    camera.position.lerp(_camGoal, 1 - Math.exp(-(dive ? 9 : 6) * dt));
    camera.lookAt(_camLook.copy(ship.position).addScaledVector(forward, 10));
    camera.rotateZ(bank + (dive ? dive.t * 3.2 : 0)); // bank into turns, barrel-roll the dive
  }

  // hyperspace: tunnel rides the camera, radial-blur pass drags the whole frame —
  // both share the warp ramp
  if (warpField && starMat) {
    warpField.position.copy(camera.position);
    warpField.quaternion.copy(camera.quaternion);
    warpMat.uniforms.uWarp.value = starMat.uniforms.uWarp.value;
  }
  if (warpBlurPass && starMat) {
    warpBlurPass.uniforms.uWarp.value = starMat.uniforms.uWarp.value;
    // center the radial streaks on where the nose points (the travel vanishing point)
    _vp.copy(ship.position).addScaledVector(forward, 1200).project(camera);
    if (_vp.z < 1) warpBlurPass.uniforms.uCenter.value.set(_vp.x * 0.5 + 0.5, -_vp.y * 0.5 + 0.5);
    else warpBlurPass.uniforms.uCenter.value.set(0.5, 0.5);
  }

  updateBubbles();
  updateCompass(forward);

  if (composer) {
    try { composer.render(); }
    catch (e) { console.warn("composer.render failed — switching to plain render:", e); composer = null; }
  }
  if (!composer) renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (composer) composer.setSize(innerWidth, innerHeight);
});
