import type { ServerWebSocket } from "bun";
import { LIMITS } from "./config";
import { onChange, replaySince, dbReady, type ChangeEvent } from "./db";
import { asWorldsError } from "./errors";
import type { Identity } from "./identity";
import { b64, fromB64, getRoom, peekRoom, type DocClient, type DocRoomLike } from "./docs";
import { closeUpstream, pipeUpstream, sendUpstream } from "./proxy";
import * as cluster from "./cluster";

// One multiplexed socket per page. Frame protocol is part of the frozen v1
// contract (docs/PLAN.md B.2): sub/unsub/pub → event/msg/presence/ack/error.

export interface SocketData {
  who: Identity;
  site: string;
  // Doc subscriptions keep the document name, not the room: the room a document lives in
  // can change under a socket (an owner pod dies and it is re-homed), so it is looked up
  // in the registry on every use.
  subs: Map<string, SubEntry>;
  fanout?: { tokens: number; at: number }; // broadcast budget, created on first pub/aevent
  proxy?: WebSocket; // set for a site backend passthrough — the upstream client socket
  peer?: string; // set for a pod-to-pod link (cluster.ts) — the dialing pod's id
}

// What an actors subscription asked for, kept so the member can be re-joined if the pod
// hosting its room goes away.
interface ActorJoin {
  channel: string;
  zone: string;
  rate: number;
  meta: Record<string, unknown>;
  observer: boolean;
}

interface SubEntry {
  kind: "db" | "channel" | "actors" | "doc";
  key: string;
  cid?: string;
  doc?: string;
  client?: DocClient;
  remote?: string; // actors: the pod hosting this room when it isn't us
  join?: ActorJoin;
}

type WS = ServerWebSocket<SocketData>;

// The slice of a socket the actors code touches. A real ServerWebSocket satisfies it, and
// so does the stand-in an owner pod keeps for a member whose socket is on another pod.
interface ActorSink {
  readonly readyState: number;
  send(data: string): void;
  data: { site: string; who: Identity; subs: Map<string, SubEntry>; fanout?: { tokens: number; at: number } };
}

// `set` is safe by construction — it's last-value state drained by the room's flush
// timer, so a faster publisher only overwrites itself. `pub` and `aevent` fan out on
// arrival, one 16KB frame per in-zone peer, which is where a single tab can melt a
// room. A token bucket keeps bursts (a buzzer, a volley of strokes) working while
// capping the sustained rate.
const FANOUT_BURST = 120;
const FANOUT_PER_SEC = 40;

