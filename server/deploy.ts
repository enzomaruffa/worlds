import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { LIMITS, RESERVED_SITES } from "./config";
import { WorldsError, json } from "./errors";
import { store } from "./blobstore";
import { identityFrom, requireCsrf, type Identity } from "./identity";
import { sql, dbReady } from "./db";
import { upsertSite, siteUrl, publishSiteDoc, getSite } from "./sites";
import { allowDeploy } from "./ratelimit";
import { postDeploy } from "./postdeploy";

const SITE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Ownership: the first uploader owns a site; only the owner can overwrite it
// (basic maintainer model). New sites are open to anyone.
async function requireOwner(site: string, who: Identity): Promise<void> {
  if (!dbReady()) return;
  const existing = await getSite(site);
  if (existing && existing.creator !== who.handle) {
    throw new WorldsError("forbidden", `"${site}" is owned by @${existing.creator} — only the owner can update it`);
  }
}

export interface DeployResult {
  site: string;
  url: string;
  deploy_id: string;
  files: number;
  bytes: number;
  created: boolean;
}

function validateSiteName(site: string): void {
  if (!SITE_NAME.test(site)) {
    throw new WorldsError("invalid_request", "site name must match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ (max 63 chars)");
  }
  if (RESERVED_SITES.has(site)) throw new WorldsError("reserved_name", `"${site}" is reserved`);
}

async function walk(dir: string, base = ""): Promise<{ path: string; size: number }[]> {
  const entries = await Promise.all((await readdir(dir)).map(async (name) => {
    const full = join(dir, name);
    const s = await stat(full);
    return s.isDirectory() ? walk(full, join(base, name)) : [{ path: join(base, name), size: s.size }];
  }));
  return entries.flat();
}

// Shared tail: a populated `root` dir → atomic swap into production + records +
// fire-and-forget universe worker. Used by both the tarball and file-map paths.
async function finalizeDeploy(site: string, root: string, who: Identity): Promise<DeployResult> {
  const indexFile = Bun.file(join(root, "index.html"));
  if (!(await indexFile.exists())) {
    throw new WorldsError("invalid_request", "bundle must contain index.html at its root");
  }

  let manifest: { description?: string; spa_fallback?: boolean; category?: string } = {};
  const manifestFile = Bun.file(join(root, ".world.json"));
  if (await manifestFile.exists()) {
    manifest = await manifestFile.json().catch(() => ({}));
  }

  const files = await walk(root);
  const bytes = files.reduce((n, f) => n + f.size, 0);

  await store.swapSite(site, root);

  const deployId = `dp_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let created = false;
  if (dbReady()) {
    created = (await upsertSite(site, who, manifest)).created;
    await sql`
      INSERT INTO deploys (deploy_id, site, by_handle, by_name, files, bytes)
      VALUES (${deployId}, ${site}, ${who.handle}, ${who.name}, ${files.length}, ${bytes})`;
    await publishSiteDoc(site, created);
    postDeploy(site).catch(() => {}); // embedding position + screenshot, async
  }

  return { site, url: siteUrl(site), deploy_id: deployId, files: files.length, bytes, created };
}

export async function handleDeploy(req: Request): Promise<Response> {
  requireCsrf(req);
  const who = identityFrom(req);

  const form = await req.formData().catch(() => {
    throw new WorldsError("invalid_request", "expected multipart form data");
  });
  const site = String(form.get("site") ?? "");
  const bundle = form.get("bundle");

  validateSiteName(site);
  if (!(bundle instanceof Blob)) throw new WorldsError("invalid_request", "missing bundle (tar.gz)");
  if (bundle.size > LIMITS.deployBytes) {
    throw new WorldsError("payload_too_large", `bundle exceeds ${LIMITS.deployBytes / 1024 / 1024}MB`);
  }
  await requireOwner(site, who);
  allowDeploy(site);

  // Stage: write the tarball, list-validate entries, then extract. The finally
  // always clears staging — including the wrapper left after a single-dir swap.
  const staged = store.stagingDir();
  await mkdir(staged, { recursive: true });
  try {
    const tarPath = join(staged, "_bundle.tgz");
    await Bun.write(tarPath, bundle);

    const list = Bun.spawnSync(["tar", "-tzf", tarPath]);
    if (list.exitCode !== 0) throw new WorldsError("invalid_request", "bundle is not a valid tar.gz");
    const entries = list.stdout.toString().split("\n").filter(Boolean);
    for (const e of entries) {
      if (e.startsWith("/") || e.split("/").includes("..")) {
        throw new WorldsError("invalid_request", `unsafe path in bundle: ${e}`);
      }
    }
    if (entries.filter((e) => !e.endsWith("/")).length > LIMITS.deployFiles) {
      throw new WorldsError("payload_too_large", `bundle exceeds ${LIMITS.deployFiles} files`);
    }

    const extract = Bun.spawnSync(["tar", "-xzf", tarPath, "-C", staged]);
    await rm(tarPath, { force: true });
    if (extract.exitCode !== 0) throw new WorldsError("invalid_request", "failed to extract bundle");

    // Tolerate single-directory tarballs (tar -czf site.tgz my-site/).
    let root = staged;
    const top = await readdir(staged);
    if (top.length === 1) {
      const only = join(staged, top[0]!);
      if ((await stat(only)).isDirectory()) root = only;
    }

    return json(await finalizeDeploy(site, root, who));
  } finally {
    await rm(staged, { recursive: true, force: true }).catch(() => {});
  }
}

// Programmatic path (MCP / drag-drop): a { "path/in/site": content } map instead
// of a tarball. Same validation + finalize as the CLI path.
export async function deployFileMap(site: string, files: Record<string, string>, who: Identity): Promise<DeployResult> {
  validateSiteName(site);
  const names = Object.keys(files);
  if (!names.length) throw new WorldsError("invalid_request", "no files to deploy");
  if (names.length > LIMITS.deployFiles) {
    throw new WorldsError("payload_too_large", `more than ${LIMITS.deployFiles} files`);
  }
  let total = 0;
  for (const [p, content] of Object.entries(files)) {
    if (p.startsWith("/") || p.split("/").includes("..")) throw new WorldsError("invalid_request", `unsafe path: ${p}`);
    total += content.length;
  }
  if (total > LIMITS.deployBytes) throw new WorldsError("payload_too_large", "files exceed the deploy size limit");
  await requireOwner(site, who);
  allowDeploy(site);

  const staged = store.stagingDir();
  await mkdir(staged, { recursive: true });
  try {
    for (const [p, content] of Object.entries(files)) {
      const dest = join(staged, p);
      if (!dest.startsWith(staged)) throw new WorldsError("invalid_request", `unsafe path: ${p}`);
      await mkdir(dirname(dest), { recursive: true });
      await Bun.write(dest, content);
    }
    return await finalizeDeploy(site, staged, who);
  } finally {
    await rm(staged, { recursive: true, force: true }).catch(() => {});
  }
}
