# world.js — the SDK

One script tag: `<script src="/world.js"></script>`. Sets `window.world`. Everything returns
promises; every rejection is a `WorldError` with `{code, message, status}`.

## Identity

```js
const me = await world.me();   // {email, name, handle, avatar_url}
world.site                     // {name, url} after world.ready()
```

## Database — `world.db`

Named collections of JSON documents (≤256KB each), scoped to your site automatically.

```js
const c = world.db.collection("posts");
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
const sites = world.db.site("home").collection("sites");   // the platform's own site registry
await sites.list();                                        // read-only: list/get/subscribe
sites.subscribe(ev => addPlanet(ev.doc));                  // this is how the universe map works
```

## AI — `world.ai`

```js
const { text } = await world.ai.complete("one-line haiku about plex");
const { text: t2 } = await world.ai.complete({ messages, system, model: "smart" });
const { vector } = await world.ai.embed("some text");
const { url } = await world.ai.image("a tiny planet");
```

Models are aliases (`fast`, `smart`) — never raw provider ids. Daily per-user caps apply.

## Uploads — `world.uploads`

```js
const { url } = await world.uploads.put(file);   // ≤25MB, 1GB per site
await world.uploads.list();
await world.uploads.delete("photo.jpg");
```

## Realtime channels — `world.ws`

```js
const ch = world.ws.channel("cursors");
ch.publish({ x, y });                       // ≤16KB JSON
const stop = ch.subscribe(msg => { /* {payload, from: {handle, name}, at} */ });
ch.presence(list => { /* [{handle, name}] */ });
```

## Notify — `world.notify`

```js
await world.notify.slack("#my-channel", "the dashboard went red");
```

Capped per user/day and always stamped with the site + sender. Notify, never impersonate.
