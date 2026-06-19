import * as THREE from "three";
import * as W from "./world.js";
import * as Grass from "./grass.js";
import * as Sky from "./sky.js";
import * as Sim from "./sim.js";
import * as El from "./elements.js";
import * as Life from "./life.js";

// ───────────────────────────────────────────────────────────────────────────
// SWARD — a multiplayer 3D incremental grass-plot game on Worlds.
// You own an empty patch of land. Clean the dirt, grow real 3D grass, and plant
// a tiny ecosystem that evolves through living seasons under a sweeping sun.
// main.js boots the world, owns the RAF loop, and glues the systems together.
// ───────────────────────────────────────────────────────────────────────────

const { id, esc, toast, colorFor } = worlds;

const $ = (x) => document.getElementById(x);
const dom = {
  canvas: $("scene"),
  ownerName: $("ownerName"), ownerDot: $("ownerDot"),
  dewN: $("dewN"), sporeN: $("sporeN"), ecoN: $("ecoN"), ecoBar: $("ecoBar").firstElementChild,
  hint: $("hint"), msgTxt: $("msgTxt"), paletteRow: $("paletteRow"), inspect: $("inspect"),
  seasonN: $("seasonN"), todN: $("todN"), yearN: $("yearN"), sunIcon: $("sunIcon"),
  muteBtn: $("muteBtn"), questBtn: $("questBtn"), marketBtn: $("marketBtn"),
  loader: $("loader"), loaderWho: $("loaderWho"), loaderErr: $("loaderErr"),
};

// Shared, mutable game state — populated across systems. Persisted via net.js (C6).
export const G = {
  me: { handle: "you", name: "you", color: "hsl(110 60% 55%)" },
  color3: new THREE.Color(0x6cc24a),
  plotIndex: 0, plotSeed: 1,
  dew: 0, spores: 0, ecoLevel: 0,
  tool: "rake",          // current palette selection
  visiting: null,        // handle of a neighbor we're viewing, or null
  booted: false,
};

const SEED_COST = 4, WATER_COST = 2;
const TOOLS = [
  { key: "rake",  ic: "🧹", nm: "Rake",  cost: 0,         hint: "click debris to clear it for 💧", r: 1.0 },
  { key: "seed",  ic: "🌱", nm: "Seed",  cost: SEED_COST, hint: "plant a patch of grass", r: 2.2 },
  { key: "water", ic: "💧", nm: "Water", cost: WATER_COST, hint: "water the soil — faster, lusher growth", r: 2.4 },
];

const fmt = (n) => {
  n = Math.floor(n);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "b";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "m";
  if (n >= 1e4) return (n / 1e3).toFixed(1) + "k";
  return String(n);
};
function flash(text) { dom.msgTxt.textContent = text; dom.msgTxt.classList.remove("show"); void dom.msgTxt.offsetWidth; dom.msgTxt.classList.add("show"); }
export const helpers = { flash, toast, esc, fmt };

// ── HUD ────────────────────────────────────────────────────────────────────
function updateWallet() {
  dom.dewN.textContent = fmt(G.dew);
  dom.sporeN.textContent = fmt(G.spores);
  dom.ecoN.textContent = G.ecoLevel;
  dom.ecoBar.style.width = (Sim.greenPct() * 100).toFixed(0) + "%";
}
function updateClockHud() {
  dom.seasonN.textContent = Sky.seasonName();
  dom.todN.textContent = Sky.todName();
  dom.yearN.textContent = "Year " + Sky.yearNum();
  dom.sunIcon.textContent = Sky.sunIcon();
}

// ── palette (tools now; features added in C5) ────────────────────────────────
function buildPalette() {
  dom.paletteRow.innerHTML = "";
  const add = (key, ic, nm, cost) => {
    const el = document.createElement("div");
    el.className = "tool" + (G.tool === key ? " sel" : "");
    el.dataset.tool = key; el.dataset.cost = cost;
    el.innerHTML = `<span class="ic">${ic}</span><span class="nm">${nm}</span><span class="cost">${cost ? cost + " 💧" : "free"}</span>`;
    el.addEventListener("click", () => selectTool(key));
    dom.paletteRow.appendChild(el);
  };
  for (const t of TOOLS) add(t.key, t.ic, t.nm, t.cost);
  const div = document.createElement("div"); div.style = "width:1px;background:var(--border-soft);margin:.1rem .15rem;flex:none"; dom.paletteRow.appendChild(div);
  for (const k of El.FEATURE_KEYS) { const f = El.FEATURES[k]; add("feat:" + k, f.icon, f.name, f.cost); }
  refreshPaletteAfford();
}
function selectTool(key) {
  G.tool = key;
  for (const el of dom.paletteRow.children) el.classList.toggle("sel", el.dataset.tool === key);
  const t = TOOLS.find((x) => x.key === key);
  if (t) dom.hint.textContent = t.hint;
  else if (key.startsWith("feat:")) { const f = El.FEATURES[key.slice(5)]; dom.hint.textContent = `click to place a ${f.name.toLowerCase()} · grab & drag to reposition · tap it to inspect`; }
}
function toolCost(key) { if (key && key.startsWith("feat:")) return El.FEATURES[key.slice(5)].cost; const t = TOOLS.find((x) => x.key === key); return t ? t.cost : 0; }
function refreshPaletteAfford() {
  for (const el of dom.paletteRow.children) {
    const c = el.querySelector(".cost"); if (!c) continue;
    const cost = +el.dataset.cost || 0;
    if (cost) c.classList.toggle("cant", G.dew < cost);
  }
}

