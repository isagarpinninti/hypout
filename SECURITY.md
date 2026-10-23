# Security policy

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue for something exploitable.

Include what you found, how to reproduce it, and the version of Hypout. You will get an acknowledgement within a few days. Fixes ship as a patch release and are credited if you wish.

## What counts

Hypout accepts connections from browsers and mints credentials, so the most serious reports are about:

- an operation succeeding without the token or capability it needs (a publish, subscribe or presence change past the HP-104 gate, or a REST call without an admin token)
- a way to forge or extend a token without the secret
- the secret, or a token, appearing in a log, an error message, a file with loose permissions or the network
- a WebSocket frame or HTTP request that crashes the server or makes it use unbounded memory or CPU
- a way to read or write files outside the places Hypout documents (`.hypout/`, the channels folder, the Studio bundle)
- the Studio exposing its admin token to a server, another site or a log

## How it is designed

See the [security model](docs/SECURITY_MODEL.md): loopback by default, bearer tokens with no cookies, a token carried in the URL fragment, resource limits on everything that grows, and an honest account of what the ledger does and does not prove.

## Supported versions

The latest release receives fixes.
