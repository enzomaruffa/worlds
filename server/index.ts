import { join } from "node:path";
import { config } from "./config";
import { WorldsError, asWorldsError, json, jsonError } from "./errors";
import { identityFrom, requireCsrf } from "./identity";
import { store } from "./blobstore";
import { initDb, sql, requireDb } from "./db";
import { handleDeploy, handleDeployFolder } from "./deploy";
import { serveSite, siteNotFound } from "./staticsite";
import { getSiteOr404, listSites, publicSite, siteUrl, bumpVisit, getSite } from "./sites";
import * as dbapi from "./dbapi";
import * as uploads from "./uploads";
import * as ai from "./ai";
import { notifySlack } from "./notify";
import { universe, universeEntry, creator } from "./universe";
import { resolveProfile, updateProfile, overlayCreators } from "./profile";
import { handleMcp } from "./mcp";
import { handleAuth, sessionFrom, validRenderToken, snapshotSetCookie } from "./auth";
import { seedWorlds } from "./seed";
import { websocket, type SocketData } from "./ws";

await store.init();
await initDb();
await seedWorlds();

const HOMEPAGE_DIR = new URL("../homepage", import.meta.url).pathname;
const SDK_DIR = new URL("../sdk", import.meta.url).pathname;
const DOCS_DIR = new URL("../docs", import.meta.url).pathname;
const TUTORIAL_DIR = new URL("../tutorial", import.meta.url).pathname;

// Default site favicon (a little ringed planet) — served for every site at
// /favicon.ico so pages don't 404 on the browser's implicit request.
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="#0c0c0f"/>' +
  '<circle cx="16" cy="16" r="7.5" fill="none" stroke="#f59e0b" stroke-width="2.5"/>' +
  '<circle cx="16" cy="16" r="2.6" fill="#fbbf24"/>' +
  '<circle cx="25" cy="9" r="1.3" fill="#fbbf24"/></svg>';

// Static dirs bundled into the server image and served at a fixed host (like home).
function serveBundled(dir: string, pathname: string): Promise<Response | null> {
  const f = Bun.file(join(dir, pathname === "/" ? "/index.html" : pathname));
  return f.exists().then((ok) => (ok ? new Response(f, { headers: { "cache-control": "no-cache" } }) : null));
}

// Host → site. "worlds.localhost" itself is the homepage (pseudo-site "home").
function siteFromHost(host: string): string {
  const bare = host.split(":")[0]!;
  if (bare === config.baseDomain.split(":")[0]) return "home";
  const suffix = `.${config.baseDomain.split(":")[0]}`;
  if (bare.endsWith(suffix)) return bare.slice(0, -suffix.length);
  return config.forwardSite || "home"; // unknown hosts (e.g. a tunnel) → forwarded site, else homepage
}

// The calling site for an API/socket request. Subdomain mode: from Host. Path mode:
// all sites share the apex origin, so the SDK declares its site via the
// `x-worlds-site` header (fetch) or `?site` (socket); static /app/<site>/ is routed by path.
function siteFromRequest(req: Request, url: URL): string {
  if (config.routing === "path") {
    return req.headers.get("x-worlds-site") || url.searchParams.get("site") || "home";
  }
  return siteFromHost(req.headers.get("host") ?? "");
}

function loader(file: string, immutable: boolean): Promise<Response | null> {
  const f = Bun.file(join(SDK_DIR, file));
  return f.exists().then((ok) =>
    ok
      ? new Response(f, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            // Evergreen /worlds.js is no-store so a new SDK reaches every site
            // immediately (Cloudflare rewrites a .js max-age to a multi-hour edge
            // TTL but honors no-store) — sites that need to pin use /v1/worlds.js.
            "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
          },
        })
      : null,
  );
}

