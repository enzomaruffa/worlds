import { WorldsError } from "./errors";

// Outbound MCP: Worlds as a *client* of a remote MCP server, so a static site can reach
// Linear/GitHub/Sentry without ever holding a credential. The inbound half lives in
// mcp.ts; nothing is shared between them but the wire vocabulary.
//
// Streamable HTTP POST only. Worlds asks and gets an answer, so the server-initiated
// half of the spec (sampling, elicitation, the long-lived GET stream) is out of scope.

const PROTOCOL_VERSION = "2025-06-18";
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 20_000;
const TOOLS_TTL_MS = 10 * 60 * 1000;

export interface RemoteTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface Session {
  sessionId: string | null;
  protocolVersion: string;
}

interface Entry {
  session: Promise<Session> | null;
  tools: { at: number; list: RemoteTool[] } | null;
}

const entries = new Map<string, Entry>();

function entryFor(name: string): Entry {
  let e = entries.get(name);
  if (!e) entries.set(name, (e = { session: null, tools: null }));
  return e;
}

// Drop everything cached for a connector — a bad session id or a rotated token means the
// next call must start from `initialize` rather than replaying a dead handshake.
export function resetConnector(name: string): void {
  entries.delete(name);
}

let nextId = 1;

interface RpcOk { result?: unknown; error?: { code: number; message: string } }

/**
 * One JSON-RPC round trip. Reads either a JSON body or a single-event SSE stream — the
 * spec lets the server pick per response, and a streamable-HTTP server is more likely
 * than not to answer a tool call as a stream.
 */
async function rpc(
  cfg: { url: string; token: string },
  session: Session | null,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const id = nextId++;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${cfg.token}`,
  };
  if (session) {
    headers["mcp-protocol-version"] = session.protocolVersion;
    if (session.sessionId) headers["mcp-session-id"] = session.sessionId;
  }

  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const aborted = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new WorldsError("upstream_error", aborted ? "connector timed out" : "connector is unreachable");
  }

  if (!res.ok) {
    // The upstream body can echo the credential back. It goes to the log, never to a caller.
    const text = await res.text().catch(() => "");
    console.error("mcp client error", cfg.url, res.status, text.slice(0, 500));
    if (res.status === 401 || res.status === 403) throw new WorldsError("upstream_error", "connector rejected the platform's credential");
    if (res.status === 404 && session?.sessionId) throw new WorldsError("conflict", "connector session expired");
    throw new WorldsError("upstream_error", `connector returned ${res.status}`);
  }

  const sessionId = res.headers.get("mcp-session-id");
  const body = await readFrame(res, id);
  if (body.error) throw new WorldsError("upstream_error", `connector: ${body.error.message}`);
  if (sessionId && session) session.sessionId = sessionId;
  return body.result;
}

// The response must answer the request we sent. Matching on id rather than position is
// what stops a replayed or interleaved frame being read as this call's result.
async function readFrame(res: Response, wantId: number): Promise<RpcOk> {
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.startsWith("text/event-stream")) {
    const j = (await res.json().catch(() => null)) as { id?: unknown } & RpcOk | null;
    if (!j || j.id !== wantId) throw new WorldsError("upstream_error", "connector sent a mismatched response");
    return j;
  }
  if (!res.body) throw new WorldsError("upstream_error", "connector sent an empty stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const j = safeJson(line.slice(5).trim()) as ({ id?: unknown } & RpcOk) | null;
        if (j && j.id === wantId) return j;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new WorldsError("upstream_error", "connector stream ended without a response");
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// Lazy, cached, and shared: twenty simultaneous first calls run one handshake between them.
function handshake(name: string, cfg: { url: string; token: string }): Promise<Session> {
  const e = entryFor(name);
  if (e.session) return e.session;
  e.session = (async () => {
    const session: Session = { sessionId: null, protocolVersion: PROTOCOL_VERSION };
    const result = (await rpc(cfg, null, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "worlds", version: "1" },
    }, HANDSHAKE_TIMEOUT_MS)) as { protocolVersion?: string } | null;
    if (result?.protocolVersion) session.protocolVersion = result.protocolVersion;
    // The server stamps its session id on the initialize response; rpc() captured it only
    // if we passed a session, which we could not have on the first call.
    await notifyInitialized(cfg, session);
    return session;
  })().catch((e2) => {
    entries.delete(name); // a failed handshake must not be cached as the answer
    throw e2;
  });
  return e.session;
}

async function notifyInitialized(cfg: { url: string; token: string }, session: Session): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${cfg.token}`,
    "mcp-protocol-version": session.protocolVersion,
  };
  if (session.sessionId) headers["mcp-session-id"] = session.sessionId;
  await fetch(cfg.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
  }).catch(() => {}); // a notification has no reply and no recovery
}

export async function listTools(name: string, cfg: { url: string; token: string }): Promise<RemoteTool[]> {
  const e = entryFor(name);
  if (e.tools && Date.now() - e.tools.at < TOOLS_TTL_MS) return e.tools.list;
  const run = async () => {
    const session = await handshake(name, cfg);
    const result = (await rpc(cfg, session, "tools/list", {}, HANDSHAKE_TIMEOUT_MS)) as { tools?: unknown[] } | null;
    return (result?.tools ?? []).map((t) => {
      const r = t as Record<string, unknown>;
      return {
        name: String(r.name ?? ""),
        description: String(r.description ?? ""),
        input_schema: (r.inputSchema ?? r.input_schema ?? {}) as Record<string, unknown>,
      };
    });
  };
  let list: RemoteTool[];
  try {
    list = await run();
  } catch (err) {
    // A list is idempotent, so an expired session is worth exactly one retry.
    if (err instanceof WorldsError && err.code === "conflict") {
      resetConnector(name);
      list = await run();
    } else throw err;
  }
  e.tools = { at: Date.now(), list };
  return list;
}

export interface CallResult {
  value: unknown;
  isError: boolean;
}

/**
 * Invoke one tool. Never retried: `tools/call` is not idempotent, and a retried
 * `create_issue` files the issue twice. An expired session fails here and succeeds on the
 * caller's next attempt — a deliberately worse experience than double-writing.
 */
export async function callTool(
  name: string,
  cfg: { url: string; token: string },
  tool: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const session = await handshake(name, cfg);
  let result: Record<string, unknown> | null;
  try {
    result = (await rpc(cfg, session, "tools/call", { name: tool, arguments: args }, CALL_TIMEOUT_MS)) as Record<string, unknown> | null;
  } catch (err) {
    if (err instanceof WorldsError && err.code === "conflict") {
      resetConnector(name);
      throw new WorldsError("upstream_error", "connector session expired — try again");
    }
    throw err;
  }
  // An unknown-tool failure usually means our cached list is stale.
  if (result?.isError === true) entryFor(name).tools = null;
  return { value: unwrap(result), isError: result?.isError === true };
}

// The inverse of mcp.ts's `asText`: structured content if the server sent it, otherwise a
// lone JSON text block parsed, otherwise the joined text.
function unwrap(result: Record<string, unknown> | null): unknown {
  if (!result) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? (result.content as Record<string, unknown>[]) : [];
  const texts = content.filter((c) => c.type === "text").map((c) => String(c.text ?? ""));
  if (texts.length === 1) {
    const parsed = safeJson(texts[0]!);
    if (parsed !== null) return parsed;
  }
  return texts.join("\n");
}
