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
};
