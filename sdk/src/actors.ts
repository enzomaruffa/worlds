import { sock } from "./socket";
import { id as tabId } from "./util";

// worlds.actors(name, opts) — the realtime tier for per-member presence, beside
// `ws.channel` (ephemeral broadcast) and `room` (one authoritative doc). Each
// member carries three flexible, generic payloads, all zone-routed by the server:
//   • STATE   — last-value, frame-rate (`set`); coalesced + rate-capped, snapshot on join
//   • METADATA— infrequent fields (team, level, status) kept apart from frame state
//   • EVENTS  — discrete one-off messages (a horn, a hit, a ping) via `send`/`onEvent`
// Together that's the whole multiplayer surface for "who's near me and what are they
// doing", so you stop pairing actors with a second ws.channel for events.
//
//   const net = worlds.actors("race", { zoneKey: s => s.cell, rate: 15, metadata: { team: "a" } });
//   net.set({ x, y, cell });                       // frame state
//   net.setMetadata({ level: 6 });                 // infrequent metadata
//   net.send({ t: "horn" });                       // one-off event to in-zone peers
//   net.onChange((id, state, peer) => draw(peer)); // peer.state + peer.metadata
//   net.onEvent((id, payload, from) => honk(id));  // a peer's discrete event
//   net.onLeave(id => remove(id));
//   net.others();  net.destroy();

export interface ActorsOptions<T = any> {
  zoneKey?: (state: T) => string | number; // interest zone from state (spatial → bounded sync)
  zone?: string | number; // a fixed zone if you don't vary it per-state
  rate?: number; // server flush Hz, 1..20 (default 15) — set by the first member
  metadata?: Record<string, any>; // initial per-member metadata
  observer?: boolean; // watch a zone read-only — invisible to peers (set/send become no-ops)
}

export interface ActorRecord<T = any> {
  id: string; // the peer's stable per-tab id
  handle: string;
  name: string;
  state: T; // may be undefined until the peer's first set
  metadata: Record<string, any>;
}

export interface ActorFrom {
  id: string;
  handle: string;
  name: string;
}

export interface Actors<T = any> {
  set(state: T): void;
  setMetadata(patch: Record<string, any>): void;
  send(payload: any): void;
  others(): ActorRecord<T>[];
  onChange(fn: (id: string, state: T, peer: ActorRecord<T>) => void): () => void;
  onEvent(fn: (id: string, payload: any, from: ActorFrom) => void): () => void;
  onLeave(fn: (id: string) => void): () => void;
  destroy(): void;
}

export function actors<T = any>(name: string, opts: ActorsOptions<T> = {}): Actors<T> {
  const cid = tabId();
  const states = new Map<string, ActorRecord<T>>();
  const changeFns = new Set<(id: string, state: T, peer: ActorRecord<T>) => void>();
  const eventFns = new Set<(id: string, payload: any, from: ActorFrom) => void>();
  const leaveFns = new Set<(id: string) => void>();
  let zone = opts.zone != null ? String(opts.zone) : "";
  let stopped = false;

  function emitChange(rec: ActorRecord<T>): void {
    for (const fn of changeFns) try { fn(rec.id, rec.state, rec); } catch { /* listener threw */ }
  }
  function emitLeave(peer: string): void {
    for (const fn of leaveFns) try { fn(peer); } catch { /* listener threw */ }
  }
  function emitEvent(from: ActorFrom, payload: any): void {
    for (const fn of eventFns) try { fn(from.id, payload, from); } catch { /* listener threw */ }
  }

  // Apply a list of snapshot/flush entries; each may carry state and/or a meta delta.
  function ingest(list: any[]): void {
    if (!Array.isArray(list)) return;
    for (const a of list) {
      if (!a || typeof a.id !== "string" || a.id === cid) continue;
      let rec = states.get(a.id);
      if (!rec) rec = { id: a.id, handle: a.handle || a.id, name: a.handle || a.id, state: undefined as any, metadata: {} };
      if (a.handle) rec.handle = a.handle;
      if (a.name) rec.name = a.name;
      if (a.state !== undefined) rec.state = a.state;
      if (a.meta) rec.metadata = { ...rec.metadata, ...a.meta };
      states.set(a.id, rec);
      emitChange(rec);
    }
  }

  const stopSub = sock.subscribe(
    { op: "sub", kind: "actors", channel: name, zone, cid, rate: opts.rate, meta: opts.metadata, observer: opts.observer },
    () => { /* actors deliver via the on* hooks below, not the plain handler */ },
    {
      // A snapshot is the authoritative in-zone set (on join AND on zone switch), so
      // anyone missing from it is no longer our concern — drop them.
      onSnapshot: (list: any[]) => {
        const keep = new Set((list || []).map((a) => a && a.id).filter(Boolean));
        for (const peer of [...states.keys()]) if (!keep.has(peer)) { states.delete(peer); emitLeave(peer); }
        ingest(list);
      },
      onActors: (list: any[]) => ingest(list),
      onActorEvent: (from: ActorFrom, payload: any) => { if (from && from.id !== cid) emitEvent(from, payload); },
      onActorLeave: (ids: string[]) => {
        if (!Array.isArray(ids)) return;
        for (const peer of ids) if (states.delete(peer)) emitLeave(peer);
      },
    },
  );

  return {
    set(state: T): void {
      if (stopped || opts.observer) return; // observers are read-only
      if (opts.zoneKey) zone = String(opts.zoneKey(state));
      sock.send({ op: "set", id: "set", channel: name, cid, state, zone });
    },
    setMetadata(patch: Record<string, any>): void {
      if (stopped || opts.observer || !patch) return;
      sock.send({ op: "ameta", id: "ameta", channel: name, cid, meta: patch });
    },
    send(payload: any): void {
      if (stopped || opts.observer) return;
      sock.send({ op: "aevent", id: "aevent", channel: name, cid, payload });
    },
    others: () => [...states.values()],
    onChange(fn) { changeFns.add(fn); return () => changeFns.delete(fn); },
    onEvent(fn) { eventFns.add(fn); return () => eventFns.delete(fn); },
    onLeave(fn) { leaveFns.add(fn); return () => leaveFns.delete(fn); },
    destroy() {
      stopped = true;
      try { stopSub(); } catch { /* socket may be gone */ }
      states.clear(); changeFns.clear(); eventFns.clear(); leaveFns.clear();
    },
  };
}
