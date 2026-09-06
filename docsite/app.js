// The interactive docs run on the public SDK, as the visitor, against this instance.
// Every demo is its own init guarded by try/catch, so one primitive that can't run
// here (no AI key, no Slack token) shows its real WorldsError instead of taking the
// page down.
/* global worlds */

const $ = (id) => document.getElementById(id);
const stamp = () => new Date().toLocaleTimeString([], { hour12: false });
function show(el, value, cls = "") {
  el.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  el.className = `out ${cls}`.trim();
  el.style.display = "";
}
function fail(el, e) {
  const err = { name: e.name || "Error", code: e.code, status: e.status, message: e.message };
  if (e.retryAfter != null) err.retryAfter = e.retryAfter;
  show(el, err, "err");
}
function logger(el) {
  return (html) => {
    const d = document.createElement("div");
    d.innerHTML = `<span class="t">${stamp()}</span>${html}`;
    el.appendChild(d);
    while (el.children.length > 80) el.firstChild.remove();
    el.scrollTop = el.scrollHeight;
  };
}
const esc = (s) => worlds.esc(s);
async function safe(name, fn) {
  try { await fn(); } catch (e) { console.error(`[docs] ${name}:`, e); }
}

// ---- host-agnostic links: this page runs on the `docs` subdomain (or /app/docs/) of any instance
const PATH_MODE = location.pathname.startsWith("/app/");
const ROOT = PATH_MODE ? location.origin : `${location.protocol}//${location.host.split(".").slice(1).join(".") || location.host}`;
const BASE_HOST = ROOT.replace(/^https?:\/\//, "");
const siteUrl = (name) => (PATH_MODE ? `${ROOT}/app/${name}/` : `${location.protocol}//${name}.${BASE_HOST}`);
for (const el of document.querySelectorAll("[data-base-host]")) el.textContent = BASE_HOST;
for (const el of document.querySelectorAll("[data-root-text]")) el.textContent = ROOT;
for (const el of document.querySelectorAll("[data-root-href]")) el.href = ROOT + el.dataset.rootHref;
for (const el of document.querySelectorAll("[data-site-href]")) el.href = siteUrl(el.dataset.siteHref);
$("chipRouting").textContent = PATH_MODE ? "path" : "subdomain";
$("howRouting").textContent = PATH_MODE ? "path (/app/<name>/)" : "subdomain (<name>.<base>)";

// ---- chrome: copy buttons, tabs, scroll-spy, mobile menu
for (const pre of document.querySelectorAll("pre")) {
  const b = document.createElement("button");
  b.className = "copy";
  b.textContent = "copy";
  b.onclick = () => {
    navigator.clipboard?.writeText(pre.textContent.replace(/copy$/, "").trim());
    b.textContent = "copied";
    setTimeout(() => (b.textContent = "copy"), 1200);
  };
  pre.appendChild(b);
}
for (const tabs of document.querySelectorAll("[data-tabs]")) {
  const panes = document.querySelector(`[data-tabpanes="${tabs.dataset.tabs}"]`);
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    for (const x of tabs.children) x.classList.toggle("on", x === b);
    for (const p of panes.children) p.classList.toggle("on", p.dataset.pane === b.dataset.tab);
  });
}
{
  const links = [...document.querySelectorAll("#nav a")];
  const sections = links.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
  let raf = 0;
  const spy = () => {
    raf = 0;
    const y = scrollY + 140;
    let cur = sections[0];
    for (const s of sections) if (s.offsetTop <= y) cur = s;
    for (const a of links) a.classList.toggle("on", a.getAttribute("href") === `#${cur?.id}`);
  };
  addEventListener("scroll", () => (raf ||= requestAnimationFrame(spy)), { passive: true });
  spy();
  $("menuBtn").onclick = () => $("side").classList.toggle("open");
  $("nav").addEventListener("click", () => $("side").classList.remove("open"));
}

// =============================================================================
let me = null;
const TEAM_COLORS = { gold: "#e5a00d", teal: "#5eead4", pink: "#f0abfc", sky: "#93c5fd" };

async function main() {
  await worlds.ready;
  me = await worlds.me();
  // identity chrome
  $("sideMe").innerHTML = `<img alt="" src="${esc(me.avatar_url || "")}" /><div><b>${esc(me.name)}</b><small>@${esc(me.handle)}</small></div>`;
  $("chipYou").textContent = `@${me.handle}`;

  await Promise.all([
    safe("context", initContext),
    safe("identity", initIdentity),
    safe("db", initDb),
    safe("cross", initCross),
    safe("ai", initAi),
    safe("uploads", initUploads),
    safe("ws", initWs),
    safe("room", initRoom),
    safe("rooms", initRooms),
    safe("actors", initActors),
    safe("doc", initDoc),
    safe("idle", initIdle),
    safe("utils", initUtils),
    safe("notify", initNotify),
    safe("errors", initErrors),
    safe("how", initHow),
  ]);
}

