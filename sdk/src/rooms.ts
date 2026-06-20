import { collection } from "./db";
import { WorldsError } from "./error";
import { room } from "./room";
import type { Room, RoomSnapshot } from "./room";

// worlds.rooms(name) — the plural of worlds.room: a live directory of many
// concurrent rooms on one site (a lobby browser with private join codes). Each
// `create`/`join`/`joinByCode` hands back a normal worlds.room, scoped to its own
// instance. Use this when a site needs more than one match at a time — many chess
// tables, several quiz sessions, private party rooms — instead of the single
// shared room a bare worlds.room(name) gives you.
//
// Storage rides the same primitives: one db collection (`name`) holds a small
// directory doc per open room (`_dir:1`) alongside each room's own state doc
// (`_room:"inst:<id>"`), and every instance gets an isolated presence channel
// (`name:<id>`). The instance host mirrors its roster into the directory doc and
// heartbeats it; rooms whose host goes quiet for `ttlMs` are swept.

export interface RoomInfo {
  id: string;
  code: string;
  name: string;
  host: { handle: string; name: string } | null;
  members: { handle: string; name: string }[];
  count: number;
  max: number; // 0 = unlimited
  status: "open" | "playing";
  full: boolean;
  private: boolean;
  createdAt: string;
  updatedAt: string;
}

type Initial<T> = T | (() => T);

export interface RoomsOptions<T = any> {
  minPlayers?: number;
  maxPlayers?: number; // per-room roster cap (0 = unlimited)
  autoStart?: boolean;
  initial?: Initial<T>; // when set, each room carries authoritative state
  ttlMs?: number; // sweep rooms whose host stopped heartbeating (default 45s)
  onList?: (rooms: RoomInfo[]) => void; // public room list changed (live)
  onChange?: (s: RoomSnapshot<T>) => void; // forwarded to the joined room
  onStart?: (s: RoomSnapshot<T>) => void;
  onReturn?: (s: RoomSnapshot<T>) => void;
}

export type JoinedRoom<T = any> = Room<T> & { id: string; code: string };

export interface Hall<T = any> {
  list(): RoomInfo[];
  onList(fn: (rooms: RoomInfo[]) => void): () => void;
  create(opts?: { name?: string; private?: boolean; max?: number }): Promise<JoinedRoom<T>>;
  join(id: string): Promise<JoinedRoom<T>>;
  joinByCode(code: string): Promise<JoinedRoom<T>>;
  leave(): Promise<void>;
  readonly current: JoinedRoom<T> | null;
  destroy(): void;
}

// Unambiguous code alphabet — no 0/O/1/I to keep codes easy to read out loud.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randInts(n: number): number[] {
  const out: number[] = [];
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    const buf = new Uint32Array(n);
    globalThis.crypto.getRandomValues(buf);
    for (let i = 0; i < n; i++) out.push(buf[i]!);
  } else {
    for (let i = 0; i < n; i++) out.push(Math.floor(Math.random() * 0xffffffff));
  }
  return out;
}
function makeCode(): string {
  return randInts(4).map((r) => CODE_ALPHABET[r % CODE_ALPHABET.length]).join("");
}
function makeId(): string {
  return randInts(3).map((r) => r.toString(36)).join("").slice(0, 10);
}

