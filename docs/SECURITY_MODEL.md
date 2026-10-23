# Security model

What Hypout defends against, what it leaves to you, and how to check each claim.

## Who can do what

| Actor | How they are identified | What they may do |
| --- | --- | --- |
| Anonymous browser | No token | Only what a namespace marks `public` (by default: subscribe) |
| User | A token signed with your secret, scoped to channel patterns and operations | The operations in the token, on matching channels, within the rate limits |
| Admin | A token with `admin: true` | The REST API, the Studio, and publishing without ACL or rate limits |
| The server | The REST API | Publish to `server`-only channels |

Tokens are `hpt_<payload>.<signature>`: base64url JSON plus an HMAC-SHA256 over the payload. The signature is compared in constant time, a tampered payload fails, and `exp` is enforced. Tokens cannot be revoked individually; keep their lifetime short and rotate `HYPOUT_SECRET` to invalidate them all.

## Defaults

- **Loopback only.** The server binds `127.0.0.1`. Binding elsewhere prints a warning, because the Studio link contains an admin token.
- **The Studio token stays out of the server's hands.** `hypout studio` prints a link with the token in the URL *fragment*, which browsers never send. The Studio reads it, keeps it in `sessionStorage` for that tab, and removes it from the address bar. Admin tokens printed by `studio` last 24 hours.
- **The REST API needs a bearer token**, always. There are no cookies, so a page on another site cannot ride on a session; CORS is limited to `allowedOrigins` when you set it.
- **No telemetry, no outbound connections.** The only network traffic is what clients open to the server.
- **The secret file is private.** `.hypout/secret` is created `0600`, and `hypout init` git-ignores `.hypout/`.

## Resource limits

An unauthenticated client can open a WebSocket and subscribe to public channels, so everything that grows is capped: frame size is checked from the header before any payload is buffered; messages are limited to `maxPayload`; a connection holds at most 100 subscriptions; channels, connections and presence members are capped; retained events are bounded per channel and allocated as they arrive; idle channels are swept; and a peer with more than 4 MiB queued is closed as a slow consumer. Each connection and each namespace has a token bucket. A peer that stops answering Pings is closed after `timeoutMs`.

## What is yours to do

- **TLS.** Hypout serves plain `http://` and `ws://`. Put it behind a TLS-terminating proxy for anything off your machine.
- **Query-string tokens.** The React client sends the token as `?token=` because browsers cannot set WebSocket headers. Make sure your proxy and logs do not record query strings, and keep user tokens short-lived. The `auth` message is an alternative that keeps the token out of the URL.
- **Origins.** With `allowedOrigins` empty, any web page can open a WebSocket to your server (it still needs a token for anything not public). Set the list for production.
- **Who may mint tokens.** Minting needs the secret. Do it in your backend and hand the browser the result.
- **Denial of service.** The limits above bound memory per connection and per channel, not the total work a flood of connections can cause. Use your proxy's connection and rate limits as well.

## The ledger

The audit ledger is tamper-*evident*, not tamper-*proof*. Editing, removing or reordering an entry breaks the chain from that point, and `hypout ledger verify` says where. Someone who can rewrite the whole file can rebuild a consistent chain, and truncating the end is undetectable from the file alone. If that matters, store the head hash that `ledger verify` prints somewhere you trust and compare later. The ledger records a hash of each event's data, not the data.

## Reporting

See [SECURITY.md](../SECURITY.md).
