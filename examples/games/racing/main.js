import * as THREE from "three";

// ───────────────────────────────────────────────────────────────────────────
// Kart Loop — low-poly arcade multiplayer racing on the Worlds platform.
//
// A "running lobby" (like tumble): there is no waiting room. Everyone drops into
// the SAME track and laps it for real time. A shared clock rotates the track for
// everyone on a timer, then a fresh 3·2·1 countdown begins. Each track keeps its
// own hotlap board.
//
// Worlds SDK is the ONLY backend:
//   worlds.room("race")          — the shared clock {trackIndex, roundEndsAt}.
//   worlds.actors("race")        — per-racer pose state, zoned by trackIndex.
//   worlds.ws.channel("race-room") — presence (live headcount).
//   worlds.db "laps"             — one doc per (handle, track): best lap on it.
// Horn is a one-off actor EVENT (send/onEvent). Each tab has a clientId; we ignore
// our own echoed poses by handle.
// ───────────────────────────────────────────────────────────────────────────

const ACTORS = "race";       // pose feed
const ROOM = "race";         // shared clock room
const ROOM_CH = "race-room"; // presence channel
const LEADERBOARD = "laps";  // db collection: per-(handle,track) best lap

const ROUND_MS = 150_000;    // seconds each track is live before rotating
const SEND_HZ = 14;          // pose broadcasts per second (SDK asks for 12-15)
const STALE_MS = 4000;       // drop a remote kart unheard-from this long
const POSE_LERP = 12;        // remote position smoothing rate
const HEAD_LERP = 10;        // remote heading smoothing rate

const { id, esc, toast } = worlds;
const clientId = id();

// ── Player identity (filled from worlds.me, with anonymous fallback) ────────
const me = { handle: null, name: "you", color: 0xfbbf24 };

// ───────────────────────────────────────────────────────────────────────────
// Color from handle (stable, vivid). Avoids the player's own gold so remotes
// stand out against you.
// ───────────────────────────────────────────────────────────────────────────
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function colorForHandle(handle) {
  const h = (hashStr(handle || "anon") % 360) / 360;
  const c = new THREE.Color();
  c.setHSL(h, 0.72, 0.56);
  return c.getHex();
}

// ── DOM ─────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const dom = {
  canvas: $("scene"),
  lapN: $("lapN"),
  timer: $("timer"),
  best: $("best"),
  last: $("last"),
  spd: $("spd"),
  racerN: $("racerN"),
  racerS: $("racerS"),
  wrongWay: $("wrongWay"),
  boardTitle: $("boardTitle"),
  boardList: $("boardList"),
  countdown: $("countdown"),
  cdNum: $("cdNum"),
  trackName: $("trackName"),
  trackMeta: $("trackMeta"),
  roundFill: $("roundFill"),
  roundBar: $("roundBar"),
  nextUp: $("nextUp"),
  loader: $("loader"),
  loaderWho: $("loaderWho"),
  loaderErr: $("loaderErr"),
  touch: { left: $("btnLeft"), right: $("btnRight"), gas: $("btnGas"), brake: $("btnBrake"), drift: $("btnDrift") },
};

// ───────────────────────────────────────────────────────────────────────────
// TRACKS — each a closed loop of Catmull-Rom control points with a height
// profile (Y) and a per-point bank weight. We use the CENTRIPETAL parameter-
// ization so the spline never overshoots into cusps / self-loops — the old
// "catmullrom" tension crumpled tight corners into a folded-over mess. Every
// track's minimum corner radius is verified larger than the road's half-width,
// so the ribbon never overlaps itself.
//
// Geometry is rebuilt at runtime when the running lobby rotates, so all the
// per-track state below is mutable and refilled by computeTrackGeometry().
// ───────────────────────────────────────────────────────────────────────────
const ROAD_HALF = 7.0;   // half-width of drivable road
const CURB_W = 0.9;
const EMB = 2.0;         // how far the terrain sits below the road edge (a low berm)
const BACKSTOP_Y = -60;  // deep backstop plane under the followed terrain
const BANK_MAX = 0.2;    // max road roll (radians) at a fully-banked corner
const SAMPLES = 600;     // centerline samples per track
const CHECKPOINT_COUNT = 5;

// theme: palette + sky + scenery biome. scenery ∈ trees|cacti|pines|pylons|stands
// Tracks have a real height profile (Y) — a terrain heightfield is generated to
// FOLLOW the track (buildTerrain), so elevated sections sit on hills instead of
// floating. Character comes from the layout, elevation, banking and biome.
const TRACKS = [
  {
    id: "sunset-bay", name: "Sunset Bay", blurb: "flowing seaside sweepers", laps: 3,
    cp: [
      [0, 0, 72], [40, 0.4, 66], [68, 1.4, 40], [76, 2.2, 4], [70, 2.6, -34],
      [46, 2.0, -64], [6, 1.0, -74], [-36, 1.4, -66], [-66, 2.2, -38], [-74, 2.0, 2],
      [-66, 1.0, 40], [-34, 0.3, 62],
    ],
    bank: [0.0, 0.2, 0.5, 0.5, 0.5, 0.45, 0.1, 0.45, 0.5, 0.5, 0.4, 0.2],
    theme: {
      ground: 0x6aa84a, road: 0x35363d, curb: [0xd8413a, 0xf3f3f5], cone: 0xf97316,
      fog: [0xf6c79a, 200, 470], sky: [0x1d4e8a, 0xf3a662, 0xffd9a0],
      sun: [0xffe1b0, 1.2, 70, 120, 50], hemi: [0xffe3c0, 0x4a5d3a, 0.85],
      scenery: "trees", stands: true,
    },
  },
  {
    id: "dust-devil", name: "Dust Devil", blurb: "rolling desert flat-out", laps: 3,
    cp: [
      [-60, 0, 86], [10, 0.5, 92], [64, 1.8, 76], [92, 3.2, 36], [88, 4.0, -16],
      [60, 4.2, -56], [14, 3.0, -76], [-36, 2.0, -70], [-72, 1.2, -34], [-86, 0.5, 14],
      [-80, 0, 56],
    ],
    bank: [0.0, 0.1, 0.4, 0.5, 0.5, 0.45, 0.2, 0.4, 0.45, 0.4, 0.2],
    theme: {
      ground: 0xceb079, road: 0x4a4438, curb: [0xd8413a, 0xf3f3f5], cone: 0xf59e0b,
      fog: [0xe8cfa0, 230, 540], sky: [0x4a8fd0, 0xbcd6ec, 0xe9d6ad],
      sun: [0xfff4d6, 1.35, 80, 130, 40], hemi: [0xdfe8ff, 0x8a7345, 0.95],
      scenery: "cacti", stands: false,
    },
  },
  {
    id: "glacier-pass", name: "Glacier Pass", blurb: "alpine climbs & drops", laps: 3,
    cp: [
      [0, 0, 74], [46, 1.5, 66], [70, 4.0, 34], [72, 6.5, -6], [56, 7.5, -44],
      [18, 6.5, -70], [-26, 5.0, -70], [-58, 3.5, -42], [-72, 2.0, -2], [-62, 1.0, 38],
      [-30, 0.3, 60],
    ],
    bank: [0.0, 0.3, 0.55, 0.5, 0.6, 0.5, 0.4, 0.55, 0.5, 0.4, 0.2],
    theme: {
      ground: 0xe8eef4, road: 0x3a3d44, curb: [0xcf3b3b, 0xffffff], cone: 0x2563eb,
      fog: [0xdfeaf2, 160, 400], sky: [0x6f9fd0, 0xcfe2f0, 0xeef6fb],
      sun: [0xeaf2ff, 1.15, -40, 120, 40], hemi: [0xeaf3ff, 0x8aa0b4, 1.0],
      scenery: "pines", stands: false,
    },
  },
  {
    id: "neon-city", name: "Neon City", blurb: "tight technical street circuit", laps: 4,
    cp: [
      [0, 0, 56], [44, 0, 51], [64, 0, 22], [64, 0, -20], [47, 0, -50],
      [6, 0, -62], [-37, 0, -57], [-63, 0, -26], [-59, 0, 8], [-64, 0, 38],
      [-34, 0, 55],
    ],
    bank: [0.0, 0.3, 0.7, 0.7, 0.65, 0.4, 0.6, 0.7, 0.55, 0.6, 0.3],
    theme: {
      ground: 0x14141c, road: 0x1c1c26, curb: [0xff2d6e, 0x22d3ee], cone: 0x22d3ee,
      fog: [0x0a0a16, 120, 330], sky: [0x05030f, 0x1a0f2e, 0x2a1140],
      sun: [0x9fb4ff, 0.7, 40, 120, -30], hemi: [0x3a2a66, 0x0a0a16, 0.7],
      scenery: "pylons", stands: false, neon: true,
    },
  },
  {
    id: "speedway", name: "Speedway", blurb: "banked oval — pure top speed", laps: 5,
    cp: [
      [0, 0, 60], [52, 0, 54], [70, 0, 20], [70, 0, -20], [52, 0, -54],
      [0, 0, -60], [-52, 0, -54], [-70, 0, -20], [-70, 0, 20], [-52, 0, 54],
    ],
    bank: [0.0, 0.7, 1.0, 1.0, 0.7, 0.0, 0.7, 1.0, 1.0, 0.7],
    theme: {
      ground: 0x4f9a3f, road: 0x33343b, curb: [0xd8413a, 0xf3f3f5], cone: 0xf97316,
      fog: [0x9ad0e8, 230, 540], sky: [0x2b6fb0, 0x9ad0e8, 0xeef4f7],
      sun: [0xfff4d6, 1.3, 70, 130, 50], hemi: [0xbfe3ff, 0x4a7a3a, 0.95],
      scenery: "stands", stands: true,
    },
  },
];

// ── mutable active-track geometry (refilled by computeTrackGeometry) ──
let curve, TRACK_LEN;
let centerPts = [];      // SAMPLES+1 points, closed
let tangents = [];
let sideNormals = [];    // banked road-right direction
let ups = [];            // banked surface up
let bankCurve;
let curTrack = TRACKS[0];
let checkpoints = [];    // { index, center, forward, normal, up, mats?, group? }
let finishNormal, finishCenter, finishForward;
let trackEdges = null;   // { left, right, curbL, curbR } of the current build
let sunOffset = new THREE.Vector3(70, 120, 50);
let terrainBaseY = -8;   // base level the followed terrain falls away to

function bankWeightAt(u) {
  return THREE.MathUtils.clamp(bankCurve.getPoint(((u % 1) + 1) % 1).y, 0, 1);
}

