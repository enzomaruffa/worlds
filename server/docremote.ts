import * as cluster from "./cluster";
import { WorldsError } from "./errors";
import type { Identity } from "./identity";
import { b64, fromB64, type DocClient, type DocRoomLike, type DocState } from "./doctypes";

// A document whose authoritative room lives on another pod. Local subscribers see the same
// frames they would from a local room; underneath, every write is a request to the owner
// and every committed update arrives as a push from it. One owner-side subscription per
// (document, pod), fanned out to however many local sockets hold it.

type Rehome = (site: string, name: string, subs: Map<DocClient, string>) => void;
let rehome: Rehome = () => {};

// docs.ts installs the function that re-runs ownership for a document once its owner is
// gone; done this way so this module never imports the registry it is part of.
export function onRehome(fn: Rehome): void {
  rehome = fn;
}

const remoteRooms = new Set<RemoteRoom>();

export class RemoteRoom implements DocRoomLike {
  epoch = 0;
  seq = 0;
  stateBytes = 0;
  subs = new Map<DocClient, string>();
  private attached: Promise<void> | null = null;
  private orphaned = false;

  constructor(readonly owner: string, readonly site: string, readonly name: string) {
    remoteRooms.add(this);
  }

  private get key(): { site: string; name: string } {
    return { site: this.site, name: this.name };
  }

  async subscribe(client: DocClient, subId: string): Promise<void> {
    this.subs.set(client, subId);
    if (!this.attached) {
      this.attached = cluster.request(this.owner, "doc.subscribe", this.key).then(() => {});
    }
    try {
      await this.attached;
    } catch (e) {
      // The owner didn't take us (no link, or it no longer holds the lease): this room is
      // useless, so leave the registry and let the caller run ownership again.
      this.subs.delete(client);
      this.attached = null;
      remoteRooms.delete(this);
      onDetach(this);
      throw e;
    }
  }

  unsubscribe(client: DocClient): void {
    this.subs.delete(client);
    if (this.subs.size === 0) this.detach();
  }

  private detach(): void {
    remoteRooms.delete(this);
    if (this.attached && !this.orphaned) cluster.push(this.owner, "doc.unsubscribe", this.key);
    this.attached = null;
    onDetach(this);
  }

  // A frame the owner pushed for this document; re-addressed to every local subscription.
  deliver(frame: Record<string, unknown>): void {
    if (typeof frame.epoch === "number") this.epoch = frame.epoch;
    if (typeof frame.seq === "number") this.seq = Math.max(frame.op === "doc_reset" ? 0 : this.seq, frame.seq);
    if (typeof frame.bytes === "number") this.stateBytes = frame.bytes;
    for (const [client, subId] of this.subs) client.send({ ...frame, id: subId });
  }

  async submit(who: Identity, epoch: number, update: Uint8Array, client: DocClient | null, subId: string | null): Promise<number> {
    try {
      const res = await cluster.request<{ seq: number; epoch: number }>(this.owner, "doc.submit", {
        ...this.key, epoch, update: b64(update), who,
      });
      this.seq = Math.max(this.seq, res.seq);
      if (client && subId) client.send({ op: "doc_ack", id: subId, seq: res.seq });
      return res.seq;
    } catch (e) {
      // The owner answers a schema violation with invalid_request; the local room would
      // have sent doc_rejected with the current state, so do the same from here.
      if (e instanceof WorldsError && e.code === "invalid_request" && client && subId) {
        client.send(await this.stateFrame("doc_rejected", subId, { reason: e.message, rule: e.extra?.rule }));
      }
      throw e;
    }
  }

  async state(): Promise<DocState> {
    const r = await cluster.request<{ epoch: number; seq: number; state: string; bytes: number }>(this.owner, "doc.state", this.key);
    this.epoch = r.epoch;
    this.seq = r.seq;
    this.stateBytes = r.bytes;
    return { epoch: r.epoch, seq: r.seq, state: fromB64(r.state) };
  }

  async stateFrame(op: "doc_state" | "doc_reset" | "doc_rejected", subId: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const s = await this.state();
    return { op, id: subId, epoch: s.epoch, seq: s.seq, state: b64(s.state), bytes: this.stateBytes, ...extra };
  }

  async updatesSince(epoch: number, seq: number): Promise<Uint8Array[] | null> {
    const r = await cluster.request<{ updates: string[] } | null>(this.owner, "doc.updates", { ...this.key, epoch, since: seq });
    return r ? r.updates.map(fromB64) : null;
  }

  async rotate(who: Identity, expectEpoch: number, state: Uint8Array): Promise<DocState> {
    const r = await cluster.request<{ epoch: number; seq: number; state: string; bytes: number }>(this.owner, "doc.rotate", {
      ...this.key, epoch: expectEpoch, state: b64(state), who,
    });
    this.epoch = r.epoch;
    this.seq = r.seq;
    this.stateBytes = r.bytes;
    return { epoch: r.epoch, seq: r.seq, state: fromB64(r.state) };
  }

  // The owner is gone. Whoever holds the lease next (maybe us) gets these subscribers.
  orphan(): void {
    this.orphaned = true;
    const subs = new Map(this.subs);
    this.subs.clear();
    this.detach();
    if (subs.size) rehome(this.site, this.name, subs);
  }
}

let onDetach: (room: RemoteRoom) => void = () => {};

export function onRemoteDetach(fn: (room: RemoteRoom) => void): void {
  onDetach = fn;
}

cluster.onPush("doc", ({ site, name, frame }: { site: string; name: string; frame: Record<string, unknown> }, from) => {
  for (const room of remoteRooms) {
    if (room.owner === from && room.site === site && room.name === name) room.deliver(frame);
  }
});

cluster.onPeerLost((pod) => {
  for (const room of [...remoteRooms]) {
    if (room.owner === pod) room.orphan();
  }
});
