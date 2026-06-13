import { join } from "node:path";
import { WorldsError, asWorldsError } from "./errors";
import { identityFrom, type Identity } from "./identity";
import { deployFileMap } from "./deploy";
import { listSites, getSiteOr404, publicSite } from "./sites";
import { universeEntry } from "./universe";
import * as dbapi from "./dbapi";

// Minimal MCP server (JSON-RPC 2.0 over HTTP, "streamable HTTP" non-SSE variant).
// No SDK/deps — the surface is small and the wire format is stable. Tools are the
// agent-facing sugar over the same /api/v1 contract.
const DOCS_DIR = new URL("../docs", import.meta.url).pathname;
const PROTOCOL_VERSION = "2025-06-18";

function asText(value: unknown) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

interface Tool {
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, who: Identity): Promise<unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required, additionalProperties: false });

async function docPages(): Promise<string[]> {
  const pages: string[] = [];
  for await (const f of new Bun.Glob("*.md").scan(DOCS_DIR)) pages.push(f);
  return pages.sort();
}

const TOOLS: Record<string, Tool> = {
  deploy_site: {
    description: "Deploy a Worlds site from a map of file paths to text contents (index.html required at root). Returns the live URL.",
    inputSchema: obj(
      {
        name: { type: "string", description: "site name → its own subdomain (a-z, 0-9, dashes)" },
        files: { type: "object", description: "map of relative path → file contents, e.g. {\"index.html\": \"<!doctype html>…\"}" },
      },
      ["name", "files"],
    ),
    async run(args, who) {
      const files = args.files;
      if (typeof files !== "object" || files === null || Array.isArray(files)) {
        throw new WorldsError("invalid_request", "files must be an object of path → contents");
      }
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(files as Record<string, unknown>)) map[k] = String(v);
      return deployFileMap(String(args.name ?? ""), map, who);
    },
  },
  list_sites: {
    description: "List Worlds sites (newest first). Optional creator handle, search query, limit.",
    inputSchema: obj({
      creator: { type: "string" },
      q: { type: "string" },
      limit: { type: "number" },
    }),
    async run(args) {
      const sites = await listSites({
        creator: typeof args.creator === "string" ? args.creator : undefined,
        search: typeof args.q === "string" ? args.q : undefined,
        limit: Math.min(Number(args.limit ?? 50), 100),
      });
      return { items: sites.map(publicSite) };
    },
  },
  get_site: {
    description: "Get one site's metadata and universe layout by name.",
    inputSchema: obj({ name: { type: "string" } }, ["name"]),
    async run(args) {
      return universeEntry(await getSiteOr404(String(args.name ?? "")));
    },
  },
  my_sites: {
    description: "List the sites you (the calling identity) created or contributed to.",
    inputSchema: obj({}),
    async run(_args, who) {
      const sites = await listSites({ creator: who.handle, limit: 100 });
      return { items: sites.map(publicSite) };
    },
  },
  db_query: {
    description: "Read documents from a site's worlds.db collection. site defaults to 'home' (the platform site registry). Supports the v1 filter/sort grammar.",
    inputSchema: obj(
      {
        collection: { type: "string" },
        site: { type: "string", description: "which site's collection to read (default 'home')" },
        filter: { type: "object", description: "v1 filter, e.g. {\"votes\": {\"gt\": 0}}" },
        sort: { type: "string", description: "field or -field" },
        limit: { type: "number" },
      },
      ["collection"],
    ),
    async run(args) {
      const params = new URLSearchParams();
      if (args.filter) params.set("filter", JSON.stringify(args.filter));
      if (typeof args.sort === "string") params.set("sort", args.sort);
      params.set("limit", String(Math.min(Number(args.limit ?? 50), 100)));
      const site = typeof args.site === "string" && args.site ? args.site : "home";
      const res = await dbapi.listDocs(site, String(args.collection ?? ""), params);
      return res.json();
    },
  },
  read_docs: {
    description: "Read Worlds' docs. With no page, lists available pages; with a page name (e.g. 'sdk'), returns its markdown.",
    inputSchema: obj({ page: { type: "string", description: "doc page name without .md (e.g. 'sdk', 'quickstart', 'limits')" } }),
    async run(args) {
      const pages = await docPages();
      if (!args.page) return { pages: pages.map((p) => p.replace(".md", "")) };
      const file = `${String(args.page).replace(/\.md$/, "")}.md`;
      if (!pages.includes(file)) throw new WorldsError("not_found", `no doc page "${args.page}" (have: ${pages.map((p) => p.replace(".md", "")).join(", ")})`);
      return Bun.file(join(DOCS_DIR, file)).text();
    },
  },
  search_docs: {
    description: "Search Worlds' docs for a query string; returns matching pages with snippets.",
    inputSchema: obj({ query: { type: "string" } }, ["query"]),
    async run(args) {
      const q = String(args.query ?? "").toLowerCase();
      if (!q) throw new WorldsError("invalid_request", "expected {query}");
      const hits: { page: string; snippet: string }[] = [];
      for (const page of await docPages()) {
        const text = await Bun.file(join(DOCS_DIR, page)).text();
        const i = text.toLowerCase().indexOf(q);
        if (i >= 0) hits.push({ page: page.replace(".md", ""), snippet: text.slice(Math.max(0, i - 60), i + 120).trim() });
      }
      return { hits };
    },
  },
};

interface RpcReq {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

async function dispatch(msg: RpcReq, who: Identity): Promise<object | null> {
  const id = msg.id ?? null;
  // Notifications (no id) get no response.
  const isNotification = msg.id === undefined;

  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  try {
    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion: (msg.params?.protocolVersion as string) ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "worlds", version: "1" },
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
        });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const tool = TOOLS[name];
        if (!tool) return err(-32602, `unknown tool "${name}"`);
        try {
          const result = await tool.run((msg.params?.arguments as Record<string, unknown>) ?? {}, who);
          return ok(asText(result));
        } catch (e) {
          // MCP convention: tool failures are results with isError, not protocol errors.
          const we = asWorldsError(e);
          return ok({ ...asText(`${we.code}: ${we.message}`), isError: true });
        }
      }
      default:
        if (isNotification) return null; // ignore unknown notifications (e.g. notifications/initialized)
        return err(-32601, `method not found: ${msg.method}`);
    }
  } catch (e) {
    return err(-32603, (e as Error).message);
  }
}

export async function handleMcp(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("MCP endpoint — POST JSON-RPC 2.0", { status: 405, headers: { allow: "POST" } });
  }
  const who = identityFrom(req); // verified identity (dev → dev@localhost)
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }

  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as RpcReq[];
  const responses = (await Promise.all(msgs.map((m) => dispatch(m, who)))).filter((r): r is object => r !== null);

  if (responses.length === 0) return new Response(null, { status: 202 }); // all notifications
  return Response.json(batch ? responses : responses[0]);
}