// Compute the centerline, tangents, banked surface frame, finish frame and the
// checkpoint ring for TRACKS[index]. Pure data — meshes are built separately.
function computeTrackGeometry(index) {
  const n = ((index % TRACKS.length) + TRACKS.length) % TRACKS.length;
  curTrack = TRACKS[n];
  const cps = curTrack.cp.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  curve = new THREE.CatmullRomCurve3(cps, true, "centripetal");
  TRACK_LEN = curve.getLength();
  centerPts = curve.getSpacedPoints(SAMPLES);
  tangents = [];
  for (let i = 0; i <= SAMPLES; i++) tangents.push(curve.getTangentAt((i % SAMPLES) / SAMPLES).normalize());

  // terrain falls away to a base below the track's lowest point
  let ymin = Infinity;
  for (let i = 0; i < SAMPLES; i++) ymin = Math.min(ymin, centerPts[i].y);
  terrainBaseY = ymin - 6;

  // smooth bank weight over u∈[0,1) from the per-control-point weights
  const bw = curTrack.bank;
  bankCurve = new THREE.CatmullRomCurve3(
    bw.map((w, i) => new THREE.Vector3(i / bw.length, w, 0)),
    true, "catmullrom", 0.5,
  );

  // per-sample banked frame: side normal rolled toward the inside of the curve
  sideNormals = [];
  ups = [];
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= SAMPLES; i++) {
    const t = tangents[i % SAMPLES];
    const flatN = new THREE.Vector3().crossVectors(WORLD_UP, t).normalize();
    const tn = tangents[(i + 4) % SAMPLES];
    const turnSign = Math.sign(t.x * tn.z - t.z * tn.x) || 0; // +left, -right (XZ)
    const u = (i % SAMPLES) / SAMPLES;
    const bank = bankWeightAt(u) * BANK_MAX;
    const roll = turnSign * bank; // bank INTO the turn (raise the outer edge), not off-camber
    const q = new THREE.Quaternion().setFromAxisAngle(t, roll);
    sideNormals.push(flatN.clone().applyQuaternion(q).normalize());
    ups.push(WORLD_UP.clone().applyQuaternion(q).normalize());
  }

  // finish frame at sample 0 (HORIZONTAL — lap math projects flat XZ onto it)
  finishCenter = centerPts[0].clone();
  finishForward = tangents[0].clone().setY(0).normalize();
  finishNormal = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), tangents[0]).normalize();

  // checkpoint ring — evenly spaced, never on the finish line (anti-shortcut)
  checkpoints = [];
  for (let k = 0; k < CHECKPOINT_COUNT; k++) {
    const frac = (k + 0.5) / CHECKPOINT_COUNT;
    const idx = Math.floor(frac * SAMPLES) % SAMPLES;
    checkpoints.push({
      index: idx,
      center: centerPts[idx].clone(),
      forward: tangents[idx].clone().setY(0).normalize(),
      normal: new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), tangents[idx]).normalize(),
      up: ups[idx].clone(),
    });
  }
}

// progress (0..1) lookup: nearest sample index, used for lap line crossing.
function nearestSample(x, z) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const p = centerPts[i];
    const dx = p.x - x, dz = p.z - z;
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; bi = i; }
  }
  return { index: bi, dist: Math.sqrt(bd) };
}

// ── Surface query: interpolated height + up + tangent at an XZ point ────────
const _segA = new THREE.Vector3();
const _segB = new THREE.Vector3();
const _segAB = new THREE.Vector3();
function surfaceAt(x, z) {
  const near = nearestSample(x, z);
  const i = near.index;
  const iPrev = (i - 1 + SAMPLES) % SAMPLES;
  const iNext = (i + 1) % SAMPLES;
  let a = i, b = iNext, frac;
  const tFwd = projParam(centerPts[i], centerPts[iNext], x, z);
  const tBwd = projParam(centerPts[iPrev], centerPts[i], x, z);
  if (tFwd >= 0) { a = i; b = iNext; frac = Math.min(1, tFwd); }
  else { a = iPrev; b = i; frac = Math.max(0, tBwd); }
  const pa = centerPts[a], pb = centerPts[b];
  const yCenter = pa.y + (pb.y - pa.y) * frac;
  const up = ups[a].clone().lerp(ups[b], frac).normalize();
  const t = tangents[a].clone().lerp(tangents[b], frac).normalize();
  const sideN = sideNormals[a].clone().lerp(sideNormals[b], frac).normalize();
  // Ride the BANKED cross-section: a kart offset sideways from the centerline on
  // a banked corner sits higher/lower than the centerline. Project the query
  // point's horizontal offset onto the banked side normal and rise with it, so
  // the kart never sinks through (or floats over) the tilted road surface.
  const cx = pa.x + (pb.x - pa.x) * frac;
  const cz = pa.z + (pb.z - pa.z) * frac;
  const hlen = Math.hypot(sideN.x, sideN.z) || 1e-6;
  const lateral = ((x - cx) * sideN.x + (z - cz) * sideN.z) / hlen;
  const y = yCenter + lateral * (sideN.y / hlen);
  return { y, yCenter, up, tangent: t, sideNormal: sideN, index: i, dist: near.dist };
}
function projParam(pa, pb, x, z) {
  _segA.set(pa.x, 0, pa.z);
  _segB.set(pb.x, 0, pb.z);
  _segAB.subVectors(_segB, _segA);
  const lenSq = _segAB.x * _segAB.x + _segAB.z * _segAB.z;
  if (lenSq < 1e-6) return 0;
  const px = x - _segA.x, pz = z - _segA.z;
  return (px * _segAB.x + pz * _segAB.z) / lenSq;
}

// ───────────────────────────────────────────────────────────────────────────
// THREE scene scaffold — created ONCE; recoloured per track by applyTheme().
// ───────────────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  canvas: dom.canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9ad0e8, 200, 470);

const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1000);
camera.position.set(0, 12, 80);

// chase-camera zoom — mouse wheel (desktop) / pinch (touch). 1 = default.
let camZoom = 1;
addEventListener("wheel", (e) => {
  e.preventDefault();
  camZoom = Math.max(0.6, Math.min(2.6, camZoom * (e.deltaY > 0 ? 1.1 : 0.9)));
}, { passive: false });
let _pinchD = 0;
addEventListener("touchmove", (e) => {
  if (e.touches.length === 2) {
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    if (_pinchD) camZoom = Math.max(0.6, Math.min(2.6, camZoom * (_pinchD / d)));
    _pinchD = d;
    e.preventDefault();
  }
}, { passive: false });
addEventListener("touchend", () => { _pinchD = 0; });

// Gradient sky via a large back-faced sphere with a vertical-fade shader.
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    top: { value: new THREE.Color(0x2b6fb0) },
    mid: { value: new THREE.Color(0x9ad0e8) },
    bot: { value: new THREE.Color(0xf2e2bf) },
  },
  vertexShader: `
    varying vec3 vP;
    void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    varying vec3 vP;
    uniform vec3 top; uniform vec3 mid; uniform vec3 bot;
    void main(){
      float h = normalize(vP).y;
      vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0,0.55,h))
                       : mix(mid, bot, smoothstep(0.0,-0.25,h));
      gl_FragColor = vec4(c,1.0);
    }
  `,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(500, 24, 16), skyMat));

// Lighting: hemisphere fill + sun directional with soft shadow.
const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x4a5d3a, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4d6, 1.25);
sun.position.set(70, 120, 50);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 20;
sun.shadow.camera.far = 360;
const SH = 160;
sun.shadow.camera.left = -SH;
sun.shadow.camera.right = SH;
sun.shadow.camera.top = SH;
sun.shadow.camera.bottom = -SH;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);

