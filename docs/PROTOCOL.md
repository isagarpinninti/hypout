# Wire protocol and gates

Hypout speaks RFC 6455 WebSocket with the subprotocol `hypout.v1`, at `/ws`. Every message is one JSON text frame.

## Connecting

`ws://host:4320/ws?token=hpt_…` (the token is optional; without one the connection is anonymous). The server replies `101 Switching Protocols`, then sends `welcome`. A bad token is refused at the upgrade with `401` and an `X-Hypout-Reason` header; a disallowed origin gets `403`; a full server gets `503`.

## Client to server

| Message | Fields |
| --- | --- |
| `sub` | `ch`, `lastSeq?`, `mid?`. Without `lastSeq` you start at the channel's head. With it, everything after that sequence is replayed. |
| `unsub` | `ch`, `mid?` |
| `pub` | `ch`, `ev`, `data`, `mid?`. Answered with `ack` (carrying `mid`) or `error`. |
| `presence` | `ch`, `op: "set"` with `state` (1 to 16 fields, 2 KiB), or `op: "get"` for a snapshot. |
| `auth` | `token`, `mid?`. Upgrades an open connection, for clients that would rather not put a token in the URL. |
| `ping` | `ts?`. Answered with `pong`. (RFC 6455 Ping frames are answered too.) |

## Server to client

| Message | Fields |
| --- | --- |
| `welcome` | `cid`, `serverTime`, `heartbeat`, `maxPayload`, `authenticated` |
| `sub.ok` | `ch`, `seq` (head), `oldest`, `replayed`, `gap` (true if events before `oldest` were already overwritten) |
| `event` | `ch`, `seq`, `ts`, `ev`, `data`, `from`, `replay?` |
| `ack` | `ch`, `seq`, `mid?` |
| `presence.snapshot` | `ch`, `members`, `ops` (the CRDT operations that make up the roster) |
| `presence.diff` | `ch`, `ops`, `joined`, `left`, `updated` |
| `auth.ok`, `unsub.ok`, `pong` | |
| `error` | `code` (`HP-101` to `HP-106`, or `HP-000` for a malformed message), `reason`, `message`, `ch?`, `mid?`, `retryAfterMs?` |

Presence members are keyed by connection id. The server fills in `userId` (the token's `sub`, or `anon:<id>`), `username` and `avatar` from the token; clients cannot set those or any `$`-prefixed field.

## Close codes

| Code | When |
| --- | --- |
| `1000` | Normal closure |
| `1001` | Server shutting down, or no Pong within the heartbeat timeout |
| `1002` | Protocol error: unmasked client frame, reserved bits set, bad opcode, control frame that is fragmented or too long |
| `1003` | A binary message |
| `1007` | Text that is not valid UTF-8 |
| `1008` | Slow consumer (more than 4 MiB queued for a peer) |
| `1009` | A frame or message larger than `maxPayload` |

## The gates

Every operation passes through numbered gates, in this order, and the first failure is reported. The Studio and `POST /api/preflight` run all of them and show every result.

| Gate | Checks | Typical refusal |
| --- | --- | --- |
| `HP-101` | The channel name is well-formed, its namespace is defined, and the server is not at `maxChannels` | `unknown_namespace`, `syntax`, `channel_limit` |
| `HP-102` | The event is declared and the payload matches its schema; presence state is well-formed | `unknown_event`, `schema`, `presence_state`, `reserved_field` |
| `HP-103` | The connection's token bucket for the namespace has capacity | `rate_limited` with `retryAfterMs` |
| `HP-104` | The connection's token (or the channel's public access) allows the operation | `token_required`, `forbidden`, `server_only`, `not_subscribed`, `not_present`, `presence_off`, `presence_full`, `too_many_subscriptions` |
| `HP-105` | The replay cursor is a valid sequence and not ahead of the channel's head | `cursor_invalid`, `cursor_ahead` |
| `HP-106` | The message fits `maxPayload` (and the namespace's `maxPayloadBytes`); presence state fits 2 KiB | `too_large` |

## Replay and gaps

Sequences start at 1 per channel and never repeat while the channel is in memory. When a client sees `seq` jump by more than one (a lost frame), or reconnects, it subscribes again with `lastSeq` set to the last sequence it processed. `sub.ok.gap` is `true` when the ring buffer no longer holds everything it missed; the client should then treat its local state as stale. If the server restarts, sequences restart from 1 and a stale cursor is refused with `HP-105`.

## Presence as a CRDT

A roster is a map from member to fields, each field a last-writer-wins register ordered by `(ts, actor)`. Operations are `{ k, f, v, ts, a }`; `$alive` marks membership. Applying an operation is commutative, associative and idempotent, so a client that processes a snapshot, a replay or a duplicate in any order ends up with the same roster as the server. The server stamps `ts` from a per-channel Lamport clock.
