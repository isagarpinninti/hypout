import { describe, expect, it } from "vitest";
import {
  ChannelRegistry, TokenBucket, allows, compileSchema, mintToken, parseCapabilities, parseClientMessage, patternMatches, preflight, verifyToken, type SchemaNode,
} from "../src";

describe("access tokens", () => {
  const secret = "s3cret";
  const caps = parseCapabilities("chat:*=sub,pub;doc:7=sub,presence");
  it("signs and verifies, carrying the claims", () => {
    const t = mintToken(secret, { sub: "ada", name: "Ada", caps, ttlSeconds: 60 }, 1_000_000);
    expect(t.startsWith("hpt_")).toBe(true);
    const r = verifyToken(secret, t, 1_000_000 + 30_000);
    expect(r).toMatchObject({ ok: true, claims: { sub: "ada", name: "Ada", exp: 1060 } });
  });
  it("rejects a wrong secret, a tampered payload, an expired token and junk", () => {
    const t = mintToken(secret, { sub: "ada", caps, ttlSeconds: 60 }, 0);
    expect(verifyToken("other", t, 1000)).toEqual({ ok: false, reason: "bad_signature" });
    const [head, sig] = t.split(".");
    const forged = `${head?.slice(0, -2)}AA.${sig}`;
    expect(verifyToken(secret, forged, 1000).ok).toBe(false);
    const admin = Buffer.from(JSON.stringify({ sub: "ada", caps: [], admin: true, iat: 0, exp: 99999 })).toString("base64url");
    expect(verifyToken(secret, `hpt_${admin}.${sig}`, 1000)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyToken(secret, t, 61_000)).toEqual({ ok: false, reason: "expired" });
    for (const junk of ["", "hpt_", "hpt_a", "hpt_a.b.c", "nope", "hpt_!!!.@@@"]) expect(verifyToken(secret, junk, 0).ok, junk).toBe(false);
  });
  it("matches capability patterns", () => {
    expect(patternMatches("*", "anything:1")).toBe(true);
    expect(patternMatches("chat:*", "chat")).toBe(true);
    expect(patternMatches("chat:*", "chat:room-1")).toBe(true);
    expect(patternMatches("chat:*", "chatter:1")).toBe(false);
    expect(patternMatches("doc:7", "doc:7")).toBe(true);
    expect(patternMatches("doc:7", "doc:70")).toBe(false);
    expect(allows({ caps }, "pub", "chat:r")).toBe(true);
    expect(allows({ caps }, "pub", "doc:7")).toBe(false);
    expect(allows({ caps: [], admin: true }, "pub", "x")).toBe(true);
  });
  it("parses the CLI capability format and complains clearly", () => {
    expect(parseCapabilities("a:*=sub,pub")).toEqual([{ ch: "a:*", ops: ["sub", "pub"] }]);
    expect(() => parseCapabilities("a")).toThrow(/channel=sub,pub/);
    expect(() => parseCapabilities("a=fly")).toThrow(/unknown operation/);
  });
});

describe("schema compiler", () => {
  const ok = (node: SchemaNode, value: unknown): boolean => compileSchema(node).safeParse(value).success;
  it("validates primitives with their limits", () => {
    expect(ok({ type: "string", minLength: 2, maxLength: 4 }, "abc")).toBe(true);
    expect(ok({ type: "string", minLength: 2, maxLength: 4 }, "a")).toBe(false);
    expect(ok({ type: "string", pattern: "^[a-z]+$" }, "abc")).toBe(true);
    expect(ok({ type: "string", pattern: "^[a-z]+$" }, "ABC")).toBe(false);
    expect(ok({ type: "string", enum: ["a", "b"] }, "b")).toBe(true);
    expect(ok({ type: "string", enum: ["a", "b"] }, "c")).toBe(false);
    expect(ok({ type: "integer", minimum: 0, maximum: 10 }, 5)).toBe(true);
    expect(ok({ type: "integer", minimum: 0, maximum: 10 }, 5.5)).toBe(false);
    expect(ok({ type: "number" }, Number.NaN)).toBe(false);
    expect(ok({ type: "number" }, Number.POSITIVE_INFINITY)).toBe(false);
    expect(ok({ type: "boolean" }, "true")).toBe(false);
    expect(ok({ type: "any" }, { whatever: [1] })).toBe(true);
  });
  it("validates objects strictly (required, optional, no extras) unless extras are allowed", () => {
    const node: SchemaNode = { type: "object", properties: { id: { type: "integer" }, note: { type: "string" } }, required: ["id"] };
    expect(ok(node, { id: 1 })).toBe(true);
    expect(ok(node, { id: 1, note: "x" })).toBe(true);
    expect(ok(node, {})).toBe(false);
    expect(ok(node, { id: 1, extra: 1 })).toBe(false);
    expect(ok({ ...node, additionalProperties: true } as SchemaNode, { id: 1, extra: 1 })).toBe(true);
  });
  it("validates arrays of nested objects", () => {
    const node: SchemaNode = { type: "array", items: { type: "object", properties: { v: { type: "number" } }, required: ["v"] }, maxItems: 2 };
    expect(ok(node, [{ v: 1 }, { v: 2 }])).toBe(true);
    expect(ok(node, [{ v: 1 }, { v: 2 }, { v: 3 }])).toBe(false);
    expect(ok(node, [{ v: "x" }])).toBe(false);
  });
  it("rejects definitions that cannot work", () => {
    expect(() => compileSchema({ type: "string", pattern: "(" })).toThrow();
    expect(() => compileSchema({ type: "object", properties: {}, required: ["missing"] })).toThrow(/not declared/);
    let deep: SchemaNode = { type: "any" };
    for (let i = 0; i < 12; i++) deep = { type: "array", items: deep };
    expect(() => compileSchema(deep)).toThrow(/deeper/);
  });
});