// ---- context -----------------------------------------------------------------
async function initContext() {
  const meta = await fetch("/api/v1/meta").then((r) => r.json());
  $("chipApi").textContent = `v${meta.api_version}`;
  show($("ctxOut"), { "worlds.site": worlds.site, "/api/v1/meta": meta }, "ok");
}

// ---- identity ----------------------------------------------------------------
async function initIdentity() {
  show($("meOut"), me, "ok");
  $("meProfile").href = `${ROOT}/@${me.handle}`;
  $("meNote").textContent = me.email.endsWith("@localhost") ? "dev identity stub — no real sign-in on this instance" : "signed in via the platform's sign-in wall";
}

// ---- db: shared to-do board --------------------------------------------------
async function initDb() {
  const todos = worlds.db.collection("todos");
  const list = $("todoList");
  const log = logger($("todoLog"));
  let timer = 0;

  async function refresh(flashId) {
    const filter = $("todoOpenOnly").checked ? { done: false } : undefined;
    const page = await todos.list({ filter, sort: $("todoSort").value, limit: 50 });
    const items = page.items.filter((d) => !d.data.demo);
    list.innerHTML = "";
    for (const d of items) {
      const li = document.createElement("li");
      li.className = (d.data.done ? "done" : "") + (d.id === flashId ? " fresh" : "");
      li.innerHTML =
        `<input type="checkbox" ${d.data.done ? "checked" : ""} title="update(id, {done})" />` +
        `<span class="txt"></span><span class="by"></span>` +
        `<button class="btn sm ghost" title="increment(id, 'votes')">👍 <span class="n">${Number(d.data.votes) || 0}</span></button>` +
        `<button class="btn sm ghost danger" title="delete(id)">✕</button>`;
      li.querySelector(".txt").textContent = d.data.text;
      li.querySelector(".by").textContent = d.data.by ? `— ${d.data.by}` : "";
      li.querySelector("input").onchange = (e) => todos.update(d.id, { done: e.target.checked }).catch((e2) => log(`<span class="ev">error</span> ${esc(e2.code)}: ${esc(e2.message)}`));
      li.querySelectorAll("button")[0].onclick = () => todos.increment(d.id, "votes", 1).catch(() => {});
      li.querySelectorAll("button")[1].onclick = () => todos.delete(d.id).catch(() => {});
      list.appendChild(li);
    }
    $("todoCount").textContent = `${items.length} shown${page.next_cursor ? " · more…" : ""}`;
  }
  const schedule = (flashId) => {
    clearTimeout(timer);
    timer = setTimeout(() => refresh(flashId).catch(() => {}), 120);
  };

  async function add() {
    const text = $("todoInput").value.trim();
    if (!text) return;
    $("todoInput").value = "";
    try { await todos.create({ text, done: false, votes: 0, by: me.name }); }
    catch (e) { log(`<span class="ev">error</span> ${esc(e.code)}: ${esc(e.message)}`); }
  }
  $("todoAdd").onclick = add;
  $("todoInput").addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  $("todoOpenOnly").onchange = () => refresh();
  $("todoSort").onchange = () => refresh();

  const demoIds = new Set(); // scratch docs the conflict/error demos create — keep them out of the log
  todos.subscribe((ev) => {
    const id = String(ev.doc?.id ?? "");
    if (ev.doc?.data?.demo) demoIds.add(id);
    if (!demoIds.has(id)) {
      const data = ev.type === "delete" ? "" : JSON.stringify(ev.doc?.data ?? {}).slice(0, 80);
      log(`<span class="ev">${esc(ev.type)}</span> ${esc(id.slice(0, 8))}… ${esc(data)}`);
    }
    schedule(ev.type === "create" ? id : undefined);
  });
  await refresh();

  $("dbConflict").onclick = async () => {
    const out = $("dbOut");
    show(out, "creating a doc, writing twice with the same updated_at…");
    let d;
    try {
      d = await todos.create({ text: "conflict demo", done: true, votes: 0, by: me.name, demo: true });
      const fresh = await todos.get(d.id);
      const second = await todos.update(d.id, { text: "v2" }, { ifUpdatedAt: fresh.updated_at });
      try {
        await todos.update(d.id, { text: "v3" }, { ifUpdatedAt: fresh.updated_at });
        show(out, "unexpected: the stale write went through", "err");
      } catch (e) {
        show(out, {
          "1st write": `ok — updated_at moved ${fresh.updated_at} → ${second.updated_at}`,
          "2nd write (stale ifUpdatedAt)": { name: e.name, code: e.code, status: e.status, message: e.message },
        }, "ok");
      }
    } catch (e) {
      fail(out, e);
    } finally {
      if (d) todos.delete(d.id).catch(() => {});
    }
  };
  $("dbCollections").onclick = async () => {
    try { show($("dbOut"), await worlds.db.collections(), "ok"); } catch (e) { fail($("dbOut"), e); }
  };
}

