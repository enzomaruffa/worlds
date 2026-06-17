// ───────────────────────────────────────────────────────────────────────────
// TUMBLE — 3D drag-and-drop level editor.
//
// Click a catalog item to drop it on the stage, click a piece to select it,
// drag it on the ground to move, tune height / rotation / size on the right.
// Build a level out of individual objects (platforms, hazards, pads, movers,
// decor), then DOWNLOAD a levels.json to drop into the tumble/ folder. The game
// loads it and derives all collision from the placed objects. Shares level.js
// with the game so the editor preview is exactly what you'll play.
// ───────────────────────────────────────────────────────────────────────────
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KINDS, instantiate, assetNames } from "./level.js";

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r2 = (n) => Math.round(n * 100) / 100;

const STARTER = () => [{
  name: "First Climb", hue: 0.55,
  objects: [
    { k: "start", x: 0, y: 0, z: 0 },
    { k: "platform", x: 0, y: 0, z: 22 },
    { k: "spinner", x: 0, y: 0, z: 22 },
    { k: "platform", x: 0, y: 0, z: 44 },
    { k: "jumppad", x: 0, y: 0.5, z: 44 },
    { k: "platform", x: 0, y: 4, z: 66 },
    { k: "finish", x: 0, y: 4, z: 86 },
  ],
}];

// ── state ────────────────────────────────────────────────────────────────────
let pack = load();
let cur = 0;          // selected level index
let sel = -1;         // selected object index
let placed = [];      // parallel to level().objects → { group }
let ASSETS = {};

function load() {
  try { const raw = localStorage.getItem("tumbleEditorPack3D"); if (raw) { const p = JSON.parse(raw); if (Array.isArray(p) && p.length) return p; } } catch (_) {}
  return STARTER();
}
function save() { try { localStorage.setItem("tumbleEditorPack3D", JSON.stringify(pack)); } catch (_) {} }
const level = () => pack[cur];
const objs = () => level().objects;

// ── three setup ──────────────────────────────────────────────────────────────
const canvas = $("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a16);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
camera.position.set(48, 44, -20);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 2, 40);
controls.enableDamping = true; controls.dampingFactor = 0.12;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20122e, 1.5));
const sun = new THREE.DirectionalLight(0xfff1d0, 1.3); sun.position.set(-30, 70, -10); scene.add(sun);
const grid = new THREE.GridHelper(400, 80, 0x2a2a3a, 0x18181f); grid.position.y = -0.5; scene.add(grid);

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.5); // y = -0.5 (top of pads sits ~0)
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const hitPt = new THREE.Vector3();
const selBox = new THREE.BoxHelper(new THREE.Object3D(), 0xfbbf24); selBox.visible = false; scene.add(selBox);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

// ── scene <-> objects ─────────────────────────────────────────────────────────
function clearScene() { for (const p of placed) scene.remove(p.group); placed = []; }
function rebuildAll() {
  clearScene();
  objs().forEach((o, i) => addGroup(o, i));
  selBox.visible = false; sel = -1;
}
function addGroup(o, i) {
  const built = instantiate(ASSETS, o);
  built.group.userData.idx = i;
  scene.add(built.group);
  placed[i] = { group: built.group };
}
function rebuild(i) { // re-instantiate one object (after size/param change)
  if (placed[i]) scene.remove(placed[i].group);
  addGroup(objs()[i], i);
  if (sel === i) { selBox.setFromObject(placed[i].group); selBox.visible = true; }
}
function reindex() { placed.forEach((p, i) => { if (p) p.group.userData.idx = i; }); }

// ── selection / placement / drag ───────────────────────────────────────────────
function setNDC(e) { const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); }
function pickObject(e) {
  setNDC(e); ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(placed.filter(Boolean).map((p) => p.group), true);
  if (!hits.length) return -1;
  let o = hits[0].object;
  while (o && o.userData.idx === undefined) o = o.parent;
  return o ? o.userData.idx : -1;
}
function groundAt(e) { setNDC(e); ray.setFromCamera(ndc, camera); return ray.ray.intersectPlane(groundPlane, hitPt) ? hitPt.clone() : null; }

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  const i = pickObject(e);
  if (i >= 0) { select(i); const g = groundAt(e); drag = { i, off: g ? { x: objs()[i].x - g.x, z: objs()[i].z - g.z } : { x: 0, z: 0 } }; controls.enabled = false; }
  else { select(-1); }
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const g = groundAt(e); if (!g) return;
  const o = objs()[drag.i];
  o.x = r2(g.x + drag.off.x); o.z = r2(g.z + drag.off.z);
  placed[drag.i].group.position.set(o.x, o.y || 0, o.z);
  selBox.setFromObject(placed[drag.i].group);
});
addEventListener("pointerup", () => { if (drag) { save(); syncExport(); } drag = null; controls.enabled = true; });

