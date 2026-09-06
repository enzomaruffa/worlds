import { WorldsError } from "./errors";

// Shared shapes for the document room, kept apart so the socket layer never depends on
// the room module's internals.

// A connected subscriber. The socket layer hands in a closure so the rooms never depend
// on Bun's WebSocket type.
export interface DocClient {
  send(frame: Record<string, unknown>): void;
}

export interface DocState {
  epoch: number;
  seq: number;
  state: Uint8Array;
}

export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromB64(s: unknown): Uint8Array {
  if (typeof s !== "string" || !s) throw new WorldsError("invalid_request", "update must be a base64 string");
  const buf = Buffer.from(s, "base64");
  if (!buf.length) throw new WorldsError("invalid_request", "update must be a base64 string");
  return new Uint8Array(buf);
}
