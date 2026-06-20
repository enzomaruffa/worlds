import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spins the real server (random port, temp data dir) against the compose
// Postgres. These double as the seed of the golden contract corpus (Draft B):
// anything asserted here may never change shape.

const PORT = 8421 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
// Postgres persists across runs while the data dir doesn't — unique site names isolate runs.
const RUN = Date.now().toString(36);
const S1 = `t1-${RUN}`;
const S2 = `t2-${RUN}`;
let proc: ReturnType<typeof Bun.spawn>;
let dataDir: string;

function req(method: string, path: string, opts: { body?: unknown; form?: FormData; site?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {
    host: `${opts.site ?? S1}.worlds.localhost`,
    "x-worlds-csrf": "1",
    ...(opts.headers ?? {}),
  };
  let body: BodyInit | undefined = opts.form;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch(`${BASE}${path}`, { method, headers, body });
}

async function bundle(files: Record<string, string>): Promise<Blob> {
  const dir = await mkdtemp(join(tmpdir(), "world-bundle-"));
  for (const [name, content] of Object.entries(files)) await Bun.write(join(dir, name), content);
  const tar = join(dir, "out.tgz");
  Bun.spawnSync(["tar", "-czf", tar, "-C", dir, ...Object.keys(files)]);
  const blob = new Blob([await Bun.file(tar).arrayBuffer()]);
  await rm(dir, { recursive: true, force: true });
  return blob;
}

async function deploy(site: string, files: Record<string, string> = { "index.html": `<h1>${site}</h1>` }) {
  const form = new FormData();
  form.set("site", site);
  form.set("bundle", await bundle(files), "bundle.tgz");
  return req("POST", "/api/v1/deploy", { form, site: "home" });
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "world-data-"));
  proc = Bun.spawn(["bun", "server/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, WORLDS_PORT: String(PORT), WORLDS_DATA_DIR: dataDir, WORLDS_DEV: "1", WORLDS_DISABLE_WORKERS: "1", WORLDS_SEED: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not boot");
});