function allowFanout(ws: ActorSink): boolean {
  const now = Date.now();
  const b = (ws.data.fanout ??= { tokens: FANOUT_BURST, at: now });
  b.tokens = Math.min(FANOUT_BURST, b.tokens + ((now - b.at) / 1000) * FANOUT_PER_SEC);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

const channelMembers = new Map<string, Map<WS, Identity>>();
const dbSubs = new Map<string, Map<WS, string>>(); // scopeKey -> ws -> subId

const MAX_SUBS_PER_SOCKET = 100;

// ── Actors: per-member live STATE with zone interest-management + coalesced flush.
// A third realtime tier beside channels (ephemeral events) and db subs. Each member
// keeps ONE last-value state; the server fans it out only to same-zone peers, batched
// at a fixed flush rate — turning per-tick N² fan-out into N·(zone size). Joiners get
// an immediate in-zone snapshot; nobody can melt a room by publishing faster.
interface ActorEntry {
  ws: ActorSink;
  cid: string; // stable per-tab id — the actor's identity to its peers
  who: Identity;
  zone: string;
  state: unknown; // last-value frame state (undefined until the member's first set)
  meta: Record<string, unknown>; // infrequent per-member metadata (team, level, status…)
  stateDirty: boolean; // state changed since the last flush
  metaDirty: boolean; // metadata changed since the last flush
  observer: boolean; // watches the zone but is invisible to peers (no state/events/leave)
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

type Person = { handle: string; name: string };

// Presence a peer pod reported for a channel: key → pod → members. Merged into what this
// pod sees locally so a room spread over two pods shows one roster.
const remotePresence = new Map<string, Map<string, Person[]>>();

function localPresence(key: string): Person[] {
  const seen = new Set<string>();
  const list: Person[] = [];
  for (const who of channelMembers.get(key)?.values() ?? []) {
    if (seen.has(who.handle)) continue;
    seen.add(who.handle);
    list.push({ handle: who.handle, name: who.name });
  }
  return list;
}

function sendPresence(key: string): void {
  const members = channelMembers.get(key);
  if (!members) return;
  const seen = new Set<string>();
  const list: Person[] = [];
  for (const p of [...localPresence(key), ...[...(remotePresence.get(key)?.values() ?? [])].flat()]) {
    if (seen.has(p.handle)) continue;
    seen.add(p.handle);
    list.push(p);
  }
  for (const [ws] of members) {
    for (const [id, sub] of ws.data.subs) {
      if (sub.kind === "channel" && sub.key === key) {
        ws.send(JSON.stringify({ op: "presence", id, members: list }));
      }
    }
  }
}

// Local membership changed: tell local subscribers and every peer pod.
function broadcastPresence(key: string): void {
  sendPresence(key);
  cluster.broadcast("presence", { key, members: localPresence(key) });
}

cluster.onBroadcast("presence", ({ key, members }: { key: string; members: Person[] }, from) => {
  if (!remotePresence.has(key)) remotePresence.set(key, new Map());
  if (members.length) remotePresence.get(key)!.set(from, members);
  else remotePresence.get(key)!.delete(from);
  sendPresence(key);
});

cluster.onPeerLost((pod) => {
  for (const [key, byPod] of remotePresence) {
    if (byPod.delete(pod)) sendPresence(key);
  }
});

// A channel message from a peer pod: fan out to this pod's members of that channel.
cluster.onBroadcast("pub", ({ key, msg }: { key: string; msg: Record<string, unknown> }) => {
  deliverPub(key, msg);
});

function deliverPub(key: string, base: Record<string, unknown>): void {
  const members = channelMembers.get(key);
  if (!members) return;
  for (const [peer] of members) {
    for (const [subId, sub] of peer.data.subs) {
      if (sub.kind === "channel" && sub.key === key) {
        peer.send(JSON.stringify({ ...base, id: subId }));
      }
    }
  }
}

function sendErr(ws: { send(data: string): void }, id: string | undefined, code: string, message: string): void {
  ws.send(JSON.stringify({ op: "error", id, error: { code, message } }));
}

// ── actors helpers ──

function hasKeys(o: Record<string, unknown> | undefined): boolean {
  return !!o && Object.keys(o).length > 0;
}

// The actors sub ids a given socket holds for this room (a socket can hold more
// than one, though games use one) — used to stamp the right `id` on each frame.
function actorSubIds(ws: ActorSink, key: string): string[] {
  const ids: string[] = [];
  for (const [subId, sub] of ws.data.subs) {
    if (sub.kind === "actors" && sub.key === key) ids.push(subId);
  }
  return ids;
}

// Send `ws` the current state of every OTHER member in `zone` — the last-value
// snapshot a joiner (or zone-switcher) gets so it sees the world immediately.
function sendActorSnapshot(ws: ActorSink, key: string, subId: string, zone: string, selfCid: string): void {
  const room = actorRooms.get(key);
  if (!room) return;
  const actors = [];
  for (const e of room.members.values()) {
    if (e.cid === selfCid || e.zone !== zone || e.observer) continue; // observers are invisible
    if (e.state === undefined && !hasKeys(e.meta)) continue; // nothing to show yet
    const a: Record<string, unknown> = { id: e.cid, handle: e.who.handle, name: e.who.name };
    if (e.state !== undefined) a.state = e.state;
    if (hasKeys(e.meta)) a.meta = e.meta;
    actors.push(a);
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
    if (e.observer || (!e.stateDirty && !e.metaDirty)) continue; // observers emit nothing
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
      const u: Record<string, unknown> = { id: e.cid, handle: e.who.handle, name: e.who.name };
      if (e.stateDirty && e.state !== undefined) u.state = e.state; // only the parts that changed
      if (e.metaDirty) u.meta = e.meta;
      if (u.state === undefined && u.meta === undefined) continue;
      updates.push(u);
    }
    if (updates.length === 0) continue;
    for (const subId of actorSubIds(recipient.ws, key)) {
      recipient.ws.send(JSON.stringify({ op: "actors", id: subId, updates }));
    }
  }
  for (const e of room.members.values()) { e.stateDirty = false; e.metaDirty = false; }
}

function ensureActorTimer(key: string): void {
  const room = actorRooms.get(key);
  if (!room || room.timer) return;
  room.timer = setInterval(() => flushActorRoom(key), 1000 / room.rate);
}

// Remove a member and stop the room's flush timer once it empties.
function dropActor(ws: ActorSink, key: string, cid: string): void {
  const room = actorRooms.get(key);
  if (!room) return;
  const e = room.members.get(cid);
  if (!e || e.ws !== ws) return; // observers ARE dropped on disconnect — just not announced
  const wasObserver = e.observer;
  room.members.delete(cid);
  if (!wasObserver) notifyZoneLeave(key, e.zone, cid); // peers never saw an observer
  if (room.members.size === 0) {
    if (room.timer) clearInterval(room.timer);
    actorRooms.delete(key);
    void cluster.release(`actors:${key}`);
  }
}

// ── actors across pods ──
// An actors room lives on one pod (a lease keyed `actors:<site>/<channel>`). A member whose
// socket is on another pod is relayed: its pod forwards the member's frames to the owner and
// hands the owner's frames back to the socket. On the owner the member is an ActorEntry like
// any other, with a stand-in sink instead of a socket.

class RemoteActorSink implements ActorSink {
  readonly readyState = 1;
  data: ActorSink["data"];
  constructor(readonly pod: string, readonly key: string, readonly cid: string, subId: string, site: string, who: Identity) {
    this.data = { site, who, subs: new Map([[subId, { kind: "actors", key, cid }]]) };
  }
  send(raw: string): void {
    cluster.push(this.pod, "actor.out", { key: this.key, cid: this.cid, raw });
  }
}

const remoteMembers = new Map<string, RemoteActorSink>(); // `${pod}|${key}|${cid}` on the owner
const relayed = new Map<string, { ws: WS; subId: string }>(); // `${key}|${cid}` on the relaying pod

function remoteFor(ws: WS, key: string, cid: string): string | null {
  for (const sub of ws.data.subs.values()) {
    if (sub.kind === "actors" && sub.key === key && sub.cid === cid) return sub.remote ?? null;
  }
  return null;
}

// Join on this pod's own room.
function joinLocal(ws: ActorSink, id: string, key: string, cid: string, join: ActorJoin): void {
  let room = actorRooms.get(key);
  if (!room) {
    // The first subscriber fixes the flush rate (clamped) — a later fast joiner
    // can't push the room past the cap.
    room = { members: new Map(), rate: join.rate, timer: null };
    actorRooms.set(key, room);
  }
  // cid comes from the client, so without this an entry could be taken over: the
  // victim's own set/ameta/aevent stop matching (wrong socket) and their disconnect
  // refuses to clean up, leaving the stolen actor in the zone after they're gone.
  // A still-open holder blocks the claim; a dead one doesn't, because a reconnecting
  // tab re-subscribes with the same cid and may beat its own close event here.
  const held = room.members.get(cid);
  if (held && held.ws !== ws && held.ws.readyState === 1) {
    ws.data.subs.delete(id);
    sendErr(ws, id, "conflict", `actor id "${cid}" is already in use`);
    return;
  }
  const meta = join.observer ? {} : join.meta;
  room.members.set(cid, { ws, cid, who: ws.data.who, zone: join.zone, state: undefined, meta, stateDirty: false, metaDirty: hasKeys(meta), observer: join.observer });
  ensureActorTimer(key);
  ws.send(JSON.stringify({ op: "ack", id }));
  sendActorSnapshot(ws, key, id, join.zone, cid); // instant last-value snapshot of the zone
}

async function joinActors(ws: WS, id: string, key: string, cid: string, join: ActorJoin): Promise<void> {
  let owner: string;
  try {
    owner = await cluster.acquire(`actors:${key}`);
  } catch (e) {
    const err = asWorldsError(e);
    sendErr(ws, id, err.code, err.message);
    return;
  }
  if (owner === cluster.podId) {
    ws.data.subs.set(id, { kind: "actors", key, cid, join });
    joinLocal(ws, id, key, cid, join);
    return;
  }
  ws.data.subs.set(id, { kind: "actors", key, cid, join, remote: owner });
  relayed.set(`${key}|${cid}`, { ws, subId: id });
  cluster.push(owner, "actor.join", { key, cid, subId: id, site: ws.data.site, who: ws.data.who, join });
}

function leaveActors(ws: WS, sub: SubEntry): void {
  if (!sub.cid) return;
  if (sub.remote) {
    relayed.delete(`${sub.key}|${sub.cid}`);
    cluster.push(sub.remote, "actor.leave", { key: sub.key, cid: sub.cid });
    return;
  }
  dropActor(ws, sub.key, sub.cid);
}

// Owner side.
cluster.onPush("actor.join", (p: { key: string; cid: string; subId: string; site: string; who: Identity; join: ActorJoin }, from) => {
  if (!cluster.isOwner(`actors:${p.key}`)) {
    cluster.push(from, "actor.rehome", { key: p.key, cid: p.cid });
    return;
  }
  const sink = new RemoteActorSink(from, p.key, p.cid, p.subId, p.site, p.who);
  remoteMembers.set(`${from}|${p.key}|${p.cid}`, sink);
  joinLocal(sink, p.subId, p.key, p.cid, p.join);
});
cluster.onPush("actor.set", (p: { key: string; cid: string; frame: Record<string, unknown> }, from) => {
  const sink = remoteMembers.get(`${from}|${p.key}|${p.cid}`);
  if (sink) handleSet(sink, p.frame);
});
cluster.onPush("actor.meta", (p: { key: string; cid: string; frame: Record<string, unknown> }, from) => {
  const sink = remoteMembers.get(`${from}|${p.key}|${p.cid}`);
  if (sink) handleSetMeta(sink, p.frame);
});
cluster.onPush("actor.event", (p: { key: string; cid: string; frame: Record<string, unknown> }, from) => {
  const sink = remoteMembers.get(`${from}|${p.key}|${p.cid}`);
  if (sink) handleActorEvent(sink, p.frame);
});
cluster.onPush("actor.leave", (p: { key: string; cid: string }, from) => {
  const sink = remoteMembers.get(`${from}|${p.key}|${p.cid}`);
  if (!sink) return;
  remoteMembers.delete(`${from}|${p.key}|${p.cid}`);
  dropActor(sink, p.key, p.cid);
});

// Relay side.
cluster.onPush("actor.out", (p: { key: string; cid: string; raw: string }) => {
  relayed.get(`${p.key}|${p.cid}`)?.ws.send(p.raw);
});
cluster.onPush("actor.rehome", (p: { key: string; cid: string }) => {
  const r = relayed.get(`${p.key}|${p.cid}`);
  if (r) void rejoinActors(r.ws, r.subId);
});

// The room's pod is gone: run ownership again once its lease has expired and join wherever
// the room lands (possibly here). Peers see the member again on its next `set`.
async function rejoinActors(ws: WS, subId: string, attempt = 0): Promise<void> {
  const sub = ws.data.subs.get(subId);
  if (!sub || sub.kind !== "actors" || !sub.cid || !sub.join) return;
  if (ws.readyState !== 1) return;
  const dead = sub.remote;
  let owner: string;
  try {
    owner = await cluster.acquire(`actors:${sub.key}`);
  } catch {
    owner = dead ?? "";
  }
  if (dead && owner === dead) {
    if (attempt < 60) setTimeout(() => void rejoinActors(ws, subId, attempt + 1), 500);
    return;
  }
  relayed.delete(`${sub.key}|${sub.cid}`);
  await joinActors(ws, subId, sub.key, sub.cid, sub.join);
}

cluster.onPeerLost((pod) => {
  for (const [k, sink] of remoteMembers) {
    if (!k.startsWith(`${pod}|`)) continue;
    remoteMembers.delete(k);
    dropActor(sink, sink.key, sink.cid);
  }
  for (const [, r] of relayed) {
    const sub = r.ws.data.subs.get(r.subId);
    if (sub?.remote === pod) void rejoinActors(r.ws, r.subId);
  }
});

// We lost the lease while alive: the room here is no longer authoritative. Every member —
// local sockets and relayed ones — rejoins wherever the room now lives.
cluster.onLeaseLost((leaseKey) => {
  if (!leaseKey.startsWith("actors:")) return;
  const key = leaseKey.slice("actors:".length);
  const room = actorRooms.get(key);
  if (!room) return;
  if (room.timer) clearInterval(room.timer);
  actorRooms.delete(key);
  for (const e of room.members.values()) {
    if (e.ws instanceof RemoteActorSink) {
      remoteMembers.delete(`${e.ws.pod}|${key}|${e.cid}`);
      cluster.push(e.ws.pod, "actor.rehome", { key, cid: e.cid });
    } else {
      for (const subId of actorSubIds(e.ws, key)) void rejoinActors(e.ws as WS, subId);
    }
  }
});

async function handleSub(ws: WS, id: string, frame: Record<string, unknown>): Promise<void> {
  if (ws.data.subs.size >= MAX_SUBS_PER_SOCKET && !ws.data.subs.has(id)) {
    sendErr(ws, id, "invalid_request", `too many subscriptions (max ${MAX_SUBS_PER_SOCKET})`);
    return;
  }
  // Re-using an id replaces the subscription, so retire the old one first: overwriting
  // the entry alone would leave this socket in the previous scope's registry — a ghost
  // in that channel's presence, and a second db scope quietly stealing its events.
  if (ws.data.subs.has(id)) handleUnsub(ws, id);
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
    const channel = String(frame.channel ?? "");
    const key = presenceKey(ws.data.site, channel);
    const cid = typeof frame.cid === "string" && frame.cid ? frame.cid : id;
    const observer = frame.observer === true;
    const join: ActorJoin = {
      channel,
      zone: typeof frame.zone === "string" ? frame.zone : "",
      rate: Math.max(1, Math.min(MAX_ACTOR_RATE, Number(frame.rate) || 15)),
      meta: !observer && frame.meta && typeof frame.meta === "object" ? (frame.meta as Record<string, unknown>) : {},
      observer,
    };
    await joinActors(ws, id, key, cid, join);
    return;
  }
  if (frame.kind === "doc") {
    if (!dbReady()) {
      sendErr(ws, id, "maintenance", "database unavailable");
      return;
    }
    const name = String(frame.doc ?? "");
    // A reconnecting client names where it left off; only that epoch's tail is missing.
    const epoch = Number(frame.epoch);
    const since = typeof frame.since === "string" && frame.since ? Number(frame.since) : NaN;
    // Registered before the room is opened: a client replays its subscription and then its
    // queued edits back-to-back, and opening the room can take seconds while it re-homes —
    // an update arriving in that window must find its subscription, not be refused.
    const client: DocClient = { send: (f) => ws.send(JSON.stringify(f)) };
    ws.data.subs.set(id, { kind: "doc", key: `${ws.data.site}/${name}`, doc: name, client });
    let room: DocRoomLike;
    try {
      room = await getRoom(ws.data.site, name);
    } catch (e) {
      ws.data.subs.delete(id);
      const err = asWorldsError(e);
      sendErr(ws, id, err.code, err.message);
      return;
    }
    try {
      await room.subscribe(client, id);
      const tail = Number.isFinite(epoch) && Number.isFinite(since) ? await room.updatesSince(epoch, since) : null;
      if (tail) {
        ws.send(JSON.stringify({ op: "doc_ack", id, seq: room.seq, epoch: room.epoch, resumed: true }));
        for (const u of tail) ws.send(JSON.stringify({ op: "doc_update", id, seq: room.seq, update: b64(u) }));
      } else {
        ws.send(JSON.stringify(await room.stateFrame("doc_state", id)));
      }
    } catch (e) {
      ws.data.subs.delete(id);
      room.unsubscribe(client);
      const err = asWorldsError(e);
      sendErr(ws, id, err.code, err.message);
    }
    return;
  }
  sendErr(ws, id, "invalid_request", "kind must be db, channel, actors or doc");
}