// ---- cross-world reads: every site on this instance ------------------------
const liveSites = new Map(); // name → site doc data, shared with the examples section
async function initCross() {
  const sites = worlds.db.site("home").collection("sites");
  const ul = $("sitesList");
  const shown = new Map();

  function row(s, fresh) {
    let li = shown.get(s.name);
    if (!li) {
      li = document.createElement("li");
      shown.set(s.name, li);
      ul.prepend(li);
    }
    li.className = fresh ? "fresh" : "";
    li.innerHTML = `<a class="txt" target="_blank" rel="noopener"></a><span class="tag"></span><span class="by"></span>${fresh ? '<span class="tag gold">new</span>' : ""}`;
    const a = li.querySelector("a");
    a.href = s.url || siteUrl(s.name);
    a.textContent = s.name + (s.description ? ` — ${s.description}` : "");
    li.querySelector(".tag").textContent = s.category || "misc";
    li.querySelector(".by").textContent = `@${s.creator?.handle ?? "?"} · ${s.visits_30d ?? 0} visits`;
  }

  const page = await sites.list({ sort: "-updated_at", limit: 100 });
  for (const d of page.items) liveSites.set(d.data.name, d.data);
  for (const d of [...page.items].reverse().slice(-12)) row(d.data, false);
  sites.subscribe((ev) => {
    if (ev.type === "delete") return;
    liveSites.set(ev.doc.data.name, ev.doc.data);
    row(ev.doc.data, ev.type === "create");
    renderExamples();
  });
  renderExamples();

  $("crossWrite").onclick = async () => {
    try { await sites.create({ name: "nope" }); $("crossOut").textContent = "unexpected: it wrote"; }
    catch (e) { $("crossOut").innerHTML = `<b>${esc(e.code)}</b> ${esc(e.message)}`; }
  };
}

// ---- ai ----------------------------------------------------------------------
async function initAi() {
  worlds.ai.models().then((m) => {
    const items = m.items || m.models || m;
    $("aiModels").textContent = "models: " + (Array.isArray(items) ? items.map((x) => `${x.alias}${x.kind ? ` (${x.kind})` : ""}`).join(" · ") : JSON.stringify(m));
  }).catch((e) => ($("aiModels").textContent = `models(): ${e.code}`));

  $("aiRun").onclick = async () => {
    const out = $("aiOut");
    const prompt = $("aiPrompt").value.trim();
    if (!prompt) return;
    const model = $("aiModel").value;
    const stream = $("aiStream").checked;
    $("aiRun").disabled = true;
    $("aiUsage").textContent = "";
    show(out, "", "");
    try {
      const t0 = performance.now();
      const res = await worlds.ai.complete({ prompt, model, max_tokens: 300, stream, onToken: (t) => (out.textContent += t) });
      if (!stream) out.textContent = res.text;
      const ms = Math.round(performance.now() - t0);
      $("aiUsage").textContent = `${res.model} · ${res.usage?.input_tokens ?? "?"} in / ${res.usage?.output_tokens ?? "?"} out · ${ms}ms`;
      out.classList.add("ok");
    } catch (e) {
      fail(out, e);
      if (e.code === "quota_exceeded") $("aiUsage").textContent = "out of completions for today";
    } finally {
      $("aiRun").disabled = false;
    }
  };

  $("embRun").onclick = async () => {
    const out = $("embOut");
    show(out, "embedding two texts…");
    try {
      const [a, b] = await Promise.all([worlds.ai.embed($("embA").value), worlds.ai.embed($("embB").value)]);
      const va = a.vector, vb = b.vector;
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < va.length; i++) { dot += va[i] * vb[i]; na += va[i] ** 2; nb += vb[i] ** 2; }
      const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
      show(out, { dimensions: va.length, "cosine similarity": Number(cos.toFixed(4)), "vector[0..5]": va.slice(0, 6).map((x) => Number(x.toFixed(4))) }, "ok");
    } catch (e) { fail(out, e); }
  };

  $("imgRun").onclick = async () => {
    const out = $("imgOut");
    const img = $("imgResult");
    img.style.display = "none";
    show(out, "generating (this spends one of your daily images)…");
    $("imgRun").disabled = true;
    try {
      const res = await worlds.ai.image($("imgPrompt").value, { size: "1024" });
      show(out, res, "ok");
      if (res.url) { img.src = res.url; img.style.display = ""; }
    } catch (e) { fail(out, e); }
    finally { $("imgRun").disabled = false; }
  };
}