afterAll(async () => {
  proc?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

describe("hosting", () => {
  test("deploy → live, overwrite → updated", async () => {
    const res = await deploy(S1, { "index.html": "<h1>v1</h1>" });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.site).toBe(S1);
    expect(out.deploy_id).toStartWith("dp_");

    const page = await req("GET", "/", { site: S1 });
    expect(await page.text()).toContain("v1");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("etag")).toBeTruthy();

    await deploy(S1, { "index.html": "<h1>v2</h1>" });
    expect(await (await req("GET", "/", { site: S1 })).text()).toContain("v2");
  });

  test("etag revalidation returns 304", async () => {
    const first = await req("GET", "/", { site: S1 });
    const etag = first.headers.get("etag")!;
    const second = await req("GET", "/", { site: S1, headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
  });

  test("reserved names are rejected with the frozen error shape", async () => {
    const res = await deploy("api");
    expect(res.status).toBe(409);
    const out = await res.json();
    expect(out.error.code).toBe("reserved_name");
    expect(typeof out.error.message).toBe("string");
  });

  test("bundle without index.html is invalid_request", async () => {
    const res = await deploy("t-noindex", { "main.css": "body{}" });
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  test("unknown site 404s", async () => {
    expect((await req("GET", "/", { site: "nope" })).status).toBe(404);
  });

  test("only the owner (first uploader) can overwrite a site", async () => {
    const site = `${S1}-owned`;
    expect((await deploy(site, { "index.html": "<h1>v1</h1>" })).status).toBe(200); // dev owns it

    const form = new FormData();
    form.set("site", site);
    form.set("bundle", await bundle({ "index.html": "<h1>hijack</h1>" }), "bundle.tgz");
    const intruder = await req("POST", "/api/v1/deploy", { form, site: "home", headers: { "x-auth-request-email": "intruder@example.com" } });
    expect(intruder.status).toBe(403);
    expect((await intruder.json()).error.code).toBe("forbidden");

    expect((await deploy(site, { "index.html": "<h1>v2</h1>" })).status).toBe(200); // owner still can
  });
});

describe("identity", () => {
  test("me returns the dev identity with frozen fields", async () => {
    const me = await (await req("GET", "/api/v1/me")).json();
    expect(me).toMatchObject({ email: "dev@localhost", name: "Dev", handle: "dev" });
    expect(me.avatar_url).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\//);
  });

  test("gateway header wins over dev fallback", async () => {
    const me = await (await req("GET", "/api/v1/me", { headers: { "x-auth-request-email": "enzo.maruffa@example.com" } })).json();
    expect(me.handle).toBe("enzo.maruffa");
    expect(me.name).toBe("Enzo Maruffa");
  });

  test("mutations without csrf header are rejected", async () => {
    const res = await fetch(`${BASE}/api/v1/db/posts`, {
      method: "POST",
      headers: { host: "t1.worlds.localhost", "content-type": "application/json" },
      body: "{}",
    });
    expect((await res.json()).error.code).toBe("invalid_request");
  });
});

describe("worlds.db", () => {
  test("crud round-trip with envelope shape", async () => {
    const created = await (await req("POST", "/api/v1/db/posts", { body: { title: "hi", votes: 0 } })).json();
    expect(created.id).toStartWith("doc_");
    expect(created.data).toEqual({ title: "hi", votes: 0 });
    expect(created.created_by).toBe("dev");

    const got = await (await req("GET", `/api/v1/db/posts/${created.id}`)).json();
    expect(got.data.title).toBe("hi");

    const patched = await (await req("PATCH", `/api/v1/db/posts/${created.id}`, { body: { title: "hi!" } })).json();
    expect(patched.data).toEqual({ title: "hi!", votes: 0 });

    const bumped = await (await req("POST", `/api/v1/db/posts/${created.id}/increment`, { body: { field: "votes", by: 3 } })).json();
    expect(bumped.data.votes).toBe(3);

    const del = await (await req("DELETE", `/api/v1/db/posts/${created.id}`)).json();
    expect(del.deleted).toBe(true);
    const again = await (await req("DELETE", `/api/v1/db/posts/${created.id}`)).json();
    expect(again.deleted).toBe(false); // idempotent
  });

  test("filters, sort and cursor pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await req("POST", "/api/v1/db/scores", { body: { n: i, team: i % 2 ? "red" : "blue" } });
    }
    const red = await (await req("GET", `/api/v1/db/scores?filter=${encodeURIComponent('{"team":"red"}')}`)).json();
    expect(red.items.length).toBe(2);

    const top = await (await req("GET", `/api/v1/db/scores?sort=-n&limit=2`)).json();
    expect(top.items.map((d: { data: { n: number } }) => d.data.n)).toEqual([4, 3]);

    const page1 = await (await req("GET", `/api/v1/db/scores?limit=3`)).json();
    expect(page1.items.length).toBe(3);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = await (await req("GET", `/api/v1/db/scores?limit=3&cursor=${encodeURIComponent(page1.next_cursor)}`)).json();
    expect(page2.items.length).toBe(2);
    expect(page2.next_cursor).toBeNull();
  });

  test("filter ops: in (incl. empty → matches nothing, not invalid SQL)", async () => {
    for (const n of [1, 2, 3, 10]) await req("POST", "/api/v1/db/nums", { body: { n } });
    const sorted = (j: { items: { data: { n: number } }[] }) => j.items.map((d) => d.data.n).sort((a, b) => a - b);

    const inSome = await (await req("GET", `/api/v1/db/nums?filter=${encodeURIComponent('{"n":{"in":[2,10]}}')}`)).json();
    expect(sorted(inSome)).toEqual([2, 10]);

    const inEmpty = await req("GET", `/api/v1/db/nums?filter=${encodeURIComponent('{"n":{"in":[]}}')}`);
    expect(inEmpty.status).toBe(200);
    expect((await inEmpty.json()).items).toEqual([]);

    const gt = await (await req("GET", `/api/v1/db/nums?filter=${encodeURIComponent('{"n":{"gt":2}}')}`)).json();
    expect(sorted(gt)).toEqual([3, 10]);
  });

  test("documents are site-scoped by host", async () => {
    await req("POST", "/api/v1/db/secrets", { body: { v: 1 }, site: S1 });
    const other = await (await req("GET", "/api/v1/db/secrets", { site: S2 })).json();
    expect(other.items).toEqual([]);
  });

  test("cross-world reads are open via ?site=, writes stay host-scoped", async () => {
    const read = await (await req("GET", `/api/v1/db/secrets?site=${S1}`, { site: S2 })).json();
    expect(read.items.length).toBe(1);
    expect(read.items[0].data.v).toBe(1);
    // a write with ?site= still lands on the CALLER's site, not the target
    await req("POST", `/api/v1/db/secrets?site=${S1}`, { body: { sneaky: true }, site: S2 });
    const s1 = await (await req("GET", "/api/v1/db/secrets", { site: S1 })).json();
    expect(s1.items.length).toBe(1); // unchanged
  });

  test("the platform's home/sites collection is world-readable", async () => {
    const sites = await (await req("GET", "/api/v1/db/sites?site=home", { site: S1 })).json();
    expect(sites.items.map((d: { data: { name: string } }) => d.data.name)).toContain(S1);
  });

  test("oversized documents are payload_too_large", async () => {
    const res = await req("POST", "/api/v1/db/posts", { body: { blob: "x".repeat(300 * 1024) } });
    expect((await res.json()).error.code).toBe("payload_too_large");
  });
});

// worlds.rooms (the multi-instance lobby browser) is pure client SDK, but it
// rides this exact db contract: one collection holds directory docs (`_dir:1`)
// alongside each room's state doc (`_room:"inst:<id>"`), discovered by filter.
// These lock that shape down so the SDK's create/list/joinByCode/cleanup hold.
describe("worlds.rooms registry", () => {
  test("directory docs and instance state docs coexist and filter apart", async () => {
    const open = await (await req("POST", "/api/v1/db/chess", {
      body: { _dir: 1, id: "aaa", code: "K7QF", name: "Open table", private: false, status: "open", count: 1 },
    })).json();
    await req("POST", "/api/v1/db/chess", { body: { _dir: 1, id: "bbb", code: "M3PQ", name: "Private", private: true, status: "open", count: 1 } });
    await req("POST", "/api/v1/db/chess", { body: { _room: "inst:aaa", _rev: 0, board: [] } });

    // list() reads only the directory entries, never the instance state docs.
    const dir = await (await req("GET", `/api/v1/db/chess?filter=${encodeURIComponent('{"_dir":1}')}`)).json();
    expect(dir.items.map((d: { data: { code: string } }) => d.data.code).sort()).toEqual(["K7QF", "M3PQ"]);

    // joinByCode() is an AND filter on the directory entry.
    const byCode = await (await req("GET", `/api/v1/db/chess?filter=${encodeURIComponent('{"_dir":1,"code":"K7QF"}')}`)).json();
    expect(byCode.items.length).toBe(1);
    expect(byCode.items[0].data.name).toBe("Open table");

    // a room loads its own state doc by its instance key, ignoring directory docs.
    const state = await (await req("GET", `/api/v1/db/chess?filter=${encodeURIComponent('{"_room":"inst:aaa"}')}`)).json();
    expect(state.items.length).toBe(1);
    expect(state.items[0].data._room).toBe("inst:aaa");

    // leave()/sweep() removes the directory entry, dropping it from the list.
    await req("DELETE", `/api/v1/db/chess/${open.id}`);
    const after = await (await req("GET", `/api/v1/db/chess?filter=${encodeURIComponent('{"_dir":1}')}`)).json();
    expect(after.items.map((d: { data: { code: string } }) => d.data.code)).toEqual(["M3PQ"]);
  });
});

describe("uploads", () => {
  test("put, list, serve, delete", async () => {
    const form = new FormData();
    form.set("file", new Blob(["hello bytes"], { type: "text/plain" }), "note.txt");
    const put = await (await req("POST", "/api/v1/uploads", { form })).json();
    expect(put.url).toBe(`/u/${S1}/note.txt`);

    const served = await req("GET", `/u/${S1}/note.txt`);
    expect(await served.text()).toBe("hello bytes");

    const list = await (await req("GET", "/api/v1/uploads")).json();
    expect(list.items.map((f: { name: string }) => f.name)).toContain("note.txt");

    const del = await (await req("DELETE", "/api/v1/uploads/note.txt")).json();
    expect(del.deleted).toBe(true);
  });
});

describe("platform surfaces", () => {
  test("sites directory and deploy history", async () => {
    const sites = await (await req("GET", "/api/v1/sites", { site: "home" })).json();
    expect(sites.items.map((s: { name: string }) => s.name)).toContain(S1);
    const hist = await (await req("GET", `/api/v1/sites/${S1}/deploys`, { site: "home" })).json();
    expect(hist.items.length).toBeGreaterThanOrEqual(2);
    expect(hist.items[0].by.handle).toBe("dev");
  });

  test("universe entries carry seeded layout", async () => {
    const u = await (await req("GET", "/api/v1/universe", { site: "home" })).json();
    const t1 = u.items.find((s: { name: string }) => s.name === S1);
    expect(t1.universe.seed).toBeGreaterThan(0);
    expect(t1.universe.pos.length).toBe(3);
  });

  test("llms.txt lists the docs", async () => {
    const txt = await (await req("GET", "/llms.txt", { site: "home" })).text();
    expect(txt).toContain("/docs/quickstart.md");
  });

  test("loaders are served with the contract cache headers", async () => {
    const evergreen = await req("GET", "/worlds.js", { site: "home" });
    expect(evergreen.headers.get("cache-control")).toBe("no-store");
    const pinned = await req("GET", "/v1/worlds.js", { site: "home" });
    expect(pinned.headers.get("cache-control")).toContain("immutable");
  });

  test("visit beacon is always 204", async () => {
    const res = await req("POST", "/api/v1/beacon/visit", { body: { site: S1 } });
    expect(res.status).toBe(204);
  });
});

describe("realtime", () => {
  test("db subscription receives create events over the socket", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/api/v1/socket`, "worlds.v1");
    const got: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no event within 3s")), 3000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ op: "sub", id: "s1", kind: "db", collection: "live" }));
        // The socket carries no Host header here, so it lands on site "home" — write there too.
        setTimeout(() => req("POST", "/api/v1/db/live", { body: { ping: 1 }, site: "home" }), 150);
      };
      ws.onmessage = (m) => {
        const f = JSON.parse(String(m.data));
        got.push(f);
        if (f.op === "event") {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    ws.close();
    const ev = got.find((f) => f.op === "event") as { type: string; doc: { data: { ping: number } }; cursor: string };
    expect(ev.type).toBe("create");
    expect(ev.doc.data.ping).toBe(1);
    expect(ev.cursor).toBeTruthy();
  });

  test("channel pub/sub with presence and sender stamp", async () => {
    const a = new WebSocket(`ws://localhost:${PORT}/api/v1/socket`, "worlds.v1");
    const b = new WebSocket(`ws://localhost:${PORT}/api/v1/socket`, "worlds.v1");
    const open = (w: WebSocket) => new Promise<void>((r) => (w.onopen = () => r()));
    await Promise.all([open(a), open(b)]);
    const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no msg within 3s")), 3000);
      b.onmessage = (m) => {
        const f = JSON.parse(String(m.data));
        if (f.op === "msg") {
          clearTimeout(timer);
          resolve(f);
        }
      };
      b.send(JSON.stringify({ op: "sub", id: "c1", kind: "channel", channel: "room" }));
      setTimeout(() => {
        a.send(JSON.stringify({ op: "sub", id: "c2", kind: "channel", channel: "room" }));
        setTimeout(() => a.send(JSON.stringify({ op: "pub", id: "p1", channel: "room", payload: { hi: true } })), 100);
      }, 100);
    });
    a.close();
    b.close();
    expect((msg.payload as { hi: boolean }).hi).toBe(true);
    expect((msg.from as { handle: string }).handle).toBe("dev");
  });

  test("a socket cannot exceed the subscription cap", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/api/v1/socket`, "worlds.v1");
    const err = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no cap error within 3s")), 3000);
      ws.onmessage = (m) => {
        const f = JSON.parse(String(m.data));
        if (f.op === "error" && /too many subscriptions/.test(String((f.error as { message?: string })?.message))) {
          clearTimeout(timer);
          resolve(f);
        }
      };
      // 0..99 fill the cap (100); the 101st must be rejected.
      ws.onopen = () => {
        for (let i = 0; i <= 100; i++) ws.send(JSON.stringify({ op: "sub", id: `cap${i}`, kind: "channel", channel: `c${i}` }));
      };
    });
    ws.close();
    expect((err.error as { code: string }).code).toBe("invalid_request");
  });
});

describe("realtime actors", () => {
  const mk = () => new WebSocket(`ws://localhost:${PORT}/api/v1/socket`, "worlds.v1");
  const opened = (w: WebSocket) => new Promise<void>((r) => (w.onopen = () => r()));
  const sub = (w: WebSocket, id: string, cid: string, zone: string, ch = "arena") =>
    w.send(JSON.stringify({ op: "sub", id, kind: "actors", channel: ch, zone, cid }));
  const set = (w: WebSocket, cid: string, state: unknown, zone: string, ch = "arena") =>
    w.send(JSON.stringify({ op: "set", id: "set", channel: ch, cid, state, zone }));
  const waitFor = (w: WebSocket, pred: (f: any) => boolean, ms = 3000) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("actors frame not seen in time")), ms);
      w.onmessage = (m) => {
        const f = JSON.parse(String(m.data));
        if (pred(f)) { clearTimeout(timer); resolve(f); }
      };
    });

  test("a joiner gets an in-zone last-value snapshot of existing members", async () => {
    const a = mk(), b = mk();
    await Promise.all([opened(a), opened(b)]);
    sub(a, "a1", "A", "z1");
    await Bun.sleep(80);
    set(a, "A", { hp: 7 }, "z1");
    await Bun.sleep(80);
    const snapP = waitFor(b, (f) => f.op === "actors_snapshot");
    sub(b, "b1", "B", "z1");
    const snap = await snapP;
    a.close(); b.close();
    expect(snap.actors.length).toBe(1);
    expect(snap.actors[0].id).toBe("A");
    expect(snap.actors[0].state.hp).toBe(7);
    expect(snap.actors[0].handle).toBe("dev"); // profile-resolved identity, like channels
  });

  test("a set is coalesced and flushed to same-zone peers", async () => {
    const a = mk(), b = mk();
    await Promise.all([opened(a), opened(b)]);
    sub(b, "b1", "B", "z1");
    sub(a, "a1", "A", "z1");
    await Bun.sleep(80);
    const updP = waitFor(b, (f) => f.op === "actors" && f.updates.some((u: any) => u.id === "A"));
    set(a, "A", { n: 1 }, "z1");
    set(a, "A", { n: 5 }, "z1"); // coalesces — only the latest is delivered
    const upd = await updP;
    a.close(); b.close();
    const mine = upd.updates.find((u: any) => u.id === "A");
    expect(mine.state.n).toBe(5);
  });

  test("interest management: updates never cross zones", async () => {
    const a = mk(), c = mk();
    await Promise.all([opened(a), opened(c)]);
    sub(a, "a1", "A", "z1");
    sub(c, "c1", "C", "z2"); // different zone
    await Bun.sleep(80);
    let leaked = false;
    c.onmessage = (m) => {
      const f = JSON.parse(String(m.data));
      if (f.op === "actors" && f.updates.some((u: any) => u.id === "A")) leaked = true;
    };
    set(a, "A", { n: 9 }, "z1");
    await Bun.sleep(400); // several 15Hz flush ticks
    a.close(); c.close();
    expect(leaked).toBe(false);
  });

  test("a disconnect notifies same-zone peers via actors_leave", async () => {
    const a = mk(), b = mk();
    await Promise.all([opened(a), opened(b)]);
    sub(a, "a1", "A", "z1");
    set(a, "A", { x: 1 }, "z1");
    sub(b, "b1", "B", "z1");
    await Bun.sleep(120);
    const leftP = waitFor(b, (f) => f.op === "actors_leave" && (f.ids || []).includes("A"));
    a.close();
    const left = await leftP;
    b.close();
    expect(left.ids).toContain("A");
  });

  test("metadata: setMetadata merges and flushes to in-zone peers", async () => {
    const a = mk(), b = mk();
    await Promise.all([opened(a), opened(b)]);
    sub(b, "b1", "B", "z1");
    sub(a, "a1", "A", "z1");
    await Bun.sleep(80);
    const updP = waitFor(b, (f) => f.op === "actors" && f.updates.some((u: any) => u.id === "A" && u.meta));
    a.send(JSON.stringify({ op: "ameta", id: "ameta", channel: "arena", cid: "A", meta: { team: "red", level: 3 } }));
    const upd = await updP;
    a.close(); b.close();
    const mine = upd.updates.find((u: any) => u.id === "A");
    expect(mine.meta.team).toBe("red");
    expect(mine.meta.level).toBe(3);
  });

  test("metadata: a joiner's snapshot includes existing metadata (even with no state)", async () => {
    const a = mk(), b = mk();
    await Promise.all([opened(a), opened(b)]);
    a.send(JSON.stringify({ op: "sub", id: "a1", kind: "actors", channel: "arena", zone: "z9", cid: "A", meta: { color: "#f00" } }));
    await Bun.sleep(80);
    const snapP = waitFor(b, (f) => f.op === "actors_snapshot");
    sub(b, "b1", "B", "z9");
    const snap = await snapP;
    a.close(); b.close();
    const ra = snap.actors.find((x: any) => x.id === "A");
    expect(ra).toBeTruthy();
    expect(ra.meta.color).toBe("#f00");
  });

  test("events: send() reaches same-zone peers but never crosses zones", async () => {
    const a = mk(), b = mk(), c = mk();
    await Promise.all([opened(a), opened(b), opened(c)]);
    sub(a, "a1", "A", "z1");
    sub(b, "b1", "B", "z1");
    sub(c, "c1", "C", "z2"); // different zone
    await Bun.sleep(80);
    let cGot = false;
    c.onmessage = (m) => { if (JSON.parse(String(m.data)).op === "actor_event") cGot = true; };
    const evP = waitFor(b, (f) => f.op === "actor_event" && f.from.id === "A");
    a.send(JSON.stringify({ op: "aevent", id: "aevent", channel: "arena", cid: "A", payload: { t: "horn", n: 7 } }));
    const ev = await evP;
    await Bun.sleep(250); // give any cross-zone leak time to (not) arrive
    a.close(); b.close(); c.close();
    expect(ev.payload.t).toBe("horn");
    expect(ev.payload.n).toBe(7);
    expect(ev.from.handle).toBe("dev");
    expect(cGot).toBe(false);
  });

  test("observer: sees the zone but stays invisible to peers (and can't write)", async () => {
    const a = mk(), o = mk();
    await Promise.all([opened(a), opened(o)]);
    sub(a, "a1", "A", "z1");
    set(a, "A", { x: 1 }, "z1");
    await Bun.sleep(80);
    let aSawO = false;
    a.onmessage = (m) => {
      const f = JSON.parse(String(m.data));
      if ((f.op === "actors" || f.op === "actors_snapshot") && JSON.stringify(f).includes('"O"')) aSawO = true;
    };
    const snapP = waitFor(o, (f) => f.op === "actors_snapshot");
    o.send(JSON.stringify({ op: "sub", id: "o1", kind: "actors", channel: "arena", zone: "z1", cid: "O", observer: true }));
    const snap = await snapP;
    o.send(JSON.stringify({ op: "set", id: "set", channel: "arena", cid: "O", state: { x: 9 }, zone: "z1" })); // ignored
    await Bun.sleep(250);
    a.close(); o.close();
    expect(snap.actors.some((x: any) => x.id === "A")).toBe(true); // observer sees the zone
    expect(aSawO).toBe(false); // peers never see the observer, even after it tries to set
  });
});