// `doc_update` carries one Yjs update against the epoch the client holds. The room
// answers with `doc_ack` (committed), `doc_rejected` (failed validation; carries the
// current state), or `doc_reset` (stale epoch; carries the current state).
async function handleDocUpdate(ws: WS, id: string, frame: Record<string, unknown>): Promise<void> {
  const sub = ws.data.subs.get(id);
  if (!sub || sub.kind !== "doc" || !sub.doc || !sub.client) {
    sendErr(ws, id, "invalid_request", "doc_update needs an open doc subscription id");
    return;
  }
  let update: Uint8Array;
  try {
    update = fromB64(frame.update);
  } catch (e) {
    const err = asWorldsError(e);
    sendErr(ws, id, err.code, err.message);
    return;
  }
  let room: DocRoomLike;
  try {
    room = await getRoom(ws.data.site, sub.doc);
    await room.submit(ws.data.who, Number(frame.epoch), update, sub.client, id);
  } catch (e) {
    const err = asWorldsError(e);
    if (err.code === "conflict" && room!) {
      ws.send(JSON.stringify(await room.stateFrame("doc_reset", id, { reason: "stale epoch" })));
      return;
    }
    // Validation failures were already answered with doc_rejected by the room.
    if (err.code !== "invalid_request") sendErr(ws, id, err.code, err.message);
  }
}

