import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ChannelDefinitionSchema, generateSecret, type ChannelDefinition } from "@hypout/core";

export const CONFIG_FILE = "hypout.config.json";
export const STATE_DIR = ".hypout";
export const DEFAULT_PORT = 4320;

export const ConfigSchema = z
  .object({
    port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
    host: z.string().min(1).default("127.0.0.1"),
    /** Folder of channel definition files, relative to the config file. */
    channels: z.string().min(1).default("channels"),
    /** Browser origins allowed to open a WebSocket. Empty allows any origin (fine for tokens-in-URL, not for cookies). */
    allowedOrigins: z.array(z.string()).default([]),
    maxPayload: z.number().int().min(256).max(16 * 1024 * 1024).default(64 * 1024),
    heartbeat: z.object({ intervalMs: z.number().int().min(1000).default(30_000), timeoutMs: z.number().int().min(500).default(10_000) }).default({ intervalMs: 30_000, timeoutMs: 10_000 }),
    maxConnections: z.number().int().min(1).default(10_000),
    /** Channels held in memory at once. New names beyond this are refused (HP-101). */
    maxChannels: z.number().int().min(1).default(10_000),
    /** A channel with no subscribers and no activity this long is dropped, with its retained events. */
    channelIdleMinutes: z.number().min(1).default(1440),
    ledger: z.boolean().default(true),
  })
  .strict();

export type HypoutConfig = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  root: string;
  file: string | null;
  config: HypoutConfig;
  channels: ChannelDefinition[];
  secret: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw new ConfigError(`${path}: ${e instanceof Error ? e.message : "cannot be read"}`);
  }
};

const describeIssues = (where: string, error: z.ZodError): string =>
  error.issues.map((i) => `${where}${i.path.length ? `: ${i.path.join(".")}` : ""}: ${i.message}`).join("\n");

/** Reads every `*.json` in the channels folder (one definition, or an array of them). */
export function loadChannels(dir: string): ChannelDefinition[] {
  if (!existsSync(dir)) return [];
  const out: ChannelDefinition[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const raw = readJson(join(dir, name));
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      const parsed = ChannelDefinitionSchema.safeParse(item);
      if (!parsed.success) throw new ConfigError(describeIssues(join(dir, name), parsed.error));
      if (seen.has(parsed.data.namespace)) throw new ConfigError(`${join(dir, name)}: namespace "${parsed.data.namespace}" is defined twice`);
      seen.add(parsed.data.namespace);
      out.push(parsed.data);
    }
  }
  return out;
}

/** The signing secret: `HYPOUT_SECRET`, else `.hypout/secret` (created on first run, owner-readable only). */
export function resolveSecret(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["HYPOUT_SECRET"];
  if (fromEnv) {
    if (fromEnv.length < 16) throw new ConfigError("HYPOUT_SECRET must be at least 16 characters");
    return fromEnv;
  }
  const dir = join(root, STATE_DIR);
  const file = join(dir, "secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dir, { recursive: true });
  const secret = generateSecret();
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export function loadConfig(cwd: string, options: { file?: string; env?: NodeJS.ProcessEnv } = {}): LoadedConfig {
  const root = resolve(cwd);
  const path = options.file ? resolve(root, options.file) : join(root, CONFIG_FILE);
  const hasFile = existsSync(path);
  if (options.file && !hasFile) throw new ConfigError(`${path}: no such file`);
  let config: HypoutConfig;
  if (hasFile) {
    const parsed = ConfigSchema.safeParse(readJson(path));
    if (!parsed.success) throw new ConfigError(describeIssues(path, parsed.error));
    config = parsed.data;
  } else {
    config = ConfigSchema.parse({});
  }
  const channels = loadChannels(resolve(root, config.channels));
  return { root, file: hasFile ? path : null, config, channels, secret: resolveSecret(root, options.env) };
}

/** Random id for a connection. */
export const newConnectionId = (): string => `c_${randomBytes(6).toString("hex")}`;
