import * as THREE from "three";

// ───────────────────────────────────────────────────────────────────────────
// Kart Loop — low-poly arcade multiplayer racing on the Worlds platform.
//
// Worlds SDK is the ONLY backend:
//   ws channel "race"  — ephemeral pose broadcasts (~14/s), echoes to self.
//   db collection "leaderboard" — one persistent doc per handle: best lap.
// Each tab gets a clientId; we ignore our own echoed poses by clientId.
// ───────────────────────────────────────────────────────────────────────────

const CHANNEL = "race";
const LEADERBOARD = "leaderboard";
const SEND_HZ = 14; // pose broadcasts per second (SDK asks for 12-15)
const STALE_MS = 5000; // drop a remote kart unheard-from this long
const POSE_LERP = 12; // remote position smoothing rate
const HEAD_LERP = 10; // remote heading smoothing rate

const clientId =
  (crypto.randomUUID && crypto.randomUUID()) ||
  Date.now().toString(36) + Math.random().toString(36).slice(2);

// ── Player identity (filled from worlds.me, with anonymous fallback) ────────
const me = { handle: null, name: "you", color: 0xfbbf24 };

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
  toast: $("toast"),
  countdown: $("countdown"),
  cdNum: $("cdNum"),
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

// Hand-placed control points forming a flowing loop with varied turns.
const CONTROL_POINTS = [
  [0, 0, 60],
  [42, 0, 52],
  [62, 0, 18],
  [50, 0, -22],
  [70, 0, -54],
  [40, 0, -78],
  [-2, 0, -70],
  [-20, 0, -40],
  [-50, 0, -48],
  [-72, 0, -14],
  [-58, 0, 26],
  [-30, 0, 30],
  [-44, 0, 60],
  [-20, 0, 82],
].map((p) => new THREE.Vector3(p[0], p[1], p[2]));

const curve = new THREE.CatmullRomCurve3(CONTROL_POINTS, true, "catmullrom", 0.5);
const TRACK_LEN = curve.getLength();
const SAMPLES = 600;
// Precompute sampled centerline + tangents (arc-length parameterized).
const centerPts = curve.getSpacedPoints(SAMPLES); // length SAMPLES+1, closed
const tangents = [];
for (let i = 0; i <= SAMPLES; i++) {
  tangents.push(curve.getTangentAt((i % SAMPLES) / SAMPLES).normalize());
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
  g.position.y = -0.02;
  g.receiveShadow = true;
  scene.add(g);
}

// ── Build the road ribbon + curbs as one mesh each ──────────────────────────
function buildTrack() {
  const up = new THREE.Vector3(0, 1, 0);
  const left = []; // inner edge of road
  const right = []; // outer edge of road
  const curbL = [];
  const curbR = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const c = centerPts[i % SAMPLES];
    const t = tangents[i % SAMPLES];
    const n = new THREE.Vector3().crossVectors(up, t).normalize(); // side normal
    left.push(c.clone().addScaledVector(n, ROAD_HALF));
    right.push(c.clone().addScaledVector(n, -ROAD_HALF));
    curbL.push(c.clone().addScaledVector(n, ROAD_HALF + CURB_W));
    curbR.push(c.clone().addScaledVector(n, -ROAD_HALF - CURB_W));
  }

  // Road surface: triangle strip between left/right.
  const roadGeo = new THREE.BufferGeometry();
  const rv = [];
  const ruv = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const a = left[i];
    const b = right[i];
    rv.push(a.x, 0.01, a.z, b.x, 0.01, b.z);
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

  // Center dashed line via small white quads every few samples.
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xe8e8ec });
  const dashGeo = new THREE.PlaneGeometry(0.35, 3.2);
  const dashCount = 90;
  const dash = new THREE.InstancedMesh(dashGeo, dashMat, dashCount);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (let d = 0; d < dashCount; d++) {
    const i = Math.floor((d / dashCount) * SAMPLES);
    const c = centerPts[i];
    const t = tangents[i];
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), t.clone().setY(0).normalize());
    const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    q.multiply(flat);
    m.compose(new THREE.Vector3(c.x, 0.03, c.z), q, new THREE.Vector3(1, 1, 1));
    dash.setMatrixAt(d, m);
  }
  dash.instanceMatrix.needsUpdate = true;
  scene.add(dash);

  // Curbs: alternating red/white strips along both edges.
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
      pos.push(a.x, 0.04, a.z, b.x, 0.04, b.z);
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

  return { left, right, curbL, curbR };
}
const trackEdges = buildTrack();

