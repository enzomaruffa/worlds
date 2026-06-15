import type { ServerWebSocket } from "bun";
import { LIMITS } from "./config";
import { onChange, replaySince, dbReady, type ChangeEvent } from "./db";
import type { Identity } from "./identity";

// One multiplexed socket per page. Frame protocol is part of the frozen v1
// contract (docs/PLAN.md B.2): sub/unsub/pub → event/msg/presence/ack/error.

export interface SocketData {
  who: Identity;
  site: string;
  subs: Map<string, { kind: "db" | "channel" | "actors"; key: string; cid?: string }>;
}

type WS = ServerWebSocket<SocketData>;

const channelMembers = new Map<string, Map<WS, Identity>>();
const dbSubs = new Map<string, Map<WS, string>>(); // scopeKey -> ws -> subId

const MAX_SUBS_PER_SOCKET = 100;

// ── Actors: per-member live STATE with zone interest-management + coalesced flush.
// A third realtime tier beside channels (ephemeral events) and db subs. Each member
// keeps ONE last-value state; the server fans it out only to same-zone peers, batched
// at a fixed flush rate — turning per-tick N² fan-out into N·(zone size). Joiners get
// an immediate in-zone snapshot; nobody can melt a room by publishing faster.
interface ActorEntry {
  ws: WS;
  cid: string; // stable per-tab id — the actor's identity to its peers
  who: Identity;
  zone: string;
  state: unknown; // undefined until the member's first set
  dirty: boolean; // changed since the last flush
}
interface ActorRoom {
  members: Map<string, ActorEntry>; // cid -> entry
  rate: number; // flush Hz (the first subscriber sets it, clamped)
  timer: ReturnType<typeof setInterval> | null;
}
const actorRooms = new Map<string, ActorRoom>(); // scopeKey -> room
const MAX_ACTOR_RATE = 20;

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

// ── actors helpers ──

// The actors sub ids a given socket holds for this room (a socket can hold more
// than one, though games use one) — used to stamp the right `id` on each frame.
function actorSubIds(ws: WS, key: string): string[] {
  const ids: string[] = [];
  for (const [subId, sub] of ws.data.subs) {
    if (sub.kind === "actors" && sub.key === key) ids.push(subId);
  }
  return ids;
}

// Send `ws` the current state of every OTHER member in `zone` — the last-value
// snapshot a joiner (or zone-switcher) gets so it sees the world immediately.
function sendActorSnapshot(ws: WS, key: string, subId: string, zone: string, selfCid: string): void {
  const room = actorRooms.get(key);
  if (!room) return;
  const actors = [];
  for (const e of room.members.values()) {
    if (e.cid === selfCid || e.zone !== zone || e.state === undefined) continue;
    actors.push({ id: e.cid, handle: e.who.handle, name: e.who.name, state: e.state });
  }
  ws.send(JSON.stringify({ op: "actors_snapshot", id: subId, actors }));
}

// Tell everyone still in `zone` that `cid` is gone from it (left the room, or moved
// to another zone) so they can drop its ghost.
function notifyZoneLeave(key: string, zone: string, cid: string): void {
  const room = actorRooms.get(key);
  if (!room) return;
  for (const e of room.members.values()) {
    if (e.cid === cid || e.zone !== zone) continue;
    for (const subId of actorSubIds(e.ws, key)) {
      e.ws.send(JSON.stringify({ op: "actors_leave", id: subId, ids: [cid] }));
    }
  }
}

// One flush tick: send each member a single batched frame of the in-zone peers that
// changed since the last tick. Coalescing (multiple sets collapse to the latest) +
// interest management (zone filter) + batching all happen here.
function flushActorRoom(key: string): void {
  const room = actorRooms.get(key);
  if (!room) return;
  const dirtyByZone = new Map<string, ActorEntry[]>();
  for (const e of room.members.values()) {
    if (!e.dirty || e.state === undefined) continue;
    let arr = dirtyByZone.get(e.zone);
    if (!arr) dirtyByZone.set(e.zone, (arr = []));
    arr.push(e);
  }
  if (dirtyByZone.size === 0) return;
  for (const recipient of room.members.values()) {
    const dirty = dirtyByZone.get(recipient.zone);
    if (!dirty) continue;
    const updates = [];
    for (const e of dirty) {
      if (e.cid === recipient.cid) continue;
      updates.push({ id: e.cid, handle: e.who.handle, name: e.who.name, state: e.state });
    }
    if (updates.length === 0) continue;
    for (const subId of actorSubIds(recipient.ws, key)) {
      recipient.ws.send(JSON.stringify({ op: "actors", id: subId, updates }));
    }
  }
  for (const e of room.members.values()) e.dirty = false;
}

