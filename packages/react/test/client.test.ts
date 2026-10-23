import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HypoutClient, HypoutError, type SocketLike } from "../src";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string): void {
    this.sent.push(JSON.parse(d) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  receive(m: object): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" });
  }
  welcome(): void {
    this.receive({ t: "welcome", cid: "c_me", serverTime: 0, heartbeat: { intervalMs: 30000, timeoutMs: 10000 }, maxPayload: 65536, authenticated: false });
  }
}
const last = (): FakeSocket => FakeSocket.all.at(-1) as FakeSocket;
const make = (extra: Partial<ConstructorParameters<typeof HypoutClient>[0]> = {}): HypoutClient =>
  new HypoutClient({ url: "ws://x/ws", socket: (u) => new FakeSocket(u), random: () => 1, ...extra });
const ev = (ch: string, seq: number, extra: object = {}) => ({ t: "event", ch, seq, ts: seq, ev: "e", data: seq, from: "c_o", ...extra });
const flush = (): Promise<void> => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("connecting", () => {
  it("opens, passes the token in the URL, and reports status", async () => {
    const c = make({ token: "hpt_a b" });
    await flush();
    expect(last().url).toBe("ws://x/ws?token=hpt_a%20b");
    expect(c.status).toBe("connecting");
    last().welcome();
    expect(c.status).toBe("open");
    expect(c.connectionId).toBe("c_me");
  });
  it("calls a token function on every connect", async () => {
    let n = 0;
    make({ token: () => `t${++n}` });
    await flush();
    expect(last().url).toContain("token=t1");
    last().drop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(last().url).toContain("token=t2");
  });
  it("backs off between attempts, caps the delay, and resets after a welcome", async () => {
    make({ reconnect: { minMs: 100, maxMs: 400, factor: 2 } });
    await flush();
    const delays = [100, 200, 400, 400];
    for (const d of delays) {
      const before = FakeSocket.all.length;
      last().drop();
      await vi.advanceTimersByTimeAsync(d - 1);
      expect(FakeSocket.all.length, `no retry before ${d} ms`).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.all.length, `retry at ${d} ms`).toBe(before + 1);
    }
    last().welcome();
    last().drop();
    const before = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeSocket.all.length).toBe(before + 1);
  });
  it("does not reconnect after close(), or when reconnect is off", async () => {
    const c = make();
    await flush();
    c.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all.length).toBe(1);
    expect(c.status).toBe("closed");
    const off = make({ reconnect: false });
    await flush();
    last().drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all.length).toBe(2);
    expect(off.status).toBe("closed");
  });
});

describe("subscriptions and replay", () => {
  it("subscribes after welcome and resumes from the last sequence after a reconnect", async () => {
    const c = make({ reconnect: { minMs: 10, maxMs: 10, factor: 1 } });
    const got: number[] = [];
    c.subscribe("chat:r", { onEvent: (e) => got.push(e.seq) });
    await flush();
    last().welcome();
    expect(last().sent).toEqual([{ t: "sub", ch: "chat:r" }]);
    last().receive({ t: "sub.ok", ch: "chat:r", seq: 0, oldest: null, replayed: 0, gap: false });
    last().receive(ev("chat:r", 1));
    last().receive(ev("chat:r", 2));
    last().drop();
    await vi.advanceTimersByTimeAsync(20);
    last().welcome();
    expect(last().sent).toEqual([{ t: "sub", ch: "chat:r", lastSeq: 2 }]);
    last().receive({ t: "sub.ok", ch: "chat:r", seq: 4, oldest: 1, replayed: 2, gap: false });
    last().receive(ev("chat:r", 3, { replay: true }));
    last().receive(ev("chat:r", 4, { replay: true }));
    expect(got).toEqual([1, 2, 3, 4]);
  });
  it("ignores duplicates and recovers from a hole by asking for a replay", async () => {
    const c = make();
    const got: Array<[number, boolean]> = [];
    c.subscribe("chat:r", { onEvent: (e) => got.push([e.seq, e.replay]) });
    await flush();
    last().welcome();
    last().receive({ t: "sub.ok", ch: "chat:r", seq: 0, oldest: null, replayed: 0, gap: false });
    last().receive(ev("chat:r", 1));
    last().receive(ev("chat:r", 1));
    last().receive(ev("chat:r", 4));
    expect(last().sent.at(-1)).toEqual({ t: "sub", ch: "chat:r", lastSeq: 1 });
    last().receive({ t: "sub.ok", ch: "chat:r", seq: 4, oldest: 1, replayed: 3, gap: false });
    for (const s of [2, 3, 4]) last().receive(ev("chat:r", s, { replay: true }));
    expect(got).toEqual([[1, false], [2, true], [3, true], [4, true]]);
  });
  it("recovers events dropped before the first one ever arrived, on a channel that was empty at subscribe", async () => {
    const c = make();
    const got: number[] = [];
    c.subscribe("chat:r", { onEvent: (e) => got.push(e.seq) });
    await flush();
    last().welcome();
    last().receive({ t: "sub.ok", ch: "chat:r", seq: 0, oldest: null, replayed: 0, gap: false });
    last().receive(ev("chat:r", 3));
    expect(last().sent.at(-1)).toEqual({ t: "sub", ch: "chat:r", lastSeq: 0 });
    last().receive({ t: "sub.ok", ch: "chat:r", seq: 3, oldest: 1, replayed: 3, gap: false });
    for (const s of [1, 2, 3]) last().receive(ev("chat:r", s, { replay: true }));
    expect(got).toEqual([1, 2, 3]);
  });
  it("starts a fresh subscription at the server's head instead of seeing a false hole", async () => {
    const c = make();
    const got: number[] = [];
    c.subscribe("chat:r", { onEvent: (e) => got.push(e.seq) });
    await flush();
    last().welcome();
    last().receive({ t: "sub.ok", ch: "chat:r", seq: 40, oldest: 1, replayed: 0, gap: false });
    last().receive(ev("chat:r", 41));
    expect(got).toEqual([41]);
    expect(last().sent.filter((m) => m["t"] === "sub")).toHaveLength(1);
  });
  it("accepts a replay that begins after a gap in retention", async () => {
    const c = make();
    const got: number[] = [];
    c.subscribe("chat:r", { onEvent: (e) => got.push(e.seq) });
    await flush();
    last().welcome();
    last().receive({ t: "sub.ok", ch: "chat:r", seq: 5, oldest: 5, replayed: 0, gap: false });
    last().receive(ev("chat:r", 6));
    last().drop();
    expect(got).toEqual([6]);
  });
  it("unsubscribes when the last listener leaves", async () => {
    const c = make();
    const off1 = c.subscribe("a", {});
    const off2 = c.subscribe("a", {});
    await flush();
    last().welcome();
    off1();
    expect(last().sent.some((m) => m["t"] === "unsub")).toBe(false);
    off2();
    expect(last().sent.at(-1)).toEqual({ t: "unsub", ch: "a" });
  });
});

