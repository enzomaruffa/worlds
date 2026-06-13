# Quickstart

Make a folder with an `index.html`. Deploy it. Done.

```sh
world init my-site      # or just write index.html yourself
world deploy            # → https://my-site.<your-world-host>
```

No CLI? Drag the folder onto your World homepage in the browser, or give Claude the
MCP URL (`<your-world-host>/mcp`) and say "deploy this".

Add superpowers with one script tag — no keys, no config:

```html
<script src="/world.js"></script>
<script>
  const me = await world.me();
  const posts = world.db.collection("guestbook");
  await posts.create({ text: "hello", by: me.name });
  posts.subscribe(ev => render(ev));
</script>
```

Optional `.world.json` at the folder root:
`{"description": "what this is", "category": "games", "spa_fallback": true}`.
Categories: `games`, `work`, `tools`, `experiments`, `misc` (default) — they decide which
star system your world orbits on the universe map.

What World is not for: anything external-facing, secrets (there are no permissions),
heavy compute, cron jobs. Scheduled reports become "refresh when opened, ping Slack when off".
