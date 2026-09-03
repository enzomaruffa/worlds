import { identityFrom, type Identity } from "./identity";
import { resolveProfile } from "./profile";
import { WorldsError } from "./errors";
import type { BackendPolicy } from "./policies";

// A site's declared backend (.world.json → backend) sits behind the sign-in wall with
// it: every request under `backend.prefix` is forwarded, signed so the backend can trust
// who's calling. See docs/quickstart.md for the wire contract.

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "host", "cookie"]);

// Also drops sec-websocket-* — those are handshake-specific to THIS connection; the
// outbound WebSocket (client or fetch) sets its own.
function stripHopByHop(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk.startsWith("proxy-") || lk.startsWith("sec-websocket")) continue;
    out[k] = v;
  }
  return out;
}

export function signProxy(method: string, path: string, userJson: string, ts: number, secret: string): string {
  return new Bun.CryptoHasher("sha256", secret).update(`${method}\n${path}\n${userJson}\n${ts}`).digest("hex");
}

// The site-relative path a proxied request forwards as, keeping its leading "/"
// ("/_api/" + "/_api/channels/x" → "/channels/x"). Null when the path isn't under the prefix.
export function proxyAfterPrefix(backend: BackendPolicy, sitePath: string): string | null {
  if (!sitePath.startsWith(backend.prefix)) return null;
  return `/${sitePath.slice(backend.prefix.length)}`;
}

async function proxyHeaders(
  req: Request,
  site: string,
  secret: string | null,
  after: string,
): Promise<{ headers: Record<string, string>; who: Identity }> {
  if (!secret) throw new WorldsError("maintenance", "backend proxy is not configured");
  const who = identityFrom(req);
  const prof = await resolveProfile(who.handle, who.email);
  const userJson = JSON.stringify({ email: who.email, handle: prof.handle, name: prof.name, kind: who.kind });
  const ts = Math.floor(Date.now() / 1000);
  const headers = stripHopByHop(req.headers);
  headers["x-worlds-site"] = site;
  headers["x-worlds-user"] = userJson;
  headers["x-worlds-ts"] = String(ts);
  headers["x-worlds-signature"] = signProxy(req.method, after, userJson, ts, secret);
  const url = new URL(req.url);
  headers["x-forwarded-proto"] = req.headers.get("x-forwarded-proto") || url.protocol.slice(0, -1);
  headers["x-forwarded-host"] = req.headers.get("host") || url.host;
  return { headers, who };
}

export async function proxyHttp(
  req: Request,
  site: string,
  backend: BackendPolicy,
  secret: string | null,
  after: string,
): Promise<Response> {
  const { headers } = await proxyHeaders(req, site, secret, after);
  const target = `${backend.url}${after}${new URL(req.url).search}`;
  const hasBody = req.body !== null && req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      ...(hasBody ? { duplex: "half" } : {}),
      signal: AbortSignal.timeout(30_000),
    } as RequestInit & { duplex?: "half" });
  } catch {
    throw new WorldsError("upstream_error", "backend unreachable");
  }
  return new Response(upstream.body, { status: upstream.status, headers: stripHopByHop(upstream.headers) });
}

export interface ProxyUpgrade {
  wsUrl: string;
  protocols: string[];
  headers: Record<string, string>;
  who: Identity;
}

export async function prepareProxyUpgrade(
  req: Request,
  site: string,
  backend: BackendPolicy,
  secret: string | null,
  after: string,
): Promise<ProxyUpgrade> {
  const { headers, who } = await proxyHeaders(req, site, secret, after);
  const backendUrl = new URL(backend.url);
  const scheme = backendUrl.protocol === "https:" ? "wss:" : "ws:";
  const search = new URL(req.url).search;
  const wsUrl = `${scheme}//${backendUrl.host}${after}${search}`;
  const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { wsUrl, protocols, headers, who };
}

// Frames that arrive at the upstream socket before the platform-side socket exists
// (open() hasn't run yet) are queued here rather than dropped.
interface Backlog {
  messages: (string | Buffer)[];
  close?: { code: number; reason: string };
  errored: boolean;
}
const backlogs = new WeakMap<WebSocket, Backlog>();
const pendingSend = new WeakMap<WebSocket, (string | Buffer)[]>();

// Dial the backend immediately (before the client's own upgrade completes) so nothing
// racing in from either side is lost — see pipeUpstream/sendUpstream below.
export function dialBackend(wsUrl: string, protocols: string[], headers: Record<string, string>): WebSocket {
  // Bun's WebSocket client takes { headers, protocols } — richer than lib.dom's
  // (string | string[]) signature TS resolves to, hence the cast (tests/e2e.test.ts
  // does the same for the same reason).
  const upstream = new WebSocket(wsUrl, (protocols.length ? { headers, protocols } : { headers }) as never);
  upstream.binaryType = "nodebuffer" as never; // Bun-only value; lib.dom's BinaryType doesn't know it
  const backlog: Backlog = { messages: [], errored: false };
  backlogs.set(upstream, backlog);
  upstream.onmessage = (ev) => backlog.messages.push(ev.data as string | Buffer);
  upstream.onerror = () => { backlog.errored = true; };
  upstream.onclose = (ev) => { backlog.close = { code: ev.code, reason: ev.reason }; };
  return upstream;
}

interface ClientSink {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
}

// Called from ws.ts's open(): wires the upstream directly to the now-live platform
// socket, replaying anything that arrived in the gap between dialBackend and here.
export function pipeUpstream(upstream: WebSocket, client: ClientSink): void {
  const backlog = backlogs.get(upstream);
  backlogs.delete(upstream);
  upstream.onmessage = (ev) => client.send(ev.data as string | Buffer);
  upstream.onerror = () => client.close(1011, "upstream error");
  upstream.onclose = (ev) => client.close(ev.code || 1000, ev.reason);
  if (backlog) {
    for (const m of backlog.messages) client.send(m);
    if (backlog.errored) client.close(1011, "upstream error");
    else if (backlog.close) client.close(backlog.close.code || 1000, backlog.close.reason);
  }
}

// Called from ws.ts's message(): the client may send frames before the backend
// handshake finishes, so queue until it's OPEN rather than throwing.
export function sendUpstream(upstream: WebSocket, data: string | Buffer): void {
  if (upstream.readyState === WebSocket.OPEN) {
    upstream.send(data as never); // Buffer vs. lib.dom's ArrayBuffer-only BufferSource
    return;
  }
  let q = pendingSend.get(upstream);
  if (!q) {
    pendingSend.set(upstream, (q = []));
    upstream.addEventListener(
      "open",
      () => {
        const queued = pendingSend.get(upstream);
        pendingSend.delete(upstream);
        if (queued) for (const m of queued) upstream.send(m as never);
      },
      { once: true },
    );
  }
  q.push(data);
}

export function closeUpstream(upstream: WebSocket, code?: number, reason?: string): void {
  try {
    upstream.close(code, reason);
  } catch {
    /* already closed */
  }
}