describe("mcp", () => {
  const rpc = (method: string, params: unknown, id: number | null = 1) =>
    req("POST", "/mcp", { body: { jsonrpc: "2.0", id, method, params } });

  test("initialize + tools/list expose the tool set", async () => {
    const init = await (await rpc("initialize", { protocolVersion: "2025-06-18" })).json();
    expect(init.result.serverInfo.name).toBe("worlds");
    expect(init.result.capabilities.tools).toBeDefined();

    const list = await (await rpc("tools/list", {})).json();
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["deploy_site", "list_sites", "get_site", "my_sites", "db_query", "read_docs", "search_docs"]),
    );
  });

  test("tools/call read_docs lists the doc pages", async () => {
    const r = await (await rpc("tools/call", { name: "read_docs", arguments: {} })).json();
    expect(r.result.content[0].text).toContain("sdk");
  });

  test("tools/call deploy_site makes the site live", async () => {
    const site = `${S1}-mcp`;
    const r = await (await rpc("tools/call", { name: "deploy_site", arguments: { name: site, files: { "index.html": `<h1>${site}</h1>` } } })).json();
    expect(r.result.isError).toBeFalsy();
    expect(r.result.content[0].text).toContain(site);
    const page = await req("GET", "/", { site });
    expect(await page.text()).toContain(site);
  });

  test("tools/call surfaces errors as isError, reserved names included", async () => {
    const r = await (await rpc("tools/call", { name: "deploy_site", arguments: { name: "api", files: { "index.html": "x" } } })).json();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("reserved");
  });

  test("notifications get a 202 with no body", async () => {
    const res = await req("POST", "/mcp", { body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(res.status).toBe(202);
  });
});

