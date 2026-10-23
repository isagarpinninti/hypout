# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/).

## 0.1.1

First release from the project's permanent repository (0.1.0 was published from a staging repository).

### Fixed
- Studio: the chaos panel no longer overwrites a slider the user has just moved when its first poll returns late.
- `@hypout/react` integration tests skip on Node 20, which has no global `WebSocket`.
- `@hypout/cli`: `bin` path normalised.

## 0.1.0

- `@hypout/core`: RFC 6455 handshake and frame codec, ring-buffer replay, CRDT presence, heartbeat, token bucket, signed tokens, gates `HP-101` to `HP-106`, and the broker.
- `@hypout/cli`: `init`, `validate`, `studio`, `publish`, `token mint`, `ledger verify`, `inspect`; the HTTP and WebSocket server, REST API, wire tap, chaos simulator, hash-chained ledger and the bundled Studio.
- `@hypout/react`: reconnecting client with replay and gap recovery, hooks, and four Studio components.
