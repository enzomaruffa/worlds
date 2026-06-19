// ───────────────────────────────────────────────────────────────────────────
// social.js — the goods economy & market. Mature features produce tradeable
// GOODS (sim.js accrues them into G.goods). Players post barter OFFERS to a
// shared worlds.db collection; anyone can fulfill them; the want-payment is
// escrowed in the offer and auto-claimed when the poster returns. Visiting a
// neighbour also lets you leave a gift. (Quests/almanac live in C8 alongside.)
// ───────────────────────────────────────────────────────────────────────────

export const GOODS = {
  honey: { name: "Honey", icon: "🍯" },
  berries: { name: "Berries", icon: "🫐" },
  caps: { name: "Mushroom caps", icon: "🍄" },
  seeds: { name: "Tree seeds", icon: "🌰" },
  petals: { name: "Petals", icon: "🌼" },
  specimens: { name: "Specimens", icon: "🦋" },
};
export const GOOD_KEYS = Object.keys(GOODS);
export const emptyGoods = () => ({ honey: 0, berries: 0, caps: 0, seeds: 0, petals: 0, specimens: 0 });

let G = null, col = null, panel = null, sub = null, plotsCol = null;
const esc = (s) => worlds.esc(s), toast = (s, ms) => worlds.toast(s, ms);

export async function init(g) {
  G = g;
  if (!G.goods) G.goods = emptyGoods();
  try {
    col = worlds.db.collection("offers");
    plotsCol = worlds.db.collection("plots");
    await claimFilled();
    sub = col.subscribe(() => { claimFilled(); if (isOpen()) render(); });
  } catch (e) { /* offline: market disabled */ }
  buildPanel();
}

// auto-claim the want-payment from any of my offers that got filled
async function claimFilled() {
  if (!col) return;
  let mine = [];
  try { mine = (await col.list({ filter: { by: G.me.handle, status: "filled" }, limit: 50 })).items || []; } catch { return; }
  for (const it of mine) {
    const c = it.data.claimable;
    if (c && c.good) { G.goods[c.good] = (G.goods[c.good] || 0) + c.qty; toast(`${esc(it.data.filledByName || "someone")} filled your offer — +${c.qty} ${GOODS[c.good]?.icon || ""}`, 4000); }
    try { await col.delete(it.id); } catch {}
  }
}

export async function postOffer(giveGood, giveQty, wantGood, wantQty) {
  if (!col) return toast("market offline");
  giveQty = Math.max(1, giveQty | 0); wantQty = Math.max(1, wantQty | 0);
  if ((G.goods[giveGood] || 0) < giveQty) return toast("you don't have " + giveQty + " " + GOODS[giveGood].icon);
  G.goods[giveGood] -= giveQty;   // escrow
  try { await col.create({ by: G.me.handle, byName: G.me.name, giveGood, giveQty, wantGood, wantQty, status: "open", at: 0 }); toast("offer posted 🤝"); }
  catch { G.goods[giveGood] += giveQty; toast("couldn't post offer"); }
  render();
}
export async function fulfill(id) {
  if (!col) return;
  let doc; try { doc = await col.get(id); } catch { return toast("offer gone"); }
  const o = doc.data; if (!o || o.status !== "open") return toast("offer already taken");
  if ((G.goods[o.wantGood] || 0) < o.wantQty) return toast("you need " + o.wantQty + " " + GOODS[o.wantGood].icon);
  G.goods[o.wantGood] -= o.wantQty;
  G.goods[o.giveGood] = (G.goods[o.giveGood] || 0) + o.giveQty;   // you receive their give
  try { await col.update(id, { status: "filled", filledBy: G.me.handle, filledByName: G.me.name, claimable: { good: o.wantGood, qty: o.wantQty } }); toast(`traded! +${o.giveQty} ${GOODS[o.giveGood].icon}`); }
  catch { G.goods[o.wantGood] += o.wantQty; G.goods[o.giveGood] -= o.giveQty; toast("trade failed"); }
  render();
}
export async function cancel(id) {
  if (!col) return;
  let doc; try { doc = await col.get(id); } catch { return; }
  const o = doc.data; if (!o || o.by !== G.me.handle || o.status !== "open") return;
  G.goods[o.giveGood] = (G.goods[o.giveGood] || 0) + o.giveQty;   // refund escrow
  try { await col.delete(id); toast("offer withdrawn"); } catch {}
  render();
}