async function llmsTxt(full: boolean): Promise<Response> {
  const glob = new Bun.Glob("*.md");
  const pages: string[] = [];
  for await (const f of glob.scan(DOCS_DIR)) pages.push(f);
  pages.sort();
  if (!full) {
    const lines = ["# Worlds", "", "> Deploy a folder, get a website. Internal hosting for Plex.", "", "## Docs", ""];
    for (const p of pages) lines.push(`- [${p.replace(".md", "")}](/docs/${p})`);
    return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  let out = "";
  for (const p of pages) out += `\n\n<!-- ${p} -->\n\n` + (await Bun.file(join(DOCS_DIR, p)).text());
  return new Response(out.trim(), { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function api(req: Request, url: URL, site: string): Promise<Response> {
  const { pathname } = url;
  const seg = pathname.split("/").filter(Boolean); // ["api","v1",...]
  const method = req.method;
  const p = seg.slice(2);

  if (p[0] === "me") {
    const who = identityFrom(req);
    if (method === "GET") {
      const prof = await resolveProfile(who.handle, who.email);
      return json({ email: who.email, handle: prof.handle, name: prof.name, avatar_url: prof.avatar_url });
    }
    if (method === "PUT") {
      requireCsrf(req);
      const prof = await updateProfile(who.handle, who.email, await req.json().catch(() => ({})));
      return json({ email: who.email, handle: prof.handle, name: prof.name, avatar_url: prof.avatar_url });
    }
  }
  if (p[0] === "site" && method === "GET") {
    const s = await getSite(site);
    return json({ name: site, url: siteUrl(site), status: s?.status ?? "live" });
  }
  if (p[0] === "deploy" && method === "POST") return handleDeploy(req);
  if (p[0] === "deploy-folder" && method === "POST") return handleDeployFolder(req);

  if (p[0] === "sites") {
    requireDb();
    if (p.length === 1 && method === "GET") {
      const items = (await listSites({
        creator: url.searchParams.get("creator") ?? undefined,
        search: url.searchParams.get("q") ?? undefined,
        limit: Math.min(Number(url.searchParams.get("limit") ?? 50), 100),
      })).map(publicSite);
      await overlayCreators(items);
      return json({ items, next_cursor: null });
    }
    if (p.length === 2 && method === "GET") return json(universeEntry(await getSiteOr404(p[1]!)));
    if (p.length === 3 && p[2] === "deploys" && method === "GET") {
      await getSiteOr404(p[1]!);
      const rows = await sql`
        SELECT deploy_id, by_handle, by_name, files, bytes, at FROM deploys
        WHERE site = ${p[1]} ORDER BY at DESC LIMIT 50`;
      return json({
        items: rows.map((r: Record<string, unknown>) => ({
          deploy_id: r.deploy_id,
          by: { handle: r.by_handle, name: r.by_name },
          at: r.at,
          files: Number(r.files),
          bytes: Number(r.bytes),
        })),
        next_cursor: null,
      });
    }
  }

  if (p[0] === "db") {
    if (method !== "GET") requireCsrf(req);
    const who = identityFrom(req);
    // Cross-world READS are open by default (?site=other) — writes always stay
    // Host-scoped. Inside the trust boundary hiding reads would be theater.
    const readSite = url.searchParams.get("site") || site;
    if (p.length === 1 && method === "GET") return dbapi.listCollections(readSite);
    const collection = p[1]!;
    if (p.length === 2) {
      if (method === "POST") return dbapi.createDoc(site, collection, await req.json().catch(() => null), who);
      if (method === "GET") return dbapi.listDocs(readSite, collection, url.searchParams);
    }
    if (p.length === 3) {
      const id = p[2]!;
      const pre = req.headers.get("if-unmodified-since-version");
      if (method === "GET") return dbapi.getDoc(readSite, collection, id);
      if (method === "PATCH") return dbapi.patchDoc(site, collection, id, await req.json().catch(() => null), "merge", pre);
      if (method === "PUT") return dbapi.patchDoc(site, collection, id, await req.json().catch(() => null), "replace", pre);
      if (method === "DELETE") return dbapi.deleteDoc(site, collection, id);
    }
    if (p.length === 4 && p[3] === "increment" && method === "POST") {
      return dbapi.incrementDoc(site, collection, p[2]!, await req.json().catch(() => null));
    }
  }

  if (p[0] === "uploads") {
    if (method === "POST") return uploads.putUpload(req, site);
    if (method === "GET") return uploads.listUploads(site);
    if (method === "DELETE" && p[1]) return uploads.deleteUpload(req, site, p[1]);
  }

  if (p[0] === "ai") {
    if (p[1] === "complete" && method === "POST") return ai.complete(req);
    if (p[1] === "embed" && method === "POST") return ai.embed(req);
    if (p[1] === "image" && method === "POST") return ai.image(req, site);
    if (p[1] === "models" && method === "GET") return ai.models();
  }

  if (p[0] === "notify" && p[1] === "slack" && method === "POST") return notifySlack(req, site);
  if (p[0] === "universe" && method === "GET") return universe();
  if (p[0] === "creators" && p[1] && method === "GET") return creator(p[1]);
  if (p[0] === "beacon" && p[1] === "visit" && method === "POST") {
    const { site: target } = (await req.json().catch(() => ({}))) as { site?: string };
    if (target) await bumpVisit(target);
    return new Response(null, { status: 204 });
  }
  if (p[0] === "meta" && method === "GET") return json({ api_version: 1, build: "dev" });

  throw new WorldsError("not_found", `no such endpoint: ${method} ${pathname}`);
}

const server = Bun.serve<SocketData, never>({
  port: config.port,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const site = siteFromRequest(req, url);
    try {
      // Built-in sign-in routes (google mode).
      if (url.pathname.startsWith("/auth/")) return await handleAuth(req, url.pathname);

      // Sign-in wall: in google mode, gate everything but auth + health. HTML
      // navigations bounce to Google sign-in (on the base origin, so the cookie
      // is base-domain-scoped and covers every world); other requests get 401.
      if (config.authMode === "google" && !config.dev) {
        const exempt = url.pathname === "/healthz" || url.pathname === "/readyz";
        if (!exempt && !sessionFrom(req)) {
          // headless screenshot bot: a valid render token → brief snapshot session, then
          // redirect to the clean URL so the captured page (and its API calls) are authed.
          if (validRenderToken(url.searchParams.get("__render"))) {
            url.searchParams.delete("__render");
            return new Response(null, {
              status: 302,
              headers: { location: `${url.pathname}${url.search}`, "set-cookie": snapshotSetCookie() },
            });
          }
          if (req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html")) {
            const base = config.publicOrigin ?? `${url.protocol}//${config.baseDomain}`;
            // Build the return target off the public origin too — behind a tunnel
            // url.href is http, which would bounce the user through an extra upgrade.
            const rd = `${base}${url.pathname}${url.search}`;
            return Response.redirect(`${base}/auth/login?rd=${encodeURIComponent(rd)}`, 302);
          }
          return jsonError(new WorldsError("unauthorized", "sign in required"));
        }
      }

      // The one multiplexed socket. Presence + message `from` MUST use the same
      // profile-resolved identity as /api/v1/me — otherwise a user who customizes
      // their handle/name shows up in presence under their raw login identity and
      // games see them as a second, different player.
      if (url.pathname === "/api/v1/socket") {
        const raw = identityFrom(req);
        const prof = await resolveProfile(raw.handle, raw.email);
        const who = { email: raw.email, handle: prof.handle, name: prof.name, avatar: prof.avatar_url };
        if (srv.upgrade(req, { data: { who, site, subs: new Map() } })) return undefined as never;
        throw new WorldsError("invalid_request", "expected websocket upgrade");
      }
      if (url.pathname === "/mcp") return await handleMcp(req);
      if (url.pathname.startsWith("/api/")) return await api(req, url, site);

      if (url.pathname === "/healthz" || url.pathname === "/readyz") return new Response("ok");
      // A default favicon for every site (sites rarely ship one) — keeps the
      // browser console clean instead of a 404 per page load.
      if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") {
        return new Response(FAVICON_SVG, {
          headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
        });
      }
      if (url.pathname === "/worlds.js") return (await loader("worlds.js", false)) ?? siteNotFound(site);
      if (url.pathname === "/v1/worlds.js") return (await loader("worlds.js", true)) ?? siteNotFound(site);
      if (url.pathname === "/llms.txt") return llmsTxt(false);
      if (url.pathname === "/llms-full.txt") return llmsTxt(true);

      if (url.pathname.startsWith("/u/")) {
        const [, , uSite, ...rest] = url.pathname.split("/");
        if (uSite && rest.length) return await uploads.serveUpload(uSite, rest.join("/"));
      }

      // A creator's public profile + the worlds they've shipped. The handle is
      // read client-side from the path; the page calls GET /api/v1/creators/<h>.
      // (This is the "/@<handle>" URL the homepage profile dialog promises.)
      if (url.pathname.startsWith("/@")) {
        return (await serveBundled(HOMEPAGE_DIR, "/profile.html")) ?? siteNotFound(site);
      }

      // Path-routing mode: /app/<site>/… serves that site off the apex origin
      // (no wildcard DNS/cert). Sites must use relative asset paths.
      if (config.routing === "path" && url.pathname.startsWith("/app/")) {
        const [, , appSite, ...rest] = url.pathname.split("/");
        if (appSite) {
          // relative Location so it inherits the client's scheme (https), not the
          // plain-http the server sees behind a tunnel.
          if (rest.length === 0) return new Response(null, { status: 308, headers: { location: `/app/${appSite}/` } });
          const path = `/${rest.join("/")}`;
          if (appSite === "hello") return (await serveBundled(TUTORIAL_DIR, path)) ?? siteNotFound("hello");
          return (await serveSite(req, appSite, path)) ?? siteNotFound(appSite);
        }
      }

      // the `hello` host — the bundled tutorial (a reserved name, not a deployable site).
      if (site === "hello") return (await serveBundled(TUTORIAL_DIR, url.pathname)) ?? siteNotFound("hello");

      if (site === "home") {
        if (url.pathname.startsWith("/docs/") && url.pathname.endsWith(".md")) {
          const rel = url.pathname.slice("/docs/".length);
          const full = join(DOCS_DIR, rel);
          if (full.startsWith(DOCS_DIR)) { // guard against ../ traversal
            const f = Bun.file(full);
            if (await f.exists()) {
              return new Response(f, { headers: { "content-type": "text/markdown; charset=utf-8" } });
            }
          }
        }
        const path = url.pathname === "/" ? "/index.html" : url.pathname;
        const f = Bun.file(join(HOMEPAGE_DIR, path));
        if (await f.exists()) {
          return new Response(f, { headers: { "cache-control": "no-cache" } });
        }
        return siteNotFound("home");
      }

      const res = await serveSite(req, site, url.pathname);
      return res ?? siteNotFound(site);
    } catch (e) {
      return jsonError(asWorldsError(e));
    }
  },
  websocket,
});

console.log(`worlds: listening on :${server.port} (base domain ${config.baseDomain}, dev=${config.dev})`);
console.log(`worlds: homepage http://${config.baseDomain}:${server.port} · deploy POST /api/v1/deploy`);
