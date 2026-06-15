import * as THREE from "three";

// ───────────────────────────────────────────────────────────────────────────
// Kart Loop — low-poly arcade multiplayer racing on the Worlds platform.
//
// Worlds SDK is the ONLY backend:
//   worlds.room("race")        — roster / ready / host / start (the waiting room).
//   ws channel "race"          — ephemeral pose broadcasts (~14/s), echoes to self.
//   db collection "leaderboard" — one persistent doc per handle: best lap.
// Each tab gets a clientId; we ignore our own echoed poses by clientId.
// ───────────────────────────────────────────────────────────────────────────

const CHANNEL = "race";
const ROOM = "race"; // worlds.room name (roster/ready/host) — its own channel below
const LEADERBOARD = "leaderboard";
const SEND_HZ = 14; // pose broadcasts per second (SDK asks for 12-15)
const STALE_MS = 4000; // drop a remote kart unheard-from this long (aggressive anti-ghost)
const POSE_LERP = 12; // remote position smoothing rate
const HEAD_LERP = 10; // remote heading smoothing rate

const { id, esc, toast } = worlds;
const clientId = id();

// ── Player identity (filled from worlds.me, with anonymous fallback) ────────
const me = { handle: null, name: "you", color: 0xfbbf24 };

// ── Lobby / waiting-room state ───────────────────────────────────────────────
// Roster, ready-state, host and start/auto-start are handled by `worlds.room`
// (constructed in boot()). `lobby` is that room; `lobbySnap` holds its latest
// snapshot so the rest of the file can read who's ready / am I host / etc.
// The pose channel ("race") below stays a pure realtime position feed.
let lobbyActive = true; // overlay shown until the race starts
let lobby = null; // worlds.room("race") instance (roster/ready/host/start)
let lobbySnap = null; // latest room snapshot from onChange
let raceBegun = false; // local guard so we run the countdown once

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
  boardList: $("boardList"),
  countdown: $("countdown"),
  cdNum: $("cdNum"),
  lobby: $("lobby"),
  lobbySub: $("lobbySub"),
  lobbyRoster: $("lobbyRoster"),
  lobbyHint: $("lobbyHint"),
  btnReady: $("btnReady"),
  btnStart: $("btnStart"),
  loader: $("loader"),
  loaderWho: $("loaderWho"),
  loaderErr: $("loaderErr"),
  touch: { left: $("btnLeft"), right: $("btnRight"), gas: $("btnGas"), brake: $("btnBrake") },
};

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

// ───────────────────────────────────────────────────────────────────────────
// TRACK — a closed loop defined by a Catmull-Rom spline of control points.
// We sample it densely to: build the road ribbon, place curbs/scenery, and
// compute the start/finish line + per-point progress for lap detection.
// ───────────────────────────────────────────────────────────────────────────
const ROAD_HALF = 7.0; // half-width of drivable road
const CURB_W = 0.9;

// Hand-placed control points forming a flowing loop with REAL elevation.
// Y gives the height profile: rolling hills, a climb to the back ridge, and a
// satisfying plunge from the high SE corner back down to the start straight.
// BANK_W[i] (0..1) pairs with each point: how hard to roll the road toward the
// inside of the curve there (applied to the sharp/banked corners).
const CONTROL_POINTS = [
  [0, 0.5, 60], // start/finish — flat straight
  [42, 3.5, 52], // gentle rise into sweeper
  [62, 7.5, 18], // banked right-hander at the climb's crest
  [50, 9.5, -22], // ridge
  [70, 11.5, -54], // highest point — hard banked hairpin
  [40, 6.0, -78], // big drop begins
  [-2, 0.5, -70], // bottom of the plunge
  [-20, 2.5, -40], // banked left kink rising again
  [-50, 5.5, -48], // banked sweeper
  [-72, 4.0, -14], // rolling
  [-58, 1.0, 26], // descending
  [-30, -2.0, 30], // dip below grade
  [-44, 1.5, 60], // banked rise
  [-20, 2.0, 82], // long curve back to start
].map((p) => new THREE.Vector3(p[0], p[1], p[2]));
const BANK_W = [0.0, 0.55, 0.95, 0.5, 1.0, 0.45, 0.2, 0.7, 0.85, 0.6, 0.4, 0.3, 0.6, 0.2];
const BANK_MAX = 0.32; // max road roll (radians) at a fully-banked corner

const curve = new THREE.CatmullRomCurve3(CONTROL_POINTS, true, "catmullrom", 0.5);
const TRACK_LEN = curve.getLength();
const SAMPLES = 600;
// Precompute sampled centerline + tangents (arc-length parameterized).
const centerPts = curve.getSpacedPoints(SAMPLES); // length SAMPLES+1, closed
const tangents = [];
for (let i = 0; i <= SAMPLES; i++) {
  tangents.push(curve.getTangentAt((i % SAMPLES) / SAMPLES).normalize());
}

// Per-control-point bank as a closed Catmull-Rom over u∈[0,1] so we can read a
// smooth bank weight at any sample. Reuse it to derive curvature-driven roll.
const bankCurve = (() => {
  const pts = BANK_W.map((w, i) => new THREE.Vector3(i / BANK_W.length, w, 0));
  return new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
})();
function bankWeightAt(u) {
  // u in [0,1) along the loop → smoothed bank weight in [0,1]
  return THREE.MathUtils.clamp(bankCurve.getPoint(((u % 1) + 1) % 1).y, 0, 1);
}

// Per-sample surface frame: side normal rolled by the bank, and the true
// surface "up" (perpendicular to the banked cross-section). Banking rolls the
// cross-section toward the inside of the curve, so we need the curve's sign of
// turn at each sample (cross product of consecutive tangents in XZ).
const sideNormals = []; // horizontal-ish road-right direction (banked)
const ups = []; // surface up (banked)
{
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= SAMPLES; i++) {
    const t = tangents[i % SAMPLES];
    const flatN = new THREE.Vector3().crossVectors(WORLD_UP, t).normalize();
    // signed curvature: how the tangent turns over a small step (left/right)
    const tn = tangents[(i + 4) % SAMPLES];
    const turnSign = Math.sign(t.x * tn.z - t.z * tn.x) || 0; // +left, -right (XZ)
    const u = (i % SAMPLES) / SAMPLES;
    const bank = bankWeightAt(u) * BANK_MAX;
    // roll the cross-section about the tangent toward the inside of the curve
    const roll = -turnSign * bank;
    const q = new THREE.Quaternion().setFromAxisAngle(t, roll);
    sideNormals.push(flatN.clone().applyQuaternion(q).normalize());
    ups.push(WORLD_UP.clone().applyQuaternion(q).normalize());
  }
}

// progress (0..1) lookup: nearest sample index, used for lap line crossing.
function nearestSample(x, z) {
  // coarse-then-fine: scan all (SAMPLES is cheap once per frame).
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const p = centerPts[i];
    const dx = p.x - x;
    const dz = p.z - z;
    const d = dx * dx + dz * dz;
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return { index: bi, dist: Math.sqrt(bd) };
}

