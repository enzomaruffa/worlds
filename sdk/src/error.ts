// The error envelope is part of the frozen v1 contract (see spec/world-v1.yaml).
export type ErrorCode =
  | "unauthorized" | "not_found" | "rate_limited" | "payload_too_large"
  | "quota_exceeded" | "invalid_request" | "reserved_name" | "forbidden" | "conflict"
  | "replay_expired" | "maintenance" | "upstream_error" | "internal";

export class WorldsError extends Error {
  code: ErrorCode;
  status: number;
  retryAfter?: number;
  constructor(code: ErrorCode, message: string, status = 0, retryAfter?: number) {
    super(message);
    this.name = "WorldsError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }

  // The wire envelope spells this `retry_after` and sites have branched on it since
  // v1; the property is camelCase like every other one on this class.
  get retry_after(): number | undefined {
    return this.retryAfter;
  }
}
