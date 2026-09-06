import { readFileSync } from "node:fs";

// Operator-declared external services a site may reach through the platform's own
// credential. The registry lives in the environment, next to the token, because that is
// the one place an unprivileged user provably cannot reach: a `.world.json` key or a
// `sites` column is written by whoever deployed the site, so a site could grant itself
// access to a credential it should never hold.
//
//   WORLDS_CONNECTORS='[{"name":"linear","url":"https://mcp.linear.app/mcp",
//                        "token_env":"LINEAR_MCP_TOKEN",
//                        "sites":{"retro":{"tools":["create_issue"],
//                                          "args":{"create_issue":{"teamId":"…"}},
//                                          "stamp":{"create_issue":["description"]}}}}]'
//
// See docs/quickstart.md "Connectors".

export interface SiteGrant {
  tools: string[];
  args: Record<string, Record<string, unknown>>; // tool -> arguments forced server-side
  stamp: Record<string, string[]>; // tool -> which text fields get the provenance line
}

export interface ConnectorConfig {
  name: string;
  url: string;
  tokenEnv: string;
  sites: Record<string, SiteGrant>;
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

// A malformed registry fails the boot. Dropping a bad entry silently would leave an
// operator believing a connector is wired up when every call 404s.
function bad(msg: string): never {
  throw new Error(`WORLDS_CONNECTORS: ${msg}`);
}

function parseGrant(where: string, raw: unknown): SiteGrant {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad(`${where} must be an object`);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["tools", "args", "stamp"].includes(k)) bad(`${where}.${k} is not a known grant key`);
  if (!Array.isArray(r.tools) || !r.tools.length || !r.tools.every((t) => typeof t === "string" && t)) {
    bad(`${where}.tools must be a non-empty array of tool names`);
  }
  const tools = r.tools as string[];
  const args: SiteGrant["args"] = {};
  if (r.args !== undefined) {
    if (typeof r.args !== "object" || r.args === null || Array.isArray(r.args)) bad(`${where}.args must be an object`);
    for (const [tool, v] of Object.entries(r.args as Record<string, unknown>)) {
      if (!tools.includes(tool)) bad(`${where}.args.${tool} is not in tools`);
      if (typeof v !== "object" || v === null || Array.isArray(v)) bad(`${where}.args.${tool} must be an object`);
      args[tool] = v as Record<string, unknown>;
    }
  }
  const stamp: SiteGrant["stamp"] = {};
  if (r.stamp !== undefined) {
    if (typeof r.stamp !== "object" || r.stamp === null || Array.isArray(r.stamp)) bad(`${where}.stamp must be an object`);
    for (const [tool, v] of Object.entries(r.stamp as Record<string, unknown>)) {
      if (!tools.includes(tool)) bad(`${where}.stamp.${tool} is not in tools`);
      if (!Array.isArray(v) || !v.every((f) => typeof f === "string" && f)) bad(`${where}.stamp.${tool} must be an array of field names`);
      stamp[tool] = v as string[];
    }
  }
  return { tools, args, stamp };
}

export function parseConnectors(raw: string | undefined, dev: boolean): ConnectorConfig[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    bad("not valid JSON");
  }
  if (!Array.isArray(parsed)) bad("must be a JSON array");
  const out: ConnectorConfig[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) bad("each entry must be an object");
    const r = item as Record<string, unknown>;
    const name = String(r.name ?? "");
    if (!NAME.test(name)) bad(`"${name}" is not a valid connector name (a-z, digits, dashes)`);
    if (seen.has(name)) bad(`"${name}" appears twice`);
    seen.add(name);
    const url = String(r.url ?? "");
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      bad(`${name}.url is not a URL`);
    }
    // Plain http would put the platform's credential on the wire in clear text. The dev
    // exception exists so the test suite can point at a local stub.
    const localDev = dev && (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1");
    if (parsedUrl.protocol !== "https:" && !localDev) bad(`${name}.url must be https`);
    const tokenEnv = String(r.token_env ?? "");
    if (!tokenEnv) bad(`${name}.token_env is required — the token itself never goes in this blob`);
    const sitesRaw = r.sites;
    if (typeof sitesRaw !== "object" || sitesRaw === null || Array.isArray(sitesRaw)) bad(`${name}.sites must be an object`);
    const sites: Record<string, SiteGrant> = {};
    for (const [site, grant] of Object.entries(sitesRaw as Record<string, unknown>)) {
      sites[site] = parseGrant(`${name}.sites.${site}`, grant);
    }
    out.push({ name, url, tokenEnv, sites });
  }
  return out;
}

export function loadConnectors(dev: boolean): ConnectorConfig[] {
  const file = process.env.WORLDS_CONNECTORS_FILE;
  const raw = file ? readFileSync(file, "utf8") : process.env.WORLDS_CONNECTORS;
  return parseConnectors(raw, dev);
}
