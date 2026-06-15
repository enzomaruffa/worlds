import { sock } from "./socket";
import { id as tabId } from "./util";

// worlds.actors(name, opts) — the realtime tier for per-member LIVE STATE (poses,
// cursors, ship positions), beside `ws.channel` (ephemeral events) and `room` (one
// authoritative doc). Each member publishes ONE last-value state with `set`; the
// server keeps it, fans it out only to same-zone peers, and flushes batched at a
// fixed rate. You get O(N·zone) instead of O(N²), an instant snapshot on join, and
// no need to hand-roll adaptive send-rates or dead-reckoning plumbing.
//
//   const net = worlds.actors("race", { zoneKey: s => s.cell, rate: 15 });
//   net.set({ x, y, z, cell });                 // your state (zone derived via zoneKey)
//   net.onChange((id, state, meta) => draw(id, state));  // a peer in your zone updated
//   net.onLeave(id => remove(id));              // a peer left your zone / disconnected
//   net.others();                              // [{ id, handle, name, state }] in your zone

export interface ActorsOptions<T = any> {
  // Derive the interest zone from a member's state. Same zone → see each other.
  // Spatial (a grid cell) bounds how many peers you sync regardless of crowd size.
  zoneKey?: (state: T) => string | number;
  zone?: string | number; // a fixed zone, if you don't vary it per-state
  rate?: number; // server flush Hz, 1..20 (default 15) — set by the first member
}

export interface ActorRecord<T = any> {
  id: string; // the peer's stable per-tab id
  handle: string;
  name: string;
  state: T;
}

export interface Actors<T = any> {
  set(state: T): void;
  others(): ActorRecord<T>[];
  onChange(fn: (id: string, state: T, meta: ActorRecord<T>) => void): () => void;
  onLeave(fn: (id: string) => void): () => void;
  stop(): void;
}

export function actors<T = any>(name: string, opts: ActorsOptions<T> = {}): Actors<T> {
  const cid = tabId();
  const states = new Map<string, ActorRecord<T>>();
  const changeFns = new Set<(id: string, state: T, meta: ActorRecord<T>) => void>();
  const leaveFns = new Set<(id: string) => void>();
  let zone = opts.zone != null ? String(opts.zone) : "";
  let stopped = false;

  function emitChange(rec: ActorRecord<T>): void {
    for (const fn of changeFns) try { fn(rec.id, rec.state, rec); } catch { /* listener threw */ }
  }
  function emitLeave(peer: string): void {
    for (const fn of leaveFns) try { fn(peer); } catch { /* listener threw */ }
  }

  // Apply incremental updates (a flush batch, or a snapshot's contents).
  function ingest(list: any[]): void {
    if (!Array.isArray(list)) return;
    for (const a of list) {
      if (!a || typeof a.id !== "string" || a.id === cid) continue;
      const rec: ActorRecord<T> = { id: a.id, handle: a.handle || a.id, name: a.name || a.handle || a.id, state: a.state };
      states.set(rec.id, rec);
      emitChange(rec);
    }
  }

  const stopSub = sock.subscribe(
    { op: "sub", kind: "actors", channel: name, zone, cid, rate: opts.rate },
    () => { /* actors deliver via onSnapshot/onActors/onActorLeave, not the plain handler */ },
    {
      // A snapshot is the authoritative in-zone set (sent on join AND on zone switch),
      // so anyone missing from it is no longer our concern — drop them.
      onSnapshot: (list: any[]) => {
        const keep = new Set((list || []).map((a) => a && a.id).filter(Boolean));
        for (const peer of [...states.keys()]) if (!keep.has(peer)) { states.delete(peer); emitLeave(peer); }
        ingest(list);
      },
      onActors: (list: any[]) => ingest(list),
      onActorLeave: (ids: string[]) => {
        if (!Array.isArray(ids)) return;
        for (const peer of ids) if (states.delete(peer)) emitLeave(peer);
      },
    },
  );

  return {
    set(state: T): void {
      if (stopped) return;
      if (opts.zoneKey) zone = String(opts.zoneKey(state));
      // Stable frame id "set": the server keys by `cid`, doesn't ack, and this runs
      // at frame rate — no point burning a fresh id per tick.
      sock.send({ op: "set", id: "set", channel: name, cid, state, zone });
    },
    others: () => [...states.values()],
    onChange(fn) { changeFns.add(fn); return () => changeFns.delete(fn); },
    onLeave(fn) { leaveFns.add(fn); return () => leaveFns.delete(fn); },
    stop() {
      stopped = true;
      try { stopSub(); } catch { /* socket may be gone */ }
      states.clear(); changeFns.clear(); leaveFns.clear();
    },
  };
}
