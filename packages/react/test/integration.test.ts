// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken, parseCapabilities } from "@hypout/core";
import { createHypoutServer, type HypoutServer } from "@hypout/cli";
import { HypoutClient, type ChannelEvent } from "../src";

const SECRET = "integration-secret-0123456789";
let server: HypoutServer;
let dir: string;
let ws: string;
const token = (sub: string): string => mintToken(SECRET, { sub, name: sub, caps: parseCapabilities("room:*=sub,pub,presence"), ttlSeconds: 600 });
const until = async (pred: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
};
const clients: HypoutClient[] = [];
const client = (sub: string, extra: object = {}): HypoutClient => {
  const c = new HypoutClient({ url: ws, token: token(sub), reconnect: { minMs: 30, maxMs: 60, factor: 1 }, ...extra });
  clients.push(c);
  return c;
};

beforeAll(async () => {
  if (typeof WebSocket === "undefined") return;
  dir = mkdtempSync(join(tmpdir(), "hypout-react-"));
  server = createHypoutServer({ secret: SECRET, port: 0, channels: [{ namespace: "room", access: { subscribe: "public", publish: "token", presence: "public" } }], ledgerPath: join(dir, "l.jsonl") });
  const { port } = await server.listen();
  ws = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => {
  if (!server) return;
  for (const c of clients) c.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

// Node 20 has no global WebSocket; the client needs one (Node 22+ or a browser).
describe.skipIf(typeof WebSocket === "undefined")("client against a real server", () => {
  it("publishes, receives, and acknowledges", async () => {
    const a = client("ada");
    const b = client("bob");
    const got: ChannelEvent[] = [];
    b.subscribe("room:1", { onEvent: (e) => got.push(e as ChannelEvent) });
    a.subscribe("room:1", {});
    await until(() => a.status === "open" && b.status === "open");
    await new Promise((r) => setTimeout(r, 80));
    const ack = await a.publish("room:1", "hello", { n: 1 });
    expect(ack.seq).toBe(1);
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ seq: 1, ev: "hello", data: { n: 1 } });
  });

  it("converges presence between two browsers and drops a member who leaves", async () => {
    const a = client("ada");
    const b = client("bob");
    a.subscribe("room:p", {});
    b.subscribe("room:p", {});
    await until(() => a.status === "open" && b.status === "open");
    a.setPresence("room:p", { name: "Ada", status: "typing" });
    b.setPresence("room:p", { name: "Bob" });
    const names = (c: HypoutClient): string[] => c.members("room:p").flatMap((m) => (typeof m.state["name"] === "string" ? [m.state["name"]] : [])).sort();
    await until(() => names(a).length === 2 && names(b).length === 2);
    expect(names(a)).toEqual(["Ada", "Bob"]);
    expect(names(b)).toEqual(["Ada", "Bob"]);
    b.close();
    await until(() => a.members("room:p").length === 1);
    expect(names(a)).toEqual(["Ada"]);
  });

  it("recovers events the network dropped, in order, with no duplicates", async () => {
    const pub = client("ada");
    const sub = client("bob");
    const seen: number[] = [];
    sub.subscribe("room:chaos", { onEvent: (e) => seen.push(e.seq) });
    await until(() => sub.status === "open" && pub.status === "open");
    await new Promise((r) => setTimeout(r, 80));
    await pub.publish("room:chaos", "n", 1);
    await until(() => seen.length === 1);
    server.chaos.set({ dropRate: 1 });
    await pub.publish("room:chaos", "n", 2);
    await pub.publish("room:chaos", "n", 3);
    server.chaos.reset();
    await pub.publish("room:chaos", "n", 4);
    await until(() => seen.length === 4);
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("resumes after the server kills the connection, replaying what it missed", async () => {
    const pub = client("ada");
    const sub = client("bob");
    const seen: number[] = [];
    sub.subscribe("room:resume", { onEvent: (e) => seen.push(e.seq) });
    await until(() => sub.status === "open" && pub.status === "open");
    await new Promise((r) => setTimeout(r, 80));
    await pub.publish("room:resume", "n", 1);
    await until(() => seen.length === 1);
    const resumed = new Promise<void>((resolve) => {
      const off = sub.onStatus((s) => {
        if (s === "open") {
          off();
          resolve();
        }
      });
    });
    // A network failure: every socket is cut. Both clients reconnect on their own; the subscriber must end up with each event exactly once.
    expect(server.severAll()).toBeGreaterThanOrEqual(2);
    await resumed;
    await until(() => pub.status === "open");
    await pub.publish("room:resume", "n", 2);
    await until(() => seen.includes(2), 6000);
    expect(seen).toEqual([1, 2]);
  });

  it("surfaces HP-104 for an anonymous publish", async () => {
    const anon = new HypoutClient({ url: ws, reconnect: false });
    clients.push(anon);
    await until(() => anon.status === "open");
    await expect(anon.publish("room:x", "e", 1)).rejects.toMatchObject({ code: "HP-104" });
  });
});