// leave a gift on a neighbour's plot (write their doc directly — cozy, open trust)
export async function gift(handle, good, qty) {
  if (!plotsCol) return toast("offline");
  if ((G.goods[good] || 0) < qty) return toast("not enough " + GOODS[good].icon);
  let page; try { page = await plotsCol.list({ filter: { handle }, limit: 1 }); } catch { return toast("couldn't reach them"); }
  const it = page.items && page.items[0]; if (!it) return toast("plot not found");
  const goods = { ...(it.data.goods || emptyGoods()) }; goods[good] = (goods[good] || 0) + qty;
  try { await plotsCol.update(it.id, { goods }); G.goods[good] -= qty; toast(`gifted ${qty} ${GOODS[good].icon} 🎁`); }
  catch { toast("gift failed"); }
}

// ── market panel UI (toolbar 🤝) ──────────────────────────────────────────────
const isOpen = () => panel && panel.style.display !== "none";
function buildPanel() {
  panel = document.createElement("div");
  panel.className = "panel"; panel.id = "market";
  panel.style = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9;width:min(94vw,30rem);max-height:80vh;overflow:auto;padding:1rem 1.1rem;display:none";
  document.getElementById("app").appendChild(panel);
}
export function toggle() { if (!panel) return; panel.style.display = isOpen() ? "none" : "block"; if (isOpen()) render(); }

let offersCache = [];
async function render() {
  if (!isOpen()) return;
  if (col) { try { offersCache = ((await col.list({ filter: { status: "open" }, limit: 60 })).items || []).map((i) => ({ id: i.id, ...i.data })); } catch {} }
  const goodsRow = GOOD_KEYS.map((k) => `<span style="margin-right:.6rem">${GOODS[k].icon} <b style="color:var(--leaf-bright)">${Math.floor(G.goods[k] || 0)}</b></span>`).join("");
  const opt = (sel) => GOOD_KEYS.map((k) => `<option value="${k}" ${k === sel ? "selected" : ""}>${GOODS[k].icon} ${GOODS[k].name}</option>`).join("");
  let html = `<h3 style="margin:0 0 .5rem;font-size:.95rem">🤝 Market</h3>
    <div style="font-size:.8rem;color:var(--muted);margin-bottom:.6rem">your goods: ${goodsRow || "—"}</div>
    <div style="background:rgba(11,18,13,.5);border:1px solid var(--border-soft);border-radius:.6rem;padding:.55rem;margin-bottom:.7rem">
      <div style="font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.4rem">post an offer</div>
      <div style="display:flex;gap:.35rem;align-items:center;flex-wrap:wrap;font-size:.8rem">
        give <input id="mGiveQ" type="number" min="1" value="1" style="width:3rem"> <select id="mGive">${opt("honey")}</select>
        for <input id="mWantQ" type="number" min="1" value="1" style="width:3rem"> <select id="mWant">${opt("berries")}</select>
        <button id="mPost" style="margin-left:auto">post</button>
      </div>
    </div>
    <div style="font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.35rem">open offers</div>`;
  if (!offersCache.length) html += `<div style="font-size:.8rem;color:var(--dim);padding:.3rem">no offers yet — post the first 🌱</div>`;
  for (const o of offersCache) {
    const mine = o.by === G.me.handle;
    html += `<div style="display:flex;gap:.5rem;align-items:center;font-size:.84rem;padding:.3rem 0;border-top:1px solid var(--border-soft)">
      <span><b>${o.giveQty}</b> ${GOODS[o.giveGood]?.icon} → <b>${o.wantQty}</b> ${GOODS[o.wantGood]?.icon}</span>
      <span style="color:var(--muted);font-size:.74rem">${mine ? "you" : esc(o.byName || o.by)}</span>
      <button data-${mine ? "cancel" : "fill"}="${o.id}" style="margin-left:auto;color:${mine ? "var(--bloom)" : "var(--leaf-bright)"}">${mine ? "cancel" : "trade"}</button>
    </div>`;
  }
  html += `<div style="text-align:right;margin-top:.7rem"><button id="mClose">close</button></div>`;
  panel.innerHTML = html;
  const btn = (sel, fn) => { const e = panel.querySelector(sel); if (e) e.addEventListener("click", fn); };
  btn("#mClose", toggle);
  btn("#mPost", () => postOffer(panel.querySelector("#mGive").value, +panel.querySelector("#mGiveQ").value, panel.querySelector("#mWant").value, +panel.querySelector("#mWantQ").value));
  for (const b of panel.querySelectorAll("button[data-fill]")) b.addEventListener("click", () => fulfill(b.dataset.fill));
  for (const b of panel.querySelectorAll("button[data-cancel]")) b.addEventListener("click", () => cancel(b.dataset.cancel));
}

