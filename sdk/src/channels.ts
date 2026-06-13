import { sock } from "./socket";

// Named pub/sub channels for multiplayer/collab, multiplexed over the one socket.
export const ws = {
  channel(name: string) {
    return {
      publish: (payload: unknown) => sock.send({ op: "pub", id: `p${sock.nextId++}`, channel: name, payload }),
      subscribe: (handler: (msg: { payload: unknown; from: any; at: string }) => void) =>
        sock.subscribe({ op: "sub", kind: "channel", channel: name }, handler),
      presence: (handler: (members: unknown[]) => void) =>
        sock.subscribe({ op: "sub", kind: "channel", channel: name, presence: true }, () => {}, { onPresence: handler }),
    };
  },
};