function ensureActorTimer(key: string): void {
  const room = actorRooms.get(key);
  if (!room || room.timer) return;
  room.timer = setInterval(() => flushActorRoom(key), 1000 / room.rate);
}

// Remove a member and stop the room's flush timer once it empties.
function dropActor(ws: WS, key: string, cid: string): void {
  const room = actorRooms.get(key);
  if (!room) return;
  const e = room.members.get(cid);
  if (!e || e.ws !== ws) return;
  room.members.delete(cid);
  notifyZoneLeave(key, e.zone, cid);
  if (room.members.size === 0) {
    if (room.timer) clearInterval(room.timer);
    actorRooms.delete(key);
  }
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
  if (frame.kind === "actors") {
    const key = presenceKey(ws.data.site, String(frame.channel ?? ""));
    const cid = typeof frame.cid === "string" && frame.cid ? frame.cid : id;
    const zone = typeof frame.zone === "string" ? frame.zone : "";
    ws.data.subs.set(id, { kind: "actors", key, cid });
    let room = actorRooms.get(key);
    if (!room) {
      // The first subscriber fixes the flush rate (clamped) — a later fast joiner
      // can't push the room past the cap.
      const rate = Math.max(1, Math.min(MAX_ACTOR_RATE, Number(frame.rate) || 15));
      room = { members: new Map(), rate, timer: null };
      actorRooms.set(key, room);
    }
    room.members.set(cid, { ws, cid, who: ws.data.who, zone, state: undefined, dirty: false });
    ensureActorTimer(key);
    ws.send(JSON.stringify({ op: "ack", id }));
    sendActorSnapshot(ws, key, id, zone, cid); // instant last-value snapshot of the zone
    return;
  }
  sendErr(ws, id, "invalid_request", "kind must be db, channel or actors");
}

// `set` updates the caller's own last-value state (and zone). No ack — it runs at
// frame rate; the coalescing flush delivers it. A zone change leaves the old zone
// (peers get actors_leave) and snapshots the new one back to the mover.
function handleSet(ws: WS, frame: Record<string, unknown>): void {
  const cid = typeof frame.cid === "string" ? frame.cid : null;
  if (!cid) return;
  if (JSON.stringify(frame.state ?? null).length > LIMITS.wsPayloadBytes) {
    sendErr(ws, undefined, "payload_too_large", "actor state over 16KB");
    return;
  }
  const key = presenceKey(ws.data.site, String(frame.channel ?? ""));
  const room = actorRooms.get(key);
  if (!room) return; // not subscribed (or a stale race) — ignore
  const e = room.members.get(cid);
  if (!e || e.ws !== ws) return; // only your own entry, on your own socket
  const newZone = typeof frame.zone === "string" ? frame.zone : e.zone;
  e.state = frame.state;
  if (newZone !== e.zone) {
    const oldZone = e.zone;
    e.zone = newZone;
    notifyZoneLeave(key, oldZone, cid); // old zone drops me
    for (const subId of actorSubIds(ws, key)) sendActorSnapshot(ws, key, subId, newZone, cid);
  }
  e.dirty = true; // delivered to the (new) zone on the next flush
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
  if (sub?.kind === "actors" && sub.cid) dropActor(ws, sub.key, sub.cid);
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
    if (frame.op === "set") return handleSet(ws, frame);
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
      if (sub.kind === "actors" && sub.cid) dropActor(ws, sub.key, sub.cid);
    }
    for (const key of touched) broadcastPresence(key);
  },
};
