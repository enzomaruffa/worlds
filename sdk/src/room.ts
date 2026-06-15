import { ws } from "./channels";
import { collection } from "./db";
import { call } from "./http";

// worlds.room(name) — ONE named shared space for everyone on a site. It rolls the
// two things every multiplayer/collab app re-implements into a single primitive:
//
//   • the roster — a live list of who's here, a stable host, ready toggles, and a
//     clean "start the game" / "back to the lobby" handshake. The roster ALWAYS
//     includes you, even before the server echoes your own presence back, so the
//     host never flickers and a fresh joiner is never mistaken for "everyone left".
//   • the state — if you pass `initial`, the room also carries ONE authoritative
//     document (a board, a quiz, a round) that's load-or-created, kept live, and
//     guarded against out-of-order writes via a hidden `_rev`.
//
// A "waiting room" is just `worlds.room(name)` with no `initial`. A board game is
// `worlds.room(name, { initial })`. Many concurrent rooms (a lobby browser with
// join codes) is the plural — `worlds.rooms(name)` — which hands you one of these.
//
// Roster rides a ws channel (ephemeral); state rides a db collection (persisted).
// For raw per-frame data (cursors, poses) drop down to worlds.ws; for many loose
// documents (polls, posts) use worlds.db.

export interface RoomMember {
  handle: string;
  name: string;
  ready: boolean;
  isMe: boolean;
  isHost: boolean;
}

export interface RoomSnapshot<T = any> {
  me: { handle: string; name: string } | null;
  members: RoomMember[];
  host: { handle: string; name: string } | null;
  isHost: boolean;
  ready: boolean; // is the caller ready
  readyCount: number;
  total: number;
  allReady: boolean;
  full: boolean; // total >= maxPlayers (false when maxPlayers is unset)
  started: boolean;
  loaded: boolean; // presence has reported at least once
  state: T | null; // authoritative shared doc, or null when no `initial` was given
}

type Initial<T> = T | (() => T);

export interface RoomOptions<T = any> {
  me?: { handle: string; name: string };
  minPlayers?: number; // smallest roster that may start (default 1)
  maxPlayers?: number; // roster cap used for `full` (default 0 = unlimited)
  autoStart?: boolean; // host auto-starts once everyone is ready (default true)
  initial?: Initial<T>; // when set, the room also carries authoritative state
  key?: string; // logical doc key in the collection (default `${name}-main`)
  channel?: string; // ws presence/protocol channel (default `name`); advanced
  onChange?: (s: RoomSnapshot<T>) => void; // roster OR state changed
  onStart?: (s: RoomSnapshot<T>) => void; // fired on every client when the game starts
  onReturn?: (s: RoomSnapshot<T>) => void; // fired on every client on return-to-lobby
}

type Person = { handle: string; name: string };

export interface Room<T = any> {
  opened: Promise<RoomSnapshot<T>>;
  // roster
  setReady(val: boolean): void;
  toggleReady(): void;
  start(): void;
  returnToLobby(): void;
  setStarted(val: boolean): void;
  // state (no-ops when the room has no `initial`)
  set(next: T): Promise<boolean>;
  merge(patch: Partial<T>): Promise<boolean>;
  reset(overrides?: Partial<T>): Promise<boolean>;
  refetch(): Promise<void>;
  // read
  snapshot(): RoomSnapshot<T>;
  onChange(fn: (s: RoomSnapshot<T>) => void): () => void;
  readonly me: Person | null;
  readonly isHost: boolean;
  readonly members: RoomMember[];
  readonly state: T | null;
  // lifecycle
  leave(): void; // alias for destroy()
  destroy(): void;
}