describe("publishing", () => {
  it("resolves on ack and rejects on a gate error with its code", async () => {
    const c = make();
    await flush();
    last().welcome();
    const ok = c.publish("chat:r", "message", { text: "hi" });
    expect(last().sent.at(-1)).toMatchObject({ t: "pub", mid: "m1" });
    last().receive({ t: "ack", ch: "chat:r", seq: 9, mid: "m1" });
    await expect(ok).resolves.toEqual({ seq: 9 });
    const bad = c.publish("chat:r", "message", 1);
    last().receive({ t: "error", code: "HP-102", reason: "schema", message: "bad payload", ch: "chat:r", mid: "m2" });
    await expect(bad).rejects.toMatchObject({ code: "HP-102", name: "HypoutError" });
    await expect(bad).rejects.toBeInstanceOf(HypoutError);
  });
  it("rejects when not connected, on timeout, and when the connection drops mid-flight", async () => {
    const c = make({ ackTimeoutMs: 1000, autoConnect: false });
    await expect(c.publish("a", "e", 1)).rejects.toThrow(/not connected/);
    c.connect();
    await flush();
    last().welcome();
    const slow = c.publish("a", "e", 1);
    const settled = expect(slow).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1001);
    await settled;
    const cut = c.publish("a", "e", 2);
    const lost = expect(cut).rejects.toThrow(/connection lost/);
    last().drop();
    await lost;
  });
  it("sends channel errors to that channel's listeners when no publish is waiting", async () => {
    const c = make();
    const errors: string[] = [];
    c.subscribe("a", { onError: (e) => errors.push(e.code) });
    await flush();
    last().welcome();
    last().receive({ t: "error", code: "HP-104", reason: "denied", message: "no", ch: "a" });
    expect(errors).toEqual(["HP-104"]);
  });
});

describe("presence", () => {
  const op = (k: string, f: string, v: unknown, ts: number, a = "s") => ({ k, f, v, ts, a });
  it("builds the roster from a snapshot, then follows diffs, whatever their order", async () => {
    const c = make();
    const rosters: string[][] = [];
    c.subscribe("chat:r", { onPresence: (m) => rosters.push(m.map((x) => x.key)) });
    await flush();
    last().welcome();
    last().receive({ t: "presence.snapshot", ch: "chat:r", members: [], ops: [op("c1", "$alive", true, 1), op("c1", "name", "Ada", 2)] });
    last().receive({ t: "presence.diff", ch: "chat:r", joined: [], left: [], updated: [], ops: [op("c2", "$alive", true, 3)] });
    last().receive({ t: "presence.diff", ch: "chat:r", joined: [], left: [], updated: [], ops: [op("c1", "$alive", false, 4)] });
    // A stale op that arrives late must not resurrect c1.
    last().receive({ t: "presence.diff", ch: "chat:r", joined: [], left: [], updated: [], ops: [op("c1", "$alive", true, 1)] });
    expect(rosters.at(-1)).toEqual(["c2"]);
    expect(c.members("chat:r").map((m) => m.key)).toEqual(["c2"]);
  });
  it("re-announces its own state after a reconnect", async () => {
    const c = make({ reconnect: { minMs: 5, maxMs: 5, factor: 1 } });
    c.subscribe("chat:r", {});
    await flush();
    last().welcome();
    c.setPresence("chat:r", { name: "Ada" });
    last().drop();
    await vi.advanceTimersByTimeAsync(10);
    last().welcome();
    last().receive({ t: "sub.ok", ch: "chat:r", seq: 0, oldest: null, replayed: 0, gap: false });
    expect(last().sent).toContainEqual({ t: "presence", ch: "chat:r", op: "set", state: { name: "Ada" } });
  });
});

describe("robustness", () => {
  it("ignores malformed and binary frames", async () => {
    const c = make();
    await flush();
    last().onmessage?.({ data: "{nope" });
    last().onmessage?.({ data: new ArrayBuffer(4) });
    last().welcome();
    expect(c.status).toBe("open");
  });
});