// Deep backstop plane (recoloured per theme) — sits far below the followed
// terrain so nothing reads as void if you glimpse past the terrain edge.
const groundMat = new THREE.MeshLambertMaterial({ color: 0x3a5a2a });
const ground = new THREE.Mesh(new THREE.CircleGeometry(700, 48), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = BACKSTOP_Y;
scene.add(ground);

// Apply a track theme to the persistent scene objects (sky/fog/lights/ground).
function applyTheme(t) {
  skyMat.uniforms.top.value.setHex(t.sky[0]);
  skyMat.uniforms.mid.value.setHex(t.sky[1]);
  skyMat.uniforms.bot.value.setHex(t.sky[2]);
  scene.fog.color.setHex(t.fog[0]);
  scene.fog.near = t.fog[1];
  scene.fog.far = t.fog[2];
  scene.background = scene.fog.color.clone();
  hemi.color.setHex(t.hemi[0]);
  hemi.groundColor.setHex(t.hemi[1]);
  hemi.intensity = t.hemi[2];
  sun.color.setHex(t.sun[0]);
  sun.intensity = t.sun[1];
  sunOffset.set(t.sun[2], t.sun[3], t.sun[4]);
  groundMat.color.setHex(new THREE.Color(t.ground).multiplyScalar(0.65).getHex());
}

// ── Followed terrain ────────────────────────────────────────────────────────
// Gentle value-noise for distant rolling hills (deterministic — no Math.random).
function noise2(x, z) {
  return Math.sin(x * 0.045) * Math.cos(z * 0.05) * 2.4
    + Math.sin((x + z) * 0.028 + 1.3) * 1.6
    + Math.cos((x - z) * 0.06) * 0.8;
}
// Ground height at (x,z): hugs the track (road height minus a low berm) close
// in, then blends out to the rolling base. This is what makes hills appear
// UNDER elevated road instead of the road floating.
const TERR_NEAR = ROAD_HALF + CURB_W + 8;   // terrain stays at road level out to here
const TERR_FAR = TERR_NEAR + 46;            // ...then blends to base by here
function terrainHeightAt(x, z) {
  const near = nearestSample(x, z);
  const by = centerPts[near.index].y;
  const tB = THREE.MathUtils.smoothstep(near.dist, TERR_NEAR, TERR_FAR);
  return THREE.MathUtils.lerp(by - EMB, terrainBaseY + noise2(x, z), tB);
}
function buildTerrain(group, theme) {
  let xmn = Infinity, xmx = -Infinity, zmn = Infinity, zmx = -Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const p = centerPts[i];
    if (p.x < xmn) xmn = p.x; if (p.x > xmx) xmx = p.x;
    if (p.z < zmn) zmn = p.z; if (p.z > zmx) zmx = p.z;
  }
  const M = 170;
  xmn -= M; xmx += M; zmn -= M; zmx += M;
  const GX = 120, GZ = 120;
  const sx = (xmx - xmn) / GX, sz = (zmx - zmn) / GZ;
  const verts = (GX + 1) * (GZ + 1);
  const pos = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  const base = new THREE.Color(theme.ground);
  const dark = base.clone().multiplyScalar(0.62);
  const tmp = new THREE.Color();
  let vi = 0;
  for (let gz = 0; gz <= GZ; gz++) {
    for (let gx = 0; gx <= GX; gx++) {
      const x = xmn + gx * sx, z = zmn + gz * sz;
      // coarse nearest sample (every 3rd is plenty for terrain)
      let bd = Infinity, by = 0;
      for (let i = 0; i < SAMPLES; i += 3) {
        const p = centerPts[i];
        const dx = p.x - x, dz = p.z - z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; by = p.y; }
      }
      const dist = Math.sqrt(bd);
      const tB = THREE.MathUtils.smoothstep(dist, TERR_NEAR, TERR_FAR);
      const h = THREE.MathUtils.lerp(by - EMB, terrainBaseY + noise2(x, z), tB);
      pos[vi * 3] = x; pos[vi * 3 + 1] = h; pos[vi * 3 + 2] = z;
      tmp.copy(base).lerp(dark, THREE.MathUtils.clamp(tB * 0.7, 0, 1));
      col[vi * 3] = tmp.r; col[vi * 3 + 1] = tmp.g; col[vi * 3 + 2] = tmp.b;
      vi++;
    }
  }
  const idx = [];
  const W = GX + 1;
  for (let gz = 0; gz < GZ; gz++) {
    for (let gx = 0; gx < GX; gx++) {
      const a = gz * W + gx, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.receiveShadow = true;
  group.add(mesh);
}

// Build a rotation that aligns +Z to `forward` and +Y to `up`.
const _ox = new THREE.Vector3();
const _oy = new THREE.Vector3();
const _oz = new THREE.Vector3();
const _om = new THREE.Matrix4();
function orientMatrix(forward, up) {
  _oz.copy(forward).normalize();
  _ox.crossVectors(up, _oz).normalize();
  _oy.crossVectors(_oz, _ox).normalize();
  _om.makeBasis(_ox, _oy, _oz);
  return _om;
}

// ── Build the road ribbon + curbs + shoulders into `group` ──────────────────
const ROAD_LIFT = 0.06;
function edgeAt(i, lateral, lift) {
  const c = centerPts[i % SAMPLES];
  const sn = sideNormals[i % SAMPLES];
  const up = ups[i % SAMPLES];
  return new THREE.Vector3(
    c.x + sn.x * lateral + up.x * lift,
    c.y + sn.y * lateral + up.y * lift,
    c.z + sn.z * lateral + up.z * lift,
  );
}
function buildRoad(group, theme) {
  const left = [], right = [], curbL = [], curbR = [], shoulderL = [], shoulderR = [];
  for (let i = 0; i <= SAMPLES; i++) {
    left.push(edgeAt(i, ROAD_HALF, ROAD_LIFT));
    right.push(edgeAt(i, -ROAD_HALF, ROAD_LIFT));
    curbL.push(edgeAt(i, ROAD_HALF + CURB_W, ROAD_LIFT + 0.04));
    curbR.push(edgeAt(i, -(ROAD_HALF + CURB_W), ROAD_LIFT + 0.04));
    const sL = edgeAt(i, ROAD_HALF + CURB_W + 7, 0);
    const sR = edgeAt(i, -(ROAD_HALF + CURB_W + 7), 0);
    // skirt down to the terrain level beside the road (road height minus berm),
    // following the elevation so the road never shows a floating lip on hills.
    const berm = centerPts[i % SAMPLES].y - EMB;
    sL.y = berm; sR.y = berm;
    shoulderL.push(sL); shoulderR.push(sR);
  }

  // Road surface (true banked Y).
  const roadGeo = new THREE.BufferGeometry();
  const rv = [], ruv = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const a = left[i], b = right[i];
    rv.push(a.x, a.y, a.z, b.x, b.y, b.z);
    const v = i / SAMPLES;
    ruv.push(0, v, 1, v);
  }
  const ridx = [];
  for (let i = 0; i < SAMPLES; i++) {
    const o = i * 2;
    ridx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  }
  roadGeo.setAttribute("position", new THREE.Float32BufferAttribute(rv, 3));
  roadGeo.setAttribute("uv", new THREE.Float32BufferAttribute(ruv, 2));
  roadGeo.setIndex(ridx);
  roadGeo.computeVertexNormals();
  const road = new THREE.Mesh(roadGeo, new THREE.MeshLambertMaterial({ color: theme.road }));
  road.receiveShadow = true;
  group.add(road);

  // Center dashed line.
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xe8e8ec });
  const dashGeo = new THREE.PlaneGeometry(0.35, 3.2);
  const dashCount = 110;
  const dash = new THREE.InstancedMesh(dashGeo, dashMat, dashCount);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const dz = new THREE.Vector3();
  // lay the plane flat on the banked surface (its normal → surface up), length
  // along the tangent — same trick as the finish tiles.
  const lay = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  for (let d = 0; d < dashCount; d++) {
    const i = Math.floor((d / dashCount) * SAMPLES);
    const c = centerPts[i], t = tangents[i], up = ups[i];
    dz.copy(t).normalize();
    q.setFromRotationMatrix(orientMatrix(dz, up));
    q.multiply(lay);
    m.compose(
      new THREE.Vector3(c.x + up.x * (ROAD_LIFT + 0.02), c.y + up.y * (ROAD_LIFT + 0.02), c.z + up.z * (ROAD_LIFT + 0.02)),
      q, new THREE.Vector3(1, 1, 1),
    );
    dash.setMatrixAt(d, m);
  }
  dash.instanceMatrix.needsUpdate = true;
  group.add(dash);

  // Curbs: alternating stripes along both banked edges (theme colors).
  const cA = new THREE.Color(theme.curb[1]); // white-ish
  const cB = new THREE.Color(theme.curb[0]); // red/neon
  function curbRibbon(inner, outer, offsetParity) {
    const geo = new THREE.BufferGeometry();
    const pos = [], idx = [], colors = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const a = inner[i], b = outer[i];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      const col = Math.floor(i / 6) % 2 === offsetParity ? cB : cA;
      colors.push(col.r, col.g, col.b, col.r, col.g, col.b);
    }
    for (let i = 0; i < SAMPLES; i++) {
      const o = i * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = theme.neon
      ? new THREE.MeshBasicMaterial({ vertexColors: true })
      : new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = !theme.neon;
    group.add(mesh);
  }
  curbRibbon(left, curbL, 0);
  curbRibbon(right, curbR, 1);

  // Grass/sand/snow shoulders skirting each curb down to grade.
  const shoulderColor = new THREE.Color(theme.ground).multiplyScalar(0.9).getHex();
  function shoulderRibbon(top, bottom) {
    const geo = new THREE.BufferGeometry();
    const pos = [], idx = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const a = top[i], b = bottom[i];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    for (let i = 0; i < SAMPLES; i++) {
      const o = i * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: shoulderColor }));
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  shoulderRibbon(curbL, shoulderL);
  shoulderRibbon(curbR, shoulderR);

  return { left, right, curbL, curbR };
}

// ── Start/finish line: checkered band + gantry across the banked road ───────
function buildFinishLine(group, theme) {
  const c = centerPts[0], t = tangents[0], up = ups[0];
  const cols = 14;
  const tileW = (ROAD_HALF * 2) / cols;
  const tileL = 3.2;
  const matA = new THREE.MeshBasicMaterial({ color: 0xf4f4f6 });
  const matB = new THREE.MeshBasicMaterial({ color: 0x18181b });
  const baseQ = new THREE.Quaternion().setFromRotationMatrix(orientMatrix(t, up));
  const lay = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const tileGeo = new THREE.PlaneGeometry(tileW, tileL);
  for (let r = 0; r < 2; r++) {
    for (let col = 0; col < cols; col++) {
      const tile = new THREE.Mesh(tileGeo, (r + col) % 2 === 0 ? matA : matB);
      tile.quaternion.copy(baseQ).multiply(lay);
      const along = t.clone().multiplyScalar((r - 0.5) * tileL);
      const lateral = ROAD_HALF - tileW * (col + 0.5);
      const p = edgeAt(0, lateral, ROAD_LIFT + 0.04);
      tile.position.set(p.x + along.x, p.y, p.z + along.z);
      group.add(tile);
    }
  }

  // Gantry: two posts + a banner over the line.
  const postMat = new THREE.MeshLambertMaterial({ color: theme.neon ? 0x16161e : 0x27272a });
  const bannerMat = theme.neon
    ? new THREE.MeshBasicMaterial({ color: theme.curb[1] })
    : new THREE.MeshLambertMaterial({ color: 0xf59e0b });
  for (const s of [1, -1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 9, 0.7), postMat);
    const base = edgeAt(0, s * (ROAD_HALF + 0.6), ROAD_LIFT);
    post.position.set(base.x, base.y + 4.5, base.z);
    post.castShadow = true;
    group.add(post);
  }
  const banner = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2 + 1.6, 1.8, 0.5), bannerMat);
  banner.position.set(c.x, c.y + 9, c.z);
  banner.rotation.y = Math.atan2(finishForward.x, finishForward.z);
  banner.castShadow = true;
  group.add(banner);
}

// ── Checkpoint gates ────────────────────────────────────────────────────────
const CP_COLOR_NEXT = new THREE.Color(0xfbbf24); // gold — go here next
const CP_COLOR_DONE = new THREE.Color(0x34d399); // green — passed
const CP_COLOR_IDLE = new THREE.Color(0x4b5563); // dim — not yet

function buildCheckpointGates(group) {
  const dimMat = () => new THREE.MeshBasicMaterial({ color: 0x4b5563, transparent: true, opacity: 0.55 });
  const GATE_H = 6.2;
  const HALF_W = ROAD_HALF + 0.5;
  const postGeo = new THREE.CylinderGeometry(0.22, 0.22, GATE_H, 8);
  const barGeo = new THREE.BoxGeometry(HALF_W * 2, 0.45, 0.45);
  for (const cp of checkpoints) {
    // Build the gate in the road's LOCAL frame (x = across, y = surface-up,
    // z = forward), then orient the whole group to the banked surface. This
    // keeps the posts on the edges and the bar spanning their tops even on
    // banked / curved checkpoints (the old world-axis build skewed there).
    const g = new THREE.Group();
    const matA = dimMat(), matB = dimMat(), barMat = dimMat();
    cp.mats = [matA, matB, barMat];
    const postA = new THREE.Mesh(postGeo, matA); postA.position.set(HALF_W, GATE_H / 2, 0); g.add(postA);
    const postB = new THREE.Mesh(postGeo, matB); postB.position.set(-HALF_W, GATE_H / 2, 0); g.add(postB);
    const bar = new THREE.Mesh(barGeo, barMat); bar.position.set(0, GATE_H, 0); g.add(bar);
    const c = centerPts[cp.index], up = ups[cp.index], t = tangents[cp.index];
    g.position.set(c.x + up.x * ROAD_LIFT, c.y + up.y * ROAD_LIFT, c.z + up.z * ROAD_LIFT);
    g.quaternion.setFromRotationMatrix(orientMatrix(t, up));
    cp.group = g;
    group.add(g);
  }
  refreshCheckpointVisuals();
}

function refreshCheckpointVisuals() {
  for (let k = 0; k < checkpoints.length; k++) {
    const cp = checkpoints[k];
    if (!cp.mats) continue;
    let color, opacity;
    if (k === lap.nextCheckpoint && raceStarted) { color = CP_COLOR_NEXT; opacity = 0.95; }
    else if (k < lap.nextCheckpoint) { color = CP_COLOR_DONE; opacity = 0.45; }
    else { color = CP_COLOR_IDLE; opacity = 0.55; }
    for (const mat of cp.mats) { mat.color.copy(color); mat.opacity = opacity; }
  }
}

