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
};

export async function seedWorlds(): Promise<void> {
  if (process.env.WORLDS_SEED === "0" || !dbReady()) return;
  const dir = new URL("../universe", import.meta.url).pathname;
  try {
    if (!(await stat(join(dir, "index.html"))).isFile()) return;
  } catch {
    return; // examples not bundled in this build
  }
  if (await getSite("universe")) return; // already present

  // Bundled apps always live on the local store (shipped in the image) — they're
  // the "local source" the composed store falls back to.
  const staged = localStore.stagingDir();
  await cp(dir, staged, { recursive: true });
  await localStore.swapSite("universe", staged);
  await upsertSite("universe", SYSTEM, {
    description: "Fly through every world as a planet in a living 3D galaxy.",
    category: "tools",
  });
  await publishSiteDoc("universe", true);
  console.log("seed: deployed the universe");
}
