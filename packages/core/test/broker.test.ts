import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Broker, ChannelRegistry, PresenceCRDT, mintToken, verifyToken, parseCapabilities, type ClientHandle, type ClientMessage, type Principal, type ServerMessage,
} from "../src";

const SECRET = "test-secret";

class FakeClient implements ClientHandle {
  inbox: ServerMessage[] = [];
  constructor(readonly id: string) {}
  send(m: ServerMessage): void {
    this.inbox.push(m);
  }
  of<T extends ServerMessage["t"]>(t: T): Array<Extract<ServerMessage, { t: T }>> {
    return this.inbox.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  last<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.of(t).at(-1);
  }
  clear(): void {
    this.inbox = [];
  }
}

const defs = [
  { namespace: "chat", access: { subscribe: "public", publish: "public", presence: "public" }, events: { message: { type: "object", properties: { text: { type: "string", maxLength: 50 } }, required: ["text"] } }, retention: { events: 5 }, rateLimit: { capacity: 1000, refillPerSecond: 1000 } },
  { namespace: "slow", access: { subscribe: "public", publish: "public", presence: "off" }, rateLimit: { capacity: 3, refillPerSecond: 1 } },
  { namespace: "alerts", access: { subscribe: "token", publish: "server", presence: "off" } },
  { namespace: "doc", access: { subscribe: "token", publish: "token", presence: "token" }, maxPayloadBytes: 200 },
  { namespace: "open", access: { subscribe: "public", publish: "public", presence: "off" }, rateLimit: { capacity: 1000, refillPerSecond: 1000 } },
] as const;

function setup(opts: { now?: () => number; echo?: boolean; maxChannels?: number } = {}) {
  let t = 1_000_000;
  const now = opts.now ?? (() => t);
  const registry = new ChannelRegistry(defs as never);
  const broker = new Broker({
    registry,
    now,
    nodeId: "n1",
    ...(opts.echo !== undefined ? { echo: opts.echo } : {}),
    ...(opts.maxChannels !== undefined ? { maxChannels: opts.maxChannels } : {}),
    verifyToken: (token, at) => {
      const r = verifyToken(SECRET, token, at);
      return r.ok ? { ok: true, principal: r.claims } : { ok: false, reason: r.reason };
    },
  });
  const client = (id: string, principal: Principal | null = null): FakeClient => {
    const c = new FakeClient(id);
    broker.connect(c, principal);
    return c;
  };
  const send = (c: FakeClient, m: ClientMessage, bytes = 50): void => broker.receive(c.id, m, bytes);
  return { broker, client, send, advance: (ms: number) => void (t += ms), registry };
}
const user = (sub: string, caps: string, extra: Partial<Principal> = {}): Principal => ({ sub, caps: parseCapabilities(caps), ...extra });

describe("connecting", () => {
  it("greets a client with its id, the heartbeat policy and the payload ceiling", () => {
    const { client } = setup();
    const a = client("a");
    expect(a.inbox[0]).toMatchObject({ t: "welcome", cid: "a", heartbeat: { intervalMs: 30000, timeoutMs: 10000 }, maxPayload: 65536, authenticated: false });
  });
});

describe("publish and subscribe", () => {
  it("fans events out in sequence, acks the publisher, and echoes by default", () => {
    const { client, send } = setup();
    const a = client("a");
    const b = client("b");
    send(a, { t: "sub", ch: "chat:room" });
    send(b, { t: "sub", ch: "chat:room" });
    send(a, { t: "pub", ch: "chat:room", ev: "message", data: { text: "hi" }, mid: "m1" });
    send(a, { t: "pub", ch: "chat:room", ev: "message", data: { text: "again" }, mid: "m2" });
    expect(a.of("ack").map((x) => [x.seq, x.mid])).toEqual([[1, "m1"], [2, "m2"]]);
    expect(b.of("event").map((e) => [e.seq, e.ev, e.data, e.from])).toEqual([[1, "message", { text: "hi" }, "a"], [2, "message", { text: "again" }, "a"]]);
    expect(a.of("event")).toHaveLength(2);
  });
  it("can skip the publisher's own copy", () => {
    const { client, send } = setup({ echo: false });
    const a = client("a");
    const b = client("b");
    send(a, { t: "sub", ch: "chat:x" });
    send(b, { t: "sub", ch: "chat:x" });
    send(a, { t: "pub", ch: "chat:x", ev: "message", data: { text: "x" } });
    expect(a.of("event")).toHaveLength(0);
    expect(b.of("event")).toHaveLength(1);
  });
  it("keeps channels independent and stops delivering after unsubscribe", () => {
    const { client, send } = setup();
    const a = client("a");
    send(a, { t: "sub", ch: "open:one" });
    send(a, { t: "pub", ch: "open:two", ev: "x", data: 1 });
    expect(a.of("event")).toHaveLength(0);
    send(a, { t: "unsub", ch: "open:one" });
    expect(a.last("unsub.ok")).toMatchObject({ ch: "open:one" });
    send(a, { t: "pub", ch: "open:one", ev: "x", data: 1 });
    expect(a.of("event")).toHaveLength(0);
  });
  it("lets the server publish (REST) without a socket", () => {
    const { client, send, broker } = setup();
    const a = client("a");
    send(a, { t: "sub", ch: "chat:r" });
    const r = broker.publish("chat:r", "message", { text: "from server" });
    expect(r).toMatchObject({ ok: true, seq: 1 });
    expect(a.last("event")).toMatchObject({ from: "server", data: { text: "from server" } });
    expect(broker.publish("nope", "x", {})).toMatchObject({ ok: false, code: "HP-101" });
    expect(broker.publish("chat:r", "message", { text: 5 })).toMatchObject({ ok: false, code: "HP-102" });
  });
});