export function room<T extends Record<string, any> = any>(name: string, opts: RoomOptions<T> = {}): Room<T> {
  const chan = ws.channel(opts.channel || name);
  const hasState = opts.initial !== undefined;
  const col = hasState ? collection(name) : null;
  const key = opts.key || `${name}-main`;
  const cid =
    (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
      ? globalThis.crypto.randomUUID()
      : `c${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const autoStart = opts.autoStart !== false;
  const minPlayers = Math.max(1, opts.minPlayers ?? 1);
  const maxPlayers = Math.max(0, opts.maxPlayers ?? 0);

  let me: Person | null = opts.me ? { handle: opts.me.handle, name: opts.me.name || opts.me.handle } : null;
  let presence: Person[] = [];
  let loaded = false;
  let started = false;
  let dead = false;
  const ready: Record<string, boolean> = {};

  // Authoritative state (only when `initial` was given).
  let docId: string | null = null;
  let state: any = hasState ? null : null;
  let rev = 0;

  const listeners = new Set<(s: RoomSnapshot<T>) => void>();
  if (opts.onChange) listeners.add(opts.onChange);

  function seed(): any {
    const init = typeof opts.initial === "function" ? (opts.initial as () => T)() : opts.initial ?? {};
    return { ...init };
  }

  function uniq(list: any[]): Person[] {
    const seen = new Set<string>();
    const out: Person[] = [];
    for (const m of list || []) {
      if (m && m.handle && !seen.has(m.handle)) {
        seen.add(m.handle);
        out.push({ handle: m.handle, name: m.name || m.handle });
      }
    }
    return out;
  }
  // The whole point: self is always in the roster, presence echo or not.
  function roster(): Person[] {
    return uniq([...(me ? [me] : []), ...presence]);
  }
  function hostHandle(): string | null {
    const r = roster().map((p) => p.handle).sort();
    return r.length ? r[0]! : null;
  }
  function isHost(): boolean {
    return !!me && hostHandle() === me.handle;
  }
  function readyCount(): number {
    return roster().filter((p) => ready[p.handle]).length;
  }
  function allReady(): boolean {
    const r = roster();
    return r.length >= minPlayers && r.every((p) => ready[p.handle]);
  }
  function snapshot(): RoomSnapshot<T> {
    const r = roster();
    const host = hostHandle();
    return {
      me,
      host: host ? r.find((p) => p.handle === host) ?? null : null,
      isHost: isHost(),
      ready: !!(me && ready[me.handle]),
      readyCount: readyCount(),
      total: r.length,
      allReady: allReady(),
      full: maxPlayers > 0 && r.length >= maxPlayers,
      started,
      loaded,
      state: hasState ? state : null,
      members: r.map((p) => ({
        handle: p.handle,
        name: p.name,
        ready: !!ready[p.handle],
        isMe: !!(me && p.handle === me.handle),
        isHost: p.handle === host,
      })),
    };
  }
  function emit(): void {
    if (dead) return;
    const s = snapshot();
    for (const fn of listeners) {
      try {
        fn(s);
      } catch {}
    }
  }
  function pub(msg: Record<string, unknown>): void {
    chan.publish({ _p: 1, cid, ...msg });
  }
  function maybeAutoStart(): void {
    if (autoStart && isHost() && !started && allReady()) start();
  }

  // ---- roster actions ----
  function setReady(val: boolean): void {
    if (!me) return;
    ready[me.handle] = !!val;
    pub({ t: "ready", handle: me.handle, name: me.name, ready: !!val });
    emit();
    maybeAutoStart();
  }
  function toggleReady(): void {
    setReady(!(me && ready[me.handle]));
  }
  function start(): void {
    if (!isHost() || started) return;
    if (roster().length < minPlayers) return;
    started = true;
    pub({ t: "start", handle: me!.handle });
    emit();
    opts.onStart?.(snapshot());
  }
  function returnToLobby(): void {
    started = false;
    for (const k of Object.keys(ready)) ready[k] = false;
    pub({ t: "return", handle: me?.handle });
    emit();
    opts.onReturn?.(snapshot());
  }
  function setStarted(val: boolean): void {
    started = !!val;
  }

  // ---- authoritative state (db doc) ----
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
  async function loadState(): Promise<void> {
    if (!col) return;
    const page = await col.list({ filter: { _room: key }, sort: "-created_at", limit: 1 });
    const found = page.items[0];
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
  }
  async function write(next: any): Promise<boolean> {
    if (!col) return false;
    if (!docId) {
      try {
        await opened;
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

  // ---- wire ws presence + protocol ----
  const unsubPresence = chan.presence((members) => {
    presence = uniq(members || []);
    const live = new Set(roster().map((p) => p.handle));
    for (const h of Object.keys(ready)) if (!live.has(h)) delete ready[h];
    loaded = true;
    emit();
    maybeAutoStart();
  });
  const unsubMsg = chan.subscribe((msg: any) => {
    const p = msg && msg.payload;
    if (!p || !p._p || p.cid === cid) return;
    if (p.t === "ready" && p.handle) {
      ready[p.handle] = !!p.ready;
      emit();
      maybeAutoStart();
    } else if (p.t === "start") {
      if (!started) {
        started = true;
        emit();
        opts.onStart?.(snapshot());
      }
    } else if (p.t === "return") {
      started = false;
      for (const k of Object.keys(ready)) ready[k] = false;
      emit();
      opts.onReturn?.(snapshot());
    } else if (p.t === "hello" && p.handle) {
      if (me) pub({ t: "ready", handle: me.handle, name: me.name, ready: !!ready[me.handle] });
    }
  });

  function announce(): void {
    if (!me) return;
    if (!(me.handle in ready)) ready[me.handle] = false;
    pub({ t: "hello", handle: me.handle, name: me.name });
    emit();
    maybeAutoStart();
  }

  // Resolve identity, seed state, announce — then `opened` settles with the first
  // full snapshot so callers can `await room.opened` before reading state/roster.
  const opened: Promise<RoomSnapshot<T>> = (async () => {
    if (!me) {
      try {
        const m: any = await call("GET", "/api/v1/me");
        if (!dead) me = { handle: m.handle, name: m.name || m.handle };
      } catch {}
    }
    if (hasState) {
      try {
        await loadState();
      } catch {}
    }
    if (!dead) announce();
    return snapshot();
  })();

  return {
    opened,
    setReady,
    toggleReady,
    start,
    returnToLobby,
    setStarted,
    set: (next) => write(next),
    merge: (patch) => write({ ...(state || {}), ...patch }),
    reset: (overrides) => write({ ...seed(), ...(overrides || {}) }),
    refetch: async () => {
      try {
        if (col && docId) adopt(await col.get(docId), true);
      } catch {}
    },
    snapshot,
    onChange(fn) {
      listeners.add(fn);
      if (loaded || (hasState && state)) {
        try {
          fn(snapshot());
        } catch {}
      }
      return () => listeners.delete(fn);
    },
    get me() {
      return me;
    },
    get isHost() {
      return isHost();
    },
    get members() {
      return snapshot().members;
    },
    get state() {
      return hasState ? state : null;
    },
    leave() {
      this.destroy();
    },
    destroy() {
      dead = true;
      try {
        unsubPresence?.();
      } catch {}
      try {
        unsubMsg?.();
      } catch {}
    },
  };
}
