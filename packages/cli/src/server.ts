import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { AddressInfo, Socket } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { z } from "zod";
import {
  Broker, ChannelRegistry, CloseCode, FrameDecoder, HeartbeatMonitor, ProtocolError, encodeClose, encodePing, encodePong, encodeText, handleUpgrade, mintToken, parseCapabilities,
  parseClientMessage, preflight, verifyToken, type ChannelDefinitionSchema, type ClientHandle, type DecodedItem, type Principal, type ServerMessage,
} from "@hypout/core";
import { ChaosSimulator } from "./chaos";
import { newConnectionId } from "./config";
import { Ledger } from "./ledger";
import { WireTap } from "./tap";

export interface HypoutServerOptions {
  secret: string;
  port?: number;
  host?: string;
  channels?: Array<z.input<typeof ChannelDefinitionSchema>>;
  allowedOrigins?: string[];
  maxPayload?: number;
  heartbeat?: { intervalMs: number; timeoutMs: number };
  maxConnections?: number;
  maxChannels?: number;
  /** Idle channels (no subscribers, no activity) older than this are dropped. Default 24 hours. */
  channelIdleMs?: number;
  /** Path of the audit ledger; omit to run without one. */
  ledgerPath?: string;
  /** Folder of the built Studio to serve at `/`. */
  studioDir?: string;
  version?: string;
  log?: (line: string) => void;
}

export interface HypoutServer {
  readonly broker: Broker;
  readonly registry: ChannelRegistry;
  readonly chaos: ChaosSimulator;
  readonly tap: WireTap;
  readonly ledger: Ledger | null;
  /** A token that may use the REST API and the Studio. Valid for 24 hours. */
  readonly adminToken: string;
  readonly http: Server;
  listen(): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
  /** Cuts every WebSocket without a closing handshake, as a network failure would. Returns how many were cut. */
  severAll(): number;
  url(): string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".map": "application/json",
};

const MAX_BODY = 256 * 1024;
const SLOW_CONSUMER_BYTES = 4 * 1024 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Host {
  chaos: ChaosSimulator;
  tap: WireTap;
}

interface Encoded {
  bytes: Uint8Array;
  opcode: number;
  payloadLength: number;
  text: string;
}

/** The broker hands the same message object to every subscriber, so it is serialised and framed once, not once per socket. */
const encoded = new WeakMap<ServerMessage, Encoded>();
function encodeOnce(message: ServerMessage): Encoded {
  let e = encoded.get(message);
  if (!e) {
    const text = JSON.stringify(message);
    const bytes = encodeText(text);
    const header = (bytes[1] as number) === 126 ? 4 : (bytes[1] as number) === 127 ? 10 : 2;
    e = { bytes, opcode: 1, payloadLength: bytes.length - header, text };
    encoded.set(message, e);
  }
  return e;
}

/** One WebSocket peer: decodes its frames, feeds the broker, and encodes what the broker sends back. */
class Peer implements ClientHandle {
  readonly decoder: FrameDecoder;
  closing = false;

  constructor(
    readonly id: string,
    readonly socket: Duplex,
    private readonly host: Host,
    maxPayload: number,
  ) {
    this.decoder = new FrameDecoder({ requireMask: true, maxPayload, maxMessage: maxPayload });
  }

  send(message: ServerMessage): void {
    if (this.closing || this.socket.destroyed) return;
    const lossy = message.t === "event" || message.t === "presence.diff" || message.t === "presence.snapshot";
    const out = encodeOnce(message);
    if (lossy && this.host.chaos.active) {
      const d = this.host.chaos.decide();
      if (d.drop) {
        this.host.tap.recordOut(this.id, out.bytes, out, true);
        return;
      }
      if (d.delayMs > 0) {
        setTimeout(() => this.write(out), d.delayMs).unref();
        return;
      }
    }
    this.write(out);
  }

