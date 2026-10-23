import type { GateCode, HypoutEvent, Json, ClientMessage, Member, PresenceOp, ServerMessage } from "../protocol/messages";
import {
  DEFAULT_MAX_PAYLOAD, gate101Topic, gate102Schema, gate103Rate, gate104Access, gate105Replay, gate106Size, type GateFailure, type Principal,
} from "./gates";
import { TokenBucket } from "./limits";
import { ALIVE, LamportClock, PresenceCRDT, diffMembers } from "./presence";
import { RingBuffer } from "./ring";
import type { ChannelRegistry, ResolvedChannel } from "./registry";

/** The broker never touches a socket: it talks to each client through this. */
export interface ClientHandle {
  id: string;
  send(message: ServerMessage): void;
}

export type TokenVerifier = (token: string, now: number) => { ok: true; principal: Principal } | { ok: false; reason: string };

export interface BrokerOptions {
  registry: ChannelRegistry;
  now?: () => number;
  /** Actor id stamped on presence operations (matters when several servers share presence later). */
  nodeId?: string;
  maxPayload?: number;
  /** Per-connection bucket across all messages. */
  connectionRate?: { capacity: number; refillPerSecond: number };
  maxSubscriptionsPerConnection?: number;
  /** Most channels held in memory at once (each keeps its retained events and presence). Default 10,000. */
  maxChannels?: number;
  verifyToken?: TokenVerifier;
  heartbeat?: { intervalMs: number; timeoutMs: number };
  /** Called after every event is stored (for the audit ledger). */
  onPublish?: (info: { channel: string; event: HypoutEvent }) => void;
  /** Deliver a publisher's own events back to it. Default true. */
  echo?: boolean;
}

interface Conn {
  handle: ClientHandle;
  principal: Principal | null;
  bucket: TokenBucket;
  nsBuckets: Map<string, TokenBucket>;
  subs: Set<string>;
  connectedAt: number;
}

interface Chan {
  name: string;
  ring: RingBuffer<HypoutEvent>;
  subs: Set<string>;
  presence: PresenceCRDT;
  clock: LamportClock;
  published: number;
  /** Last time anything touched the channel; idle channels with no subscribers are swept. */
  lastActive: number;
}

export interface BrokerStats {
  connections: number;
  subscriptions: number;
  channels: Array<{ name: string; subscribers: number; head: number; retained: number; members: number }>;
  counters: { published: number; delivered: number; replayed: number; rejected: Record<GateCode, number> };
}

const RESERVED_ALWAYS = new Set(["userId"]);
const MAX_PRESENCE_KEYS = 16;
const MAX_PRESENCE_BYTES = 2048;

/**
 * The pub/sub core: channels with ring-buffer replay, CRDT presence, and the HP-101 to HP-106 gates in front of
 * every operation. Transport-agnostic and synchronous, so it is exact to test and runs the same under any socket.
 */
export class Broker {
  readonly registry: ChannelRegistry;
  private readonly conns = new Map<string, Conn>();
  private readonly chans = new Map<string, Chan>();
  private readonly now: () => number;
  private readonly nodeId: string;
  private readonly maxPayload: number;
  private readonly counters: BrokerStats["counters"] = { published: 0, delivered: 0, replayed: 0, rejected: { "HP-101": 0, "HP-102": 0, "HP-103": 0, "HP-104": 0, "HP-105": 0, "HP-106": 0 } };

  constructor(private readonly opts: BrokerOptions) {
    this.registry = opts.registry;
    this.now = opts.now ?? Date.now;
    this.nodeId = opts.nodeId ?? "node";
    this.maxPayload = opts.maxPayload ?? DEFAULT_MAX_PAYLOAD;
  }

  /* ───────── connections ───────── */

  connect(handle: ClientHandle, principal: Principal | null = null): void {
    const rate = this.opts.connectionRate ?? { capacity: 200, refillPerSecond: 100 };
    this.conns.set(handle.id, { handle, principal, bucket: new TokenBucket(rate.capacity, rate.refillPerSecond, this.now()), nsBuckets: new Map(), subs: new Set(), connectedAt: this.now() });
    handle.send({
      t: "welcome",
      cid: handle.id,
      serverTime: this.now(),
      heartbeat: this.opts.heartbeat ?? { intervalMs: 30_000, timeoutMs: 10_000 },
      maxPayload: this.maxPayload,
      authenticated: principal !== null,
    });
  }

