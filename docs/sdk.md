# worlds.js — the SDK

One script tag: `<script src="/worlds.js"></script>`. Sets `window.worlds`. Everything returns
promises; every rejection is a `WorldsError` with `{code, message, status}`.

## Identity

```js
const me = await worlds.me();   // {email, name, handle, avatar_url}
await worlds.ready;             // resolves once the site context is loaded
worlds.site;                    // {name, url} — populated after `await worlds.ready`
```

## Errors

Every rejected promise is a `WorldsError` — `{ code, message, status, retry_after? }`.
`code` comes from a frozen registry, so you can branch on it reliably:

`unauthorized` · `invalid_request` · `not_found` · `conflict` · `payload_too_large` ·
`rate_limited` (carries `retry_after` seconds) · `quota_exceeded` · `upstream_error`
(AI provider) · `maintenance` · `internal`.

```js
try { await c.create(doc); }
catch (e) { if (e.code === "quota_exceeded") toast("easy there!"); else throw e; }
```

The SDK redirects to sign-in on session expiry and retries idempotent GETs on transient
errors — you never handle auth or flaky networks yourself.

## Database — `worlds.db`

Named collections of JSON documents (≤256KB each), scoped to your site automatically.

```js
const c = worlds.db.collection("posts");
const doc = await c.create({ title: "hi", votes: 0 });   // {id, data, created_by, created_at, updated_at}
await c.get(doc.id);
await c.update(doc.id, { title: "hi!" });                 // shallow merge
await c.replace(doc.id, { title: "fresh" });
await c.increment(doc.id, "votes", 2);                    // atomic — no read-modify-write races
await c.delete(doc.id);
const page = await c.list({ filter: { votes: { gt: 0 } }, sort: "-votes", limit: 20 });
const stop = c.subscribe(ev => { /* {type: create|update|delete, doc} */ });
```

Filters: `{field: value}` equality or `{gt,gte,lt,lte,ne,in}`, dot paths allowed, AND only.
Subscriptions survive reconnects (cursor replay); after long offline gaps the SDK re-lists for you.

### Reading other worlds

Reads are open across worlds (you could see the data by visiting the site anyway); writes
always stay with the owning site:

```js
const sites = worlds.db.site("home").collection("sites");   // the platform's own site registry
await sites.list();                                        // read-only: list/get/subscribe
sites.subscribe(ev => addPlanet(ev.doc));                  // this is how the universe map works
```

## AI — `worlds.ai`

```js
const { text } = await worlds.ai.complete("one-line haiku about plex");
const { text: t2 } = await worlds.ai.complete({ messages, system, model: "smart", max_tokens: 500 });
// stream tokens as they arrive (still resolves with the full {text, model} at the end):
await worlds.ai.complete({ prompt, stream: true, onToken: (chunk) => append(chunk) });
const { vector } = await worlds.ai.embed("some text");
const { url } = await worlds.ai.image("a tiny planet", { size: "1024" });
await worlds.ai.models();   // discover the available model aliases
```

Models are aliases (`fast`, `smart`) — never raw provider ids. Daily per-user caps apply.

## Uploads — `worlds.uploads`

```js
const { url } = await worlds.uploads.put(file);   // ≤25MB, 1GB per site
await worlds.uploads.list();
await worlds.uploads.delete("photo.jpg");
```

## Realtime channels — `worlds.ws`

```js
const ch = worlds.ws.channel("cursors");
ch.publish({ x, y });                       // ≤16KB JSON
const stop = ch.subscribe(msg => { /* {payload, from: {handle, name}, at} */ });
ch.presence(list => { /* [{handle, name}] */ });
```

## Rooms — `worlds.room` / `worlds.rooms`

A **room** is one named shared space for everyone on the site. It rolls the two
things every multiplayer app re-implements into one primitive:

- **the roster** — a live list of who's here, a stable host, ready toggles, and a
  clean start / return-to-lobby. The roster **always includes you**, even before
  the server echoes your own presence back, so the host never flickers and a fresh
  joiner is never mistaken for "everyone left".
- **the state** — pass `initial` and the room also carries ONE authoritative
  document (a board, a quiz, a round): load-or-created, kept live, and guarded
  against out-of-order writes by a hidden `_rev`.

A waiting room is just a room with no `initial`. A board game is a room with one.

```js
const r = worlds.room("chess", {
  minPlayers: 2,             // smallest roster that may start (default 1)
  maxPlayers: 2,             // roster cap → fills `full` (default 0 = unlimited)
  autoStart: true,           // host starts once everyone is ready (default true)
  initial: () => ({ board: blank(), turn: "x" }),  // omit for a roster-only room
  onChange: (s) => render(s),      // roster OR state changed
  onStart:  (s) => beginGame(s),   // fires on every client when the game starts
  onReturn: (s) => showLobby(s),   // fires on every client on return-to-lobby
});

await r.opened;               // resolves once loaded/created + identity is known
r.toggleReady();              // or r.setReady(true/false)
r.start();                    // host-only; broadcasts start to everyone
r.returnToLobby();            // send everyone back to the waiting room
r.isHost;                     // am I the host (smallest handle)?
r.members;                    // [{handle,name,ready,isMe,isHost}]

r.state;                      // current shared doc (null if no `initial`)
await r.set(next);            // full replace, monotonic
await r.merge({ turn: "o" }); // shallow-merge onto current, then write
await r.reset();              // back to initial (+ optional overrides)
r.onChange((s) => render(s)); // ONE subscription; fires on roster OR state change
r.leave();                    // alias r.destroy()
```

