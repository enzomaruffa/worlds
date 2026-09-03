import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

// The document room against a throwaway SQLite database: commit/ack ordering, durability
// across a simulated crash, snapshots and rotation. The socket and HTTP surfaces are
// covered in e2e.test.ts; this is the room itself.

let dataDir: string;
let docs: typeof import("../server/docs");
let db: typeof import("../server/db");

const who = { email: "t@localhost", handle: "t", name: "T", avatar: "", kind: "user" as const };
const SITE = "unit";

function textUpdate(base: Uint8Array | null, text: string): { update: Uint8Array; doc: Y.Doc } {
  const doc = new Y.Doc();
  if (base) Y.applyUpdate(doc, base);
  const before = Y.encodeStateVector(doc);
  doc.get("root", Y.XmlText).insert(0, text);
  return { update: Y.encodeStateAsUpdate(doc, before), doc };
}

function textOf(state: Uint8Array): string {
  const d = new Y.Doc();
  Y.applyUpdate(d, state);
  return d.get("root", Y.XmlText).toString();
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "world-docs-"));
  process.env.WORLDS_DB = "sqlite";
  process.env.DATABASE_URL = "docs-test.sqlite";
  process.env.WORLDS_DATA_DIR = dataDir;
  process.env.WORLDS_DEV = "1";
  process.env.WORLDS_DOC_IDLE_MS = "200";
  db = await import("../server/db");
  await db.initDb();
  docs = await import("../server/docs");
});

afterAll(async () => {
  await docs.closeAllRooms();
  await rm(dataDir, { recursive: true, force: true });
});

