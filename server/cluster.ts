import { hostname } from "node:os";
import { config } from "./config";
import { sql, dbReady, onLocalChange, dispatchRemoteChange, type ChangeEvent } from "./db";
import { isSqlite } from "./dialect";
import { WorldsError } from "./errors";

// Running more than one pod. Every in-process registry (db subscribers, channel members,
// document rooms) only knows its own sockets, so pods talk to each other over a small
// mesh of WebSocket links: pods register themselves in the `pods` table with a heartbeat,
// each pair keeps one link (the lexicographically smaller id dials, the other accepts —
// so a pair never ends up with two links and duplicate deliveries), and everything that
// has to reach every pod is broadcast over them. Things that must have exactly one home
// (a document's authoritative Y.Doc) take a lease in `room_leases`; the other pods forward
// to the owner over its link.
//
// Bun's SQL client has no LISTEN, which is why this is links rather than NOTIFY. With
// SQLite (one process by construction) or without WORLDS_PEER_URL the whole module is a
// no-op and every call answers as if this pod were the only one.

export const podId: string = process.env.WORLDS_POD_ID || hostname();
export const enabled: boolean = !isSqlite && !!config.peerUrl;

// How often a pod re-registers and looks for new peers; also how long joining takes.
const HEARTBEAT_MS = Math.max(200, Number(process.env.WORLDS_HEARTBEAT_MS ?? 5_000));
const POD_TTL_MS = Math.max(HEARTBEAT_MS * 3, 15_000);
const REQUEST_TIMEOUT_MS = 10_000;
export const LEASE_TTL_MS = Math.max(1_000, Number(process.env.WORLDS_LEASE_TTL_MS ?? 15_000));

type Frame =
  | { t: "bcast"; kind: string; payload: unknown }
  | { t: "push"; kind: string; payload: unknown }
  | { t: "req"; id: string; kind: string; payload: unknown }
  | { t: "res"; id: string; ok: true; payload: unknown }
  | { t: "res"; id: string; ok: false; error: { code: string; message: string; extra?: Record<string, unknown> } };

interface Link {
  pod: string;
  send(frame: Frame): void;
  close(): void;
}

type Handler = (payload: any, from: string) => void;
type RequestHandler = (payload: any, from: string) => Promise<unknown> | unknown;

const links = new Map<string, Link>();
const broadcastHandlers = new Map<string, Set<Handler>>();
const pushHandlers = new Map<string, Set<Handler>>();
const requestHandlers = new Map<string, RequestHandler>();
const peerLost = new Set<(pod: string) => void>();
const leaseLost = new Set<(key: string) => void>();
const pending = new Map<string, { pod: string; resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout> }>();
const owned = new Set<string>();
let nextRequest = 1;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let renew: ReturnType<typeof setInterval> | null = null;
let stopped = false;

export function onBroadcast(kind: string, fn: Handler): void {
  if (!broadcastHandlers.has(kind)) broadcastHandlers.set(kind, new Set());
  broadcastHandlers.get(kind)!.add(fn);
}

export function onPush(kind: string, fn: Handler): void {
  if (!pushHandlers.has(kind)) pushHandlers.set(kind, new Set());
  pushHandlers.get(kind)!.add(fn);
}

export function onRequest(kind: string, fn: RequestHandler): void {
  requestHandlers.set(kind, fn);
}

export function onPeerLost(fn: (pod: string) => void): void {
  peerLost.add(fn);
}

export function onLeaseLost(fn: (key: string) => void): void {
  leaseLost.add(fn);
}

export function peers(): string[] {
  return [...links.keys()];
}

export function broadcast(kind: string, payload: unknown): void {
  if (!enabled) return;
  const frame: Frame = { t: "bcast", kind, payload };
  for (const link of links.values()) link.send(frame);
}

export function push(pod: string, kind: string, payload: unknown): void {
  links.get(pod)?.send({ t: "push", kind, payload });
}

