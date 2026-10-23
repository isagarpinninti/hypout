import { PresenceCRDT, type HypoutEvent, type Json, type Member, type ServerMessage } from "@hypout/core/protocol";

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** The subset of the browser `WebSocket` the client uses, so tests (and Node) can bring their own. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

export interface ReconnectOptions {
  minMs: number;
  maxMs: number;
  factor: number;
}

export interface HypoutClientOptions {
  /** `ws://host:4320/ws` (or `wss://`). */
  url: string;
  /** A token string, or a function returning one (called on every connect, so it can refresh). */
  token?: string | (() => string | Promise<string>);
  socket?: SocketFactory;
  /** Backoff between reconnect attempts. `false` turns reconnecting off. */
  reconnect?: Partial<ReconnectOptions> | false;
  /** Start connecting immediately. Default true. */
  autoConnect?: boolean;
  /** How long `publish` waits for an ack. Default 10 seconds. */
  ackTimeoutMs?: number;
  /** Injected for tests. */
  random?: () => number;
}

export interface ChannelListener {
  onEvent?(event: HypoutEvent & { channel: string; replay: boolean }): void;
  onPresence?(members: Member[]): void;
  /** The server accepted the subscription. `gap` is true when events were lost before the oldest retained one. */
  onSubscribed?(info: { seq: number; replayed: number; gap: boolean }): void;
  onError?(error: HypoutError): void;
}

export class HypoutError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
    message: string,
    readonly channel?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HypoutError";
  }
}

interface ChannelState {
  name: string;
  listeners: Set<ChannelListener>;
  lastSeq: number;
  /** True once the server has told us where the channel's sequence stands, so a hole is detectable even from 0. */
  synced: boolean;
  subscribed: boolean;
  recovering: boolean;
  presence: PresenceCRDT;
  /** The state this client last set, re-sent after a reconnect (the server forgets it on disconnect). */
  ownState: Record<string, Json> | null;
}

interface Pending {
  resolve(v: { seq: number }): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

/**
 * A WebSocket client for a Hypout server. It reconnects with backoff and resumes each channel from the last
 * sequence it saw, so the server replays exactly what was missed; when it notices a hole in the sequence
 * (a dropped frame) it asks for the missing events the same way. Presence is merged locally as CRDT ops.
 */
export class HypoutClient {
  private ws: SocketLike | null = null;
  private state: ConnectionStatus = "idle";
  private readonly channels = new Map<string, ChannelState>();
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private readonly pending = new Map<string, Pending>();
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  private seq = 0;
  private cidValue: string | null = null;
  private readonly reconnectOpts: ReconnectOptions | false;
  private readonly makeSocket: SocketFactory;
  private readonly rand: () => number;

  constructor(private readonly options: HypoutClientOptions) {
    this.reconnectOpts = options.reconnect === false ? false : { minMs: 500, maxMs: 15_000, factor: 2, ...options.reconnect };
    this.rand = options.random ?? Math.random;
    this.makeSocket =
      options.socket ??
      ((url, protocols) => {
        const Ctor = (globalThis as { WebSocket?: new (url: string, protocols?: string[]) => unknown }).WebSocket;
        if (!Ctor) throw new Error("no global WebSocket; pass options.socket");
        return new Ctor(url, protocols) as SocketLike;
      });
    if (options.autoConnect !== false) this.connect();
  }

  get status(): ConnectionStatus {
    return this.state;
  }

  /** The connection id the server assigned (the presence key of this client), once connected. */
  get connectionId(): string | null {
    return this.cidValue;
  }

  onStatus(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.state === s) return;
    this.state = s;
    for (const l of [...this.statusListeners]) l(s);
  }

  connect(): void {
    this.wanted = true;
    if (this.ws || this.state === "connecting") return;
    void this.open();
  }

