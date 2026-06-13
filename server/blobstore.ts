import { mkdir, rename, rm, readdir, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import { config } from "./config";
import { WorldError } from "./errors";

// The cloud only ever appears behind this seam (local fs now, S3 in prod).
export interface BlobStore {
  siteDir(site: string): string;
  swapSite(site: string, stagedDir: string): Promise<void>;
  open(site: string, path: string): ReturnType<typeof Bun.file> | null;
  putUpload(site: string, name: string, data: Blob): Promise<{ size: number }>;
  listUploads(site: string): Promise<{ name: string; size: number; uploaded_at: string }[]>;
  deleteUpload(site: string, name: string): Promise<boolean>;
  openUpload(site: string, name: string): ReturnType<typeof Bun.file> | null;
  uploadsBytes(site: string): Promise<number>;
}

function safeJoin(root: string, ...parts: string[]): string {
  const p = normalize(join(root, ...parts));
  if (!p.startsWith(normalize(root))) throw new WorldError("invalid_request", "bad path");
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

  siteDir(site: string): string {
    return safeJoin(this.root, "sites", site);
  }

  async swapSite(site: string, stagedDir: string): Promise<void> {
    const live = this.siteDir(site);
    const old = `${live}.old-${Date.now()}`;
    try {
      await rename(live, old);
    } catch {
      /* first deploy */
    }
    await rename(stagedDir, live);
    await rm(old, { recursive: true, force: true });
  }

  open(site: string, path: string) {
    try {
      return Bun.file(safeJoin(this.siteDir(site), path));
    } catch {
      return null;
    }
  }

  private uploadDir(site: string): string {
    return safeJoin(this.root, "uploads", site);
  }

  async putUpload(site: string, name: string, data: Blob): Promise<{ size: number }> {
    await mkdir(this.uploadDir(site), { recursive: true });
    const target = safeJoin(this.uploadDir(site), name);
    await Bun.write(target, data);
    return { size: data.size };
  }

  async listUploads(site: string) {
    try {
      const dir = this.uploadDir(site);
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
      await rm(safeJoin(this.uploadDir(site), name));
      return true;
    } catch {
      return false;
    }
  }

  openUpload(site: string, name: string) {
    try {
      return Bun.file(safeJoin(this.uploadDir(site), name));
    } catch {
      return null;
    }
  }

  async uploadsBytes(site: string): Promise<number> {
    const files = await this.listUploads(site);
    return files.reduce((n, f) => n + f.size, 0);
  }
}

export const store = new LocalBlobStore();