function signedCheckpointDist(cp, x, z) {
  const dx = x - cp.center.x, dz = z - cp.center.z;
  return dx * cp.forward.x + dz * cp.forward.z;
}
function nearCheckpoint(cp, x, z) {
  const dx = x - cp.center.x, dz = z - cp.center.z;
  const lateral = dx * cp.normal.x + dz * cp.normal.z;
  return Math.abs(lateral) < ROAD_HALF + 2;
}

// ── Scenery (biome-specific) into `group` ──────────────────────────────────
function finishNormalAt(i) {
  const t = tangents[i % SAMPLES];
  return new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), t).normalize();
}
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// scatter `count` props in a ring around the track, skipping near the road.
function scatter(count, rng, place, minRad = 95, maxRad = 320) {
  let placed = 0, guard = 0;
  while (placed < count && guard++ < 6000) {
    const ang = rng() * Math.PI * 2;
    const rad = minRad + rng() * (maxRad - minRad);
    const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
    if (nearestSample(x, z).dist < ROAD_HALF + 14) continue;
    place(x, z, placed, rng);
    placed++;
  }
  return placed;
}

function addScenery(group, theme) {
  const rng = mulberry32(hashStr(curTrack.id) || 1337);

  // Cones along both curbs (instanced) — theme-tinted.
  const coneGeo = new THREE.ConeGeometry(0.5, 1.3, 8);
  const coneMat = theme.neon
    ? new THREE.MeshBasicMaterial({ color: theme.cone })
    : new THREE.MeshLambertMaterial({ color: theme.cone });
  const coneCount = 60;
  const cones = new THREE.InstancedMesh(coneGeo, coneMat, coneCount);
  cones.castShadow = !theme.neon;
  const m = new THREE.Matrix4();
  for (let k = 0; k < coneCount; k++) {
    const i = Math.floor((k / coneCount) * SAMPLES);
    const edge = k % 2 === 0 ? trackEdges.curbL[i] : trackEdges.curbR[i];
    const off = (k % 2 === 0 ? 1 : -1) * 1.1;
    const n = finishNormalAt(i).multiplyScalar(off);
    m.makeTranslation(edge.x + n.x, edge.y + 0.65, edge.z + n.z);
    cones.setMatrixAt(k, m);
  }
  cones.instanceMatrix.needsUpdate = true;
  group.add(cones);

  if (theme.scenery === "trees" || theme.scenery === "stands") {
    addTrees(group, rng, theme.scenery === "stands" ? 40 : 70);
  } else if (theme.scenery === "cacti") {
    addCacti(group, rng);
  } else if (theme.scenery === "pines") {
    addPines(group, rng);
  } else if (theme.scenery === "pylons") {
    addPylons(group, rng, theme);
  }

  if (theme.stands) addGrandstands(group, theme);
}

function addTrees(group, rng, treeCount) {
  const trunkGeo = new THREE.CylinderGeometry(0.4, 0.55, 2.6, 6);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2b });
  const leafGeo = new THREE.IcosahedronGeometry(2.2, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshLambertMaterial({ color: 0x3f7d33 }), treeCount);
  trunks.castShadow = true; leaves.castShadow = true;
  const leafColors = [0x3f7d33, 0x4f9a3f, 0x357a2e, 0x68a84a];
  const mt = new THREE.Matrix4(), ml = new THREE.Matrix4();
  const n = scatter(treeCount, rng, (x, z, p, r) => {
    const s = 0.7 + r() * 0.9;
    const gy = terrainHeightAt(x, z);
    mt.compose(new THREE.Vector3(x, gy + 1.3 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    trunks.setMatrixAt(p, mt);
    ml.compose(new THREE.Vector3(x, gy + 4.2 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    leaves.setMatrixAt(p, ml);
    leaves.setColorAt(p, new THREE.Color(leafColors[p % leafColors.length]));
  });
  trunks.count = n; leaves.count = n;
  trunks.instanceMatrix.needsUpdate = true; leaves.instanceMatrix.needsUpdate = true;
  if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  group.add(trunks, leaves);
}

function addCacti(group, rng) {
  const count = 55;
  const bodyGeo = new THREE.CylinderGeometry(0.5, 0.6, 4.2, 8);
  const armGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.6, 6);
  const cactusMat = new THREE.MeshLambertMaterial({ color: 0x3f7d4a });
  const bodies = new THREE.InstancedMesh(bodyGeo, cactusMat, count);
  const arms = new THREE.InstancedMesh(armGeo, cactusMat, count);
  bodies.castShadow = true; arms.castShadow = true;
  const rockGeo = new THREE.DodecahedronGeometry(1.4, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ color: 0x8a7a5e }), count);
  rocks.castShadow = true;
  const mm = new THREE.Matrix4();
  const nC = scatter(count, rng, (x, z, p, r) => {
    const s = 0.8 + r() * 0.8;
    const gy = terrainHeightAt(x, z);
    mm.compose(new THREE.Vector3(x, gy + 2.1 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    bodies.setMatrixAt(p, mm);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (r() < 0.5 ? 1 : -1) * 0.9);
    mm.compose(new THREE.Vector3(x + (r() < 0.5 ? 0.7 : -0.7) * s, gy + 2.6 * s, z), q, new THREE.Vector3(s, s, s));
    arms.setMatrixAt(p, mm);
  });
  bodies.count = nC; arms.count = nC;
  bodies.instanceMatrix.needsUpdate = true; arms.instanceMatrix.needsUpdate = true;
  const nR = scatter(count, rng, (x, z, p, r) => {
    const s = 0.5 + r() * 1.2;
    const gy = terrainHeightAt(x, z);
    mm.compose(new THREE.Vector3(x, gy + 0.4 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s * 0.7, s));
    rocks.setMatrixAt(p, mm);
  }, 80, 330);
  rocks.count = nR; rocks.instanceMatrix.needsUpdate = true;
  group.add(bodies, arms, rocks);
}

function addPines(group, rng) {
  const count = 65;
  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 2.2, 6);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a3f28 });
  const coneGeo = new THREE.ConeGeometry(2.0, 4.5, 7);
  const pineMat = new THREE.MeshLambertMaterial({ color: 0x2f6b46 });
  const capGeo = new THREE.ConeGeometry(1.1, 1.6, 7);
  const capMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  const pines = new THREE.InstancedMesh(coneGeo, pineMat, count);
  const caps = new THREE.InstancedMesh(capGeo, capMat, count);
  trunks.castShadow = true; pines.castShadow = true;
  const mm = new THREE.Matrix4();
  const n = scatter(count, rng, (x, z, p, r) => {
    const s = 0.8 + r() * 0.9;
    const gy = terrainHeightAt(x, z);
    mm.compose(new THREE.Vector3(x, gy + 1.1 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    trunks.setMatrixAt(p, mm);
    mm.compose(new THREE.Vector3(x, gy + 4.3 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    pines.setMatrixAt(p, mm);
    mm.compose(new THREE.Vector3(x, gy + 6.2 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    caps.setMatrixAt(p, mm);
  });
  trunks.count = n; pines.count = n; caps.count = n;
  trunks.instanceMatrix.needsUpdate = true; pines.instanceMatrix.needsUpdate = true; caps.instanceMatrix.needsUpdate = true;
  group.add(trunks, pines, caps);
}

function addPylons(group, rng, theme) {
  // glowing roadside pylons + a few dark skyscraper blocks with emissive tops
  const count = 50;
  const pyGeo = new THREE.CylinderGeometry(0.3, 0.4, 7, 6);
  const pyMat = new THREE.MeshBasicMaterial({ color: theme.cone });
  const pylons = new THREE.InstancedMesh(pyGeo, pyMat, count);
  const mm = new THREE.Matrix4();
  const n = scatter(count, rng, (x, z, p) => {
    mm.makeTranslation(x, terrainHeightAt(x, z) + 3.5, z);
    pylons.setMatrixAt(p, mm);
  });
  pylons.count = n; pylons.instanceMatrix.needsUpdate = true;
  group.add(pylons);

  // skyline buildings
  const bCount = 26;
  const bGeo = new THREE.BoxGeometry(1, 1, 1);
  const bMat = new THREE.MeshLambertMaterial({ color: 0x101018 });
  const buildings = new THREE.InstancedMesh(bGeo, bMat, bCount);
  const tops = new THREE.InstancedMesh(bGeo, new THREE.MeshBasicMaterial({ color: theme.curb[0] }), bCount);
  const topColors = [theme.curb[0], theme.curb[1], 0xa855f7];
  buildings.castShadow = true;
  const nb = scatter(bCount, rng, (x, z, p, r) => {
    const w = 8 + r() * 10, h = 18 + r() * 44, d = 8 + r() * 10;
    const gy = terrainHeightAt(x, z);
    mm.compose(new THREE.Vector3(x, gy + h / 2, z), new THREE.Quaternion(), new THREE.Vector3(w, h, d));
    buildings.setMatrixAt(p, mm);
    mm.compose(new THREE.Vector3(x, gy + h + 0.4, z), new THREE.Quaternion(), new THREE.Vector3(w * 0.5, 0.8, d * 0.5));
    tops.setMatrixAt(p, mm);
    tops.setColorAt(p, new THREE.Color(topColors[p % topColors.length]));
  }, 130, 360);
  buildings.count = nb; tops.count = nb;
  buildings.instanceMatrix.needsUpdate = true; tops.instanceMatrix.needsUpdate = true;
  if (tops.instanceColor) tops.instanceColor.needsUpdate = true;
  group.add(buildings, tops);
}

function addGrandstands(group, theme) {
  const standMat = new THREE.MeshLambertMaterial({ color: 0x3b3b44 });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xf59e0b });
  for (const spot of [80, 360]) {
    const i = spot % SAMPLES;
    const c = centerPts[i];
    const n = finishNormalAt(i).multiplyScalar(ROAD_HALF + 12);
    const gy = terrainHeightAt(c.x + n.x, c.z + n.z);
    const base = new THREE.Mesh(new THREE.BoxGeometry(18, 4, 7), standMat);
    base.position.set(c.x + n.x, gy + 2, c.z + n.z);
    base.lookAt(c.x, gy + 2, c.z);
    base.castShadow = true; base.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(18.5, 0.5, 7.5), roofMat);
    roof.position.set(c.x + n.x, gy + 4.6, c.z + n.z);
    roof.lookAt(c.x, gy + 4.6, c.z);
    group.add(base, roof);
  }
}

// ── Orchestrator: (re)build the whole track world for TRACKS[index] ─────────
const T = { index: -1, group: null, built: false };
function disposeGroup(g) {
  g.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) {
      o.geometry?.dispose?.();
      const mat = o.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    }
  });
}
function buildTrackWorld(index) {
  computeTrackGeometry(index);
  T.index = ((index % TRACKS.length) + TRACKS.length) % TRACKS.length;
  if (T.group) { scene.remove(T.group); disposeGroup(T.group); }
  const group = new THREE.Group();
  applyTheme(curTrack.theme);
  buildTerrain(group, curTrack.theme);
  trackEdges = buildRoad(group, curTrack.theme);
  buildFinishLine(group, curTrack.theme);
  buildCheckpointGates(group);
  addScenery(group, curTrack.theme);
  scene.add(group);
  T.group = group; T.built = true;
}

