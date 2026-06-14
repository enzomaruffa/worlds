# Worlds

**Deploy a folder of static files, get `<name>.<your-domain>` — instantly, with a
batteries-included client SDK.** Worlds is a small, self-hostable internal hosting
platform: your team signs in with Google, drops a folder, and gets a live site with a
database, AI, file uploads, realtime channels and identity built in. No pipelines, no
keys, no infra knowledge. Inspired by [Shopify's Quick](https://shopify.engineering/quick).

> ⚠️ **Fully vibe-coded.** This was built end-to-end with an AI agent. The tests pass and
> it runs, but honestly nobody has deeply audited the internals — treat it as a fun
> experiment, not battle-tested infrastructure. Read the code, expect rough edges, don't
> put anything you'd cry over behind it. PRs and poking very welcome.

## What you get

One `<script src="/worlds.js">` tag — no keys, no config. The platform already knows who
you are (everyone signs in at the edge):

```js
const me    = await worlds.me();                      // { email, name, handle, avatar_url }
const posts = worlds.db.collection("guestbook");      // JSONB docs, queries, realtime
await posts.create({ text: "hi", by: me.name });
posts.subscribe(ev => render(ev));                   // live over one multiplexed WebSocket
const { text } = await worlds.ai.complete("…");       // Gemini, server-side key
await worlds.ai.complete({ prompt, stream: true, onToken: t => append(t) });  // streaming
const { url }  = await worlds.uploads.put(file);      // file storage
worlds.ws.channel("room").publish({ x, y });          // multiplayer pub/sub
worlds.lobby("room", { onStart: begin });             // waiting room: roster, host, ready, auto-start
const board = worlds.room("connect4");                // one shared, live, conflict-guarded doc
await worlds.notify.slack("#data", "dashboard is red");
worlds.toast("saved!"); worlds.colorFor(handle);      // batteries: toast, color-from-handle, id, esc…
```

The example sites under `examples/games/` (connect4, trivia, spyfall, racing, paint-arena,
red-light, draw-guess, hangout, quick-poll) are the reference implementations of these
primitives — read them to see `worlds.lobby` + `worlds.room` in real multiplayer use.

The homepage ships as a **3D universe** — every site is a planet you can fly through.
It's just a Worlds site built on the public SDK (`universe/`).

## Quick start (self-host)

```sh
cp .env.example .env        # fill in GOOGLE_CLIENT_ID/SECRET, WORLDS_SESSION_SECRET, GEMINI_API_KEY
docker compose up           # server + Postgres
```

Open `http://worlds.localhost:8420` (or your configured domain) → sign in with Google →
you're in. The universe is seeded as the first world.

You'll want **wildcard DNS + TLS** for `*.<your-domain>` so each site gets its own
subdomain, a **Google OAuth client** (redirect URI `https://<your-domain>/auth/callback`),
and a long random `WORLDS_SESSION_SECRET`. See [deploy/README.md](deploy/README.md).

## Auth

- **`WORLDS_AUTH=google`** (default): built-in Google sign-in. The server runs the OAuth
  flow and sets a signed session cookie scoped to `*.<your-domain>`, so one sign-in covers
  every site. Restrict who's allowed with `WORLDS_ALLOWED_DOMAINS` / `WORLDS_ALLOWED_EMAILS`
  (empty = any Google account).
- **`WORLDS_AUTH=gateway`**: trust a verified-email header from an upstream proxy
  (oauth2-proxy / IAP / Cloudflare Access). For when you already terminate auth at the edge.

## Stack

- **Bun + TypeScript** server, no runtime npm deps — `Bun.serve`, `Bun.sql` (Postgres),
  `Bun.file`, `fetch`. Multiplexes by `Host`: `<site>.<base>` → that site's files, bare
  base → the homepage, `/api/v1/*` → the platform.
- **Postgres** for `worlds.db` collections, the deploy log, profiles, and realtime events.
- **Gemini** for `worlds.ai` (server-side key only — clients never see it).
- Cloud storage is behind a `BlobStore` seam (local fs by default; swap in S3/GCS).

## Dev

```sh
bun install
bun run db:up                 # Postgres in docker (compose.yaml)
bun run build:sdk             # build sdk/src → sdk/worlds.js
bun run dev                   # server on :8420 (WORLDS_DEV=1 stubs identity as dev@localhost)

bun cli/worlds.ts init && bun cli/worlds.ts deploy   # deploy a folder with an index.html
```

`bun test` runs the e2e suite (needs `db:up`). `bunx tsc --noEmit` typechecks.

## Layout

```
server/        Bun API + static serving (one module per concern; BlobStore abstracts storage)
sdk/src/       worlds.js SDK source (modular TS) — `bun run build:sdk` → sdk/worlds.js (generated)
cli/           the `worlds` CLI (login / init / deploy / open / list)
homepage/      the /list + 3D universe homepage (itself a Worlds site)
tutorial/      the hello.world tutorial (served at the `hello` host)
universe/  the flagship 3D "universe" — seeded as the first world
docs/          user docs (served at /docs, /llms.txt)
spec/          world-v1.yaml — the frozen API contract
skills/        an agent skill so Claude can build + deploy Worlds sites
```

## The v1 contract (never breaks)

Deployed sites live forever and are never rebuilt, so `/api/v1` and `/worlds.js` are
**frozen, additive-only**. Errors are always `{error:{code,message,retry_after?}}` from a
fixed registry; AI models are stable aliases (`fast`, `smart`). Full surface in
[docs/sdk.md](docs/sdk.md), [docs/limits.md](docs/limits.md), and `spec/world-v1.yaml`.

## Agents

There's an MCP server at `/mcp` and a [`world-site` skill](skills/world-site/SKILL.md) so
Claude (Code/Desktop) can build and deploy sites unaided — point it at the docs and say
"deploy this."

## License

MIT — see [LICENSE](LICENSE).
