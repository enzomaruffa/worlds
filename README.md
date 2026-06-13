# World

**Deploy a folder of static files, get `<name>.<your-domain>` — instantly, with a
batteries-included client SDK.** World is a small, self-hostable internal hosting
platform: your team signs in with Google, drops a folder, and gets a live site with a
database, AI, file uploads, realtime channels and identity built in. No pipelines, no
keys, no infra knowledge. Inspired by [Shopify's Quick](https://shopify.engineering/quick).

> ⚠️ **Fully vibe-coded.** This was built end-to-end with an AI agent. The tests pass and
> it runs, but honestly nobody has deeply audited the internals — treat it as a fun
> experiment, not battle-tested infrastructure. Read the code, expect rough edges, don't
> put anything you'd cry over behind it. PRs and poking very welcome.

## What you get

One `<script src="/world.js">` tag — no keys, no config. The platform already knows who
you are (everyone signs in at the edge):

```js
const me    = await world.me();                      // { email, name, handle, avatar_url }
const posts = world.db.collection("guestbook");      // JSONB docs, queries, realtime
await posts.create({ text: "hi", by: me.name });
posts.subscribe(ev => render(ev));                   // live over one multiplexed WebSocket
const { text } = await world.ai.complete("…");       // Gemini, server-side key
await world.ai.complete({ prompt, stream: true, onToken: t => append(t) });  // streaming
const { url }  = await world.uploads.put(file);      // file storage
world.ws.channel("room").publish({ x, y });          // multiplayer pub/sub
await world.notify.slack("#data", "dashboard is red");
```

The homepage ships as a **3D universe** — every site is a planet you can fly through.
It's just a World site built on the public SDK (`examples/universe/`).

## Quick start (self-host)

```sh
cp .env.example .env        # fill in GOOGLE_CLIENT_ID/SECRET, WORLD_SESSION_SECRET, GEMINI_API_KEY
docker compose up           # server + Postgres
```

Open `http://world.localhost:8420` (or your configured domain) → sign in with Google →
you're in. The universe is seeded as the first world.

You'll want **wildcard DNS + TLS** for `*.<your-domain>` so each site gets its own
subdomain, a **Google OAuth client** (redirect URI `https://<your-domain>/auth/callback`),
and a long random `WORLD_SESSION_SECRET`. See [deploy/README.md](deploy/README.md).

## Auth

- **`WORLD_AUTH=google`** (default): built-in Google sign-in. The server runs the OAuth
  flow and sets a signed session cookie scoped to `*.<your-domain>`, so one sign-in covers
  every site. Restrict who's allowed with `WORLD_ALLOWED_DOMAINS` / `WORLD_ALLOWED_EMAILS`
  (empty = any Google account).
- **`WORLD_AUTH=gateway`**: trust a verified-email header from an upstream proxy
  (oauth2-proxy / IAP / Cloudflare Access). For when you already terminate auth at the edge.

## Stack

- **Bun + TypeScript** server, no runtime npm deps — `Bun.serve`, `Bun.sql` (Postgres),
  `Bun.file`, `fetch`. Multiplexes by `Host`: `<site>.<base>` → that site's files, bare
  base → the homepage, `/api/v1/*` → the platform.
- **Postgres** for `world.db` collections, the deploy log, profiles, and realtime events.
- **Gemini** for `world.ai` (server-side key only — clients never see it).
- Cloud storage is behind a `BlobStore` seam (local fs by default; swap in S3/GCS).

## Dev

```sh
bun install
bun run db:up                 # Postgres in docker (compose.yaml)
bun run build:sdk             # build sdk/src → sdk/world.js
bun run dev                   # server on :8420 (WORLD_DEV=1 stubs identity as dev@localhost)

bun cli/world.ts init && bun cli/world.ts deploy   # deploy a folder with an index.html
```

`bun test` runs the e2e suite (needs `db:up`). `bunx tsc --noEmit` typechecks.

## Layout

```
server/        Bun API + static serving (one module per concern; BlobStore abstracts storage)
sdk/src/       world.js SDK source (modular TS) — `bun run build:sdk` → sdk/world.js (generated)
cli/           the `world` CLI (login / init / deploy / open / list)
homepage/      the /list + 3D universe homepage (itself a World site)
tutorial/      the hello.world tutorial (served at the `hello` host)
examples/universe/  the flagship 3D "universe" — seeded as the first world
docs/          user docs (served at /docs, /llms.txt)
spec/          world-v1.yaml — the frozen API contract
skills/        an agent skill so Claude can build + deploy World sites
```

## The v1 contract (never breaks)

Deployed sites live forever and are never rebuilt, so `/api/v1` and `/world.js` are
**frozen, additive-only**. Errors are always `{error:{code,message,retry_after?}}` from a
fixed registry; AI models are stable aliases (`fast`, `smart`). Full surface in
[docs/sdk.md](docs/sdk.md), [docs/limits.md](docs/limits.md), and `spec/world-v1.yaml`.

## Agents

There's an MCP server at `/mcp` and a [`world-site` skill](skills/world-site/SKILL.md) so
Claude (Code/Desktop) can build and deploy sites unaided — point it at the docs and say
"deploy this."

## License

MIT — see [LICENSE](LICENSE).