// ---- uploads -----------------------------------------------------------------
async function initUploads() {
  const out = $("upOut");
  const gallery = $("upGallery");
  async function refresh() {
    try {
      const res = await worlds.uploads.list();
      const items = res.items || [];
      gallery.innerHTML = "";
      for (const it of items) {
        const g = document.createElement("div");
        g.className = "g";
        const url = it.url || `/u/${worlds.site.name}/${it.name}`;
        const isImg = /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(it.name || url);
        g.innerHTML = isImg ? `<img alt="" />` : `<span></span>`;
        if (isImg) g.querySelector("img").src = url; else g.querySelector("span").textContent = it.name;
        g.title = `${it.name} · ${it.bytes ?? "?"} bytes`;
        const del = document.createElement("button");
        del.textContent = "✕";
        del.title = `uploads.delete("${it.name}")`;
        del.onclick = async () => { try { await worlds.uploads.delete(it.name); await refresh(); } catch (e) { fail(out, e); } };
        g.appendChild(del);
        gallery.appendChild(g);
      }
      if (!items.length) gallery.innerHTML = `<div class="g">nothing uploaded yet</div>`;
    } catch (e) { fail(out, e); }
  }
  $("upList").onclick = refresh;
  $("upPut").onclick = async () => {
    const f = $("upFile").files[0];
    if (!f) { show(out, "pick a file first"); return; }
    show(out, `uploading ${f.name} (${f.size} bytes)…`);
    try { show(out, await worlds.uploads.put(f), "ok"); await refresh(); } catch (e) { fail(out, e); }
  };
  show(out, "pick a file (≤25MB) and upload it — or refresh the list to see what's here");
  await refresh();
}

// ---- ws: reactions -----------------------------------------------------------
async function initWs() {
  const ch = worlds.ws.channel("reactions");
  const stage = $("wsStage");
  const log = logger($("wsLog"));
  const float = (emoji, who, mine) => {
    const d = document.createElement("div");
    d.className = "float";
    d.style.left = `${8 + Math.random() * 84}%`;
    d.innerHTML = `${esc(emoji)}<small>${esc(mine ? "you" : who)}</small>`;
    stage.appendChild(d);
    setTimeout(() => d.remove(), 2300);
  };
  ch.subscribe((msg) => {
    const mine = msg.payload?.cid === worlds.id();
    float(msg.payload?.emoji ?? "?", msg.from?.name ?? "?", mine);
    log(`<span class="from">${esc(msg.from?.name ?? "?")}</span> → ${esc(msg.payload?.emoji ?? "")}${mine ? ' <span class="t">(this tab)</span>' : ""}`);
  });
  ch.presence((list) => {
    const n = worlds.uniqByHandle(list).length;
    $("wsPresence").textContent = `${n} ${n === 1 ? "person" : "people"} on this channel right now`;
  });
  $("wsButtons").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-emoji]");
    if (b) ch.publish({ emoji: b.dataset.emoji, cid: worlds.id() });
  });
}