// ── Surface query: interpolated height + up + tangent at an XZ point ────────
// Find the nearest centerline segment and project the point onto it to get a
// smooth blended frame (so the kart rides the slope, not stair-stepped samples).
const _segA = new THREE.Vector3();
const _segB = new THREE.Vector3();
const _segAB = new THREE.Vector3();
function surfaceAt(x, z) {
  const near = nearestSample(x, z);
  const i = near.index;
  // pick the better-matching adjacent segment: [i-1,i] or [i,i+1]
  const iPrev = (i - 1 + SAMPLES) % SAMPLES;
  const iNext = (i + 1) % SAMPLES;
  let a = i;
  let b = iNext;
  // project onto both candidate segments, keep the one whose param is in range
  const tFwd = projParam(centerPts[i], centerPts[iNext], x, z);
  const tBwd = projParam(centerPts[iPrev], centerPts[i], x, z);
  let frac;
  if (tFwd >= 0) {
    a = i;
    b = iNext;
    frac = Math.min(1, tFwd);
  } else {
    a = iPrev;
    b = i;
    frac = Math.max(0, tBwd);
  }
  const pa = centerPts[a];
  const pb = centerPts[b];
  const y = pa.y + (pb.y - pa.y) * frac;
  const up = ups[a].clone().lerp(ups[b], frac).normalize();
  const t = tangents[a].clone().lerp(tangents[b], frac).normalize();
  const sideN = sideNormals[a].clone().lerp(sideNormals[b], frac).normalize();
  return { y, up, tangent: t, sideNormal: sideN, index: i, dist: near.dist };
}
function projParam(pa, pb, x, z) {
  _segA.set(pa.x, 0, pa.z);
  _segB.set(pb.x, 0, pb.z);
  _segAB.subVectors(_segB, _segA);
  const lenSq = _segAB.x * _segAB.x + _segAB.z * _segAB.z;
  if (lenSq < 1e-6) return 0;
  const px = x - _segA.x;
  const pz = z - _segA.z;
  return (px * _segAB.x + pz * _segAB.z) / lenSq;
}

// ───────────────────────────────────────────────────────────────────────────
// THREE scene scaffold
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
scene.fog = new THREE.Fog(0x9ad0e8, 180, 420);

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
{
  const skyGeo = new THREE.SphereGeometry(500, 24, 16);
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
  scene.add(new THREE.Mesh(skyGeo, skyMat));
}

// Lighting: hemisphere fill + sun directional with soft shadow.
scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x4a5d3a, 0.9));
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

// Ground plane (grass).
{
  const g = new THREE.Mesh(
    new THREE.CircleGeometry(380, 48),
    new THREE.MeshLambertMaterial({ color: 0x5d8a43 }),
  );
  g.rotation.x = -Math.PI / 2;
  g.position.y = -3.4; // below the track's lowest dip so banked road never clips
  g.receiveShadow = true;
  scene.add(g);
}

// ── Build the road ribbon + curbs as one mesh each (banked, 3D) ─────────────
// Edges follow the banked side normal so the road tilts; small surface lift
// along the banked up keeps the ribbon above the grass and the curbs above
// the road. The grass shoulders fall away from the curbs.
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
function buildTrack() {
  const left = []; // inner edge of road
  const right = []; // outer edge of road
  const curbL = [];
  const curbR = [];
  const shoulderL = [];
  const shoulderR = [];
  for (let i = 0; i <= SAMPLES; i++) {
    left.push(edgeAt(i, ROAD_HALF, ROAD_LIFT));
    right.push(edgeAt(i, -ROAD_HALF, ROAD_LIFT));
    curbL.push(edgeAt(i, ROAD_HALF + CURB_W, ROAD_LIFT + 0.04));
    curbR.push(edgeAt(i, -(ROAD_HALF + CURB_W), ROAD_LIFT + 0.04));
    // shoulder skirt fans outward AND drops to ground grade so the raised road
    // blends into the grass with no floating lip on hills/banks.
    const sL = edgeAt(i, ROAD_HALF + CURB_W + 7, 0);
    const sR = edgeAt(i, -(ROAD_HALF + CURB_W + 7), 0);
    sL.y = -3.4;
    sR.y = -3.4;
    shoulderL.push(sL);
    shoulderR.push(sR);
  }

  // Road surface: triangle strip between left/right (true banked Y).
  const roadGeo = new THREE.BufferGeometry();
  const rv = [];
  const ruv = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const a = left[i];
    const b = right[i];
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
  const road = new THREE.Mesh(
    roadGeo,
    new THREE.MeshLambertMaterial({ color: 0x36373f }),
  );
  road.receiveShadow = true;
  scene.add(road);

  // Center dashed line via small white quads, laid on the banked surface.
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xe8e8ec });
  const dashGeo = new THREE.PlaneGeometry(0.35, 3.2);
  const dashCount = 110;
  const dash = new THREE.InstancedMesh(dashGeo, dashMat, dashCount);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const dz = new THREE.Vector3();
  for (let d = 0; d < dashCount; d++) {
    const i = Math.floor((d / dashCount) * SAMPLES);
    const c = centerPts[i];
    const t = tangents[i];
    const up = ups[i];
    dz.copy(t).normalize();
    q.setFromRotationMatrix(orientMatrix(dz, up));
    m.compose(
      new THREE.Vector3(c.x + up.x * (ROAD_LIFT + 0.02), c.y + up.y * (ROAD_LIFT + 0.02), c.z + up.z * (ROAD_LIFT + 0.02)),
      q,
      new THREE.Vector3(1, 1, 1),
    );
    dash.setMatrixAt(d, m);
  }
  dash.instanceMatrix.needsUpdate = true;
  scene.add(dash);

  // Curbs: alternating red/white strips along both banked edges.
  function curbRibbon(inner, outer, offsetParity) {
    const geo = new THREE.BufferGeometry();
    const pos = [];
    const idx = [];
    const colors = [];
    const cWhite = new THREE.Color(0xf3f3f5);
    const cRed = new THREE.Color(0xd8413a);
    for (let i = 0; i <= SAMPLES; i++) {
      const a = inner[i];
      const b = outer[i];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      const stripe = Math.floor(i / 6) % 2 === offsetParity;
      const col = stripe ? cRed : cWhite;
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
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  curbRibbon(left, curbL, 0);
  curbRibbon(right, curbR, 1);

  // Grass shoulders: a darker apron skirting each curb down to grade so the
  // raised/banked road never shows a floating edge against the flat ground.
  function shoulderRibbon(top, bottom) {
    const geo = new THREE.BufferGeometry();
    const pos = [];
    const idx = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const a = top[i];
      const b = bottom[i];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    for (let i = 0; i < SAMPLES; i++) {
      const o = i * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x55803d }));
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  shoulderRibbon(curbL, shoulderL);
  shoulderRibbon(curbR, shoulderR);

  return { left, right, curbL, curbR };
}

// Build a rotation that aligns +Z to `forward` and +Y to `up` (for placing
// flat quads / posts on the banked surface).
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
const trackEdges = buildTrack();

