import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WsClient, mintToken, parseCapabilities, type ServerMessage } from "@hypout/core";
import { createHypoutServer, verifyLedger, type HypoutServer } from "../src";

const SECRET = "test-secret-0123456789";
const defs = [
  { namespace: "chat", access: { subscribe: "public" as const, publish: "token" as const, presence: "public" as const }, events: { message: { type: "object" as const, properties: { text: { type: "string" as const, maxLength: 200 } }, required: ["text"] } }, retention: { events: 50 } },
  { namespace: "news", access: { subscribe: "public" as const, publish: "server" as const, presence: "off" as const } },
];

let dir: string;
let server: HypoutServer;
let port: number;
let clients: WsClient[] = [];

const tokenFor = (sub: string, caps = "chat:*=sub,pub,presence"): string => mintToken(SECRET, { sub, name: sub, caps: parseCapabilities(caps), ttlSeconds: 600 });
const connect = async (token?: string, extra = ""): Promise<WsClient> => {
  const c = await WsClient.connect(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ""}${extra}`, { protocols: ["hypout.v1"] });
  clients.push(c);
  return c;
};
const until = async <T extends ServerMessage>(c: WsClient, pred: (m: ServerMessage) => m is T, limit = 20): Promise<T> => {
  for (let i = 0; i < limit; i++) {
    const m = await c.nextJson<ServerMessage>(3000);
    if (pred(m)) return m;
  }
  throw new Error("expected message never arrived");
};
const isT = <K extends ServerMessage["t"]>(t: K) => (m: ServerMessage): m is Extract<ServerMessage, { t: K }> => m.t === t;
const send = (c: WsClient, m: object): void => c.sendText(JSON.stringify(m));
/** The REST responses the tests read, typed loosely: a missing field fails the assertion that reads it. */
interface ApiBody {
  ok: boolean; seq: number; code: string; token: string; active: boolean; head: number; connections: number;
  events: unknown[]; members: unknown[]; namespaces: Array<{ namespace: string }>; checks: Array<{ code: string; ok: boolean }>;
  frames: Array<{ dir: string; text: string | null; masked: boolean }>;
}
const api = async (path: string, init: RequestInit = {}, token = server.adminToken): Promise<{ status: number; body: ApiBody }> => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as ApiBody };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hypout-"));
  server = createHypoutServer({ secret: SECRET, port: 0, channels: defs, ledgerPath: join(dir, "ledger.jsonl"), heartbeat: { intervalMs: 1000, timeoutMs: 500 } });
  port = (await server.listen()).port;
  clients = [];
});
afterEach(async () => {
  for (const c of clients) c.destroy();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("websocket round trip", () => {
  it("welcomes, subscribes, publishes and delivers to both ends", async () => {
    const a = await connect(tokenFor("ada"));
    const b = await connect(tokenFor("bob"));
    expect(a.protocol).toBe("hypout.v1");
    expect((await until(a, isT("welcome"))).authenticated).toBe(true);
    await until(b, isT("welcome"));
    send(a, { t: "sub", ch: "chat:r1" });
    send(b, { t: "sub", ch: "chat:r1" });
    await until(a, isT("sub.ok"));
    await until(b, isT("sub.ok"));
    send(a, { t: "pub", ch: "chat:r1", ev: "message", data: { text: "hello" }, mid: "m1" });
    const ev = await until(b, isT("event"));
    expect(ev).toMatchObject({ ch: "chat:r1", seq: 1, ev: "message", data: { text: "hello" } });
    expect((await until(a, isT("ack"))).mid).toBe("m1");
  });

  it("refuses an anonymous publish with HP-104 and a bad payload with HP-102", async () => {
    const anon = await connect();
    send(anon, { t: "sub", ch: "chat:r1" });
    await until(anon, isT("sub.ok"));
    send(anon, { t: "pub", ch: "chat:r1", ev: "message", data: { text: "x" } });
    expect((await until(anon, isT("error"))).code).toBe("HP-104");
    const u = await connect(tokenFor("ada"));
    send(u, { t: "pub", ch: "chat:r1", ev: "message", data: { text: 5 } });
    expect((await until(u, isT("error"))).code).toBe("HP-102");
  });

  it("replays what a reconnecting client missed using lastSeq", async () => {
    const pub = await connect(tokenFor("ada"));
    for (let i = 1; i <= 5; i++) send(pub, { t: "pub", ch: "chat:r2", ev: "message", data: { text: `m${i}` } });
    await new Promise((r) => setTimeout(r, 150));
    const late = await connect();
    send(late, { t: "sub", ch: "chat:r2", lastSeq: 2 });
    const ok = await until(late, isT("sub.ok"));
    expect(ok).toMatchObject({ seq: 5, replayed: 3, gap: false });
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) texts.push(((await until(late, isT("event"))).data as { text: string }).text);
    expect(texts).toEqual(["m3", "m4", "m5"]);
  });

  it("shares presence through CRDT ops and removes a member on disconnect", async () => {
    const a = await connect(tokenFor("ada"));
    const b = await connect(tokenFor("bob"));
    send(a, { t: "sub", ch: "chat:r3" });
    await until(a, isT("sub.ok"));
    send(a, { t: "presence", ch: "chat:r3", op: "set", state: { status: "typing" } });
    send(b, { t: "sub", ch: "chat:r3" });
    const snap = await until(b, isT("presence.snapshot"));
    expect(snap.members.map((m) => m.state["userId"])).toContain("ada");
    b.destroy();
    send(a, { t: "presence", ch: "chat:r3", op: "get" });
    const later = await until(a, isT("presence.snapshot"));
    expect(later.members.map((m) => m.state["userId"])).toEqual(["ada"]);
  });
});

describe("protocol hygiene", () => {
  it("closes with 1002 on an unmasked client frame", async () => {
    const c = await connect();
    c.sendRaw(Uint8Array.from([0x81, 0x02, 0x68, 0x69]));
    expect((await c.closed).code).toBe(1002);
  });
  it("closes with 1009 on an oversize frame, 1003 on binary", async () => {
    const big = await connect();
    big.sendText("x".repeat(70_000));
    expect((await big.closed).code).toBe(1009);
    const bin = await connect();
    bin.sendBinary(new Uint8Array([1, 2, 3]));
    expect((await bin.closed).code).toBe(1003);
  });
  it("reports a malformed JSON message as HP-000 without closing", async () => {
    const c = await connect();
    c.sendText("{nope");
    const e = await until(c, isT("error"));
    expect(e).toMatchObject({ code: "HP-000", reason: "bad_message" });
    send(c, { t: "ping", ts: 7 });
    expect((await until(c, isT("pong"))).ts).toBe(7);
  });
  it("answers pings, and evicts a peer that never pongs", async () => {
    const c = await connect();
    c.sendRaw(Uint8Array.from([0x89, 0x80, 1, 2, 3, 4]));
    await new Promise((r) => setTimeout(r, 100));
    let pongs = 0;
    c.onPong = () => pongs++;
    c.ping();
    await new Promise((r) => setTimeout(r, 200));
    expect(pongs).toBeGreaterThan(0);
  });
  it("rejects a bad token, a wrong path and a foreign origin when origins are restricted", async () => {
    await expect(WsClient.connect(`ws://127.0.0.1:${port}/ws?token=hpt_bad.sig`)).rejects.toThrow(/401/);
    await expect(WsClient.connect(`ws://127.0.0.1:${port}/nope`)).rejects.toThrow(/404/);
    const strict = createHypoutServer({ secret: SECRET, port: 0, allowedOrigins: ["https://app.example"] });
    const p = (await strict.listen()).port;
    await expect(WsClient.connect(`ws://127.0.0.1:${p}/ws`, { origin: "https://evil.example" })).rejects.toThrow(/403/);
    const ok = await WsClient.connect(`ws://127.0.0.1:${p}/ws`, { origin: "https://app.example" });
    ok.destroy();
    await strict.close();
  });
  it("frees the server socket when the client vanishes", async () => {
    const c = await connect();
    await until(c, isT("welcome"));
    expect(server.broker.stats().connections).toBe(1);
    c.destroy();
    for (let i = 0; i < 40 && server.broker.stats().connections > 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(server.broker.stats().connections).toBe(0);
  });
});