// ── upgrade shop (toolbar 🛠) ─────────────────────────────────────────────────
let shopEl = null;
function buildShop() {
  const btn = document.createElement("button");
  btn.className = "iconbtn"; btn.id = "shopBtn"; btn.title = "upgrades"; btn.textContent = "🛠";
  dom.muteBtn.parentElement.insertBefore(btn, dom.muteBtn);
  shopEl = document.createElement("div");
  shopEl.className = "panel"; shopEl.id = "shop";
  shopEl.style = "position:fixed;right:.7rem;bottom:4.4rem;z-index:8;width:16rem;max-width:90vw;padding:.7rem .8rem;display:none";
  document.getElementById("app").appendChild(shopEl);
  btn.addEventListener("click", () => { shopEl.style.display = shopEl.style.display === "none" ? "block" : "none"; renderShop(); });
}
function renderShop() {
  if (!shopEl || shopEl.style.display === "none") return;
  let html = `<h3 style="margin:0 0 .5rem;font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)">upgrades</h3>`;
  for (const key of Object.keys(Sim.UPGRADES)) {
    const u = Sim.UPGRADES[key], lvl = Sim.S.upgrades[key] || 0, maxed = Sim.upgradeMaxed(key), cost = Sim.upgradeCost(key);
    const can = !maxed && G.dew >= cost;
    html += `<div style="display:flex;gap:.5rem;align-items:center;margin:.35rem 0">
      <span style="font-size:1.3rem">${u.icon}</span>
      <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:.82rem">${u.name} <span style="color:var(--dim);font-weight:400">${lvl}/${u.max}</span></div>
      <div style="font-size:.68rem;color:var(--muted);line-height:1.3">${u.desc}</div></div>
      <button data-up="${key}" ${maxed ? "disabled" : ""} style="pointer-events:auto;cursor:pointer;font-family:inherit;font-size:.72rem;font-weight:700;padding:.32rem .5rem;border-radius:.5rem;border:1px solid ${can ? "var(--leaf)" : "var(--border)"};background:${can ? "rgba(108,194,74,.18)" : "rgba(11,18,13,.6)"};color:${maxed ? "var(--dim)" : can ? "var(--leaf-bright)" : "var(--bloom)"}">${maxed ? "max" : fmt(cost) + " 💧"}</button>
    </div>`;
  }
  shopEl.innerHTML = html;
  for (const b of shopEl.querySelectorAll("button[data-up]")) {
    b.addEventListener("click", () => {
      if (Sim.buyUpgrade(b.dataset.up)) { toast(Sim.UPGRADES[b.dataset.up].name + " upgraded!"); updateWallet(); renderShop(); }
      else toast("not enough 💧");
    });
  }
}

// ── input: grab features to move, tap to act/inspect, drag empty to orbit ─────
let pointer = { x: 0, y: 0, on: false }, down = null, grab = null;
dom.canvas.addEventListener("pointermove", (e) => {
  pointer.x = e.clientX; pointer.y = e.clientY; pointer.on = true;
  if (grab) {
    const g = W.pickGround(e.clientX, e.clientY);
    if (g && W.insidePlot(g.x, g.z)) { Sim.moveFeature(grab.id, g.x, g.z); grab.moved = grab.moved || Math.hypot(e.clientX - grab.sx, e.clientY - grab.sy) > 6; }
  }
});
dom.canvas.addEventListener("pointerleave", () => { pointer.on = false; });
dom.canvas.addEventListener("pointerdown", (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (G.visiting) return;
  const hit = W.pickObjects(e.clientX, e.clientY, Sim.featureRoots);
  if (hit && hit.kind === "feature") { grab = { id: hit.pickId, sx: e.clientX, sy: e.clientY, moved: false }; W.setControlsEnabled(false); }
});
dom.canvas.addEventListener("pointerup", (e) => {
  if (grab) {
    W.setControlsEnabled(true);
    if (!grab.moved) showInspect(grab.id); else { saveSoon(); hideInspect(); }
    grab = null; down = null; return;
  }
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), held = performance.now() - down.t;
  down = null;
  if (moved < 7 && held < 450) applyAt(e.clientX, e.clientY);
});