function select(i) {
  sel = i;
  if (i >= 0 && placed[i]) { selBox.setFromObject(placed[i].group); selBox.visible = true; }
  else selBox.visible = false;
  syncInspector();
}

addEventListener("keydown", (e) => {
  if ((e.key === "Delete" || e.key === "Backspace") && sel >= 0) { delObject(sel); }
});

// ── catalog palette ────────────────────────────────────────────────────────────
function buildCatalog() {
  const byCat = {};
  for (const [k, def] of Object.entries(KINDS)) { (byCat[def.cat] = byCat[def.cat] || []).push([k, def]); }
  const host = $("catalog"); host.innerHTML = "";
  for (const [catName, items] of Object.entries(byCat)) {
    const wrap = document.createElement("div"); wrap.className = "cat";
    const h = document.createElement("h4"); h.textContent = catName; wrap.appendChild(h);
    const pal = document.createElement("div"); pal.className = "pal";
    for (const [k, def] of items) {
      const b = document.createElement("button");
      const col = def.color != null ? "#" + (def.color >>> 0).toString(16).padStart(6, "0") : "#7dd3fc";
      b.innerHTML = `<span class="sw" style="background:${col}"></span>${def.label}`;
      b.onclick = () => addObject(k);
      pal.appendChild(b);
    }
    wrap.appendChild(pal); host.appendChild(wrap);
  }
}
function addObject(k) {
  const o = { k, x: r2(controls.target.x), y: KINDS[k].box ? 0 : 0, z: r2(controls.target.z), ry: 0 };
  const def = KINDS[k];
  if (def.box) { o.w = def.box[0]; o.h = def.box[1]; o.d = def.box[2]; }
  if (def.model) o.s = def.s || 2;
  if (def.p) o.p = JSON.parse(JSON.stringify(def.p));
  objs().push(o);
  addGroup(o, objs().length - 1);
  select(objs().length - 1);
  save(); syncExport();
}
function delObject(i) {
  scene.remove(placed[i].group); placed.splice(i, 1); objs().splice(i, 1);
  reindex(); select(-1); save(); syncExport();
}
function dupObject(i) {
  const o = JSON.parse(JSON.stringify(objs()[i])); o.x = r2(o.x + 4); o.z = r2(o.z + 4);
  objs().push(o); addGroup(o, objs().length - 1); select(objs().length - 1); save(); syncExport();
}

