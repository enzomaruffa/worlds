<!-- GENERATED from sdk/src, server/ and spec/ by `bun run build:docs`. Do not edit by hand. -->
# worlds.js — generated reference

The complete public surface of the SDK, printed from the source that ships with this server, so it can never be newer or older than the `/worlds.js` you load. Declarations are verbatim TypeScript; the prose is the comment block above each one. For the narrative guide see `sdk.md`; for the HTTP shapes behind the SDK see the tables at the end.

## The `worlds` global

```ts
worlds.WorldsError: typeof WorldsError
// {name, url} of the site this page is — populated once `worlds.ready` resolves.
worlds.site.name: string | null
worlds.site.url: string | null
worlds.me: () => Promise<any>
worlds.db.collection: <T = any>(name: string, otherSite?: string) => Collection<T>
worlds.db.collections: () => Promise<{ items: { name: string; docs: number; }[]; next_cursor: string | null; }>
// Same shape as worlds.db itself, so a cross-world read is the same code with a
// different prefix — writes on the returned collection reject as read-only.
worlds.db.site: (name: string) => { collection: (c: string) => Collection<any>; collections: () => Promise<{ items: { name: string; docs: number; }[]; next_cursor: string | null; }>; }
worlds.ai.complete: (promptOrOpts: string | CompleteOpts) => Promise<Completion>
worlds.ai.embed: (text: string) => Promise<any>
worlds.ai.image: (prompt: string, opts?: ImageOpts) => Promise<any>
worlds.ai.models: () => Promise<any>
worlds.uploads.put: (file: Blob, opts?: { name?: string; }) => Promise<any>
worlds.uploads.list: () => Promise<any>
worlds.uploads.delete: (name: string) => Promise<any>
worlds.ws.channel: <T = any>(name: string) => Channel<T>
worlds.notify.slack: (target: string, text: string) => Promise<any>
worlds.room: <T extends Record<string, any> = any>(name: string, opts?: RoomOptions<T>) => Room<T>
worlds.rooms: <T extends Record<string, any> = any>(name: string, opts?: RoomsOptions<T>) => Hall<T>
worlds.actors: <T = any>(name: string, opts?: ActorsOptions<T>) => Actors<T>
worlds.idle: (key?: string, opts?: IdleOptions) => Idle
// batteries: small building blocks every multiplayer/collab site needs
worlds.id: () => string
worlds.colorFor: (seed: string) => string
worlds.uniqByHandle: (list: any[]) => { handle: string; name: string; }[]
worlds.esc: (s: any) => string
worlds.countdown: (endsAt: number, opts: { onTick: (msLeft: number) => void; onEnd?: (() => void); interval?: number; }) => Countdown
worlds.toast: (text: string, ms?: number) => void
// Resolve this site's context once; sites can `await worlds.ready`.
worlds.ready: Promise<any>
```

## worlds.db — database

Source: `sdk/src/db.ts`

### `interface ListOpts`

```ts
export interface ListOpts {
  filter?: Record<string, unknown>;
  sort?: string;
  limit?: number;
  cursor?: string;
}
```

### `interface UpdateOpts`

```ts
export interface UpdateOpts {
  ifUpdatedAt?: string; // the doc's `updated_at` you read — rejects with `conflict` if it moved
  /** @deprecated snake_case spelling of ifUpdatedAt, kept for v1 callers. */
  if_updated_at?: string;
}
```

### `interface Doc`

```ts
export interface Doc<T = any> {
  id: string;
  data: T;
  created_by: string;
  created_at: string;
  updated_at: string;
}
```

### `interface Page`

```ts
export interface Page<T = any> {
  items: Doc<T>[];
  next_cursor: string | null;
}
```

### `interface ChangeEvent`

```ts
export interface ChangeEvent<T = any> {
  type: "create" | "update" | "delete";
  doc: Doc<T>;
}
```

### `interface Collection`