function applyAt(cx, cy) {
  if (G.visiting) return;
  const tool = G.tool || "rake";
  if (tool === "rake") {
    const hit = W.pickObjects(cx, cy, Sim.roots);
    if (hit && hit.kind === "debris") { const r = Sim.clearDebris(hit.pickId); if (r) { flash("+" + r + " 💧"); updateWallet(); } }
    else hideInspect();
    return;
  }
  const g = W.pickGround(cx, cy);
  if (!g || !W.insidePlot(g.x, g.z)) { hideInspect(); return; }
  if (tool === "seed") {
    if (G.dew < SEED_COST) return toast("need " + SEED_COST + " 💧");
    if (Sim.seedPatch(g.x, g.z, 2.2, 0.34)) { G.dew -= SEED_COST; Grass.rebuild(); updateWallet(); }
  } else if (tool === "water") {
    if (G.dew < WATER_COST) return toast("need " + WATER_COST + " 💧");
    Sim.waterPatch(g.x, g.z, 2.4); G.dew -= WATER_COST; updateWallet();
  } else if (tool.startsWith("feat:")) {
    const kind = tool.slice(5), cost = El.FEATURES[kind].cost;
    if (G.dew < cost) return toast("need " + cost + " 💧");
    const f = Sim.placeFeature(kind, g.x, g.z);
    if (f) { Life.sync(); updateWallet(); flash(El.FEATURES[kind].icon); showInspect(f.id); }
  }
}

// ── inspect panel: stage + what it needs to evolve ───────────────────────────
function gateHint(kind, stage, x, z, season) {
  const f = El.FEATURES[kind]; const st = f.stages[stage];
  if (!st || stage >= f.stages.length - 1) return "fully grown 🎉";
  const g = st.gate, fx = Sim.fieldsAt(x, z), needs = [];
  if (g) {
    if (g.shade) needs.push(fx.shade >= 0.25 ? "✓ in shade" : "✗ needs tree shade");
    if (g.moist) needs.push(fx.moist >= 0.25 ? "✓ moist" : "✗ needs water nearby");
    if (g.pollen) needs.push(fx.pollen >= 0.25 ? "✓ pollinated" : "✗ needs a hive in range");
    if (g.nectar) needs.push(fx.nectar >= 0.25 ? "✓ flowers in range" : "✗ needs blooming flowers nearby");
    if (g.season) needs.push(g.season.includes(season) ? "✓ in season" : "✗ waits for " + g.season.map((i) => ["spring", "summer", "autumn", "winter"][i]).join("/"));
    if (g.notSeason) needs.push(g.notSeason.includes(season) ? "✗ dormant this season" : "✓ growing");
  }
  return "growing… " + (needs.length ? needs.join(" · ") : "just needs time");
}
function showInspect(id) {
  const f = Sim.featureById(id); if (!f) return hideInspect();
  const def = El.FEATURES[f.kind];
  dom.inspect.innerHTML =
    `<h4>${def.icon} ${def.name} <span class="stage">${El.stageName(f.kind, f.stage)}</span></h4>` +
    `<div class="desc">stage ${f.stage + 1}/${def.stages.length} · ${esc(gateHint(f.kind, f.stage, f.x, f.z, Sky.seasonIndex()))}</div>` +
    `<div class="acts"><button id="insClose">close</button><button id="insRemove" class="danger">remove (+${Math.round(def.cost * 0.4)} 💧)</button></div>`;
  dom.inspect.classList.add("show");
  dom.inspect.dataset.id = id;
  $("insClose").addEventListener("click", hideInspect);
  $("insRemove").addEventListener("click", () => { Sim.removeFeature(id); Life.sync(); updateWallet(); hideInspect(); });
}
function hideInspect() { dom.inspect.classList.remove("show"); dom.inspect.dataset.id = ""; }

