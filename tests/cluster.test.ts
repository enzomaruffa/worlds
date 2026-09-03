import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { SQL } from "bun";

// Two pods sharing one Postgres, linked through cluster.ts. Covers the fan-out paths
// (db events, channel messages, presence) and document ownership: a client on the pod
// that does not hold the lease sees the same document, and when the owner dies the
// survivors re-home it once the lease expires.

const RUN = Date.now().toString(36);
const SECRET = "cluster-test-secret";
const SITE = `t-cluster-${RUN}`;

interface Pod {
  id: string;
  port: number;
  base: string;
  proc: ReturnType<typeof Bun.spawn> | null;
  dataDir: string;
}

const pods: Pod[] = [];

async function spawnPod(id: string, port: number): Promise<Pod> {
  const dataDir = await mkdtemp(join(tmpdir(), `world-${id}-`));
  const proc = Bun.spawn(["bun", "server/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      WORLDS_PORT: String(port),
      WORLDS_DATA_DIR: dataDir,
      WORLDS_DEV: "1",
      WORLDS_DISABLE_WORKERS: "1",
      WORLDS_SEED: "0",
      WORLDS_POD_ID: id,
      WORLDS_PEER_URL: `http://localhost:${port}`,
      WORLDS_CLUSTER_SECRET: SECRET,
      WORLDS_LEASE_TTL_MS: "1500",
      WORLDS_HEARTBEAT_MS: "300",
      WORLDS_DOC_IDLE_MS: "300",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const pod: Pod = { id, port, base: `http://localhost:${port}`, proc, dataDir };
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${pod.base}/healthz`)).ok) return pod;
    } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error(`${id} did not boot`);
}

const headers = { host: `${SITE}.worlds.localhost`, "x-worlds-csrf": "1", "content-type": "application/json" };

function req(pod: Pod, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  return fetch(`${pod.base}${path}`, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
}

// A socket client with frame matching; `as` picks the identity (dev header).
async function socket(pod: Pod, as = "dev@localhost") {
  const ws = new WebSocket(`ws://localhost:${pod.port}/api/v1/socket`, {
    protocols: ["worlds.v1"],
    headers: { host: `${SITE}.worlds.localhost`, "x-auth-request-email": as },
  } as never);
  const frames: any[] = [];
  const waiters: ((f: any) => void)[] = [];
  ws.onmessage = (m) => {
    const f = JSON.parse(String(m.data));
    frames.push(f);
    for (const w of waiters.splice(0)) w(f);
  };
  await new Promise((r) => (ws.onopen = r));
  function next(pred: (f: any) => boolean, ms = 6000): Promise<any> {
    const hit = frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no frame matched in ${ms}ms; saw ${JSON.stringify(frames.map((f) => f.op))}`)), ms);
      const w = (f: any) => {
        if (pred(f)) {
          clearTimeout(t);
          resolve(f);
        } else waiters.push(w);
      };
      waiters.push(w);
    });
  }
  return { ws, frames, next, send: (f: unknown) => ws.send(JSON.stringify(f)), close: () => ws.close() };
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

// A doc client wired like sdk/src/doc.ts: local edits go up, server frames come down.
async function docClient(pod: Pod, docName: string, as: string) {
  const ws = new WebSocket(`ws://localhost:${pod.port}/api/v1/socket`, {
    protocols: ["worlds.v1"],
    headers: { host: `${SITE}.worlds.localhost`, "x-auth-request-email": as },
  } as never);
  const frames: any[] = [];
  const waiters: ((f: any) => void)[] = [];
  let ydoc = new Y.Doc();
  let epoch = 0;
  const send = (f: unknown) => ws.send(JSON.stringify(f));
  const install = (state: string) => {
    ydoc.destroy();
    ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, unb64(state), "server");
    ydoc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== "server") send({ op: "doc_update", id: "d1", epoch, update: b64(u) });
    });
  };
  ws.onmessage = (m) => {
    const f = JSON.parse(String(m.data));
    frames.push(f);
    if (f.op === "doc_state" || f.op === "doc_reset" || f.op === "doc_rejected") {
      epoch = f.epoch;
      install(f.state);
    } else if (f.op === "doc_update") {
      Y.applyUpdate(ydoc, unb64(f.update), "server");
    }
    for (const w of waiters.splice(0)) w(f);
  };
  await new Promise((r) => (ws.onopen = r));
  const next = (pred: (f: any) => boolean, ms = 8000): Promise<any> => {
    const hit = frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no frame matched in ${ms}ms; saw ${JSON.stringify(frames.map((f) => f.op))}`)), ms);
      const w = (f: any) => {
        if (pred(f)) {
          clearTimeout(t);
          resolve(f);
        } else waiters.push(w);
      };
      waiters.push(w);
    });
  };
  send({ op: "sub", id: "d1", kind: "doc", doc: docName });
  await next((f) => f.op === "doc_state");
  return {
    next,
    close: () => ws.close(),
    text: () => ydoc.get("root", Y.XmlText).toString(),
    type: (t: string) => ydoc.get("root", Y.XmlText).insert(ydoc.get("root", Y.XmlText).length, t),
    seen: (op: string) => frames.filter((f) => f.op === op).length,
  };
}

let A: Pod;
let B: Pod;

beforeAll(async () => {
  const base = 9000 + Math.floor(Math.random() * 500);
  [A, B] = await Promise.all([spawnPod(`pod-a-${RUN}`, base), spawnPod(`pod-b-${RUN}`, base + 1)]);
  pods.push(A, B);
  // Give the heartbeat a couple of rounds to register both pods and dial the link.
  await Bun.sleep(1200);
});

afterAll(async () => {
  for (const p of pods) {
    p.proc?.kill();
    await rm(p.dataDir, { recursive: true, force: true });
  }
});

describe("two pods", () => {
  test("a db write on one pod reaches a subscriber on the other", async () => {
    const sub = await socket(B);
    sub.send({ op: "sub", id: "s1", kind: "db", collection: "notes" });
    await sub.next((f) => f.op === "ack");
    const res = await req(A, "POST", "/api/v1/db/notes", { text: "from a" });
    expect(res.status).toBe(200);
    const ev = await sub.next((f) => f.op === "event");
    expect(ev.doc.data.text).toBe("from a");
    sub.close();
  }, 20000);

  test("channel messages and presence cross pods", async () => {
    const a = await socket(A, "alice@localhost");
    const b = await socket(B, "bob@localhost");
    a.send({ op: "sub", id: "c", kind: "channel", channel: "room", presence: true });
    b.send({ op: "sub", id: "c", kind: "channel", channel: "room", presence: true });
    await a.next((f) => f.op === "ack");
    await b.next((f) => f.op === "ack");
    const roster = await a.next((f) => f.op === "presence" && f.members.some((m: any) => m.handle === "bob"));
    expect(roster.members.map((m: any) => m.handle).sort()).toEqual(["alice", "bob"]);
    a.send({ op: "pub", id: "p1", channel: "room", payload: { hi: 1 } });
    const msg = await b.next((f) => f.op === "msg");
    expect(msg.payload).toEqual({ hi: 1 });
    expect(msg.from.handle).toBe("alice");
    a.close();
    const gone = await b.next((f) => f.op === "presence" && !f.members.some((m: any) => m.handle === "alice"));
    expect(gone.members.map((m: any) => m.handle)).toEqual(["bob"]);
    b.close();
  }, 20000);

  test("a document is shared across pods and both sides commit", async () => {
    const a = await docClient(A, "plan-shared", "alice@localhost");
    const b = await docClient(B, "plan-shared", "bob@localhost");
    a.type("alpha ");
    await a.next((f) => f.op === "doc_ack" && f.seq === 1);
    await b.next((f) => f.op === "doc_update" && f.seq === 1);
    b.type("bravo");
    await b.next((f) => f.op === "doc_ack" && f.seq === 2);
    await a.next((f) => f.op === "doc_update" && f.seq === 2);
    expect(a.text()).toBe("alpha bravo");
    expect(b.text()).toBe("alpha bravo");
    // both pods answer HTTP reads with the same state, whoever owns the room
    for (const pod of [A, B]) {
      const got = await (await req(pod, "GET", "/api/v1/docs/plan-shared")).json();
      expect(got.seq).toBe(2);
      const d = new Y.Doc();
      Y.applyUpdate(d, unb64(got.state));
      expect(d.get("root", Y.XmlText).toString()).toBe("alpha bravo");
    }
    a.close();
    b.close();
  }, 20000);

  test("actors rooms span pods: state, events and leave cross over", async () => {
    const a = await socket(A, "alice@localhost");
    const b = await socket(B, "bob@localhost");
    a.send({ op: "sub", id: "x", kind: "actors", channel: "arena", cid: "a1", zone: "z", rate: 20 });
    b.send({ op: "sub", id: "x", kind: "actors", channel: "arena", cid: "b1", zone: "z", rate: 20 });
    await a.next((f) => f.op === "ack");
    await b.next((f) => f.op === "ack");
    a.send({ op: "set", id: "x", channel: "arena", cid: "a1", state: { x: 1 } });
    const upd = await b.next((f) => f.op === "actors" && f.updates.some((u: any) => u.id === "a1"));
    expect(upd.updates.find((u: any) => u.id === "a1").state).toEqual({ x: 1 });
    expect(upd.updates.find((u: any) => u.id === "a1").handle).toBe("alice");
    b.send({ op: "aevent", id: "x", channel: "arena", cid: "b1", payload: { honk: true } });
    const ev = await a.next((f) => f.op === "actor_event");
    expect(ev.from.id).toBe("b1");
    expect(ev.payload).toEqual({ honk: true });
    // a late joiner on either pod gets the zone snapshot with alice's state
    const c = await socket(B, "carol@localhost");
    c.send({ op: "sub", id: "x", kind: "actors", channel: "arena", cid: "c1", zone: "z" });
    const snap = await c.next((f) => f.op === "actors_snapshot");
    expect(snap.actors.map((x: any) => x.id).sort()).toEqual(["a1"]);
    a.close();
    const left = await b.next((f) => f.op === "actors_leave");
    expect(left.ids).toEqual(["a1"]);
    b.close();
    c.close();
  }, 20000);

  test("when the owner pod dies, the survivor re-homes the document and keeps every acked edit", async () => {
    const name = "plan-failover";
    const a = await docClient(A, name, "alice@localhost");
    const b = await docClient(B, name, "bob@localhost");
    a.type("kept ");
    await b.next((f) => f.op === "doc_update" && f.seq === 1);
    // Whichever pod owns the room, kill it and keep the other.
    const admin = new SQL(process.env.DATABASE_URL ?? "postgres://world:world@localhost:5499/world");
    const [ownerRow] = await admin`SELECT owner FROM room_leases WHERE key = ${`${SITE}/${name}`}`;
    await admin.close();
    const owner = String(ownerRow.owner);
    const dead = owner === A.id ? A : B;
    const alive = dead === A ? B : A;
    const survivor = dead === A ? b : a;
    dead.proc!.kill("SIGKILL");
    dead.proc = null;
    // The survivor's pod loses its link, waits out the lease, takes the room, and hands a
    // fresh state to the subscriber.
    const state = await survivor.next((f) => f.op === "doc_state" && survivor.seen("doc_state") >= 2, 15000);
    expect(state.seq).toBe(1);
    expect(survivor.text()).toBe("kept ");
    survivor.type("after");
    await survivor.next((f) => f.op === "doc_ack" && f.seq === 2, 8000);
    const got = await (await req(alive, "GET", `/api/v1/docs/${name}`)).json();
    const d = new Y.Doc();
    Y.applyUpdate(d, unb64(got.state));
    expect(d.get("root", Y.XmlText).toString()).toBe("kept after");
    survivor.close();
  }, 30000);
});