// ---- room: shared pixel board ------------------------------------------------
async function initRoom() {
  const board = $("board");
  const cells = [];
  for (let i = 0; i < 64; i++) {
    const b = document.createElement("button");
    b.title = `cell ${i}`;
    board.appendChild(b);
    cells.push(b);
  }
  const myColor = worlds.colorFor(me.handle);
  const r = worlds.room("pixels", {
    initial: () => ({ cells: Array(64).fill(null) }),
    minPlayers: 1, maxPlayers: 8, autoStart: false,
    onChange: render,
    onStart: () => worlds.toast("room started — on every client"),
    onReturn: () => worlds.toast("back to the lobby"),
  });
  function render(s) {
    const st = s.state?.cells || [];
    cells.forEach((b, i) => (b.style.background = st[i] || ""));
    $("roomMembers").innerHTML = s.members.map((m) =>
      `<span class="member ${m.isMe ? "me" : ""}"><span class="sw" style="background:${worlds.colorFor(m.handle)}"></span>${esc(m.name)}` +
      `${m.isHost ? ' <span class="role">host</span>' : ""}${m.ready ? ' <span class="ready">✓</span>' : ""}</span>`).join("");
    $("roomReady").textContent = s.ready ? "not ready" : "I'm ready";
    $("roomStart").disabled = !s.isHost || s.started;
    $("roomStatus").innerHTML =
      `<b>${s.total}</b> here · ready <b>${s.readyCount}/${s.total}</b>${s.allReady ? " (all)" : ""} · host <b>${esc(s.host?.name ?? "—")}</b>` +
      ` · ${s.started ? '<span class="tag ok">started</span>' : '<span class="tag">lobby</span>'}${s.loaded ? "" : " · loading…"}${s.full ? " · full" : ""}`;
  }
  cells.forEach((b, i) => (b.onclick = async () => {
    const next = [...(r.state?.cells || Array(64).fill(null))];
    next[i] = next[i] === myColor ? null : myColor;
    if (!(await r.merge({ cells: next }))) await r.refetch(); // lost a race — refetch and let the user retry
  }));
  $("roomReady").onclick = () => r.toggleReady();
  $("roomStart").onclick = () => r.start();
  $("roomReturn").onclick = () => r.returnToLobby();
  $("roomReset").onclick = () => r.reset();
  await r.ready;
  render(r.snapshot());
}

// ---- rooms: a lobby browser --------------------------------------------------
async function initRooms() {
  const listEl = $("hallList");
  const joined = $("hallJoined");
  let table = null;
  const hall = worlds.rooms("tables", {
    maxPlayers: 4,
    initial: () => ({ taps: 0 }),
    onList: renderList,
    onChange: renderTable,
  });
  function renderList(rooms) {
    listEl.innerHTML = "";
    for (const ro of rooms) {
      const d = document.createElement("div");
      d.className = "r";
      d.innerHTML = `<span class="code"></span><span class="nm"></span><span class="cnt"></span><span class="tag"></span><button class="btn sm">join</button>`;
      d.querySelector(".code").textContent = ro.code;
      d.querySelector(".nm").textContent = ro.name;
      d.querySelector(".cnt").textContent = `${ro.count}/${ro.max || "∞"} · host ${ro.host?.name ?? "?"}`;
      d.querySelector(".tag").textContent = ro.status;
      const btn = d.querySelector("button");
      btn.disabled = ro.full || hall.current?.id === ro.id;
      btn.onclick = () => enter(() => hall.join(ro.id));
      listEl.appendChild(d);
    }
  }
  function renderTable(s) {
    if (!hall.current) { joined.style.display = "none"; return; }
    joined.style.display = "";
    $("hallJoinedCode").textContent = hall.current.code;
    $("hallTaps").textContent = s.state?.taps ?? 0;
    $("hallMembers").innerHTML = s.members.map((m) =>
      `<span class="member ${m.isMe ? "me" : ""}"><span class="sw" style="background:${worlds.colorFor(m.handle)}"></span>${esc(m.name)}${m.isHost ? ' <span class="role">host</span>' : ""}</span>`).join("");
  }
  async function enter(open) {
    try {
      table = await open();
      $("hallJoinedName").textContent = hall.list().find((x) => x.id === table.id)?.name || table.id;
      renderTable(table.snapshot());
      renderList(hall.list());
      worlds.toast(`joined — code ${table.code}`);
    } catch (e) { worlds.toast(`${e.code}: ${e.message}`); }
  }
  $("hallCreate").onclick = () => enter(() => hall.create({ name: $("hallName").value.trim() || `${me.name}'s table`, private: $("hallPrivate").checked }));
  $("hallJoinCode").onclick = () => { const c = $("hallCode").value.trim().toUpperCase(); if (c) enter(() => hall.joinByCode(c)); };
  $("hallTap").onclick = async () => { if (table && !(await table.merge({ taps: (table.state?.taps ?? 0) + 1 }))) await table.refetch(); };
  $("hallLeave").onclick = async () => { await hall.leave(); table = null; joined.style.display = "none"; renderList(hall.list()); };
  renderList(hall.list());
}