// ── inspector ──────────────────────────────────────────────────────────────────
function syncInspector() {
  const box = $("inspect");
  if (sel < 0) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const o = objs()[sel], def = KINDS[o.k];
  $("insKind").textContent = def.label;
  $("insY").value = o.y || 0; $("insYV").textContent = (o.y || 0).toFixed(1);
  $("insRot").value = o.ry || 0; $("insRotV").textContent = ((o.ry || 0) * 57.3).toFixed(0) + "°";
  // dynamic extras: size + kind params
  const ex = $("insExtra"); ex.innerHTML = "";
  if (def.box) {
    ex.appendChild(slider("Width", o.w, 2, 30, 0.5, (v) => { o.w = v; rebuild(sel); }));
    ex.appendChild(slider("Depth", o.d, 2, 30, 0.5, (v) => { o.d = v; rebuild(sel); }));
  } else if (def.model) {
    ex.appendChild(slider("Size", o.s, 0.5, 14, 0.5, (v) => { o.s = v; rebuild(sel); }));
  }
  o.p = o.p || {};
  if (o.k === "mover") {
    ex.appendChild(axisToggle(o));
    ex.appendChild(slider("Reach", o.p.amp ?? 7, 1, 20, 0.5, (v) => { o.p.amp = v; saveX(); }));
    ex.appendChild(slider("Speed", o.p.speed ?? 1, 0.2, 3, 0.1, (v) => { o.p.speed = v; saveX(); }));
  } else if (o.k === "jumppad") {
    ex.appendChild(slider("Boost", o.p.boost ?? 22, 10, 38, 1, (v) => { o.p.boost = v; saveX(); }));
  } else if (o.k === "spinner" || o.k === "sweeper") {
    ex.appendChild(slider("Speed", o.p.speed ?? 1.6, 0.4, 3.5, 0.1, (v) => { o.p.speed = v; saveX(); }));
  }
}
function saveX() { save(); syncExport(); }
function slider(label, val, min, max, step, on) {
  const row = document.createElement("div"); row.className = "row";
  row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${val}"><span class="val"></span>`;
  const inp = row.querySelector("input"), out = row.querySelector(".val");
  out.textContent = (+val).toFixed(step < 1 ? 1 : 0);
  inp.oninput = (e) => { const v = +e.target.value; out.textContent = v.toFixed(step < 1 ? 1 : 0); on(v); };
  return row;
}
function axisToggle(o) {
  const row = document.createElement("div"); row.className = "row";
  row.innerHTML = `<label>Axis</label><select><option value="x">side ↔</option><option value="z">forward ↕</option></select>`;
  const s = row.querySelector("select"); s.value = o.p.axis || "x";
  s.onchange = (e) => { o.p.axis = e.target.value; saveX(); };
  return row;
}
$("insY").addEventListener("input", (e) => { if (sel < 0) return; const o = objs()[sel]; o.y = +e.target.value; $("insYV").textContent = o.y.toFixed(1); placed[sel].group.position.y = o.y; selBox.setFromObject(placed[sel].group); saveX(); });
$("insRot").addEventListener("input", (e) => { if (sel < 0) return; const o = objs()[sel]; o.ry = +e.target.value; $("insRotV").textContent = (o.ry * 57.3).toFixed(0) + "°"; placed[sel].group.rotation.y = o.ry; selBox.setFromObject(placed[sel].group); saveX(); });
$("insDup").addEventListener("click", () => { if (sel >= 0) dupObject(sel); });
$("insDel").addEventListener("click", () => { if (sel >= 0) delObject(sel); });

// ── level pack ──────────────────────────────────────────────────────────────────
function syncLevelSelect() { $("lvlSel").innerHTML = pack.map((l, i) => `<option value="${i}">${i + 1}. ${escapeHtml(l.name || "level")}</option>`).join(""); $("lvlSel").value = String(cur); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function syncLevelMeta() { $("mName").value = level().name || ""; $("mHue").value = level().hue ?? 0.55; $("mHueV").textContent = (+(level().hue ?? 0.55)).toFixed(2); $("delLvl").disabled = pack.length <= 1; }
function switchLevel(i) { cur = i; sel = -1; rebuildAll(); syncLevelSelect(); syncLevelMeta(); syncInspector(); syncExport(); }

$("lvlSel").addEventListener("change", (e) => switchLevel(+e.target.value));
$("addLvl").addEventListener("click", () => { pack.push({ name: "Level " + (pack.length + 1), hue: r2(Math.random()), objects: [{ k: "start", x: 0, y: 0, z: 0 }, { k: "platform", x: 0, y: 0, z: 24 }, { k: "finish", x: 0, y: 0, z: 46 }] }); cur = pack.length - 1; switchLevel(cur); save(); });
$("dupLvl").addEventListener("click", () => { pack.splice(cur + 1, 0, JSON.parse(JSON.stringify(level()))); pack[cur + 1].name = (level().name || "Level") + " copy"; cur += 1; switchLevel(cur); save(); });
$("delLvl").addEventListener("click", () => { if (pack.length <= 1) return; pack.splice(cur, 1); cur = clamp(cur, 0, pack.length - 1); switchLevel(cur); save(); });
$("mName").addEventListener("input", (e) => { level().name = e.target.value; save(); syncLevelSelect(); syncExport(); });
$("mHue").addEventListener("input", (e) => { level().hue = +e.target.value; $("mHueV").textContent = (+e.target.value).toFixed(2); save(); syncExport(); });

// ── export / preview ──────────────────────────────────────────────────────────
function exportObj() {
  return { levels: pack.map((l) => ({ name: l.name || "Level", hue: r2(l.hue ?? 0.55), objects: l.objects.map(cleanObj) })) };
}
function cleanObj(o) {
  const out = { k: o.k, x: r2(o.x || 0), y: r2(o.y || 0), z: r2(o.z || 0) };
  if (o.ry) out.ry = r2(o.ry);
  if (o.w != null) { out.w = r2(o.w); out.h = r2(o.h); out.d = r2(o.d); }
  if (o.s != null) out.s = r2(o.s);
  if (o.p && Object.keys(o.p).length) out.p = o.p;
  return out;
}
function exportText() { return JSON.stringify(exportObj(), null, 2); }
function syncExport() { $("export").value = exportText(); }

$("previewBtn").addEventListener("click", () => {
  try { localStorage.setItem("tumblePreviewLevels", JSON.stringify([exportObj().levels[cur]])); } catch (_) {}
  window.open("index.html?preview=1", "_blank");
});
$("copyBtn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(exportText()); flash($("copyBtn"), "Copied!"); }
  catch (_) { $("export").select(); document.execCommand("copy"); flash($("copyBtn"), "Copied!"); }
});
$("dlBtn").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([exportText()], { type: "application/json" }));
  a.download = "levels.json"; a.click(); URL.revokeObjectURL(a.href);
  flash($("dlBtn"), "Saved ⬇");
});
function flash(btn, txt) { const o = btn.textContent; btn.textContent = txt; setTimeout(() => (btn.textContent = o), 1100); }