```ts
export interface Collection<T = any> {
  create(data: T): Promise<Doc<T>>;
  get(id: string): Promise<Doc<T>>;
  update(id: string, patch: Partial<T>, opts?: UpdateOpts): Promise<Doc<T>>;
  replace(id: string, data: T): Promise<Doc<T>>;
  delete(id: string): Promise<{ deleted: boolean; id: string }>;
  increment(id: string, field: string, by?: number): Promise<Doc<T>>;
  list(opts?: ListOpts): Promise<Page<T>>;
  subscribe(handler: (ev: ChangeEvent<T>) => void): () => void;
}
```

### `collections()`

```ts
export function collections(
  otherSite?: string,
): Promise<{ items: { name: string; docs: number }[]; next_cursor: string | null }>
```

Collections a site has written to. Reads only, so it accepts a cross-world site.

### `collection()`

```ts
export function collection<T = any>(name: string, otherSite?: string): Collection<T>
```

otherSite (via worlds.db.site("x")) gives cross-world READ access; writes are
rejected and always stay with the calling site.

## worlds.ai — AI

Source: `sdk/src/ai.ts`

### `interface CompleteOpts`

```ts
export interface CompleteOpts {
  prompt?: string;
  messages?: { role: string; content: string }[];
  system?: string;
  model?: "fast" | "smart";
  max_tokens?: number;
  stream?: boolean;
  onToken?: (chunk: string) => void;
}
```

### `interface Usage`

```ts
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
```

### `interface Completion`

```ts
export interface Completion {
  text: string;
  model: string;
  usage: Usage;
}
```

### `interface ImageOpts`

```ts
export interface ImageOpts {
  size?: string;
  name?: string; // upload name for the generated file
}
```

### `ai`

```ts
ai.complete: (promptOrOpts: string | CompleteOpts) => Promise<Completion>
ai.embed: (text: string) => Promise<any>
ai.image: (prompt: string, opts?: ImageOpts) => Promise<any>
ai.models: () => Promise<any>
```

Models are stable aliases ("fast", "smart"); the server maps them to providers.

## worlds.uploads — file storage

Source: `sdk/src/uploads.ts`

### `uploads`

```ts
uploads.put: (file: Blob, opts?: { name?: string; }) => Promise<any>
uploads.list: () => Promise<any>
uploads.delete: (name: string) => Promise<any>
```

## worlds.ws — realtime channels

Source: `sdk/src/channels.ts`

### `interface ChannelMessage`

```ts
export interface ChannelMessage<T = any> {
  payload: T;
  from: Person;
  at: string;
}
```

### `interface Channel`

```ts
export interface Channel<T = any> {
  publish(payload: T): void; // fire-and-forget, unlike every other write in the SDK
  subscribe(handler: (msg: ChannelMessage<T>) => void): () => void;
  presence(handler: (members: Person[]) => void): () => void;
}
```

### `ws`

```ts
ws.channel: <T = any>(name: string) => Channel<T>
```

Named pub/sub channels for multiplayer/collab, multiplexed over the one socket.

## worlds.room — one shared room

Source: `sdk/src/room.ts`

worlds.room(name) — ONE named shared space for everyone on a site. It rolls the
two things every multiplayer/collab app re-implements into a single primitive:

- the roster — a live list of who's here, a stable host, ready toggles, and a clean "start the game" / "back to the lobby" handshake. The roster ALWAYS includes you, even before the server echoes your own presence back, so the host never flickers and a fresh joiner is never mistaken for "everyone left".
- the state — if you pass `initial`, the room also carries ONE authoritative document (a board, a quiz, a round) that's load-or-created, kept live, and guarded against out-of-order writes via a hidden `_rev`.

A "waiting room" is just `worlds.room(name)` with no `initial`. A board game is
`worlds.room(name, { initial })`. Many concurrent rooms (a lobby browser with
join codes) is the plural — `worlds.rooms(name)` — which hands you one of these.

Roster rides a ws channel (ephemeral); state rides a db collection (persisted).
For raw per-frame data (cursors, poses) drop down to worlds.ws; for many loose
documents (polls, posts) use worlds.db.

### `interface RoomMember`

```ts
export interface RoomMember extends Person {
  ready: boolean;
  isMe: boolean;
  isHost: boolean;
}
```

### `interface RoomSnapshot`

```ts
export interface RoomSnapshot<T = any> {
  me: Person | null;
  members: RoomMember[];
  host: Person | null;
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
```

### `interface RoomOptions`