describe("profiles", () => {
  const ACE = "ace@example.com";
  const NEW_HANDLE = `pilot-${RUN}`;
  const as = (email: string) => ({ "x-auth-request-email": email });

  test("setting a custom handle + name is reflected in me()", async () => {
    const put = await req("PUT", "/api/v1/me", { body: { handle: NEW_HANDLE, name: "Ace Pilot" }, headers: as(ACE) });
    expect(put.status).toBe(200);
    const me = await (await req("GET", "/api/v1/me", { headers: as(ACE) })).json();
    expect(me.handle).toBe(NEW_HANDLE);
    expect(me.name).toBe("Ace Pilot");
    expect(me.avatar_url).toBeTruthy();
  });

  test("the canonical /@handle redirects to the custom one", async () => {
    const canon = await (await req("GET", "/api/v1/creators/ace")).json();
    expect(canon.redirect_to).toBe(NEW_HANDLE);
    const custom = await (await req("GET", `/api/v1/creators/${NEW_HANDLE}`)).json();
    expect(custom.handle).toBe(NEW_HANDLE);
    expect(custom.redirect_to).toBeNull();
  });

  test("a taken handle is a conflict", async () => {
    const res = await req("PUT", "/api/v1/me", { body: { handle: NEW_HANDLE }, headers: as("rival@example.com") });
    expect((await res.json()).error.code).toBe("conflict");
  });

  test("reserved + malformed handles are rejected", async () => {
    expect((await (await req("PUT", "/api/v1/me", { body: { handle: "api" }, headers: as(ACE) })).json()).error.code).toBe("invalid_request");
    expect((await (await req("PUT", "/api/v1/me", { body: { handle: "Nope!" }, headers: as(ACE) })).json()).error.code).toBe("invalid_request");
  });

  test("/@<handle> serves the profile page shell", async () => {
    const res = await req("GET", `/@${NEW_HANDLE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain("/api/v1/creators/"); // the client fetches the creator API
  });
});

describe("auth (google mode)", () => {
  const GPORT = 9100 + Math.floor(Math.random() * 400);
  const GBASE = `http://localhost:${GPORT}`;
  const SECRET = "test-session-secret";
  let gproc: ReturnType<typeof Bun.spawn>;
  let gdir: string;

  function session(email: string): string {
    const payload = Buffer.from(JSON.stringify({ email, name: "Tester", picture: "", exp: Date.now() + 3_600_000 })).toString("base64url");
    const sig = new Bun.CryptoHasher("sha256", SECRET).update(payload).digest("hex");
    return `world_session=${payload}.${sig}`;
  }

  beforeAll(async () => {
    gdir = await mkdtemp(join(tmpdir(), "world-gauth-"));
    gproc = Bun.spawn(["bun", "server/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, WORLDS_PORT: String(GPORT), WORLDS_DATA_DIR: gdir, WORLDS_DEV: "0", WORLDS_AUTH: "google", WORLDS_SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "test-secret", WORLDS_PUBLIC_ORIGIN: GBASE, WORLDS_DISABLE_WORKERS: "1", WORLDS_SEED: "0" },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${GBASE}/healthz`)).ok) break; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
  });
  afterAll(async () => { gproc?.kill(); await rm(gdir, { recursive: true, force: true }); });

  test("healthz is exempt from the wall", async () => {
    expect((await fetch(`${GBASE}/healthz`)).status).toBe(200);
  });
  test("unauthenticated HTML navigation redirects to sign-in", async () => {
    const res = await fetch(`${GBASE}/`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/login");
  });
  test("unauthenticated API call is 401", async () => {
    expect((await fetch(`${GBASE}/api/v1/me`)).status).toBe(401);
  });
  test("/auth/login redirects to Google", async () => {
    const res = await fetch(`${GBASE}/auth/login`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accounts.google.com");
  });
  test("a validly signed session authenticates", async () => {
    const res = await fetch(`${GBASE}/api/v1/me`, { headers: { cookie: session("tester@example.com") } });
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.email).toBe("tester@example.com");
    expect(me.handle).toBe("tester");
  });
  test("a tampered session is rejected", async () => {
    const res = await fetch(`${GBASE}/api/v1/me`, { headers: { cookie: `${session("tester@example.com")}TAMPER` } });
    expect(res.status).toBe(401);
  });
});

describe("auth (google GIS mode — client id, no secret)", () => {
  const GPORT = 9500 + Math.floor(Math.random() * 80);
  const GBASE = `http://localhost:${GPORT}`;
  let gproc: ReturnType<typeof Bun.spawn>;
  let gdir: string;

  beforeAll(async () => {
    gdir = await mkdtemp(join(tmpdir(), "world-gis-"));
    gproc = Bun.spawn(["bun", "server/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, WORLDS_PORT: String(GPORT), WORLDS_DATA_DIR: gdir, WORLDS_DEV: "0", WORLDS_AUTH: "google", WORLDS_SESSION_SECRET: "gis-secret", GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", WORLDS_PUBLIC_ORIGIN: GBASE, WORLDS_DISABLE_WORKERS: "1", WORLDS_SEED: "0" },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${GBASE}/healthz`)).ok) break; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
  });
  afterAll(async () => { gproc?.kill(); await rm(gdir, { recursive: true, force: true }); });

  test("/auth/login serves the GIS sign-in page (no Google redirect)", async () => {
    const res = await fetch(`${GBASE}/auth/login`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("accounts.google.com/gsi/client");
    expect(html).toContain('data-client_id="test-client.apps.googleusercontent.com"');
  });
  test("/auth/google with no credential is 400", async () => {
    const res = await fetch(`${GBASE}/auth/google`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });
  test("/auth/google with a garbage credential is rejected (401)", async () => {
    const res = await fetch(`${GBASE}/auth/google`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: "not.a.jwt" }) });
    expect(res.status).toBe(401);
  });
});

describe("path routing (WORLDS_ROUTING=path)", () => {
  const PPORT = 9600 + Math.floor(Math.random() * 300);
  const PB = `http://localhost:${PPORT}`;
  const SITE = `${S1}-p`;
  let pproc: ReturnType<typeof Bun.spawn>;
  let pdir: string;

  beforeAll(async () => {
    pdir = await mkdtemp(join(tmpdir(), "worlds-path-"));
    pproc = Bun.spawn(["bun", "server/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, WORLDS_PORT: String(PPORT), WORLDS_DATA_DIR: pdir, WORLDS_DEV: "1", WORLDS_ROUTING: "path", WORLDS_DISABLE_WORKERS: "1", WORLDS_SEED: "0" },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${PB}/healthz`)).ok) break; } catch { /* booting */ }
      await Bun.sleep(100);
    }
    const form = new FormData();
    form.set("site", SITE);
    form.set("bundle", await bundle({ "index.html": `<h1>path ${SITE}</h1>` }), "bundle.tgz");
    await fetch(`${PB}/api/v1/deploy`, { method: "POST", headers: { "x-worlds-csrf": "1" }, body: form });
  });
  afterAll(async () => { pproc?.kill(); await rm(pdir, { recursive: true, force: true }); });

  test("site is served at /app/<name>/", async () => {
    const res = await fetch(`${PB}/app/${SITE}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`path ${SITE}`);
  });
  test("/app/<name> redirects to the trailing slash", async () => {
    const res = await fetch(`${PB}/app/${SITE}`, { redirect: "manual" });
    expect(res.status).toBe(308);
  });
  test("siteUrl is path-based", async () => {
    const s = await (await fetch(`${PB}/api/v1/sites/${SITE}`)).json();
    expect(s.url).toContain(`/app/${SITE}`);
  });
  test("db is scoped by the x-worlds-site header (not Host)", async () => {
    await fetch(`${PB}/api/v1/db/notes`, { method: "POST", headers: { "x-worlds-csrf": "1", "x-worlds-site": SITE, "content-type": "application/json" }, body: JSON.stringify({ v: 1 }) });
    const mine = await (await fetch(`${PB}/api/v1/db/notes`, { headers: { "x-worlds-site": SITE } })).json();
    expect(mine.items.length).toBe(1);
    const home = await (await fetch(`${PB}/api/v1/db/notes`)).json(); // no header → home
    expect(home.items.length).toBe(0);
  });
});
