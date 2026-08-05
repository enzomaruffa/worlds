# Deploying worlds at Plex — what's left

Status as of 2026-08-05. The deployment fork is `plexinc/worlds`; features land upstream in
`enzomaruffa/worlds` and sync via `git merge source/main`.

**The wildcard is vetoed**, so this runs in **path mode**: every world lives at
`world.plex.bz/app/<site>/` on one hostname. That is a supported first-class mode
(`WORLDS_ROUTING=path`), not a degraded fallback — but the chart currently in the fork is
written for the wildcard and will not work as-is.

## What the veto changes

Path mode **removes three of the four genuinely-new infra asks** from the original
proposal. What's left is all standard-pattern work.

| Original ask | Path mode |
|---|---|
| Wildcard DNS `*.world.plex.bz` | One A/CNAME for `world.plex.bz` |
| Wildcard TLS cert | One single-host cert |
| Wildcard Cloudflare Access app | One app on one hostname |
| Mountpoint-S3 CSI addon | Not needed — the server has a native S3 backend |

The cost is **origin isolation**, and it is the one thing worth a deliberate decision:

- With subdomains, every world got its own origin. In path mode all worlds execute on
  `world.plex.bz` — the *same* origin that serves the homepage, the deploy UI and profile
  pages.
- So a deployed world's JavaScript runs same-origin with the platform: it can call
  `/api/v1/*` as the viewer with any `x-worlds-site` it likes, read other worlds'
  `localStorage`, and read any cookie scoped to `.plex.bz` that isn't `HttpOnly`.
- Inside an employee-only boundary that is the documented trade ("fine inside the sign-in
  boundary"), and it's the same posture the platform already takes on cross-world reads.
  But it means **any employee who deploys a world can act as any viewer of that world
  against the platform's own APIs.**
- If that is not acceptable, the fix needs no wildcard either: serve user content from a
  **second single-host origin** (e.g. `worlds-content.plex.bz/app/<site>/`) and keep the
  platform UI on `world.plex.bz`. Two single-host certs, two Access apps, one origin
  boundary restored.

## Chart changes required (`deploy/main/values.yaml`)

1. **Switch to path routing.** Add `WORLDS_ROUTING: path` to `env`. Without it the server
   defaults to `subdomain` and resolves every request to the apex site.
2. **Drop the wildcard hostname** from `route.main.hostnames` — keep only
   `world.plex.bz`. The `*.world.plex.bz` entry will never resolve.
3. **Set `autoscaling.minReplicas: 1` / `maxReplicas: 1`** (or disable autoscaling). This
   is the one that would ship visibly broken:
   - The realtime change feed and every realtime registry (`channelMembers`, `dbSubs`,
     `actorRooms`) are in-process module-level maps; `emitChange` only notifies listeners
     in its own process.
   - With 2+ pods, two players in the same room on different pods never see each other,
     and a `db.subscribe` misses writes served by another pod.
   - Session affinity does **not** fix this — the players are different users who need to
     reach the *same* pod, not a stable pod each.
   - Multi-pod needs Postgres `LISTEN/NOTIFY` fan-out first (called out in
     `server/db.ts:142`). One pod is the documented design and is plenty: Shopify's
     equivalent ran 50k sites on a single VM, and here the browser does the work.

## Still outstanding (unchanged, all standard patterns)

1. **Nothing has been pushed.** `plexinc/worlds` is an empty repo — the fork's 13 commits
   (CD workflow + Helm chart + docs) exist only locally.
2. ECR repo `worlds` + per-repo GHA OIDC push role (`role/gha-worlds`) — ARN is a
   `TODO(infra)` placeholder in `.github/workflows/deploy.yaml`.
3. IRSA role (`role/worlds`) with read/write on the sites+uploads bucket — placeholder.
4. S3 bucket (`plex-worlds-sites`), RDS Postgres (smallest tier), and Secrets Manager
   `worlds/config` holding `DATABASE_URL`, `WORLDS_SESSION_SECRET`, `GEMINI_API_KEY`,
   `SLACK_BOT_TOKEN`.
5. Cloudflare Access app on `world.plex.bz` injecting `Cf-Access-Authenticated-User-Email`
   (the server trusts it via `WORLDS_AUTH=gateway`, already set).
6. Add `plexinc/worlds` to ArgoCD's allowed source repos; confirm the hydrator action ref.
7. `ci.yaml` still says `runs-on: ubuntu-latest` — must be Blacksmith in a `plexinc` repo.
   (`deploy.yaml` already is.)

## Known gaps once it's up

- **No screenshot thumbnails.** The universe shows planets without previews unless a
  Chromium binary is on `WORLDS_CHROME`; the Dockerfile installs only `tar`. Either add
  Chromium to the image (bigger) or accept blank previews.
- **The `nginx/` directory in the fork is an empty fossil** of the
  nginx+Mountpoint design and should be deleted. The Bun server serves static files
  itself through the blobstore.

## Sanity-checked, not assumed

Path + gateway mode was exercised in a browser with the identity header injected at the
edge the way Access does it: two tabs got distinct identities, `worlds.db` scoped
correctly by `x-worlds-site`, uploads round-tripped on the shared origin, and shared room
state synced over the `?site=` socket. Two path-mode bugs found and fixed on the way (the
visit beacon and `idle`'s storage key both derived the site from the hostname, which is
the apex for every world in path mode), plus one that this exact chart would have hit: the
universe used to 404 permanently after any pod restart, because seeding skipped when the
db row survived while `/data` (an `emptyDir`) came back empty.
