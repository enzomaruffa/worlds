import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "./config";
import { dbReady } from "./db";
import { aiConfigured, embedText, generateImage } from "./ai";
import { store } from "./blobstore";
import { getSite, setEmbedPos, setScreenshot, publishSiteDoc, siteUrl } from "./sites";
import { mintRenderToken } from "./auth";

// Runs after a deploy (fire-and-forget). Two best-effort jobs that refine the
// universe: an embedding-derived position (so similar sites cluster) and the card
// picture. Neither blocks the deploy, and both degrade silently.
export async function postDeploy(site: string, opts: { thumbnail: string }): Promise<void> {
  if (!dbReady() || process.env.WORLDS_DISABLE_WORKERS) return;
  await Promise.allSettled([computeEmbedPos(site), makeThumbnail(site, opts.thumbnail)]);
}

// --- embedding-derived layout -------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fixed random projection 768 → 3 (Johnson–Lindenstrauss): stable across restarts
// and roughly similarity-preserving, so nearby embeddings land near each other.
const EMBED_DIM = 768;
const PROJ = (() => {
  const r = mulberry32(0x5eed);
  return Array.from({ length: 3 }, () => Array.from({ length: EMBED_DIM }, () => r() * 2 - 1));
})();

function project(vec: number[]): [number, number, number] {
  const out = PROJ.map((row) => {
    let s = 0;
    const n = Math.min(vec.length, row.length);
    for (let i = 0; i < n; i++) s += vec[i]! * row[i]!;
    return s;
  });
  // x,z give the orbital direction (what the universe clusters by); y a small tilt.
  const xz = Math.hypot(out[0]!, out[2]!) || 1;
  const r = 0.35 + (Math.tanh(out[1]!) * 0.5 + 0.5) * 0.5; // 0.35..0.85
  return [(out[0]! / xz) * r, Math.tanh(out[1]!) * 0.12, (out[2]! / xz) * r];
}

async function computeEmbedPos(site: string): Promise<void> {
  if (!config.geminiKey) return;
  const s = await getSite(site);
  if (!s) return;
  const vec = await embedText(`${s.name}. ${s.category}. ${s.description}`.trim());
  if (vec.length < 3) return;
  await setEmbedPos(site, project(vec));
  // pos shows on the next /api/v1/universe load; no live re-emit needed.
}

// --- screenshot thumbnail -----------------------------------------------------

// Best-effort headless capture. Works wherever a Chrome/Chromium binary exists
// (set WORLDS_CHROME to point at one); silently skips otherwise. In prod the
// gateway must let the capture reach the site internally — see deploy/README.
const CHROME = [
  process.env.WORLDS_CHROME,
  "google-chrome",
  "chromium",
  "chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((b): b is string => !!b);

async function capture(url: string): Promise<Blob | null> {
  const out = join(tmpdir(), `world-shot-${crypto.randomUUID()}.png`);
  for (const bin of CHROME) {
    try {
      // Async spawn (NOT spawnSync) — never block the server event loop.
      const proc = Bun.spawn(
        [bin, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         "--window-size=1200,800", "--virtual-time-budget=7000", `--screenshot=${out}`, url],
        { stdout: "ignore", stderr: "ignore", timeout: 30000 },
      );
      const code = await proc.exited;
      if (code === 0 && (await Bun.file(out).exists())) {
        return new Blob([await Bun.file(out).arrayBuffer()], { type: "image/png" });
      }
    } catch { /* try the next candidate */ } finally {
      // A timed-out or crashed Chrome can still have written a partial PNG, and every
      // capture uses a fresh uuid — cleaning up only on success leaks one file per failure.
      await rm(out, { force: true }).catch(() => {});
    }
  }
  return null;
}

// Capture over localhost with a render token (works behind the google sign-in wall);
// in subdomain mode fall back to the public URL + token.
function shotUrl(site: string): string {
  const token = mintRenderToken();
  if (config.routing === "path") return `http://localhost:${config.port}/app/${site}/?__render=${token}`;
  const u = new URL(siteUrl(site));
  u.searchParams.set("__render", token);
  return u.toString();
}

// `screenshot` is the default and falls back to `ai` when there is no browser to
// capture with: a generated picture beats the blank tile an instance without Chrome
// would otherwise show forever. `ai` is the author's explicit choice. Anything else
// (`none`, or a bundled file already recorded at deploy time) needs no worker.
async function makeThumbnail(site: string, mode: string): Promise<void> {
  let blob: Blob | null = null;
  let file = "__screenshot.png";
  if (mode === "screenshot") blob = await capture(shotUrl(site));
  if (!blob && (mode === "screenshot" || mode === "ai") && aiConfigured()) {
    blob = await generateCard(site).catch(() => null);
    file = "__thumbnail.png";
  }
  if (!blob) return;
  await store.putUpload(site, file, blob);
  await setScreenshot(site, `/u/${site}/${file}`);
  await publishSiteDoc(site, false); // re-emit so the picture appears live
}

// A card image from what the site says about itself. Dark and simple on purpose — it
// sits in a 16:9 tile next to real screenshots, so it should read as a poster, not a UI.
async function generateCard(site: string): Promise<Blob | null> {
  const s = await getSite(site);
  if (!s) return null;
  const about = [s.description, s.tags?.length ? `tags: ${s.tags.join(", ")}` : ""].filter(Boolean).join(". ");
  return generateImage(
    `A 16:9 poster-style illustration for an internal web app called "${s.name}" (category: ${s.category}). ${about || "No description."} ` +
    `Dark background, one or two bold colors, flat vector shapes, no text, no letters, no words, no logos, no people's faces.`,
  );
}