describe("replay with Last-Event-ID semantics (ring buffer)", () => {
  it("replays exactly the events after the cursor, flagged as replay, before live ones", () => {
    const { client, send } = setup();
    const a = client("a");
    send(a, { t: "sub", ch: "open:r" });
    for (let i = 1; i <= 5; i++) send(a, { t: "pub", ch: "open:r", ev: "n", data: i });
    const b = client("b");
    send(b, { t: "sub", ch: "open:r", lastSeq: 2 });
    expect(b.last("sub.ok")).toMatchObject({ seq: 5, replayed: 3, gap: false });
    expect(b.of("event").map((e) => [e.seq, e.data, e.replay])).toEqual([[3, 3, true], [4, 4, true], [5, 5, true]]);
    send(a, { t: "pub", ch: "open:r", ev: "n", data: 6 });
    expect(b.of("event").at(-1)).toMatchObject({ seq: 6, data: 6 });
    expect(b.of("event").at(-1)?.replay).toBeUndefined();
  });
  it("replays nothing when the cursor is at the head", () => {
    const { client, send } = setup();
    const a = client("a");
    send(a, { t: "pub", ch: "open:r", ev: "n", data: 1 });
    send(a, { t: "sub", ch: "open:r", lastSeq: 1 });
    expect(a.last("sub.ok")).toMatchObject({ replayed: 0, gap: false });
  });
  it("gap detection on a small ring (server publishes)", () => {
    const { client, send, broker } = setup();
    for (let i = 1; i <= 9; i++) broker.publish("chat:g", "message", { text: String(i) });
    const a = client("a");
    send(a, { t: "sub", ch: "chat:g", lastSeq: 2 });
    expect(a.last("sub.ok")).toMatchObject({ seq: 9, oldest: 5, replayed: 5, gap: true });
    expect(a.of("event").map((e) => e.seq)).toEqual([5, 6, 7, 8, 9]);
  });
  it("HP-105 rejects a cursor that is negative, fractional or ahead of the channel", () => {
    const { client, send } = setup();
    const a = client("a");
    send(a, { t: "pub", ch: "open:r", ev: "n", data: 1 });
    for (const lastSeq of [-1, 1.5, 99]) {
      a.clear();
      send(a, { t: "sub", ch: "open:r", lastSeq });
      expect(a.last("error"), String(lastSeq)).toMatchObject({ code: "HP-105" });
      expect(a.of("sub.ok")).toHaveLength(0);
    }
  });
  it("the chaos scenario: drop, miss three events, reconnect with lastSeq, lose nothing", () => {
    const { client, send, broker } = setup();
    const a = client("a");
    const pub = client("p");
    send(a, { t: "sub", ch: "open:chaos" });
    send(pub, { t: "pub", ch: "open:chaos", ev: "n", data: 1 });
    const seen = a.of("event").map((e) => e.seq);
    expect(seen).toEqual([1]);
    broker.disconnect("a"); // the wifi drops
    for (const n of [2, 3, 4]) send(pub, { t: "pub", ch: "open:chaos", ev: "n", data: n });
    const back = client("a2"); // a new connection (new id), same user
    send(back, { t: "sub", ch: "open:chaos", lastSeq: seen.at(-1) ?? 0 });
    const got = [...seen, ...back.of("event").map((e) => e.seq)];
    expect(got).toEqual([1, 2, 3, 4]);
    expect(back.last("sub.ok")).toMatchObject({ replayed: 3, gap: false });
  });
});