// ── persistence (C6 swaps localStorage for worlds.db) ────────────────────────
const saveKey = () => "sward:" + G.me.handle;
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 1500); }
function saveNow() { try { localStorage.setItem(saveKey(), JSON.stringify(Sim.serialize())); } catch (_) {} }
function loadSaved() { try { const raw = localStorage.getItem(saveKey()); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }

// ── main loop ────────────────────────────────────────────────────────────────
let last = performance.now(), hudT = 0, simAccum = 0, dirtyGrass = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  // placement cursor
  if (pointer.on && G.tool && !G.visiting) {
    const t = TOOLS.find((x) => x.key === G.tool);
    const g = W.pickGround(pointer.x, pointer.y);
    if (g && W.insidePlot(g.x, g.z)) W.setCursor(g.x, g.z, G.tool === "rake" || G.dew >= (t ? t.cost : 0), t ? t.r : 1);
    else W.setCursor(null);
  } else W.setCursor(null);

  Sky.update(dt);

  // fixed-step sim @5Hz (offline catch-up handles long gaps)
  simAccum += dt;
  while (simAccum >= 0.2) {
    Sim.step(0.2, { season: Sky.seasonIndex(), sunlight: Sky.daylight(), rain: false });
    simAccum -= 0.2; dirtyGrass = true;
  }
  if (dirtyGrass) { Grass.rebuild(); dirtyGrass = false; }
  Grass.update(dt);
  Life.update(dt, now / 1000);

  hudT += dt;
  if (hudT > 0.25) {
    hudT = 0;
    updateClockHud(); updateWallet(); refreshPaletteAfford();
    if (shopEl && shopEl.style.display !== "none") renderShop();
    if (dom.inspect.dataset.id) showInspect(dom.inspect.dataset.id);
    // re-sync critters only when the ecosystem composition actually changes
    const sig = Sim.S.features.map((f) => f.kind + f.stage).sort().join(",") + "|" + Sky.seasonIndex();
    if (sig !== lifeSig) { lifeSig = sig; Life.sync(); }
    // climax celebration (once per achievement)
    if (Sim.S.climax && !climaxShown) { climaxShown = true; flash("Climax ecosystem! ✨"); toast("Every feature at its peak — Spore bonus banked on rewild 🍄", 4500); }
    if (!Sim.S.climax) climaxShown = false;
    saveSoon();
  }

  W.tickControls();
  W.render();
}
let lifeSig = "", climaxShown = false;

// ── boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  try { await worlds.ready; } catch (_) {}
  try {
    const m = await worlds.me();
    if (m && m.handle) G.me = { handle: m.handle, name: m.name || m.handle, color: m.color || colorFor(m.handle) };
  } catch (_) { G.me = { handle: id().slice(0, 6), name: "gardener", color: colorFor(id()) }; }
  G.color3 = new THREE.Color().setStyle(G.me.color);
  dom.ownerName.textContent = G.me.name + "'s plot";
  dom.ownerDot.style.background = G.me.color;

  let h = 0; for (const c of G.me.handle) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  G.plotSeed = h || 1;
  dom.loaderWho.innerHTML = `welcome, <b>${esc(G.me.name)}</b>`;

  const stage = (s) => { dom.loaderWho.textContent = s; };
  stage("shaping the land…"); W.initWorld(dom.canvas, G.plotSeed);
  W.focusCamera(0, 0, 50);
  stage("unpacking props…"); await W.loadModels(["rocks", "rocks_smallA", "rocks_smallB", "stump_round", "log", "grass", ...El.MODEL_NAMES]);

  stage("sprouting grass…"); Grass.buildGrass();
  const saved = loadSaved();
  stage("tilling the soil…"); const idle = Sim.init(G, saved);   // builds debris, restores field, offline catch-up
  // a fresh plot gets a couple of starter tufts so the wind + grass read instantly
  if (!saved) { Sim.seedPatch(2, 1, 1.8, 0.4); Sim.seedPatch(-3, -2, 1.6, 0.35); Grass.rebuild(); }

  const at = new URLSearchParams(location.search).get("at");   // ?at=<gameMs> freezes time (preview)
  if (at != null) Sky.setAbsolute(Number(at));
  stage("raising the sun…"); Sky.initSky();

  buildPalette(); buildShop(); selectTool(G.tool);
  updateClockHud(); updateWallet();
  dom.muteBtn.addEventListener("click", () => toast("audio arrives soon 🔇"));
  dom.questBtn.addEventListener("click", () => toast("quests & almanac — coming soon 📖"));
  dom.marketBtn.addEventListener("click", () => toast("market — coming soon 🤝"));
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveNow(); });
  window.addEventListener("beforeunload", saveNow);

  if (idle && idle.dew > 0) toast(`while you were away (${Math.round(idle.secs / 60)} min): +${fmt(idle.dew)} 💧`, 4200);

  G.booted = true;
  dom.loader.classList.add("hide");
  window.SWARD = { G, Sim, Sky, Grass, W, El, Life };   // debug/inspection handle
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  dom.loaderErr.textContent = "BOOT ERROR: " + (e && (e.stack || e.message) || e);
});
