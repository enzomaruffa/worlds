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

### Document schemas (`.world.json` → `docs`)

A `worlds.doc` document is a Yjs tree the server never interprets, so by default any
client can put anything in it. A site declares, per document-name pattern, which node
types may appear, where, with which attributes, and how big the whole thing may get. The
server checks every update against this before committing it; an update that breaks a
rule is rejected and the sender resyncs, nobody else notices.

```json
{
  "docs": {
    "plan-*": {
      "nodes": {
        "root":      {"children": ["heading", "paragraph", "decision"]},
        "heading":   {"attrs": {"__tag": {"enum": ["h1", "h2", "h3"]}}, "children": ["text"], "maxText": 500},
        "paragraph": {"children": ["text", "linebreak", "link"]},
        "text":      {},
        "linebreak": {},
        "link":      {"attrs": {"__url": {"urlPrefix": ["https://"]}, "__target": {"nullable": true}, "__rel": {"nullable": true}, "__title": {"nullable": true}}, "children": ["text"]},
        "decision":  {"attrs": {"__id": {"ref": "decisions"}}}
      },
      "limits": {"depth": 20, "bytes": 4194304, "perType": {"decision": 200}}
    }
  }
}
```

- The tree shape is the one Lexical's Yjs binding writes: a root `Y.XmlText` named `root`,
  elements as embedded `Y.XmlText` with `__type` plus `__*` attributes, text as a
  `{__type: "text"}` map followed by the string, leaves as a map or `Y.XmlElement`. Any
  editor that writes this shape works; `root` and `typeAttr` are configurable.
- Lexical's base attributes (`__format`, `__style`, `__indent`, `__dir`, `__textFormat`,
  `__textStyle`, `__mode`, `__detail`) are allowed on every node with sane bounds; add or
  override under `commonAttrs`.
- Attribute rules: `type` (`string|int|number|bool|json|object|any`), `enum`, `maxLen`, `min`, `max`,
  `urlPrefix`, `nullable`, and `ref` — the value must be the id of a document in that
  collection of this site, checked at commit. `object` walks a nested map (Lexical keeps a
  node's state in one `__state` attribute) key by key through `props`, refusing undeclared
  keys unless `open: true`. Anything not declared is a violation.
- `children` lists what may sit directly beneath a node; absent means the node is a leaf.
  `maxText` caps the characters directly inside one node.
- `limits`: `depth`, `bytes` (Yjs state), `nodes`, `textChars`, `perType`.

What Worlds is not for: anything external-facing, secrets (there are no permissions),
heavy compute, cron jobs. Scheduled reports become "refresh when opened, ping Slack when off".
