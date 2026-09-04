import { SQL } from "bun";
import { join, isAbsolute } from "node:path";
import { config } from "./config";
import { WorldsError } from "./errors";
import { openSqlite } from "./sqlite";
import { restoreSqlite, startSqliteSnapshots } from "./dbsnapshot";
import { hoursAgo, isSqlite, jsonArg, jsonParam, NOW } from "./dialect";

// sqlite: DATABASE_URL is a path (default: a file under WORLDS_DATA_DIR, so it rides
// the same volume as sites and uploads). postgres: a DSN.
function sqliteFile(): string {
  const url = process.env.DATABASE_URL ?? "";
  // A server DSN left in the environment isn't a file path — WORLDS_DB=sqlite wins, and
  // the default location wins with it, rather than trying to open "postgres://…".
  const raw = /^[a-z+]+:\/\//.test(url) && !/^(sqlite|file):/.test(url) ? "" : url.replace(/^(sqlite|file):(\/\/)?/, "");
  if (!raw) return join(config.dataDir, "worlds.sqlite");
  return isAbsolute(raw) ? raw : join(config.dataDir, raw);
}

const SQLITE_FILE = isSqlite ? sqliteFile() : "";

// Before the file is opened, not after: with an ephemeral disk the snapshot in S3 is the
// database, and opening first would create an empty one that then wins.
if (isSqlite) await restoreSqlite(SQLITE_FILE);

export const sql: any = isSqlite
  ? openSqlite(SQLITE_FILE)
  : new SQL(config.databaseUrl, { max: 10 });

let ready = false;

export function dbReady(): boolean {
  return ready;
}

export function requireDb(): void {
  if (!ready) throw new WorldsError("maintenance", "database unavailable — run `bun run db:up`");
}

// Work that needs a live db at boot but must also run if the db only shows up later
// (installed before postgres, or postgres bounced). Hooks must be idempotent — they
// run again on every reconnect.
const readyHooks = new Set<() => unknown>();

export function onDbReady(fn: () => unknown): void {
  readyHooks.add(fn);
}

export async function initDb(): Promise<void> {
  try {
    if (isSqlite) await migrateSqlite();
    else await migratePostgres();
    ready = true;
    console.log("db: ready");
    if (isSqlite) startSqliteSnapshots(sql, SQLITE_FILE);
    startPrune();
    for (const fn of readyHooks) void Promise.resolve(fn()).catch(() => {});
  } catch (e) {
    ready = false;
    console.warn(`db: unavailable (${(e as Error).message}) — db-backed APIs will 503; reconnecting…`);
  } finally {
    startMonitor();   // self-heal across postgres restarts (and boot-before-postgres)
  }
}