describe("the six gates", () => {
  it("HP-101 refuses malformed names and unknown namespaces", () => {
    const { client, send } = setup();
    const a = client("a");
    for (const ch of ["Chat", "chat room", "chat:", ":x", "nope", "nope:1", "a".repeat(200)]) {
      a.clear();
      send(a, { t: "sub", ch });
      expect(a.last("error"), ch).toMatchObject({ code: "HP-101" });
    }
    expect(a.last("error")?.message).toBeTruthy();
  });
  it("HP-102 enforces event names and payload schemas", () => {
    const { client, send } = setup();
    const a = client("a");
    send(a, { t: "pub", ch: "chat:r", ev: "typo", data: { text: "x" } });
    expect(a.last("error")).toMatchObject({ code: "HP-102", reason: "unknown_event" });
    send(a, { t: "pub", ch: "chat:r", ev: "message", data: { text: 5 } });
    expect(a.last("error")).toMatchObject({ code: "HP-102", reason: "schema" });
    send(a, { t: "pub", ch: "chat:r", ev: "message", data: { text: "x".repeat(51) } });
    expect(a.last("error")).toMatchObject({ code: "HP-102" });
    send(a, { t: "pub", ch: "chat:r", ev: "message", data: { text: "ok", extra: 1 } });
    expect(a.last("error")).toMatchObject({ code: "HP-102" });
    expect(a.of("ack")).toHaveLength(0);
  });
  it("HP-103 rate limits a connection and tells it when to retry; tokens come back with time", () => {
    const { client, send, advance } = setup();
    const a = client("a");
    for (let i = 0; i < 3; i++) send(a, { t: "pub", ch: "slow:r", ev: "e", data: i });
    expect(a.of("ack")).toHaveLength(3);
    send(a, { t: "pub", ch: "slow:r", ev: "e", data: 4 });
    expect(a.last("error")).toMatchObject({ code: "HP-103", retryAfterMs: expect.any(Number) });
    advance(1000);
    send(a, { t: "pub", ch: "slow:r", ev: "e", data: 5 });
    expect(a.of("ack")).toHaveLength(4);
  });
  it("HP-103 limits each connection separately", () => {
    const { client, send } = setup();
    const a = client("a");
    const b = client("b");
    for (let i = 0; i < 5; i++) send(a, { t: "pub", ch: "slow:r", ev: "e", data: i });
    expect(a.of("ack")).toHaveLength(3);
    send(b, { t: "pub", ch: "slow:r", ev: "e", data: 1 });
    expect(b.of("ack")).toHaveLength(1);
  });
  it("HP-104 needs a token where the channel says so, and checks its capabilities", () => {
    const { client, send } = setup();
    const anon = client("anon");
    send(anon, { t: "sub", ch: "alerts" });
    expect(anon.last("error")).toMatchObject({ code: "HP-104", reason: "token_required" });
    const viewer = client("v", user("u1", "alerts=sub"));
    send(viewer, { t: "sub", ch: "alerts" });
    expect(viewer.last("sub.ok")).toBeTruthy();
    send(viewer, { t: "pub", ch: "alerts", ev: "x", data: 1 });
    expect(viewer.last("error")).toMatchObject({ code: "HP-104", reason: "server_only" });
    const wrong = client("w", user("u2", "doc:*=sub"));
    send(wrong, { t: "sub", ch: "alerts" });
    expect(wrong.last("error")).toMatchObject({ code: "HP-104", reason: "forbidden" });
    send(wrong, { t: "sub", ch: "doc:7" });
    expect(wrong.last("sub.ok")).toMatchObject({ ch: "doc:7" });
    send(wrong, { t: "pub", ch: "doc:7", ev: "x", data: 1 });
    expect(wrong.last("error")).toMatchObject({ code: "HP-104", reason: "forbidden" });
  });
  it("HP-104 accepts a signed token sent after connecting, refuses a forged or expired one", () => {
    const { client, send } = setup();
    const a = client("a");
    send(a, { t: "auth", token: mintToken(SECRET, { sub: "ada", name: "Ada", caps: parseCapabilities("doc:*=sub,pub,presence") }, 1_000_000), mid: "t1" });
    expect(a.last("auth.ok")).toMatchObject({ sub: "ada", admin: false, mid: "t1" });
    send(a, { t: "sub", ch: "doc:1" });
    expect(a.last("sub.ok")).toBeTruthy();
    const b = client("b");
    send(b, { t: "auth", token: mintToken("other-secret", { sub: "x", caps: [] }, 1_000_000) });
    expect(b.last("error")).toMatchObject({ code: "HP-104", reason: "token_bad_signature" });
    send(b, { t: "auth", token: mintToken(SECRET, { sub: "x", caps: [], ttlSeconds: 1 }, 0) });
    expect(b.last("error")).toMatchObject({ code: "HP-104", reason: "token_expired" });
    send(b, { t: "auth", token: "garbage" });
    expect(b.last("error")).toMatchObject({ code: "HP-104", reason: "token_malformed" });
  });
  it("an admin bypasses ACLs and rate limits", () => {
    const { client, send } = setup();
    const admin = client("adm", { sub: "studio", caps: [], admin: true });
    send(admin, { t: "sub", ch: "alerts" });
    expect(admin.last("sub.ok")).toBeTruthy();
    for (let i = 0; i < 50; i++) send(admin, { t: "pub", ch: "slow:r", ev: "e", data: i });
    expect(admin.of("ack")).toHaveLength(50);
  });
  it("HP-106 refuses an oversized message, and a channel can set a lower ceiling", () => {
    const { client, send } = setup();
    const a = client("a");
    send(a, { t: "pub", ch: "open:x", ev: "e", data: 1 }, 70_000);
    expect(a.last("error")).toMatchObject({ code: "HP-106" });
    const d = client("d", user("u", "doc:*=sub,pub"));
    send(d, { t: "pub", ch: "doc:1", ev: "e", data: "x" }, 500);
    expect(d.last("error")).toMatchObject({ code: "HP-106" });
    send(d, { t: "pub", ch: "doc:1", ev: "e", data: "x" }, 150);
    expect(d.last("ack")).toBeTruthy();
  });
  it("counts what each gate rejected", () => {
    const { client, send, broker } = setup();
    const a = client("a");
    send(a, { t: "sub", ch: "BAD" });
    send(a, { t: "sub", ch: "alerts" });
    send(a, { t: "sub", ch: "open:r", lastSeq: 9 });
    const r = broker.stats().counters.rejected;
    expect([r["HP-101"], r["HP-104"], r["HP-105"]]).toEqual([1, 1, 1]);
  });
});