// ── Start/finish line: a checkered band laid across the banked road ─────────
// finishForward/finishNormal stay HORIZONTAL (XZ) — lap-crossing math projects
// the kart's flat XZ onto these planes, so keeping them planar avoids slope
// sensitivity. Visuals follow the banked surface frame instead.
const FINISH_INDEX = 0;
let finishNormal, finishCenter, finishForward;
{
  const c = centerPts[FINISH_INDEX];
  const t = tangents[FINISH_INDEX];
  const up = ups[FINISH_INDEX];
  finishCenter = c.clone();
  finishForward = t.clone().setY(0).normalize();
  finishNormal = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), t).normalize();

  const cols = 14;
  const tileW = (ROAD_HALF * 2) / cols;
  const tileL = 3.2;
  const group = new THREE.Group();
  const matA = new THREE.MeshBasicMaterial({ color: 0xf4f4f6 });
  const matB = new THREE.MeshBasicMaterial({ color: 0x18181b });
  const baseQ = new THREE.Quaternion().setFromRotationMatrix(orientMatrix(t, up));
  const lay = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  for (let r = 0; r < 2; r++) {
    for (let col = 0; col < cols; col++) {
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(tileW, tileL),
        (r + col) % 2 === 0 ? matA : matB,
      );
      tile.quaternion.copy(baseQ).multiply(lay);
      // place on the banked surface: along the tangent, across the side normal
      const along = t.clone().multiplyScalar((r - 0.5) * tileL);
      const lateral = ROAD_HALF - tileW * (col + 0.5);
      const p = edgeAt(FINISH_INDEX, lateral, ROAD_LIFT + 0.04);
      tile.position.set(p.x + along.x, p.y, p.z + along.z);
      group.add(tile);
    }
  }
  scene.add(group);

  // Start gantry: two posts + banner over the line, planted on the banked road.
  const postMat = new THREE.MeshLambertMaterial({ color: 0x27272a });
  const bannerMat = new THREE.MeshLambertMaterial({ color: 0xf59e0b });
  for (const s of [1, -1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 9, 0.7), postMat);
    const base = edgeAt(FINISH_INDEX, s * (ROAD_HALF + 0.6), ROAD_LIFT);
    post.position.set(base.x, base.y + 4.5, base.z);
    post.castShadow = true;
    scene.add(post);
  }
  const banner = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2 + 1.6, 1.8, 0.5), bannerMat);
  banner.position.set(c.x, c.y + 9, c.z);
  banner.rotation.y = Math.atan2(finishForward.x, finishForward.z);
  banner.castShadow = true;
  scene.add(banner);
}

// ───────────────────────────────────────────────────────────────────────────
// CHECKPOINTS — a ring of gates around the track, evenly spaced along the
// spline and offset from the finish line. A lap only counts after the kart has
// passed ALL of them in order since the last finish crossing (anti-shortcut).
// ───────────────────────────────────────────────────────────────────────────
const CHECKPOINT_COUNT = 5;
const checkpoints = []; // { index, center:Vector3, forward:Vector3, normal:Vector3, post:[Mesh,Mesh], bar:Mesh, mats:[...] }

{
  // Spread evenly but skip sample 0 (the finish line). First gate sits at a
  // fraction of the way around so none overlaps the start/finish band.
  for (let k = 0; k < CHECKPOINT_COUNT; k++) {
    const frac = (k + 0.5) / CHECKPOINT_COUNT; // never 0 → never on the finish
    const index = Math.floor(frac * SAMPLES) % SAMPLES;
    const c = centerPts[index];
    const t = tangents[index];
    const forward = t.clone().setY(0).normalize();
    const normal = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), t).normalize();
    checkpoints.push({
      index,
      center: c.clone(), // 3D — for gate placement
      forward, // horizontal — for plane crossing math
      normal, // horizontal
      up: ups[index].clone(),
    });
  }
}

function buildCheckpointGates() {
  const dimMat = () => new THREE.MeshBasicMaterial({ color: 0x4b5563, transparent: true, opacity: 0.55 });
  for (const cp of checkpoints) {
    const group = new THREE.Group();
    const matA = dimMat();
    const matB = dimMat();
    const barMat = dimMat();
    cp.mats = [matA, matB, barMat];
    const postGeo = new THREE.CylinderGeometry(0.22, 0.22, 7, 8);
    for (const [s, mat] of [
      [1, matA],
      [-1, matB],
    ]) {
      const base = edgeAt(cp.index, s * (ROAD_HALF + 0.4), ROAD_LIFT);
      const post = new THREE.Mesh(postGeo, mat);
      post.position.set(base.x, base.y + 3.5, base.z);
      group.add(post);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2 + 0.8, 0.4, 0.4), barMat);
    bar.position.set(cp.center.x, cp.center.y + 6.8, cp.center.z);
    bar.rotation.y = Math.atan2(cp.forward.x, cp.forward.z);
    group.add(bar);
    cp.group = group;
    scene.add(group);
  }
  refreshCheckpointVisuals();
}

const CP_COLOR_NEXT = new THREE.Color(0xfbbf24); // gold — go here next
const CP_COLOR_DONE = new THREE.Color(0x34d399); // green — already passed
const CP_COLOR_IDLE = new THREE.Color(0x4b5563); // dim — not yet

function refreshCheckpointVisuals() {
  for (let k = 0; k < checkpoints.length; k++) {
    const cp = checkpoints[k];
    if (!cp.mats) continue;
    let color, opacity;
    if (k === lap.nextCheckpoint && raceStarted) {
      color = CP_COLOR_NEXT;
      opacity = 0.95;
    } else if (k < lap.nextCheckpoint) {
      color = CP_COLOR_DONE;
      opacity = 0.45;
    } else {
      color = CP_COLOR_IDLE;
      opacity = 0.55;
    }
    for (const mat of cp.mats) {
      mat.color.copy(color);
      mat.opacity = opacity;
    }
  }
}

// Signed distance to a checkpoint's plane (+ahead of the gate along track dir).
function signedCheckpointDist(cp, x, z) {
  const dx = x - cp.center.x;
  const dz = z - cp.center.z;
  return dx * cp.forward.x + dz * cp.forward.z;
}
function nearCheckpoint(cp, x, z) {
  const dx = x - cp.center.x;
  const dz = z - cp.center.z;
  const lateral = dx * cp.normal.x + dz * cp.normal.z;
  return Math.abs(lateral) < ROAD_HALF + 2;
}

// ── Scenery: cones near apexes + low-poly trees + grandstand blocks ─────────
function addScenery() {
  // Cones along both curbs (instanced).
  const coneGeo = new THREE.ConeGeometry(0.5, 1.3, 8);
  const coneMat = new THREE.MeshLambertMaterial({ color: 0xf97316 });
  const coneCount = 60;
  const cones = new THREE.InstancedMesh(coneGeo, coneMat, coneCount);
  cones.castShadow = true;
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
  scene.add(cones);

  // Trees ring the track, well outside the road.
  const trunkGeo = new THREE.CylinderGeometry(0.4, 0.55, 2.6, 6);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2b });
  const leafGeo = new THREE.IcosahedronGeometry(2.2, 0);
  const treeCount = 70;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshLambertMaterial({ color: 0x3f7d33 }), treeCount);
  trunks.castShadow = true;
  leaves.castShadow = true;
  const leafColors = [0x3f7d33, 0x4f9a3f, 0x357a2e, 0x68a84a];
  const mt = new THREE.Matrix4();
  const ml = new THREE.Matrix4();
  let placed = 0;
  const rng = mulberry32(1337);
  let guard = 0;
  while (placed < treeCount && guard++ < 4000) {
    const ang = rng() * Math.PI * 2;
    const rad = 95 + rng() * 230;
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    const near = nearestSample(x, z);
    if (near.dist < ROAD_HALF + 14) continue; // keep clear of the track
    const s = 0.7 + rng() * 0.9;
    const gy = -3.4; // ground grade
    mt.compose(new THREE.Vector3(x, gy + 1.3 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    trunks.setMatrixAt(placed, mt);
    ml.compose(new THREE.Vector3(x, gy + (2.6 + 1.6) * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    leaves.setMatrixAt(placed, ml);
    leaves.setColorAt(placed, new THREE.Color(leafColors[placed % leafColors.length]));
    placed++;
  }
  trunks.count = placed;
  leaves.count = placed;
  trunks.instanceMatrix.needsUpdate = true;
  leaves.instanceMatrix.needsUpdate = true;
  if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  scene.add(trunks, leaves);

  // A couple of grandstand blocks for arcade flavor.
  const standMat = new THREE.MeshLambertMaterial({ color: 0x3b3b44 });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xf59e0b });
  for (const spot of [80, 360]) {
    const i = spot % SAMPLES;
    const c = centerPts[i];
    const n = finishNormalAt(i).multiplyScalar(ROAD_HALF + 12);
    const gy = Math.max(0, c.y); // sit on grade, never sink below ground
    const base = new THREE.Mesh(new THREE.BoxGeometry(18, 4, 7), standMat);
    base.position.set(c.x + n.x, gy + 2, c.z + n.z);
    base.lookAt(c.x, gy + 2, c.z);
    base.castShadow = true;
    base.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(18.5, 0.5, 7.5), roofMat);
    roof.position.set(c.x + n.x, gy + 4.6, c.z + n.z);
    roof.lookAt(c.x, gy + 4.6, c.z);
    scene.add(base, roof);
  }
}
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
addScenery();

