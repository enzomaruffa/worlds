import { sock, type Person } from "./socket";

export type { Person };

export interface ChannelMessage<T = any> {
  payload: T;
  from: Person;
  at: string;
}

export interface Channel<T = any> {
  publish(payload: T): void; // fire-and-forget, unlike every other write in the SDK
  subscribe(handler: (msg: ChannelMessage<T>) => void): () => void;
  presence(handler: (members: Person[]) => void): () => void;
}

export interface Pong {
  rtt: number;      // ms, this socket's round trip
  serverAt: number; // the server's Date.now() when it replied
  skew: number;     // serverAt - the local clock's midpoint of the trip, in ms
}

// Named pub/sub channels for multiplayer/collab, multiplexed over the one socket.
export const ws = {
  channel<T = any>(name: string): Channel<T> {
    return {
      publish: (payload: T) => sock.send({ op: "pub", id: `p${sock.nextId++}`, channel: name, payload }),
      subscribe: (handler: (msg: ChannelMessage<T>) => void) =>
        sock.subscribe({ op: "sub", kind: "channel", channel: name }, handler),
      presence: (handler: (members: Person[]) => void) =>
        sock.subscribe({ op: "sub", kind: "channel", channel: name, presence: true }, () => {}, { onPresence: handler }),
    };
  },

  // Round trip over the live socket. `skew` assumes a symmetric path, which real
  // networks often aren't — treat it as an estimate, not a measurement.
  async ping(): Promise<Pong> {
    const t0 = performance.now();
    const f = await sock.request({ op: "ping" });
    const rtt = performance.now() - t0;
    return { rtt, serverAt: f.at, skew: f.at - (Date.now() - rtt / 2) };
  },
};
