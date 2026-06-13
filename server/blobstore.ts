import { mkdir, rename, rm, readdir, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { config } from "./config";
import { WorldsError } from "./errors";

// A served blob: a body Response accepts, plus the metadata for ETag/caching.
export interface Stored {
  body: Blob | ReadableStream | ReturnType<typeof Bun.file>;
  size: number;
  mtime: number; // epoch ms
}

export interface UploadInfo {
  name: string;
  size: number;
  uploaded_at: string;
}

// Storage is behind this seam so sites + uploads can live on local disk, an S3
// bucket, or both (a LayeredBlobStore reads local-then-remote). Reads return a
// normalized Stored so any backend serves identically.
export interface BlobStore {
  init(): Promise<void>;
  stagingDir(): string;
  swapSite(site: string, stagedDir: string): Promise<void>;
  readSite(site: string, path: string): Promise<Stored | null>;
  putUpload(site: string, name: string, data: Blob): Promise<{ size: number }>;
  readUpload(site: string, name: string): Promise<Stored | null>;
  listUploads(site: string): Promise<UploadInfo[]>;
  deleteUpload(site: string, name: string): Promise<boolean>;
  uploadsBytes(site: string): Promise<number>;
}

// Reject path traversal; join into a clean relative key/path.
function safeRel(...parts: string[]): string {
  const p = normalize(join("/", ...parts)).replace(/^\/+/, "");
  if (p.split("/").includes("..")) throw new WorldsError("invalid_request", "bad path");
  return p;
}

export class LocalBlobStore implements BlobStore {
  constructor(private root: string = config.dataDir) {}

  async init() {
    await mkdir(join(this.root, "sites"), { recursive: true });
    await mkdir(join(this.root, "uploads"), { recursive: true });
    await mkdir(join(this.root, "staging"), { recursive: true });
  }

  stagingDir(): string {
    return join(this.root, "staging", crypto.randomUUID());
  }

  private abs(kind: "sites" | "uploads", site: string, rest = ""): string {
    return join(this.root, kind, safeRel(site, rest));
  }

  async swapSite(site: string, stagedDir: string): Promise<void> {
    const live = this.abs("sites", site);
    const old = `${live}.old-${Date.now()}`;
    try {
      await rename(live, old);
    } catch {
      /* first deploy */
    }
    await rename(stagedDir, live);
    await rm(old, { recursive: true, force: true });
  }

  private async read(full: string): Promise<Stored | null> {
    try {
      const f = Bun.file(full);
      const s = await f.stat();
      if (s.isDirectory()) return null;
      return { body: f, size: s.size, mtime: s.mtime.getTime() };
    } catch {
      return null;
    }
  }

  readSite(site: string, path: string): Promise<Stored | null> {
    return this.read(this.abs("sites", site, path));
  }

  async putUpload(site: string, name: string, data: Blob): Promise<{ size: number }> {
    const target = this.abs("uploads", site, name);
    await mkdir(this.abs("uploads", site), { recursive: true });
    await Bun.write(target, data);
    return { size: data.size };
  }

  readUpload(site: string, name: string): Promise<Stored | null> {
    return this.read(this.abs("uploads", site, name));
  }

  async listUploads(site: string): Promise<UploadInfo[]> {
    try {
      const dir = this.abs("uploads", site);
      const names = await readdir(dir);
      const stats = await Promise.all(names.map(async (name) => ({ name, s: await stat(join(dir, name)) })));
      return stats
        .filter(({ s }) => s.isFile())
        .map(({ name, s }) => ({ name, size: s.size, uploaded_at: s.mtime.toISOString() }))
        .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
    } catch {
      return [];
    }
  }

  async deleteUpload(site: string, name: string): Promise<boolean> {
    try {
      await rm(this.abs("uploads", site, name));
      return true;
    } catch {
      return false;
    }
  }

  async uploadsBytes(site: string): Promise<number> {
    return (await this.listUploads(site)).reduce((n, f) => n + f.size, 0);
  }
}

// Remote backend on any S3-compatible store (AWS S3, R2, MinIO…) via Bun's native
// S3 client. Untested without a live bucket; the local path is the default.
export class S3BlobStore implements BlobStore {
  private client: Bun.S3Client;
  constructor(opts: { bucket: string; region?: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string }) {
    this.client = new Bun.S3Client({
      bucket: opts.bucket,
      ...(opts.region ? { region: opts.region } : {}),
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.accessKeyId ? { accessKeyId: opts.accessKeyId } : {}),
      ...(opts.secretAccessKey ? { secretAccessKey: opts.secretAccessKey } : {}),
    });
  }

  async init() {}

  // Deploys still stage to local disk; swapSite uploads the staged tree to S3.
  stagingDir(): string {
    return join(tmpdir(), "worlds-staging", crypto.randomUUID());
  }

  private async walk(dir: string, base = ""): Promise<{ abs: string; rel: string }[]> {
    const out = await Promise.all((await readdir(dir)).map(async (name) => {
      const abs = join(dir, name);
      const s = await stat(abs);
      return s.isDirectory() ? this.walk(abs, join(base, name)) : [{ abs, rel: join(base, name) }];
    }));
    return out.flat();
  }

  private async deletePrefix(prefix: string): Promise<void> {
    const res = await this.client.list({ prefix });
    for (const obj of res?.contents ?? []) if (obj.key) await this.client.file(obj.key).delete().catch(() => {});
  }

  async swapSite(site: string, stagedDir: string): Promise<void> {
    const prefix = `sites/${safeRel(site)}/`;
    await this.deletePrefix(prefix);
    for (const { abs, rel } of await this.walk(stagedDir)) {
      await this.client.file(prefix + rel.split("/").map(encodeURIComponent).join("/").replace(/%2F/g, "/")).write(Bun.file(abs));
    }
  }

  private async read(key: string): Promise<Stored | null> {
    try {
      const f = this.client.file(key);
      const s = await f.stat();
      return { body: f, size: s.size, mtime: new Date(s.lastModified ?? Date.now()).getTime() };
    } catch {
      return null;
    }
  }

  readSite(site: string, path: string): Promise<Stored | null> {
    return this.read(`sites/${safeRel(site, path)}`);
  }

  async putUpload(site: string, name: string, data: Blob): Promise<{ size: number }> {
    await this.client.file(`uploads/${safeRel(site, name)}`).write(data);
    return { size: data.size };
  }

  readUpload(site: string, name: string): Promise<Stored | null> {
    return this.read(`uploads/${safeRel(site, name)}`);
  }

  async listUploads(site: string): Promise<UploadInfo[]> {
    const prefix = `uploads/${safeRel(site)}/`;
    const res = await this.client.list({ prefix }).catch(() => null);
    return (res?.contents ?? [])
      .filter((o) => o.key && !o.key.endsWith("/"))
      .map((o) => ({
        name: o.key!.slice(prefix.length),
        size: o.size ?? 0,
        uploaded_at: new Date(o.lastModified ?? Date.now()).toISOString(),
      }))
      .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
  }

  async deleteUpload(site: string, name: string): Promise<boolean> {
    try {
      await this.client.file(`uploads/${safeRel(site, name)}`).delete();
      return true;
    } catch {
      return false;
    }
  }

  async uploadsBytes(site: string): Promise<number> {
    return (await this.listUploads(site)).reduce((n, f) => n + f.size, 0);
  }
}