describe("presence", () => {
  const ada = (): Principal => user("ada", "chat:*=sub,pub,presence", { name: "Ada", avatar: "https://x/ada.png" });
  const lin = (): Principal => user("lin", "chat:*=sub,pub,presence", { name: "Lin" });

  it("gives a joiner a snapshot and tells everyone else, with CRDT operations", () => {
    const { client, send } = setup();
    const a = client("a", ada());
    send(a, { t: "sub", ch: "chat:r" });
    expect(a.last("presence.snapshot")?.members.map((m) => m.state.username)).toEqual(["Ada"]);
    const l = client("l", lin());
    send(l, { t: "sub", ch: "chat:r" });
    expect(l.last("presence.snapshot")?.members.map((m) => m.state.username)).toEqual(["Ada", "Lin"]);
    const diff = a.last("presence.diff");
    expect(diff?.joined.map((m) => m.key)).toEqual(["l"]);
    expect(diff?.ops.length).toBeGreaterThan(1);
    expect(l.of("presence.diff")).toHaveLength(0); // the joiner learns about itself from the snapshot, not a diff
  });
  it("updates state (cursor, status) and broadcasts only what changed", () => {
    const { client, send } = setup();
    const a = client("a", ada());
    const l = client("l", lin());
    send(a, { t: "sub", ch: "chat:r" });
    send(l, { t: "sub", ch: "chat:r" });
    send(a, { t: "presence", ch: "chat:r", op: "set", state: { cursor: { x: 4, y: 7 }, status: "typing" } });
    const d = l.last("presence.diff");
    expect(d?.updated).toHaveLength(1);
    expect(d?.updated[0]).toMatchObject({ key: "a", state: { cursor: { x: 4, y: 7 }, status: "typing", username: "Ada" } });
    expect(d?.joined).toEqual([]);
  });
  it("removes a member when it unsubscribes or its connection drops", () => {
    const { client, send, broker } = setup();
    const a = client("a", ada());
    const l = client("l", lin());
    send(a, { t: "sub", ch: "chat:r" });
    send(l, { t: "sub", ch: "chat:r" });
    send(l, { t: "unsub", ch: "chat:r" });
    expect(a.last("presence.diff")?.left).toEqual(["l"]);
    expect(broker.members("chat:r").map((m) => m.key)).toEqual(["a"]);
    broker.disconnect("a");
    expect(broker.members("chat:r")).toEqual([]);
  });
  it("lets a client reset its roster from a snapshot and stay convergent with live diffs (end-to-end CRDT)", () => {
    const { client, send } = setup();
    const a = client("a", ada());
    send(a, { t: "sub", ch: "chat:r" });
    const view = new PresenceCRDT(); // what a browser would hold
    const apply = (c: FakeClient): void => {
      for (const m of c.inbox) {
        if (m.t === "presence.snapshot") view.applyAll(m.ops);
        if (m.t === "presence.diff") view.applyAll(m.ops);
      }
      c.clear();
    };
    apply(a);
    const l = client("l", lin());
    send(l, { t: "sub", ch: "chat:r" });
    send(l, { t: "presence", ch: "chat:r", op: "set", state: { status: "away" } });
    send(a, { t: "presence", ch: "chat:r", op: "set", state: { cursor: 3 } });
    apply(a);
    expect(view.members().map((m) => [m.key, m.state.status ?? null, m.state.cursor ?? null])).toEqual([["a", null, 3], ["l", "away", null]]);
    send(l, { t: "unsub", ch: "chat:r" });
    apply(a);
    expect(view.members().map((m) => m.key)).toEqual(["a"]);
  });
  it("converges for any interleaving of joins, updates and leaves (property)", () => {
    const step = fc.oneof(
      fc.record({ k: fc.constant("join" as const), who: fc.integer({ min: 0, max: 3 }) }),
      fc.record({ k: fc.constant("set" as const), who: fc.integer({ min: 0, max: 3 }), v: fc.integer({ min: 0, max: 9 }) }),
      fc.record({ k: fc.constant("leave" as const), who: fc.integer({ min: 0, max: 3 }) }),
    );
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 40 }), (steps) => {
        const { client, send, broker } = setup();
        const watcher = client("watcher", user("w", "chat:*=sub,presence", { name: "W" }));
        send(watcher, { t: "sub", ch: "chat:r" });
        const view = new PresenceCRDT();
        const people = [0, 1, 2, 3].map((i) => client(`c${i}`, user(`u${i}`, "chat:*=sub,pub,presence", { name: `U${i}` })));
        const joined = new Set<number>();
        for (const s of steps) {
          const c = people[s.who] as FakeClient;
          if (s.k === "join" && !joined.has(s.who)) {
            send(c, { t: "sub", ch: "chat:r" });
            joined.add(s.who);
          } else if (s.k === "set" && joined.has(s.who)) send(c, { t: "presence", ch: "chat:r", op: "set", state: { n: s.v } });
          else if (s.k === "leave" && joined.has(s.who)) {
            send(c, { t: "unsub", ch: "chat:r" });
            joined.delete(s.who);
          }
        }
        for (const m of watcher.inbox) if (m.t === "presence.snapshot" || m.t === "presence.diff") view.applyAll(m.ops);
        expect(view.members()).toEqual(broker.members("chat:r"));
      }),
      { numRuns: 200 },
    );
  });
  it("refuses presence without permission, without subscribing, on a channel with presence off, and for reserved fields", () => {
    const { client, send } = setup();
    const noPresence = client("n", user("n", "doc:*=sub"));
    send(noPresence, { t: "sub", ch: "doc:1" });
    send(noPresence, { t: "presence", ch: "doc:1", op: "set", state: { s: 1 } });
    expect(noPresence.last("error")).toMatchObject({ code: "HP-104" });
    const a = client("a", ada());
    send(a, { t: "presence", ch: "chat:r", op: "set", state: { s: 1 } });
    expect(a.last("error")).toMatchObject({ code: "HP-104", reason: "not_subscribed" });
    send(a, { t: "sub", ch: "chat:r" });
    for (const state of [{ userId: "evil" }, { username: "evil" }, { $alive: false }, {}, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))]) {
      a.clear();
      send(a, { t: "presence", ch: "chat:r", op: "set", state });
      expect(a.last("error"), JSON.stringify(state).slice(0, 30)).toMatchObject({ code: "HP-102" });
    }
    const o = client("o");
    send(o, { t: "sub", ch: "open:r" });
    send(o, { t: "presence", ch: "open:r", op: "get" });
    expect(o.last("error")).toMatchObject({ code: "HP-104", reason: "presence_off" });
  });
  it("supports anonymous presence on a public channel with a generated user id", () => {
    const { client, send, broker } = setup();
    const a = client("a");
    send(a, { t: "sub", ch: "chat:r" });
    expect(broker.members("chat:r")[0]?.state.userId).toBe("anon:a");
  });
});