describe("REST API", () => {
  it("requires an admin token", async () => {
    expect((await api("/api/stats", {}, "nope")).status).toBe(401);
    expect((await api("/api/stats", {}, tokenFor("ada"))).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  });
  it("publishes on a server-only channel and fans out; refuses a client publish there", async () => {
    const sub = await connect();
    send(sub, { t: "sub", ch: "news" });
    await until(sub, isT("sub.ok"));
    const r = await api("/api/publish", { method: "POST", body: JSON.stringify({ channel: "news", event: "headline", data: { t: "Hi" } }) });
    expect(r.body).toMatchObject({ ok: true, seq: 1 });
    expect((await until(sub, isT("event"))).data).toEqual({ t: "Hi" });
    const user = await connect(tokenFor("ada", "news=pub"));
    send(user, { t: "pub", ch: "news", ev: "x", data: 1 });
    expect((await until(user, isT("error"))).code).toBe("HP-104");
  });
  it("reports gate failures with the right status", async () => {
    const bad = await api("/api/publish", { method: "POST", body: JSON.stringify({ channel: "ghost", event: "e", data: 1 }) });
    expect(bad).toMatchObject({ status: 422, body: { code: "HP-101" } });
    const pre = await api("/api/preflight", { method: "POST", body: JSON.stringify({ op: "pub", channel: "chat:r", event: "message", data: { text: 3 } }) });
    expect(pre.body.checks.find((c) => c.code === "HP-102")?.ok).toBe(false);
  });
  it("lists channels, events and members, and mints a usable token", async () => {
    await api("/api/publish", { method: "POST", body: JSON.stringify({ channel: "news", event: "a", data: 1 }) });
    expect((await api("/api/channels/news/events")).body.events).toHaveLength(1);
    expect((await api("/api/channels/chat%3Ar/members")).body.members).toEqual([]);
    expect((await api("/api/channels")).body.namespaces.map((n) => n.namespace)).toEqual(["chat", "news"]);
    const minted = await api("/api/token", { method: "POST", body: JSON.stringify({ sub: "zed", caps: "chat:*=sub,pub" }) });
    const c = await connect(minted.body.token);
    expect((await until(c, isT("welcome"))).authenticated).toBe(true);
    expect((await api("/api/token", { method: "POST", body: JSON.stringify({ sub: "z", caps: "bad" }) })).status).toBe(400);
  });
  it("rejects oversize and malformed bodies", async () => {
    expect((await api("/api/publish", { method: "POST", body: "{x" })).status).toBe(400);
    expect((await api("/api/publish", { method: "POST", body: JSON.stringify({ channel: "news", event: "e", data: "x".repeat(300_000) }) })).status).toBe(413);
  });
});

describe("chaos, wire tap and ledger", () => {
  it("cuts every connection on demand without a closing handshake", async () => {
    const c = await connect(tokenFor("ada"));
    await until(c, isT("welcome"));
    expect((await api("/api/sever", { method: "POST", body: "{}" })).body).toEqual({ severed: 1 });
    expect((await c.closed).clean).toBe(false);
  });
  it("drops events on demand and replay recovers them", async () => {
    const sub = await connect();
    send(sub, { t: "sub", ch: "news" });
    await until(sub, isT("sub.ok"));
    expect((await api("/api/chaos", { method: "POST", body: JSON.stringify({ dropRate: 1 }) })).body.active).toBe(true);
    for (let i = 0; i < 3; i++) await api("/api/publish", { method: "POST", body: JSON.stringify({ channel: "news", event: "n", data: i }) });
    expect(server.chaos.dropped).toBe(3);
    await api("/api/chaos", { method: "POST", body: JSON.stringify({ reset: true }) });
    send(sub, { t: "sub", ch: "news", lastSeq: 0 });
    const ok = await until(sub, isT("sub.ok"));
    expect(ok.replayed).toBe(3);
    expect((await api("/api/chaos", { method: "POST", body: JSON.stringify({ dropRate: 2 }) })).status).toBe(400);
  });
  it("records frames in both directions, marking dropped ones", async () => {
    const c = await connect();
    await until(c, isT("welcome"));
    send(c, { t: "ping", ts: 1 });
    await until(c, isT("pong"));
    const wire = (await api("/api/wire")).body;
    const dirs = new Set(wire.frames.map((f) => f.dir));
    expect(dirs).toEqual(new Set(["in", "out"]));
    expect(wire.frames.some((f) => f.text?.includes('"t":"welcome"'))).toBe(true);
    expect(wire.frames.find((f) => f.dir === "in")?.masked).toBe(true);
  });
  it("writes a verifiable hash-chained ledger that detects tampering", async () => {
    for (let i = 0; i < 4; i++) await api("/api/publish", { method: "POST", body: JSON.stringify({ channel: "news", event: "n", data: { i } }) });
    const path = join(dir, "ledger.jsonl");
    expect(verifyLedger(path)).toMatchObject({ ok: true, entries: 4 });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const edited = JSON.parse(lines[1] as string);
    edited.ev = "forged";
    writeFileSync(path, [lines[0], JSON.stringify(edited), lines[2], lines[3]].join("\n") + "\n");
    expect(verifyLedger(path)).toMatchObject({ ok: false, brokenAt: 2 });
    writeFileSync(path, [lines[0], lines[2], lines[3]].join("\n") + "\n");
    expect(verifyLedger(path)).toMatchObject({ ok: false, brokenAt: 2 });
  });
});
