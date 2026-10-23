import { createHash, randomBytes } from "node:crypto";

/** RFC 6455 section 1.3: the fixed GUID appended to the client's key before hashing. */
export const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Sec-WebSocket-Accept = base64( SHA-1( Sec-WebSocket-Key + GUID ) ). */
export function computeWebSocketAccept(key: string): string {
  return createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
}

export interface UpgradeRequestLike {
  method?: string | undefined;
  httpVersion?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

/** Just what the handshake needs from a socket, so it can be tested with a fake. */
export interface SocketLike {
  write(chunk: string | Uint8Array): unknown;
  end(chunk?: string | Uint8Array): unknown;
}

const header = (req: UpgradeRequestLike, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(", ") : v;
};

/** True when a comma-separated header (such as `Connection: keep-alive, Upgrade`) contains the token. */
export function hasToken(value: string | undefined, token: string): boolean {
  if (!value) return false;
  return value.split(",").some((t) => t.trim().toLowerCase() === token);
}

export type UpgradeCheck =
  | { ok: true; key: string; accept: string; protocols: string[]; origin: string | undefined }
  | { ok: false; status: 400 | 405 | 426; reason: string; headers?: Record<string, string> };

/** A Sec-WebSocket-Key is the base64 form of exactly 16 random bytes (24 characters, ending in "=="). */
const KEY_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

/** Validates an HTTP request as a WebSocket opening handshake (RFC 6455 section 4.2.1). */
export function checkUpgrade(req: UpgradeRequestLike): UpgradeCheck {
  if (req.method !== "GET") return { ok: false, status: 405, reason: "the WebSocket handshake must be a GET request", headers: { Allow: "GET" } };
  if (req.httpVersion && req.httpVersion !== "1.1") return { ok: false, status: 400, reason: "the WebSocket handshake needs HTTP/1.1 or later" };
  if (!hasToken(header(req, "upgrade"), "websocket")) return { ok: false, status: 400, reason: 'missing "Upgrade: websocket"' };
  if (!hasToken(header(req, "connection"), "upgrade")) return { ok: false, status: 400, reason: 'missing "Connection: Upgrade"' };
  const key = header(req, "sec-websocket-key");
  if (!key || !KEY_PATTERN.test(key.trim())) return { ok: false, status: 400, reason: "Sec-WebSocket-Key must be 16 random bytes in base64" };
  if (header(req, "sec-websocket-version")?.trim() !== "13") {
    return { ok: false, status: 426, reason: "unsupported WebSocket version; Hypout speaks version 13", headers: { "Sec-WebSocket-Version": "13" } };
  }
  const protocols = (header(req, "sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return { ok: true, key: key.trim(), accept: computeWebSocketAccept(key.trim()), protocols, origin: header(req, "origin") };
}

/** The raw `101 Switching Protocols` response. No extensions are ever negotiated. */
export function buildUpgradeResponse(accept: string, protocol?: string): string {
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
    "",
    "",
  ].join("\r\n");
}

const STATUS_TEXT: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 405: "Method Not Allowed", 426: "Upgrade Required", 429: "Too Many Requests", 503: "Service Unavailable" };

/** Refuses an upgrade with a plain HTTP error and closes the connection. */
export function rejectUpgrade(socket: SocketLike, status: number, reason: string, headers: Record<string, string> = {}): void {
  const body = `${reason}\n`;
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "",
    body,
  ];
  socket.end(lines.join("\r\n"));
}

export interface HandleUpgradeOptions {
  /** Subprotocols the server supports, in order of preference. The first one the client offered wins. */
  protocols?: string[];
}

export type UpgradeResult = { ok: true; protocol: string | undefined; origin: string | undefined } | { ok: false; status: number; reason: string };

/**
 * Completes the server side of the opening handshake on a raw socket: validates the request, computes
 * Sec-WebSocket-Accept, and writes `HTTP/1.1 101 Switching Protocols` (or a plain HTTP error). After an `ok`
 * result the socket carries RFC 6455 frames.
 */
export function handleUpgrade(req: UpgradeRequestLike, socket: SocketLike, options: HandleUpgradeOptions = {}): UpgradeResult {
  const check = checkUpgrade(req);
  if (!check.ok) {
    rejectUpgrade(socket, check.status, check.reason, check.headers);
    return { ok: false, status: check.status, reason: check.reason };
  }
  const protocol = options.protocols?.find((p) => check.protocols.includes(p));
  socket.write(buildUpgradeResponse(check.accept, protocol));
  return { ok: true, protocol, origin: check.origin };
}

/* ───────────────────── client side (used by the CLI and tests) ───────────────────── */

export const createClientKey = (): string => randomBytes(16).toString("base64");

export function buildClientRequest(opts: { host: string; path: string; key: string; protocols?: string[]; origin?: string; headers?: Record<string, string> }): string {
  return [
    `GET ${opts.path} HTTP/1.1`,
    `Host: ${opts.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${opts.key}`,
    "Sec-WebSocket-Version: 13",
    ...(opts.protocols?.length ? [`Sec-WebSocket-Protocol: ${opts.protocols.join(", ")}`] : []),
    ...(opts.origin ? [`Origin: ${opts.origin}`] : []),
    ...Object.entries(opts.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    "",
    "",
  ].join("\r\n");
}

/** Checks a server's reply to the opening handshake. Returns an error message, or null when it is valid. */
export function validateServerHandshake(head: string, key: string): string | null {
  const [statusLine = "", ...lines] = head.split("\r\n");
  const status = /^HTTP\/1\.1 (\d{3})/.exec(statusLine)?.[1];
  if (status !== "101") return `the server answered "${statusLine}", not 101 Switching Protocols`;
  const headers = new Map<string, string>();
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  if (!hasToken(headers.get("upgrade"), "websocket")) return 'the server did not answer "Upgrade: websocket"';
  if (!hasToken(headers.get("connection"), "upgrade")) return 'the server did not answer "Connection: Upgrade"';
  if (headers.get("sec-websocket-accept") !== computeWebSocketAccept(key)) return "Sec-WebSocket-Accept does not match the key that was sent";
  return null;
}
