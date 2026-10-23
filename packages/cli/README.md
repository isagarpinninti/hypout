# @hypout/cli

Run a self-hosted [Hypout](https://github.com/isagarpinninti/hypout) real-time server: WebSocket upgrade, pub/sub channels, CRDT presence, replay, a hash-chained audit ledger, and the Studio.

```bash
npx @hypout/cli init        # hypout.config.json and example channels
npx @hypout/cli validate
npx @hypout/cli studio      # 127.0.0.1:4320, prints a Studio link
```

| Command | |
| --- | --- |
| `hypout init [dir]` | Scaffold a project |
| `hypout validate` | Check config and channels |
| `hypout studio` | Start the server and the Studio |
| `hypout publish <channel> <event> [json]` | Publish through a running server |
| `hypout token mint --sub <id> [--caps ...] [--admin]` | Mint a signed token |
| `hypout ledger verify` | Verify the audit ledger |
| `hypout inspect <hex>` | Explain a WebSocket frame header |

Binds to loopback by default; TLS is for your reverse proxy. Configuration, REST API and security notes: [docs/CONFIGURATION.md](https://github.com/isagarpinninti/hypout/blob/main/docs/CONFIGURATION.md). MIT licensed.
