# Worlds site reference — recipes, resources, gotchas

Copy-paste building blocks for Worlds sites. Every snippet runs as-is behind a single
`<script src="/worlds.js"></script>` tag — no keys, no build step. Full SDK signatures live
in `SKILL.md`; the live contract is at `/llms.txt` and `/docs`.

The golden rule: **the page is the program.** Do the work in the browser. The server gives
you data (`worlds.db`), AI (`worlds.ai`), files (`worlds.uploads`), realtime (`worlds.ws`),
identity (`worlds.me`), and Slack (`worlds.notify`) — everything else is your HTML/JS/CSS.

---

## Recipes

### 1. Guestbook (db + identity + realtime)

The hello-world of Worlds. Persists, shows who wrote what, updates live across tabs.

```html
<script src="/worlds.js"></script>
<input id="msg" placeholder="say something" />
<button onclick="post()">sign</button>
<ul id="list"></ul>
<script>
  const book = worlds.db.collection("guestbook");
  const list = document.getElementById("list");

  function add(doc) {
    const li = document.createElement("li");
    li.textContent = `${doc.data.by}: ${doc.data.text}`;
    list.prepend(li);
  }

  // initial paint, newest first
  (await book.list({ sort: "-created_at", limit: 50 })).items.forEach(add);
  // live: every other tab's signature shows up here too
  book.subscribe(ev => { if (ev.type === "create") add(ev.doc); });

  window.post = async () => {
    const me = await worlds.me();
    const input = document.getElementById("msg");
    if (!input.value.trim()) return;
    await book.create({ text: input.value, by: me.name });
    input.value = "";
  };
</script>
```

### 2. Live poll / leaderboard (atomic increment)

Never do read-modify-write on a counter — concurrent voters race. Use `increment`.

```js
const polls = worlds.db.collection("polls");
// one doc holds all the tallies
let poll = (await polls.list({ limit: 1 })).items[0]
  ?? await polls.create({ question: "lunch?", tacos: 0, sushi: 0 });

async function vote(option) {
  await polls.increment(poll.id, option, 1);   // atomic, race-free
}

// live results: re-render whenever the doc changes
polls.subscribe(ev => { if (ev.doc.id === poll.id) render(ev.doc.data); });
```

### 3. Multiplayer cursors / presence (ws channel)