  disconnect(id: string): void {
    const conn = this.conns.get(id);
    if (!conn) return;
    for (const name of [...conn.subs]) this.leave(conn, name);
    this.conns.delete(id);
  }

  principalOf(id: string): Principal | null {
    return this.conns.get(id)?.principal ?? null;
  }

  has(id: string): boolean {
    return this.conns.has(id);
  }

  /* ───────── message handling ───────── */

  /** Processes one decoded client message. `bytes` is its size on the wire (for HP-106). */
  receive(id: string, msg: ClientMessage, bytes: number): void {
    const conn = this.conns.get(id);
    if (!conn) return;
    const now = this.now();
    if (msg.t === "ping") {
      conn.handle.send({ t: "pong", ts: msg.ts ?? null, serverTime: now });
      return;
    }
    const size = gate106Size(bytes, this.maxPayload);
    if (!size.ok) return this.reject(conn, size, msg);
    const rate = gate103Rate(conn.bucket, now);
    if (!rate.ok) return this.reject(conn, rate, msg);
    switch (msg.t) {
      case "auth":
        return this.onAuth(conn, msg.token, msg.mid);
      case "sub":
        return this.onSub(conn, msg.ch, msg.lastSeq, msg.mid);
      case "unsub":
        return this.onUnsub(conn, msg.ch, msg.mid);
      case "pub":
        return this.onPub(conn, msg.ch, msg.ev, msg.data, bytes, msg.mid);
      case "presence":
        return this.onPresence(conn, msg.ch, msg.op, msg.state, msg.mid);
    }
  }

