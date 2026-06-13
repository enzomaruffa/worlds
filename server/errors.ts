// Error codes are part of the frozen v1 contract (docs/PLAN.md, Draft B).
export type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "payload_too_large"
  | "quota_exceeded"
  | "invalid_request"
  | "reserved_name"
  | "conflict"
  | "replay_expired"
  | "maintenance"
  | "upstream_error"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  rate_limited: 429,
  payload_too_large: 413,
  quota_exceeded: 429,
  invalid_request: 400,
  reserved_name: 409,
  conflict: 409,
  replay_expired: 410,
  maintenance: 503,
  upstream_error: 502,
  internal: 500,
};

export class WorldsError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryAfter?: number,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const BASE_HEADERS = { "content-type": "application/json", "x-worlds-api-version": "1" };

export function jsonError(err: WorldsError): Response {
  const body: Record<string, unknown> = { code: err.code, message: err.message, ...err.extra };
  if (err.retryAfter !== undefined) body.retry_after = err.retryAfter;
  return new Response(JSON.stringify({ error: body }), {
    status: STATUS[err.code],
    headers: err.retryAfter !== undefined
      ? { ...BASE_HEADERS, "retry-after": String(err.retryAfter) }
      : BASE_HEADERS,
  });
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...BASE_HEADERS, ...(init.headers ?? {}) },
  });
}

export function asWorldsError(e: unknown): WorldsError {
  if (e instanceof WorldsError) return e;
  console.error(e);
  return new WorldsError("internal", "internal error");
}