Ephemeral, high-frequency state goes over `worlds.ws`, **not** `worlds.db` (channels aren't
persisted and don't count against doc quotas). This is the pattern for shared whiteboards,
co-watching, and the universe's live ships.

```js
const me = await worlds.me();
const room = worlds.ws.channel("cursors");

addEventListener("pointermove", e => {
  room.publish({ x: e.clientX / innerWidth, y: e.clientY / innerHeight });
});

const others = new Map();
room.subscribe(msg => {
  // msg = { payload, from: {handle, name}, at }
  drawCursor(msg.from.handle, msg.payload.x, msg.payload.y, msg.from.name);
});
room.presence(members => renderRoster(members));   // [{handle, name}] — who's here now
```

Throttle publishes to ~10–15/s for cursors; payloads are capped at 16KB.

### 4. AI toy (completions + a model choice)

```js
async function ask(q) {
  const { text } = await worlds.ai.complete({
    system: "You are a terse, witty assistant. One sentence.",
    messages: [{ role: "user", content: q }],
    model: "fast",            // "fast" (default) or "smart"; never a raw provider id
    max_tokens: 200,
  });
  return text;
}
// one-shot string form for quick prompts:
const haiku = (await worlds.ai.complete("haiku about postgres")).text;
```

Keep a local fallback for demos so the UI never hard-stalls if you hit the daily cap:

```js
async function askSafe(q) {
  try { return await ask(q); }
  catch (e) { return e.code === "quota_exceeded" ? "(out of AI for today)" : "(hmm, try again)"; }
}
```

### 5. Upload gallery (files + list + delete)

```js
const fileInput = document.querySelector("input[type=file]");
fileInput.onchange = async () => {
  for (const f of fileInput.files) {
    const { url, name } = await worlds.uploads.put(f, { name: f.name });   // ≤25MB each
    addThumb(url, name);
  }
};
// existing files
(await worlds.uploads.list()).items.forEach(u => addThumb(u.url, u.name));
async function remove(name) { await worlds.uploads.delete(name); }
```

Uploaded files are served at a stable, world-readable URL (`/u/<site>/<name>`) — paste it
anywhere. Same-name re-uploads overwrite.

### 6. AI image generator (image → upload)

```js
const { url } = await worlds.ai.image("a low-poly desert planet at dusk", { size: "1024" });
document.querySelector("img").src = url;   // already stored as an upload, counts toward quota
```

### 7. Slack alert ("ping me when X") — the internal-tools killer feature

```js
// a dashboard that nags a channel when a metric goes red
if (errorRate > 0.05) {
  await worlds.notify.slack("#data-alerts", `error rate is ${(errorRate*100).toFixed(1)}% 🔴`);
}
```

Capped per user/day and stamped server-side with the site + sender — you can't spoof
identity, and you can't spam. This is how Worlds replaces "I need a cron + a Slack bot":
**refresh-on-view + notify-on-bad** instead of a scheduled job.

### 8. Reading other worlds (cross-site reads)

Any world's data is readable (you could see it by visiting the site anyway); writes always
stay with the owning site. This is exactly how the homepage universe is built.

```js
const sites = worlds.db.site("home").collection("sites");   // the platform site registry
(await sites.list({ sort: "-visits_30d", limit: 10 })).items.forEach(addPlanet);
sites.subscribe(ev => addPlanet(ev.doc));                   // a fresh deploy pops in live
```

### 9. The universe pattern (a 3D site on pure worlds.js)

`examples/universe/` is the flagship dogfood — a Three.js space sim that is **just a Worlds
site** (deploy it with `worlds deploy` like any other). It uses only public APIs:

- `worlds.db.site("home").collection("sites").subscribe(...)` → a planet per deployed site, live.
- `worlds.ws.channel("ships")` → other signed-in users' ships in realtime (pose broadcast + presence).
- `worlds.ai.complete(...)` → the "ask the universe" navigator and per-planet lore.
- Three.js itself comes from a CDN importmap (below) — Worlds ships no 3D engine.

Read its `main.js` when you want a worked example of channels + db subscribe + ai together
at scale. Don't bake heavy engines into the server; load them from a CDN in your site.

---

## Resources (all CDN / CC0 — sites are static behind the gate, so any CDN works)

You have no build step. Pull libraries straight from a CDN with a `<script>` tag or an ES
module `importmap`. Pin a version in the URL so your site keeps working forever.

### Loading ES modules without a bundler

```html
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
}}
</script>
<script type="module">
  import * as THREE from "three";
  import { OrbitControls } from "three/addons/controls/OrbitControls.js";
  // …
</script>
```

`esm.sh`, `jsdelivr`, and `unpkg` all serve any npm package this way. `esm.sh/<pkg>` is the
most forgiving for transitive deps.

### Curated libraries

| Need | Use | CDN |
|---|---|---|
| 3D / WebGL | **three.js** | `cdn.jsdelivr.net/npm/three@0.160.0/` (importmap above) |
| Charts / dashboards | **ECharts** | `cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js` |
| Charts (lightweight) | **Chart.js** | `cdn.jsdelivr.net/npm/chart.js@4` |
| Creative coding / canvas | **p5.js** | `cdn.jsdelivr.net/npm/p5@1/lib/p5.min.js` |
| Reactive UI without a build | **Alpine.js** | `cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js` (`defer`) |
| HTML-over-the-wire interactions | **htmx** | `unpkg.com/htmx.org@2` |
| Tiny VDOM | **Preact** (via esm.sh) | `esm.sh/preact@10` + `esm.sh/htm` |
| Animation | **GSAP** | `cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js` |
| Markdown | **marked** | `cdn.jsdelivr.net/npm/marked@12/marked.min.js` |
| Dates | **day.js** | `cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js` |
| Icons | **lucide** | `unpkg.com/lucide@latest` |
| Fonts | **Google Fonts / Fontsource** | `fonts.googleapis.com` / `cdn.jsdelivr.net/npm/@fontsource/...` |

Styling: write plain CSS, or pull a classless sheet (**Pico.css** `cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css` — instant decent-looking forms) or Tailwind's Play CDN (`cdn.tailwindcss.com`, dev only — fine for internal toys).

### CC0 / royalty-free assets (no attribution headaches)

| Kind | Source | Notes |
|---|---|---|
| 3D models, sprites, UI kits, audio | **Kenney** — kenney.nl/assets | CC0. The universe uses these (ships, trees, asteroids, SFX). Drop into `public/` and upload with the bundle, or host on `worlds.uploads`. |
| SFX | **Kenney audio packs**, **freesound.org** (filter CC0) | bundle small clips; large media → `worlds.uploads` (≤25MB). |
| Textures / HDRIs | **Poly Haven** — polyhaven.com | CC0, hotlinkable. |
| Photos | **Unsplash** | free, hotlinkable via `images.unsplash.com`. |
| Emoji / open icons | **lucide**, **Twemoji** | MIT / CC-BY. |

Credit CC0 sources in a `CREDITS.txt` even when not required — it's polite and copy-pasteable
for the next builder.

---

## Gotchas

- **Use relative URLs everywhere** (`/worlds.js`, `./style.css`, `/u/<site>/<file>`). Never
  hardcode `https://<site>.<your-worlds-host>` — sites are same-origin and must stay portable.
- **`index.html` must be at the folder root.** That's what makes a folder a site. SPA routing?
  add `"spa_fallback": true` to `.world.json`.
- **`worlds.*` methods are async and ready immediately** — `worlds.me()`, `worlds.db.collection(...)`
  etc. work the moment the script tag runs (the SDK queues internally). For the site's own
  name/url, `await worlds.ready` first (`worlds.site` is `{name, url}`).
- **Every rejection is a `WorldsError`** with `{code, message, status, retry_after?}`. Codes:
  `unauthorized · not_found · rate_limited · payload_too_large · quota_exceeded ·
  invalid_request · reserved_name · conflict · replay_expired · maintenance · upstream_error ·
  internal`. Branch on `e.code`, not on message text.
- **db filters are AND-only**, single sort key, ops `{gt,gte,lt,lte,ne,in}` plus equality on
  dot paths (`"author.handle"`). No OR, no aggregation in v1 — do those client-side after `list`.
- **Counters**: use `c.increment(id, field, by)`, never `get`→`+1`→`update` (it races).
- **Ephemeral vs durable**: high-frequency/transient state (cursors, presence, "is typing") →
  `worlds.ws` (not persisted, no quota). State you want back on reload → `worlds.db`.
- **Subscriptions survive reconnects** via cursor replay; after a long offline gap the SDK
  re-lists for you (you may see `type:"update"` for docs you already had — make renders idempotent
  by keying on `doc.id`).
- **No secrets, no permissions, no backends, no cron.** It's internal-only, so unsecured
  guestbooks/leaderboards are fine — but don't put anything you wouldn't want everyone on your
  instance to read or overwrite. For secrets/scheduled jobs/public audiences, use a real product surface.
- **Reserved site names**: `api www home hello assets uploads list mcp docs u`.
- **Cache**: site HTML is `no-cache`+ETag (redeploys show on next refresh); assets are
  `max-age=60`. If you redeploy a `.js`/`.css` and see the old one, hard-refresh.
- **Anyone can overwrite any site.** The deploy log is the audit trail, not a lock. Pick a
  site name you're okay sharing; coordinate on shared ones.
