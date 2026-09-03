# Quickstart

Make a folder with an `index.html`. Deploy it. Done.

```sh
worlds init my-site      # or just write index.html yourself
worlds deploy            # → https://my-site.<your-worlds-host>
```

No CLI? Drag the folder onto your Worlds homepage in the browser, or give Claude the
MCP URL (`<your-worlds-host>/mcp`) and say "deploy this".

Add superpowers with one script tag — no keys, no config:

```html
<script src="/worlds.js"></script>
<script>
  const me = await worlds.me();
  const posts = worlds.db.collection("guestbook");
  await posts.create({ text: "hello", by: me.name });
  posts.subscribe(ev => render(ev));
</script>
```

Optional `.world.json` at the folder root:
`{"description": "what this is", "category": "games", "spa_fallback": true}`.
Categories: `games`, `work`, `tools`, `experiments`, `misc` (default) — they decide which
star system your world orbits on the universe map.

### Write rules (`.world.json` → `collections`, `uploads`)

By default every signed-in caller can write anything. A site can declare rules the server
enforces on every write; a rule the manifest gets wrong fails the deploy instead of being dropped.

```json
{
  "collections": {
    "decisions": {"appendOnly": true, "writers": ["service:app"]},
    "chat":      {"maxBytes": 16384, "urlFields": {"attachments[].url": ["/u/my-site/"]}}
  },
  "uploads": {"maxTotalBytes": 5368709120}
}
```

- `appendOnly` — documents can be created, never updated, incremented or deleted (`forbidden`).
- `writers` — `"user:<handle>"`, `"service:<handle>"` or `"*"`; anyone else gets `forbidden`.
- `maxBytes` — a tighter per-document cap than the platform's 256KB (`payload_too_large`).
- `urlFields` — dotted paths (`"a.b"`, `"items[].url"`) whose string values must start with one
  of the prefixes (`invalid_request`). Keeps media references inside the sign-in boundary.
- `uploads.maxTotalBytes` — the site's upload quota; can go below the default, and above it only
  up to the operator's ceiling.

Rules are read from the manifest of the current deploy: a bundle without them has none.

What Worlds is not for: anything external-facing, secrets (there are no permissions),
heavy compute, cron jobs. Scheduled reports become "refresh when opened, ping Slack when off".
