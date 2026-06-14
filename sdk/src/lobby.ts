import { ws } from "./channels";
import { call } from "./http";

// worlds.lobby(channel, opts) — batteries-included multiplayer waiting room.
//
// Every multiplayer game needs the same fiddly bits: a live roster, a stable
// host, ready toggles, "start when everyone's ready", and a clean return to the
// lobby afterwards. Getting presence timing right is the part everyone gets
// wrong — the roster here ALWAYS includes the caller, even before the server has
// echoed their own presence back, so host election never flickers and a fresh
// joiner is never mistaken for "everybody left".
//
// State is ephemeral (rides the ws channel; nothing persisted). Games that need
// authoritative state (boards, scores) keep using worlds.db; the lobby only owns
// the pre-game handshake and the lobby<->game transition signal.

export interface LobbyMember {
  handle: string;
  name: string;
  ready: boolean;
  isMe: boolean;
  isHost: boolean;
}

export interface LobbySnapshot {
  me: { handle: string; name: string } | null;
  members: LobbyMember[];
  host: { handle: string; name: string } | null;
  isHost: boolean;
  ready: boolean; // is the caller ready
  readyCount: number;
  total: number;
  allReady: boolean;
  started: boolean;
  loaded: boolean; // presence has reported at least once
}

export interface LobbyOptions {
  me?: { handle: string; name: string };
  autoStart?: boolean; // host auto-starts once everyone is ready (default true)
  minPlayers?: number; // smallest roster that may start (default 1)
  onUpdate?: (s: LobbySnapshot) => void;
  onStart?: (s: LobbySnapshot) => void; // fired on every client when the game starts
  onReturn?: (s: LobbySnapshot) => void; // fired on every client when sent back to lobby
}

type Person = { handle: string; name: string };

export interface Lobby {
  setReady(val: boolean): void;
  toggleReady(): void;
  start(): void;
  returnToLobby(): void;
  setStarted(val: boolean): void;
  snapshot(): LobbySnapshot;
  readonly me: Person | null;
  readonly isHost: boolean;
  destroy(): void;
}

export function lobby(channel: string, opts: LobbyOptions = {}): Lobby {
  const room = ws.channel(channel);
  const cid =
    (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
      ? globalThis.crypto.randomUUID()
      : `c${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const autoStart = opts.autoStart !== false;
  const minPlayers = Math.max(1, opts.minPlayers ?? 1);

  let me: Person | null = opts.me ? { handle: opts.me.handle, name: opts.me.name || opts.me.handle } : null;
  let presence: Person[] = [];
  let loaded = false;
  let started = false;
  let dead = false;
  const ready: Record<string, boolean> = {};

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
  function snapshot(): LobbySnapshot {
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
      started,
      loaded,
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
    if (!dead) opts.onUpdate?.(snapshot());
  }
  function pub(msg: Record<string, unknown>): void {
    room.publish({ _lobby: 1, cid, ...msg });
  }
  function maybeAutoStart(): void {
    if (autoStart && isHost() && !started && allReady()) start();
  }

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

  const unsubPresence = room.presence((members) => {
    presence = uniq(members || []);
    const live = new Set(roster().map((p) => p.handle));
    for (const h of Object.keys(ready)) if (!live.has(h)) delete ready[h];
    loaded = true;
    emit();
    maybeAutoStart();
  });
  const unsubMsg = room.subscribe((msg: any) => {
    const p = msg && msg.payload;
    if (!p || !p._lobby || p.cid === cid) return;
    if (p.t === "ready" && p.handle) {
      ready[p.handle] = !!p.ready;
      emit();
      maybeAutoStart();
    } else if (p.t === "start") {
      if (!started) {
        started = true;
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

  if (me) {
    announce();
  } else {
    call("GET", "/api/v1/me")
      .then((m: any) => {
        if (dead) return;
        me = { handle: m.handle, name: m.name || m.handle };
        announce();
      })
      .catch(() => {});
  }

  return {
    setReady,
    toggleReady,
    start,
    returnToLobby,
    setStarted,
    snapshot,
    get me() {
      return me;
    },
    get isHost() {
      return isHost();
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
