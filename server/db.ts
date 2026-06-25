import { SQL } from "bun";
import { config } from "./config";
import { WorldsError } from "./errors";

export const sql = new SQL(config.databaseUrl, { max: 10, idleTimeout: 30 });

let ready = false;

export function dbReady(): boolean {
  return ready;
}

export function requireDb(): void {
  if (!ready) throw new WorldsError("maintenance", "database unavailable — run `bun run db:up`");
}

export async function initDb(): Promise<void> {
  try {
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
    ready = true;
    console.log("db: ready");
    startPrune();
  } catch (e) {
    ready = false;
    console.warn(`db: unavailable (${(e as Error).message}) — db-backed APIs will 503; reconnecting…`);
  } finally {
    startMonitor();   // self-heal across postgres restarts (and boot-before-postgres)
  }
}

// Run the hourly events prune exactly once (events are only needed for the replay
// window, so the table stays small). Idempotent — safe to call on every reconnect.
let pruneStarted = false;
function startPrune(): void {
  if (pruneStarted) return;
  pruneStarted = true;
  const prune = () => sql`DELETE FROM events WHERE at < now() - make_interval(hours => ${EVENT_RETENTION_HOURS})`.catch(() => {});
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
      await sql`SELECT 1`;
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
  const [row] = await sql`
    INSERT INTO events (site, collection, type, doc)
    VALUES (${site}, ${collection}, ${type}, ${doc as never})
    RETURNING seq`;
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
  const [oldest] = await sql`
    SELECT min(seq) AS min FROM events
    WHERE site = ${site} AND collection = ${collection}
      AND at > now() - make_interval(hours => ${EVENT_RETENTION_HOURS})`;
  if (oldest?.min !== null && seq < Number(oldest.min) - 1) return "expired";
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