```ts
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
```

### `interface Room`

```ts
export interface Room<T = any> {
  ready: Promise<RoomSnapshot<T>>;
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
  destroy(): void;
  leave(): void; // alias for destroy() — a single room is the thing you leave
  stop(): void; // alias for destroy()
}
```

### `room()`

```ts
export function room<T extends Record<string, any> = any>(name: string, opts: RoomOptions<T> = {}): Room<T>
```

## worlds.rooms — many rooms (lobby browser)

Source: `sdk/src/rooms.ts`

worlds.rooms(name) — the plural of worlds.room: a live directory of many
concurrent rooms on one site (a lobby browser with private join codes). Each
`create`/`join`/`joinByCode` hands back a normal worlds.room, scoped to its own
instance. Use this when a site needs more than one match at a time — many chess
tables, several quiz sessions, private party rooms — instead of the single
shared room a bare worlds.room(name) gives you.

Storage rides the same primitives: one db collection (`name`) holds a small
directory doc per open room (`_dir:1`) alongside each room's own state doc
(`_room:"inst:<id>"`), and every instance gets an isolated presence channel
(`name:<id>`). The instance host mirrors its roster into the directory doc and
heartbeats it; rooms whose host goes quiet for `ttlMs` are swept.

### `interface RoomInfo`

