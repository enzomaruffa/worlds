import * as Y from "yjs";
import { sql, dbReady, requireDb } from "./db";
import { WorldsError } from "./errors";
import type { Identity } from "./identity";
import { checkRefs, docSchemaFor, validateTree, type DocSchema, type Violation } from "./docschema";

// Server-held collaborative documents. A doc is one Yjs document per (site, name); the
// server holds the authoritative Y.Doc while anyone is connected, and Postgres/SQLite holds a
// snapshot plus the log of committed updates.
//
// Commit before ack: an inbound batch is applied to a scratch copy and validated first, then
// persisted, and only then acknowledged and fanned out. A batch that fails validation is
// refused and never touches the live document — the sender gets `doc_rejected` with the
// current state so it can resync; nobody else notices.
//
// Epochs: the client-visible generation of the document. Every update names the epoch it
// was made against; a mismatch gets a `doc_reset` carrying the current state. The epoch only
// moves when the document is rotated (a client with the content model hands in a compact
// fresh state), because the server never decodes content and so cannot compact it itself.

export const DOC_LIMITS = {
  updateBytes: 512 * 1024,
  stateBytes: 4 * 1024 * 1024, // past this, subscribers are told a rotation is wanted
  hardStateBytes: 8 * 1024 * 1024, // past this, updates are refused
  docsPerSite: 200,
  nameLength: 64,
  snapshotEvery: 200, // committed batches between snapshots
  snapshotLogBytes: 1024 * 1024,
  idleCloseMs: Math.max(200, Number(process.env.WORLDS_DOC_IDLE_MS ?? 60_000)),
  batchMs: 5,
};

const DOC_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function checkDocName(name: string): void {
  if (!DOC_NAME.test(name)) throw new WorldsError("invalid_request", "bad document name");
}

// A connected subscriber. The socket layer hands in a closure so this module never
// depends on Bun's WebSocket type.
export interface DocClient {
  send(frame: Record<string, unknown>): void;
}

export interface DocState {
  epoch: number;
  seq: number;
  state: Uint8Array;
}

type Pending = {
  client: DocClient | null;
  subId: string | null;
  update: Uint8Array;
  who: Identity;
  resolve(seq: number): void;
  reject(err: WorldsError): void;
};

export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromB64(s: unknown): Uint8Array {
  if (typeof s !== "string" || !s) throw new WorldsError("invalid_request", "update must be a base64 string");
  const buf = Buffer.from(s, "base64");
  if (!buf.length) throw new WorldsError("invalid_request", "update must be a base64 string");
  return new Uint8Array(buf);
}

const BAD_ENCODING: Violation = { rule: "encoding", message: "update is not a valid Yjs update" };

// mergeUpdates decodes every update it is given and throws on garbage.
function mergeSafe(updates: Uint8Array[]): Uint8Array | null {
  try {
    return Y.mergeUpdates(updates);
  } catch {
    return null;
  }
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return new Uint8Array(Buffer.from(v.startsWith("\\x") ? v.slice(2) : v, v.startsWith("\\x") ? "hex" : "base64"));
  return new Uint8Array(v as ArrayBuffer);
}