// ───────────────────────────────────────────────────────────────────────────
// KART mesh — built from boxes. Reused for self + remotes; color-tinted.
// Returns a group; the body material is the one we recolor per player.
// ───────────────────────────────────────────────────────────────────────────
function makeKart(colorHex) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: colorHex });   // recolored per player
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

  // low floor pan + main tub
  add(new THREE.BoxGeometry(1.4, 0.16, 2.7), darkMat, 0, 0.34, 0);
  add(new THREE.BoxGeometry(1.35, 0.42, 1.7), bodyMat, 0, 0.6, -0.1);
  // side pods (radiators)
  add(new THREE.BoxGeometry(0.34, 0.4, 1.4), bodyMat, 0.88, 0.55, 0);
  add(new THREE.BoxGeometry(0.34, 0.4, 1.4), bodyMat, -0.88, 0.55, 0);
  // tapered nose + front splitter
  add(new THREE.BoxGeometry(1.1, 0.3, 1.2), bodyMat, 0, 0.5, 1.35);
  add(new THREE.BoxGeometry(1.6, 0.08, 0.45), trimMat, 0, 0.38, 1.95);
  // cockpit recess
  add(new THREE.BoxGeometry(0.85, 0.34, 0.95), darkMat, 0, 0.8, 0);
  // driver: suit torso, skin head, helmet in the player colour + visor
  add(new THREE.BoxGeometry(0.5, 0.46, 0.46), trimMat, 0, 1.0, -0.1);
  add(new THREE.SphereGeometry(0.18, 12, 10), skinMat, 0, 1.32, -0.05);
  add(new THREE.SphereGeometry(0.24, 16, 12), bodyMat, 0, 1.4, -0.1);
  add(new THREE.BoxGeometry(0.4, 0.1, 0.06), darkMat, 0, 1.42, 0.14); // visor
  // steering wheel
  const sw = add(new THREE.TorusGeometry(0.16, 0.035, 8, 16), darkMat, 0, 0.98, 0.42);
  sw.rotation.x = Math.PI / 2.4;
  // roll hoop + rear wing on struts
  add(new THREE.BoxGeometry(0.8, 0.55, 0.2), bodyMat, 0, 1.3, -0.75);
  add(new THREE.BoxGeometry(1.85, 0.1, 0.5), trimMat, 0, 1.25, -1.45);
  for (const s of [0.66, -0.66]) add(new THREE.BoxGeometry(0.1, 0.5, 0.1), darkMat, s, 1.0, -1.45);
  // twin exhausts
  for (const s of [0.22, -0.22]) {
    const e = add(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 8), rimMat, s, 0.5, -1.5);
    e.rotation.x = Math.PI / 2;
  }

  // wheels: tire + light rim, grouped so rotation.x spins and rotation.y steers
  const tireGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.4, 16);
  const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.42, 8);
  const wheels = [];
  const wx = 0.9;
  const wz = 1.02;
  for (const [sx, sz] of [
    [wx, wz],
    [-wx, wz],
    [wx, -wz],
    [-wx, -wz],
  ]) {
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

// Name label as a sprite (canvas texture). Reused per kart.
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
  // sizeAttenuation:false → scale is in normalized screen height (y) units, so
  // the label is a constant on-screen caption regardless of camera distance/zoom.
  const mat = new THREE.SpriteMaterial({
    map: tex,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    sizeAttenuation: false,
  });
  const sprite = new THREE.Sprite(mat);
  const aspect = cv.width / cv.height;
  const LABEL_H = 1 / 20; // base; scaled per-frame by distance (bigger far, smaller close)
  sprite.userData.baseW = LABEL_H * aspect;
  sprite.userData.baseH = LABEL_H;
  sprite.scale.set(LABEL_H * aspect, LABEL_H, 1);
  sprite.position.y = 2.5;
  sprite.renderOrder = 10;
  return sprite;
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
  heading: 0, // radians, 0 = +Z
  vel: 0, // forward signed speed (units/s)
  lateral: 0, // drift slip used for visual lean
  surfaceY: 0, // smoothed track-surface height under the kart
  surfaceUp: new THREE.Vector3(0, 1, 0), // smoothed surface up (banked)
  mesh: null,
  label: null,
};

// Spawn slightly behind the finish line, facing along the track direction.
{
  const back = finishForward.clone().multiplyScalar(-6);
  player.pos.set(finishCenter.x + back.x, finishCenter.y, finishCenter.z + back.z);
  player.heading = Math.atan2(finishForward.x, finishForward.z);
  const sf = surfaceAt(player.pos.x, player.pos.z);
  player.surfaceY = sf.y;
  player.surfaceUp.copy(sf.up);
}

const PHYS = {
  accel: 26, // throttle acceleration
  brake: 40, // braking deceleration
  reverseAccel: 14,
  maxSpeed: 46,
  maxReverse: -12,
  drag: 1.6, // passive slowdown factor (per sec)
  rollFriction: 6, // coasting friction
  turnRate: 2.4, // base steering (rad/s) at low speed
  turnSpeedFalloff: 0.55, // steering shrinks as speed rises
  offRoadDrag: 34, // strong slow when off the road
  offRoadMax: 16, // speed cap off-road
  gripRecover: 6,
  gravityFeel: 18, // accel/decel from slope grade (units/s² at full pitch)
};

function makeSelfKart() {
  player.mesh = makeKart(me.color);
  player.label = makeLabel(me.name + " (you)");
  player.mesh.add(player.label);
  scene.add(player.mesh);
}

// ── Remote karts ─────────────────────────────────────────────────────────
// Keyed by HANDLE → exactly one kart per distinct player. Each entry also
// remembers which clientId currently "owns" it; a pose from a DIFFERENT cid for
// the same handle (rename / reconnect / new tab) REPLACES the owner instead of
// spawning a ghost. Label updates live on rename.
// handle -> { mesh, label, name, color, cid, cur, target, ..., at }
const remotes = new Map();

