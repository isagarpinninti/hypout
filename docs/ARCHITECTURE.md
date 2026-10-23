# Architecture

```
 browser / app ──ws──┐
 browser / app ──ws──┼──▶ @hypout/cli (HTTP server + upgrade handler)
 hypout publish ─http┘          │ decoded JSON messages
                                ▼
                        @hypout/core  Broker ──▶ gates HP-101..106
                                │                 ring buffers · CRDT presence · token buckets
                                ▼
                  ClientHandle.send(message) ──▶ framed by the codec ──▶ the socket
```

## Packages

**`@hypout/core`** has no network code in its engine. The `Broker` is synchronous and takes a `ClientHandle` (`id`, `send(message)`) for each client, so every behaviour (gates, replay, presence, rate limits, channel limits) is tested without a socket and runs identically under any transport. Around it:

- `codec/frames.ts`: encode and decode RFC 6455 frames on plain `Uint8Array`s. `FrameDecoder` is incremental (bytes arrive in arbitrary chunks), checks the frame length against the limit from the header before buffering any payload, reassembles fragments, allows control frames in the middle of a fragmented message, and validates UTF-8 and close codes.
- `codec/handshake.ts`: `Sec-WebSocket-Accept`, upgrade validation, and a client-side counterpart used by the CLI and the tests.
- `node/client.ts`: `WsClient`, a small WebSocket client over `node:net`/`node:tls`, built on the same codec.
- `engine/`: the ring buffer, the presence CRDT, the heartbeat monitor (a pure object that takes the clock as an argument), the token bucket, the schema compiler, the channel registry, signed tokens, the gates and the broker.
- `@hypout/core/protocol`: the subset with no `node:*` imports (frames, messages, presence, schemas), which the React package and the Studio import.

**`@hypout/cli`** adds what the engine deliberately leaves out: the HTTP server, the upgrade handler, the REST API, the wire tap, the chaos simulator, the hash-chained ledger, config loading and the commands. It also serves the Studio's static files.

**`@hypout/react`** is a client plus UI. `HypoutClient` is framework-free; the hooks and components are thin layers over it. The four Studio components talk to the REST API with an admin token and poll while the tab is visible.

## A message's path

1. Bytes arrive on an upgraded socket and go to the peer's `FrameDecoder` (masking required, frame size capped).
2. A completed text message is parsed against the client message schema; a malformed one gets `HP-000` and the connection stays open.
3. `Broker.receive` runs the gates, applies the operation (append to the ring, update presence, change subscriptions) and calls `send` on the affected handles.
4. The server encodes each outgoing message once, however many subscribers get it, and writes the same bytes to each socket.

## Design decisions

- **A synchronous broker.** There is no `await` between "check the gate" and "apply the effect", so there is no window for a race between them, and tests can drive time with an injected clock.
- **Bounded everything.** Frame size, message size, subscriptions per connection (100), retained events per channel, presence members, channels in memory, connections, and bytes queued per peer all have limits. None of them grows with traffic.
- **Half-open sockets.** Node leaves an upgraded socket half-open when the client sends FIN. The server answers with `socket.end()`, or every vanished client would leak a socket.
- **CRDT presence, server-ordered.** The server is the only source of presence timestamps for a channel, which keeps the Lamport clock simple. The CRDT still matters: clients merge snapshots, diffs and replays in whatever order the network delivers them.
- **Chaos is part of the server.** Dropping and delaying frames lives in the send path, so a client under test sees exactly what a lossy network would do, and the wire tap marks which frames were dropped.

## What it is not

A multi-node system. Presence operations carry an actor id so a later version could merge rosters from several servers, but today there is one process and no shared state.
