import { join } from "node:path";
import { store, type Stored } from "./blobstore";
import { spaFallback } from "./sites";

// Caching: code/text (html/js/css/…) gets `no-cache` (revalidate every load) so
// overwrite-deploys propagate INSTANTLY; a CONTENT-HASH ETag keeps that cheap —
// unchanged bytes 304 even across redeploys, so nothing re-downloads (e.g. the
// 1.3MB vendored three.js). Binary media (rarely changes) gets a real max-age.
// NOTE: Cloudflare's Browser-Cache-TTL can rewrite a max-age but respects no-cache.
const REVALIDATE = /\.(html?|js|mjs|css|json|svg|txt|md|map|xml|webmanifest)$/i;
function cacheControl(path: string): string {
  return path.endsWith("/") || REVALIDATE.test(path) ? "no-cache" : "public, max-age=3600";
}

// Content-hash ETags, memoized by (size,mtime) so the hash is computed once per
// file version. Re-readable bodies (BunFile/Blob) hash their bytes; streams fall
// back to size+mtime (still correct, just re-downloads unchanged files on redeploy).
const etagCache = new Map<string, { mtime: number; size: number; etag: string }>();
async function etagFor(key: string, st: Stored): Promise<string> {
  const c = etagCache.get(key);
  if (c && c.mtime === st.mtime && c.size === st.size) return c.etag;
  let etag = `"${st.size.toString(16)}-${Math.floor(st.mtime / 1000).toString(16)}"`;
  const body = st.body as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof body.arrayBuffer === "function") {
    try {
      etag = `"${Bun.hash(await body.arrayBuffer()).toString(16)}"`;
    } catch {
      /* keep the size+mtime fallback */
    }
  }
  etagCache.set(key, { mtime: st.mtime, size: st.size, etag });
  return etag;
}

async function respond(req: Request, site: string, path: string, st: Stored): Promise<Response> {
  const etag = await etagFor(`${site}:${path}`, st);
  const res = new Response(st.body, { headers: { etag, "cache-control": cacheControl(path) } });
  return checkEtag(req, res);
}

function checkEtag(req: Request, res: Response): Response {
  const inm = req.headers.get("if-none-match");
  const etag = res.headers.get("etag");
  if (inm && etag && inm === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return res;
}

export async function serveSite(req: Request, site: string, pathname: string): Promise<Response | null> {
  let path = decodeURIComponent(pathname);
  if (path.endsWith("/")) path += "index.html";

  const tryServe = async (p: string): Promise<Response | null> => {
    const st = await store.readSite(site, p);
    return st ? await respond(req, site, p, st) : null;
  };

  let res = await tryServe(path);
  if (res) return res;

  // Extensionless pretty paths: /about -> /about.html, then /about/index.html.
  if (!path.includes(".", path.lastIndexOf("/"))) {
    for (const candidate of [`${path}.html`, join(path, "index.html")]) {
      res = await tryServe(candidate);
      if (res) return res;
    }
  }

  if (await spaFallback(site)) {
    res = await tryServe("index.html");
    if (res) return res;
  }
  return null;
}

const SITE_404 = (site: string) => `<!doctype html>
<meta charset="utf-8"><title>404 · worlds</title>
<style>body{font:15px/1.6 ui-monospace,monospace;background:#101012;color:#e4e4e7;display:grid;place-items:center;min-height:100vh}a{color:#e5a00d}</style>
<div><h1>this world doesn't exist (yet)</h1>
<p><code>worlds deploy</code> a folder named <b>${site}</b> and it will.</p>
<p><a href="/">← back to the universe</a></p></div>`;

export function siteNotFound(site: string): Response {
  return new Response(SITE_404(site), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
