# @hypout/core

The engine behind [Hypout](https://github.com/isagarpinninti/hypout): an RFC 6455 WebSocket codec and handshake, ring-buffer replay, CRDT presence, heartbeat, signed tokens, the `HP-101` to `HP-106` gates and a transport-agnostic pub/sub broker. No `ws`, no `socket.io`, no runtime dependencies besides a `zod` peer.

```bash
npm install @hypout/core zod
```

```ts
import { Broker, ChannelRegistry } from "@hypout/core";

const registry = new ChannelRegistry([{ namespace: "chat", access: { publish: "public" } }]);
const broker = new Broker({ registry });

broker.connect({ id: "a", send: (m) => console.log("a gets", m) });
broker.receive("a", { t: "sub", ch: "chat:lobby" }, 30);
broker.receive("a", { t: "pub", ch: "chat:lobby", ev: "message", data: { text: "hi" } }, 60);
```

The broker never touches a socket: give it a `ClientHandle` (`id`, `send(message)`) for each client and feed it decoded messages. `@hypout/cli` does that over real sockets.

## Exports

- `@hypout/core`: everything, including Node-only parts (`handleUpgrade`, `WsClient`, `mintToken`, `verifyToken`).
- `@hypout/core/protocol`: the browser-safe subset (frame codec, message schemas, `PresenceCRDT`, `RingBuffer`, schema compiler, `explainHeader`, `hexdump`). No `node:*` imports.

Supports Zod `^3.23` and `^4`. Full documentation: [docs/](https://github.com/isagarpinninti/hypout/tree/main/docs). MIT licensed.
