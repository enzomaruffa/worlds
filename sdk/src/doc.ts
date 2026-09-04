import { sock } from "./socket";
import { call } from "./http";

// worlds.doc(name) — the transport for ONE server-held collaborative document. The
// server keeps the authoritative copy and persists every accepted update before anyone
// sees it; this side only moves bytes. Bring your own CRDT (Yjs is what the server
// speaks): feed `onState`/`onUpdate` into Y.applyUpdate, and hand `ydoc.on("update")`
// to `send`. Cursors and selections ride a normal channel (`worlds.ws.channel`).
//
// Epochs are the document's generation. Every update names the epoch it was made
// against; when the server has moved on (a rotation, or your copy is stale) you get
// `onReset` with a full state and must replace your local document with it.

export interface DocHandlers {
  onState(state: Uint8Array, info: { epoch: number; seq: number; bytes: number }): void; // initial load
  onUpdate(update: Uint8Array, info: { seq: number }): void; // a committed update (yours included)
  onReset?(state: Uint8Array, info: { epoch: number; seq: number; reason: string }): void; // replace the local doc
  onRejected?(state: Uint8Array, info: { reason: string; rule?: string }): void; // your update was refused; resync from state
  onAck?(seq: number): void;
  onStatus?(info: { bytes: number; rotateWanted: boolean; reconnecting?: boolean }): void; // the doc is large; a compact state would be welcome
  onError?(error: { code: string; message: string }): void;
}

export interface DocTransport {
  readonly name: string;
  readonly epoch: number;
  readonly seq: number;
  ready: Promise<void>; // resolves after the first state arrives
  send(update: Uint8Array): void;
  close(): void;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Whole-document operations that need no live transport.
export const docs = {
  list: () => call("GET", "/api/v1/docs"),
  // Site contributors and services only; subscribers get an error frame and the name is free again.
  remove: (name: string) => call("DELETE", `/api/v1/docs/${encodeURIComponent(name)}`),
};

export function doc(name: string, handlers: DocHandlers): DocTransport {
  let epoch = 0;
  let seq = 0;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((r) => (resolveReady = r));

  // The sub frame is replayed on every reconnect; keeping epoch + since on it means a
  // reconnect asks only for the tail we missed instead of the whole state.
  const frame: Record<string, unknown> & { op: string } = { op: "sub", kind: "doc", doc: name };
  let resubAttempts = 0;
  // A dropped socket is reported as reconnecting until the next doc_state lands.
  const offConnection = sock.onConnection((state) => {
    if (state === "closed") handlers.onStatus?.({ bytes: 0, rotateWanted: false, reconnecting: true });
  });
  const { id, entry, off } = sock.sub(frame, () => {}, {
    onDoc: (f: any) => {
      if (f.op === "doc_state") {
        epoch = f.epoch;
        resubAttempts = 0;
        seq = f.seq;
        frame.epoch = epoch;
        entry.cursor = String(seq);
        handlers.onState(fromBase64(f.state), { epoch, seq, bytes: f.bytes ?? 0 });
        resolveReady();
      } else if (f.op === "doc_update") {
        seq = f.seq;
        entry.cursor = String(seq);
        handlers.onUpdate(fromBase64(f.update), { seq });
      } else if (f.op === "doc_ack") {
        if (typeof f.epoch === "number") { epoch = f.epoch; frame.epoch = epoch; }
        seq = Math.max(seq, f.seq);
        entry.cursor = String(seq);
        if (!f.resumed) handlers.onAck?.(f.seq);
      } else if (f.op === "doc_reset") {
        epoch = f.epoch;
        seq = f.seq;
        frame.epoch = epoch;
        entry.cursor = String(seq);
        handlers.onReset?.(fromBase64(f.state), { epoch, seq, reason: f.reason ?? "reset" });
      } else if (f.op === "doc_rejected") {
        epoch = f.epoch;
        seq = f.seq;
        frame.epoch = epoch;
        entry.cursor = String(seq);
        handlers.onRejected?.(fromBase64(f.state), { reason: f.reason ?? "rejected", rule: f.rule });
      } else if (f.op === "doc_status") {
        handlers.onStatus?.({ bytes: f.bytes ?? 0, rotateWanted: !!f.rotate_wanted });
      }
    },
    onError: (error) => {
      // "maintenance" is the server saying "not right now" — the room is re-homing after a
      // pod died, or the database blinked. Ask again with backoff; anything else is the caller's.
      if (error.code === "maintenance" && resubAttempts < 8) {
        const delay = Math.min(5000, 500 * 2 ** resubAttempts++);
        setTimeout(() => sock.send({ ...frame, id, since: entry.cursor ?? undefined }), delay);
        handlers.onStatus?.({ bytes: 0, rotateWanted: false, reconnecting: true });
        return;
      }
      handlers.onError?.(error);
    },
  });

  return {
    name,
    get epoch() { return epoch; },
    get seq() { return seq; },
    ready,
    send(update: Uint8Array) {
      sock.send({ op: "doc_update", id, epoch, update: toBase64(update) });
    },
    close: () => {
      offConnection();
      off();
    },
  };
}