// Spawn slightly behind the finish line, facing along the track direction.
function spawnPlayerAtStart() {
  const back = finishForward.clone().multiplyScalar(-6);
  player.pos.set(finishCenter.x + back.x, finishCenter.y, finishCenter.z + back.z);
  player.heading = Math.atan2(finishForward.x, finishForward.z);
  player.vel = 0; player.vx = 0; player.vz = 0; player.slip = 0;
  player.drift = false;
  player.lateral = 0;
  const sf = surfaceAt(player.pos.x, player.pos.z);
  player.surfaceY = sf.y;
  player.surfaceUp.copy(sf.up);
  if (player.mesh) player.mesh.position.set(player.pos.x, player.surfaceY, player.pos.z);
}

// ───────────────────────────────────────────────────────────────────────────
// KART mesh — built from boxes. Reused for self + remotes; color-tinted.
// ───────────────────────────────────────────────────────────────────────────
function makeKart(colorHex) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: colorHex });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x18181b });
  const tireMat = new THREE.MeshLambertMaterial({ color: 0x0e0e10 });
  const rimMat = new THREE.MeshLambertMaterial({ color: 0xd4d4d8 });
  const trimMat = new THREE.MeshLambertMaterial({ color: 0xfafafa });
  const skinMat = new THREE.MeshLambertMaterial({ color: 0xf1c9a5 });
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    group.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(1.4, 0.16, 2.7), darkMat, 0, 0.34, 0);
  add(new THREE.BoxGeometry(1.35, 0.42, 1.7), bodyMat, 0, 0.6, -0.1);
  add(new THREE.BoxGeometry(0.34, 0.4, 1.4), bodyMat, 0.88, 0.55, 0);
  add(new THREE.BoxGeometry(0.34, 0.4, 1.4), bodyMat, -0.88, 0.55, 0);
  add(new THREE.BoxGeometry(1.1, 0.3, 1.2), bodyMat, 0, 0.5, 1.35);
  add(new THREE.BoxGeometry(1.6, 0.08, 0.45), trimMat, 0, 0.38, 1.95);
  add(new THREE.BoxGeometry(0.85, 0.34, 0.95), darkMat, 0, 0.8, 0);
  add(new THREE.BoxGeometry(0.5, 0.46, 0.46), trimMat, 0, 1.0, -0.1);
  add(new THREE.SphereGeometry(0.18, 12, 10), skinMat, 0, 1.32, -0.05);
  add(new THREE.SphereGeometry(0.24, 16, 12), bodyMat, 0, 1.4, -0.1);
  add(new THREE.BoxGeometry(0.4, 0.1, 0.06), darkMat, 0, 1.42, 0.14);
  const sw = add(new THREE.TorusGeometry(0.16, 0.035, 8, 16), darkMat, 0, 0.98, 0.42);
  sw.rotation.x = Math.PI / 2.4;
  add(new THREE.BoxGeometry(0.8, 0.55, 0.2), bodyMat, 0, 1.3, -0.75);
  add(new THREE.BoxGeometry(1.85, 0.1, 0.5), trimMat, 0, 1.25, -1.45);
  for (const s of [0.66, -0.66]) add(new THREE.BoxGeometry(0.1, 0.5, 0.1), darkMat, s, 1.0, -1.45);
  for (const s of [0.22, -0.22]) {
    const e = add(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 8), rimMat, s, 0.5, -1.5);
    e.rotation.x = Math.PI / 2;
  }
  const tireGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.4, 16);
  const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.42, 8);
  const wheels = [];
  const wx = 0.9, wz = 1.02;
  for (const [sx, sz] of [[wx, wz], [-wx, wz], [wx, -wz], [-wx, -wz]]) {
    const w = new THREE.Group();
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    w.add(tire);
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.z = Math.PI / 2;
    rim.position.x = sx > 0 ? 0.04 : -0.04;
    w.add(rim);
    w.position.set(sx, 0.46, sz);
    group.add(w);
    wheels.push(w);
  }
  group.userData.bodyMat = bodyMat;
  group.userData.frontWheels = [wheels[0], wheels[1]];
  group.userData.allWheels = wheels;
  return group;
}

// Name label as a sprite (canvas texture).
function makeLabel(text) {
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d");
  const font = "600 40px 'Space Grotesk', system-ui, sans-serif";
  ctx.font = font;
  const padX = 24;
  const w = Math.min(420, Math.ceil(ctx.measureText(text).width) + padX * 2);
  cv.width = w;
  cv.height = 72;
  ctx.font = font;
  ctx.fillStyle = "rgba(9,9,11,0.78)";
  roundRect(ctx, 0, 0, cv.width, cv.height, 16);
  ctx.fill();
  ctx.fillStyle = "#fde68a";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cv.width / 2, cv.height / 2 + 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false });
  const sprite = new THREE.Sprite(mat);
  const aspect = cv.width / cv.height;
  const LABEL_H = 1 / 20;
  sprite.userData.baseW = LABEL_H * aspect;
  sprite.userData.baseH = LABEL_H;
  sprite.scale.set(LABEL_H * aspect, LABEL_H, 1);
  sprite.position.y = 2.5;
  sprite.renderOrder = 10;
  return sprite;
}
function honkOver(mesh) {
  if (!mesh) return;
  const s = makeLabel("honk! 📣");
  s.position.y = 3.7;
  mesh.add(s);
  setTimeout(() => { mesh.remove(s); s.material.map?.dispose(); s.material.dispose(); }, 1100);
}
const _lblV = new THREE.Vector3();
function scaleLabel(sprite) {
  if (!sprite || !sprite.userData.baseW) return;
  const d = camera.position.distanceTo(sprite.getWorldPosition(_lblV));
  const f = Math.max(0.5, Math.min(2.4, d / 26));
  sprite.scale.set(sprite.userData.baseW * f, sprite.userData.baseH * f, 1);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ───────────────────────────────────────────────────────────────────────────
// SELF kart + arcade physics
// ───────────────────────────────────────────────────────────────────────────
const player = {
  pos: new THREE.Vector3(0, 0, 0),
  heading: 0,        // facing direction (radians, 0 = +Z)
  vx: 0, vz: 0,      // world velocity vector
  vel: 0,            // forward speed (V·heading) — for HUD / network / wheel spin
  slip: 0,           // lateral speed (V·right) — drives the drift lean + skid marks
  drift: false,      // currently sliding (handbrake or big slip)
  lateral: 0,        // smoothed visual lean
  surfaceY: 0,
  surfaceUp: new THREE.Vector3(0, 1, 0),
  mesh: null,
  label: null,
};

// Arcade drift model: a velocity VECTOR with grip. Lateral velocity is bled off
// fast when gripping and slowly while drifting, so the kart slides through
// corners on the handbrake. Punchy top speed + acceleration.
const PHYS = {
  accel: 46,             // throttle force (units/s²)
  brake: 60,             // braking decel
  reverseAccel: 20,
  maxSpeed: 66,          // top speed
  maxReverse: -18,
  engineBrake: 7,        // coast slowdown when off the gas
  turn: 2.9,             // base yaw rate (rad/s)
  turnSpeedFalloff: 0.5, // steering tightens less at speed than before
  gripNormal: 8.5,       // lateral grip (higher = sticks to the line)
  gripDrift: 2.0,        // lateral grip while handbraking (slides)
  driftSteerBoost: 1.3,  // extra yaw authority mid-drift
  driftScrub: 0.28,      // forward speed scrubbed per sec while drifting
  cornerSlip: 0.78,      // grip kept when cornering hard at speed (natural slide)
  offRoadDrag: 34,
  offRoadMax: 30,
  gravityFeel: 18,
};

function makeSelfKart() {
  player.mesh = makeKart(me.color);
  player.label = makeLabel(me.name + " (you)");
  player.mesh.add(player.label);
  scene.add(player.mesh);
}

// ── Skid marks — a pooled InstancedMesh stamped under the rear wheels while
// drifting. Ring buffer so it never grows; cleared on each new round.
const SKID_MAX = 260;
let skidMesh = null, skidIdx = 0, lastSkidAt = 0;
const _skidM = new THREE.Matrix4();
const _skidQ = new THREE.Quaternion();
const _skidLay = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
function initSkid() {
  skidMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.5, 1.3),
    new THREE.MeshBasicMaterial({ color: 0x0b0b0d, transparent: true, opacity: 0.34, depthWrite: false }),
    SKID_MAX,
  );
  skidMesh.frustumCulled = false;
  clearSkid();
  scene.add(skidMesh);
}
function clearSkid() {
  if (!skidMesh) return;
  for (let i = 0; i < SKID_MAX; i++) skidMesh.setMatrixAt(i, _zero);
  skidMesh.instanceMatrix.needsUpdate = true;
  skidIdx = 0;
}
function stampSkid(now) {
  if (!skidMesh || now - lastSkidAt < 36) return;
  lastSkidAt = now;
  const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
  const sf = surfaceAt(player.pos.x, player.pos.z);
  _skidQ.setFromRotationMatrix(orientMatrix(_kfwd.set(fx, 0, fz), sf.up));
  _skidQ.multiply(_skidLay);
  for (const side of [-1, 1]) {
    const ox = fz * side * 0.78, oz = -fx * side * 0.78; // across the rear axle
    const bx = player.pos.x - fx * 0.95 + ox;
    const bz = player.pos.z - fz * 0.95 + oz;
    _skidM.compose(new THREE.Vector3(bx, sf.y + 0.06, bz), _skidQ, new THREE.Vector3(1, 1, 1));
    skidMesh.setMatrixAt(skidIdx, _skidM);
    skidIdx = (skidIdx + 1) % SKID_MAX;
  }
  skidMesh.instanceMatrix.needsUpdate = true;
}

// ── Remote karts (keyed by HANDLE → one kart per player) ────────────────────
const remotes = new Map();

function ensureRemote(handle, name, colorHex, cid) {
  let r = remotes.get(handle);
  if (!r) {
    const mesh = makeKart(colorHex);
    const label = makeLabel(name);
    mesh.add(label);
    scene.add(mesh);
    r = {
      mesh, label, name, color: colorHex, cid: cid || null,
      cur: new THREE.Vector3(), target: new THREE.Vector3(),
      surfaceY: 0, surfaceUp: new THREE.Vector3(0, 1, 0),
      curHeading: 0, targetHeading: 0, speed: 0, at: performance.now(), init: false,
    };
    remotes.set(handle, r);
  }
  return r;
}
function setRemoteLabel(r, text) {
  if (r.label) {
    r.mesh.remove(r.label);
    r.label.material.map?.dispose();
    r.label.material.dispose();
  }
  const label = makeLabel(text);
  r.mesh.add(label);
  r.label = label;
}
function removeRemote(handle) {
  const r = remotes.get(handle);
  if (!r) return;
  scene.remove(r.mesh);
  r.label?.material.map?.dispose();
  remotes.delete(handle);
}