// ── quests + almanac + town goal ──────────────────────────────────────────────
export const QUESTS = [
  { id: "place1", name: "Break ground", desc: "Place your first feature", reward: { dew: 40 }, check: (c) => c.Sim.S.features.length >= 1 },
  { id: "clear5", name: "Tidy plot", desc: "Clear 5 bits of debris", reward: { dew: 60 }, check: (c) => (c.G.stats.debrisCleared || 0) >= 5 },
  { id: "green40", name: "Green thumb", desc: "Cover 40% of the plot in grass", reward: { dew: 120 }, check: (c) => c.Sim.greenPct() >= 0.4 },
  { id: "oak", name: "Old oak", desc: "Raise a tree to Ancient", reward: { dew: 220 }, check: (c) => c.Sim.S.features.some((f) => f.kind === "tree" && f.stage >= 4) },
  { id: "meadow", name: "Pollinator", desc: "Grow a spreading flower meadow (needs a hive)", reward: { dew: 180 }, check: (c) => c.Sim.S.features.some((f) => f.kind === "flowers" && f.stage >= 3) },
  { id: "frogs", name: "Wetland", desc: "Bring frogs to a pond", reward: { dew: 180 }, check: (c) => c.Sim.S.features.some((f) => f.kind === "pond" && f.stage >= 3) },
  { id: "eco8", name: "Biodiverse", desc: "Reach ecosystem level 8", reward: { spores: 1, dew: 100 }, check: (c) => c.G.ecoLevel >= 8 },
  { id: "catch5", name: "Collector", desc: "Catch 5 drifting critters", reward: { dew: 160 }, check: (c) => (c.G.stats.specimensCaught || 0) >= 5 },
  { id: "neigh", name: "Good neighbour", desc: "Water 3 neighbours' plots", reward: { dew: 100 }, check: (c) => (c.G.stats.neighborsWatered || 0) >= 3 },
  { id: "climax", name: "Climax ecosystem", desc: "Bring every feature to its peak", reward: { spores: 2, dew: 300 }, check: (c) => c.Sim.S.climax },
];
const ALM = {
  Features: [["f:tree", "🌳"], ["f:pond", "💧"], ["f:flowers", "🌸"], ["f:hive", "🐝"], ["f:clover", "🍀"], ["f:shrub", "🫐"], ["f:mushrooms", "🍄"]],
  Critters: [["c:bee", "🐝"], ["c:frog", "🐸"], ["c:butterfly", "🦋"], ["c:rabbit", "🐰"]],
  Specimens: [["s:monarch", "🦋"], ["s:firefly", "✨"], ["s:ladybug", "🐞"], ["s:dragonfly", "🪰"]],
  Events: [["e:shower", "🌧️"], ["e:migration", "🦋"], ["e:fireflies", "✨"], ["e:windstorm", "🍂"], ["e:frost", "❄️"], ["e:festival", "🎏"]],
};

export function discover(key) {
  if (!G.almanac) G.almanac = new Set();
  if (G.almanac.has(key)) return false;
  G.almanac.add(key); toast("📖 Almanac: new discovery!", 2200); return true;
}
export function checkQuests(ctx) {
  if (!G.questsDone) G.questsDone = new Set();
  for (const q of QUESTS) {
    if (G.questsDone.has(q.id)) continue;
    let ok = false; try { ok = q.check(ctx); } catch {}
    if (ok) {
      G.questsDone.add(q.id);
      if (q.reward.dew) G.dew += q.reward.dew;
      if (q.reward.spores) G.spores = (G.spores || 0) + q.reward.spores;
      toast(`✅ ${q.name} — +${q.reward.dew || 0} 💧${q.reward.spores ? " +" + q.reward.spores + " 🍄" : ""}`, 4000);
    }
  }
}

