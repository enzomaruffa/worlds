import { config, LIMITS } from "./config";
import type { ConnectorConfig, SiteGrant } from "./connectors";
import { sql, requireDb } from "./db";
import { jsonParam } from "./dialect";
import { WorldsError, json } from "./errors";
import { identityFrom, requireCsrf } from "./identity";
import { callTool, listTools, type RemoteTool } from "./mcpclient";
import { resolveProfile } from "./profile";
import { allowConnect, takeQuota } from "./ratelimit";
import { siteUrl } from "./sites";

// Sites call external services through the platform's own credential. The browser never
// sees a key, and a site can only reach what an operator granted it in the environment.
//
// In path routing the calling site is a header the client supplies, so the allowlist
// stops accidents rather than people. The audit row is keyed on the session identity,
// which is not forgeable, and that is the control that actually holds.

function connectorFor(name: string): ConnectorConfig | null {
  return config.connectors.find((c) => c.name === name) ?? null;
}

// A site with no grant gets the same answer as a connector that does not exist, so a
// page cannot probe which connectors an instance has.
function grantFor(name: string, site: string): { cfg: ConnectorConfig; grant: SiteGrant; token: string } {
  const cfg = connectorFor(name);
  const grant = cfg?.sites[site];
  if (!cfg || !grant) throw new WorldsError("not_found", `no connector "${name}" for this site`);
  const token = process.env[cfg.tokenEnv];
  if (!token) throw new WorldsError("upstream_error", `connector "${name}" is not configured — ${cfg.tokenEnv} is unset`);
  return { cfg, grant, token };
}

export async function list(req: Request, site: string): Promise<Response> {
  identityFrom(req);
  const items = config.connectors
    .filter((c) => c.sites[site])
    .map((c) => ({ name: c.name, tools: c.sites[site]!.tools }));
  return json({ items, next_cursor: null });
}

export async function tools(req: Request, site: string, name: string): Promise<Response> {
  identityFrom(req);
  const { cfg, grant, token } = grantFor(name, site);
  const all = await listTools(cfg.name, { url: cfg.url, token });
  const allowed = new Set(grant.tools);
  const items: RemoteTool[] = all.filter((t) => allowed.has(t.name));
  return json({ items, next_cursor: null });
}

export async function call(req: Request, site: string, name: string): Promise<Response> {
  requireCsrf(req);
  const who = identityFrom(req);
  const { cfg, grant, token } = grantFor(name, site);

  const body = (await req.json().catch(() => ({}))) as { tool?: unknown; args?: unknown };
  const tool = typeof body.tool === "string" ? body.tool : "";
  if (!tool) throw new WorldsError("invalid_request", "expected {tool, args?}");
  if (body.args !== undefined && (typeof body.args !== "object" || body.args === null || Array.isArray(body.args))) {
    throw new WorldsError("invalid_request", "args must be an object");
  }
  // Granted the connector but not this tool: say so, because the site author has to fix it.
  if (!grant.tools.includes(tool)) throw new WorldsError("forbidden", `"${tool}" is not allowed for this site`);

  const caller = (body.args ?? {}) as Record<string, unknown>;
  if (JSON.stringify(caller).length > LIMITS.connectArgsBytes) {
    throw new WorldsError("payload_too_large", `args over ${LIMITS.connectArgsBytes} bytes`);
  }

  takeQuota("connect", who.handle);
  allowConnect(site);

  // Forced arguments win over anything the caller sent. This is what an allowlist on tool
  // names alone cannot do: the site may file an issue and may not choose the team, even
  // if someone rewrites the page's JavaScript.
  const sent: Record<string, unknown> = { ...caller, ...(grant.args[tool] ?? {}) };
  const profile = await resolveProfile(who.handle, who.email);
  for (const field of grant.stamp[tool] ?? []) {
    const existing = typeof sent[field] === "string" ? (sent[field] as string) : "";
    sent[field] = `${existing}${existing ? "\n\n" : ""}---\n_via ${siteUrl(site)} · requested by ${profile.name} (${who.email})_`;
  }

  // The row goes in before the call, so a request that goes out and never comes back is
  // still on the record — that is the whole point of the table.
  requireDb();
  const id = `cc_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const recorded = JSON.stringify(sent);
  const stored = recorded.length > 4096 ? { _truncated: recorded.length } : sent;
  await sql`
    INSERT INTO connector_calls (id, connector, tool, site, by_handle, by_email, args, outcome)
    VALUES (${id}, ${cfg.name}, ${tool}, ${site}, ${profile.handle}, ${who.email}, ${jsonParam(stored)}, 'pending')`;

  const started = Date.now();
  let settled = false;
  const record = async (outcome: string, detail: string | null) => {
    if (settled) return;
    settled = true;
    await sql`UPDATE connector_calls SET outcome = ${outcome}, detail = ${detail}, ms = ${Date.now() - started} WHERE id = ${id}`.catch(() => {});
  };
  try {
    const out = await callTool(cfg.name, { url: cfg.url, token }, tool, sent);
    if (out.isError) {
      const detail = String(out.value).slice(0, 300);
      await record("error", detail);
      // The tool's own message, not an HTTP body — safe to surface, and the caller needs
      // it to be actionable.
      throw new WorldsError("upstream_error", `connector: ${detail}`);
    }
    await record("ok", null);
    return json({ ok: true, connector: cfg.name, tool, result: out.value });
  } catch (e) {
    const message = String((e as Error)?.message ?? "");
    await record(message.includes("timed out") ? "timeout" : "error", message.slice(0, 300));
    throw e;
  }
}