class DocRoom {
  ydoc = new Y.Doc({ gc: true });
  epoch = 1;
  seq = 0;
  stateBytes = 0;
  subs = new Map<DocClient, string>();
  private pending: Pending[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private sinceSnapshot = { batches: 0, bytes: 0 };
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  closing: Promise<void> | null = null;
  rotateWanted = false;

  constructor(readonly site: string, readonly name: string) {}

  async load(): Promise<void> {
    const [row] = await sql`SELECT epoch, snapshot, snapshot_seq FROM docs WHERE site = ${this.site} AND name = ${this.name}`;
    if (!row) {
      await sql`INSERT INTO docs (site, name, epoch, snapshot, snapshot_seq, bytes) VALUES (${this.site}, ${this.name}, 1, ${Y.encodeStateAsUpdate(this.ydoc)}, 0, 0)`;
      this.stateBytes = Y.encodeStateAsUpdate(this.ydoc).byteLength;
      return;
    }
    this.epoch = Number(row.epoch);
    this.seq = Number(row.snapshot_seq);
    if (row.snapshot) Y.applyUpdate(this.ydoc, toBytes(row.snapshot));
    const rows = await sql`
      SELECT seq, "update" FROM doc_updates
      WHERE site = ${this.site} AND name = ${this.name} AND epoch = ${this.epoch} AND seq > ${this.seq}
      ORDER BY seq`;
    for (const r of rows) {
      Y.applyUpdate(this.ydoc, toBytes(r.update));
      this.seq = Number(r.seq);
    }
    this.stateBytes = Y.encodeStateAsUpdate(this.ydoc).byteLength;
  }

  state(): DocState {
    return { epoch: this.epoch, seq: this.seq, state: Y.encodeStateAsUpdate(this.ydoc) };
  }

  stateFrame(op: "doc_state" | "doc_reset" | "doc_rejected", subId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const s = this.state();
    return { op, id: subId, epoch: s.epoch, seq: s.seq, state: b64(s.state), bytes: this.stateBytes, ...extra };
  }

  subscribe(client: DocClient, subId: string): void {
    this.subs.set(client, subId);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  unsubscribe(client: DocClient): void {
    this.subs.delete(client);
    if (this.subs.size === 0) this.scheduleClose();
  }

  // Updates since `seq` in this epoch, for a reconnecting client. Null when the gap
  // predates the snapshot (the caller then sends the full state).
  async updatesSince(epoch: number, seq: number): Promise<Uint8Array[] | null> {
    if (epoch !== this.epoch) return null;
    if (seq > this.seq) return null;
    if (seq === this.seq) return [];
    const [snap] = await sql`SELECT snapshot_seq FROM docs WHERE site = ${this.site} AND name = ${this.name}`;
    if (!snap || seq < Number(snap.snapshot_seq)) return null;
    const rows = await sql`
      SELECT "update" FROM doc_updates
      WHERE site = ${this.site} AND name = ${this.name} AND epoch = ${this.epoch} AND seq > ${seq}
      ORDER BY seq`;
    return rows.map((r: { update: unknown }) => toBytes(r.update));
  }

  // Queue an update. Resolves with the committed seq, or rejects with a WorldsError the
  // caller turns into an error frame / HTTP error. Socket callers pass their client so
  // the ack and rejection frames reach them; HTTP callers pass null and use the promise.
  submit(who: Identity, epoch: number, update: Uint8Array, client: DocClient | null, subId: string | null): Promise<number> {
    if (update.byteLength > DOC_LIMITS.updateBytes) {
      throw new WorldsError("payload_too_large", `update exceeds ${DOC_LIMITS.updateBytes / 1024}KB`);
    }
    if (epoch !== this.epoch) {
      throw new WorldsError("conflict", "stale epoch", undefined, { epoch: this.epoch });
    }
    if (this.stateBytes > DOC_LIMITS.hardStateBytes) {
      throw new WorldsError("quota_exceeded", "document is over the size ceiling; rotate it");
    }
    return new Promise<number>((resolve, reject) => {
      this.pending.push({ client, subId, update, who, resolve, reject });
      if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), DOC_LIMITS.batchMs);
    });
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.flushing) await this.flushing;
    const batch = this.pending.splice(0);
    if (!batch.length) return;
    this.flushing = this.commit(batch).finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  // Validate on a scratch copy, then persist, then tell everyone. Order matters: nothing is
  // acknowledged or relayed that isn't already on disk, so a crash can only lose what no
  // client has been told was accepted.
  private async commit(batch: Pending[]): Promise<void> {
    const schema = await docSchemaFor(this.site, this.name);
    let accepted = batch;
    let merged = mergeSafe(batch.map((p) => p.update));
    let violation = merged ? await this.tryApply(merged, schema) : BAD_ENCODING;
    if (violation && batch.length > 1) {
      // One bad update shouldn't take the rest of the batch with it: keep the ones that
      // pass on their own.
      accepted = [];
      for (const p of batch) {
        const v = await this.tryApply(p.update, schema);
        if (v) this.reject(p, v);
        else accepted.push(p);
      }
      if (!accepted.length) return;
      merged = mergeSafe(accepted.map((p) => p.update));
      violation = merged ? await this.tryApply(merged, schema) : BAD_ENCODING;
    }
    if (violation || !merged) {
      for (const p of accepted) this.reject(p, violation ?? BAD_ENCODING);
      return;
    }

    if (!dbReady()) {
      for (const p of accepted) this.fail(p, new WorldsError("maintenance", "database unavailable"));
      return;
    }
    const seq = this.seq + 1;
    try {
      await sql`
        INSERT INTO doc_updates (site, name, epoch, seq, "update", by)
        VALUES (${this.site}, ${this.name}, ${this.epoch}, ${seq}, ${merged}, ${accepted[0]!.who.handle})`;
    } catch (e) {
      for (const p of accepted) this.fail(p, new WorldsError("internal", `could not persist update: ${(e as Error).message}`));
      return;
    }
    Y.applyUpdate(this.ydoc, merged, "commit");
    this.seq = seq;
    this.stateBytes = Y.encodeStateAsUpdate(this.ydoc).byteLength;
    this.sinceSnapshot.batches += 1;
    this.sinceSnapshot.bytes += merged.byteLength;

    for (const p of accepted) {
      p.resolve(seq);
      if (p.client && p.subId) p.client.send({ op: "doc_ack", id: p.subId, seq });
    }
    const frame = { op: "doc_update", seq, update: b64(merged) };
    for (const [client, subId] of this.subs) client.send({ ...frame, id: subId });

    const wanted = this.stateBytes > DOC_LIMITS.stateBytes;
    if (wanted !== this.rotateWanted) {
      this.rotateWanted = wanted;
      for (const [client, subId] of this.subs) client.send({ op: "doc_status", id: subId, bytes: this.stateBytes, rotate_wanted: wanted });
    }
    if (this.sinceSnapshot.batches >= DOC_LIMITS.snapshotEvery || this.sinceSnapshot.bytes >= DOC_LIMITS.snapshotLogBytes) {
      await this.snapshot();
    }
  }