// ── Start/finish line: a checkered band laid across the road at sample 0 ────
const FINISH_INDEX = 0;
let finishNormal, finishCenter, finishForward;
{
  const c = centerPts[FINISH_INDEX];
  const t = tangents[FINISH_INDEX];
  finishCenter = c.clone();
  finishForward = t.clone().setY(0).normalize();
  finishNormal = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), t).normalize();

  const cols = 14;
  const tileW = (ROAD_HALF * 2) / cols;
  const tileL = 3.2;
  const group = new THREE.Group();
  const matA = new THREE.MeshBasicMaterial({ color: 0xf4f4f6 });
  const matB = new THREE.MeshBasicMaterial({ color: 0x18181b });
  for (let r = 0; r < 2; r++) {
    for (let col = 0; col < cols; col++) {
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(tileW, tileL),
        (r + col) % 2 === 0 ? matA : matB,
      );
      tile.rotation.x = -Math.PI / 2;
      const along = finishForward.clone().multiplyScalar((r - 0.5) * tileL);
      const side = finishNormal.clone().multiplyScalar(ROAD_HALF - tileW * (col + 0.5));
      tile.position.set(c.x + side.x + along.x, 0.05, c.z + side.z + along.z);
      // align tile rows with track direction
      tile.rotation.z = Math.atan2(finishNormal.x, finishNormal.z);
      group.add(tile);
    }
  }
  scene.add(group);

  // Start gantry: two posts + banner over the line.
  const postMat = new THREE.MeshLambertMaterial({ color: 0x27272a });
  const bannerMat = new THREE.MeshLambertMaterial({ color: 0xf59e0b });
  for (const s of [1, -1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 9, 0.7), postMat);
    const off = finishNormal.clone().multiplyScalar(s * (ROAD_HALF + 0.6));
    post.position.set(c.x + off.x, 4.5, c.z + off.z);
    post.castShadow = true;
    scene.add(post);
  }
  const banner = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2 + 1.6, 1.8, 0.5), bannerMat);
  banner.position.set(c.x, 9, c.z);
  banner.rotation.y = Math.atan2(finishForward.x, finishForward.z);
  banner.castShadow = true;
  scene.add(banner);
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
    m.makeTranslation(edge.x + n.x, 0.65, edge.z + n.z);
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
    mt.compose(new THREE.Vector3(x, 1.3 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    trunks.setMatrixAt(placed, mt);
    ml.compose(new THREE.Vector3(x, (2.6 + 1.6) * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
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
    const base = new THREE.Mesh(new THREE.BoxGeometry(18, 4, 7), standMat);
    base.position.set(c.x + n.x, 2, c.z + n.z);
    base.lookAt(c.x, 2, c.z);
    base.castShadow = true;
    base.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(18.5, 0.5, 7.5), roofMat);
    roof.position.set(c.x + n.x, 4.6, c.z + n.z);
    roof.lookAt(c.x, 4.6, c.z);
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
  const bodyMat = new THREE.MeshLambertMaterial({ color: colorHex });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x18181b });
  const tireMat = new THREE.MeshLambertMaterial({ color: 0x0e0e10 });
  const trimMat = new THREE.MeshLambertMaterial({ color: 0xfafafa });

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.45, 3.0), bodyMat);
  chassis.position.y = 0.55;
  chassis.castShadow = true;
  group.add(chassis);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.35, 0.9), bodyMat);
  nose.position.set(0, 0.5, 1.7);
  nose.castShadow = true;
  group.add(nose);

  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.55, 1.2), darkMat);
  cockpit.position.set(0, 0.95, -0.1);
  cockpit.castShadow = true;
  group.add(cockpit);

  // seat headrest + roll hoop hint
  const hoop = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.25), bodyMat);
  hoop.position.set(0, 1.25, -0.75);
  hoop.castShadow = true;
  group.add(hoop);

  // rear wing
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 0.6), trimMat);
  wing.position.set(0, 1.15, -1.55);
  wing.castShadow = true;
  group.add(wing);
  for (const s of [0.7, -0.7]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), darkMat);
    strut.position.set(s, 0.9, -1.55);
    group.add(strut);
  }

  // wheels
  const wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.4, 12);
  const wheels = [];
  const wx = 0.95;
  const wz = 1.05;
  for (const [sx, sz] of [
    [wx, wz],
    [-wx, wz],
    [wx, -wz],
    [-wx, -wz],
  ]) {
    const w = new THREE.Mesh(wheelGeo, tireMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(sx, 0.45, sz);
    w.castShadow = true;
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
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const aspect = cv.width / cv.height;
  sprite.scale.set(2.6 * aspect, 2.6, 1);
  sprite.position.y = 3.0;
  sprite.renderOrder = 10;
  return sprite;
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
  mesh: null,
  label: null,
};

// Spawn slightly behind the finish line, facing along the track direction.
{
  const back = finishForward.clone().multiplyScalar(-6);
  player.pos.set(finishCenter.x + back.x, 0, finishCenter.z + back.z);
  player.heading = Math.atan2(finishForward.x, finishForward.z);
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
};

function makeSelfKart() {
  player.mesh = makeKart(me.color);
  player.label = makeLabel(me.name + " (you)");
  player.mesh.add(player.label);
  scene.add(player.mesh);
}

// ── Remote karts ─────────────────────────────────────────────────────────
// handle -> { mesh, label, target:{x,z,ry,speed}, name, color, at }
const remotes = new Map();

function ensureRemote(handle, name, colorHex) {
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
      cur: new THREE.Vector3(),
      target: new THREE.Vector3(),
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
function removeRemote(handle) {
  const r = remotes.get(handle);
  if (!r) return;
  scene.remove(r.mesh);
  r.label.material.map?.dispose();
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
// LAP detection — cross the finish band in the forward track direction.
// We track the signed distance to the finish plane each frame; a sign flip
// from behind→ahead while near the line, moving forward, counts as a lap.
// ───────────────────────────────────────────────────────────────────────────
const lap = {
  count: 0,
  startMs: 0, // current lap start timestamp
  bestMs: null,
  lastMs: null,
  prevSide: null, // sign of distance to finish plane last frame
  armed: false, // must travel away from the line before a lap can re-count
  wrongWay: false,
};

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

let raceStarted = false; // gate lap timing until countdown finishes
function onCrossFinish(forward, now) {
  if (!raceStarted) return;
  if (!forward) {
    flashToast("↺ turn around");
    return;
  }
  if (lap.count > 0) {
    // completed a lap
    const ms = now - lap.startMs;
    lap.lastMs = ms;
    if (lap.bestMs == null || ms < lap.bestMs) {
      lap.bestMs = ms;
      dom.last.textContent = "last " + fmtTime(ms) + "  ★ best!";
      dom.last.classList.add("good");
      saveBest(ms);
      flashToast("🏁 new best · " + fmtTime(ms));
    } else {
      dom.last.textContent = "last " + fmtTime(ms);
      dom.last.classList.remove("good");
      flashToast("lap " + lap.count + " · " + fmtTime(ms));
    }
  }
  lap.count++;
  lap.startMs = now;
  updateHud();
}

// ───────────────────────────────────────────────────────────────────────────
// GAME LOOP
// ───────────────────────────────────────────────────────────────────────────
let lastFrame = performance.now();
const tmpCamPos = new THREE.Vector3();
const tmpLook = new THREE.Vector3();

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  stepPhysics(dt, now);
  stepRemotes(dt);
  updateCamera(dt);
  maybeSendPose(now);
  pruneRemotes(now);
  updateLiveTimer(now);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function stepPhysics(dt, now) {
  // ── longitudinal ──
  const throttling = input.up;
  const braking = input.down;
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
  const steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
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

  // mesh transform
  if (player.mesh) {
    player.mesh.position.set(player.pos.x, 0, player.pos.z);
    player.mesh.rotation.y = player.heading;
    // body roll on turns
    player.mesh.rotation.z = -player.lateral * 0.18;
    // tiny pitch under accel/brake
    const pitch = (throttling ? -0.04 : braking ? 0.05 : 0) * speedFrac;
    player.mesh.rotation.x = pitch;
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
    r.mesh.position.set(r.cur.x, 0, r.cur.z);
    r.mesh.rotation.y = r.curHeading;
    const spin = r.speed * dt * 2.2;
    for (const w of r.mesh.userData.allWheels) w.rotation.x += spin;
  }
}

function updateCamera(dt) {
  if (!player.mesh) return;
  const fx = Math.sin(player.heading);
  const fz = Math.cos(player.heading);
  // chase position: behind + above the kart
  const speedZoom = 1 + Math.min(1, Math.abs(player.vel) / PHYS.maxSpeed) * 0.4;
  const back = 9.5 * speedZoom;
  const height = 5.2;
  tmpCamPos.set(
    player.pos.x - fx * back,
    height,
    player.pos.z - fz * back,
  );
  // smooth follow (lag)
  const follow = 1 - Math.pow(0.0009, dt); // frame-rate independent smoothing
  camera.position.lerp(tmpCamPos, follow);
  // look slightly ahead of the kart
  tmpLook.set(player.pos.x + fx * 5, 1.4, player.pos.z + fz * 5);
  camera.lookAt(tmpLook);
  // keep the sun shadow frustum centered on the action
  sun.position.set(player.pos.x + 70, 120, player.pos.z + 50);
  sun.target.position.set(player.pos.x, 0, player.pos.z);
}

function pruneRemotes(now) {
  for (const [h, r] of remotes) {
    if (now - r.at > STALE_MS) removeRemote(h);
  }
  updateRacerCount();
}

// ───────────────────────────────────────────────────────────────────────────
// MULTIPLAYER — ws channel "race"
//   pose message: { cid, t:"pose", handle, name, x, z, ry, speed, color }
// ───────────────────────────────────────────────────────────────────────────
let room = null;
let lastSendAt = 0;

function maybeSendPose(now) {
  if (!room) return;
  if (now - lastSendAt < 1000 / SEND_HZ) return;
  lastSendAt = now;
  try {
    room.publish({
      cid: clientId,
      t: "pose",
      handle: me.handle,
      name: me.name,
      x: round3(player.pos.x),
      z: round3(player.pos.z),
      ry: round3(player.heading),
      speed: round3(player.vel),
      color: me.color,
    });
  } catch (_) {
    /* SDK buffers / reconnects */
  }
}

function onPose(msg) {
  const p = msg && msg.payload;
  if (!p || typeof p !== "object") return;
  if (p.cid === clientId) return; // our own echo
  if (p.t !== "pose") return;
  const handle = p.handle || (msg.from && msg.from.handle);
  if (!handle || handle === me.handle) return; // never render our own handle
  const name = typeof p.name === "string" ? p.name : (msg.from && msg.from.name) || handle;
  const colorHex = typeof p.color === "number" ? p.color : colorForHandle(handle);
  const r = ensureRemote(handle, name, colorHex);
  // (re)apply color/name if changed
  if (r.color !== colorHex) {
    r.color = colorHex;
    r.mesh.userData.bodyMat.color.setHex(colorHex);
  }
  const x = num(p.x, r.target.x);
  const z = num(p.z, r.target.z);
  const ry = num(p.ry, r.targetHeading);
  r.target.set(x, 0, z);
  r.targetHeading = ry;
  r.speed = num(p.speed, 0);
  r.at = performance.now();
  if (!r.init) {
    // first packet: snap so we don't lerp from origin
    r.cur.copy(r.target);
    r.curHeading = ry;
    r.mesh.position.set(x, 0, z);
    r.mesh.rotation.y = ry;
    r.init = true;
  }
  updateRacerCount();
}

function onPresence(members) {
  if (!Array.isArray(members)) return;
  const present = new Set(members.map((m) => m && m.handle).filter(Boolean));
  for (const h of [...remotes.keys()]) {
    if (!present.has(h)) removeRemote(h);
  }
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
  const name = escapeHtml((r.name || "racer").slice(0, 16));
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
let toastTimer = null;
function flashToast(text) {
  dom.toast.textContent = text;
  dom.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove("show"), 2200);
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
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
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
      updateHud();
      flashToast("go! cross the line to set a lap");
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

  dom.loaderWho.innerHTML = "ready · <b>" + escapeHtml(me.name) + "</b>";

  // build self kart now that we have a color/name
  makeSelfKart();
  updateHud();
  updateRacerCount();

  // realtime
  try {
    room = worlds.ws.channel(CHANNEL);
    room.subscribe(onPose);
    room.presence(onPresence);
    // announce our presence immediately so peers spawn us before first throttle tick
    room.publish({
      cid: clientId,
      t: "pose",
      handle: me.handle,
      name: me.name,
      x: round3(player.pos.x),
      z: round3(player.pos.z),
      ry: round3(player.heading),
      speed: 0,
      color: me.color,
    });
  } catch (_) {
    /* still drivable solo */
  }

  // leaderboard (non-blocking)
  initLeaderboard();

  // start render loop + hide loader + countdown
  lastFrame = performance.now();
  requestAnimationFrame(frame);
  setTimeout(() => dom.loader.classList.add("hide"), 350);
  setTimeout(runCountdown, 700);
})();