// `set` updates the caller's own last-value state (and zone). No ack — it runs at
// frame rate; the coalescing flush delivers it. A zone change leaves the old zone
// (peers get actors_leave) and snapshots the new one back to the mover.
function handleSet(ws: ActorSink, frame: Record<string, unknown>): void {
  const cid = typeof frame.cid === "string" ? frame.cid : null;
  if (!cid) return;
  if (JSON.stringify(frame.state ?? null).length > LIMITS.wsPayloadBytes) {
    sendErr(ws, undefined, "payload_too_large", "actor state over 16KB");
    return;
  }
  const key = presenceKey(ws.data.site, String(frame.channel ?? ""));
  if (relayFrame(ws, key, cid, "actor.set", frame)) return;
  const room = actorRooms.get(key);
  if (!room) return; // not subscribed (or a stale race) — ignore
  const e = room.members.get(cid);
  if (!e || e.ws !== ws || e.observer) return; // your own entry only; observers are read-only
  const newZone = typeof frame.zone === "string" ? frame.zone : e.zone;
  e.state = frame.state;
  if (newZone !== e.zone) {
    const oldZone = e.zone;
    e.zone = newZone;
    notifyZoneLeave(key, oldZone, cid); // old zone drops me
    for (const subId of actorSubIds(ws, key)) sendActorSnapshot(ws, key, subId, newZone, cid);
  }
  e.stateDirty = true; // delivered to the (new) zone on the next flush
}

