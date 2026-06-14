import { collection } from "./db";

// worlds.room(name) — ONE shared, authoritative document for a whole site, kept
// live for everyone. It's the multiplayer-game / shared-state pattern that every
// turn-based or single-board app re-implements by hand: load-or-create a single
// doc, subscribe to it, and write with a monotonic guard so out-of-order/stale
// updates never clobber newer state. Ordering is handled for you via a hidden
// `_rev` counter — you just describe state transitions.
//
// For lobby/ready handshakes use worlds.lobby; for ephemeral per-frame data use
// worlds.ws. Use worlds.room when there's a single source of truth that must
// survive reloads (a board, a quiz, a round).

type Initial<T> = T | (() => T);

export interface RoomOptions<T> {
  key?: string; // logical key stored on the doc; defaults to `${name}-main`
  initial?: Initial<T>; // seed used to create the doc when none exists yet
}

export interface Room<T> {
  ready: Promise<T>;
  get(): T | null;
  onChange(fn: (state: T) => void): () => void; // fires on load + every change (incl. own writes)
  set(next: T): Promise<boolean>; // full replace, monotonic
  merge(patch: Partial<T>): Promise<boolean>; // shallow-merge onto current, then write
  reset(next?: Partial<T>): Promise<boolean>; // back to initial (+ optional overrides)
  refetch(): Promise<void>;
}

export function room<T extends Record<string, any> = any>(name: string, opts: RoomOptions<T> = {}): Room<T> {
  const col = collection(name);
  const key = opts.key || `${name}-main`;
  let docId: string | null = null;
  let state: any = null;
  let rev = 0;
  const listeners = new Set<(s: T) => void>();

  function seed(): any {
    const init = typeof opts.initial === "function" ? (opts.initial as () => T)() : opts.initial ?? {};
    return { ...init };
  }
  function emit(): void {
    for (const fn of listeners) {
      try {
        fn(state);
      } catch {}
    }
  }
  // Monotonic adopt: never regress to a lower _rev (drops stale/out-of-order
  // writes) unless it's the confirmation of our own write.
  function adopt(doc: any, own: boolean): void {
    if (!doc || !doc.data) return;
    const incoming = doc.data;
    if (incoming._room !== key && doc.id !== docId) return;
    if (!own && state && (incoming._rev || 0) < rev) return;
    docId = doc.id;
    state = incoming;
    rev = incoming._rev || 0;
    emit();
  }

  async function load(): Promise<T> {
    const page = await col.list({ sort: "-created_at", limit: 100 });
    const found = page.items.find((d: any) => d.data && d.data._room === key);
    if (found) {
      docId = found.id;
      state = found.data;
      rev = state._rev || 0;
    } else {
      const created = await col.create({ ...seed(), _room: key, _rev: 0 });
      docId = created.id;
      state = created.data;
      rev = 0;
    }
    col.subscribe((ev: any) => {
      if (!ev || !ev.doc) return;
      const d = ev.doc;
      if (d.id === docId || (d.data && d.data._room === key)) {
        if (ev.type === "delete") {
          state = { ...seed(), _room: key, _rev: rev };
          emit();
          return;
        }
        adopt(d, false);
      }
    });
    emit();
    return state;
  }

  const ready = load();

  async function write(next: any): Promise<boolean> {
    if (!docId) {
      try {
        await ready;
      } catch {}
    }
    if (!docId) return false;
    const payload = { ...next, _room: key, _rev: rev + 1 };
    try {
      const res = await col.replace(docId, payload);
      adopt(res, true);
      return true;
    } catch {
      return false;
    }
  }

  return {
    ready,
    get: () => state,
    onChange(fn) {
      listeners.add(fn);
      if (state) {
        try {
          fn(state);
        } catch {}
      }
      return () => listeners.delete(fn);
    },
    set: (next) => write(next),
    merge: (patch) => write({ ...(state || {}), ...patch }),
    reset: (next) => write({ ...seed(), ...(next || {}) }),
    refetch: async () => {
      try {
        if (docId) adopt(await col.get(docId), true);
      } catch {}
    },
  };
}
