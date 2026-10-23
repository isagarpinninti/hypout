import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILE, DEFAULT_PORT } from "../config";

const chat = {
  namespace: "chat",
  description: "Room chat. Anyone can listen; publishing needs a token.",
  access: { subscribe: "public", publish: "token", presence: "public" },
  events: {
    message: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["text"] },
    typing: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] },
  },
  rateLimit: { capacity: 20, refillPerSecond: 5 },
  retention: { events: 200 },
};

const alerts = {
  namespace: "alerts",
  description: "Server-to-browser alerts. Only the server (REST or `hypout publish`) can publish.",
  access: { subscribe: "public", publish: "server", presence: "off" },
  events: {
    notice: { type: "object", properties: { level: { type: "string", enum: ["info", "warn", "error"] }, message: { type: "string", maxLength: 500 } }, required: ["level", "message"] },
  },
  retention: { events: 100 },
};

const doc = {
  namespace: "doc",
  description: "Collaborative cursors and selections for a document (use channel names like doc:42).",
  access: { subscribe: "token", publish: "token", presence: "token" },
  events: {
    cursor: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
  },
  rateLimit: { capacity: 60, refillPerSecond: 30 },
  retention: { events: 50 },
  presence: { maxMembers: 200 },
};

export interface InitResult {
  created: string[];
  skipped: string[];
}

export function runInit(dir: string, force = false): InitResult {
  const root = resolve(dir);
  mkdirSync(join(root, "channels"), { recursive: true });
  const files: Array<[string, unknown]> = [
    [CONFIG_FILE, { port: DEFAULT_PORT, host: "127.0.0.1", channels: "channels", allowedOrigins: [], maxPayload: 65536, heartbeat: { intervalMs: 30000, timeoutMs: 10000 } }],
    ["channels/chat.json", chat],
    ["channels/alerts.json", alerts],
    ["channels/doc.json", doc],
  ];
  const created: string[] = [];
  const skipped: string[] = [];
  for (const [rel, body] of files) {
    const path = join(root, rel);
    if (existsSync(path) && !force) {
      skipped.push(rel);
      continue;
    }
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    created.push(rel);
  }
  // The state folder holds the signing secret and the ledger: keep it out of git.
  const ignore = join(root, ".gitignore");
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!/^\.hypout\/?$/m.test(current)) {
    appendFileSync(ignore, `${current && !current.endsWith("\n") ? "\n" : ""}.hypout/\n`);
    created.push(".gitignore (.hypout/)");
  }
  return { created, skipped };
}
