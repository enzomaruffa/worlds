# AGENTS.md — building on World

This file is for AI agents (Claude Code/Desktop, etc.). World is a self-hostable
internal hosting platform: **deploy a folder of static files → `<name>.<your-world-host>`**,
signed-in-only, with a batteries-included client SDK and zero infra.

## If you were asked to "put this online" / "make an internal tool/dashboard/game"

That's a World site. The full playbook is the **`world-site` skill** in this repo:
`skills/world-site/SKILL.md` (deploy path + SDK cheat sheet + rules) and
`skills/world-site/reference.md` (copy-paste recipes + CDN/CC0 resources + gotchas). A
ready-to-edit starter is at `skills/world-site/template/`.

The 30-second version:

1. A folder with an **`index.html`** at its root. Add `<script src="/world.js"></script>`.
2. Optional `.world.json`: `{"description":"…","category":"games|work|tools|experiments|misc"}`.
3. Deploy — `world deploy`, the MCP `deploy_site` tool (`<your-world-host>/mcp`), or drag-drop on your World host.
4. Live at `https://<name>.<your-world-host>`. Re-deploy to overwrite.

The SDK gives you `world.me()`, `world.db` (JSONB collections + realtime), `world.ai`
(Gemini), `world.uploads`, `world.ws` (multiplayer), and `world.notify.slack` — no keys,
no config, all behind the sign-in gate.

## Live, always-current contract

- `/llms.txt` — machine-readable manifest of the SDK + endpoints.
- `/docs` — human docs (also `docs/` in this repo: `sdk.md`, `quickstart.md`, `limits.md`).
- `spec/world-v1.yaml` — the frozen OpenAPI contract. `/api/v1` is additive-only forever.

Prefer these over guessing — the SDK surface is small and stable, but read it rather than
inventing method names.

## If you're working ON this repo (not just deploying a site)

- **Stack**: Bun + TypeScript, no runtime npm deps. `server/` (one module per concern,
  `BlobStore` abstracts the cloud), `sdk/src/` (modular → `bun run build:sdk` → the single
  served `sdk/world.js`; never hand-edit `sdk/world.js`), `cli/`, `homepage/`,
  `examples/universe/` (the flagship 3D dogfood — a World site, not part of the image).
- **Before committing**: `bunx tsc --noEmit` (typecheck) + `bun test` (e2e — needs `bun run db:up`).
- **The contract is frozen.** Anything under `/api/v1` and the `world.js` surface is
  additive-only: new optional fields, new endpoints, new error codes for new failure modes —
  never remove/rename/retype. Sites live forever without a rebuild.
- **Conventions**: one-liner conventional commits; comments only for non-obvious *why*;
  relative URLs in sites; `type` imports; `bunx tsc --noEmit` + `bun test` before committing.

## What World is NOT for

External/public audiences, secrets (no permissions — everyone on your instance can read/overwrite any
site), heavy/long compute, scheduled jobs, or public webhooks. For those, point at a real
product surface or your backend.