// Two sources at once: writes go to `primary` (e.g. S3); reads fall through
// primary → fallback (e.g. bundled apps shipped on local disk).
export class LayeredBlobStore implements BlobStore {
  constructor(private primary: BlobStore, private fallback: BlobStore) {}

  async init() {
    await Promise.all([this.primary.init(), this.fallback.init()]);
  }
  stagingDir(): string {
    return this.primary.stagingDir();
  }
  swapSite(site: string, stagedDir: string): Promise<void> {
    return this.primary.swapSite(site, stagedDir);
  }
  async readSite(site: string, path: string): Promise<Stored | null> {
    return (await this.primary.readSite(site, path)) ?? this.fallback.readSite(site, path);
  }
  putUpload(site: string, name: string, data: Blob) {
    return this.primary.putUpload(site, name, data);
  }
  async readUpload(site: string, name: string): Promise<Stored | null> {
    return (await this.primary.readUpload(site, name)) ?? this.fallback.readUpload(site, name);
  }
  async listUploads(site: string): Promise<UploadInfo[]> {
    const seen = new Set<string>();
    const merged: UploadInfo[] = [];
    for (const u of [...(await this.primary.listUploads(site)), ...(await this.fallback.listUploads(site))]) {
      if (seen.has(u.name)) continue;
      seen.add(u.name);
      merged.push(u);
    }
    return merged;
  }
  deleteUpload(site: string, name: string): Promise<boolean> {
    return this.primary.deleteUpload(site, name);
  }
  uploadsBytes(site: string): Promise<number> {
    return this.primary.uploadsBytes(site);
  }
}

// Bundled/seeded apps always live on local disk (shipped in the image). When an
// S3 bucket is configured, deploys + uploads go to S3 and reads fall through to
// the local bundle — "one local and one remote source of apps".
export const localStore = new LocalBlobStore();
export const store: BlobStore = config.s3Bucket
  ? new LayeredBlobStore(
      new S3BlobStore({
        bucket: config.s3Bucket,
        ...(config.s3Region ? { region: config.s3Region } : {}),
        ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
      }),
      localStore,
    )
  : localStore;