// ---- actors: a zoned field ---------------------------------------------------
async function initActors() {
  const field = $("field");
  const log = logger($("actLog"));
  const COLS = 3, ROWS = 2;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const z = document.createElement("div");
    z.className = "zone";
    z.dataset.cell = `${c}-${r}`;
    z.style.left = `${(c / COLS) * 100}%`;
    z.style.top = `${(r / ROWS) * 100}%`;
    z.textContent = `zone ${c}-${r}`;
    field.appendChild(z);
  }
  const mine = document.createElement("div");
  mine.className = "actor me";
  mine.dataset.name = "you";
  field.appendChild(mine);
  const peers = new Map();
  let net = null;
  let state = { x: 0.5, y: 0.5, cell: "1-0" };
  const teamColor = (t) => TEAM_COLORS[t] || worlds.colorFor(String(t));
  const place = (el, s) => { el.style.left = `${s.x * 100}%`; el.style.top = `${s.y * 100}%`; };
  const ripple = (s) => {
    if (!s) return;
    const d = document.createElement("div");
    d.className = "ripple";
    place(d, s);
    field.appendChild(d);
    setTimeout(() => d.remove(), 800);
  };
  const status = () => {
    const inZone = net ? net.others().length : 0;
    $("actStatus").innerHTML = `zone <b>${esc(state.cell)}</b> · <b>${inZone}</b> peer${inZone === 1 ? "" : "s"} here${$("actObserver").checked ? " · observing" : ""}`;
    for (const z of field.querySelectorAll(".zone")) z.classList.toggle("mine", z.dataset.cell === state.cell);
  };
  function connect() {
    net?.destroy();
    for (const el of peers.values()) el.remove();
    peers.clear();
    const observer = $("actObserver").checked;
    net = worlds.actors("field", { zoneKey: (s) => s.cell, rate: 15, metadata: { team: $("actTeam").value }, observer });
    mine.style.background = observer ? "transparent" : teamColor($("actTeam").value);
    mine.style.borderStyle = observer ? "dashed" : "solid";
    net.onChange((id, s, peer) => {
      if (!s) return;
      let el = peers.get(id);
      if (!el) {
        el = document.createElement("div");
        el.className = "actor";
        el.dataset.name = peer.name;
        field.appendChild(el);
        peers.set(id, el);
        log(`<span class="ev">joined zone</span> <span class="from">${esc(peer.name)}</span> (${esc(id.slice(0, 6))}) team ${esc(peer.metadata?.team ?? "?")}`);
      }
      el.style.background = teamColor(peer.metadata?.team);
      place(el, s);
      status();
    });
    net.onEvent((id, payload, from) => {
      const el = peers.get(id);
      if (el) ripple({ x: parseFloat(el.style.left) / 100, y: parseFloat(el.style.top) / 100 });
      log(`<span class="ev">event</span> ${esc(JSON.stringify(payload))} from <span class="from">${esc(from.name)}</span>`);
    });
    net.onLeave((id) => {
      peers.get(id)?.remove();
      peers.delete(id);
      log(`<span class="ev">left zone</span> ${esc(id.slice(0, 6))}`);
      status();
    });
    net.set(state);
    place(mine, state);
    status();
  }
  field.addEventListener("pointermove", (e) => {
    const b = field.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width));
    const y = Math.min(1, Math.max(0, (e.clientY - b.top) / b.height));
    const cell = `${Math.min(COLS - 1, Math.floor(x * COLS))}-${Math.min(ROWS - 1, Math.floor(y * ROWS))}`;
    const zoneChanged = cell !== state.cell;
    state = { x, y, cell };
    net.set(state);
    place(mine, state);
    if (zoneChanged) {
      for (const el of peers.values()) el.remove(); // the server re-snapshots the new zone
      peers.clear();
      status();
    }
  });
  field.addEventListener("click", () => { net.send({ t: "ping" }); ripple(state); });
  $("actTeam").onchange = () => { net.setMetadata({ team: $("actTeam").value }); mine.style.background = teamColor($("actTeam").value); };
  $("actObserver").onchange = connect;
  connect();
}