describe("limits and housekeeping", () => {
  it("caps subscriptions per connection", () => {
    const { client, send } = setup();
    const a = client("a");
    for (let i = 0; i < 100; i++) send(a, { t: "sub", ch: `open:c${i}` });
    send(a, { t: "sub", ch: "open:one-too-many" });
    expect(a.last("error")).toMatchObject({ code: "HP-104", reason: "too_many_subscriptions" });
  });
  it("answers application pings and is not rate limited by them", () => {
    const { client, send } = setup();
    const a = client("a");
    for (let i = 0; i < 500; i++) send(a, { t: "ping", ts: i });
    expect(a.of("pong")).toHaveLength(500);
  });
  it("reports statistics", () => {
    const { client, send, broker } = setup();
    const a = client("a");
    send(a, { t: "sub", ch: "open:s" });
    send(a, { t: "pub", ch: "open:s", ev: "e", data: 1 });
    const s = broker.stats();
    expect(s).toMatchObject({ connections: 1, subscriptions: 1, counters: { published: 1, delivered: 1 } });
    expect(s.channels[0]).toMatchObject({ name: "open:s", subscribers: 1, head: 1, retained: 1 });
    expect(broker.recent("open:s")).toHaveLength(1);
    expect(broker.head("open:s")).toBe(1);
  });
  it("keeps the sequence going when retention changes", () => {
    const { client, send, broker, registry } = setup();
    const a = client("a");
    for (let i = 0; i < 5; i++) send(a, { t: "pub", ch: "open:s", ev: "e", data: i });
    registry.add({ namespace: "open", access: { subscribe: "public", publish: "public", presence: "off" }, retention: { events: 2 }, rateLimit: { capacity: 1000, refillPerSecond: 1000 } });
    send(a, { t: "pub", ch: "open:s", ev: "e", data: 5 });
    expect(broker.head("open:s")).toBe(6);
    expect(broker.recent("open:s").map((e) => e.seq)).toEqual([5, 6]);
  });
  it("ignores messages from a connection that is gone", () => {
    const { client, send, broker } = setup();
    const a = client("a");
    broker.disconnect("a");
    send(a, { t: "pub", ch: "open:s", ev: "e", data: 1 });
    expect(broker.head("open:s")).toBe(0);
  });
});