  close(): void {
    this.wanted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "client closed");
    } catch {
      /* already closed */
    }
    this.failPending(new Error("client closed"));
    this.markUnsubscribed();
    this.setStatus("closed");
  }

  private async open(): Promise<void> {
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    let url = this.options.url;
    try {
      const t = typeof this.options.token === "function" ? await this.options.token() : this.options.token;
      if (t) url += `${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}`;
      if (!this.wanted) return;
      const ws = this.makeSocket(url, ["hypout.v1"]);
      this.ws = ws;
      ws.onmessage = (ev) => {
        if (this.ws === ws) this.handleRaw(ev.data);
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.onDisconnected();
      };
      ws.onerror = () => undefined;
    } catch {
      this.ws = null;
      this.onDisconnected();
    }
  }

  private onDisconnected(): void {
    this.failPending(new Error("connection lost"));
    this.markUnsubscribed();
    if (!this.wanted || this.reconnectOpts === false) {
      this.setStatus("closed");
      return;
    }
    const { minMs, maxMs, factor } = this.reconnectOpts;
    const ceiling = Math.min(maxMs, minMs * factor ** this.attempts);
    const delay = Math.floor(ceiling / 2 + (this.rand() * ceiling) / 2);
    this.attempts++;
    this.setStatus("reconnecting");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) void this.open();
    }, delay);
  }

  private markUnsubscribed(): void {
    for (const c of this.channels.values()) {
      c.subscribed = false;
      c.recovering = false;
    }
  }

  private failPending(e: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  private sendJson(msg: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /* ───────── subscriptions ───────── */

  subscribe(channel: string, listener: ChannelListener = {}): () => void {
    let c = this.channels.get(channel);
    if (!c) {
      c = { name: channel, listeners: new Set(), lastSeq: 0, synced: false, subscribed: false, recovering: false, presence: new PresenceCRDT(), ownState: null };
      this.channels.set(channel, c);
    }
    c.listeners.add(listener);
    if (this.state === "open" && !c.subscribed) this.sendSub(c);
    else if (c.subscribed) this.sendJson({ t: "presence", ch: channel, op: "get" });
    return () => {
      const cur = this.channels.get(channel);
      if (!cur) return;
      cur.listeners.delete(listener);
      if (cur.listeners.size === 0) {
        this.channels.delete(channel);
        this.sendJson({ t: "unsub", ch: channel });
      }
    };
  }

  private sendSub(c: ChannelState): void {
    this.sendJson({ t: "sub", ch: c.name, ...(c.synced ? { lastSeq: c.lastSeq } : {}) });
  }

  /** The members currently present on a channel this client is subscribed to. */
  members(channel: string): Member[] {
    return this.channels.get(channel)?.presence.members() ?? [];
  }

  /** Sets this client's presence state on a channel (and re-sends it after a reconnect). */
  setPresence(channel: string, state: Record<string, Json>): void {
    const c = this.channels.get(channel);
    if (c) c.ownState = state;
    this.sendJson({ t: "presence", ch: channel, op: "set", state });
  }

  publish(channel: string, event: string, data: Json): Promise<{ seq: number }> {
    return new Promise((resolve, reject) => {
      const mid = `m${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(mid);
        reject(new Error("publish timed out waiting for an ack"));
      }, this.options.ackTimeoutMs ?? 10_000);
      this.pending.set(mid, { resolve, reject, timer });
      if (!this.sendJson({ t: "pub", ch: channel, ev: event, data, mid })) {
        clearTimeout(timer);
        this.pending.delete(mid);
        reject(new Error("not connected"));
      }
    });
  }

  /* ───────── incoming ───────── */

  private handleRaw(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    this.handle(msg);
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.cidValue = msg.cid;
        this.attempts = 0;
        this.setStatus("open");
        for (const c of this.channels.values()) this.sendSub(c);
        break;
      case "sub.ok": {
        const c = this.channels.get(msg.ch);
        if (!c) break;
        c.subscribed = true;
        c.recovering = false;
        if (!c.synced) c.lastSeq = Math.max(c.lastSeq, msg.seq);
        c.synced = true;
        for (const l of c.listeners) l.onSubscribed?.({ seq: msg.seq, replayed: msg.replayed, gap: msg.gap });
        if (c.ownState) this.sendJson({ t: "presence", ch: c.name, op: "set", state: c.ownState });
        break;
      }
      case "event": {
        const c = this.channels.get(msg.ch);
        if (!c) break;
        if (msg.seq <= c.lastSeq) break;
        const hole = c.synced && msg.seq > c.lastSeq + 1;
        if (hole && !msg.replay && !c.recovering) {
          // A frame was lost on the way: ask the server to resend everything after what we have.
          c.recovering = true;
          this.sendSub(c);
          break;
        }
        if (hole && c.recovering) break;
        c.lastSeq = msg.seq;
        const ev = { seq: msg.seq, ts: msg.ts, ev: msg.ev, data: msg.data, from: msg.from, channel: msg.ch, replay: msg.replay === true };
        for (const l of c.listeners) l.onEvent?.(ev);
        break;
      }
      case "presence.snapshot": {
        const c = this.channels.get(msg.ch);
        if (!c) break;
        c.presence = new PresenceCRDT();
        c.presence.applyAll(msg.ops);
        this.notifyPresence(c);
        break;
      }
      case "presence.diff": {
        const c = this.channels.get(msg.ch);
        if (!c) break;
        c.presence.applyAll(msg.ops);
        this.notifyPresence(c);
        break;
      }
      case "ack": {
        if (!msg.mid) break;
        const p = this.pending.get(msg.mid);
        if (!p) break;
        clearTimeout(p.timer);
        this.pending.delete(msg.mid);
        p.resolve({ seq: msg.seq });
        break;
      }
      case "error": {
        const err = new HypoutError(msg.code, msg.reason, msg.message, msg.ch, msg.retryAfterMs);
        if (msg.mid) {
          const p = this.pending.get(msg.mid);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.mid);
            p.reject(err);
            break;
          }
        }
        if (msg.ch) for (const l of this.channels.get(msg.ch)?.listeners ?? []) l.onError?.(err);
        break;
      }
      default:
        break;
    }
  }

  private notifyPresence(c: ChannelState): void {
    const members = c.presence.members();
    for (const l of c.listeners) l.onPresence?.(members);
  }
}