describe("channel registry", () => {
  const reg = new ChannelRegistry([{ namespace: "chat", events: { message: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } }, { namespace: "alerts" }]);
  it("resolves names to definitions and applies the defaults", () => {
    const r = reg.resolve("chat:room-42");
    expect(r.ok && r.channel).toMatchObject({ namespace: "chat", id: "room-42", definition: { access: { subscribe: "public", publish: "token", presence: "off" }, retention: { events: 500 }, rateLimit: { capacity: 30, refillPerSecond: 10 } } });
    expect(reg.resolve("alerts")).toMatchObject({ ok: true, channel: { id: null } });
    expect(reg.namespaces()).toEqual(["alerts", "chat"]);
  });
  it("explains why a name was refused", () => {
    expect(reg.resolve("Chat")).toMatchObject({ ok: false, reason: "syntax" });
    expect(reg.resolve("ghost:1")).toMatchObject({ ok: false, reason: "unknown_namespace" });
  });
  it("rejects invalid definitions with a readable message naming the problem", () => {
    expect(() => new ChannelRegistry([{ namespace: "Bad Name" } as never])).toThrow(/invalid channel definition "Bad Name"/);
    expect(() => new ChannelRegistry([{ namespace: "x", surprise: true } as never])).toThrow(/surprise/);
    expect(() => new ChannelRegistry([{ namespace: "x", events: { e: { type: "string", pattern: "(" } } }])).toThrow(/event "e"/);
  });
  it("can replace and remove a namespace", () => {
    const r = new ChannelRegistry([{ namespace: "a" }]);
    r.add({ namespace: "a", retention: { events: 7 } });
    expect(r.get("a")?.retention.events).toBe(7);
    expect(r.remove("a")).toBe(true);
    expect(r.resolve("a")).toMatchObject({ ok: false });
  });
});

describe("client message parsing", () => {
  it("accepts every message shape", () => {
    for (const m of [
      { t: "sub", ch: "a", lastSeq: 3 }, { t: "unsub", ch: "a" }, { t: "pub", ch: "a", ev: "e", data: { x: 1 }, mid: "1" },
      { t: "presence", ch: "a", op: "set", state: { s: 1 } }, { t: "presence", ch: "a", op: "get" }, { t: "auth", token: "hpt_x" }, { t: "ping", ts: 1 }, { t: "ping" },
    ]) expect(parseClientMessage(JSON.stringify(m)), JSON.stringify(m)).toMatchObject({ ok: true });
  });
  it("explains what is wrong", () => {
    expect(parseClientMessage("{not json")).toEqual({ ok: false, reason: "not valid JSON" });
    expect(parseClientMessage('{"t":"nope"}')).toMatchObject({ ok: false });
    expect(parseClientMessage('{"t":"sub"}')).toMatchObject({ ok: false, reason: expect.stringContaining("ch") });
    expect(parseClientMessage('{"t":"pub","ch":"a","ev":""}')).toMatchObject({ ok: false });
    expect(parseClientMessage("[]")).toMatchObject({ ok: false });
  });
});

describe("pre-flight report", () => {
  const reg = new ChannelRegistry([
    { namespace: "chat", access: { subscribe: "public", publish: "token", presence: "off" }, events: { message: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
  ]);
  const principal = { sub: "u", caps: parseCapabilities("chat:*=sub,pub") };
  it("reports every gate on a good publish", () => {
    const r = preflight(reg, { op: "pub", channel: "chat:r", event: "message", data: { text: "hi" }, principal, bytes: 40, bucket: new TokenBucket(5, 1, 0), now: 0 });
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => [c.code, c.ok, c.skipped])).toEqual([["HP-101", true, false], ["HP-102", true, false], ["HP-103", true, false], ["HP-104", true, false], ["HP-105", true, true], ["HP-106", true, false]]);
  });
  it("shows all the failures together, not just the first", () => {
    const r = preflight(reg, { op: "pub", channel: "chat:r", event: "nope", data: 1, principal: null, bytes: 99_999, bucket: new TokenBucket(1, 1, 0), now: 0 });
    expect(r.ok).toBe(false);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.code)).toEqual(["HP-102", "HP-104", "HP-106"]);
  });
  it("stops at an invalid channel but still checks the size, and checks the replay cursor on subscribe", () => {
    const bad = preflight(reg, { op: "sub", channel: "NOPE", principal: null, bytes: 10 });
    expect(bad.checks.filter((c) => !c.ok).map((c) => c.code)).toEqual(["HP-101"]);
    const cursor = preflight(reg, { op: "sub", channel: "chat:r", lastSeq: 50, head: 10, principal: null, bytes: 10 });
    expect(cursor.checks.find((c) => c.code === "HP-105")).toMatchObject({ ok: false, skipped: false });
  });
});
