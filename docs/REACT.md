# React guide

```bash
npm install @hypout/react zod
```

```tsx
import "@hypout/react/styles.css";
```

`react` (18.2 or newer) and `zod` are peer dependencies. The components read colours from `--hy-*` CSS variables (see `styles.css`) and follow `prefers-color-scheme`, or `data-theme="light" | "dark"` on `<html>`.

## The client

```ts
const client = new HypoutClient({
  url: "ws://localhost:4320/ws",
  token: () => fetch("/api/hypout-token").then((r) => r.text()),   // a string or a function; called on every connect
  reconnect: { minMs: 500, maxMs: 15000, factor: 2 },               // or false
});
const off = client.subscribe("chat:lobby", { onEvent, onPresence, onSubscribed, onError });
await client.publish("chat:lobby", "message", { text: "hi" });      // resolves with { seq }, rejects with HypoutError
client.setPresence("chat:lobby", { name: "Ada" });                  // re-sent after every reconnect
client.status;                                                       // idle | connecting | open | reconnecting | closed
```

- **Reconnect** uses exponential backoff with jitter and resets after a successful `welcome`.
- **Resume**: each channel remembers the last sequence it delivered. After a reconnect it subscribes with that cursor, and the server replays what was missed. Events are delivered once, in order; duplicates are dropped.
- **Loss detection**: if a live event arrives with a sequence more than one ahead, the client holds it, asks for a replay from its cursor, and delivers the missing events first. A lost *last* event cannot be noticed until the next one (or a reconnect) arrives.
- **Errors**: `publish` rejects with `HypoutError` carrying the gate `code` (`HP-104`, ...), `reason` and `retryAfterMs` where relevant.

## Hooks

Wrap your tree in `<HypoutProvider options={{ url, token }}>` (the client is created and closed for you), or pass `client={existing}`.

| Hook | Returns |
| --- | --- |
| `useConnectionStatus()` | the client's status |
| `useChannel(channel, { limit, event, enabled })` | `{ events, head, subscribed, gap, error, publish }` |
| `usePresence(channel, state?)` | `{ members, self, setState }`; pass `state` to announce yourself |

## Components

| Component | Props | Notes |
| --- | --- | --- |
| `LivePresenceRoster` | `channel`, `state?`, `maxVisible?`, `title?` | Joins and leaves are announced politely to screen readers. |
| `ChannelTopologyStudio` | `baseUrl`, `token`, `pollMs?`, `onSelectChannel?` | Admin. A diagram plus a table with the same facts. |
| `WireFrameInspector` | `baseUrl`, `token`, `pollMs?`, `keep?` | Admin. Decodes each header in the browser with `explainHeader`. |
| `ChaosDropSimulator` | `baseUrl`, `token`, `pollMs?` | Admin. Drop, delay, jitter, presets, disconnect-all. |

The last three need an **admin token** and talk to the REST API, so use them in tools you control (the Studio is built from them), not in a page your users see. `HypoutLogo` is exported too.

## Next.js and SSR

The package is marked `"use client"`. `HypoutClient` does nothing until it runs in the browser, so server rendering a page that uses the hooks is safe; they render their empty state first.