The snapshot `s` (from `r.snapshot()` and `onChange(s)`): `{ me,
members:[{handle,name,ready,isMe,isHost}], host, isHost, ready, readyCount, total,
allReady, full, started, loaded, state }`. `ready` is whether **you** are ready;
`loaded` is `true` once presence has reported at least once (gate "opponent left"
checks on it); `state` is the shared doc.

`set`/`merge` return `false` on a write conflict — call `r.refetch()` and retry.
Two clients writing the newest `_rev` is last-write-wins (fine for toys; add your
own turn/seat gating for stricter games — see the connect4 example). For a
db-driven start, pass `autoStart:false` and trigger your own start from `onChange`
when `s.allReady`.

`key` (advanced) lets one collection hold more than one room's doc — defaults to
`${name}-main`; `worlds.rooms` uses it under the hood to pack many rooms into a
single collection.

### Many rooms — `worlds.rooms`

The plural is a live **directory** of concurrent rooms — a lobby browser with
private join codes. Each `create`/`join`/`joinByCode` hands back a normal
`worlds.room` scoped to its own instance. Reach for it when a site needs more than
one match at a time (many chess tables, several quizzes, private party rooms).

```js
const hall = worlds.rooms("chess", {
  minPlayers: 2, maxPlayers: 2,
  initial: () => ({ board: blank(), turn: "x" }),  // each room gets its own state
  onList: (rooms) => renderTables(rooms),          // public list changed (live)
});

hall.list();                                  // RoomInfo[] of open rooms right now
const r = await hall.create({ name: "Enzo's table" });   // make one, join it
const r = await hall.join(roomId);            // join a listed room
const r = await hall.joinByCode("K7QF");      // join by code (works for private)
await hall.create({ private: true });         // hidden from the list, code-only
await hall.leave();                           // leave; the host closes empty rooms
hall.current;                                 // the joined room (or null)
```

Each returned room also carries `r.id` and `r.code` (show the code so others can
join). `RoomInfo`: `{ id, code, name, host, members, count, max, status:"open"|
"playing", full, private, createdAt, updatedAt }`. The room's host mirrors its
roster into the directory and heartbeats it; rooms whose host goes quiet for
`ttlMs` (default 45s) are swept, so the list self-heals after crashes and closed
tabs.

## Realtime actors — `worlds.actors`

The realtime tier for per-member **live state** — poses, cursors, ship positions —
beside `worlds.ws` (ephemeral events) and `worlds.room` (one authoritative doc).
Each member publishes ONE last-value state with `set`; the server keeps it and fans
it out **only to same-zone peers**, **batched** at a fixed flush rate. That turns the
per-tick `O(N²)` fan-out of raw channels into `O(N · zone)`, so a crowd scales. You
also get an instant **snapshot on join** (a fresh player sees everyone immediately,
not a blank screen) and a server-enforced rate cap (no client can melt a room by
publishing faster). Use this instead of hand-rolling pose channels with adaptive
send-rates.

```js
const net = worlds.actors("race", {
  zoneKey: (s) => s.cell,   // interest zone derived from state — same zone = see each other
  rate: 15,                 // server flush Hz, 1..20 (default 15; the first member sets it)
});

net.set({ x, y, z, cell });                          // publish MY state (zone via zoneKey)
net.onChange((id, state, meta) => draw(id, state));  // a peer in my zone created/updated
net.onLeave((id) => remove(id));                     // a peer left my zone or disconnected
net.others();                                        // [{ id, handle, name, state }] in my zone
net.stop();                                          // unsubscribe + drop listeners
```

`id` is the peer's stable per-tab id (`worlds.id()`); `meta` carries `{id, handle, name}`.
A **zone** is any string you derive from state — make it **spatial** (a grid cell)
and you sync only nearby peers no matter how many people are connected. `set` is
fire-and-forget at frame rate; the server coalesces multiple sets between flushes to
the latest, so just call it every frame. State is ephemeral (≤16KB) — keep anything
that must survive a reload in `worlds.db` / `worlds.room`.

## Utility building blocks

Small things every multiplayer/collab site re-implements — included so you don't:

```js
worlds.toast("saved!");                 // self-contained transient toast (injects its own element)
worlds.id();                            // stable per-tab id — attach as `cid` to ws msgs to skip your own echo
worlds.colorFor(handle);                // deterministic "hsl(…)" color — same handle → same color everywhere
worlds.uniqByHandle(members);           // dedupe a presence list by handle → [{handle, name}]
worlds.esc(userText);                   // HTML-escape before innerHTML
const t = worlds.countdown(endsAt, { onTick: (ms) => …, onEnd: () => … }); // t.stop() to cancel
```

Every site also gets an automatic **"◐ Worlds" leave pill** (top-left) that flies the
visitor back to the universe — so no world is a dead end. Opt out with
`window.__worldsNoLeave = true` before the `worlds.js` tag.

## Notify — `worlds.notify`

```js
await worlds.notify.slack("#my-channel", "the dashboard went red");
```

Capped per user/day and always stamped with the site + sender. Notify, never impersonate.
