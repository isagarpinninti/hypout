import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ALIVE, HeartbeatMonitor, LamportClock, PresenceCRDT, RingBuffer, TokenBucket, diffMembers } from "../src/engine/index-basics";
import type { PresenceOp } from "../src/protocol/messages";

const ev = (seq: number): { seq: number; v: string } => ({ seq, v: `e${seq}` });

describe("RingBuffer", () => {
  it("replays everything after a sequence, oldest first", () => {
    const r = new RingBuffer<{ seq: number; v: string }>(5);
    for (let i = 1; i <= 4; i++) r.push(ev(i));
    expect(r.head).toBe(4);
    expect(r.oldest).toBe(1);
    expect(r.since(2).events.map((e) => e.seq)).toEqual([3, 4]);
    expect(r.since(0).events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(r.since(4)).toEqual({ events: [], gap: false });
  });
  it("overwrites the oldest when full and reports a gap if the cursor fell off the end", () => {
    const r = new RingBuffer<{ seq: number; v: string }>(3);
    for (let i = 1; i <= 7; i++) r.push(ev(i));
    expect(r.size).toBe(3);
    expect(r.oldest).toBe(5);
    expect(r.since(5)).toEqual({ events: [ev(6), ev(7)], gap: false });
    const behind = r.since(2);
    expect(behind.gap).toBe(true);
    expect(behind.events.map((e) => e.seq)).toEqual([5, 6, 7]);
  });
  it("never grows past its capacity (memory stays flat)", () => {
    const r = new RingBuffer<{ seq: number }>(100);
    for (let i = 1; i <= 100_000; i++) r.push({ seq: i });
    expect(r.size).toBe(100);
    expect(r.since(99_950).events).toHaveLength(50);
  });
  it("is correct for any capacity and history (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 80 }), fc.integer({ min: 0, max: 85 }), (cap, n, cursor) => {
        const r = new RingBuffer<{ seq: number }>(cap);
        for (let i = 1; i <= n; i++) r.push({ seq: i });
        const { events, gap } = r.since(cursor);
        const oldest = Math.max(1, n - cap + 1);
        const want = [] as number[];
        for (let s = Math.max(cursor + 1, oldest); s <= n; s++) want.push(s);
        expect(events.map((e) => e.seq)).toEqual(want);
        expect(gap).toBe(n > 0 ? cursor + 1 < oldest : cursor < n);
      }),
      { numRuns: 400 },
    );
  });
  it("rejects out-of-order pushes and bad capacities", () => {
    const r = new RingBuffer<{ seq: number }>(2);
    expect(() => r.push({ seq: 2 })).toThrow(RangeError);
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });
});

