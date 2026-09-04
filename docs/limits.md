# Limits & guarantees

Quotas are floors — they can go up, never down for existing behavior.

| Thing | Limit |
|---|---|
| Document size | 256KB |
| Collections per site | 50 |
| Documents per collection | 50,000 |
| Upload size | 25MB |
| Uploads per site | 1GB (a site's `.world.json` can lower it, or raise it up to the operator's `WORLDS_UPLOAD_QUOTA_MAX`) |
| AI completions | 200 / user / day |
| AI images | 50 / user / day |
| Slack notifies | 50 / user / day |
| WS payload | 16KB |
| Document update (`worlds.doc`) | 512KB |
| Document state | 4MB before a rotation is asked for; 8MB hard ceiling |
| Documents per site | 200 (operator override: `WORLDS_DOCS_PER_SITE`) |
| Deploy bundle | 100MB, 2000 files |
| Deploys per site | 60 / hour |

## The forever-compat contract

`/api/v1` is frozen: endpoints, fields and error codes are never removed, renamed or retyped.
New stuff is always additive. `/worlds.js` is an evergreen alias; `/v1/worlds.js` never changes.
Errors are always `{error: {code, message, retry_after?}}` from a fixed registry.
Your site will work in five years without a rebuild. That's the whole deal.

## Caching

Site HTML is `no-cache` with ETags (an overwrite-deploy shows up on the next refresh).
Assets get `max-age=60, stale-while-revalidate=600`. `db`/`me`/`ai` responses are never cached.