export function request<T = unknown>(pod: string, kind: string, payload: unknown): Promise<T> {
  const link = links.get(pod);
  if (!link) return Promise.reject(new WorldsError("maintenance", `no link to pod ${pod}`));
  const id = `${podId}:${nextRequest++}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new WorldsError("maintenance", `pod ${pod} did not answer ${kind}`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { pod, resolve: resolve as (v: unknown) => void, reject, timer });
    link.send({ t: "req", id, kind, payload });
  });
}

async function handleFrame(from: string, raw: string): Promise<void> {
  let frame: Frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  if (frame.t === "bcast") {
    for (const fn of broadcastHandlers.get(frame.kind) ?? []) fn(frame.payload, from);
  } else if (frame.t === "push") {
    for (const fn of pushHandlers.get(frame.kind) ?? []) fn(frame.payload, from);
  } else if (frame.t === "req") {
    const link = links.get(from);
    const handler = requestHandlers.get(frame.kind);
    if (!link) return;
    if (!handler) {
      link.send({ t: "res", id: frame.id, ok: false, error: { code: "not_found", message: `no handler for ${frame.kind}` } });
      return;
    }
    try {
      link.send({ t: "res", id: frame.id, ok: true, payload: await handler(frame.payload, from) });
    } catch (e) {
      const err = e instanceof WorldsError ? e : new WorldsError("internal", (e as Error).message);
      link.send({ t: "res", id: frame.id, ok: false, error: { code: err.code, message: err.message, extra: err.extra } });
    }
  } else if (frame.t === "res") {
    const p = pending.get(frame.id);
    if (!p) return;
    pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.ok) p.resolve(frame.payload);
    else p.reject(new WorldsError(frame.error.code as never, frame.error.message, undefined, frame.error.extra));
  }
}

function dropLink(pod: string, link: Link): void {
  if (links.get(pod) !== link) return;
  links.delete(pod);
  // Requests are addressed to one pod; the ones in flight to this one can't complete.
  for (const [id, p] of pending) {
    if (p.pod !== pod) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(new WorldsError("maintenance", `pod ${pod} went away`));
  }
  for (const fn of peerLost) fn(pod);
}

// Inbound side: a peer dialed us. The socket layer hands the raw socket in and routes
// its frames here.
export interface PeerSocket {
  send(data: string): void;
  close(): void;
}

export function attachInbound(pod: string, socket: PeerSocket): void {
  const link: Link = { pod, send: (f) => socket.send(JSON.stringify(f)), close: () => socket.close() };
  links.get(pod)?.close();
  links.set(pod, link);
}

export function inboundMessage(pod: string, raw: string | Buffer): void {
  void handleFrame(pod, String(raw));
}

export function inboundClosed(pod: string): void {
  const link = links.get(pod);
  if (link) dropLink(pod, link);
}

// Outbound side: we dial pods with a bigger id than ours.
function dial(pod: string, url: string): void {
  if (links.has(pod) || stopped) return;
  const target = `${url.replace(/^http/, "ws")}/internal/peer`;
  const ws = new WebSocket(target, {
    headers: { "x-worlds-cluster-secret": config.clusterSecret ?? "", "x-worlds-pod": podId },
  } as never);
  const link: Link = { pod, send: (f) => ws.send(JSON.stringify(f)), close: () => ws.close() };
  const queue: Frame[] = [];
  link.send = (f) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
    else queue.push(f);
  };
  links.set(pod, link);
  ws.onopen = () => {
    for (const f of queue.splice(0)) ws.send(JSON.stringify(f));
  };
  ws.onmessage = (ev) => void handleFrame(pod, String(ev.data));
  ws.onclose = () => dropLink(pod, link);
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  };
}

async function tick(): Promise<void> {
  if (!dbReady() || stopped) return;
  try {
    await sql`
      INSERT INTO pods (id, url, last_seen) VALUES (${podId}, ${config.peerUrl}, now())
      ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, last_seen = now()`;
    const rows = await sql`
      SELECT id, url FROM pods
      WHERE id <> ${podId} AND last_seen > now() - (${POD_TTL_MS} * interval '1 millisecond')`;
    for (const r of rows as { id: string; url: string }[]) {
      if (podId < r.id && !links.has(r.id)) dial(r.id, r.url);
    }
  } catch (e) {
    console.warn(`cluster: heartbeat failed (${(e as Error).message})`);
  }
}

// ---- leases: exactly one pod hosts a given room ----

// Returns the pod that owns `key` after this call: us if the lease was free (or already
// ours), otherwise the current holder.
export async function acquire(key: string): Promise<string> {
  if (!enabled) return podId;
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await sql`
      INSERT INTO room_leases (key, owner, expires_at)
      VALUES (${key}, ${podId}, now() + (${LEASE_TTL_MS} * interval '1 millisecond'))
      ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
      WHERE room_leases.expires_at < now() OR room_leases.owner = EXCLUDED.owner
      RETURNING owner`;
    if (rows.length) {
      owned.add(key);
      return podId;
    }
    const [cur] = await sql`SELECT owner FROM room_leases WHERE key = ${key} AND expires_at >= now()`;
    if (cur) return String(cur.owner);
    // Expired between the two statements: try again.
  }
  throw new WorldsError("maintenance", `could not settle ownership of ${key}`);
}

export async function release(key: string): Promise<void> {
  if (!owned.delete(key) || !enabled) return;
  try {
    await sql`DELETE FROM room_leases WHERE key = ${key} AND owner = ${podId}`;
  } catch {
    /* the lease expires on its own */
  }
}

export function isOwner(key: string): boolean {
  return !enabled || owned.has(key);
}

async function renewLeases(): Promise<void> {
  if (!owned.size || !dbReady() || stopped) return;
  const keys = [...owned];
  // One statement for every owned key. The list travels as a single text parameter split in SQL:
  // Bun.sql has no array parameters, and a jsonb parameter is re-encoded as a JSON string.
  try {
    const rows = await sql`
      UPDATE room_leases SET expires_at = now() + (${LEASE_TTL_MS} * interval '1 millisecond')
      WHERE key = ANY(string_to_array(${keys.join("\u0001")}, chr(1))) AND owner = ${podId}
      RETURNING key`;
    const kept = new Set((rows as { key: string }[]).map((r) => r.key));
    for (const key of keys) {
      if (kept.has(key)) continue;
      owned.delete(key);
      for (const fn of leaseLost) fn(key);
    }
  } catch (e) {
    console.warn(`cluster: lease renewal failed (${(e as Error).message})`);
  }
}

let started = false;

// Idempotent: called once the database is ready, and again from the reconnect hook.
export async function start(): Promise<void> {
  if (!enabled || started) return;
  if (!config.clusterSecret) throw new Error("WORLDS_CLUSTER_SECRET must be set when WORLDS_PEER_URL is");
  started = true;
  onLocalChange((ev: ChangeEvent) => broadcast("db", ev));
  onBroadcast("db", (ev: ChangeEvent) => dispatchRemoteChange(ev));
  await tick();
  heartbeat = setInterval(() => void tick(), HEARTBEAT_MS);
  heartbeat.unref?.();
  renew = setInterval(() => void renewLeases(), Math.max(500, Math.floor(LEASE_TTL_MS / 3)));
  renew.unref?.();
  console.log(`cluster: pod ${podId} at ${config.peerUrl}`);
}

export async function stop(): Promise<void> {
  if (!enabled) return;
  stopped = true;
  if (heartbeat) clearInterval(heartbeat);
  if (renew) clearInterval(renew);
  try {
    await sql`DELETE FROM room_leases WHERE owner = ${podId}`;
    await sql`DELETE FROM pods WHERE id = ${podId}`;
  } catch {
    /* rows expire on their own */
  }
  owned.clear();
  for (const link of links.values()) link.close();
  links.clear();
}