// ---- doc: a shared Yjs notepad -----------------------------------------------
async function initDoc() {
  const ta = $("docText");
  const status = $("docStatus");
  const log = logger($("docLog"));
  const Y = await import("https://cdn.jsdelivr.net/npm/yjs@13/+esm");
  let ydoc = null;
  let transport = null;

  const setStatus = (extra) => {
    status.innerHTML = `epoch <b>${transport.epoch}</b> · seq <b>${transport.seq}</b> · ${esc(extra)}`;
  };
  const render = () => {
    const next = ydoc.getText("body").toString();
    if (ta.value === next) return;
    const pos = Math.min(ta.selectionStart ?? next.length, next.length);
    ta.value = next; // programmatic writes fire no input event, so nothing echoes back
    try { ta.setSelectionRange(pos, pos); } catch { /* not focused */ }
  };
  // The recipe's rule: reset and rejection both mean replace, never merge — the local
  // doc is rebuilt from the server's state by reopening the transport on a fresh Y.Doc.
  function open() {
    ydoc = new Y.Doc();
    transport = worlds.doc("notepad", {
      onState: (state, info) => {
        Y.applyUpdate(ydoc, state, "server");
        ta.disabled = false;
        render();
        log(`<span class="ev">state</span> epoch ${info.epoch} seq ${info.seq} · ${info.bytes} bytes`);
        setStatus("live");
      },
      onUpdate: (update, info) => {
        Y.applyUpdate(ydoc, update, "server");
        log(`<span class="ev">update</span> seq ${info.seq} committed`);
        setStatus("live");
      },
      onAck: (seq) => { log(`<span class="ev">ack</span> seq ${seq} — yours is on disk`); setStatus("live"); },
      onReset: (state, info) => { log(`<span class="ev">reset</span> epoch ${info.epoch} (${esc(info.reason)}) — rebuilding`); transport.close(); open(); },
      onRejected: (state, info) => { log(`<span class="ev">rejected</span> ${esc(info.reason)} ${esc(info.rule || "")} — resyncing`); transport.close(); open(); },
      onStatus: (info) => { if (info.reconnecting) setStatus("reconnecting…"); },
      onError: (e) => { log(`<span class="ev">error</span> ${esc(e.code)}: ${esc(e.message)}`); status.textContent = `${e.code}: ${e.message}`; },
    });
    ydoc.on("update", (u, origin) => { if (origin !== "server") transport.send(u); });
    ydoc.getText("body").observe(render);
  }
  // Turn the textarea's new value into a minimal Yjs edit: the changed middle only, so
  // two people typing in different places don't overwrite each other.
  ta.addEventListener("input", () => {
    const text = ydoc.getText("body");
    const cur = text.toString();
    const next = ta.value;
    let head = 0;
    while (head < cur.length && head < next.length && cur[head] === next[head]) head++;
    let tail = 0;
    while (tail < cur.length - head && tail < next.length - head && cur[cur.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    ydoc.transact(() => {
      if (cur.length - head - tail > 0) text.delete(head, cur.length - head - tail);
      if (next.length - head - tail > 0) text.insert(head, next.slice(head, next.length - tail));
    });
  });
  $("docList").onclick = async () => {
    try { show($("docOut"), await worlds.docs.list(), "ok"); } catch (e) { fail($("docOut"), e); }
  };
  open();
}

// ---- idle --------------------------------------------------------------------
async function initIdle() {
  const idle = worlds.idle("docs-demo", { cap: 8 * 3600, min: 10 });
  const out = $("idleOut");
  let report = { dew: 42, honey: 3, "visitors while away": 2 };
  const secs = await idle.elapsed();
  if (secs) {
    report = { "seconds away (capped)": secs, dew: secs * 2, honey: Math.floor(secs / 60) };
    show(out, { "idle.elapsed()": secs, "your report": report }, "ok");
  } else {
    show(out, { "idle.elapsed()": null, why: "first visit, or you were away under 10s — reload in a bit and it'll credit the gap" });
  }
  $("idleBeat").onclick = () => { idle.beat(); worlds.toast("lastSeen = now"); };
  $("idleSummary").onclick = () => idle.summary(report, { title: "While you were away" });
}

// ---- utilities ---------------------------------------------------------------
async function initUtils() {
  $("utToast").onclick = () => worlds.toast("saved! (worlds.toast)");
  $("utId").textContent = worlds.id();
  const color = () => {
    const v = $("utColorIn").value || me.handle;
    const c = worlds.colorFor(v);
    $("utSwatch").style.background = c;
    $("utColor").textContent = c;
  };
  $("utColorIn").placeholder = me.handle;
  $("utColorIn").oninput = color;
  color();
  const escape = () => ($("utEsc").textContent = worlds.esc($("utEscIn").value));
  $("utEscIn").oninput = escape;
  escape();
  $("utUniq").textContent = JSON.stringify(worlds.uniqByHandle([{ handle: "enzo", name: "Enzo" }, { handle: "enzo", name: "Enzo M" }, { handle: "ana", name: "Ana" }]));
  let t = null;
  $("utCount").onclick = () => {
    t?.destroy();
    const end = Date.now() + 10_000;
    t = worlds.countdown(end, {
      onTick: (ms) => { $("utBar").style.width = `${100 - ms / 100}%`; $("utLeft").textContent = `${(ms / 1000).toFixed(1)}s`; },
      onEnd: () => { $("utLeft").textContent = "done"; worlds.toast("time!"); },
    });
  };
}

// ---- notify ------------------------------------------------------------------
async function initNotify() {
  $("slackSend").onclick = async () => {
    const out = $("slackOut");
    const target = $("slackChannel").value.trim();
    if (!target) { show(out, "name a channel first (e.g. #general)"); return; }
    show(out, `posting to ${target}…`);
    try { show(out, await worlds.notify.slack(target, $("slackText").value), "ok"); } catch (e) { fail(out, e); }
  };
}

// ---- errors ------------------------------------------------------------------
async function initErrors() {
  const todos = worlds.db.collection("todos");
  const out = $("errOut");
  const triggers = {
    not_found: () => todos.get("does-not-exist"),
    invalid_request: () => todos.create("not an object"),
    payload_too_large: () => todos.create({ blob: "x".repeat(300_000) }),
    read_only: () => worlds.db.site("home").collection("sites").create({}),
    conflict: async () => {
      const d = await todos.create({ text: "conflict", demo: true });
      try {
        await todos.update(d.id, { text: "v2" }, { ifUpdatedAt: d.updated_at });
        await todos.update(d.id, { text: "v3" }, { ifUpdatedAt: d.updated_at });
      } finally { todos.delete(d.id).catch(() => {}); }
    },
  };
  document.querySelector("#errors .row").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-err]");
    if (!b) return;
    show(out, `triggering ${b.dataset.err}…`);
    try { await triggers[b.dataset.err](); show(out, "no error thrown (unexpected)", "err"); }
    catch (err) { fail(out, err); out.textContent += `\n\ne instanceof worlds.WorldsError → ${err instanceof worlds.WorldsError}`; }
  });
}

