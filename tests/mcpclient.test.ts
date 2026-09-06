import { afterEach, describe, expect, test } from "bun:test";
import { callTool, listTools, resetConnector } from "../server/mcpclient";
import { WorldsError } from "../server/errors";

// A stub MCP server per test: the real one needs a credential, and a dev-mode
// short-circuit in the client would make "did it actually happen" untestable.
interface Call { method: string; params: any; id: number; headers: Headers }
interface Stub {
  url: string;
  seen: Call[];
  stop: () => void;
}

// The body is read once, here, and handed to the handler already parsed — a handler that
// re-read the Request would reset the connection and look like an unreachable server.
function stub(handler: (call: Call) => Response | Promise<Response>): Stub {
  const seen: Call[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { method: string; params: unknown; id?: number };
      const call: Call = { method: body.method, params: body.params, id: body.id ?? 0, headers: req.headers };
      seen.push(call);
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return handler(call);
    },
  });
  return { url: `http://localhost:${server.port}/mcp`, seen, stop: () => server.stop(true) };
}

const rpc = (id: number, result: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json", ...extra },
  });

// Request ids increment globally across the module, so tests echo the id that arrived
// rather than assuming one.
function echo(result: unknown, extra: Record<string, string> = {}) {
  return (call: Call) => rpc(call.id, result, extra);
}

const CFG = (url: string) => ({ url, token: "tok_secret_value" });
let live: Stub | null = null;
afterEach(() => { live?.stop(); live = null; });

describe("mcp client", () => {
  test("handshakes once across concurrent callers and echoes session + protocol headers", async () => {
    const s = stub((c) => {
      if (c.method === "initialize") return rpc(c.id, { protocolVersion: "2025-06-18" }, { "mcp-session-id": "sess-1" });
      return rpc(c.id, { tools: [{ name: "create_issue", description: "d", inputSchema: { type: "object" } }] });
    });
    live = s;
    resetConnector("c1");
    const [a, b] = await Promise.all([listTools("c1", CFG(s.url)), listTools("c1", CFG(s.url))]);
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(s.seen.filter((x) => x.method === "initialize").length).toBe(1);
    const listCall = s.seen.find((x) => x.method === "tools/list")!;
    expect(listCall.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(listCall.headers.get("authorization")).toBe("Bearer tok_secret_value");
  });

  test("tools/list is cached until reset", async () => {
    const s = stub(echo({ tools: [{ name: "a", description: "", inputSchema: {} }] }));
    live = s;
    resetConnector("c2");
    await listTools("c2", CFG(s.url));
    await listTools("c2", CFG(s.url));
    expect(s.seen.filter((x) => x.method === "tools/list").length).toBe(1);
    resetConnector("c2");
    await listTools("c2", CFG(s.url));
    expect(s.seen.filter((x) => x.method === "tools/list").length).toBe(2);
  });

  test("an SSE response parses identically to a JSON one", async () => {
    const s = stub((c) => {
      if (c.method === "initialize") return rpc(c.id, {});
      const frame = JSON.stringify({ jsonrpc: "2.0", id: c.id, result: { content: [{ type: "text", text: '{"identifier":"ENG-1"}' }] } });
      return new Response(`event: message\ndata: ${frame}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    live = s;
    resetConnector("c3");
    const out = await callTool("c3", CFG(s.url), "create_issue", { title: "x" });
    expect(out.isError).toBe(false);
    expect((out.value as { identifier: string }).identifier).toBe("ENG-1");
  });

  test("a mismatched response id is refused", async () => {
    const s = stub((c) => {
      if (c.method === "initialize") return rpc(c.id, {});
      return rpc(c.id + 999, { content: [] });
    });
    live = s;
    resetConnector("c4");
    await expect(callTool("c4", CFG(s.url), "t", {})).rejects.toThrow(/mismatched/);
  });

  test("a 401 never leaks the upstream body and is not retried", async () => {
    const s = stub(() => new Response("token tok_secret_value is invalid", { status: 401 }));
    live = s;
    resetConnector("c5");
    let err: unknown;
    try { await listTools("c5", CFG(s.url)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WorldsError);
    expect((err as WorldsError).message).not.toContain("tok_secret_value");
    expect((err as WorldsError).code).toBe("upstream_error");
    expect(s.seen.filter((x) => x.method === "initialize").length).toBe(1);
  });

  test("isError comes back flagged, with the tool's own message", async () => {
    const s = stub((c) => {
      if (c.method === "initialize") return rpc(c.id, {});
      return rpc(c.id, { isError: true, content: [{ type: "text", text: "team not found" }] });
    });
    live = s;
    resetConnector("c7");
    const out = await callTool("c7", CFG(s.url), "create_issue", {});
    expect(out.isError).toBe(true);
    expect(String(out.value)).toContain("team not found");
  });

  test("arguments reach the server verbatim under `arguments`", async () => {
    const s = stub(echo({ content: [{ type: "text", text: "ok" }] }));
    live = s;
    resetConnector("c8");
    await callTool("c8", CFG(s.url), "create_issue", { title: "hello", teamId: "T1" });
    const call = s.seen.find((x) => x.method === "tools/call")!;
    expect(call.params.name).toBe("create_issue");
    expect(call.params.arguments).toEqual({ title: "hello", teamId: "T1" });
  });

  test("a connector that is down is upstream_error, not a crash", async () => {
    const s = stub(echo({ tools: [] }));
    const url = s.url;
    s.stop(); // the port was real a moment ago; now nothing is listening
    resetConnector("c9");
    let err: unknown;
    try { await listTools("c9", { url, token: "t" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WorldsError);
    expect((err as WorldsError).code).toBe("upstream_error");
  });
});