```ts
export interface RoomInfo {
  id: string;
  code: string;
  name: string;
  host: Person | null;
  members: Person[];
  count: number;
  max: number; // 0 = unlimited
  status: "open" | "playing";
  full: boolean;
  private: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### `interface RoomsOptions`

```ts
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
```

### `type JoinedRoom`

```ts
export type JoinedRoom<T = any> = Room<T> & { id: string; code: string };
```

### `interface Hall`

```ts
export interface Hall<T = any> {
  list(): RoomInfo[];
  onList(fn: (rooms: RoomInfo[]) => void): () => void;
  create(opts?: { name?: string; private?: boolean; max?: number }): Promise<JoinedRoom<T>>;
  join(id: string): Promise<JoinedRoom<T>>;
  joinByCode(code: string): Promise<JoinedRoom<T>>;
  // Leaves the joined room but keeps the directory live — NOT the teardown call.
  // (On a single `Room`, leave() *is* destroy(); a Hall outlives the rooms you join.)
  leave(): Promise<void>;
  readonly current: JoinedRoom<T> | null;
  destroy(): void;
  stop(): void; // alias for destroy()
}
```

### `rooms()`

```ts
export function rooms<T extends Record<string, any> = any>(name: string, opts: RoomsOptions<T> = {}): Hall<T>
```

## worlds.actors — zoned per-member presence

Source: `sdk/src/actors.ts`

worlds.actors(name, opts) — the realtime tier for per-member presence, beside
`ws.channel` (ephemeral broadcast) and `room` (one authoritative doc). Each
member carries three flexible, generic payloads, all zone-routed by the server:

- STATE   — last-value, frame-rate (`set`); coalesced + rate-capped, snapshot on join
- METADATA— infrequent fields (team, level, status) kept apart from frame state
- EVENTS  — discrete one-off messages (a horn, a hit, a ping) via `send`/`onEvent`

Together that's the whole multiplayer surface for "who's near me and what are they
doing", so you stop pairing actors with a second ws.channel for events.

```js
const net = worlds.actors("race", { zoneKey: s => s.cell, rate: 15, metadata: { team: "a" } });
net.set({ x, y, cell });                       // frame state
net.setMetadata({ level: 6 });                 // infrequent metadata
net.send({ t: "horn" });                       // one-off event to in-zone peers
net.onChange((id, state, peer) => draw(peer)); // peer.state + peer.metadata
net.onEvent((id, payload, from) => honk(id));  // a peer's discrete event
net.onLeave(id => remove(id));
net.others();  net.destroy();
```

### `interface ActorsOptions`

```ts
export interface ActorsOptions<T = any> {
  zoneKey?: (state: T) => string | number; // interest zone from state (spatial → bounded sync)
  zone?: string | number; // a fixed zone if you don't vary it per-state
  rate?: number; // server flush Hz, 1..20 (default 15) — set by the first member
  metadata?: Record<string, any>; // initial per-member metadata
  observer?: boolean; // watch a zone read-only — invisible to peers (set/send become no-ops)
}
```

### `interface ActorFrom`

```ts
export interface ActorFrom extends Person {
  id: string;
}
```

A peer's identity in an actors zone: who they are, plus the per-tab id that
distinguishes two tabs of the same person.

### `interface ActorRecord`

```ts
export interface ActorRecord<T = any> extends ActorFrom {
  state: T; // may be undefined until the peer's first set
  metadata: Record<string, any>;
}
```

### `interface Actors`

```ts
export interface Actors<T = any> {
  set(state: T): void;
  setMetadata(patch: Record<string, any>): void;
  send(payload: any): void;
  others(): ActorRecord<T>[];
  onChange(fn: (id: string, state: T, peer: ActorRecord<T>) => void): () => void;
  onEvent(fn: (id: string, payload: any, from: ActorFrom) => void): () => void;
  onLeave(fn: (id: string) => void): () => void;
  destroy(): void;
  stop(): void; // alias for destroy()
}
```

### `actors()`

```ts
export function actors<T = any>(name: string, opts: ActorsOptions<T> = {}): Actors<T>
```

## worlds.idle — offline progress

Source: `sdk/src/idle.ts`

worlds.idle(key, opts) — the offline/idle-progress battery. Every incremental
or tend-it game re-implements the same three things: remember when the player
was last here, credit the (capped) time they were away, and show a "while you
were away" summary. This rolls that into one primitive.

The SDK owns the GENERIC half — persisting `lastSeen`, computing capped elapsed
time, a heartbeat (auto on tab-hide / unload), and a self-contained summary
modal. The GAME owns the specific half — how its world advances over N seconds
— which it does itself after reading `elapsed()`, then passes a report object
to `summary()`.

```js
const idle = worlds.idle("my-game", { cap: 8 * 3600 });
const secs = await idle.elapsed();             // capped seconds away, or null
if (secs) { const report = advanceMyWorld(secs); idle.summary(report); }
idle.beat();                                   // also auto-beats on hide/unload
```

Persistence: store:"local" (default) keeps lastSeen in localStorage; "db" keeps
it in a per-player worlds.db doc; "none" means the caller owns `lastSeen` (pass
it in) — e.g. a game that already saves its own state + timestamp.

### `interface IdleOptions`

```ts
export interface IdleOptions {
  cap?: number;        // max credited offline seconds (default 8h)
  lastSeen?: number;   // caller-owned ms timestamp; when set, store defaults to "none"
  store?: "db" | "local" | "none";
  min?: number;        // ignore gaps under this many seconds (default 30)
}
```

### `interface IdleSummaryOptions`

```ts
export interface IdleSummaryOptions {
  title?: string;
  render?: (report: any) => string; // returns body HTML; default lists report entries
  onClose?: () => void;
}
```

### `interface Idle`

```ts
export interface Idle {
  elapsed(): Promise<number | null>; // capped seconds since last visit (null if first/too-short)
  beat(): void;                      // stamp lastSeen = now (no-op when the caller owns lastSeen)
  summary(report: any, opts?: IdleSummaryOptions): void;
  // Every SDK primitive tears down with destroy(); stop() is the same call.
  destroy(): void;
  stop(): void;
}
```

### `idle()`

```ts
export function idle(key = "default", opts: IdleOptions = {}): Idle
```

## worlds.notify — Slack

Source: `sdk/src/notify.ts`

### `notify`

```ts
notify.slack: (target: string, text: string) => Promise<any>
```

Sends are capped and stamped server-side with the site + sender. Notify, never impersonate.

## utilities — id, colorFor, uniqByHandle, esc, countdown

Source: `sdk/src/util.ts`

Small building blocks every multiplayer/collab site re-implements. Tiny on
their own, but they're copy-pasted into every app — so they live here once.

### `id()`

```ts
export function id(): string
```

A stable per-tab id. Attach as `cid` to ws messages to ignore your own echoes.

### `colorFor()`

```ts
export function colorFor(seed: string): string
```

Deterministic, pleasant color from any string (a handle, a name). Same input
→ same color everywhere, so a player keeps their color across every surface.

### `uniqByHandle()`

```ts
export function uniqByHandle(list: any[]): { handle: string; name: string }[]
```

Dedup a presence/member list by handle, keeping the first name seen.

### `esc()`

```ts
export function esc(s: any): string
```

HTML-escape untrusted text before putting it in innerHTML.

### `interface Countdown`

```ts
export interface Countdown {
  // Every SDK primitive tears down with destroy(); stop() is the same call.
  destroy(): void;
  stop(): void;
}
```

### `countdown()`

```ts
export function countdown(
  endsAt: number,
  opts: { onTick: (msLeft: number) => void; onEnd?: () => void; interval?: number },
): Countdown
```

Drive a countdown to an absolute timestamp. onTick gets ms remaining; onEnd
fires once at zero. Returns a handle so you can stop it on teardown.

## worlds.toast

Source: `sdk/src/toast.ts`

A self-contained transient toast. No markup or CSS required in the site —
the first call injects a styled element. Override via the `.worlds-toast`
class if a site wants its own look.

### `toast()`

```ts
export function toast(text: string, ms = 2400): void
```

## WorldsError

Source: `sdk/src/error.ts`

### `type ErrorCode`

```ts
export type ErrorCode =
  | "unauthorized" | "not_found" | "rate_limited" | "payload_too_large"
  | "quota_exceeded" | "invalid_request" | "reserved_name" | "forbidden" | "conflict"
  | "replay_expired" | "maintenance" | "upstream_error" | "internal";