  private write(out: Encoded): void {
    if (this.closing || this.socket.destroyed) return;
    this.host.tap.recordOut(this.id, out.bytes, out);
    this.socket.write(out.bytes);
    if (this.socket.writableLength > SLOW_CONSUMER_BYTES) this.close(CloseCode.PolicyViolation, "slow consumer");
  }

  /** Control frames bypass chaos and the closing check. */
  control(bytes: Uint8Array): void {
    if (this.socket.destroyed) return;
    this.host.tap.record(this.id, "out", bytes);
    this.socket.write(bytes);
  }

  close(code: number, reason: string): void {
    if (this.closing) return;
    this.closing = true;
    if (!this.socket.destroyed) {
      const bytes = encodeClose(code, reason);
      this.host.tap.record(this.id, "out", bytes);
      this.socket.end(bytes);
    }
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }
}

export function createHypoutServer(options: HypoutServerOptions): HypoutServer {
  const log = options.log ?? (() => undefined);
  const registry = new ChannelRegistry(options.channels ?? []);
  const maxPayload = options.maxPayload ?? 64 * 1024;
  const heartbeat = options.heartbeat ?? { intervalMs: 30_000, timeoutMs: 10_000 };
  const chaos = new ChaosSimulator();
  const tap = new WireTap();
  const ledger = options.ledgerPath ? new Ledger(options.ledgerPath) : null;
  const startedAt = Date.now();
  const allowedOrigins = options.allowedOrigins ?? [];
  const host: Host = { chaos, tap };
  const peers = new Map<string, Peer>();
  const monitor = new HeartbeatMonitor(heartbeat.intervalMs, heartbeat.timeoutMs);
  const adminPrincipal: Principal = { sub: "studio", caps: [], admin: true };

  const broker = new Broker({
    registry,
    maxPayload,
    heartbeat,
    nodeId: "hypout",
    ...(options.maxChannels !== undefined ? { maxChannels: options.maxChannels } : {}),
    verifyToken: (token, now) => {
      const r = verifyToken(options.secret, token, now);
      return r.ok ? { ok: true, principal: toPrincipal(r.claims) } : { ok: false, reason: r.reason };
    },
    onPublish: ({ channel, event }) => {
      ledger?.append({ ts: event.ts, channel, seq: event.seq, ev: event.ev, from: event.from, data: event.data });
    },
  });

  const adminToken = mintToken(options.secret, { sub: "studio", name: "Studio", caps: [], admin: true, ttlSeconds: 24 * 3600 });
  const studioDir = options.studioDir && existsSync(join(options.studioDir, "index.html")) ? resolve(options.studioDir) : null;

  /* ───────────── HTTP ───────────── */

  const http = createHttpServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`error: ${e instanceof Error ? e.message : String(e)}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, { error: e instanceof HttpError ? e.message : "internal error" }, req);
    });
  });
  http.headersTimeout = 15_000;
  http.requestTimeout = 30_000;

  const cors = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (!origin) return {};
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) return {};
    return { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" };
  };

  function sendJson(res: ServerResponse, status: number, body: unknown, req: IncomingMessage): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...cors(req) });
    res.end(JSON.stringify(body));
  }

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolveBody, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      req.on("data", (c: Buffer) => {
        if (failed) return;
        size += c.length;
        if (size > MAX_BODY) {
          failed = true;
          reject(new HttpError(413, "request body too large"));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (failed) return;
        if (size === 0) return resolveBody({});
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch {
          reject(new HttpError(400, "body is not valid JSON"));
        }
      });
      req.on("error", reject);
    });

  const requireAdmin = (req: IncomingMessage): void => {
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    const r = token ? verifyToken(options.secret, token) : null;
    if (!r?.ok || !r.claims.admin) throw new HttpError(401, "an admin token is required (Authorization: Bearer hpt_…)");
  };

  const asRecord = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, cors(req));
      res.end();
      return;
    }
    if (path === "/health") {
      sendJson(res, 200, { ok: true, version: options.version ?? "0.0.0", uptimeMs: Date.now() - startedAt, connections: peers.size }, req);
      return;
    }
    if (path.startsWith("/api/")) {
      requireAdmin(req);
      await api(req, res, method, path, url);
      return;
    }
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
    serveStatic(req, res, path);
  }

  async function api(req: IncomingMessage, res: ServerResponse, method: string, path: string, url: URL): Promise<void> {
    if (method === "GET" && path === "/api/stats") {
      sendJson(res, 200, {
        version: options.version ?? "0.0.0",
        uptimeMs: Date.now() - startedAt,
        ...broker.stats(),
        chaos: { ...chaos.current, active: chaos.active, dropped: chaos.dropped, delayed: chaos.delayed },
        ledger: ledger ? { entries: ledger.entries, head: ledger.head } : null,
        maxPayload,
        heartbeat,
        wireHead: tap.head,
      }, req);
      return;
    }
    if (method === "GET" && path === "/api/channels") {
      sendJson(res, 200, { namespaces: registry.definitions(), channels: broker.stats().channels }, req);
      return;
    }
    const m = /^\/api\/channels\/([^/]+)\/(events|members)$/.exec(path);
    if (method === "GET" && m) {
      const name = decodeURIComponent(m[1] as string);
      const resolved = registry.resolve(name);
      if (!resolved.ok) throw new HttpError(404, resolved.message);
      if (m[2] === "events") sendJson(res, 200, { channel: name, head: broker.head(name), events: broker.recent(name, clampInt(url.searchParams.get("limit"), 1, 500, 50)) }, req);
      else sendJson(res, 200, { channel: name, members: broker.members(name) }, req);
      return;
    }
    if (method === "POST" && path === "/api/publish") {
      const body = asRecord(await readBody(req));
      const channel = typeof body["channel"] === "string" ? body["channel"] : "";
      const event = typeof body["event"] === "string" ? body["event"] : "";
      if (!channel || !event) throw new HttpError(400, "channel and event are required");
      const r = broker.publish(channel, event, body["data"] ?? null);
      if (!r.ok) {
        sendJson(res, r.code === "HP-103" ? 429 : 422, { ok: false, code: r.code, reason: r.reason, message: r.message }, req);
        return;
      }
      sendJson(res, 200, { ok: true, channel, seq: r.seq, ts: r.event.ts }, req);
      return;
    }
    if (method === "POST" && path === "/api/preflight") {
      const body = asRecord(await readBody(req));
      const op = body["op"] === "sub" || body["op"] === "pub" || body["op"] === "presence" ? body["op"] : "pub";
      const channel = typeof body["channel"] === "string" ? body["channel"] : "";
      const data = body["data"] ?? null;
      const bytes = Buffer.byteLength(JSON.stringify({ t: op, ch: channel, ev: body["event"], data }));
      const report = preflight(registry, {
        op,
        channel,
        principal: body["anonymous"] === true ? null : adminPrincipal,
        bytes,
        data: data as never,
        head: broker.head(channel),
        ...(typeof body["event"] === "string" ? { event: body["event"] } : {}),
        ...(typeof body["lastSeq"] === "number" ? { lastSeq: body["lastSeq"] } : {}),
      });
      sendJson(res, 200, report, req);
      return;
    }
    if (path === "/api/wire") {
      if (method === "DELETE") {
        tap.clear();
        sendJson(res, 200, { ok: true }, req);
        return;
      }
      if (method === "GET") {
        sendJson(res, 200, { head: tap.head, frames: tap.since(clampInt(url.searchParams.get("since"), 0, Number.MAX_SAFE_INTEGER, 0), clampInt(url.searchParams.get("limit"), 1, 500, 200)) }, req);
        return;
      }
    }
    if (path === "/api/chaos" && (method === "GET" || method === "POST")) {
      if (method === "POST") {
        const body = asRecord(await readBody(req));
        const next: Partial<{ dropRate: number; delayMs: number; jitterMs: number; seed: number }> = {};
        for (const k of ["dropRate", "delayMs", "jitterMs", "seed"] as const) {
          const v = body[k];
          if (v === undefined) continue;
          if (typeof v !== "number") throw new HttpError(400, `${k} must be a number`);
          next[k] = v;
        }
        try {
          if (body["reset"] === true) chaos.reset();
          chaos.set(next);
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : "invalid chaos settings");
        }
      }
      sendJson(res, 200, { ...chaos.current, active: chaos.active, dropped: chaos.dropped, delayed: chaos.delayed }, req);
      return;
    }
    if (method === "POST" && path === "/api/sever") {
      sendJson(res, 200, { severed: severAll() }, req);
      return;
    }
    if (method === "POST" && path === "/api/token") {
      const body = asRecord(await readBody(req));
      const sub = typeof body["sub"] === "string" ? body["sub"] : "";
      if (!sub) throw new HttpError(400, "sub is required");
      let caps;
      try {
        caps = typeof body["caps"] === "string" ? parseCapabilities(body["caps"]) : [];
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "invalid caps");
      }
      const ttl = typeof body["ttlSeconds"] === "number" ? Math.min(30 * 24 * 3600, Math.max(10, Math.floor(body["ttlSeconds"]))) : 3600;
      const token = mintToken(options.secret, { sub, ...(typeof body["name"] === "string" ? { name: body["name"] } : {}), caps, ttlSeconds: ttl });
      sendJson(res, 200, { token, ttlSeconds: ttl }, req);
      return;
    }
    throw new HttpError(404, "no such endpoint");
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): void {
    if (!studioDir) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Hypout ${options.version ?? ""} is running.\nWebSocket: ws://${req.headers.host ?? "localhost"}/ws\nThe Studio is not bundled in this build; see /health.\n`);
      return;
    }
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(path)).replace(/^[/\\]+/, "");
    } catch {
      throw new HttpError(400, "bad path");
    }
    if (rel === "" || rel.endsWith("/") || rel.endsWith("\\")) rel += "index.html";
    let file = resolve(studioDir, rel);
    if (file !== studioDir && !file.startsWith(studioDir + sep)) throw new HttpError(403, "forbidden");
    if (!existsSync(file) || !statSync(file).isFile()) {
      const alt = `${file}.html`;
      if (existsSync(alt) && statSync(alt).isFile()) file = alt;
      else {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
    }
    const immutable = file.includes(`${sep}_next${sep}static${sep}`);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(req.method === "HEAD" ? undefined : readFileSync(file));
  }

  /* ───────────── WebSocket ───────────── */

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    socket.on("error", () => undefined);
    const refuse = (line: string, extra = ""): void => {
      socket.end(`HTTP/1.1 ${line}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (url.pathname !== "/ws") return refuse("404 Not Found");
    const origin = req.headers.origin;
    if (origin && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) return refuse("403 Forbidden");
    if (peers.size >= (options.maxConnections ?? 10_000)) return refuse("503 Service Unavailable", "Retry-After: 5\r\n");

    let principal: Principal | null = null;
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    const presented = url.searchParams.get("token") ?? bearer;
    if (presented) {
      const r = verifyToken(options.secret, presented);
      if (!r.ok) return refuse("401 Unauthorized", `X-Hypout-Reason: ${r.reason}\r\n`);
      principal = toPrincipal(r.claims);
    }
    const result = handleUpgrade(req, socket, { protocols: ["hypout.v1"] });
    if (!result.ok) return;

    const id = newConnectionId();
    const peer = new Peer(id, socket, host, maxPayload);
    peers.set(id, peer);
    monitor.open(id, Date.now());
    (socket as Socket).setNoDelay(true);

    // An upgraded socket is half-open: answer the client's FIN or the socket would leak.
    socket.on("end", () => socket.end());
    socket.on("close", () => {
      peers.delete(id);
      monitor.close(id);
      broker.disconnect(id);
    });

    const handle = (items: DecodedItem[]): void => {
      for (const item of items) {
        if (peer.closing) return;
        if (item.kind === "message") {
          if (item.opcode === 2) {
            peer.close(CloseCode.UnsupportedData, "binary messages are not supported");
            return;
          }
          const parsed = parseClientMessage(item.text ?? "");
          if (!parsed.ok) {
            peer.send({ t: "error", code: "HP-000", reason: "bad_message", message: parsed.reason });
            continue;
          }
          broker.receive(id, parsed.message, item.length);
        } else if (item.kind === "ping") {
          peer.control(encodePong(item.payload));
        } else if (item.kind === "pong") {
          monitor.pong(id, Date.now());
        } else if (item.kind === "close") {
          peer.closing = true;
          const bytes = encodeClose(item.code ?? CloseCode.Normal);
          tap.record(id, "out", bytes);
          socket.end(bytes);
          return;
        }
      }
    };

    const onData = (chunk: Buffer): void => {
      monitor.seen(id, Date.now());
      tap.record(id, "in", chunk);
      try {
        handle(peer.decoder.push(chunk));
      } catch (e) {
        if (e instanceof ProtocolError) peer.close(e.code, e.message);
        else {
          log(`error: ${e instanceof Error ? e.message : String(e)}`);
          peer.close(CloseCode.InternalError, "internal error");
        }
      }
    };
    socket.on("data", onData);

    broker.connect(peer, principal);
    if (head.length > 0) onData(head);
    log(`connect ${id}${principal ? ` as ${principal.sub}` : ""}`);
  });

  const severAll = (): number => {
    const n = peers.size;
    for (const p of [...peers.values()]) p.socket.destroy();
    return n;
  };

  let timer: NodeJS.Timeout | null = null;
  let lastSweep = Date.now();
  const tick = (): void => {
    const now = Date.now();
    if (now - lastSweep >= 60_000) {
      lastSweep = now;
      const n = broker.sweep(options.channelIdleMs ?? 24 * 3600_000, now);
      if (n > 0) log(`swept ${n} idle channel${n === 1 ? "" : "s"}`);
    }
    const { ping, evict } = monitor.tick(Date.now());
    for (const id of ping) peers.get(id)?.control(encodePing());
    for (const id of evict) {
      log(`evict ${id} (no pong)`);
      peers.get(id)?.close(CloseCode.GoingAway, "heartbeat timeout");
    }
  };

  return {
    broker,
    registry,
    chaos,
    tap,
    ledger,
    adminToken,
    http,
    severAll,
    listen: () =>
      new Promise<{ port: number; host: string }>((resolveListen, reject) => {
        http.once("error", reject);
        http.listen(options.port ?? 4320, options.host ?? "127.0.0.1", () => {
          http.off("error", reject);
          timer = setInterval(tick, Math.max(100, Math.min(1000, Math.floor(heartbeat.timeoutMs / 4)))).unref();
          const a = http.address() as AddressInfo;
          resolveListen({ port: a.port, host: a.address });
        });
      }),
    close: () =>
      new Promise<void>((resolveClose) => {
        if (timer) clearInterval(timer);
        for (const p of peers.values()) p.close(CloseCode.GoingAway, "server shutting down");
        http.close(() => resolveClose());
        http.closeIdleConnections();
        setTimeout(() => {
          for (const p of peers.values()) p.socket.destroy();
          http.closeAllConnections();
        }, 1500).unref();
      }),
    url: () => {
      const a = http.address() as AddressInfo | null;
      return a ? `http://${a.address === "::" || a.address === "0.0.0.0" ? "localhost" : a.address}:${a.port}` : "";
    },
  };
}

function toPrincipal(c: { sub: string; name?: string | undefined; avatar?: string | undefined; caps: Principal["caps"]; admin?: boolean | undefined }): Principal {
  return { sub: c.sub, caps: c.caps, ...(c.name !== undefined ? { name: c.name } : {}), ...(c.avatar !== undefined ? { avatar: c.avatar } : {}), ...(c.admin ? { admin: true } : {}) };
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
