# worlds.js — the SDK

One script tag: `<script src="/worlds.js"></script>`. Sets `window.worlds`. Everything returns
promises; every rejection is a `WorldsError` with `{code, message, status}`.

## Identity

```js
const me = await worlds.me();   // {email, name, handle, avatar_url}
worlds.site                     // {name, url} after worlds.ready()
```

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
const { text: t2 } = await worlds.ai.complete({ messages, system, model: "smart" });
const { vector } = await worlds.ai.embed("some text");
const { url } = await worlds.ai.image("a tiny planet");
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

## Multiplayer lobby — `worlds.lobby`

A waiting room with batteries included: a live roster, a stable host, ready
toggles, and a clean start. The roster **always includes you** — even before the
server echoes your own presence back — so the host never flickers and a fresh
joiner is never mistaken for "everyone left". State is ephemeral (rides a ws
channel); keep authoritative game state in `worlds.db`.

```js
const lobby = worlds.lobby("room", {
  autoStart: true,            // host starts once everyone is ready (default true)
  minPlayers: 2,              // smallest roster that may start (default 1)
  onUpdate: (s) => render(s), // roster/ready/host changed
  onStart:  (s) => beginGame(s),   // fires on every client when the game starts
  onReturn: (s) => showLobby(s),   // fires on every client on return-to-lobby
});

lobby.toggleReady();          // or lobby.setReady(true/false)
lobby.start();                // host-only; broadcasts start to everyone
lobby.returnToLobby();        // send everyone back to the waiting room
lobby.isHost;                 // am I the host (smallest handle)?
lobby.snapshot();             // current state, same shape as onUpdate(s)
```

The snapshot `s`: `{ me, members:[{handle,name,ready,isMe,isHost}], host, isHost,
ready, readyCount, total, allReady, started, loaded }`. `loaded` is `true` once
presence has reported at least once — gate "opponent left" checks on it.

For db-driven games (authoritative phase in a shared doc), pass `autoStart:false`
and trigger your own start from `onUpdate` when `s.allReady` — the lobby still
gives you the self-inclusive roster, host election, and ready sync.

## Shared room state — `worlds.room`

ONE shared, authoritative document for the whole site, kept live for everyone —
the turn-based / single-board / single-quiz pattern. It load-or-creates the doc,
subscribes, and guards ordering for you (a hidden `_rev` drops stale/out-of-order
writes), so you just describe state transitions. Use `worlds.lobby` for the
pre-game waiting room, `worlds.ws` for ephemeral per-frame data, and `worlds.room`
when there's a single source of truth that must survive reloads.

```js
const board = worlds.room("connect4", { initial: () => ({ cells: [], turn: "x" }) });
await board.ready;                 // loaded or freshly created
board.get();                       // current state
board.onChange((s) => render(s));  // fires on load + every change (incl. your own writes)
await board.set(next);             // full replace, monotonic
await board.merge({ turn: "o" });  // shallow-merge onto current, then write
await board.reset();               // back to initial (+ optional overrides)
```

Returns `false` from `set`/`merge` on a write conflict — call `board.refetch()`
and retry. Two clients writing the newest `_rev` is last-write-wins (fine for toys;
add your own turn/seat gating for stricter games — see the connect4 example).

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
