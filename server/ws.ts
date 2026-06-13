import type { ServerWebSocket } from "bun";
import { LIMITS } from "./config";
import { onChange, replaySince, dbReady, type ChangeEvent } from "./db";
import type { Identity } from "./identity";

// One multiplexed socket per page. Frame protocol is part of the frozen v1
// contract (docs/PLAN.md B.2): sub/unsub/pub → event/msg/presence/ack/error.

export interface SocketData {
  who: Identity;
  site: string;
  subs: Map<string, { kind: "db" | "channel"; key: string }>;
}

type WS = ServerWebSocket<SocketData>;

const channelMembers = new Map<string, Map<WS, Identity>>();
const dbSubs = new Map<string, Map<WS, string>>(); // scopeKey -> ws -> subId

const MAX_SUBS_PER_SOCKET = 100;

// Drop a socket from a scoped registry, pruning the scope entry when it empties
// (otherwise the outer map grows one entry per (site, collection|channel) forever).
function dropFromScope<V>(reg: Map<string, Map<WS, V>>, key: string, ws: WS): void {
  const inner = reg.get(key);
  if (!inner) return;
  inner.delete(ws);
  if (inner.size === 0) reg.delete(key);
}

let feedStarted = false;

function ensureChangeFeed(): void {
  if (feedStarted) return;
  feedStarted = true;
  onChange((ev: ChangeEvent) => {
    const subs = dbSubs.get(`${ev.site}/${ev.collection}`);
    if (!subs) return;
    for (const [ws, id] of subs) {
      ws.send(JSON.stringify({ op: "event", id, type: ev.type, doc: ev.doc, cursor: ev.cursor }));
    }
  });
}

function presenceKey(site: string, channel: string): string {
  return `${site}/${channel}`;
}

function broadcastPresence(key: string): void {
  const members = channelMembers.get(key);
  if (!members) return;
  const seen = new Set<string>();
  const list = [];
  for (const who of members.values()) {
    if (seen.has(who.handle)) continue;
    seen.add(who.handle);
    list.push({ handle: who.handle, name: who.name });
  }
  for (const [ws] of members) {
    for (const [id, sub] of ws.data.subs) {
      if (sub.kind === "channel" && sub.key === key) {
        ws.send(JSON.stringify({ op: "presence", id, members: list }));
      }
    }
  }
}

function sendErr(ws: WS, id: string | undefined, code: string, message: string): void {
  ws.send(JSON.stringify({ op: "error", id, error: { code, message } }));
}

async function handleSub(ws: WS, id: string, frame: Record<string, unknown>): Promise<void> {
  if (ws.data.subs.size >= MAX_SUBS_PER_SOCKET && !ws.data.subs.has(id)) {
    sendErr(ws, id, "invalid_request", `too many subscriptions (max ${MAX_SUBS_PER_SOCKET})`);
    return;
  }
  if (frame.kind === "db") {
    if (!dbReady()) {
      sendErr(ws, id, "maintenance", "database unavailable");
      return;
    }
    const collection = String(frame.collection ?? "");
    // Subscriptions are reads — cross-world subscribe is allowed via frame.site.
    const scope = typeof frame.site === "string" && frame.site ? frame.site : ws.data.site;
    const key = `${scope}/${collection}`;
    ws.data.subs.set(id, { kind: "db", key });
    if (!dbSubs.has(key)) dbSubs.set(key, new Map());
    dbSubs.get(key)!.set(ws, id);
    if (typeof frame.since === "string" && frame.since) {
      const replay = await replaySince(scope, collection, frame.since);
      if (replay === "expired") {
        sendErr(ws, id, "replay_expired", "cursor too old, re-list");
        return;
      }
      for (const ev of replay) {
        ws.send(JSON.stringify({ op: "event", id, type: ev.type, doc: ev.doc, cursor: ev.cursor }));
      }
    }
    ws.send(JSON.stringify({ op: "ack", id }));
    return;
  }
  if (frame.kind === "channel") {
    const key = presenceKey(ws.data.site, String(frame.channel ?? ""));
    ws.data.subs.set(id, { kind: "channel", key });
    if (!channelMembers.has(key)) channelMembers.set(key, new Map());
    channelMembers.get(key)!.set(ws, ws.data.who);
    ws.send(JSON.stringify({ op: "ack", id }));
    broadcastPresence(key);
    return;
  }
  sendErr(ws, id, "invalid_request", "kind must be db or channel");
}

function handleUnsub(ws: WS, id: string): void {
  const sub = ws.data.subs.get(id);
  ws.data.subs.delete(id);
  if (sub?.kind === "db") dropFromScope(dbSubs, sub.key, ws);
  if (sub?.kind === "channel") {
    const stillIn = [...ws.data.subs.values()].some((s) => s.kind === "channel" && s.key === sub.key);
    if (!stillIn) {
      dropFromScope(channelMembers, sub.key, ws);
      broadcastPresence(sub.key);
    }
  }
}

function handlePub(ws: WS, id: string, frame: Record<string, unknown>): void {
  const payload = frame.payload;
  if (JSON.stringify(payload ?? null).length > LIMITS.wsPayloadBytes) {
    sendErr(ws, id, "payload_too_large", "ws payload over 16KB");
    return;
  }
  const key = presenceKey(ws.data.site, String(frame.channel ?? ""));
  const members = channelMembers.get(key);
  const base = {
    op: "msg",
    payload,
    from: { handle: ws.data.who.handle, name: ws.data.who.name },
    at: new Date().toISOString(),
  };
  if (members) {
    for (const [peer] of members) {
      for (const [subId, sub] of peer.data.subs) {
        if (sub.kind === "channel" && sub.key === key) {
          peer.send(JSON.stringify({ ...base, id: subId }));
        }
      }
    }
  }
  ws.send(JSON.stringify({ op: "ack", id }));
}

export const websocket = {
  open(_ws: WS): void {
    ensureChangeFeed();
  },

  async message(ws: WS, raw: string | Buffer): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      sendErr(ws, undefined, "invalid_request", "frames must be JSON");
      return;
    }
    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (!id) {
      sendErr(ws, undefined, "invalid_request", "missing frame id");
      return;
    }
    if (frame.op === "sub") return handleSub(ws, id, frame);
    if (frame.op === "unsub") return handleUnsub(ws, id);
    if (frame.op === "pub") return handlePub(ws, id, frame);
    // Unknown ops are ignored (forward-compat rule).
  },

  close(ws: WS): void {
    const touched = new Set<string>();
    for (const sub of ws.data.subs.values()) {
      if (sub.kind === "db") dropFromScope(dbSubs, sub.key, ws);
      if (sub.kind === "channel") {
        dropFromScope(channelMembers, sub.key, ws);
        touched.add(sub.key);
      }
    }
    for (const key of touched) broadcastPresence(key);
  },
};