describe("channel limits and idle sweep", () => {
  it("refuses new channels beyond maxChannels but keeps serving existing ones", () => {
    const { broker, client, send } = setup({ maxChannels: 2 });
    const a = client("a");
    for (const ch of ["open:1", "open:2", "open:3"]) send(a, { t: "sub", ch });
    expect(a.last("error")).toMatchObject({ code: "HP-101", reason: "channel_limit", ch: "open:3" });
    send(a, { t: "sub", ch: "open:1" });
    expect(a.of("error")).toHaveLength(1);
    expect(broker.publish("open:3", "e", 1)).toMatchObject({ ok: false, code: "HP-101", reason: "channel_limit" });
    expect(broker.publish("open:1", "e", 1)).toMatchObject({ ok: true });
    const b = client("b", user("b", "open:*=pub"));
    send(b, { t: "pub", ch: "open:4", ev: "e", data: 1 });
    expect(b.last("error")).toMatchObject({ reason: "channel_limit" });
  });
  it("sweeps idle channels with no subscribers, never ones someone is on", () => {
    let t = 0;
    const { broker, client, send } = setup({ now: () => t });
    const a = client("a");
    send(a, { t: "sub", ch: "open:live" });
    broker.publish("open:quiet", "e", 1);
    t = 1000;
    expect(broker.sweep(500)).toBe(1);
    expect(broker.head("open:quiet")).toBe(0);
    expect(broker.stats().channels.map((c) => c.name)).toEqual(["open:live"]);
    broker.disconnect("a");
    t = 1200;
    expect(broker.sweep(500)).toBe(0);
    t = 1600;
    expect(broker.sweep(500)).toBe(1);
  });
});
