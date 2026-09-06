// One multiplexed WebSocket for the whole page: db subscriptions and channels
// share it. Reconnects with backoff, replays db cursors, and queues frames sent
// while still connecting so nothing is dropped.
type Frame = Record<string, unknown> & { op: string; id?: string };

// Who a peer is on the wire. Defined here because socket.ts is the bottom of the SDK's
// import order, so channels/room/actors can all share this one shape.
export interface Person {
  handle: string;
  name: string;
}
interface Sub {
  frame: Frame;
  handler: (ev: any) => void;
  cursor: string | null;
  onPresence?: (members: Person[]) => void;
  onExpired?: () => void;
  onSnapshot?: (actors: any[]) => void; // actors: full in-zone state (join / zone switch)
  onActors?: (updates: any[]) => void; // actors: batched per-flush updates
  onActorEvent?: (from: any, payload: any) => void; // actors: a peer's one-off event
  onActorLeave?: (ids: string[]) => void; // actors: members who left the zone
  onDoc?: (frame: any) => void; // doc: every doc_* frame, undecoded
  onError?: (error: { code: string; message: string }) => void;
}

export const sock = {
  ws: null as WebSocket | null,
  backoff: 1000,
  nextId: 1,
  subs: new Map<string, Sub>(),
  outbox: [] as Frame[],
  connectionListeners: new Set<(state: "open" | "closed") => void>(),

  // Connection state for callers that show it (an editor going read-only while offline).
  onConnection(fn: (state: "open" | "closed") => void): () => void {
    this.connectionListeners.add(fn);
    return () => this.connectionListeners.delete(fn);
  },

  open(): void {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // Path mode: declare the site via query (WebSockets can't send custom headers).
    const m = location.pathname.match(/^\/app\/([^/]+)/);
    const q = m ? `?site=${encodeURIComponent(m[1]!)}` : "";
    this.ws = new WebSocket(`${proto}//${location.host}/api/v1/socket${q}`, "worlds.v1");
    this.ws.onopen = () => {
      this.backoff = 1000;
      for (const fn of this.connectionListeners) fn("open");
      for (const [id, sub] of this.subs) {
        const frame: Frame = { ...sub.frame, id };
        if (sub.cursor) frame.since = sub.cursor;
        this.ws!.send(JSON.stringify(frame));
      }
      for (const f of this.outbox) this.ws!.send(JSON.stringify(f));
      this.outbox = [];
    };
    this.ws.onmessage = (m) => {
      let f: any;
      try { f = JSON.parse(m.data); } catch { return; }
      const sub = f.id && this.subs.get(f.id);
      if (!sub) return;
      if (f.op === "event") {
        sub.cursor = f.cursor || sub.cursor;
        sub.handler({ type: f.type, doc: f.doc });
      } else if (f.op === "msg") {
        sub.handler({ payload: f.payload, from: f.from, at: f.at });
      } else if (f.op === "presence" && sub.onPresence) {
        sub.onPresence(f.members);
      } else if (f.op === "actors_snapshot" && sub.onSnapshot) {
        sub.onSnapshot(f.actors || []);
      } else if (f.op === "actors" && sub.onActors) {
        sub.onActors(f.updates || []);
      } else if (f.op === "actor_event" && sub.onActorEvent) {
        sub.onActorEvent(f.from, f.payload);
      } else if (f.op === "actors_leave" && sub.onActorLeave) {
        sub.onActorLeave(f.ids || []);
      } else if (typeof f.op === "string" && f.op.startsWith("doc_") && sub.onDoc) {
        sub.onDoc(f);
      } else if (f.op === "error") {
        if (f.error?.code === "replay_expired" && sub.onExpired) {
          sub.cursor = null;
          sub.onExpired();
        } else if (sub.onError) {
          sub.onError(f.error ?? { code: "internal", message: "unknown realtime error" });
        } else {
          // Nothing else can surface this — a rejected subscription would otherwise
          // look identical to a topic that is simply quiet.
          console.warn("[worlds] realtime error", f.error?.code, f.error?.message);
        }
      }
    };
    this.ws.onclose = () => {
      for (const fn of this.connectionListeners) fn("closed");
      if (this.subs.size === 0 && this.outbox.length === 0) return;
      setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
  },

  send(frame: Frame): void {
    this.open();
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
    else this.outbox.push(frame); // flushed on open — frames are never dropped
  },

  subscribe(frame: Frame, handler: (ev: any) => void, extras: Partial<Sub> = {}): () => void {
    return this.sub(frame, handler, extras).off;
  },

  // Like subscribe, but hands back the subscription id and its entry — for primitives
  // that send frames addressed to their own subscription (docs) or move its cursor.
  sub(frame: Frame, handler: (ev: any) => void, extras: Partial<Sub> = {}): { id: string; entry: Sub; off: () => void } {
    const id = `s${this.nextId++}`;
    const entry: Sub = { frame, handler, cursor: null, ...extras };
    this.subs.set(id, entry);
    this.open();
    // Only send when already connected: onopen replays every entry in `subs`, so
    // queueing here too would register the subscription twice per connect.
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ ...frame, id }));
    const off = () => {
      this.subs.delete(id);
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op: "unsub", id }));
    };
    return { id, entry, off };
  },
};
