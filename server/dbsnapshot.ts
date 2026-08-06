import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "./config";

// Durability for the SQLite backend without a volume: the database file lives on the
// pod's disk (which may be ephemeral) and its consistent snapshot lives in the same S3
// bucket as sites and uploads. Restore on boot, snapshot on a timer and on shutdown.
//
// The trade is explicit: a hard crash loses writes since the last snapshot, bounded by
// WORLDS_DB_SNAPSHOT_SECONDS. A graceful stop (a rollout, a scale-down) loses nothing
// because SIGTERM snapshots before exiting. That is the right shape for a single-writer
// install that would rather not operate a database server or a volume; anything that
// cannot afford the crash window should run Postgres instead.

const KEY = "db/worlds.sqlite";

function client(): Bun.S3Client | null {
  if (!config.s3Bucket) return null;
  return new Bun.S3Client({
    bucket: config.s3Bucket,
    ...(config.s3Region ? { region: config.s3Region } : {}),
    ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
  });
}

// Pull the snapshot down before the database is opened. A local file always wins: it is
// either newer than the snapshot or the snapshot does not exist yet.
export async function restoreSqlite(file: string): Promise<void> {
  const s3 = client();
  if (!s3) return;
  try {
    if (await Bun.file(file).exists()) return;
    const remote = s3.file(KEY);
    if (!(await remote.exists())) return;
    await Bun.write(file, await remote.arrayBuffer());
    console.log(`db: restored ${KEY} from s3`);
  } catch (e) {
    // Boot anyway — an empty database is recoverable, refusing to start is not.
    console.warn(`db: could not restore from s3 (${(e as Error).message}) — starting fresh`);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

// VACUUM INTO, not a copy of the live file: it writes a consistent database even while
// the WAL has uncommitted frames, and it compacts on the way out.
async function snapshot(sql: { unsafe(text: string): Promise<unknown> }, file: string): Promise<void> {
  const s3 = client();
  if (!s3 || inFlight) return;
  inFlight = true;
  const tmp = join(tmpdir(), `worlds-snap-${crypto.randomUUID()}.sqlite`);
  try {
    await sql.unsafe(`VACUUM INTO '${tmp}'`);
    await s3.file(KEY).write(Bun.file(tmp));
  } catch (e) {
    console.warn(`db: snapshot to s3 failed (${(e as Error).message})`);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
    inFlight = false;
  }
}

export function startSqliteSnapshots(sql: { unsafe(text: string): Promise<unknown> }, file: string): void {
  if (!config.s3Bucket || timer) return;
  timer = setInterval(() => void snapshot(sql, file), config.dbSnapshotSeconds * 1000);
  timer.unref?.();

  // A rollout is the common case, so make it lossless: snapshot, then exit.
  let stopping = false;
  const onStop = async () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    await snapshot(sql, file);
    process.exit(0);
  };
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);
}
