import { join } from "node:path";
import { config } from "./config";
import { WorldsError, asWorldsError, json, jsonError } from "./errors";
import { identityFrom, requireCsrf } from "./identity";
import { store } from "./blobstore";
import { initDb, sql, requireDb, onDbReady } from "./db";
import { handleDeploy, handleDeployFolder } from "./deploy";
import { serveSite, siteNotFound } from "./staticsite";
import { getSiteOr404, listSites, publicSite, siteUrl, bumpVisit, getSite } from "./sites";
import * as dbapi from "./dbapi";
import * as docs from "./docs";
import * as uploads from "./uploads";
import * as ai from "./ai";
import { notifySlack } from "./notify";
import { universe, universeEntry, creator } from "./universe";
import { resolveProfile, updateProfile, overlayCreators } from "./profile";
import { handleMcp } from "./mcp";
import { handleAuth, sessionFrom, validRenderToken, snapshotSetCookie } from "./auth";
import { seedWorlds } from "./seed";
import { websocket, type SocketData } from "./ws";
import { timestampKeysetBefore } from "./dialect";

await store.init();
// Registered before initDb so an install that boots ahead of postgres still gets its
// universe once the connection lands, instead of staying empty until a manual restart.
onDbReady(seedWorlds);
await initDb();
await seedWorlds(); // joins the hook's run when the db was up at boot

const HOMEPAGE_DIR = new URL("../homepage", import.meta.url).pathname;
const SDK_DIR = new URL("../sdk", import.meta.url).pathname;
const DOCS_DIR = new URL("../docs", import.meta.url).pathname;
const TUTORIAL_DIR = new URL("../tutorial", import.meta.url).pathname;
const DOCSITE_DIR = new URL("../docsite", import.meta.url).pathname;

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

// Reading order for the LLM-facing index and the concatenated llms-full.txt; any page
// not listed is appended alphabetically, so a new doc is never silently left out.
const DOC_ORDER = ["quickstart.md", "sdk.md", "reference.md", "limits.md"];

