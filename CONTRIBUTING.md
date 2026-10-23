# Contributing

Thanks for helping. Bug reports with a reproduction, and small focused pull requests, are the most useful.

## Setup

You need Node.js 20 or newer.

```bash
git clone https://github.com/isagarpinninti/hypout.git
cd hypout
npm install
npm run build
```

## The checks

```bash
npm run typecheck   # tsc for the root, core, react and cli
npm run lint
npm test            # core (also against Zod 3), react, cli
npm run e2e         # Playwright + axe against the real server and Studio (run `npx playwright install chromium` once)
npm run smoke       # pack, install into a clean project, drive the CLI
npm run gates       # all of the above, in order
```

`npm run dev` starts the Studio on port 3000; open it with `?server=http://127.0.0.1:4320` while a `hypout studio` runs.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | The engine. No network code in `engine/`; `protocol.ts` must stay free of `node:*` imports. |
| `packages/cli` | Server, REST API, commands, ledger |
| `packages/react` | Client, hooks, the four Studio components |
| `src/` | The Studio (Next.js, static export copied into the CLI) |
| `e2e/`, `scripts/` | Playwright tests, smoke and bench scripts |

## Rules of the house

- **No WebSocket library.** The point of the project is that the protocol is ours and is tested. Do not add `ws`, `socket.io` or similar, even as a dev dependency of a package that ships.
- **No `any`, no `eval`, no TODOs** left in the tree.
- **A behaviour change comes with a test.** Protocol behaviour is tested on the codec, on the broker without a socket, and on a real socket; pick the lowest level that can show it.
- **Keep it accessible.** The e2e suite runs axe on every Studio view in both themes; new UI has to pass.
- **Bounded by default.** Anything that can grow with traffic needs a limit and a test of the limit.

## Pull requests

Describe what changed and why, and mention anything you could not test. CI runs the full set of checks.
