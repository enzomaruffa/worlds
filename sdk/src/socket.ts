// One multiplexed WebSocket for the whole page: db subscriptions and channels
// share it. Reconnects with backoff, replays db cursors, and queues frames sent
// while still connecting so nothing is dropped.
type Frame = Record<string, unknown> & { op: string; id?: string };
interface Sub {
  frame: Frame;
  handler: (ev: any) => void;
  cursor: string | null;
  onPresence?: (members: unknown[]) => void;
  onExpired?: () => void;
}

export const sock = {
  ws: null as WebSocket | null,
  backoff: 1000,
  nextId: 1,
  subs: new Map<string, Sub>(),
  outbox: [] as string[],

  open(): void {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${proto}//${location.host}/api/v1/socket`, "worlds.v1");
    this.ws.onopen = () => {
      this.backoff = 1000;
      for (const [id, sub] of this.subs) {
        const frame: Frame = { ...sub.frame, id };
        if (sub.cursor) frame.since = sub.cursor;
        this.ws!.send(JSON.stringify(frame));
      }
      for (const f of this.outbox) this.ws!.send(f);
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
      } else if (f.op === "error" && f.error?.code === "replay_expired" && sub.onExpired) {
        sub.cursor = null;
        sub.onExpired();
      }
    };
    this.ws.onclose = () => {
      if (this.subs.size === 0) return;
      setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
  },

  send(frame: Frame): void {
    this.open();
    const s = JSON.stringify(frame);
    if (this.ws && this.ws.readyState === 1) this.ws.send(s);
    else this.outbox.push(s); // flushed on open — frames are never dropped
  },

  subscribe(frame: Frame, handler: (ev: any) => void, extras: Partial<Sub> = {}): () => void {
    const id = `s${this.nextId++}`;
    this.subs.set(id, { frame, handler, cursor: null, ...extras });
    this.send({ ...frame, id });
    return () => {
      this.subs.delete(id);
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op: "unsub", id }));
    };
  },
};