function ensureRemote(handle, name, colorHex, cid) {
  let r = remotes.get(handle);
  if (!r) {
    const mesh = makeKart(colorHex);
    const label = makeLabel(name);
    mesh.add(label);
    scene.add(mesh);
    r = {
      mesh,
      label,
      name,
      color: colorHex,
      cid: cid || null,
      cur: new THREE.Vector3(),
      target: new THREE.Vector3(),
      surfaceY: 0,
      surfaceUp: new THREE.Vector3(0, 1, 0),
      curHeading: 0,
      targetHeading: 0,
      speed: 0,
      at: performance.now(),
      init: false,
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
const input = { up: false, down: false, left: false, right: false };
const KEYMAP = {
  ArrowUp: "up", w: "up", W: "up",
  ArrowDown: "down", s: "down", S: "down",
  ArrowLeft: "left", a: "left", A: "left",
  ArrowRight: "right", d: "right", D: "right",
};
addEventListener(
  "keydown",
  (e) => {
    const k = KEYMAP[e.key];
    if (k) {
      input[k] = true;
      e.preventDefault();
    }
  },
  { passive: false },
);
addEventListener(
  "keyup",
  (e) => {
    const k = KEYMAP[e.key];
    if (k) {
      input[k] = false;
      e.preventDefault();
    }
  },
  { passive: false },
);
// release everything when focus/visibility is lost
function releaseAll() {
  input.up = input.down = input.left = input.right = false;
}
addEventListener("blur", releaseAll);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAll();
});

// Touch detection + wiring
const isTouch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
if (isTouch) document.body.classList.add("touch");
function bindHold(el, key) {
  if (!el) return;
  const on = (e) => {
    e.preventDefault();
    input[key] = true;
    el.classList.add("held");
  };
  const off = (e) => {
    if (e) e.preventDefault();
    input[key] = false;
    el.classList.remove("held");
  };
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

// ───────────────────────────────────────────────────────────────────────────
// OFF-ROAD test — signed distance from centerline using nearest sample.
// ───────────────────────────────────────────────────────────────────────────
function offRoadAmount(x, z) {
  const near = nearestSample(x, z);
  // how far past the road half-width (plus a little curb forgiveness)
  return Math.max(0, near.dist - (ROAD_HALF + CURB_W * 0.6));
}

// ───────────────────────────────────────────────────────────────────────────
// COLLISIONS — arcade "soft walls". Both nudge the LOCAL player only.
// ───────────────────────────────────────────────────────────────────────────
// allow drifting onto the curb a bit before the wall kicks in
const WALL_LIMIT = ROAD_HALF + CURB_W + 0.6;
const WALL_PUSH = 0.6; // how much of the overshoot to correct per frame

function resolveTrackWall(fx, fz) {
  const near = nearestSample(player.pos.x, player.pos.z);
  const c = centerPts[near.index];
  // outward radial direction from the centerline in the XZ plane
  let ox = player.pos.x - c.x;
  let oz = player.pos.z - c.z;
  const dist = Math.hypot(ox, oz);
  if (dist < WALL_LIMIT || dist < 1e-4) return;
  ox /= dist;
  oz /= dist;
  const overshoot = dist - WALL_LIMIT;
  // push back toward the road (forgiving, not a hard snap)
  player.pos.x -= ox * overshoot * WALL_PUSH;
  player.pos.z -= oz * overshoot * WALL_PUSH;
  // kill the outward component of velocity (vel is along heading fx/fz)
  const into = fx * ox + fz * oz; // >0 means driving outward into the wall
  if (into > 0 && player.vel > 0) {
    player.vel -= player.vel * into * 0.5;
  } else if (into < 0 && player.vel < 0) {
    player.vel -= player.vel * -into * 0.5;
  }
}

const KART_RADIUS = 1.1;
const KART_MIN_DIST = KART_RADIUS * 2;

function resolveKartCollisions(fx, fz) {
  for (const r of remotes.values()) {
    if (!r.init) continue;
    let dx = player.pos.x - r.cur.x;
    let dz = player.pos.z - r.cur.z;
    const dist = Math.hypot(dx, dz);
    if (dist >= KART_MIN_DIST) continue;
    let nx, nz;
    if (dist < 1e-4) {
      // exactly overlapping → push along our own forward axis
      nx = fx;
      nz = fz;
    } else {
      nx = dx / dist;
      nz = dz / dist;
    }
    const overlap = KART_MIN_DIST - dist;
    // light push: move the local kart out along the separation normal
    player.pos.x += nx * overlap;
    player.pos.z += nz * overlap;
    // damp the velocity component heading INTO the other kart (arcade nudge)
    const into = -(fx * nx + fz * nz); // >0 means we're driving toward them
    if (into > 0 && player.vel > 0) {
      player.vel -= player.vel * into * 0.35;
    } else if (into < 0 && player.vel < 0) {
      player.vel -= player.vel * -into * 0.35;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// LAP detection — cross the finish band in the forward track direction.
// We track the signed distance to the finish plane each frame; a sign flip
// from behind→ahead while near the line, moving forward, counts as a lap.
// ───────────────────────────────────────────────────────────────────────────
let raceStarted = false; // gate lap timing until countdown finishes
const lap = {
  count: 0,
  startMs: 0, // current lap start timestamp
  bestMs: null,
  lastMs: null,
  prevSide: null, // sign of distance to finish plane last frame
  armed: false, // must travel away from the line before a lap can re-count
  wrongWay: false,
  nextCheckpoint: 0, // index into checkpoints[] we must clear next
  prevCpSide: null, // sign of dist to the NEXT checkpoint plane last frame
};

// gates need the `lap` state to color the next checkpoint — build now.
buildCheckpointGates();

function signedFinishDist(x, z) {
  // distance along finishForward from the finish center; +ahead, -behind.
  const dx = x - finishCenter.x;
  const dz = z - finishCenter.z;
  return dx * finishForward.x + dz * finishForward.z;
}
function nearFinishLine(x, z) {
  const dx = x - finishCenter.x;
  const dz = z - finishCenter.z;
  const lateral = dx * finishNormal.x + dz * finishNormal.z;
  return Math.abs(lateral) < ROAD_HALF + 2;
}

function startTimerNow(now) {
  lap.startMs = now;
}

function onCrossFinish(forward, now) {
  if (!raceStarted) return;
  if (!forward) {
    toast("↺ turn around");
    return;
  }
  // Anti-shortcut: a lap is only valid once every checkpoint was cleared in
  // order since the last finish crossing.
  const allChecked = lap.nextCheckpoint >= checkpoints.length;
  if (lap.count > 0 && !allChecked) {
    toast("⚑ missed checkpoints · lap not counted");
    return; // do NOT count the lap, do NOT reset the timer
  }
  if (lap.count > 0) {
    // completed a valid lap
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
  // reset checkpoint ring for the new lap
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

  stepPhysics(dt, now);
  stepRemotes(dt);
  updateCamera(dt);
  maybeSendPose(now);
  pruneRemotes(now);
  updateLiveTimer(now);

  // name tags: bigger far, smaller close (after camera update so distance is current)
  scaleLabel(player.label);
  for (const r of remotes.values()) scaleLabel(r.label);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function stepPhysics(dt, now) {
  // ── longitudinal ──
  // while the lobby is up, karts idle at the start line — ignore drive input.
  const throttling = lobbyActive ? false : input.up;
  const braking = lobbyActive ? false : input.down;
  if (lobbyActive) player.vel *= Math.max(0, 1 - 4 * dt); // settle to a stop
  if (throttling) {
    player.vel += PHYS.accel * dt;
  } else if (braking) {
    if (player.vel > 0.5) player.vel -= PHYS.brake * dt;
    else player.vel -= PHYS.reverseAccel * dt; // into reverse
  } else {
    // coast: roll friction toward zero
    const f = PHYS.rollFriction * dt;
    if (player.vel > 0) player.vel = Math.max(0, player.vel - f);
    else if (player.vel < 0) player.vel = Math.min(0, player.vel + f);
  }
  // passive drag (proportional)
  player.vel -= player.vel * PHYS.drag * dt * 0.18;

  // off-road penalty: cap + heavy slow + gentle steer-back nudge
  const off = offRoadAmount(player.pos.x, player.pos.z);
  let onGrass = off > 0;
  if (onGrass) {
    if (player.vel > PHYS.offRoadMax) player.vel -= PHYS.offRoadDrag * dt;
    if (player.vel < -PHYS.offRoadMax) player.vel += PHYS.offRoadDrag * dt;
    player.vel = THREE.MathUtils.clamp(player.vel, -PHYS.offRoadMax, PHYS.offRoadMax);
  }

  player.vel = THREE.MathUtils.clamp(player.vel, PHYS.maxReverse, PHYS.maxSpeed);

  // ── steering (scales down with speed; needs motion to turn) ──
  const steer = lobbyActive ? 0 : (input.left ? 1 : 0) - (input.right ? 1 : 0);
  const speedFrac = Math.min(1, Math.abs(player.vel) / PHYS.maxSpeed);
  const turnScale = 1 - PHYS.turnSpeedFalloff * speedFrac;
  // motion gate: barely turns when nearly stopped (arcade but believable)
  const motionGate = Math.min(1, Math.abs(player.vel) / 6);
  const dir = player.vel >= 0 ? 1 : -1;
  const turn = steer * PHYS.turnRate * turnScale * motionGate * dir;
  player.heading += turn * dt;

  // drift/lean visual: lateral slip eases toward steer*speed
  const targetLat = steer * speedFrac * 0.7;
  player.lateral += (targetLat - player.lateral) * Math.min(1, PHYS.gripRecover * dt);

  // ── integrate position ──
  const fx = Math.sin(player.heading);
  const fz = Math.cos(player.heading);
  player.pos.x += fx * player.vel * dt;
  player.pos.z += fz * player.vel * dt;

  // ── gravity feel: sample surface height a step ahead vs behind along the
  // heading; the height delta is the grade. Downhill (+) speeds up, uphill (−)
  // slows down. Subtle by design — keeps the arcade feel.
  {
    const STEP = 3;
    const aheadY = surfaceAt(player.pos.x + fx * STEP, player.pos.z + fz * STEP).y;
    const behindY = surfaceAt(player.pos.x - fx * STEP, player.pos.z - fz * STEP).y;
    const grade = (behindY - aheadY) / (2 * STEP); // >0 means going downhill
    player.vel += THREE.MathUtils.clamp(grade, -0.6, 0.6) * PHYS.gravityFeel * dt;
  }

  // ── track containment ("soft wall" at the road edge) ──
  // Past the road half-width + margin, push back toward the centerline and
  // kill the outward velocity component. Forgiving enough to clip curbs.
  resolveTrackWall(fx, fz);

  // ── kart-to-kart collisions (local player vs remotes; XZ circle test) ──
  resolveKartCollisions(fx, fz);

  // ── stick to the track surface: set Y to the interpolated surface height and
  // orient the kart to the banked/sloped surface frame, then layer the arcade
  // turn-lean + accel-pitch on top. Smoothed so crests/banks feel fluid.
  const sf = surfaceAt(player.pos.x, player.pos.z);
  const onGround = sf.dist < ROAD_HALF + CURB_W + 3;
  const targetY = onGround ? sf.y : Math.max(-3.4 + 0.05, player.surfaceY); // off-track: hold last grade
  player.surfaceY += (targetY - player.surfaceY) * Math.min(1, 12 * dt);
  player.surfaceUp.lerp(onGround ? sf.up : WORLD_UP, Math.min(1, 8 * dt)).normalize();
  player.pos.y = player.surfaceY;

  // mesh transform
  if (player.mesh) {
    player.mesh.position.set(player.pos.x, player.surfaceY, player.pos.z);
    // base orientation: align kart up to surface up, forward to heading
    const fwd = _kfwd.set(fx, 0, fz);
    // tilt forward into the surface plane so pitch tracks the slope
    const upS = player.surfaceUp;
    fwd.addScaledVector(upS, -(fwd.dot(upS))).normalize();
    _kquat.setFromRotationMatrix(orientMatrix(fwd, upS));
    player.mesh.quaternion.copy(_kquat);
    // arcade lean (roll) + accel/brake pitch, applied in the kart's local frame
    const lean = -player.lateral * 0.18;
    const pitch = (throttling ? -0.04 : braking ? 0.05 : 0) * speedFrac;
    _kquat2.setFromEuler(_keuler.set(pitch, 0, lean, "ZYX"));
    player.mesh.quaternion.multiply(_kquat2);
    // spin wheels
    const spin = player.vel * dt * 2.2;
    for (const w of player.mesh.userData.allWheels) w.rotation.x += spin;
    for (const fw of player.mesh.userData.frontWheels) fw.rotation.y = steer * 0.4;
  }

  // ── lap line crossing ──
  const sd = signedFinishDist(player.pos.x, player.pos.z);
  const near = nearFinishLine(player.pos.x, player.pos.z);
  if (lap.prevSide !== null && near) {
    const crossedForward = lap.prevSide < 0 && sd >= 0;
    const crossedBackward = lap.prevSide >= 0 && sd < 0;
    if (crossedForward && lap.armed) {
      lap.armed = false;
      onCrossFinish(true, now);
    } else if (crossedBackward) {
      // crossed the wrong way; do not count, just re-arm logic
      lap.armed = true;
    }
  }
  // re-arm once we're a safe distance ahead of the line
  if (sd > 8) lap.armed = true;
  lap.prevSide = sd;

  // ── checkpoint gating ──
  // Must pass the NEXT checkpoint's plane going forward (within the road's
  // lateral span). Crossing in order arms the next; finish only counts a lap
  // once all are cleared.
  if (raceStarted && lap.nextCheckpoint < checkpoints.length) {
    const cp = checkpoints[lap.nextCheckpoint];
    const csd = signedCheckpointDist(cp, player.pos.x, player.pos.z);
    if (lap.prevCpSide !== null && nearCheckpoint(cp, player.pos.x, player.pos.z)) {
      const crossedForward = lap.prevCpSide < 0 && csd >= 0;
      if (crossedForward) {
        lap.nextCheckpoint++;
        refreshCheckpointVisuals();
      }
    }
    // track sign against whichever checkpoint is now next
    const cpNow = checkpoints[lap.nextCheckpoint];
    lap.prevCpSide = cpNow ? signedCheckpointDist(cpNow, player.pos.x, player.pos.z) : null;
  } else {
    lap.prevCpSide = null;
  }

  // wrong-way detection: moving fast but heading opposes track tangent
  if (Math.abs(player.vel) > 8) {
    const t = tangents[nearestSample(player.pos.x, player.pos.z).index];
    const dot = fx * t.x + fz * t.z;
    const wrong = dot < -0.35 && player.vel > 0;
    if (wrong !== lap.wrongWay) {
      lap.wrongWay = wrong;
      dom.wrongWay.classList.toggle("show", wrong);
    }
  } else if (lap.wrongWay) {
    lap.wrongWay = false;
    dom.wrongWay.classList.remove("show");
  }

  // speed HUD (km/h-ish flavor scaling)
  dom.spd.textContent = String(Math.round(Math.abs(player.vel) * 7.2));
}

function stepRemotes(dt) {
  for (const r of remotes.values()) {
    if (!r.init) continue;
    r.cur.lerp(r.target, Math.min(1, POSE_LERP * dt));
    // shortest-arc heading lerp
    let dh = r.targetHeading - r.curHeading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    r.curHeading += dh * Math.min(1, HEAD_LERP * dt);
    // ride the surface too: prefer the sender's reported y when present, else
    // sample so remotes don't float over hills.
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
  // chase position: behind + above the kart, riding its surface height so
  // cresting a hill / dropping reads naturally. Look a bit further ahead at the
  // surface height THERE so the camera tips down on descents and up on climbs.
  const speedZoom = 1 + Math.min(1, Math.abs(player.vel) / PHYS.maxSpeed) * 0.4;
  const back = 10.5 * speedZoom * camZoom;
  const height = 4 + 2.2 * camZoom;
  const baseY = player.surfaceY;
  tmpCamPos.set(
    player.pos.x - fx * back,
    baseY + height,
    player.pos.z - fz * back,
  );
  // smooth follow (lag)
  const follow = 1 - Math.pow(0.0009, dt); // frame-rate independent smoothing
  camera.position.lerp(tmpCamPos, follow);
  // look slightly ahead of the kart, at that point's surface height
  const aheadX = player.pos.x + fx * 7;
  const aheadZ = player.pos.z + fz * 7;
  const aheadY = surfaceAt(aheadX, aheadZ).y;
  tmpLook.set(aheadX, aheadY + 1.4, aheadZ);
  camera.lookAt(tmpLook);
  // keep the sun shadow frustum centered on the action
  sun.position.set(player.pos.x + 70, baseY + 120, player.pos.z + 50);
  sun.target.position.set(player.pos.x, baseY, player.pos.z);
}

function pruneRemotes(now) {
  // Drop kart meshes we haven't heard a pose from recently. The lobby roster is
  // owned by worlds.room (presence-backed), so there's nothing else to expire.
  for (const [h, r] of remotes) {
    if (now - r.at > STALE_MS) removeRemote(h);
  }
  updateRacerCount();
}

// ───────────────────────────────────────────────────────────────────────────
// MULTIPLAYER — poses over worlds.actors("race"), one zone (the whole track).
//   Each racer publishes ONE last-value pose; the server snapshots it to joiners
//   and rate-caps the fan-out (no hand-rolled pose channel). Ready / host / start
//   live in worlds.room (the lobby), NOT on the pose.
//   actor state: { handle, name, x, y, z, ry, speed, color }
// ───────────────────────────────────────────────────────────────────────────
let net = null; // worlds.actors handle
let lastSendAt = 0;
const cidToHandle = new Map(); // actor id -> handle, to map a leave back to its kart

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
  };
}

function publishPose() {
  if (!net) return;
  try {
    net.set(buildPosePayload());
  } catch (_) {
    /* SDK buffers / reconnects */
  }
}

function maybeSendPose(now) {
  if (!net) return;
  if (now - lastSendAt < 1000 / SEND_HZ) return;
  lastSendAt = now;
  publishPose();
}

// worlds.actors onChange — a peer (id = its stable cid) created or updated its pose.
function onActor(cid, p) {
  if (!p || typeof p !== "object") return;
  const handle = p.handle;
  if (!handle || handle === me.handle) return; // never render our own handle
  const name = typeof p.name === "string" ? p.name : handle;
  const colorHex = typeof p.color === "number" ? p.color : colorForHandle(handle);

  cidToHandle.set(cid, handle); // map this actor id back to its kart for onLeave

  const r = ensureRemote(handle, name, colorHex, cid);
  // One kart per handle: the latest cid to send for a handle (rename / reconnect /
  // new tab) takes ownership, so a leave from an OLD cid won't yank the kart.
  r.cid = cid;
  // live name update on rename
  if (r.name !== name) {
    r.name = name;
    setRemoteLabel(r, name);
  }
  // (re)apply color if changed
  if (r.color !== colorHex) {
    r.color = colorHex;
    r.mesh.userData.bodyMat.color.setHex(colorHex);
  }
  const x = num(p.x, r.target.x);
  const z = num(p.z, r.target.z);
  const y = num(p.y, NaN); // optional; sampled when absent
  const ry = num(p.ry, r.targetHeading);
  r.target.set(x, isFinite(y) ? y : surfaceAt(x, z).y, z);
  r.targetHeading = ry;
  r.speed = num(p.speed, 0);
  r.at = performance.now();
  if (!r.init) {
    // first packet: snap so we don't lerp from origin, and orient to the banked
    // surface (matches stepRemotes) so it doesn't flash flat for one frame.
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
  updateRacerCount();
}

// worlds.actors onLeave — a peer's cid disconnected. Drop its kart if that cid
// still owns it (a newer cid may have taken over). Roster lives in worlds.room.
function onActorLeave(cid) {
  const handle = cidToHandle.get(cid);
  cidToHandle.delete(cid);
  if (!handle) return;
  const r = remotes.get(handle);
  if (!r || r.cid !== cid) return;
  removeRemote(handle);
  updateRacerCount();
}

function updateRacerCount() {
  const n = 1 + remotes.size;
  dom.racerN.textContent = String(n);
  dom.racerS.textContent = n === 1 ? "" : "s";
}

// ───────────────────────────────────────────────────────────────────────────
// LEADERBOARD — persistent db collection "leaderboard"
//   one doc per handle: { handle, name, best_ms }
// ───────────────────────────────────────────────────────────────────────────
let lbCollection = null;
let lbDocId = null; // our own doc id once known
let lbRows = []; // [{handle,name,best_ms}]

async function initLeaderboard() {
  try {
    lbCollection = worlds.db.collection(LEADERBOARD);
  } catch (_) {
    return;
  }
  await refreshLeaderboard();
  // find our existing doc (so we update instead of duplicating)
  try {
    const mine = lbRows.find((r) => r.handle === me.handle);
    if (mine && mine._id) lbDocId = mine._id;
    if (mine && typeof mine.best_ms === "number") {
      lap.bestMs = mine.best_ms;
      updateHud();
    }
  } catch (_) {}
  // live updates
  try {
    lbCollection.subscribe(() => {
      refreshLeaderboard();
    });
  } catch (_) {}
}

async function refreshLeaderboard() {
  if (!lbCollection) return;
  try {
    const res = await lbCollection.list({ sort: "best_ms", limit: 100 });
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
    renderBoard();
  } catch (_) {}
}

let savingBest = false;
async function saveBest(ms) {
  if (!lbCollection || !me.handle) return;
  if (savingBest) return;
  savingBest = true;
  const payload = { handle: me.handle, name: me.name, best_ms: Math.round(ms) };
  try {
    if (!lbDocId) {
      // re-check in case our doc exists but wasn't matched yet
      try {
        const res = await lbCollection.list({ filter: { handle: me.handle }, limit: 1 });
        const found = res && res.items && res.items[0];
        if (found) lbDocId = found.id;
      } catch (_) {}
    }
    if (lbDocId) {
      await lbCollection.update(lbDocId, payload);
    } else {
      const doc = await lbCollection.create(payload);
      if (doc && doc.id) lbDocId = doc.id;
    }
    await refreshLeaderboard();
  } catch (_) {
    // best-effort; lap still recorded locally
  } finally {
    savingBest = false;
  }
}

function renderBoard() {
  if (!lbRows.length) {
    dom.boardList.innerHTML = '<li class="empty">no laps yet — be the first</li>';
    return;
  }
  const top = lbRows.slice(0, 8);
  // ensure self is shown even if outside top 8
  const selfRow = lbRows.find((r) => r.handle === me.handle);
  const selfRank = selfRow ? lbRows.indexOf(selfRow) + 1 : null;
  const showSelfExtra = selfRow && selfRank > 8;
  const html = top
    .map((r, i) => rowHtml(r, i + 1))
    .join("");
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
}
function updateLiveTimer(now) {
  if (!raceStarted) {
    dom.timer.textContent = "0:00.00";
    return;
  }
  const ms = now - lap.startMs;
  dom.timer.textContent = fmtTime(ms);
}
function fmtTime(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
function round3(n) {
  return Math.round(n * 1000) / 1000;
}
function num(v, fallback) {
  return typeof v === "number" && isFinite(v) ? v : fallback;
}
// ───────────────────────────────────────────────────────────────────────────
// LOBBY — waiting room driven entirely by worlds.room("race").
//   The room owns the live roster, per-player ready toggles, a stable host, and
//   start / auto-start (min 1 player, so solo still works). We just render its
//   snapshots and forward button presses; onStart fires on every client.
// ───────────────────────────────────────────────────────────────────────────
function renderLobby(s) {
  lobbySnap = s || lobbySnap;
  if (!lobbyActive || !lobbySnap) return;
  const members = (lobbySnap.members || []).slice().sort((a, b) => {
    // self first, then by name
    if (a.isMe) return -1;
    if (b.isMe) return 1;
    return (a.name || a.handle).localeCompare(b.name || b.handle);
  });
  const total = members.length;
  const readyN = members.filter((m) => m.ready).length;
  const host = lobbySnap.host;
  const hostName = host ? (host.name || host.handle) : me.name;
  dom.lobbySub.innerHTML =
    `${total} racer${total === 1 ? "" : "s"} here · ${readyN}/${total} ready · host <span class="host">${esc(hostName)}</span>`;

  dom.lobbyRoster.innerHTML = members
    .map((m) => {
      const nm = esc((m.name || m.handle).slice(0, 18));
      const tags = [];
      if (m.isMe) tags.push("you");
      if (m.isHost) tags.push("host");
      const tag = tags.length ? `<span class="tag">${tags.join(" · ")}</span>` : "";
      return `<li class="${m.isMe ? "me " : ""}${m.ready ? "ready" : ""}"><span class="dot"></span><span class="nm">${nm}${tag}</span><span class="st">${m.ready ? "ready" : "…"}</span></li>`;
    })
    .join("");

  dom.btnReady.classList.toggle("on", lobbySnap.ready);
  dom.btnReady.textContent = lobbySnap.ready ? "Ready ✓" : "I'm ready";

  const canStart = lobbySnap.isHost && lobbySnap.total >= 1;
  dom.btnStart.disabled = !canStart;
  if (lobbySnap.allReady) {
    dom.lobbyHint.textContent = "Everyone's ready — starting…";
  } else if (lobbySnap.isHost) {
    dom.lobbyHint.textContent = "You're the host — start any time, or wait for all ready.";
  } else {
    dom.lobbyHint.textContent = `Waiting for ${esc(hostName)} to start (or all ready).`;
  }
}

function toggleSelfReady() {
  if (lobby) lobby.toggleReady(); // room re-renders via onChange + auto-starts
}

function hostStart() {
  if (lobby) lobby.start(); // host-only; broadcasts start to everyone
}

// Begin the race locally. Fires from the room's onStart on EVERY client (host
// pressed start, or autoStart tripped when all-ready), so no broadcast here.
function beginRace() {
  if (raceBegun) return;
  raceBegun = true;
  lobbyActive = false;
  dom.lobby.classList.add("hide");
  document.body.classList.remove("lobby");
  setTimeout(() => { dom.lobby.style.display = "none"; }, 420);
  runCountdown();
}

// ───────────────────────────────────────────────────────────────────────────
// COUNTDOWN — 3 · 2 · 1 · GO before lap timing begins
// ───────────────────────────────────────────────────────────────────────────
function runCountdown() {
  const seq = ["3", "2", "1", "GO!"];
  let i = 0;
  function show() {
    if (i >= seq.length) {
      dom.countdown.style.display = "none";
      raceStarted = true;
      lap.armed = true;
      lap.prevSide = signedFinishDist(player.pos.x, player.pos.z);
      lap.startMs = performance.now();
      lap.count = 1; // we are on lap 1
      // arm the checkpoint ring for lap 1
      lap.nextCheckpoint = 0;
      lap.prevCpSide = signedCheckpointDist(checkpoints[0], player.pos.x, player.pos.z);
      refreshCheckpointVisuals();
      updateHud();
      toast("go! cross the line to set a lap");
      return;
    }
    const isGo = i === seq.length - 1;
    dom.cdNum.textContent = seq[i];
    dom.cdNum.classList.remove("pop", "go");
    void dom.cdNum.offsetWidth; // restart animation
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
  const w = window.innerWidth;
  const h = window.innerHeight;
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
  // identity
  try {
    if (window.worlds && worlds.ready) await worlds.ready;
  } catch (_) {}
  try {
    const info = await worlds.me();
    if (info && info.handle) {
      me.handle = info.handle;
      me.name = info.name || info.handle;
    }
  } catch (_) {
    me.handle = "anon-" + clientId.slice(0, 8);
    me.name = "guest";
    dom.loaderErr.textContent = "Playing anonymously — sign in to save your best laps.";
  }
  if (!me.handle) {
    me.handle = "anon-" + clientId.slice(0, 8);
    me.name = "guest";
  }
  me.color = colorForHandle(me.handle);

  dom.loaderWho.innerHTML = "ready · <b>" + esc(me.name) + "</b>";

  // build self kart now that we have a color/name
  makeSelfKart();
  updateHud();
  updateRacerCount();

  // realtime pose feed over worlds.actors (positions only — ready/host/start live in worlds.room)
  try {
    net = worlds.actors(CHANNEL, { rate: SEND_HZ });
    net.onChange(onActor);
    net.onLeave(onActorLeave);
    // announce ourselves immediately so peers spawn us before the first throttle tick
    publishPose();
  } catch (_) {
    /* still drivable solo */
  }

  // leaderboard (non-blocking)
  initLeaderboard();

  // ── lobby room: roster / ready / host / start (own channel so it never mixes
  // with the pose feed). minPlayers:1 keeps solo working; autoStart fires the
  // race once everyone present is ready. onStart runs on every client.
  try {
    lobby = worlds.room(ROOM, {
      channel: ROOM + "-lobby",
      me: { handle: me.handle, name: me.name },
      minPlayers: 1,
      autoStart: true,
      onChange: (s) => renderLobby(s),
      onStart: () => beginRace(),
      onReturn: () => {}, // racing never returns to the lobby mid-session
    });
  } catch (_) {
    /* room unavailable — fall through; solo can still self-start below */
  }

  // lobby wiring
  dom.btnReady.addEventListener("click", toggleSelfReady);
  dom.btnStart.addEventListener("click", hostStart);
  document.body.classList.add("lobby");
  if (lobby) {
    lobby.ready.then(() => renderLobby(lobby.snapshot())).catch(() => {});
  } else {
    // no room (offline): show a minimal solo lobby that starts on Ready
    dom.btnReady.removeEventListener("click", toggleSelfReady);
    dom.btnReady.addEventListener("click", () => beginRace());
    dom.lobbySub.textContent = "Solo session — press Ready to start.";
  }

  // start render loop + reveal lobby (karts idle at the start line until start)
  lastFrame = performance.now();
  requestAnimationFrame(frame);
  setTimeout(() => dom.loader.classList.add("hide"), 350);
})();
