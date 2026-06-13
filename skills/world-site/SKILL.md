---
name: world-site
description: Build and deploy an internal website on Worlds (a self-hostable hosting platform). Use whenever someone wants to ship a quick internal tool, dashboard, prototype, game, or page that teammates can open at a URL — "put this online", "make a Worlds site", "deploy this for the team", "build me an internal dashboard/tool/game". Worlds gives any signed-in user a site at <name>.<your-worlds-host> with a built-in SDK (database, AI, file uploads, realtime, identity) and zero infra.
---

# Build & deploy a Worlds site

Worlds turns a **folder of static files** into a live, signed-in-only website at
`<name>.<your-worlds-host>`. No build, no backend, no keys. Add one `<script src="/worlds.js">`
tag and you get a database, AI, uploads, realtime channels, and the visitor's identity —
all behind the sign-in gate, so it's safe to keep simple.

## The 30-second path

1. Make a folder with an **`index.html`** at its root. Add `<script src="/worlds.js"></script>`.
2. (Optional) add `.world.json`: `{"description": "...", "category": "games|work|tools|experiments|misc"}`.
3. Deploy it — three equivalent ways:
   - **CLI**: `worlds deploy` (or `worlds deploy <name>`) from the folder.
   - **MCP**: connect `<your-worlds-host>/mcp` and call `deploy_site(name, files)`.
   - **Browser**: drag the folder onto your Worlds host.
4. It's live at `https://<name>.<your-worlds-host>`. Re-deploy to update (overwrite; no versioning).

## The SDK (`worlds.js`) — one tag, no keys

```js
await worlds.me()                                  // {email, name, handle, avatar_url}
const c = worlds.db.collection("posts")            // JSONB docs, scoped to this site
await c.create({title, votes: 0})                 // → {id, data, created_by, created_at, updated_at}
await c.get(id) · c.update(id, patch) · c.replace(id, doc) · c.delete(id)
await c.increment(id, "votes", 1)                 // atomic counters (no read-modify-write races)
await c.list({filter:{votes:{gt:0}}, sort:"-votes", limit:20})  // filter ops: gt gte lt lte ne in, AND only
c.subscribe(ev => …)                              // realtime {type:create|update|delete, doc}; survives reconnects
worlds.db.site("home").collection("sites")         // cross-world READ (writes stay yours)

await worlds.ai.complete("prompt" | {messages, system, model:"fast"|"smart", max_tokens})  // → {text}
await worlds.ai.embed(text) · worlds.ai.image(prompt, {size})   // image → stored upload URL

await worlds.uploads.put(file, {name}) · worlds.uploads.list() · worlds.uploads.delete(name)  // ≤25MB
const ch = worlds.ws.channel("room"); ch.publish(payload); ch.subscribe(cb); ch.presence(cb) // multiplayer
await worlds.notify.slack("#channel", "text")      // capped + stamped with site & sender
```

Every call returns a promise; rejections are `WorldsError` with `{code, message}`.

## Rules (deliberate — keep sites simple)

- **No backends, no cron, no per-site secrets, no permissions.** Anyone can overwrite any
  site; the deploy log is the audit trail. It's internal-only, so unsecured guestbooks /
  leaderboards / multiplayer toys are fine — everyone on your instance can read and overwrite.
- **Reserved names**: `api www home hello assets uploads list mcp docs u`.
- **Limits**: doc 256KB · 50 collections/site · 25MB upload · 1GB/site · 200 AI completions
  + 50 images / user / day · deploy 100MB & 60/site/hour.
- **Use relative URLs** (`/worlds.js`, `./style.css`) — never hardcode the host. Sites are
  same-origin and portable.

## Tips & resources

- **Starter**: copy [`template/`](template/) (a notes board — identity + db + realtime in one
  `index.html` + `.world.json`) and edit from there.
- **Recipes + resources**: [reference.md](reference.md) has copy-paste recipes (guestbook,
  live poll, multiplayer cursors, AI toy, upload gallery, Slack alert, the universe pattern)
  plus a curated list of CDN libraries and CC0 asset sources (three.js, Kenney, ECharts, …) —
  sites are static behind the gate, so any CDN works.
- **Live contract**: `/llms.txt` and `/docs` are always current — read them rather
  than guessing method names.

## When NOT to use Worlds

External/public audiences, anything secret (no permissions), heavy/long compute, scheduled
jobs, or receiving public webhooks. For those, point to a real product surface or your backend.
