// The error envelope is part of the frozen v1 contract (see spec/world-v1.yaml).
export type ErrorCode =
  | "unauthorized" | "not_found" | "rate_limited" | "payload_too_large"
  | "quota_exceeded" | "invalid_request" | "reserved_name" | "conflict"
  | "replay_expired" | "maintenance" | "upstream_error" | "internal";

export class WorldsError extends Error {
  code: ErrorCode;
  status: number;
  retry_after?: number;
  constructor(code: ErrorCode, message: string, status = 0, retryAfter?: number) {
    super(message);
    this.name = "WorldsError";
    this.code = code;
    this.status = status;
    this.retry_after = retryAfter;
  }
}
