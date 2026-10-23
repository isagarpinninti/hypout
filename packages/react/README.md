# @hypout/react

A reconnecting [Hypout](https://github.com/isagarpinninti/hypout) client with replay and presence, React hooks, and the Studio's four components.

```bash
npm install @hypout/react zod
```

```tsx
import "@hypout/react/styles.css";
import { HypoutProvider, LivePresenceRoster, useChannel } from "@hypout/react";

<HypoutProvider options={{ url: "ws://localhost:4320/ws", token }}>
  <Chat />
  <LivePresenceRoster channel="chat:lobby" state={{ name: "Ada" }} />
</HypoutProvider>;
```

- `HypoutClient`: framework-free; backoff with jitter, resume from the last sequence, gap detection, CRDT presence.
- Hooks: `useChannel`, `usePresence`, `useConnectionStatus`.
- Components: `LivePresenceRoster`, plus the admin tools `ChannelTopologyStudio`, `WireFrameInspector` and `ChaosDropSimulator`.

Peer dependencies: `react` 18.2 or newer, `zod` 3.23 or 4. See the [React guide](https://github.com/isagarpinninti/hypout/blob/main/docs/REACT.md). MIT licensed.