const op = (k: string, f: string, v: PresenceOp["v"], ts: number, a = "s"): PresenceOp => ({ k, f, v, ts, a });
const shuffle = <T>(xs: T[], seed: number): T[] => {
  const out = xs.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

describe("PresenceCRDT", () => {
  it("tracks joins, updates and leaves", () => {
    const p = new PresenceCRDT();
    p.applyAll([op("c1", ALIVE, true, 1), op("c1", "username", "ada", 2), op("c2", ALIVE, true, 3), op("c2", "username", "lin", 4)]);
    expect(p.members().map((m) => m.state.username)).toEqual(["ada", "lin"]);
    p.apply(op("c1", "cursor", { x: 1, y: 2 }, 5));
    expect(p.member("c1")?.state.cursor).toEqual({ x: 1, y: 2 });
    p.apply(op("c2", ALIVE, false, 6));
    expect(p.members().map((m) => m.key)).toEqual(["c1"]);
    expect(p.has("c2")).toBe(false);
  });
  it("ignores stale and duplicate operations", () => {
    const p = new PresenceCRDT();
    expect(p.apply(op("c1", "status", "away", 5))).toBe(true);
    expect(p.apply(op("c1", "status", "online", 3))).toBe(false); // older
    expect(p.apply(op("c1", "status", "away", 5))).toBe(false); // duplicate
    expect(p.apply(op("c1", "status", "busy", 6))).toBe(true);
  });
  it("breaks timestamp ties deterministically", () => {
    const a = new PresenceCRDT();
    const b = new PresenceCRDT();
    const x = op("c", "f", "from-a", 4, "a");
    const y = op("c", "f", "from-b", 4, "b");
    a.applyAll([x, y]);
    b.applyAll([y, x]);
    expect(a.equals(b)).toBe(true);
  });
  it("a leave beats an earlier update that arrives late", () => {
    const p = new PresenceCRDT();
    p.apply(op("c", ALIVE, true, 1));
    p.apply(op("c", ALIVE, false, 9));
    p.apply(op("c", "cursor", 1, 5));
    expect(p.has("c")).toBe(false);
  });
  it("converges for any order, with any duplication (property)", () => {
    const opArb = fc.record({
      k: fc.constantFrom("a", "b", "c"),
      f: fc.constantFrom(ALIVE, "name", "cursor", "status"),
      v: fc.oneof(fc.boolean(), fc.integer({ min: 0, max: 5 }), fc.constantFrom("x", "y")),
      ts: fc.integer({ min: 1, max: 12 }),
      a: fc.constantFrom("s1", "s2", "s3"),
    });
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 0, maxLength: 40 }), fc.integer({ min: 1, max: 1e6 }), (ops, seed) => {
        const one = new PresenceCRDT();
        const two = new PresenceCRDT();
        one.applyAll(ops);
        two.applyAll(shuffle([...ops, ...ops.slice(0, 7)], seed)); // different order, some duplicates
        expect(two.equals(one)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
  it("merge is commutative, associative and idempotent (property)", () => {
    const opArb = fc.record({
      k: fc.constantFrom("a", "b"),
      f: fc.constantFrom(ALIVE, "name"),
      v: fc.oneof(fc.boolean(), fc.constantFrom("x", "y", "z")),
      ts: fc.integer({ min: 1, max: 8 }),
      a: fc.constantFrom("s1", "s2"),
    });
    const replica = fc.array(opArb, { maxLength: 15 }).map((ops) => {
      const p = new PresenceCRDT();
      p.applyAll(ops);
      return p;
    });
    const clone = (p: PresenceCRDT): PresenceCRDT => {
      const c = new PresenceCRDT();
      c.merge(p);
      return c;
    };
    fc.assert(
      fc.property(replica, replica, replica, (x, y, z) => {
        const xy = clone(x);
        xy.merge(y);
        const yx = clone(y);
        yx.merge(x);
        expect(xy.equals(yx)).toBe(true);
        const xy_z = clone(xy);
        xy_z.merge(z);
        const yz = clone(y);
        yz.merge(z);
        const x_yz = clone(x);
        x_yz.merge(yz);
        expect(xy_z.equals(x_yz)).toBe(true);
        const twice = clone(xy);
        twice.merge(xy);
        expect(twice.equals(xy)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
  it("replaying toOps() into an empty replica reproduces the state, and gc drops old tombstones", () => {
    const p = new PresenceCRDT();
    p.applyAll([op("a", ALIVE, true, 1), op("a", "n", "x", 2), op("b", ALIVE, true, 3), op("b", ALIVE, false, 4)]);
    const q = new PresenceCRDT();
    q.applyAll(p.toOps());
    expect(q.equals(p)).toBe(true);
    expect(p.liveOps().every((o) => o.k === "a")).toBe(true);
    expect(p.gc(10)).toBe(1);
    expect(p.toOps().some((o) => o.k === "b")).toBe(false);
  });
  it("diffs rosters into joined, left and updated", () => {
    const a = new PresenceCRDT();
    a.applyAll([op("1", ALIVE, true, 1), op("2", ALIVE, true, 1)]);
    const before = a.members();
    a.applyAll([op("1", "status", "away", 2), op("2", ALIVE, false, 2), op("3", ALIVE, true, 2)]);
    const d = diffMembers(before, a.members());
    expect(d.joined.map((m) => m.key)).toEqual(["3"]);
    expect(d.left).toEqual(["2"]);
    expect(d.updated.map((m) => m.key)).toEqual(["1"]);
  });
  it("Lamport clock moves past what it has seen", () => {
    const c = new LamportClock();
    expect([c.tick(), c.tick()]).toEqual([1, 2]);
    c.observe(10);
    expect(c.tick()).toBe(11);
    c.observe(3);
    expect(c.tick()).toBe(12);
  });
});

describe("HeartbeatMonitor (30 s ping, 10 s to answer)", () => {
  it("pings after the interval and evicts a peer that stays silent past the timeout", () => {
    const h = new HeartbeatMonitor();
    h.open("a", 0);
    expect(h.tick(29_999)).toEqual({ ping: [], evict: [] });
    expect(h.tick(30_000)).toEqual({ ping: ["a"], evict: [] });
    expect(h.tick(39_999)).toEqual({ ping: [], evict: [] });
    expect(h.tick(40_000)).toEqual({ ping: [], evict: ["a"] });
    expect(h.size).toBe(0);
  });
  it("keeps a peer that answers in time, and measures the round trip", () => {
    const h = new HeartbeatMonitor();
    h.open("a", 0);
    h.tick(30_000);
    expect(h.pong("a", 30_042)).toBe(42);
    expect(h.tick(40_000)).toEqual({ ping: [], evict: [] });
    expect(h.tick(60_000)).toEqual({ ping: ["a"], evict: [] });
  });
  it("treats any traffic as proof of life only for the next ping, never for an outstanding one", () => {
    const h = new HeartbeatMonitor(1000, 500);
    h.open("a", 0);
    h.tick(1000);
    h.seen("a", 1200); // data frame while a ping is outstanding does not cancel the deadline
    expect(h.tick(1500).evict).toEqual(["a"]);
  });
  it("handles many peers independently", () => {
    const h = new HeartbeatMonitor(1000, 500);
    h.open("fast", 0);
    h.open("slow", 0);
    h.tick(1000);
    h.pong("fast", 1100);
    const r = h.tick(1500);
    expect(r.evict).toEqual(["slow"]);
  });
});

describe("TokenBucket", () => {
  it("allows a burst, then refills over time", () => {
    const b = new TokenBucket(3, 2, 0);
    expect([b.take(0).ok, b.take(0).ok, b.take(0).ok, b.take(0).ok]).toEqual([true, true, true, false]);
    const wait = b.take(0);
    expect(wait).toEqual({ ok: false, retryAfterMs: 500 });
    expect(b.take(500).ok).toBe(true);
    expect(b.take(500).ok).toBe(false);
    expect(b.take(5000).ok).toBe(true);
    expect(b.available).toBeLessThanOrEqual(3);
  });
});
