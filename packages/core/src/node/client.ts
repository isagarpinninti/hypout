import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { buildClientRequest, createClientKey, validateServerHandshake } from "../codec/handshake";
import { CloseCode, FrameDecoder, ProtocolError, encodeBinary, encodeClose, encodePing, encodePong, encodeText, type DecodedItem, type FrameInfo } from "../codec/frames";

export interface WsClientOptions {
  protocols?: string[];
  origin?: string;
  headers?: Record<string, string>;
  maxPayload?: number;
  connectTimeoutMs?: number;
  /** Called for every frame in both directions, with the raw bytes (for wire inspection). */
  onFrame?: (direction: "in" | "out", frame: FrameInfo | { wire: Uint8Array }) => void;
}

export interface CloseInfo {
  code: number | null;
  reason: string;
  /** True when both sides completed the closing handshake. */
  clean: boolean;
}

export type WsMessage = { binary: false; text: string } | { binary: true; data: Uint8Array };

/**
 * A small RFC 6455 client over node:net / node:tls, built on the same codec as the server. Used by the CLI
 * (publish, inspect, chaos) and by the tests. Client frames are always masked.
 */
export class WsClient {
  private readonly decoder: FrameDecoder;
  private readonly queue: WsMessage[] = [];
  private readonly waiters: Array<{ resolve: (m: WsMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  private closeSent = false;
  private closeReceived: { code: number | null; reason: string } | null = null;
  private resolveClosed!: (info: CloseInfo) => void;
  /** Resolves when the connection ends, cleanly or not. */
  readonly closed: Promise<CloseInfo>;
  onMessage: ((m: WsMessage) => void) | undefined;
  onPing: ((payload: Uint8Array) => void) | undefined;
  onPong: ((payload: Uint8Array) => void) | undefined;
  /** The subprotocol the server picked, if any. */
  protocol: string | undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly options: WsClientOptions,
    maxPayload: number,
  ) {
    this.decoder = new FrameDecoder({ forbidMask: true, maxPayload, maxMessage: maxPayload * 4, emitFrames: !!options.onFrame, keepWire: !!options.onFrame });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  static connect(url: string, options: WsClientOptions = {}): Promise<WsClient> {
    const u = new URL(url);
    const secure = u.protocol === "wss:" || u.protocol === "https:";
    if (!secure && u.protocol !== "ws:" && u.protocol !== "http:") return Promise.reject(new Error(`unsupported URL scheme ${u.protocol}`));
    const port = Number(u.port || (secure ? 443 : 80));
    const key = createClientKey();
    return new Promise((resolve, reject) => {
      const socket: Socket = secure ? tlsConnect({ host: u.hostname, port, servername: u.hostname }) : netConnect({ host: u.hostname, port });
      const client = new WsClient(socket, options, options.maxPayload ?? 1024 * 1024);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("timed out opening the WebSocket"));
      }, options.connectTimeoutMs ?? 8000);
      let head = Buffer.alloc(0);
      let opened = false;
      const fail = (e: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(e);
      };
      socket.once("error", fail);
      socket.once(secure ? "secureConnect" : "connect", () => {
        socket.write(
          buildClientRequest({
            host: u.host,
            path: `${u.pathname}${u.search}` || "/",
            key,
            ...(options.protocols ? { protocols: options.protocols } : {}),
            ...(options.origin ? { origin: options.origin } : {}),
            ...(options.headers ? { headers: options.headers } : {}),
          }),
        );
      });
      socket.on("data", (chunk: Buffer) => {
        if (opened) return client.onData(chunk);
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const problem = validateServerHandshake(head.subarray(0, end).toString("latin1"), key);
        if (problem) return fail(new Error(problem));
        opened = true;
        clearTimeout(timer);
        socket.removeListener("error", fail);
        client.protocol = /^sec-websocket-protocol:\s*(.+)$/im.exec(head.subarray(0, end).toString("latin1"))?.[1]?.trim();
        socket.on("error", () => undefined);
        socket.on("close", () => client.onSocketClosed());
        resolve(client);
        const rest = head.subarray(end + 4);
        if (rest.length > 0) client.onData(rest);
      });
    });
  }

  private onData(chunk: Buffer): void {
    let items: DecodedItem[];
    try {
      items = this.decoder.push(chunk);
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : CloseCode.ProtocolError;
      this.sendClose(code, e instanceof Error ? e.message : "protocol error");
      return;
    }
    for (const item of items) {
      if (item.kind === "frame") this.options.onFrame?.("in", item.frame);
      else if (item.kind === "message") {
        const m: WsMessage = item.opcode === 1 ? { binary: false, text: item.text ?? "" } : { binary: true, data: item.data ?? new Uint8Array() };
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(m);
        } else this.queue.push(m);
        this.onMessage?.(m);
      } else if (item.kind === "ping") {
        this.onPing?.(item.payload);
        this.write(encodePong(item.payload, true));
      } else if (item.kind === "pong") this.onPong?.(item.payload);
      else if (item.kind === "close") {
        this.closeReceived = { code: item.code, reason: item.reason };
        if (!this.closeSent) this.sendClose(item.code ?? CloseCode.Normal, "");
        this.socket.end();
      }
    }
  }

  private onSocketClosed(): void {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("the connection closed"));
    }
    this.resolveClosed({
      code: this.closeReceived?.code ?? null,
      reason: this.closeReceived?.reason ?? "",
      clean: this.closeSent && this.closeReceived !== null,
    });
  }

  private write(frame: Uint8Array): void {
    if (this.socket.destroyed || !this.socket.writable) return;
    this.options.onFrame?.("out", { wire: frame });
    this.socket.write(frame);
  }

  sendText(text: string): void {
    this.write(encodeText(text, true));
  }

  sendBinary(data: Uint8Array): void {
    this.write(encodeBinary(data, true));
  }

  ping(payload?: Uint8Array | string): void {
    this.write(encodePing(payload, true));
  }

  /** Sends raw bytes as they are: lets tests send deliberately malformed frames. */
  sendRaw(bytes: Uint8Array): void {
    this.write(bytes);
  }

  private sendClose(code: number, reason: string): void {
    if (this.closeSent) return;
    this.closeSent = true;
    this.write(encodeClose(code, reason, true));
  }

  /** Starts the closing handshake. */
  close(code: number = CloseCode.Normal, reason = ""): void {
    this.sendClose(code, reason);
  }

  /** Drops the TCP connection without a Close frame: what a lost Wi-Fi connection looks like to the server. */
  destroy(): void {
    this.socket.destroy();
  }

  /** The next message, waiting up to `timeoutMs`. */
  next(timeoutMs = 3000): Promise<WsMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((w) => w.timer === timer);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error(`no message within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  /** The next text message parsed as JSON. */
  async nextJson<T = unknown>(timeoutMs?: number): Promise<T> {
    const m = await this.next(timeoutMs);
    if (m.binary) throw new Error("expected a text message");
    return JSON.parse(m.text) as T;
  }
}
