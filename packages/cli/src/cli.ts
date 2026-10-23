import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hexdump, mintToken, parseCapabilities } from "@hypout/core";
import { UsageError, flagBool, flagInt, flagString, parseArgs } from "./args";
import { runInit } from "./commands/init";
import { parseData, publish } from "./commands/publish";
import { runValidate } from "./commands/validate";
import { ConfigError, DEFAULT_PORT, STATE_DIR, loadConfig } from "./config";
import { verifyLedger } from "./ledger";
import { createHypoutServer } from "./server";

export interface Io {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
}

export const version = (): string => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
};

const HELP = `hypout: a self-hosted real-time WebSocket server with CRDT presence and replay

Usage: hypout <command> [options]

Commands:
  init [dir]                      Write hypout.config.json and example channels
  validate                        Check the config and channel definitions
  studio                          Start the server and open the Studio   (alias: start)
  publish <channel> <event> [json]  Publish an event through a running server
  token mint --sub <id> [--caps "chat:*=sub,pub"] [--ttl 3600] [--admin]
  ledger verify                   Check the audit ledger's hash chain
  inspect <hex>                   Explain the bytes of a WebSocket frame

Common options:
  --port <n>      Port to listen on or connect to (default ${DEFAULT_PORT})
  --host <addr>   Interface to bind (default 127.0.0.1)
  --url <url>     Server URL for publish (default http://127.0.0.1:${DEFAULT_PORT})
  --config <file> Config file (default hypout.config.json)
  --json          Machine-readable output
  -h, --help      Show this help
  -v, --version   Show the version

Exit codes: 0 success, 1 a check failed, 2 bad usage.
`;

const BOOLEANS = ["json", "admin", "force", "no-ledger", "no-studio", "help", "version", "quiet"] as const;