  private async tryApply(update: Uint8Array, schema: DocSchema | null): Promise<Violation | null> {
    const scratch = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(scratch, Y.encodeStateAsUpdate(this.ydoc));
      Y.applyUpdate(scratch, update);
    } catch (e) {
      scratch.destroy();
      return { rule: "encoding", message: `update is not a valid Yjs update: ${(e as Error).message}` };
    }
    try {
      return await this.validate(scratch, schema);
    } finally {
      scratch.destroy();
    }
  }

  private async validate(doc: Y.Doc, schema: DocSchema | null): Promise<Violation | null> {
    if (!schema) return null;
    const check = validateTree(doc, schema, Y.encodeStateAsUpdate(doc).byteLength);
    if (check.violation) return check.violation;
    return check.refs.length ? checkRefs(this.site, check.refs) : null;
  }

  private reject(p: Pending, v: Violation): void {
    p.reject(new WorldsError("invalid_request", v.message, undefined, { rule: v.rule }));
    if (p.client && p.subId) {
      p.client.send(this.stateFrame("doc_rejected", p.subId, { reason: v.message, rule: v.rule }));
    }
  }

  private fail(p: Pending, err: WorldsError): void {
    p.reject(err);
    if (p.client && p.subId) p.client.send({ op: "error", id: p.subId, error: { code: err.code, message: err.message } });
  }

  async snapshot(): Promise<void> {
    if (!dbReady()) return;
    const state = Y.encodeStateAsUpdate(this.ydoc);
    await sql`
      UPDATE docs SET snapshot = ${state}, snapshot_seq = ${this.seq}, epoch = ${this.epoch}, bytes = ${state.byteLength}, updated_at = ${new Date().toISOString()}
      WHERE site = ${this.site} AND name = ${this.name}`;
    await sql`DELETE FROM doc_updates WHERE site = ${this.site} AND name = ${this.name} AND (epoch < ${this.epoch} OR seq <= ${this.seq})`;
    this.sinceSnapshot = { batches: 0, bytes: 0 };
  }

  // Install a compact state as a new epoch. Validated like any update; the log of the old
  // epoch is dropped once the new snapshot is down.
  async rotate(who: Identity, expectEpoch: number, state: Uint8Array): Promise<DocState> {
    if (expectEpoch !== this.epoch) throw new WorldsError("conflict", "stale epoch", undefined, { epoch: this.epoch });
    if (state.byteLength > DOC_LIMITS.stateBytes) throw new WorldsError("payload_too_large", "rotated state is still over the size threshold");
    if (this.flushing) await this.flushing;
    const fresh = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(fresh, state);
    } catch (e) {
      fresh.destroy();
      throw new WorldsError("invalid_request", `state is not a valid Yjs update: ${(e as Error).message}`);
    }
    const v = await this.validate(fresh, await docSchemaFor(this.site, this.name));
    if (v) {
      fresh.destroy();
      throw new WorldsError("invalid_request", v.message, undefined, { rule: v.rule });
    }
    requireDb();
    const epoch = this.epoch + 1;
    const compact = Y.encodeStateAsUpdate(fresh);
    await sql`
      UPDATE docs SET snapshot = ${compact}, snapshot_seq = 0, epoch = ${epoch}, bytes = ${compact.byteLength}, updated_at = ${new Date().toISOString()}
      WHERE site = ${this.site} AND name = ${this.name}`;
    await sql`DELETE FROM doc_updates WHERE site = ${this.site} AND name = ${this.name} AND epoch < ${epoch}`;
    this.ydoc.destroy();
    this.ydoc = fresh;
    this.epoch = epoch;
    this.seq = 0;
    this.stateBytes = compact.byteLength;
    this.rotateWanted = false;
    this.sinceSnapshot = { batches: 0, bytes: 0 };
    for (const [client, subId] of this.subs) {
      client.send(this.stateFrame("doc_reset", subId, { reason: `rotated by ${who.handle}` }));
    }
    return this.state();
  }

  private scheduleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.subs.size) return;
      this.closing = closeRoom(this);
    }, DOC_LIMITS.idleCloseMs);
    this.idleTimer.unref?.();
  }

  async finish(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      await this.flush();
    }
    if (this.flushing) await this.flushing;
    await this.snapshot();
    this.ydoc.destroy();
  }
}

