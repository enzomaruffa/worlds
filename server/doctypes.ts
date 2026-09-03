import { WorldsError } from "./errors";
import type { Identity } from "./identity";

// Shared shapes for the document room and its remote counterpart, kept apart from both so
// neither has to import the other.

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

// What the socket and HTTP layers need from a room, whether it lives in this process or
// is forwarded to the pod that holds the lease.
export interface DocRoomLike {
  readonly site: string;
  readonly name: string;
  readonly epoch: number;
  readonly seq: number;
  readonly stateBytes: number;
  subscribe(client: DocClient, subId: string): Promise<void>;
  unsubscribe(client: DocClient): void;
  submit(who: Identity, epoch: number, update: Uint8Array, client: DocClient | null, subId: string | null): Promise<number>;
  state(): Promise<DocState>;
  stateFrame(op: "doc_state" | "doc_reset" | "doc_rejected", subId: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  updatesSince(epoch: number, seq: number): Promise<Uint8Array[] | null>;
  rotate(who: Identity, expectEpoch: number, state: Uint8Array): Promise<DocState>;
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