let townList = [];
export function setTown(list) { townList = list || []; }

let qpanel = null;
function buildQuestPanel() {
  qpanel = document.createElement("div");
  qpanel.className = "panel"; qpanel.id = "quests";
  qpanel.style = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9;width:min(94vw,30rem);max-height:82vh;overflow:auto;padding:1rem 1.1rem;display:none";
  document.getElementById("app").appendChild(qpanel);
}
export function toggleQuests() { if (!qpanel) buildQuestPanel(); qpanel.style.display = qpanel.style.display === "none" ? "block" : "none"; if (qpanel.style.display === "block") renderQuests(); }
export function renderQuests() {
  if (!qpanel || qpanel.style.display === "none") return;
  const done = G.questsDone || new Set();
  let html = `<h3 style="margin:0 0 .5rem;font-size:.95rem">📖 Quests & Almanac</h3>`;
  // town goal
  const townEco = townList.reduce((a, n) => a + (n.eco || 0), 0) + (G.ecoLevel || 0);
  const GOAL = 40;
  html += `<div style="background:rgba(108,194,74,.1);border:1px solid var(--border-soft);border-radius:.6rem;padding:.5rem .6rem;margin-bottom:.7rem;font-size:.8rem">
    🏡 <b>Neighbourhood goal</b> — combined eco ${Math.min(townEco, GOAL)}/${GOAL}
    <div style="height:.35rem;border-radius:999px;background:rgba(255,255,255,.08);margin-top:.3rem;overflow:hidden"><i style="display:block;height:100%;width:${Math.min(100, townEco / GOAL * 100)}%;background:linear-gradient(90deg,var(--leaf),var(--leaf-bright))"></i></div></div>`;
  // quests
  html += `<div style="font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.3rem">quests</div>`;
  for (const q of QUESTS) {
    const d = done.has(q.id);
    html += `<div style="display:flex;gap:.5rem;align-items:center;font-size:.82rem;padding:.22rem 0;opacity:${d ? 0.55 : 1}">
      <span>${d ? "✅" : "▢"}</span><div style="flex:1"><b>${q.name}</b> <span style="color:var(--muted)">— ${q.desc}</span></div>
      <span style="color:var(--leaf-bright);font-size:.74rem">${q.reward.dew ? q.reward.dew + "💧" : ""}${q.reward.spores ? " " + q.reward.spores + "🍄" : ""}</span></div>`;
  }
  // almanac
  const alm = G.almanac || new Set();
  html += `<div style="font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:.7rem 0 .3rem">almanac</div>`;
  for (const [sec, items] of Object.entries(ALM)) {
    html += `<div style="font-size:.78rem;margin:.25rem 0"><span style="color:var(--muted)">${sec}</span> `;
    html += items.map(([k, ic]) => `<span title="${k}" style="font-size:1.2rem;opacity:${alm.has(k) ? 1 : 0.22};filter:${alm.has(k) ? "none" : "grayscale(1)"}">${ic}</span>`).join(" ");
    html += `</div>`;
  }
  html += `<div style="text-align:right;margin-top:.7rem"><button id="qClose">close</button></div>`;
  qpanel.innerHTML = html;
  const cl = qpanel.querySelector("#qClose"); if (cl) cl.addEventListener("click", toggleQuests);
}
export const questsPanelOpen = () => qpanel && qpanel.style.display === "block";

// goods production rates per second by feature kind + min stage (sim.js reads this)
export const PRODUCERS = [
  { kind: "hive", stage: 3, good: "honey", rate: 0.05 },
  { kind: "shrub", stage: 2, good: "berries", rate: 0.045 },
  { kind: "mushrooms", stage: 2, good: "caps", rate: 0.035 },
  { kind: "tree", stage: 4, good: "seeds", rate: 0.02 },
  { kind: "flowers", stage: 3, good: "petals", rate: 0.045 },
];