// ───────────────────────────────────────────────────────────────────────────
// INPUT — keyboard + on-screen touch buttons
// ───────────────────────────────────────────────────────────────────────────
const input = { up: false, down: false, left: false, right: false, hand: false };
const KEYMAP = {
  ArrowUp: "up", w: "up", W: "up",
  ArrowDown: "down", s: "down", S: "down",
  ArrowLeft: "left", a: "left", A: "left",
  ArrowRight: "right", d: "right", D: "right",
  " ": "hand", Shift: "hand",
};
addEventListener("keydown", (e) => {
  if (e.key === "h" || e.key === "H") { honk(); return; }
  const k = KEYMAP[e.key];
  if (k) { input[k] = true; e.preventDefault(); }
}, { passive: false });
addEventListener("keyup", (e) => {
  const k = KEYMAP[e.key];
  if (k) { input[k] = false; e.preventDefault(); }
}, { passive: false });
function releaseAll() { input.up = input.down = input.left = input.right = input.hand = false; }
addEventListener("blur", releaseAll);
document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAll(); });

const isTouch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
if (isTouch) document.body.classList.add("touch");
function bindHold(el, key) {
  if (!el) return;
  const on = (e) => { e.preventDefault(); input[key] = true; el.classList.add("held"); };
  const off = (e) => { if (e) e.preventDefault(); input[key] = false; el.classList.remove("held"); };
  el.addEventListener("pointerdown", on);
  el.addEventListener("pointerup", off);
  el.addEventListener("pointercancel", off);
  el.addEventListener("pointerleave", off);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}
bindHold(dom.touch.left, "left");
bindHold(dom.touch.right, "right");
bindHold(dom.touch.gas, "up");
bindHold(dom.touch.brake, "down");
bindHold(dom.touch.drift, "hand");