async function migratePostgres(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS sites (
      name        text PRIMARY KEY,
      description text NOT NULL DEFAULT '',
      creator     text NOT NULL,
      contributors jsonb NOT NULL DEFAULT '[]',
      spa_fallback boolean NOT NULL DEFAULT false,
      status      text NOT NULL DEFAULT 'live',
      visits      bigint NOT NULL DEFAULT 0,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`ALTER TABLE sites ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'misc'`;
  // Universe layout: embedding-derived [x,y,z] (similar sites cluster), set async post-deploy.
  await sql`ALTER TABLE sites ADD COLUMN IF NOT EXISTS embed_pos jsonb`;
  await sql`ALTER TABLE sites ADD COLUMN IF NOT EXISTS screenshot text`;
  await sql`
    CREATE TABLE IF NOT EXISTS deploys (
      deploy_id  text PRIMARY KEY,
      site       text NOT NULL,
      by_handle  text NOT NULL,
      by_name    text NOT NULL,
      files      int NOT NULL,
      bytes      bigint NOT NULL,
      at         timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS deploys_site ON deploys (site, at DESC)`;
  // User profiles: canonical (email local-part) is the immutable identity key;
  // handle is the mutable, unique display/URL alias (defaults to canonical).
  await sql`
    CREATE TABLE IF NOT EXISTS profiles (
      canonical   text PRIMARY KEY,
      handle      text UNIQUE NOT NULL,
      name        text,
      avatar      text,
      updated_at  timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      n           bigserial,
      site        text NOT NULL,
      collection  text NOT NULL,
      id          text NOT NULL,
      data        jsonb NOT NULL,
      created_by  text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (site, collection, id)
    )`;
  // Internal monotone sequence for keyset cursors (never exposed; timestamps
  // lose microseconds round-tripping through JS Dates).
  await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS n bigserial`;
  await sql`CREATE INDEX IF NOT EXISTS documents_n ON documents (site, collection, n)`;
  await sql`
    CREATE TABLE IF NOT EXISTS events (
      seq        bigserial PRIMARY KEY,
      site       text NOT NULL,
      collection text NOT NULL,
      type       text NOT NULL,
      doc        jsonb NOT NULL,
      at         timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS events_scope ON events (site, collection, seq)`;
}

// Same shape, SQLite spelling: JSON lives in TEXT, timestamps are ISO-8601 strings
// with milliseconds, and the monotone cursor columns are AUTOINCREMENT primary keys
// (plain rowids get reused after a delete, which would rewind a live cursor).
async function migrateSqlite(): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS sites (
      name         TEXT PRIMARY KEY,
      description  TEXT NOT NULL DEFAULT '',
      creator      TEXT NOT NULL,
      contributors TEXT NOT NULL DEFAULT '[]',
      spa_fallback INTEGER NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'live',
      visits       INTEGER NOT NULL DEFAULT 0,
      category     TEXT NOT NULL DEFAULT 'misc',
      embed_pos    TEXT,
      screenshot   TEXT,
      created_at   TEXT NOT NULL DEFAULT (${NOW}),
      updated_at   TEXT NOT NULL DEFAULT (${NOW})
    )`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS deploys (
      deploy_id TEXT PRIMARY KEY,
      site      TEXT NOT NULL,
      by_handle TEXT NOT NULL,
      by_name   TEXT NOT NULL,
      files     INTEGER NOT NULL,
      bytes     INTEGER NOT NULL,
      at        TEXT NOT NULL DEFAULT (${NOW})
    )`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS deploys_site ON deploys (site, at DESC)`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS profiles (
      canonical  TEXT PRIMARY KEY,
      handle     TEXT UNIQUE NOT NULL,
      name       TEXT,
      avatar     TEXT,
      updated_at TEXT NOT NULL DEFAULT (${NOW})
    )`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS documents (
      n          INTEGER PRIMARY KEY AUTOINCREMENT,
      site       TEXT NOT NULL,
      collection TEXT NOT NULL,
      id         TEXT NOT NULL,
      data       TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      updated_at TEXT NOT NULL DEFAULT (${NOW}),
      UNIQUE (site, collection, id)
    )`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS documents_n ON documents (site, collection, n)`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS events (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      site       TEXT NOT NULL,
      collection TEXT NOT NULL,
      type       TEXT NOT NULL,
      doc        TEXT NOT NULL,
      at         TEXT NOT NULL DEFAULT (${NOW})
    )`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS events_scope ON events (site, collection, seq)`);
}

// Run the hourly events prune exactly once (events are only needed for the replay
// window, so the table stays small). Idempotent — safe to call on every reconnect.
let pruneStarted = false;
function startPrune(): void {
  if (pruneStarted) return;
  pruneStarted = true;
  const prune = () =>
    sql.unsafe(`DELETE FROM events WHERE at < ${hoursAgo(EVENT_RETENTION_HOURS)}`).catch(() => {});
  prune();
  setInterval(prune, 60 * 60 * 1000).unref?.();
}

// Health monitor — ping postgres every few seconds and self-heal. Without this the
// app latches `ready = false` on the first connection blip (it booted before
// postgres was up, or postgres restarted) and serves 503s for every db-backed
// route until the process is restarted by hand — which is exactly how the live
// instance went dark after a postgres bounce.
let monitorStarted = false;
let dbChecking = false;
function startMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;
  const tick = async () => {
    if (dbChecking) return;
    dbChecking = true;
    try {
      // One retry: a probe that lands on a connection the pool is closing fails once and
      // recovers on the next, and that is not a postgres outage.
      await sql`SELECT 1`.catch(() => sql`SELECT 1`);
      if (!ready) await initDb();   // connection is back — re-migrate (idempotent) + flip ready
    } catch (e) {
      if (ready) {
        ready = false;
        console.warn(`db: unavailable (${(e as Error).message}) — db-backed APIs will 503; reconnecting…`);
      }
    } finally {
      dbChecking = false;
    }
  };
  setInterval(tick, 4000).unref?.();
}

// ---- in-process change feed (single-pod dev; PG LISTEN/NOTIFY when multi-pod) ----

export interface ChangeEvent {
  seq: number;
  site: string;
  collection: string;
  type: "create" | "update" | "delete";
  doc: unknown;
  cursor: string;
}

type Listener = (ev: ChangeEvent) => void;
const listeners = new Set<Listener>();

export function onChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function emitChange(
  site: string,
  collection: string,
  type: ChangeEvent["type"],
  doc: unknown,
): Promise<void> {
  const [row] = await sql.unsafe(
    `INSERT INTO events (site, collection, type, doc)
     VALUES ($1, $2, $3, ${jsonArg("$4")})
     RETURNING seq`,
    [site, collection, type, jsonParam(doc)],
  );
  const ev: ChangeEvent = { seq: Number(row.seq), site, collection, type, doc, cursor: String(row.seq) };
  for (const fn of listeners) fn(ev);
}

export const EVENT_RETENTION_HOURS = 24;

export async function replaySince(
  site: string,
  collection: string,
  since: string,
): Promise<ChangeEvent[] | "expired"> {
  const seq = Number(since);
  if (!Number.isFinite(seq)) return "expired";
  const [oldest] = await sql.unsafe(
    `SELECT min(seq) AS min FROM events
     WHERE site = $1 AND collection = $2 AND at > ${hoursAgo(EVENT_RETENTION_HOURS)}`,
    [site, collection],
  );
  // A NULL min means the window holds nothing, which is "your cursor aged out",
  // not "you're caught up" — returning [] there tells the client it missed nothing.
  if (oldest?.min === null || oldest?.min === undefined) return "expired";
  if (seq < Number(oldest.min) - 1) return "expired";
  const rows = await sql`
    SELECT seq, type, doc FROM events
    WHERE site = ${site} AND collection = ${collection} AND seq > ${seq}
    ORDER BY seq`;
  return rows.map((r: { seq: string; type: ChangeEvent["type"]; doc: unknown }) => ({
    seq: Number(r.seq),
    site,
    collection,
    type: r.type,
    doc: r.doc,
    cursor: String(r.seq),
  }));
}