```

The error envelope is part of the frozen v1 contract (see spec/world-v1.yaml).

### `class WorldsError`

```ts
export class WorldsError extends Error {
  code: ErrorCode;
  status: number;
  retryAfter?: number;
  constructor(code: ErrorCode, message: string, status = 0, retryAfter?: number) {
    super(message);
    this.name = "WorldsError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }

  // The wire envelope spells this `retry_after` and sites have branched on it since
  // v1; the property is camelCase like every other one on this class.
  get retry_after(): number | undefined {
    return this.retryAfter;
  }
}
```

## shared types

Source: `sdk/src/socket.ts`

One multiplexed WebSocket for the whole page: db subscriptions and channels
share it. Reconnects with backoff, replays db cursors, and queues frames sent
while still connecting so nothing is dropped.

### `interface Person`

```ts
export interface Person {
  handle: string;
  name: string;
}
```

Who a peer is on the wire. Defined here because socket.ts is the bottom of the SDK's
import order, so channels/room/actors can all share this one shape.

## Error codes

Every failed request is `{ error: { code, message, retry_after? } }` with one of these codes; the SDK rethrows it as a `WorldsError` carrying the same `code` plus the HTTP `status`. The registry is frozen: codes are never removed or renumbered.

| code | HTTP status |
|---|---|
| `unauthorized` | 401 |
| `not_found` | 404 |
| `rate_limited` | 429 |
| `payload_too_large` | 413 |
| `quota_exceeded` | 429 |
| `invalid_request` | 400 |
| `reserved_name` | 409 |
| `forbidden` | 403 |
| `conflict` | 409 |
| `replay_expired` | 410 |
| `maintenance` | 503 |
| `upstream_error` | 502 |
| `internal` | 500 |

## Limits

Quotas are floors: they can go up, never down for existing behavior.

| limit | value |
|---|---|
| `docBytes` | 256 KB |
| `collectionsPerSite` | 50 |
| `docsPerCollection` | 50000 |
| `uploadBytes` | 25 MB |
| `uploadsPerSiteBytes` | 1 GB |
| `deployBytes` | 100 MB |
| `deployFiles` | 2000 |
| `deploysPerSitePerHour` | 60 |
| `aiCompletionsPerUserPerDay` | 200 |
| `aiImagesPerUserPerDay` | 50 |
| `aiInputChars` | 200000 |
| `wsPayloadBytes` | 16 KB |
| `slackPerUserPerDay` | 50 |

Reserved site names (cannot be deployed to): `api`, `www`, `home`, `hello`, `assets`, `uploads`, `list`, `mcp`, `docs`, `u`.

## AI model aliases

Chat completions accept `model` as one of `fast`, `smart` (default `fast`). Aliases are the contract; the provider model behind each one is remapped server-side and never exposed. `worlds.ai.models()` lists the live set, including the embedding model.

## HTTP API (`/api/v1`)

The SDK is a thin client over these endpoints (`spec/world-v1.yaml`, frozen and additive-only). Mutations need the `x-worlds-csrf: 1` header; in path-routing mode a page also sends `x-worlds-site: <site>`.

| method | path | |
|---|---|---|
| GET | `/api/v1/me` | caller identity |
| GET | `/api/v1/site` | calling site context (Host-derived) |
| POST | `/api/v1/deploy` | multipart tarball -> live site |
| GET | `/api/v1/sites` | site directory |
| GET | `/api/v1/sites/{name}` | one site |
| GET | `/api/v1/sites/{name}/deploys` | deploy history |
| GET | `/api/v1/db` | list collections |
| POST | `/api/v1/db/{collection}` | create document |
| GET | `/api/v1/db/{collection}` | list documents (filter, sort, cursor) |
| GET | `/api/v1/db/{collection}/{id}` | read |
| PATCH | `/api/v1/db/{collection}/{id}` | shallow merge (If-Unmodified-Since-Version) |
| PUT | `/api/v1/db/{collection}/{id}` | replace |
| DELETE | `/api/v1/db/{collection}/{id}` | delete (idempotent) |
| POST | `/api/v1/db/{collection}/{id}/increment` | atomic counter |
| GET | `/api/v1/socket` | multiplexed WebSocket (db subs + channels), subprotocol worlds.v1 |
| POST | `/api/v1/ai/complete` | Gemini completion (model aliases only) |
| POST | `/api/v1/ai/embed` | embedding |
| POST | `/api/v1/ai/image` | image -> stored upload |
| GET | `/api/v1/ai/models` | stable model aliases |
| POST | `/api/v1/uploads` | store file |
| GET | `/api/v1/uploads` | list uploads |
| DELETE | `/api/v1/uploads/{name}` | delete upload |
| POST | `/api/v1/notify/slack` | capped, sender-stamped Slack message |
| GET | `/api/v1/universe` | homepage payload |
| GET | `/api/v1/creators/{handle}` | creator page data |
| POST | `/api/v1/beacon/visit` | sendBeacon page view, always 204 |
| GET | `/api/v1/meta` | api_version + build (build is NOT stable) |

## MCP tools

The server speaks MCP (JSON-RPC 2.0 over HTTP) at `/mcp`. The tools are sugar over the same `/api/v1` contract, so an agent can build and deploy a site without a browser.

### `deploy_site`

Deploy a Worlds site from a map of file paths to text contents (index.html required at root). Returns the live URL.

| argument | type | |
|---|---|---|
| `name` (required) | string | site name → its own subdomain (a-z, 0-9, dashes) |
| `files` (required) | object | map of relative path → file contents, e.g. {"index.html": "<!doctype html>…"} |

### `list_sites`

List Worlds sites (newest first). Optional creator handle, search query, limit.

| argument | type | |
|---|---|---|
| `creator` | string |  |
| `q` | string |  |
| `limit` | number |  |

### `get_site`

Get one site's metadata and universe layout by name.

| argument | type | |
|---|---|---|
| `name` (required) | string |  |

### `my_sites`

List the sites you (the calling identity) created or contributed to.

### `db_query`

Read documents from a site's worlds.db collection. site defaults to 'home' (the platform site registry). Supports the v1 filter/sort grammar.

| argument | type | |
|---|---|---|
| `collection` (required) | string |  |
| `site` | string | which site's collection to read (default 'home') |
| `filter` | object | v1 filter, e.g. {"votes": {"gt": 0}} |
| `sort` | string | field or -field |
| `limit` | number |  |

### `read_docs`

Read Worlds' docs. With no page, lists available pages; with a page name (e.g. 'sdk'), returns its markdown.

| argument | type | |
|---|---|---|
| `page` | string | doc page name without .md (e.g. 'sdk', 'quickstart', 'limits') |

### `search_docs`

Search Worlds' docs for a query string; returns matching pages with snippets.

| argument | type | |
|---|---|---|
| `query` (required) | string |  |
