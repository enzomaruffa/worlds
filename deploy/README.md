# Deploy / self-host

Worlds is **one container** (the Bun server) plus **Postgres**. The server multiplexes
everything by `Host`: each site's static files, the homepage, `/worlds.js`, the `/api/v1`
platform, and the `/mcp` agent endpoint.

## Fastest path (Docker Compose)

```sh
cp .env.example .env     # fill in the auth + AI keys (below)
docker compose up        # builds the server, starts Postgres, seeds the universe
```

The server listens on `:8420`. Put it behind a reverse proxy that terminates TLS and
forwards `*.<your-domain>` and `<your-domain>` to it.

## What you need for a real deploy

1. **Wildcard DNS + TLS** for `*.<your-domain>` and `<your-domain>` — every site gets its
   own subdomain (`<site>.<your-domain>`), the bare domain serves the homepage. Point both
   at your reverse proxy (Caddy/nginx/Traefik/Cloudflare) and set `WORLDS_BASE_DOMAIN`.
2. **A Google OAuth client** (https://console.cloud.google.com/apis/credentials):
   redirect URI `https://<your-domain>/auth/callback`. Set `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET`, and `WORLDS_PUBLIC_ORIGIN=https://<your-domain>` so sign-in always
   happens on the base domain (the session cookie is scoped to `.<your-domain>`).
3. **A session secret**: `WORLDS_SESSION_SECRET=$(openssl rand -hex 32)`.
4. (Optional) **`GEMINI_API_KEY`** for `worlds.ai`, **`SLACK_BOT_TOKEN`** for `worlds.notify`.
5. (Optional) restrict sign-in with `WORLDS_ALLOWED_DOMAINS` / `WORLDS_ALLOWED_EMAILS`.

A reverse proxy must forward WebSocket upgrades (`/api/v1/socket`) for realtime to work.

## Environment

| Var | Meaning |
|---|---|
| `WORLDS_BASE_DOMAIN` | wildcard base, e.g. `world.example.com`. `<site>.<base>` → that site; bare base → homepage. |
| `WORLDS_PUBLIC_ORIGIN` | external origin for the OAuth redirect, e.g. `https://world.example.com`. |
| `WORLDS_AUTH` | `google` (built-in sign-in, default) or `gateway` (trust a verified-email header from an upstream proxy). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client (google mode). |
| `WORLDS_ALLOWED_DOMAINS` / `WORLDS_ALLOWED_EMAILS` | comma-separated allowlist; empty = any Google account. |
| `WORLDS_SESSION_SECRET` | HMAC key for the session cookie — set a long random value. |
| `DATABASE_URL` | Postgres DSN (`worlds.db` collections, deploy log, profiles, events). |
| `WORLDS_DATA_DIR` | site + upload storage root (mount a volume; default `./data`). |
| `GEMINI_API_KEY` | server-side key for `worlds.ai` (optional). |
| `SLACK_BOT_TOKEN` | bot token for `worlds.notify.slack` (optional). |
| `WORLDS_SEED` | `1` seeds the universe as the first world on boot (default); `0` skips. |
| `WORLDS_CHROME` | path to a Chrome/Chromium binary to enable screenshot thumbnails. |
| `WORLDS_DEV` | `1` stubs identity as `dev@localhost` (local dev only — no real auth). |
| `WORLDS_FORWARD_SITE` | serve one site at unrecognized hosts (forward a single site over a non-wildcard tunnel). |

## Behind an existing auth proxy

If you already terminate auth at the edge (oauth2-proxy, Identity-Aware Proxy, Cloudflare
Access), set `WORLDS_AUTH=gateway` and have the proxy inject the verified email as
`X-Auth-Request-Email` (or `Cf-Access-Authenticated-User-Email`). Worlds trusts that header
and skips its own sign-in. The proxy must protect every host, including `*.<your-domain>`.

## Storage & scaling

Sites and uploads live under `WORLDS_DATA_DIR` via a `BlobStore` abstraction (local
filesystem by default). For multi-instance or object-store backends, implement `BlobStore`
for S3/GCS (the interface is in `server/blobstore.ts`). The realtime change-feed is
in-process today (single instance); fan out via Postgres `LISTEN/NOTIFY` before scaling out.
