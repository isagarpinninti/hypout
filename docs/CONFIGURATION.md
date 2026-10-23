# Configuration

Hypout reads `hypout.config.json` from the folder you run it in (or `--config <file>`), plus one JSON file per namespace under `channels/`. `hypout init` writes a working set.

## `hypout.config.json`

Every key is optional. Unknown keys are an error, so a typo is caught by `hypout validate` instead of being ignored.

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `4320` | Port to listen on (`0` picks a free one). `--port` overrides it. |
| `host` | `127.0.0.1` | Interface to bind. Anything other than loopback prints a warning, because the Studio link carries an admin token. |
| `channels` | `"channels"` | Folder of channel definition files. |
| `allowedOrigins` | `[]` | Browser origins allowed to open a WebSocket and call the REST API from a page. Empty allows any origin. |
| `maxPayload` | `65536` | Largest message in bytes (frames larger than this close the connection with `1009`). |
| `heartbeat` | `{ intervalMs: 30000, timeoutMs: 10000 }` | A Ping is sent every `intervalMs`; a peer that has not answered `timeoutMs` later is closed. |
| `maxConnections` | `10000` | Further upgrades get `503`. |
| `maxChannels` | `10000` | Channels held in memory at once. New names beyond this are refused with `HP-101` (`channel_limit`). |
| `channelIdleMinutes` | `1440` | A channel with no subscribers and no activity for this long is dropped, with its retained events. |
| `ledger` | `true` | Append every published event to `.hypout/ledger.jsonl`. |

## The signing secret

Tokens are signed with HMAC-SHA256. The secret comes from `HYPOUT_SECRET` (at least 16 characters), or else from `.hypout/secret`, which is created on first run with mode `0600`. `.hypout/` is added to `.gitignore` by `hypout init`. Every process that mints or checks tokens (the server, `hypout publish`, `hypout token mint`) must see the same secret.

## Channel definitions

One JSON file per namespace, either an object or an array of objects. A channel is addressed as `namespace` or `namespace:id` (`chat:room-42`); every channel in a namespace follows the namespace's definition.

```json
{
  "namespace": "chat",
  "description": "Room chat.",
  "access": { "subscribe": "public", "publish": "token", "presence": "public" },
  "events": {
    "message": { "type": "object", "properties": { "text": { "type": "string", "minLength": 1, "maxLength": 2000 } }, "required": ["text"] }
  },
  "rateLimit": { "capacity": 20, "refillPerSecond": 5 },
  "retention": { "events": 200 },
  "presence": { "maxMembers": 1000 },
  "maxPayloadBytes": 8192
}
```

| Field | Values | Meaning |
| --- | --- | --- |
| `access.subscribe` | `public`, `token` | Who may subscribe. |
| `access.publish` | `public`, `token`, `server` | `server` means only the REST API and `hypout publish`. |
| `access.presence` | `public`, `token`, `off` | Who may join the presence roster; `off` disables it. |
| `events` | name → schema | The allowed event names and their payload shapes. Empty means any event and any payload (`validate` warns). |
| `rateLimit` | token bucket | Per connection, per namespace. Admin tokens are exempt. |
| `retention.events` | 1 to 100000 | How many recent events are kept for replay. |
| `presence.maxMembers` | integer | Roster size cap. |
| `maxPayloadBytes` | integer | A tighter size limit than the server's `maxPayload`. |

### Schemas

A small JSON-Schema-like subset, compiled to Zod: `string` (`minLength`, `maxLength`, `pattern`, `enum`), `number`, `integer` (`minimum`, `maximum`), `boolean`, `array` (`items`, `minItems`, `maxItems`), `object` (`properties`, `required`, `additionalProperties`; extra keys are refused by default), and `any`. Nesting is limited to 10 levels, and an invalid `pattern` is reported when the file is loaded.

### Tokens

`hypout token mint --sub ada --caps "chat:*=sub,pub,presence;doc:7=sub" --ttl 3600`

A capability is `channel-pattern=op,op`, where the pattern is an exact channel, `namespace:*` (the namespace and everything under it) or `*`, and the operations are `sub`, `pub` and `presence`. `--admin` mints a token that bypasses ACLs and rate limits; keep those on your server.

## REST API

All endpoints except `/health` need `Authorization: Bearer <admin token>`. Responses are JSON.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | `{ ok, version, uptimeMs, connections }`, no token needed |
| `GET /api/stats` | Counters, per-channel stats, chaos state, ledger head |
| `GET /api/channels` | Namespace definitions and live channels |
| `GET /api/channels/:name/events?limit=50` | Retained events (newest last) |
| `GET /api/channels/:name/members` | Presence roster |
| `POST /api/publish` | `{ channel, event, data }`. `422` with the gate code if refused, `429` for `HP-103` |
| `POST /api/preflight` | Run the gates against a hypothetical message: `{ op, channel, event?, data?, lastSeq?, anonymous? }` |
| `POST /api/token` | `{ sub, name?, caps?, ttlSeconds? }` returns a token |
| `GET /api/wire?since=<id>` / `DELETE /api/wire` | Recent frames for the inspector / clear them |
| `GET /api/chaos` / `POST /api/chaos` | Read / set `{ dropRate, delayMs, jitterMs, seed }` or `{ reset: true }` |
| `POST /api/sever` | Cut every WebSocket without a closing handshake |

## The ledger

`.hypout/ledger.jsonl` has one line per published event: sequence, channel, event name, publisher, a SHA-256 of the data (not the data itself), the previous entry's hash and its own hash. `hypout ledger verify` recomputes the chain and reports the first entry that was edited, removed or reordered. Starting the server on a corrupt ledger fails loudly instead of appending to it.