// ── 🌐 shared library (worlds.db — live, deploy-free) ──────────────────────────
let levelsCol = null;
async function initShared() {
  try { await worlds.ready; levelsCol = worlds.db.collection("levels"); } catch (_) { return; }
  refreshShared();
  try { levelsCol.subscribe(() => refreshShared()); } catch (_) {}
}
$("pubBtn").addEventListener("click", async () => {
  if (!levelsCol) { flash($("pubBtn"), "sign in to publish"); return; }
  const data = exportObj().levels[cur]; // {name, hue, objects}
  try {
    const did = level()._docId;
    if (did) { await levelsCol.update(did, data); flash($("pubBtn"), "Updated for all ✓"); }
    else { const doc = await levelsCol.create(data); level()._docId = doc.id; save(); flash($("pubBtn"), "Published to all ✓"); }
    refreshShared();
  } catch (_) { flash($("pubBtn"), "publish failed"); }
});
function refreshShared() {
  const host = $("sharedList"); if (!host || !levelsCol) return;
  levelsCol.list({ limit: 100 }).then((res) => {
    const items = res.items || [];
    if (!items.length) { host.innerHTML = '<span class="note">nothing published yet — be the first!</span>'; return; }
    host.innerHTML = "";
    for (const it of items) {
      const row = document.createElement("div"); row.className = "row"; row.style.margin = "0";
      const nm = (it.data && it.data.name) || "level";
      const mine = it.id === (level() && level()._docId);
      row.innerHTML = `<span style="flex:1;min-width:0;font-size:.8rem;color:${mine ? "var(--gold-bright)" : "var(--muted)"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(nm)}</span>`;
      const edit = document.createElement("button"); edit.textContent = "Edit"; edit.style.cssText = "flex:0;min-width:0;padding:.25rem .5rem;font-size:.74rem";
      edit.onclick = () => loadShared(it);
      const del = document.createElement("button"); del.textContent = "✕"; del.className = "danger"; del.style.cssText = "flex:0;min-width:0;padding:.25rem .5rem;font-size:.74rem";
      del.onclick = async () => { try { await levelsCol.delete(it.id); refreshShared(); } catch (_) {} };
      row.append(edit, del); host.appendChild(row);
    }
  }).catch(() => {});
}
function loadShared(it) {
  const d = it.data || {};
  pack.push({ name: d.name || "level", hue: d.hue ?? 0.55, objects: Array.isArray(d.objects) ? JSON.parse(JSON.stringify(d.objects)) : [], _docId: it.id });
  cur = pack.length - 1; sel = -1; switchLevel(cur); save();
}

// ── loop + boot ──────────────────────────────────────────────────────────────────
function tick() { requestAnimationFrame(tick); controls.update(); renderer.render(scene, camera); }
async function boot() {
  resize();
  const loader = new GLTFLoader();
  await Promise.all(assetNames().map(async (n) => {
    try { const g = await loader.loadAsync(`./assets/${n}.glb`); ASSETS[n] = g.scene; } catch (e) { console.warn("asset", n, e && e.message); }
  }));
  $("loading").style.display = "none";
  buildCatalog();
  rebuildAll();
  syncLevelSelect(); syncLevelMeta(); syncInspector(); syncExport();
  initShared();
  tick();
}
boot();