async function docPages(): Promise<string[]> {
  const pages: string[] = [];
  for await (const f of new Bun.Glob("*.md").scan(DOCS_DIR)) pages.push(f);
  const rank = (p: string) => (DOC_ORDER.includes(p) ? DOC_ORDER.indexOf(p) : DOC_ORDER.length);
  return pages.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// A page's first paragraph, trimmed to one line — the blurb llms.txt shows next to its link.
function blurb(md: string): string {
  const lines = md.split("\n");
  let i = lines.findIndex((l) => l.trim() && !/^(#|<!--|```|\|)/.test(l));
  const para: string[] = [];
  while (i >= 0 && i < lines.length && lines[i]!.trim()) para.push(lines[i++]!.trim());
  const text = para.join(" ");
  return text.length > 160 ? `${text.slice(0, 157).replace(/\s+\S*$/, "")}…` : text;
}

async function llmsTxt(full: boolean): Promise<Response> {
  const pages = await docPages();
  const headers = { "content-type": "text/plain; charset=utf-8" };
  if (!full) {
    const lines = [
      "# Worlds",
      "",
      "> Deploy a folder of static files, get `<name>.<your-domain>` with a batteries-included client SDK — database, AI, uploads, realtime, identity — behind one `<script src=\"/worlds.js\">` tag. No keys, no config.",
      "",
      "## Docs",
      "",
    ];
    for (const p of pages) lines.push(`- [${p.replace(".md", "")}](/docs/${p}): ${blurb(await Bun.file(join(DOCS_DIR, p)).text())}`);
    lines.push(
      "",
      "## Optional",
      "",
      "- [llms-full.txt](/llms-full.txt): every page above in one file",
      "- [interactive docs](/docs): the human-facing site — every primitive explained and running live",
      "- [MCP](/mcp): deploy_site, list_sites, get_site, my_sites, db_query, read_docs, search_docs",
    );
    return new Response(lines.join("\n"), { headers });
  }
  let out = "";
  for (const p of pages) out += `\n\n<!-- ${p} -->\n\n` + (await Bun.file(join(DOCS_DIR, p)).text());
  return new Response(out.trim(), { headers });
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

  // Every deploy on the instance, newest first. The per-site list above answers "what
  // happened to this world"; this one answers "what is happening here", which is what an
  // activity feed needs and cannot assemble from N per-site calls.
  if (p[0] === "deploys" && p.length === 1 && method === "GET") {
    requireDb();
    const limit = dbapi.clampLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    let where = "";
    const args: unknown[] = [];
    if (cursor) {
      const raw = Buffer.from(cursor, "base64").toString();
      const at = raw.slice(0, raw.indexOf("|"));
      const id = raw.slice(raw.indexOf("|") + 1);
      if (!at || !id) throw new WorldsError("invalid_request", "bad cursor");
      args.push(at, id);
      where = `WHERE ${timestampKeysetBefore("at", "deploy_id", "$1", "$2")}`;
    }
    const rows = (await sql.unsafe(
      `SELECT deploy_id, site, by_handle, by_name, files, bytes, at FROM deploys
       ${where} ORDER BY at DESC, deploy_id DESC LIMIT ${limit + 1}`,
      args as never[],
    )) as Record<string, unknown>[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return json({
      items: page.map((r) => ({
        deploy_id: r.deploy_id,
        site: r.site,
        by: { handle: r.by_handle, name: r.by_name },
        at: r.at,
        files: Number(r.files),
        bytes: Number(r.bytes),
      })),
      next_cursor: rows.length > limit && last
        ? Buffer.from(`${new Date(last.at as string).toISOString()}|${last.deploy_id}`).toString("base64")
        : null,
    });
  }

  if (p[0] === "sites") {
    requireDb();
    if (p.length === 1 && method === "GET") {
      const items = (await listSites({
        creator: url.searchParams.get("creator") ?? undefined,
        search: url.searchParams.get("q") ?? undefined,
        limit: dbapi.clampLimit(url.searchParams.get("limit")),
      })).map(publicSite);
      await overlayCreators(items);
      return json({ items, next_cursor: null });
    }
    if (p.length === 2 && method === "GET") {
      const entry = universeEntry(await getSiteOr404(p[1]!));
      await overlayCreators([entry]); // the display handle, as the list endpoint returns
      return json(entry);
    }
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

  // Collaborative documents over HTTP — for scripts and services; browsers use the socket.
  if (p[0] === "docs") {
    if (method !== "GET") requireCsrf(req);
    const who = identityFrom(req);
    if (p.length === 1 && method === "GET") return json({ items: await docs.listDocs(site), next_cursor: null });
    const name = p[1]!;
    if (p.length === 2 && method === "DELETE") {
      // Writes are open to anyone signed in (the schema is the guard); deleting is not.
      const s = await getSite(site);
      const contributor = !!s && (s.creator === who.handle || s.contributors.includes(who.handle));
      if (!contributor) throw new WorldsError("forbidden", "only a site contributor may delete documents");
      return json(await docs.deleteDoc(site, name));
    }
    if (p.length === 2 && method === "GET") {
      const room = await docs.getRoom(site, name);
      const s = room.snapshotState();
      return json({ name, epoch: s.epoch, seq: s.seq, state: docs.b64(s.state), bytes: room.stateBytes });
    }
    if (p.length === 3 && p[2] === "updates") {
      const room = await docs.getRoom(site, name);
      if (method === "GET") {
        const epoch = Number(url.searchParams.get("epoch"));
        const since = Number(url.searchParams.get("since"));
        const tail = Number.isFinite(epoch) && Number.isFinite(since) ? await room.updatesSince(epoch, since) : null;
        if (!tail) throw new WorldsError("replay_expired", "epoch or seq too old — fetch the state", undefined, { epoch: room.epoch, seq: room.seq });
        return json({ epoch: room.epoch, seq: room.seq, updates: tail.map(docs.b64) });
      }
      if (method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { epoch?: unknown; update?: unknown };
        const seq = await room.submit(who, Number(body.epoch), docs.fromB64(body.update), null, null);
        return json({ epoch: room.epoch, seq });
      }
    }
    if (p.length === 3 && p[2] === "rotate" && method === "POST") {
      const room = await docs.getRoom(site, name);
      const body = (await req.json().catch(() => ({}))) as { epoch?: unknown; state?: unknown };
      const s = await room.rotate(who, Number(body.epoch), docs.fromB64(body.state));
      return json({ name, epoch: s.epoch, seq: s.seq, bytes: room.stateBytes });
    }
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
    // sendBeacon can't set headers, so path mode has to name its site in the body.
    // Subdomain mode already knows it from the Host — prefer that, so a page can't
    // pad another world's counter.
    let target = site;
    if (config.routing === "path") {
      const body = (await req.json().catch(() => ({}))) as { site?: string };
      target = typeof body.site === "string" ? body.site : site;
    }
    if (target && target !== "home") await bumpVisit(target);
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
          if (appSite === "docs") return (await serveBundled(DOCSITE_DIR, path)) ?? siteNotFound("docs");
          return (await serveSite(req, appSite, path)) ?? siteNotFound(appSite);
        }
      }

      // the `hello` host — the bundled tutorial (a reserved name, not a deployable site).
      if (site === "hello") return (await serveBundled(TUTORIAL_DIR, url.pathname)) ?? siteNotFound("hello");
      // the `docs` host — the bundled interactive docs (reserved, like `hello`).
      if (site === "docs") return (await serveBundled(DOCSITE_DIR, url.pathname)) ?? siteNotFound("docs");

      if (site === "home") {
        if (url.pathname === "/docs" || url.pathname === "/docs/") {
          // The interactive docs are their own site; the raw markdown stays at /docs/<page>.md.
          const target = config.routing === "path" ? "/app/docs/" : siteUrl("docs");
          return new Response(null, { status: 302, headers: { location: target } });
        }
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

// Open documents snapshot on the way out so a restart replays nothing.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    docs.closeAllRooms().finally(() => process.exit(0));
  });
}

const authLabel = config.dev ? "dev-stub" : config.authMode;
// publicOrigin when set, so the logged URL is the one people actually open rather than a
// guessed scheme plus the container's internal port.
const homepage = config.publicOrigin ?? `http://${config.baseDomain}:${server.port}`;
console.log(
  `worlds: listening on :${server.port} ` +
    `(base domain ${config.baseDomain}, routing ${config.routing}, auth ${authLabel})`,
);
console.log(`worlds: homepage ${homepage} · deploy POST /api/v1/deploy`);
