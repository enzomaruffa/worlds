import { cp, stat } from "node:fs/promises";
import { join } from "node:path";
import { localStore } from "./blobstore";
import { dbReady } from "./db";
import { avatarFor, type Identity } from "./identity";
import { getSite, upsertSite, publishSiteDoc } from "./sites";

// First-boot seed: ship the flagship "universe" (the 3D space of all worlds) as
// an initial world, so a fresh install isn't empty. Idempotent; disable with
// WORLDS_SEED=0. The universe is a normal Worlds site built on the public SDK.
const SYSTEM: Identity = {
  email: "system@localhost",
  handle: "world",
  name: "Worlds",
  avatar: avatarFor("system@localhost"),
  kind: "user",
};

// Runs at boot and again on every db reconnect, so two calls can overlap — and both
// would pass the "already present" check and deploy the universe twice. Callers share
// one in-flight run; a finished one is cleared so a failed attempt can be retried.
let inFlight: Promise<void> | null = null;

export function seedWorlds(): Promise<void> {
  return (inFlight ??= runSeed().finally(() => {
    inFlight = null;
  }));
}

async function runSeed(): Promise<void> {
  if (process.env.WORLDS_SEED === "0" || !dbReady()) return;
  const dir = new URL("../universe", import.meta.url).pathname;
  try {
    if (!(await stat(join(dir, "index.html"))).isFile()) return;
  } catch {
    return; // examples not bundled in this build
  }
  // Gate on the FILES, not the db row. The row lives in postgres and the files live
  // under WORLDS_DATA_DIR, so a deployment that keeps the database but gives the pod a
  // fresh disk (an emptyDir, a new node) comes back with the row intact and nothing to
  // serve — and a row-only check would skip re-seeding and 404 the universe forever.
  const alreadyServing = await localStore.readSite("universe", "index.html");
  const row = await getSite("universe");
  if (alreadyServing && row) return;

  // Bundled apps always live on the local store (shipped in the image) — they're
  // the "local source" the composed store falls back to.
  if (!alreadyServing) {
    const staged = localStore.stagingDir();
    await cp(dir, staged, { recursive: true });
    await localStore.swapSite("universe", staged);
  }
  await upsertSite("universe", SYSTEM, {
    description: "Fly through every world as a planet in a living 3D galaxy.",
    category: "tools",
  });
  if (!row) await publishSiteDoc("universe", true);
  console.log(alreadyServing ? "seed: universe row restored" : "seed: deployed the universe");
}
