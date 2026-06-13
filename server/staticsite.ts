import { join } from "node:path";
import { store, type Stored } from "./blobstore";
import { spaFallback } from "./sites";

// Caching contract (docs/PLAN.md Q2): HTML no-cache + ETag so overwrite-deploys
// show immediately; other assets get a short stale-while-revalidate window.
function respond(req: Request, path: string, st: Stored): Response {
  const isHtml = path.endsWith(".html") || path.endsWith("/");
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtime / 1000).toString(16)}"`;
  const res = new Response(st.body, {
    headers: {
      etag,
      "cache-control": isHtml ? "no-cache" : "max-age=60, stale-while-revalidate=600",
    },
  });
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
    return st ? respond(req, p, st) : null;
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