// ── OFF-ROAD / COLLISIONS ───────────────────────────────────────────────────
function offRoadAmount(x, z) {
  const near = nearestSample(x, z);
  return Math.max(0, near.dist - (ROAD_HALF + CURB_W * 0.6));
}
// "Soft wall" at the road edge: ease the kart back in and SLIDE along the wall —
// cancel only the outward velocity, keep the tangential part (with light
// friction) so a clip scrubs a little speed instead of dead-stopping you.
const WALL_LIMIT = ROAD_HALF + CURB_W + 0.9;
const WALL_PUSH = 0.5;
function resolveTrackWall() {
  const near = nearestSample(player.pos.x, player.pos.z);
  const c = centerPts[near.index];
  let ox = player.pos.x - c.x, oz = player.pos.z - c.z;
  const dist = Math.hypot(ox, oz);
  if (dist < WALL_LIMIT || dist < 1e-4) return;
  ox /= dist; oz /= dist;
  const overshoot = dist - WALL_LIMIT;
  player.pos.x -= ox * overshoot * WALL_PUSH;
  player.pos.z -= oz * overshoot * WALL_PUSH;
  const vDotN = player.vx * ox + player.vz * oz; // outward speed
  if (vDotN > 0) {
    player.vx -= ox * vDotN;       // remove the into-wall component (slide, no bounce)
    player.vz -= oz * vDotN;
    player.vx *= 0.94; player.vz *= 0.94; // mild scrub along the wall
  }
}
// Kart-to-kart: separate the local kart and BOUNCE both velocities apart. Each
// client resolves itself against peers' last poses, so a head-on bumps both.
const KART_RADIUS = 1.1;
const KART_MIN_DIST = KART_RADIUS * 2;
function resolveKartCollisions() {
  for (const r of remotes.values()) {
    if (!r.init) continue;
    let dx = player.pos.x - r.cur.x, dz = player.pos.z - r.cur.z;
    const dist = Math.hypot(dx, dz);
    if (dist >= KART_MIN_DIST) continue;
    let nx, nz;
    if (dist < 1e-4) { nx = Math.sin(player.heading); nz = Math.cos(player.heading); }
    else { nx = dx / dist; nz = dz / dist; }
    const overlap = KART_MIN_DIST - dist;
    player.pos.x += nx * overlap; player.pos.z += nz * overlap;
    // reflect the closing velocity off the contact normal + a knockback shove
    const vDotN = player.vx * nx + player.vz * nz;
    if (vDotN < 0) { player.vx -= nx * vDotN * 1.6; player.vz -= nz * vDotN * 1.6; }
    player.vx += nx * 6; player.vz += nz * 6;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// LAP detection
// ───────────────────────────────────────────────────────────────────────────
let raceStarted = false;
const lap = {
  count: 0,
  startMs: 0,
  bestMs: null,
  lastMs: null,
  prevSide: null,
  armed: false,
  wrongWay: false,
  nextCheckpoint: 0,
  prevCpSide: null,
};

function signedFinishDist(x, z) {
  const dx = x - finishCenter.x, dz = z - finishCenter.z;
  return dx * finishForward.x + dz * finishForward.z;
}
function nearFinishLine(x, z) {
  const dx = x - finishCenter.x, dz = z - finishCenter.z;
  const lateral = dx * finishNormal.x + dz * finishNormal.z;
  return Math.abs(lateral) < ROAD_HALF + 2;
}

function onCrossFinish(forward, now) {
  if (!raceStarted) return;
  if (!forward) { toast("↺ turn around"); return; }
  const allChecked = lap.nextCheckpoint >= checkpoints.length;
  if (lap.count > 0 && !allChecked) {
    toast("⚑ missed checkpoints · lap not counted");
    return;
  }
  if (lap.count > 0) {
    const ms = now - lap.startMs;
    lap.lastMs = ms;
    if (lap.bestMs == null || ms < lap.bestMs) {
      lap.bestMs = ms;
      dom.last.textContent = "last " + fmtTime(ms) + "  ★ best!";
      dom.last.classList.add("good");
      saveBest(ms);
      toast("🏁 new best · " + fmtTime(ms));
    } else {
      dom.last.textContent = "last " + fmtTime(ms);
      dom.last.classList.remove("good");
      toast("lap " + lap.count + " · " + fmtTime(ms));
    }
  }
  lap.count++;
  lap.startMs = now;
  lap.nextCheckpoint = 0;
  lap.prevCpSide = null;
  refreshCheckpointVisuals();
  updateHud();
}

// ───────────────────────────────────────────────────────────────────────────
// GAME LOOP
// ───────────────────────────────────────────────────────────────────────────
let lastFrame = performance.now();
const tmpCamPos = new THREE.Vector3();
const tmpLook = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _kfwd = new THREE.Vector3();
const _kquat = new THREE.Quaternion();
const _kquat2 = new THREE.Quaternion();
const _keuler = new THREE.Euler();

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (T.built) {
    stepPhysics(dt, now);
    stepRemotes(dt);
    updateCamera(dt);
    maybeSendPose(now);
    pruneRemotes(now);
    updateLiveTimer(now);
    tickRoundClock(now);
    scaleLabel(player.label);
    for (const r of remotes.values()) scaleLabel(r.label);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function stepPhysics(dt, now) {
  const throttling = !preRace && input.up;
  const braking = !preRace && input.down;

  // forward (heading) + right axes
  let fx = Math.sin(player.heading), fz = Math.cos(player.heading);
  const rx = fz, rz = -fx;

  // decompose world velocity into forward + lateral components
  let fwd = player.vx * fx + player.vz * fz;
  let lat = player.vx * rx + player.vz * rz;

  if (preRace) {
    fwd *= Math.max(0, 1 - 4 * dt);
    lat *= Math.max(0, 1 - 6 * dt);
  } else if (throttling) {
    fwd += PHYS.accel * dt;
  } else if (braking) {
    if (fwd > 0.5) fwd -= PHYS.brake * dt;
    else fwd -= PHYS.reverseAccel * dt;
  } else {
    const f = PHYS.engineBrake * dt;
    if (fwd > 0) fwd = Math.max(0, fwd - f);
    else if (fwd < 0) fwd = Math.min(0, fwd + f);
  }

  // off-road: heavy slow + low cap
  const off = offRoadAmount(player.pos.x, player.pos.z);
  const onGrass = off > 0;
  if (onGrass) {
    if (fwd > PHYS.offRoadMax) fwd -= PHYS.offRoadDrag * dt;
    if (fwd < -PHYS.offRoadMax) fwd += PHYS.offRoadDrag * dt;
    fwd = THREE.MathUtils.clamp(fwd, -PHYS.offRoadMax, PHYS.offRoadMax);
  }
  fwd = THREE.MathUtils.clamp(fwd, PHYS.maxReverse, PHYS.maxSpeed);

  // steering — yaw the heading; handbrake adds authority for big drifts
  const steer = preRace ? 0 : (input.left ? 1 : 0) - (input.right ? 1 : 0);
  const speedFrac = Math.min(1, Math.abs(fwd) / PHYS.maxSpeed);
  const handbrake = !preRace && input.hand && Math.abs(fwd) > 3;
  const turnScale = 1 - PHYS.turnSpeedFalloff * speedFrac;
  const motionGate = Math.min(1, Math.abs(fwd) / 5);
  const dir = fwd >= 0 ? 1 : -1;
  let yaw = steer * PHYS.turn * turnScale * motionGate * dir;
  if (handbrake) yaw *= PHYS.driftSteerBoost;
  player.heading += yaw * dt;

  // grip: bleed lateral velocity. Handbrake (or hard cornering at speed) lowers
  // grip so the kart slides — that's the drift.
  let grip = handbrake ? PHYS.gripDrift : PHYS.gripNormal;
  if (onGrass) grip *= 0.55;
  else if (!handbrake && steer !== 0 && speedFrac > 0.6) grip *= PHYS.cornerSlip;
  lat *= Math.exp(-grip * dt);
  if (handbrake) fwd *= Math.max(0, 1 - PHYS.driftScrub * dt);

  // slope feel along the (new) heading
  fx = Math.sin(player.heading); fz = Math.cos(player.heading);
  {
    const STEP = 3;
    const aheadY = surfaceAt(player.pos.x + fx * STEP, player.pos.z + fz * STEP).yCenter;
    const behindY = surfaceAt(player.pos.x - fx * STEP, player.pos.z - fz * STEP).yCenter;
    const grade = (behindY - aheadY) / (2 * STEP);
    fwd += THREE.MathUtils.clamp(grade, -0.6, 0.6) * PHYS.gravityFeel * dt;
  }

  // recompose world velocity from forward + lateral on the new heading
  const nrx = fz, nrz = -fx;
  player.vx = fx * fwd + nrx * lat;
  player.vz = fz * fwd + nrz * lat;

  // integrate, then resolve walls + karts on the velocity vector
  player.pos.x += player.vx * dt;
  player.pos.z += player.vz * dt;
  resolveTrackWall();
  resolveKartCollisions();

  // derive forward speed (post-collision) for HUD / network / spin
  player.vel = player.vx * fx + player.vz * fz;
  player.slip = lat;
  player.drift = handbrake || Math.abs(lat) > 7;

  // skid marks while sliding on the ground at speed
  if (player.drift && Math.abs(player.vel) > 9 && !onGrass) stampSkid(now);

  const sf = surfaceAt(player.pos.x, player.pos.z);
  const onGround = sf.dist < ROAD_HALF + CURB_W + 3;
  // off the road, ride the followed terrain (so you bump over grass, not air)
  const targetY = onGround ? sf.y : terrainHeightAt(player.pos.x, player.pos.z) + 0.4;
  player.surfaceY += (targetY - player.surfaceY) * Math.min(1, 12 * dt);
  player.surfaceUp.lerp(onGround ? sf.up : WORLD_UP, Math.min(1, 8 * dt)).normalize();
  player.pos.y = player.surfaceY;

  // visual lean from drift slip + steer
  const targetLat = THREE.MathUtils.clamp(lat / 16, -1, 1) * 0.7 + steer * speedFrac * 0.2;
  player.lateral += (targetLat - player.lateral) * Math.min(1, 9 * dt);

  if (player.mesh) {
    player.mesh.position.set(player.pos.x, player.surfaceY, player.pos.z);
    const fwdv = _kfwd.set(fx, 0, fz);
    const upS = player.surfaceUp;
    fwdv.addScaledVector(upS, -(fwdv.dot(upS))).normalize();
    _kquat.setFromRotationMatrix(orientMatrix(fwdv, upS));
    player.mesh.quaternion.copy(_kquat);
    const lean = -player.lateral * 0.2;
    const pitch = (throttling ? -0.04 : braking ? 0.05 : 0) * speedFrac;
    _kquat2.setFromEuler(_keuler.set(pitch, 0, lean, "ZYX"));
    player.mesh.quaternion.multiply(_kquat2);
    const spin = player.vel * dt * 2.2;
    for (const w of player.mesh.userData.allWheels) w.rotation.x += spin;
    // front wheels point into the steer, with a touch of counter-steer on drifts
    const counter = THREE.MathUtils.clamp(-player.slip / 22, -0.5, 0.5);
    for (const fw of player.mesh.userData.frontWheels) fw.rotation.y = steer * 0.4 + (player.drift ? counter : 0);
  }

  // lap line crossing
  const sd = signedFinishDist(player.pos.x, player.pos.z);
  const near = nearFinishLine(player.pos.x, player.pos.z);
  if (lap.prevSide !== null && near) {
    const crossedForward = lap.prevSide < 0 && sd >= 0;
    const crossedBackward = lap.prevSide >= 0 && sd < 0;
    if (crossedForward && lap.armed) { lap.armed = false; onCrossFinish(true, now); }
    else if (crossedBackward) { lap.armed = true; }
  }
  if (sd > 8) lap.armed = true;
  lap.prevSide = sd;

  // checkpoint gating
  if (raceStarted && lap.nextCheckpoint < checkpoints.length) {
    const cp = checkpoints[lap.nextCheckpoint];
    const csd = signedCheckpointDist(cp, player.pos.x, player.pos.z);
    if (lap.prevCpSide !== null && nearCheckpoint(cp, player.pos.x, player.pos.z)) {
      if (lap.prevCpSide < 0 && csd >= 0) { lap.nextCheckpoint++; refreshCheckpointVisuals(); }
    }
    const cpNow = checkpoints[lap.nextCheckpoint];
    lap.prevCpSide = cpNow ? signedCheckpointDist(cpNow, player.pos.x, player.pos.z) : null;
  } else {
    lap.prevCpSide = null;
  }

  // wrong-way detection
  if (Math.abs(player.vel) > 8) {
    const t = tangents[nearestSample(player.pos.x, player.pos.z).index];
    const dot = fx * t.x + fz * t.z;
    const wrong = dot < -0.35 && player.vel > 0;
    if (wrong !== lap.wrongWay) { lap.wrongWay = wrong; dom.wrongWay.classList.toggle("show", wrong); }
  } else if (lap.wrongWay) {
    lap.wrongWay = false;
    dom.wrongWay.classList.remove("show");
  }

  dom.spd.textContent = String(Math.round(Math.abs(player.vel) * 4.4));
}

function stepRemotes(dt) {
  for (const r of remotes.values()) {
    if (!r.init) continue;
    r.cur.lerp(r.target, Math.min(1, POSE_LERP * dt));
    let dh = r.targetHeading - r.curHeading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    r.curHeading += dh * Math.min(1, HEAD_LERP * dt);
    const sf = surfaceAt(r.cur.x, r.cur.z);
    const ty = isFinite(r.target.y) ? r.target.y : sf.y;
    r.surfaceY += (ty - r.surfaceY) * Math.min(1, 12 * dt);
    r.surfaceUp.lerp(sf.up, Math.min(1, 8 * dt)).normalize();
    r.mesh.position.set(r.cur.x, r.surfaceY, r.cur.z);
    const fwd = _kfwd.set(Math.sin(r.curHeading), 0, Math.cos(r.curHeading));
    const upS = r.surfaceUp;
    fwd.addScaledVector(upS, -(fwd.dot(upS))).normalize();
    r.mesh.quaternion.copy(_kquat.setFromRotationMatrix(orientMatrix(fwd, upS)));
    const spin = r.speed * dt * 2.2;
    for (const w of r.mesh.userData.allWheels) w.rotation.x += spin;
  }
}

function updateCamera(dt) {
  if (!player.mesh) return;
  const fx = Math.sin(player.heading);
  const fz = Math.cos(player.heading);
  const speedZoom = 1 + Math.min(1, Math.abs(player.vel) / PHYS.maxSpeed) * 0.4;
  const back = 10.5 * speedZoom * camZoom;
  const height = 4 + 2.2 * camZoom;
  const baseY = player.surfaceY;
  tmpCamPos.set(player.pos.x - fx * back, baseY + height, player.pos.z - fz * back);
  const follow = 1 - Math.pow(0.0009, dt);
  camera.position.lerp(tmpCamPos, follow);
  const aheadX = player.pos.x + fx * 7;
  const aheadZ = player.pos.z + fz * 7;
  const aheadY = surfaceAt(aheadX, aheadZ).y;
  tmpLook.set(aheadX, aheadY + 1.4, aheadZ);
  camera.lookAt(tmpLook);
  sun.position.set(player.pos.x + sunOffset.x, baseY + sunOffset.y, player.pos.z + sunOffset.z);
  sun.target.position.set(player.pos.x, baseY, player.pos.z);
}

function pruneRemotes(now) {
  for (const [h, r] of remotes) {
    if (now - r.at > STALE_MS) removeRemote(h);
  }
  updateRacerCount();
}

// ───────────────────────────────────────────────────────────────────────────
// MULTIPLAYER — poses over worlds.actors, zoned by trackIndex.
//   actor state: { handle, name, x, y, z, ry, speed, color, tk }
// ───────────────────────────────────────────────────────────────────────────
let net = null;
let lastSendAt = 0;
const cidToHandle = new Map();

function buildPosePayload() {
  return {
    handle: me.handle,
    name: me.name,
    x: round3(player.pos.x),
    y: round3(player.pos.y),
    z: round3(player.pos.z),
    ry: round3(player.heading),
    speed: round3(player.vel),
    color: me.color,
    tk: T.index,
  };
}
function publishPose() {
  if (!net) return;
  try { net.set(buildPosePayload()); } catch (_) {}
}
function maybeSendPose(now) {
  if (!net) return;
  if (now - lastSendAt < 1000 / SEND_HZ) return;
  lastSendAt = now;
  publishPose();
}

function onActor(cid, p) {
  if (!p || typeof p !== "object") return;
  const handle = p.handle;
  if (!handle || handle === me.handle) return;
  if (p.tk !== undefined && p.tk !== T.index) return; // ignore other tracks
  const name = typeof p.name === "string" ? p.name : handle;
  const colorHex = typeof p.color === "number" ? p.color : colorForHandle(handle);
  cidToHandle.set(cid, handle);
  const r = ensureRemote(handle, name, colorHex, cid);
  r.cid = cid;
  if (r.name !== name) { r.name = name; setRemoteLabel(r, name); }
  if (r.color !== colorHex) { r.color = colorHex; r.mesh.userData.bodyMat.color.setHex(colorHex); }
  const x = num(p.x, r.target.x);
  const z = num(p.z, r.target.z);
  const y = num(p.y, NaN);
  const ry = num(p.ry, r.targetHeading);
  r.target.set(x, isFinite(y) ? y : surfaceAt(x, z).y, z);
  r.targetHeading = ry;
  r.speed = num(p.speed, 0);
  r.at = performance.now();
  if (!r.init) {
    r.cur.copy(r.target);
    r.curHeading = ry;
    const sf0 = surfaceAt(x, z);
    r.surfaceY = r.target.y;
    r.surfaceUp.copy(sf0.up);
    r.mesh.position.set(x, r.target.y, z);
    const fwd0 = _kfwd.set(Math.sin(ry), 0, Math.cos(ry));
    fwd0.addScaledVector(sf0.up, -(fwd0.dot(sf0.up))).normalize();
    r.mesh.quaternion.setFromRotationMatrix(orientMatrix(fwd0, sf0.up));
    r.init = true;
  }
}

function onActorLeave(cid) {
  const handle = cidToHandle.get(cid);
  cidToHandle.delete(cid);
  if (!handle) return;
  const r = remotes.get(handle);
  if (!r || r.cid !== cid) return;
  removeRemote(handle);
}

function updateRacerCount() {
  const n = Math.max(1, headcount || 1 + remotes.size);
  dom.racerN.textContent = String(n);
  dom.racerS.textContent = n === 1 ? "" : "s";
}

// Horn — a discrete one-off EVENT over worlds.actors.
function onActorEvent(cid, payload) {
  if (!payload || payload.t !== "horn") return;
  const handle = cidToHandle.get(cid);
  const r = handle && remotes.get(handle);
  if (r) honkOver(r.mesh);
}
let lastHorn = 0;
function honk() {
  const now = performance.now();
  if (now - lastHorn < 500) return;
  lastHorn = now;
  if (net) try { net.send({ t: "horn" }); } catch (_) {}
  honkOver(player.mesh);
}

// ───────────────────────────────────────────────────────────────────────────
// LEADERBOARD — db collection "laps": one doc per (handle, track).
//   { handle, name, track, best_ms }. Board shows the CURRENT track's hotlaps.
// ───────────────────────────────────────────────────────────────────────────
let lbCollection = null;
let lbDocId = null;     // our doc id for the CURRENT track
let lbRows = [];        // current track rows

async function initLeaderboard() {
  try { lbCollection = worlds.db.collection(LEADERBOARD); } catch (_) { return; }
  try { lbCollection.subscribe(() => refreshLeaderboard()); } catch (_) {}
  await loadBoardForTrack();
}

// Re-point the board at the active track (called on every round/rotation).
async function loadBoardForTrack() {
  lbDocId = null;
  lap.bestMs = null;
  await refreshLeaderboard();
  const mine = lbRows.find((r) => r.handle === me.handle);
  if (mine) {
    if (mine._id) lbDocId = mine._id;
    if (typeof mine.best_ms === "number") lap.bestMs = mine.best_ms;
  }
  updateHud();
}

async function refreshLeaderboard() {
  if (!lbCollection) return;
  const track = curTrack.id;
  try {
    const res = await lbCollection.list({ filter: { track }, sort: "best_ms", limit: 100 });
    const items = (res && res.items) || [];
    lbRows = items
      .map((it) => ({
        _id: it.id,
        handle: it.data?.handle,
        name: it.data?.name || it.data?.handle || "racer",
        best_ms: typeof it.data?.best_ms === "number" ? it.data.best_ms : Infinity,
      }))
      .filter((r) => r.handle && isFinite(r.best_ms))
      .sort((a, b) => a.best_ms - b.best_ms);
    const mine = lbRows.find((r) => r.handle === me.handle);
    if (mine && mine._id) lbDocId = mine._id;
    renderBoard();
  } catch (_) {}
}

let savingBest = false;
async function saveBest(ms) {
  if (!lbCollection || !me.handle) return;
  if (savingBest) return;
  savingBest = true;
  const track = curTrack.id;
  const payload = { handle: me.handle, name: me.name, track, best_ms: Math.round(ms) };
  try {
    if (!lbDocId) {
      try {
        const res = await lbCollection.list({ filter: { handle: me.handle, track }, limit: 1 });
        const found = res && res.items && res.items[0];
        if (found) lbDocId = found.id;
      } catch (_) {}
    }
    if (lbDocId) await lbCollection.update(lbDocId, payload);
    else {
      const doc = await lbCollection.create(payload);
      if (doc && doc.id) lbDocId = doc.id;
    }
    await refreshLeaderboard();
  } catch (_) {} finally {
    savingBest = false;
  }
}

function renderBoard() {
  if (!lbRows.length) {
    dom.boardList.innerHTML = '<li class="empty">no laps yet — be the first</li>';
    return;
  }
  const top = lbRows.slice(0, 8);
  const selfRow = lbRows.find((r) => r.handle === me.handle);
  const selfRank = selfRow ? lbRows.indexOf(selfRow) + 1 : null;
  const showSelfExtra = selfRow && selfRank > 8;
  const html = top.map((r, i) => rowHtml(r, i + 1)).join("");
  const extra = showSelfExtra ? rowHtml(selfRow, selfRank) : "";
  dom.boardList.innerHTML = html + extra;
}
function rowHtml(r, pos) {
  const mine = r.handle === me.handle;
  const name = esc((r.name || "racer").slice(0, 16));
  return `<li class="${mine ? "me" : ""}"><span class="pos">${pos}</span><span class="who">${name}${mine ? " (you)" : ""}</span><span class="ms">${fmtTime(r.best_ms)}</span></li>`;
}

// ───────────────────────────────────────────────────────────────────────────
// HUD helpers
// ───────────────────────────────────────────────────────────────────────────
function updateHud() {
  dom.lapN.textContent = String(raceStarted ? Math.max(1, lap.count) : 1);
  dom.best.textContent = lap.bestMs != null ? fmtTime(lap.bestMs) : "—";
  if (dom.boardTitle) dom.boardTitle.textContent = "best laps · " + curTrack.name;
}
function updateTrackHud() {
  if (dom.trackName) dom.trackName.textContent = curTrack.name;
  if (dom.trackMeta) dom.trackMeta.textContent = curTrack.blurb + " · " + curTrack.laps + " laps";
}
function updateLiveTimer(now) {
  if (!raceStarted) { dom.timer.textContent = "0:00.00"; return; }
  dom.timer.textContent = fmtTime(now - lap.startMs);
}
function fmtTime(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
function round3(n) { return Math.round(n * 1000) / 1000; }
function num(v, fallback) { return typeof v === "number" && isFinite(v) ? v : fallback; }

// ───────────────────────────────────────────────────────────────────────────
// RUNNING LOBBY — shared clock room {trackIndex, roundEndsAt}. No waiting room:
//   everyone laps the current track; when the clock runs out, any client rolls
//   it forward (conflict-guarded) and everyone rebuilds + counts down together.
// ───────────────────────────────────────────────────────────────────────────
let clockRoom = null;
let roundEndsAt = Date.now() + ROUND_MS;
let advancing = false;
let preRace = true; // true during the countdown (karts idle at the line)

function applyRoom(s) {
  if (!s) return;
  roundEndsAt = s.roundEndsAt || Date.now() + ROUND_MS;
  const idx = ((s.trackIndex | 0) % TRACKS.length + TRACKS.length) % TRACKS.length;
  if (idx !== T.index || !T.built) startRound(idx);
}

// Build the track and (re)start the round locally.
function startRound(idx) {
  buildTrackWorld(idx);
  spawnPlayerAtStart();
  clearSkid();
  raceStarted = false;
  preRace = true;
  lap.count = 0;
  lap.startMs = 0;
  lap.lastMs = null;
  lap.prevSide = null;
  lap.armed = false;
  lap.nextCheckpoint = 0;
  lap.prevCpSide = null;
  dom.last.textContent = "";
  dom.last.classList.remove("good");
  refreshCheckpointVisuals();
  updateTrackHud();
  loadBoardForTrack();
  updateHud();
  flashTrack();
  runCountdown();
}

async function tryAdvance() {
  if (advancing || !clockRoom) return;
  const cur = clockRoom.state;
  if (!cur) return;
  advancing = true;
  const next = ((cur.trackIndex | 0) + 1) % TRACKS.length;
  try {
    const ok = await clockRoom.set({ trackIndex: next, roundEndsAt: Date.now() + ROUND_MS });
    if (ok === false && clockRoom.refetch) await clockRoom.refetch();
  } catch (_) {}
  setTimeout(() => { advancing = false; }, 2000);
}

let lastClockCheck = 0;
function tickRoundClock(now) {
  // round timer bar
  const remain = Math.max(0, roundEndsAt - Date.now());
  const frac = THREE.MathUtils.clamp(remain / ROUND_MS, 0, 1);
  if (dom.roundFill) dom.roundFill.style.width = (frac * 100).toFixed(1) + "%";
  if (dom.roundBar) dom.roundBar.classList.toggle("low", remain < 15000);
  if (dom.nextUp) {
    if (remain < 15000) {
      const nxt = TRACKS[(T.index + 1) % TRACKS.length];
      dom.nextUp.textContent = "next: " + nxt.name + " · " + Math.ceil(remain / 1000) + "s";
      dom.nextUp.classList.add("show");
    } else {
      dom.nextUp.classList.remove("show");
    }
  }
  // any client past the deadline rolls the track forward (guarded)
  if (now - lastClockCheck > 500) {
    lastClockCheck = now;
    if (clockRoom && clockRoom.state && Date.now() >= roundEndsAt) tryAdvance();
  }
}

// ── presence headcount over a ws channel ──
let presenceCh = null;
let headcount = 1;

// ───────────────────────────────────────────────────────────────────────────
// COUNTDOWN + track flash
// ───────────────────────────────────────────────────────────────────────────
function flashTrack() {
  if (!dom.trackName) return;
  dom.trackName.classList.remove("flash");
  void dom.trackName.offsetWidth;
  dom.trackName.classList.add("flash");
}

let countdownToken = 0;
function runCountdown() {
  const token = ++countdownToken; // a new round cancels an in-flight countdown
  const seq = ["3", "2", "1", "GO!"];
  let i = 0;
  dom.countdown.style.display = "flex";
  function show() {
    if (token !== countdownToken) return;
    if (i >= seq.length) {
      dom.countdown.style.display = "none";
      raceStarted = true;
      preRace = false;
      lap.armed = true;
      lap.prevSide = signedFinishDist(player.pos.x, player.pos.z);
      lap.startMs = performance.now();
      lap.count = 1;
      lap.nextCheckpoint = 0;
      lap.prevCpSide = signedCheckpointDist(checkpoints[0], player.pos.x, player.pos.z);
      refreshCheckpointVisuals();
      updateHud();
      toast("go! · " + curTrack.name);
      return;
    }
    const isGo = i === seq.length - 1;
    dom.cdNum.textContent = seq[i];
    dom.cdNum.classList.remove("pop", "go");
    void dom.cdNum.offsetWidth;
    dom.cdNum.classList.add("pop");
    if (isGo) dom.cdNum.classList.add("go");
    i++;
    setTimeout(show, 900);
  }
  show();
}

// ───────────────────────────────────────────────────────────────────────────
// RESIZE
// ───────────────────────────────────────────────────────────────────────────
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// ───────────────────────────────────────────────────────────────────────────
// BOOT
// ───────────────────────────────────────────────────────────────────────────
(async function boot() {
  try { if (window.worlds && worlds.ready) await worlds.ready; } catch (_) {}
  try {
    const info = await worlds.me();
    if (info && info.handle) { me.handle = info.handle; me.name = info.name || info.handle; }
  } catch (_) {
    me.handle = "anon-" + clientId.slice(0, 8);
    me.name = "guest";
    dom.loaderErr.textContent = "Playing anonymously — sign in to save your best laps.";
  }
  if (!me.handle) { me.handle = "anon-" + clientId.slice(0, 8); me.name = "guest"; }
  me.color = colorForHandle(me.handle);
  dom.loaderWho.innerHTML = "ready · <b>" + esc(me.name) + "</b>";

  makeSelfKart();
  initSkid();

  // realtime pose feed (zoned by track so cross-track ghosts don't show)
  try {
    net = worlds.actors(ACTORS, { zoneKey: (s) => "t" + (s.tk ?? 0), rate: SEND_HZ });
    net.onChange(onActor);
    net.onLeave(onActorLeave);
    net.onEvent(onActorEvent);
  } catch (_) {}

  // presence headcount
  try {
    presenceCh = worlds.ws.channel(ROOM_CH);
    presenceCh.presence((list) => {
      const set = new Set((list || []).map((m) => m.handle).filter(Boolean));
      set.add(me.handle);
      headcount = set.size;
      updateRacerCount();
    });
    setInterval(() => { try { presenceCh.publish({ t: "hi", handle: me.handle }); } catch (_) {} }, 4000);
  } catch (_) {}

  // leaderboard (non-blocking)
  initLeaderboard();

  // shared clock room — drives which track everyone is on + the round timer
  try {
    clockRoom = worlds.room(ROOM, {
      initial: () => ({ trackIndex: 0, roundEndsAt: Date.now() + ROUND_MS }),
    });
    try { await clockRoom.ready; } catch (_) {}
    clockRoom.onChange((s) => applyRoom(s && s.state));
    applyRoom(clockRoom.state || { trackIndex: 0, roundEndsAt: Date.now() + ROUND_MS });
  } catch (_) {
    // offline: just race track 0 solo
    startRound(0);
  }

  // announce ourselves once a track exists
  publishPose();

  lastFrame = performance.now();
  requestAnimationFrame(frame);
  setTimeout(() => dom.loader.classList.add("hide"), 350);
})();