// ---- platform endpoints ------------------------------------------------------
async function initHow() {
  document.querySelector("#how .panel .row").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-get]");
    if (!b) return;
    const out = $("howOut");
    show(out, `GET ${b.dataset.get}…`);
    try {
      const res = await fetch(b.dataset.get, { headers: PATH_MODE ? { "x-worlds-site": "docs" } : {} });
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      show(out, { status: res.status, body }, res.ok ? "ok" : "err");
    } catch (err) { fail(out, err); }
  });
}

// ---- examples ----------------------------------------------------------------
const EXAMPLES = [
  ["connect4", "Four-in-a-row tables: a lobby browser with join codes wrapping a per-table board.", ["rooms", "room"]],
  ["trivia", "Concurrent AI-generated quizzes with host-driven phases.", ["rooms", "ai"]],
  ["spyfall", "Social deduction — private roles per table.", ["rooms", "room"]],
  ["draw-guess", "Draw and guess: strokes over channels, rounds in the db.", ["ws", "db", "rooms"]],
  ["tumble", "An endless, synchronized three.js gauntlet — lobby-less, unbounded players.", ["actors", "room", "db"]],
  ["racing", "3D karts on a rotating track clock; poses over zoned actors, a horn via events.", ["actors", "room", "db"]],
  ["red-light", "Red light, green light — one ready-up room, realtime moves.", ["room", "ws"]],
  ["paint-arena", "Paint territory, encircle rivals, grab power-ups.", ["room", "ws"]],
  ["hangout", "A lounge: presence, chat, shared mood.", ["db", "ws"]],
  ["quick-poll", "Live polls with realtime results.", ["db"]],
  ["survive", "Co-op AI doom party game — absurd scenarios, secret plans, shared lives.", ["ai", "room", "db"]],
  ["sward", "Tend a moonlit plot: a dew economy with offline progress, in three.js.", ["db", "idle"]],
  ["pe-de-meia", "A couples' investment simulator with an AI assistant.", ["db", "ai"]],
];
function renderExamples() {
  const wrap = $("exampleCards");
  wrap.innerHTML = "";
  for (const [name, desc, uses] of EXAMPLES) {
    const live = liveSites.get(name);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      `<h4>${live ? `<a href="${esc(live.url || siteUrl(name))}" target="_blank" rel="noopener">${esc(name)}</a><span class="dot live" title="deployed here"></span>` : esc(name)}</h4>` +
      `<p>${esc(desc)}</p><div class="uses">${uses.map((u) => `<code>worlds.${u}</code>`).join("")}</div>` +
      `<div class="foot">${live ? `live on this instance · ${live.visits_30d ?? 0} visits` : "not deployed here"}` +
      ` · <a href="https://github.com/enzomaruffa/worlds/tree/main/examples/games/${name}" target="_blank" rel="noopener">source ↗</a></div>`;
    wrap.appendChild(card);
  }
}
renderExamples();

main().catch((e) => {
  console.error(e);
  $("sideMe").innerHTML = `<div><b>not signed in</b><small>${esc(e.code || e.message)}</small></div>`;
});