export function rooms<T extends Record<string, any> = any>(name: string, opts: RoomsOptions<T> = {}): Hall<T> {
  const dir = collection(name);
  const hasState = opts.initial !== undefined;
  const ttlMs = Math.max(5000, opts.ttlMs ?? 45000);

  const docs = new Map<string, any>(); // dbId -> registry doc envelope
  const listeners = new Set<(rooms: RoomInfo[]) => void>();
  let current: JoinedRoom<T> | null = null;
  let currentDbId: string | null = null;
  let stopMirror: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lastMirror = "";
  let dead = false;

  function toInfo(doc: any): RoomInfo {
    const d = doc.data || {};
    const max = Number(d.max || 0);
    const count = Number(d.count || (d.members ? d.members.length : 0));
    return {
      id: d.id,
      code: d.code,
      name: d.name || d.id,
      host: d.host || null,
      members: Array.isArray(d.members) ? d.members : [],
      count,
      max,
      status: d.status === "playing" ? "playing" : "open",
      full: max > 0 && count >= max,
      private: !!d.private,
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
    };
  }
  function fresh(doc: any): boolean {
    const t = Date.parse(doc.updated_at || doc.created_at || "");
    return !Number.isFinite(t) || Date.now() - t < ttlMs;
  }
  function computeList(): RoomInfo[] {
    const out: RoomInfo[] = [];
    for (const doc of docs.values()) {
      if (!doc.data || !doc.data._dir || doc.data.private) continue;
      if (!fresh(doc)) continue;
      out.push(toInfo(doc));
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return out;
  }
  function pushList(): void {
    if (dead) return;
    const list = computeList();
    for (const fn of listeners) {
      try {
        fn(list);
      } catch {}
    }
  }

  // Best-effort cleanup of rooms whose host went quiet. Idempotent — a delete that
  // races another client just returns deleted:false.
  async function sweep(): Promise<void> {
    for (const [dbId, doc] of [...docs.entries()]) {
      if (dbId === currentDbId) continue; // never GC the room we're in (host migration handles a dead host)
      if (doc.data && doc.data._dir && !fresh(doc)) {
        docs.delete(dbId);
        try {
          await dir.delete(dbId);
        } catch {}
        try {
          await deleteStateDoc(doc.data.id);
        } catch {}
      }
    }
  }

  async function deleteStateDoc(instId: string): Promise<void> {
    if (!hasState) return;
    try {
      const page = await dir.list({ filter: { _room: `inst:${instId}` }, limit: 1 });
      if (page.items[0]) await dir.delete(page.items[0].id);
    } catch {}
  }

  // ---- live registry feed ----
  const unsubDir = dir.subscribe((ev: any) => {
    if (!ev || !ev.doc) return;
    if (ev.type === "delete") {
      if (docs.delete(ev.doc.id)) pushList();
      return;
    }
    if (!ev.doc.data || !ev.doc.data._dir) return; // ignore instance state docs
    docs.set(ev.doc.id, ev.doc);
    pushList();
  });
  if (opts.onList) listeners.add(opts.onList);
  // Initial fill.
  (async () => {
    try {
      const page = await dir.list({ filter: { _dir: 1 }, sort: "-created_at", limit: 100 });
      for (const doc of page.items) docs.set(doc.id, doc);
      pushList();
    } catch {}
  })();
  const sweeper = setInterval(() => {
    void sweep().then(pushList);
  }, Math.min(ttlMs, 20000));

  // ---- joining / hosting ----
  function detach(): void {
    if (stopMirror) {
      try {
        stopMirror();
      } catch {}
      stopMirror = null;
    }
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (current) {
      try {
        current.destroy();
      } catch {}
    }
    current = null;
    currentDbId = null;
    lastMirror = "";
  }

  function open(id: string, code: string, dbId: string, max: number): JoinedRoom<T> {
    detach();
    const r = room<T>(name, {
      channel: `${name}:${id}`,
      key: `inst:${id}`,
      initial: hasState ? opts.initial : undefined,
      minPlayers: opts.minPlayers,
      maxPlayers: max || opts.maxPlayers,
      autoStart: opts.autoStart,
      onChange: opts.onChange,
      onStart: opts.onStart,
      onReturn: opts.onReturn,
    }) as JoinedRoom<T>;
    r.id = id;
    r.code = code;
    current = r;
    currentDbId = dbId;

    // The host owns the directory entry: it mirrors roster/status and heartbeats
    // updated_at so the room stays "alive" in everyone's list.
    function mirror(s: RoomSnapshot<T>): void {
      if (!s.isHost || currentDbId !== dbId) return;
      const patch = {
        host: s.host,
        members: s.members.map((m) => ({ handle: m.handle, name: m.name })),
        count: s.total,
        status: s.started ? "playing" : "open",
      };
      const sig = JSON.stringify(patch);
      if (sig === lastMirror) return;
      lastMirror = sig;
      dir.update(dbId, patch).catch(() => {});
    }
    stopMirror = r.onChange(mirror);
    heartbeat = setInterval(() => {
      const s = r.snapshot();
      if (s.isHost && currentDbId === dbId) {
        // bump updated_at so the room stays "alive" for browsers, and refresh our
        // own cache from the result so list freshness reflects the heartbeat.
        dir.update(dbId, { count: s.total }).then((updated) => { if (updated) docs.set(dbId, updated); pushList(); }).catch(() => {});
      }
    }, 15000);
    return r;
  }

  async function findByInstanceId(id: string): Promise<any | null> {
    for (const doc of docs.values()) if (doc.data && doc.data._dir && doc.data.id === id) return doc;
    try {
      const page = await dir.list({ filter: { _dir: 1, id }, limit: 1 });
      return page.items[0] || null;
    } catch {
      return null;
    }
  }

  return {
    list: () => computeList(),
    onList(fn) {
      listeners.add(fn);
      try {
        fn(computeList());
      } catch {}
      return () => listeners.delete(fn);
    },
    async create(o = {}) {
      const id = makeId();
      const used = new Set<string>();
      for (const doc of docs.values()) if (doc.data?.code) used.add(doc.data.code);
      let code = makeCode();
      for (let i = 0; i < 8 && used.has(code); i++) code = makeCode();
      const max = Math.max(0, o.max ?? opts.maxPlayers ?? 0);
      const data = {
        _dir: 1,
        id,
        code,
        name: o.name || `Room ${code}`,
        private: !!o.private,
        status: "open",
        host: null,
        members: [],
        count: 0,
        max,
      };
      const created = await dir.create(data);
      docs.set(created.id, created);
      pushList();
      return open(id, code, created.id, max);
    },
    async join(id) {
      const doc = await findByInstanceId(id);
      if (!doc) throw new WorldsError("not_found", "no such room", 404);
      const info = toInfo(doc);
      if (info.full) throw new WorldsError("conflict", "room is full", 409);
      return open(info.id, info.code, doc.id, info.max);
    },
    async joinByCode(code) {
      const want = String(code || "").toUpperCase().trim();
      let doc: any = null;
      for (const d of docs.values()) if (d.data && d.data._dir && d.data.code === want) doc = d;
      if (!doc) {
        try {
          const page = await dir.list({ filter: { _dir: 1, code: want }, limit: 1 });
          doc = page.items[0] || null;
        } catch {}
      }
      if (!doc) throw new WorldsError("not_found", "no room with that code", 404);
      const info = toInfo(doc);
      if (info.full) throw new WorldsError("conflict", "room is full", 409);
      return open(info.id, info.code, doc.id, info.max);
    },
    async leave() {
      const r = current;
      const dbId = currentDbId;
      if (!r || !dbId) return;
      const s = r.snapshot();
      const instId = r.id;
      detach();
      // Last one out (and we were the host) closes the room.
      if (s.isHost && s.total <= 1) {
        try {
          await dir.delete(dbId);
        } catch {}
        docs.delete(dbId);
        await deleteStateDoc(instId);
        pushList();
      }
    },
    get current() {
      return current;
    },
    destroy() {
      dead = true;
      detach();
      try {
        unsubDir?.();
      } catch {}
      clearInterval(sweeper);
      listeners.clear();
    },
  };
}
