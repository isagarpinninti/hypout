# Guide: from zero to a production deployment

This walks through building a small live feature end to end: a chat room with presence and server alerts. Each step says what you should see.

## 1. Create a project

```bash
mkdir realtime && cd realtime
npx @hypout/cli init
```

You get `hypout.config.json` and `channels/` with three namespaces: `chat` (users publish), `alerts` (only your server publishes) and `doc` (token-only cursors). `.hypout/` is added to `.gitignore`; it will hold your signing secret and the audit ledger.

```bash
npx @hypout/cli validate
```

You should see `3 namespaces valid`. Warnings are worth reading: they flag namespaces anyone can publish to, or that accept any payload.

## 2. Start the server and open the Studio

```bash
npx @hypout/cli studio
```

It prints a WebSocket URL and a Studio link such as `http://127.0.0.1:4320/#token=hpt_…`. Open the link. The token is in the URL fragment, so it never reaches a server, and the Studio removes it from the address bar.

In the Studio pick `chat` on the left, press **Publish**, and see the event appear. The **Gates** panel beside the form shows `HP-101` to `HP-106` for the message you are typing: break the JSON schema and `HP-102` goes red before you send anything.

## 3. Define your own channels

A channel file describes a namespace. Edit `channels/chat.json`: change the `events` schemas, tighten `rateLimit`, raise `retention.events`. Restart `studio` after editing (definitions are read at start-up) and run `validate` first; it names the file and field of any mistake.

Channel names are `namespace` or `namespace:id`, so `chat:room-42` and `chat:room-43` are separate channels that share the `chat` rules. See [Configuration](CONFIGURATION.md) for every field.

## 4. Give browsers a token

Browsers should never see your secret. Your backend mints a short-lived token per user and hands it to the page:

```ts
import { mintToken, parseCapabilities } from "@hypout/core";

// HYPOUT_SECRET must be the same value the server runs with.
const token = mintToken(process.env.HYPOUT_SECRET!, {
  sub: user.id,
  name: user.name,
  caps: parseCapabilities("chat:*=sub,pub,presence"),
  ttlSeconds: 15 * 60,
});
```

For a quick test, `npx @hypout/cli token mint --sub ada --caps "chat:*=sub,pub,presence" --ttl 900` prints one.

Set the secret for real before you deploy: `export HYPOUT_SECRET="$(openssl rand -hex 32)"` and give the same value to every process that mints or verifies tokens. Without it Hypout generates `.hypout/secret` on first run, which is fine for development only.

## 5. Connect from React

```bash
npm install @hypout/react zod
```

```tsx
import "@hypout/react/styles.css";
import { HypoutProvider, LivePresenceRoster, useChannel } from "@hypout/react";

export function ChatRoom({ token, name }: { token: string; name: string }) {
  return (
    <HypoutProvider options={{ url: "ws://localhost:4320/ws", token }}>
      <Messages />
      <LivePresenceRoster channel="chat:lobby" state={{ name }} />
    </HypoutProvider>
  );
}

function Messages() {
  const { events, publish, subscribed, error } = useChannel("chat:lobby", { event: "message", limit: 200 });
  return (
    <section>
      <ul>
        {events.map((e) => (
          <li key={e.seq}>{(e.data as { text: string }).text}</li>
        ))}
      </ul>
      {error ? <p role="alert">{error.code}: {error.message}</p> : null}
      <button disabled={!subscribed} onClick={() => publish("message", { text: "hello" })}>
        Say hello
      </button>
    </section>
  );
}
```

Close the tab or kill the network and reopen it: the client reconnects, resumes from the last sequence it saw and replays what it missed. Open the same page in two browsers and watch the roster follow both.

Not using React? `HypoutClient` is framework-free; see [the React guide](REACT.md). Not using JavaScript at all? The [wire protocol](PROTOCOL.md) is plain JSON over WebSocket.

## 6. Publish from your backend

Server-only channels (`"publish": "server"`) are for events your code decides to send:

```bash
npx @hypout/cli publish alerts notice '{"level":"warn","message":"deploy starting"}'
```

or over HTTP from any language, with an admin token (`hypout token mint --sub backend --admin --ttl 2592000`):

```bash
curl -X POST http://127.0.0.1:4320/api/publish \
  -H "authorization: Bearer $HYPOUT_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"channel":"alerts","event":"notice","data":{"level":"info","message":"hello"}}'
```

A refused publish returns `422` with the gate code (`429` for rate limits); a gate failure is never a silent drop.

## 7. Test failure on purpose

In the Studio open **Chaos**. Pick *Weak Wi-Fi*, publish a few events from another tab, then switch to **Wire frames**: dropped frames are marked. Set the network back to *Clean* and publish once more; the client notices the gap in the sequence, asks for a replay, and delivers the missing events in order. **Disconnect all** cuts every socket to prove reconnect and resume.

Build your app's reconnect handling against this, not against a hope.

## 8. Deploy

Hypout is one Node process. A reasonable production shape:

1. **Run it as a service**, bound to loopback, with a fixed secret and a state directory that survives restarts (for the ledger):

   ```ini
   # /etc/systemd/system/hypout.service
   [Unit]
   Description=Hypout
   After=network.target

   [Service]
   WorkingDirectory=/srv/realtime
   Environment=HYPOUT_SECRET=<from your secret store>
   ExecStart=/usr/bin/npx --no-install hypout studio --quiet --no-studio
   Restart=always
   User=hypout

   [Install]
   WantedBy=multi-user.target
   ```

   Install the CLI in that folder (`npm install @hypout/cli`) so `npx --no-install` finds it. `--no-studio` leaves the Studio unserved, which is what you want on the public internet; use it through an SSH tunnel when you need it.

2. **Terminate TLS in front**, and proxy WebSocket upgrades. With Caddy:

   ```
   realtime.example.com {
     reverse_proxy 127.0.0.1:4320
   }
   ```

   With nginx, add `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` and a `proxy_read_timeout` above your heartbeat interval.

3. **Lock down origins** in `hypout.config.json`: `"allowedOrigins": ["https://app.example.com"]`.

4. **Keep query strings out of logs** at the proxy, since the browser client passes its token as `?token=`.

5. **Watch it**: `GET /health` for liveness; `GET /api/stats` (admin token) for connections, subscriptions, published/delivered/replayed counters and per-gate rejection counts.

6. **Plan for one node.** State is in memory: a restart clears channels and presence, and clients reconnect to an empty history. If you need durable history or several servers, Hypout is not yet the right tool (see the README's limits).

The service unit and proxy snippets above are examples I have not run against your environment; adapt them and test.

## 9. Audit

With `ledger` on (the default), each published event appends a hash-chained line to `.hypout/ledger.jsonl`:

```bash
npx @hypout/cli ledger verify
```

prints the entry count and head hash, or the first entry that was edited, removed or reordered. To detect truncation too, copy the head hash somewhere you trust on a schedule and compare. See the [security model](SECURITY_MODEL.md).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `401` on the WebSocket upgrade | Token signed with a different secret, or expired. Check `HYPOUT_SECRET` on both sides. |
| `403` on the upgrade | The page's origin is not in `allowedOrigins`. |
| `HP-101 unknown_namespace` | No `channels/<name>.json` defines the namespace, or the server was not restarted after you added it. |
| `HP-104 forbidden` | The token's capabilities do not cover that channel and operation (`chat:*=sub` cannot publish). |
| `HP-103 rate_limited` | The namespace's token bucket is empty; wait `retryAfterMs`, or raise `rateLimit`. |
| Connection closes with `1009` | A message over `maxPayload` (64 KiB by default). |
| `publish` rejects with "not connected" | It was called before the socket opened; gate the button on `subscribed`. |
| Studio shows "That token was refused" | Admin tokens from `studio` last 24 hours; restart it for a new link. |
| `hypout publish` says 401 | The CLI and server see different secrets; run it from the project folder or set the same `HYPOUT_SECRET`. |