// `ameta` shallow-merges a metadata patch — infrequent per-member fields (team,
// level, status) kept apart from the frame-rate `state` so they don't resync every tick.
function handleSetMeta(ws: ActorSink, frame: Record<string, unknown>): void {
  const cid = typeof frame.cid === "string" ? frame.cid : null;
  if (!cid) return;
  const patch = frame.meta && typeof frame.meta === "object" ? (frame.meta as Record<string, unknown>) : null;
  if (!patch) return;
  if (JSON.stringify(patch).length > LIMITS.wsPayloadBytes) {
    sendErr(ws, undefined, "payload_too_large", "actor metadata over 16KB");
    return;
  }
  const key = presenceKey(ws.data.site, String(frame.channel ?? ""));
  if (relayFrame(ws, key, cid, "actor.meta", frame)) return;
  const room = actorRooms.get(key);
  const e = room && room.members.get(cid);
  if (!e || e.ws !== ws || e.observer) return;
  e.meta = { ...e.meta, ...patch };
  e.metaDirty = true;
}

// `aevent` is a discrete one-off event (a horn, a hit, a ping) — fanned out to
// in-zone peers immediately (no coalescing, no storage). The flexible-payload tier
// on top of last-value state, so games stop pairing actors with a second channel.
function handleActorEvent(ws: ActorSink, frame: Record<string, unknown>): void {
  const cid = typeof frame.cid === "string" ? frame.cid : null;
  if (!cid) return;
  if (JSON.stringify(frame.payload ?? null).length > LIMITS.wsPayloadBytes) {
    sendErr(ws, undefined, "payload_too_large", "actor event over 16KB");
    return;
  }
  if (!allowFanout(ws)) {
    sendErr(ws, undefined, "rate_limited", `actor events are capped at ${FANOUT_PER_SEC}/s`);
    return;
  }
  const key = presenceKey(ws.data.site, String(frame.channel ?? ""));
  if (relayFrame(ws, key, cid, "actor.event", frame)) return;
  const room = actorRooms.get(key);
  const e = room && room.members.get(cid);
  if (!e || e.ws !== ws || e.observer) return;
  const from = { id: cid, handle: e.who.handle, name: e.who.name };
  for (const peer of room.members.values()) {
    if (peer.cid === cid || peer.zone !== e.zone) continue;
    for (const subId of actorSubIds(peer.ws, key)) {
      peer.ws.send(JSON.stringify({ op: "actor_event", id: subId, from, payload: frame.payload }));
    }
  }
}