/** Runs a command and returns the exit code. A long-running command (studio) resolves only when it stops. */
export async function main(argv: string[], io: Io, signal?: AbortSignal): Promise<number> {
  const args = parseArgs(argv, BOOLEANS);
  const [command, ...rest] = args.positional;
  try {
    if (flagBool(args, "version") || command === "version" || argv.includes("-v")) {
      io.out(version());
      return 0;
    }
    if (!command || flagBool(args, "help") || command === "help" || argv.includes("-h")) {
      io.out(HELP);
      return 0;
    }
    switch (command) {
      case "init": {
        const r = runInit(resolve(io.cwd, rest[0] ?? "."), flagBool(args, "force"));
        if (flagBool(args, "json")) io.out(JSON.stringify(r));
        else {
          for (const f of r.created) io.out(`created  ${f}`);
          for (const f of r.skipped) io.out(`kept     ${f} (already exists; use --force to overwrite)`);
          io.out(`\nNext: hypout validate && hypout studio`);
        }
        return 0;
      }
      case "validate": {
        const r = runValidate(io.cwd, flagString(args, "config"));
        if (flagBool(args, "json")) io.out(JSON.stringify(r, null, 2));
        else {
          for (const n of r.namespaces) io.out(`ok  ${n.namespace}  events: ${n.events.join(", ") || "(any)"}  sub:${n.access.subscribe} pub:${n.access.publish} presence:${n.access.presence}  keeps ${n.retention}`);
          for (const w of r.warnings) io.out(`warn  ${w}`);
          for (const e of r.errors) io.err(`error  ${e}`);
          io.out(r.ok ? `\n${r.namespaces.length} namespace${r.namespaces.length === 1 ? "" : "s"} valid.` : `\nInvalid.`);
        }
        return r.ok ? 0 : 1;
      }
      case "studio":
      case "start": {
        return await runStudio(args, io, signal);
      }
      case "publish": {
        const [channel, event, raw] = rest;
        if (!channel || !event) throw new UsageError("usage: hypout publish <channel> <event> [json]");
        const data = parseData(raw);
        const port = flagInt(args, "port", 1, 65535);
        const url = flagString(args, "url") ?? `http://127.0.0.1:${port ?? DEFAULT_PORT}`;
        let token = flagString(args, "token") ?? process.env["HYPOUT_ADMIN_TOKEN"];
        if (!token) {
          const loaded = loadConfig(io.cwd, flagString(args, "config") ? { file: flagString(args, "config") as string } : {});
          token = mintToken(loaded.secret, { sub: "cli", caps: [], admin: true, ttlSeconds: 300 });
        }
        const r = await publish({ url, token, channel, event, data });
        if (flagBool(args, "json")) io.out(JSON.stringify(r));
        else if (r.ok) io.out(`published ${channel} #${r.seq}`);
        else io.err(`${r.code ?? "error"}: ${r.message}`);
        return r.ok ? 0 : 1;
      }
      case "token": {
        if (rest[0] !== "mint") throw new UsageError("usage: hypout token mint --sub <id> [--caps ...] [--ttl seconds] [--admin]");
        const sub = flagString(args, "sub");
        if (!sub) throw new UsageError("--sub is required");
        const caps = parseCapabilitiesFlag(flagString(args, "caps"));
        const ttl = flagInt(args, "ttl", 10, 30 * 24 * 3600) ?? 3600;
        const loaded = loadConfig(io.cwd, flagString(args, "config") ? { file: flagString(args, "config") as string } : {});
        const name = flagString(args, "name");
        const token = mintToken(loaded.secret, { sub, ...(name ? { name } : {}), caps, ttlSeconds: ttl, ...(flagBool(args, "admin") ? { admin: true } : {}) });
        io.out(flagBool(args, "json") ? JSON.stringify({ token, ttlSeconds: ttl }) : token);
        return 0;
      }
      case "ledger": {
        if (rest[0] !== "verify") throw new UsageError("usage: hypout ledger verify [file]");
        const file = rest[1] ?? join(io.cwd, STATE_DIR, "ledger.jsonl");
        const r = verifyLedger(file);
        if (flagBool(args, "json")) io.out(JSON.stringify(r));
        else if (r.ok) io.out(`ok  ${r.entries} entr${r.entries === 1 ? "y" : "ies"}, head ${r.head.slice(0, 16)}…`);
        else io.err(`BROKEN at entry ${r.brokenAt}: ${r.reason}`);
        return r.ok ? 0 : 1;
      }
      case "inspect": {
        const hex = rest.join("").replace(/0x|[\s,:]/gi, "");
        if (!hex || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new UsageError("usage: hypout inspect <hex bytes of one frame>");
        const bytes = Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
        const { explainHeader } = await import("@hypout/core");
        for (const f of explainHeader(bytes)) io.out(`${f.name.padEnd(14)} ${f.bits.padEnd(10)} ${f.value}${f.note ? `  ${f.note}` : ""}`);
        io.out(`\n${hexdump(bytes)}`);
        return 0;
      }
      default:
        throw new UsageError(`unknown command "${command}". Run hypout --help`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 2;
    }
    if (e instanceof ConfigError) {
      io.err(e.message);
      return 1;
    }
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

function parseCapabilitiesFlag(spec: string | undefined) {
  if (!spec) return [];
  try {
    return parseCapabilities(spec);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : "invalid --caps");
  }
}

async function runStudio(args: ReturnType<typeof parseArgs>, io: Io, signal?: AbortSignal): Promise<number> {
  const loaded = loadConfig(io.cwd, flagString(args, "config") ? { file: flagString(args, "config") as string } : {});
  const port = flagInt(args, "port", 0, 65535) ?? loaded.config.port;
  const host = flagString(args, "host") ?? loaded.config.host;
  const here = dirname(fileURLToPath(import.meta.url));
  const studioDir = flagBool(args, "no-studio") ? undefined : join(here, "..", "studio");
  const server = createHypoutServer({
    secret: loaded.secret,
    port,
    host,
    channels: loaded.channels,
    allowedOrigins: loaded.config.allowedOrigins,
    maxPayload: loaded.config.maxPayload,
    heartbeat: loaded.config.heartbeat,
    maxConnections: loaded.config.maxConnections,
    maxChannels: loaded.config.maxChannels,
    channelIdleMs: loaded.config.channelIdleMinutes * 60_000,
    version: version(),
    ...(loaded.config.ledger && !flagBool(args, "no-ledger") ? { ledgerPath: join(loaded.root, STATE_DIR, "ledger.jsonl") } : {}),
    ...(studioDir ? { studioDir } : {}),
    ...(flagBool(args, "quiet") ? {} : { log: (l: string) => io.err(`[hypout] ${l}`) }),
  });
  const addr = await server.listen();
  const base = server.url();
  io.out(`Hypout ${version()} listening on ${base}`);
  io.out(`  WebSocket   ws://${addr.host === "::" || addr.host === "0.0.0.0" ? "localhost" : addr.host}:${addr.port}/ws`);
  io.out(`  Studio      ${base}/#token=${server.adminToken}`);
  io.out(`  Channels    ${loaded.channels.map((c) => c.namespace).join(", ") || "(none; run hypout init)"}`);
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") io.err(`warning: bound to ${host}; the Studio link above carries an admin token, so put the server behind TLS and keep that link private.`);
  await new Promise<void>((done) => {
    const stop = (): void => done();
    signal?.addEventListener("abort", stop, { once: true });
    if (!signal) {
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  });
  io.out("\nshutting down…");
  await server.close();
  return 0;
}
