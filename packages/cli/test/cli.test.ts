import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WsClient, verifyToken } from "@hypout/core";
import { main, type Io } from "../src";

let dir: string;
let out: string[];
let err: string[];
const io = (): Io => ({ out: (l) => out.push(l), err: (l) => err.push(l), cwd: dir });
const run = (...argv: string[]): Promise<number> => main(argv, io());

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hypout-cli-"));
  out = [];
  err = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("init and validate", () => {
  it("scaffolds a project that validates, and does not overwrite on a second run", async () => {
    expect(await run("init")).toBe(0);
    for (const f of ["hypout.config.json", "channels/chat.json", "channels/alerts.json", "channels/doc.json", ".gitignore"]) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".hypout/");
    writeFileSync(join(dir, "channels/chat.json"), "{}");
    out.length = 0;
    expect(await run("init")).toBe(0);
    expect(out.join("\n")).toContain("kept");
    expect(readFileSync(join(dir, "channels/chat.json"), "utf8")).toBe("{}");
    await run("init", "--force");
    expect(await run("validate")).toBe(0);
    expect(out.join("\n")).toMatch(/3 namespaces valid/);
  });
  it("reports a broken channel file with its path and exits 1", async () => {
    await run("init");
    writeFileSync(join(dir, "channels/chat.json"), JSON.stringify({ namespace: "Chat!" }));
    out.length = 0;
    expect(await run("validate")).toBe(1);
    expect(err.join("\n")).toMatch(/chat\.json.*namespace/);
    writeFileSync(join(dir, "channels/chat.json"), "{oops");
    err.length = 0;
    expect(await run("validate", "--json")).toBe(1);
    expect(JSON.parse(out.at(-1) as string).errors[0]).toContain("chat.json");
  });
  it("catches duplicate namespaces and bad schema patterns", async () => {
    await run("init");
    writeFileSync(join(dir, "channels/dup.json"), JSON.stringify({ namespace: "chat" }));
    expect(await run("validate")).toBe(1);
    expect(err.join("\n")).toContain("defined twice");
    rmSync(join(dir, "channels/dup.json"));
    writeFileSync(join(dir, "channels/bad.json"), JSON.stringify({ namespace: "bad", events: { e: { type: "string", pattern: "(" } } }));
    err.length = 0;
    expect(await run("validate")).toBe(1);
    expect(err.join("\n")).toContain('event "e"');
  });
  it("warns about open publishing and undeclared events", async () => {
    await run("init");
    writeFileSync(join(dir, "channels/open.json"), JSON.stringify({ namespace: "open", access: { publish: "public" } }));
    out.length = 0;
    expect(await run("validate")).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("anyone can publish");
    expect(text).toContain("no events declared");
  });
});

describe("small commands", () => {
  it("prints help and the version, and rejects unknown commands with exit 2", async () => {
    expect(await run("--help")).toBe(0);
    expect(out.join("\n")).toContain("Usage: hypout");
    out.length = 0;
    expect(await run("--version")).toBe(0);
    expect(out[0]).toMatch(/^\d+\.\d+\.\d+/);
    expect(await run("frobnicate")).toBe(2);
    expect(err.join("\n")).toContain("unknown command");
  });
  it("mints a token that verifies against the project secret", async () => {
    await run("init");
    expect(await run("token", "mint", "--sub", "ada", "--caps", "chat:*=sub,pub", "--ttl", "120")).toBe(0);
    const secret = readFileSync(join(dir, ".hypout/secret"), "utf8").trim();
    const r = verifyToken(secret, out.at(-1) as string);
    expect(r).toMatchObject({ ok: true, claims: { sub: "ada" } });
    expect(await run("token", "mint")).toBe(2);
    expect(await run("token", "mint", "--sub", "a", "--caps", "nonsense")).toBe(2);
  });
  it("explains a frame given as hex", async () => {
    expect(await run("inspect", "81 05 68 65 6c 6c 6f")).toBe(0);
    expect(out.join("\n")).toMatch(/FIN/);
    expect(await run("inspect", "zz")).toBe(2);
  });
  it("verifies a missing ledger as empty and flags a corrupt one", async () => {
    expect(await run("ledger", "verify")).toBe(0);
    writeFileSync(join(dir, "bad.jsonl"), "garbage\n");
    expect(await run("ledger", "verify", join(dir, "bad.jsonl"))).toBe(1);
    expect(err.join("\n")).toContain("BROKEN at entry 1");
  });
});

describe("studio + publish end to end", () => {
  it("starts from a scaffolded project, accepts a published event over WebSocket, and shuts down", async () => {
    await run("init");
    const abort = new AbortController();
    const running = main(["studio", "--port", "0", "--quiet"], io(), abort.signal);
    let line: string | undefined;
    for (let i = 0; i < 100 && !(line = out.find((l) => l.includes("WebSocket"))); i++) await new Promise((r) => setTimeout(r, 30));
    expect(line, "server never announced itself").toBeDefined();
    const port = Number(/:(\d+)\/ws/.exec(line as string)?.[1]);
    const c = await WsClient.connect(`ws://127.0.0.1:${port}/ws`);
    c.sendText(JSON.stringify({ t: "sub", ch: "alerts" }));
    expect(await publishVia(port)).toBe(0);
    let got = false;
    for (let i = 0; i < 10 && !got; i++) got = ((await c.nextJson<{ t: string; data?: { message: string } }>()).data?.message ?? "") === "disk full";
    expect(got).toBe(true);
    c.destroy();
    abort.abort();
    expect(await running).toBe(0);
    expect(await run("ledger", "verify")).toBe(0);
    expect(out.at(-1)).toMatch(/1 entry/);
  });
  it("fails clearly when no server is listening, and on invalid JSON", async () => {
    await run("init");
    expect(await run("publish", "alerts", "notice", '{"level":"info","message":"x"}', "--url", "http://127.0.0.1:9")).toBe(1);
    expect(err.join("\n")).toContain("could not reach");
    expect(await run("publish", "alerts", "notice", "{bad")).toBe(2);
    expect(await run("publish", "alerts")).toBe(2);
  });
});

async function publishVia(port: number): Promise<number> {
  return run("publish", "alerts", "notice", '{"level":"warn","message":"disk full"}', "--port", String(port));
}