// A member whose room is on another pod: forward the frame there instead of handling it.
function relayFrame(ws: ActorSink, key: string, cid: string, kind: string, frame: Record<string, unknown>): boolean {
  if (ws instanceof RemoteActorSink) return false; // already on the owner, arrived by relay
  const remote = remoteFor(ws as WS, key, cid);
  if (!remote) return false;
  cluster.push(remote, kind, { key, cid, frame });
  return true;
}

// Leave a document without opening it: only a room already in the registry needs to hear it.
function leaveDoc(site: string, name: string, client: DocClient): void {
  void peekRoom(site, name)?.then((room) => room.unsubscribe(client)).catch(() => {});
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
  if (sub?.kind === "actors") leaveActors(ws, sub);
  if (sub?.kind === "doc" && sub.doc && sub.client) leaveDoc(ws.data.site, sub.doc, sub.client);
}

function handlePub(ws: WS, id: string, frame: Record<string, unknown>): void {
  const payload = frame.payload;
  if (JSON.stringify(payload ?? null).length > LIMITS.wsPayloadBytes) {
    sendErr(ws, id, "payload_too_large", "ws payload over 16KB");
    return;
  }
  if (!allowFanout(ws)) {
    sendErr(ws, id, "rate_limited", `channel publishes are capped at ${FANOUT_PER_SEC}/s`);
    return;
  }
  const key = presenceKey(ws.data.site, String(frame.channel ?? ""));
  const base = {
    op: "msg",
    payload,
    from: { handle: ws.data.who.handle, name: ws.data.who.name },
    at: new Date().toISOString(),
  };
  deliverPub(key, base);
  cluster.broadcast("pub", { key, msg: base });
  ws.send(JSON.stringify({ op: "ack", id }));
}

