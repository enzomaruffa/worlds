import { WorldsError } from "./error";

// Custom header forces a CORS preflight → same-origin only. Auth is the gateway's
// session cookie; sites never carry tokens. In path-routing mode (sites at
// /app/<site>/), the page shares the apex origin, so declare the site explicitly.
function siteHeaders(): Record<string, string> {
  if (typeof location === "undefined") return {};
  const m = location.pathname.match(/^\/app\/([^/]+)/);
  return m ? { "x-worlds-site": m[1]! } : {};
}
export const HEADERS: Record<string, string> = { "x-worlds-csrf": "1", ...siteHeaders() };

export interface CallOpts {
  headers?: Record<string, string>;
}

export async function call(method: string, path: string, body?: unknown, opts: CallOpts = {}): Promise<any> {
  const init: RequestInit = { method, headers: { ...HEADERS, ...(opts.headers ?? {}) } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new WorldsError("internal", `network error: ${(e as Error).message}`, 0);
  }

  if (res.status === 401) {
    // Session expired: sites never handle auth — bounce through sign-in.
    location.assign(`/auth/login?rd=${encodeURIComponent(location.href)}`);
    throw new WorldsError("unauthorized", "session expired, redirecting", 401);
  }
  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data && data.error) || {};
    throw new WorldsError(err.code || "internal", err.message || res.statusText, res.status, err.retry_after);
  }
  return data;
}