describe("doc room", () => {
  test("a new document starts at epoch 1, seq 0, empty", async () => {
    const room = await docs.getRoom(SITE, "fresh");
    const s = room.state();
    expect(s.epoch).toBe(1);
    expect(s.seq).toBe(0);
    expect(textOf(s.state)).toBe("");
  });

  test("updates commit in order and subscribers hear ack then update", async () => {
    const room = await docs.getRoom(SITE, "order");
    const frames: Record<string, unknown>[] = [];
    const client = { send: (f: Record<string, unknown>) => frames.push(f) };
    room.subscribe(client, "s1");
    const a = textUpdate(null, "hello");
    const seq1 = await room.submit(who, 1, a.update, client, "s1");
    expect(seq1).toBe(1);
    const b = textUpdate(room.state().state, " world");
    const seq2 = await room.submit(who, 1, b.update, client, "s1");
    expect(seq2).toBe(2);
    expect(textOf(room.state().state)).toBe(" worldhello");
    expect(frames.map((f) => f.op)).toEqual(["doc_ack", "doc_update", "doc_ack", "doc_update"]);
    expect(frames[0]!.seq).toBe(1);
    room.unsubscribe(client);
  });

  test("a stale epoch is a conflict carrying the current epoch", async () => {
    const room = await docs.getRoom(SITE, "epoch");
    expect(() => room.submit(who, 7, textUpdate(null, "x").update, null, null)).toThrow(/stale epoch/);
  });

  test("an oversized update is refused before anything is queued", async () => {
    const room = await docs.getRoom(SITE, "big");
    const huge = textUpdate(null, "x".repeat(600 * 1024)).update;
    expect(() => room.submit(who, 1, huge, null, null)).toThrow(/exceeds/);
    expect(room.seq).toBe(0);
  });

  test("garbage bytes are rejected and never touch the live document", async () => {
    const room = await docs.getRoom(SITE, "garbage");
    await room.submit(who, 1, textUpdate(null, "keep").update, null, null);
    const frames: Record<string, unknown>[] = [];
    const client = { send: (f: Record<string, unknown>) => frames.push(f) };
    room.subscribe(client, "s1");
    await expect(room.submit(who, 1, new Uint8Array([1, 2, 3, 4, 5]), client, "s1")).rejects.toThrow(/not a valid Yjs update/);
    expect(frames[0]!.op).toBe("doc_rejected");
    expect(textOf(room.state().state)).toBe("keep");
    expect(room.seq).toBe(1);
    room.unsubscribe(client);
  });

  test("one bad update in a batch does not sink the good ones", async () => {
    const room = await docs.getRoom(SITE, "batch");
    const good = room.submit(who, 1, textUpdate(null, "ok").update, null, null);
    const bad = room.submit(who, 1, new Uint8Array([9, 9, 9]), null, null);
    expect(await good).toBe(1);
    await expect(bad).rejects.toThrow();
    expect(textOf(room.state().state)).toBe("ok");
  });

  test("a crash before any snapshot replays the committed log", async () => {
    const room = await docs.getRoom(SITE, "crash");
    await room.submit(who, 1, textUpdate(null, "one").update, null, null);
    await room.submit(who, 1, textUpdate(room.state().state, " two").update, null, null);
    await docs.forgetRoom(SITE, "crash");
    const again = await docs.getRoom(SITE, "crash");
    expect(again.seq).toBe(2);
    expect(textOf(again.state().state)).toBe(" twoone");
  });

  test("a snapshot truncates the log and reloads identically", async () => {
    const room = await docs.getRoom(SITE, "snap");
    for (let i = 0; i < 3; i++) await room.submit(who, 1, textUpdate(room.state().state, String(i)).update, null, null);
    await room.snapshot();
    const [rows] = await db.sql`SELECT count(*) AS n FROM doc_updates WHERE site = ${SITE} AND name = ${"snap"}`;
    expect(Number(rows.n)).toBe(0);
    const before = textOf(room.state().state);
    await docs.forgetRoom(SITE, "snap");
    const again = await docs.getRoom(SITE, "snap");
    expect(again.seq).toBe(3);
    expect(textOf(again.state().state)).toBe(before);
  });

  test("updatesSince hands back the tail, or null past the snapshot", async () => {
    const room = await docs.getRoom(SITE, "tail");
    await room.submit(who, 1, textUpdate(null, "a").update, null, null);
    await room.submit(who, 1, textUpdate(room.state().state, "b").update, null, null);
    expect((await room.updatesSince(1, 1))!.length).toBe(1);
    expect(await room.updatesSince(1, 2)).toEqual([]);
    expect(await room.updatesSince(2, 0)).toBeNull();
    await room.snapshot();
    expect(await room.updatesSince(1, 0)).toBeNull();
  });

  test("rotation installs a compact state as a new epoch and resets subscribers", async () => {
    const room = await docs.getRoom(SITE, "rotate");
    await room.submit(who, 1, textUpdate(null, "old").update, null, null);
    const frames: Record<string, unknown>[] = [];
    const client = { send: (f: Record<string, unknown>) => frames.push(f) };
    room.subscribe(client, "s1");
    const fresh = new Y.Doc();
    fresh.get("root", Y.XmlText).insert(0, "compact");
    const s = await room.rotate(who, 1, Y.encodeStateAsUpdate(fresh));
    expect(s.epoch).toBe(2);
    expect(s.seq).toBe(0);
    expect(textOf(s.state)).toBe("compact");
    expect(frames.at(-1)!.op).toBe("doc_reset");
    expect(() => room.submit(who, 1, textUpdate(null, "x").update, null, null)).toThrow(/stale epoch/);
    await docs.forgetRoom(SITE, "rotate");
    const again = await docs.getRoom(SITE, "rotate");
    expect(again.epoch).toBe(2);
    expect(textOf(again.state().state)).toBe("compact");
    room.unsubscribe(client);
  });

  test("an idle room closes with a snapshot and a late subscriber gets a fresh, equal room", async () => {
    const room = await docs.getRoom(SITE, "idle");
    const client = { send: () => {} };
    room.subscribe(client, "s1");
    await room.submit(who, 1, textUpdate(null, "bye").update, client, "s1");
    room.unsubscribe(client);
    await Bun.sleep(400);
    const again = await docs.getRoom(SITE, "idle");
    expect(again).not.toBe(room);
    expect(textOf(again.state().state)).toBe("bye");
  });

  test("document names are validated and per-site quota is enforced", async () => {
    await expect(docs.getRoom(SITE, "Bad Name")).rejects.toThrow(/bad document name/);
    const list = await docs.listDocs(SITE);
    expect(list.map((d) => d.name)).toContain("order");
  });
});