export const websocket = {
  open(ws: WS): void {
    if (ws.data.proxy) {
      pipeUpstream(ws.data.proxy, ws);
      return;
    }
    if (ws.data.peer) {
      cluster.attachInbound(ws.data.peer, { send: (d) => ws.send(d), close: () => ws.close() });
      return;
    }
    ensureChangeFeed();
  },

  async message(ws: WS, raw: string | Buffer): Promise<void> {
    if (ws.data.proxy) {
      sendUpstream(ws.data.proxy, raw);
      return;
    }
    if (ws.data.peer) {
      cluster.inboundMessage(ws.data.peer, raw);
      return;
    }
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
    if (frame.op === "ameta") return handleSetMeta(ws, frame);
    if (frame.op === "aevent") return handleActorEvent(ws, frame);
    if (frame.op === "doc_update") return handleDocUpdate(ws, id, frame);
    // Unknown ops are ignored (forward-compat rule).
  },

  close(ws: WS, code: number, reason: string): void {
    if (ws.data.proxy) {
      closeUpstream(ws.data.proxy, code, reason);
      return;
    }
    if (ws.data.peer) {
      cluster.inboundClosed(ws.data.peer);
      return;
    }
    const touched = new Set<string>();
    for (const sub of ws.data.subs.values()) {
      if (sub.kind === "db") dropFromScope(dbSubs, sub.key, ws);
      if (sub.kind === "channel") {
        dropFromScope(channelMembers, sub.key, ws);
        touched.add(sub.key);
      }
      if (sub.kind === "actors") leaveActors(ws, sub);
      if (sub.kind === "doc" && sub.doc && sub.client) leaveDoc(ws.data.site, sub.doc, sub.client);
    }
    for (const key of touched) broadcastPresence(key);
  },
};