  private reject(conn: Conn, f: GateFailure, msg?: { ch?: string; mid?: string }): void {
    this.counters.rejected[f.code]++;
    conn.handle.send({
      t: "error",
      code: f.code,
      reason: f.reason,
      message: f.message,
      ...(msg?.ch !== undefined ? { ch: msg.ch } : {}),
      ...(msg?.mid !== undefined ? { mid: msg.mid } : {}),
      ...(f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}),
    });
  }

  private onAuth(conn: Conn, token: string, mid?: string): void {
    const verify = this.opts.verifyToken;
    if (!verify) return this.reject(conn, { code: "HP-104", reason: "auth_disabled", message: "this server is not configured to accept tokens" }, { ...(mid ? { mid } : {}) });
    const r = verify(token, this.now());
    if (!r.ok) return this.reject(conn, { code: "HP-104", reason: `token_${r.reason}`, message: `the token was refused (${r.reason})` }, { ...(mid ? { mid } : {}) });
    conn.principal = r.principal;
    conn.handle.send({ t: "auth.ok", sub: r.principal.sub, admin: r.principal.admin === true, ...(mid ? { mid } : {}) });
  }

  /** The channel's runtime state, created on first use; its ring follows the definition's retention. */
  private chan(channel: ResolvedChannel): Chan {
    let c = this.chans.get(channel.name);
    const capacity = channel.definition.retention.events;
    if (!c) {
      c = { name: channel.name, ring: new RingBuffer<HypoutEvent>(capacity), subs: new Set(), presence: new PresenceCRDT(), clock: new LamportClock(), published: 0, lastActive: this.now() };
      this.chans.set(channel.name, c);
    } else {
      c.lastActive = this.now();
    }
    if (c.ring.capacity !== capacity) {
      // The definition's retention changed: keep as many of the newest events as fit, with their sequence numbers.
      c.ring = reseed(c.ring, capacity);
    }
    return c;
  }

  /** Refuses to create one more channel once the server holds `maxChannels`; existing channels are always reachable. */
  private channelLimit(name: string): GateFailure | null {
    const max = this.opts.maxChannels ?? 10_000;
    if (this.chans.has(name) || this.chans.size < max) return null;
    return { code: "HP-101", reason: "channel_limit", message: `the server already holds ${max} channels; use an existing one` };
  }

  /** Drops channels that have had no subscribers and no activity for `idleMs`, with their retained events. Returns how many. */
  sweep(idleMs: number, now = this.now()): number {
    let removed = 0;
    for (const [name, c] of this.chans) {
      if (c.subs.size === 0 && now - c.lastActive >= idleMs) {
        this.chans.delete(name);
        removed++;
      }
    }
    return removed;
  }

  private onSub(conn: Conn, name: string, lastSeq: number | undefined, mid?: string): void {
    const topic = gate101Topic(this.registry, name);
    if (!topic.ok) return this.reject(conn, topic, { ch: name, ...(mid ? { mid } : {}) });
    const channel = topic.value;
    const acl = gate104Access(channel, conn.principal, "sub");
    if (!acl.ok) return this.reject(conn, acl, { ch: name, ...(mid ? { mid } : {}) });
    const limit = this.opts.maxSubscriptionsPerConnection ?? 100;
    if (!conn.subs.has(name) && conn.subs.size >= limit) {
      return this.reject(conn, { code: "HP-104", reason: "too_many_subscriptions", message: `a connection may hold at most ${limit} subscriptions` }, { ch: name, ...(mid ? { mid } : {}) });
    }
    const full = this.channelLimit(name);
    if (full) return this.reject(conn, full, { ch: name, ...(mid ? { mid } : {}) });
    const chan = this.chan(channel);
    if (lastSeq !== undefined) {
      const cursor = gate105Replay(lastSeq, chan.ring.head);
      if (!cursor.ok) return this.reject(conn, cursor, { ch: name, ...(mid ? { mid } : {}) });
    }
    const already = conn.subs.has(name);
    conn.subs.add(name);
    chan.subs.add(conn.handle.id);
    const replay = lastSeq !== undefined ? chan.ring.since(lastSeq) : { events: [], gap: false };
    conn.handle.send({ t: "sub.ok", ch: name, seq: chan.ring.head, oldest: chan.ring.oldest, replayed: replay.events.length, gap: replay.gap, ...(mid ? { mid } : {}) });
    for (const e of replay.events) {
      conn.handle.send({ t: "event", ch: name, seq: e.seq, ts: e.ts, ev: e.ev, data: e.data, from: e.from, replay: true });
      this.counters.replayed++;
    }
    if (channel.definition.access.presence !== "off") this.joinPresence(conn, chan, channel, already);
  }

  private joinPresence(conn: Conn, chan: Chan, channel: ResolvedChannel, already: boolean): void {
    const mayJoin = gate104Access(channel, conn.principal, "presence").ok;
    if (mayJoin && !already) {
      if (chan.presence.size >= channel.definition.presence.maxMembers) {
        this.reject(conn, { code: "HP-104", reason: "presence_full", message: `presence on "${chan.name}" is full` }, { ch: chan.name });
      } else {
        const before = chan.presence.members();
        const p = conn.principal;
        const id = conn.handle.id;
        const ts = () => chan.clock.tick();
        const ops: PresenceOp[] = [
          { k: id, f: ALIVE, v: true, ts: ts(), a: this.nodeId },
          { k: id, f: "userId", v: p?.sub ?? `anon:${id}`, ts: ts(), a: this.nodeId },
          ...(p?.name ? [{ k: id, f: "username", v: p.name, ts: ts(), a: this.nodeId }] : []),
          ...(p?.avatar ? [{ k: id, f: "avatar", v: p.avatar, ts: ts(), a: this.nodeId }] : []),
        ];
        chan.presence.applyAll(ops);
        const d = diffMembers(before, chan.presence.members());
        for (const sid of chan.subs) if (sid !== id) this.deliver(sid, { t: "presence.diff", ch: chan.name, ops, joined: d.joined, left: d.left, updated: d.updated });
      }
    }
    conn.handle.send({ t: "presence.snapshot", ch: chan.name, members: chan.presence.members(), ops: chan.presence.liveOps() });
  }

  private onUnsub(conn: Conn, name: string, mid?: string): void {
    if (conn.subs.has(name)) this.leave(conn, name);
    conn.handle.send({ t: "unsub.ok", ch: name, ...(mid ? { mid } : {}) });
  }

  /** Removes a connection from a channel and, if it was present, tells everyone it left. */
  private leave(conn: Conn, name: string): void {
    conn.subs.delete(name);
    const chan = this.chans.get(name);
    if (!chan) return;
    chan.subs.delete(conn.handle.id);
    chan.lastActive = this.now();
    const id = conn.handle.id;
    if (chan.presence.has(id)) {
      const before = chan.presence.members();
      const op: PresenceOp = { k: id, f: ALIVE, v: false, ts: chan.clock.tick(), a: this.nodeId };
      chan.presence.apply(op);
      const d = diffMembers(before, chan.presence.members());
      for (const sid of chan.subs) this.deliver(sid, { t: "presence.diff", ch: name, ops: [op], joined: d.joined, left: d.left, updated: d.updated });
    }
  }

  private nsBucket(conn: Conn, channel: ResolvedChannel): TokenBucket {
    let b = conn.nsBuckets.get(channel.namespace);
    if (!b) {
      const r = channel.definition.rateLimit;
      b = new TokenBucket(r.capacity, r.refillPerSecond, this.now());
      conn.nsBuckets.set(channel.namespace, b);
    }
    return b;
  }

  private onPub(conn: Conn, name: string, ev: string, data: unknown, bytes: number, mid?: string): void {
    const ctx = { ch: name, ...(mid ? { mid } : {}) };
    const topic = gate101Topic(this.registry, name);
    if (!topic.ok) return this.reject(conn, topic, ctx);
    const channel = topic.value;
    const acl = gate104Access(channel, conn.principal, "pub");
    if (!acl.ok) return this.reject(conn, acl, ctx);
    if (!conn.principal?.admin) {
      const rate = gate103Rate(this.nsBucket(conn, channel), this.now());
      if (!rate.ok) return this.reject(conn, rate, ctx);
    }
    const limit = Math.min(channel.definition.maxPayloadBytes ?? this.maxPayload, this.maxPayload);
    const size = gate106Size(bytes, limit);
    if (!size.ok) return this.reject(conn, size, ctx);
    const schema = gate102Schema(channel, ev, data);
    if (!schema.ok) return this.reject(conn, schema, ctx);
    const full = this.channelLimit(name);
    if (full) return this.reject(conn, full, ctx);
    const event = this.append(channel, ev, data as Json, conn.handle.id);
    conn.handle.send({ t: "ack", ch: name, seq: event.seq, ...(mid ? { mid } : {}) });
  }

  /** Publishes on behalf of the server itself (the REST API). Still checked for name, schema and size; no ACL or rate limit. */
  publish(name: string, ev: string, data: unknown): { ok: true; seq: number; event: HypoutEvent } | ({ ok: false } & GateFailure) {
    const topic = gate101Topic(this.registry, name);
    if (!topic.ok) return topic;
    const channel = topic.value;
    const size = gate106Size(Buffer.byteLength(JSON.stringify(data ?? null)), Math.min(channel.definition.maxPayloadBytes ?? this.maxPayload, this.maxPayload));
    if (!size.ok) return size;
    const schema = gate102Schema(channel, ev, data);
    if (!schema.ok) return schema;
    const full = this.channelLimit(name);
    if (full) return { ok: false, ...full };
    const event = this.append(channel, ev, data as Json, "server");
    return { ok: true, seq: event.seq, event };
  }

  private append(channel: ResolvedChannel, ev: string, data: Json, from: string): HypoutEvent {
    const chan = this.chan(channel);
    const event: HypoutEvent = { seq: chan.ring.head + 1, ts: this.now(), ev, data, from };
    chan.ring.push(event);
    chan.published++;
    this.counters.published++;
    this.opts.onPublish?.({ channel: channel.name, event });
    const msg: ServerMessage = { t: "event", ch: channel.name, seq: event.seq, ts: event.ts, ev, data, from };
    const echo = this.opts.echo !== false;
    for (const sid of chan.subs) {
      if (!echo && sid === from) continue;
      this.deliver(sid, msg);
    }
    return event;
  }

  private onPresence(conn: Conn, name: string, op: "set" | "get", state: Record<string, unknown> | undefined, mid?: string): void {
    const ctx = { ch: name, ...(mid ? { mid } : {}) };
    const topic = gate101Topic(this.registry, name);
    if (!topic.ok) return this.reject(conn, topic, ctx);
    const channel = topic.value;
    const chan = this.chans.get(name);
    if (!chan || !conn.subs.has(name)) return this.reject(conn, { code: "HP-104", reason: "not_subscribed", message: `subscribe to "${name}" before using presence on it` }, ctx);
    if (channel.definition.access.presence === "off") return this.reject(conn, { code: "HP-104", reason: "presence_off", message: `presence is not enabled on "${channel.namespace}"` }, ctx);
    if (op === "get") {
      conn.handle.send({ t: "presence.snapshot", ch: name, members: chan.presence.members(), ops: chan.presence.liveOps() });
      return;
    }
    const acl = gate104Access(channel, conn.principal, "presence");
    if (!acl.ok) return this.reject(conn, acl, ctx);
    if (!conn.principal?.admin) {
      const rate = gate103Rate(this.nsBucket(conn, channel), this.now());
      if (!rate.ok) return this.reject(conn, rate, ctx);
    }
    const id = conn.handle.id;
    if (!chan.presence.has(id)) return this.reject(conn, { code: "HP-104", reason: "not_present", message: "you have not joined presence on this channel" }, ctx);
    const entries = Object.entries(state ?? {});
    const reserved = new Set(RESERVED_ALWAYS);
    if (conn.principal?.name) reserved.add("username");
    if (conn.principal?.avatar) reserved.add("avatar");
    if (entries.length === 0 || entries.length > MAX_PRESENCE_KEYS) return this.reject(conn, { code: "HP-102", reason: "presence_state", message: `presence state needs 1 to ${MAX_PRESENCE_KEYS} fields` }, ctx);
    for (const [k] of entries) {
      if (k.startsWith("$") || reserved.has(k) || k.length > 40) return this.reject(conn, { code: "HP-102", reason: "reserved_field", message: `"${k}" cannot be set by a client` }, ctx);
    }
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_PRESENCE_BYTES) return this.reject(conn, { code: "HP-106", reason: "too_large", message: `presence state is limited to ${MAX_PRESENCE_BYTES} bytes` }, ctx);
    const before = chan.presence.members();
    const ops: PresenceOp[] = entries.map(([f, v]) => ({ k: id, f, v: v as Json, ts: chan.clock.tick(), a: this.nodeId }));
    chan.presence.applyAll(ops);
    const d = diffMembers(before, chan.presence.members());
    for (const sid of chan.subs) this.deliver(sid, { t: "presence.diff", ch: name, ops, joined: d.joined, left: d.left, updated: d.updated });
  }

  private deliver(id: string, msg: ServerMessage): void {
    const c = this.conns.get(id);
    if (!c) return;
    c.handle.send(msg);
    this.counters.delivered++;
  }

  /* ───────── inspection ───────── */

  members(name: string): Member[] {
    return this.chans.get(name)?.presence.members() ?? [];
  }

  head(name: string): number {
    return this.chans.get(name)?.ring.head ?? 0;
  }

  /** Events retained for a channel (newest last), for the Studio's event log. */
  recent(name: string, limit = 100): HypoutEvent[] {
    const chan = this.chans.get(name);
    if (!chan || chan.ring.head === 0) return [];
    return chan.ring.since(Math.max(0, chan.ring.head - limit)).events;
  }

  stats(): BrokerStats {
    let subscriptions = 0;
    for (const c of this.conns.values()) subscriptions += c.subs.size;
    return {
      connections: this.conns.size,
      subscriptions,
      channels: [...this.chans.values()].map((c) => ({ name: c.name, subscribers: c.subs.size, head: c.ring.head, retained: c.ring.size, members: c.presence.size })).sort((a, b) => (a.name < b.name ? -1 : 1)),
      counters: { ...this.counters, rejected: { ...this.counters.rejected } },
    };
  }
}

/** Builds a ring of a new capacity that keeps the sequence going from where the old one was. */
function reseed(old: RingBuffer<HypoutEvent>, capacity: number): RingBuffer<HypoutEvent> {
  const next = new RingBuffer<HypoutEvent>(capacity);
  const kept = old.oldest === null ? [] : old.since(old.oldest - 1).events.slice(-capacity);
  if (kept.length === 0) return next;
  // RingBuffer requires consecutive sequences starting at 1, so a resized ring is started at the oldest kept sequence.
  return RingBuffer.startingAt(capacity, kept);
}