// One registry entry per open document. A closing room stays registered until its final
// snapshot is written, so a subscriber arriving mid-close waits for it and then loads a
// fresh room that sees that snapshot — two rooms for one document never overlap.
const rooms = new Map<string, Promise<DocRoom>>();

function key(site: string, name: string): string {
  return `${site}/${name}`;
}

async function closeRoom(room: DocRoom): Promise<void> {
  try {
    await room.finish();
  } finally {
    rooms.delete(key(room.site, room.name));
  }
}

async function countDocs(site: string): Promise<number> {
  const [row] = await sql`SELECT count(*) AS n FROM docs WHERE site = ${site}`;
  return Number(row?.n ?? 0);
}

export async function getRoom(site: string, name: string): Promise<DocRoom> {
  requireDb();
  checkDocName(name);
  const k = key(site, name);
  for (;;) {
    const existing = rooms.get(k);
    if (!existing) break;
    const room = await existing;
    if (!room.closing) return room;
    await room.closing.catch(() => {});
  }
  const loading = (async () => {
    const room = new DocRoom(site, name);
    const [exists] = await sql`SELECT 1 AS present FROM docs WHERE site = ${site} AND name = ${name}`;
    if (!exists && (await countDocs(site)) >= DOC_LIMITS.docsPerSite) {
      throw new WorldsError("quota_exceeded", `site has ${DOC_LIMITS.docsPerSite} documents`);
    }
    await room.load();
    return room;
  })();
  rooms.set(k, loading);
  try {
    return await loading;
  } catch (e) {
    rooms.delete(k);
    throw e;
  }
}

// Drop the in-memory room WITHOUT snapshotting — what a crash does. The next getRoom
// must rebuild it from the snapshot plus the committed log. Tests and chaos runs only.
export async function forgetRoom(site: string, name: string): Promise<void> {
  const k = key(site, name);
  const p = rooms.get(k);
  rooms.delete(k);
  if (p) (await p).ydoc.destroy();
}

// Graceful stop: snapshot every open room so a restart replays nothing.
export async function closeAllRooms(): Promise<void> {
  await Promise.all([...rooms.values()].map((p) => p.then((r) => r.finish()).catch(() => {})));
  rooms.clear();
}

export async function listDocs(site: string): Promise<{ name: string; epoch: number; bytes: number; updated_at: string }[]> {
  requireDb();
  const rows = await sql`SELECT name, epoch, bytes, updated_at FROM docs WHERE site = ${site} ORDER BY name`;
  return rows.map((r: Record<string, unknown>) => ({ name: String(r.name), epoch: Number(r.epoch), bytes: Number(r.bytes), updated_at: String(r.updated_at) }));
}
