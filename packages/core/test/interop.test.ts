import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloseCode, WsClient, encodeClose, encodeFrame, encodeText, Opcode, FrameDecoder } from "../src";
import { startEchoServer, type EchoServer } from "./helpers";

let server: EchoServer;
beforeAll(async () => {
  server = await startEchoServer({ maxPayload: 100_000 });
});
afterAll(async () => {
  await server.close();
});

describe("server and Hypout's own client over a real socket", () => {
  it("echoes text, binary, large and empty messages", async () => {
    const c = await WsClient.connect(server.url, { protocols: ["hypout.v1"] });
    expect(c.protocol).toBe("hypout.v1");
    c.sendText("héllo 🌱");
    expect(await c.next()).toEqual({ binary: false, text: "héllo 🌱" });
    c.sendBinary(Uint8Array.of(0, 1, 2, 254, 255));
    expect(await c.next()).toEqual({ binary: true, data: Uint8Array.of(0, 1, 2, 254, 255) });
    const big = "x".repeat(70_000);
    c.sendText(big);
    expect((await c.next(8000) as { text: string }).text.length).toBe(70_000);
    c.sendText("");
    expect(await c.next()).toEqual({ binary: false, text: "" });
    c.close();
    expect(await c.closed).toMatchObject({ code: 1000, clean: true });
  });
  it("answers a ping with a pong carrying the same payload", async () => {
    const c = await WsClient.connect(server.url);
    const pong = new Promise<Uint8Array>((resolve) => {
      c.onPong = resolve;
    });
    c.ping("are you there");
    expect(new TextDecoder().decode(await pong)).toBe("are you there");
    c.close();
    await c.closed;
  });
  it("closes with 1009 when a frame is larger than the limit", async () => {
    const c = await WsClient.connect(server.url);
    c.sendBinary(new Uint8Array(200_000));
    const info = await c.closed;
    expect(info.code).toBe(CloseCode.MessageTooBig);
  });
  it("closes with 1002 when a client sends an unmasked frame", async () => {
    const c = await WsClient.connect(server.url);
    c.sendRaw(encodeText("not masked"));
    expect((await c.closed).code).toBe(CloseCode.ProtocolError);
  });
  it("closes with 1007 on invalid UTF-8 in a text message", async () => {
    const c = await WsClient.connect(server.url);
    c.sendRaw(encodeFrame({ opcode: Opcode.Text, payload: Uint8Array.of(0xc3, 0x28), mask: true }));
    expect((await c.closed).code).toBe(CloseCode.InvalidPayload);
  });
  it("handles a fragmented message with a ping in the middle", async () => {
    const c = await WsClient.connect(server.url);
    c.sendRaw(encodeFrame({ opcode: Opcode.Text, payload: "Hel", fin: false, mask: true }));
    c.sendRaw(encodeFrame({ opcode: Opcode.Ping, payload: "mid", mask: true }));
    c.sendRaw(encodeFrame({ opcode: Opcode.Continuation, payload: "lo", mask: true }));
    expect(await c.next()).toEqual({ binary: false, text: "Hello" });
    c.close();
    await c.closed;
  });
  it("completes the closing handshake started by either side and echoes the code", async () => {
    const c = await WsClient.connect(server.url);
    c.close(4001, "custom");
    const info = await c.closed;
    expect(info.code).toBe(4001);
    expect(info.clean).toBe(true);
  });
  it("copes with a client that vanishes without closing", async () => {
    await new Promise((r) => setTimeout(r, 150)); // let sockets from earlier tests finish closing
    const before = server.sockets.size;
    const c = await WsClient.connect(server.url);
    expect(server.sockets.size).toBe(before + 1);
    c.destroy();
    await c.closed;
    // The server must notice the dropped connection and release the socket (poll: it is asynchronous).
    for (let i = 0; i < 40 && server.sockets.size > before; i++) await new Promise((r) => setTimeout(r, 25));
    expect(server.sockets.size).toBe(before);
  });
});

describe("raw bytes, with no client library at all", () => {
  it("speaks the protocol to a plain TCP socket", async () => {
    const socket = connect({ host: "127.0.0.1", port: server.port });
    const chunks: Buffer[] = [];
    socket.on("data", (d: Buffer) => chunks.push(d));
    await new Promise((r) => socket.once("connect", r));
    socket.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    await new Promise((r) => setTimeout(r, 100));
    const head = Buffer.concat(chunks).toString("latin1");
    expect(head.startsWith("HTTP/1.1 101 Switching Protocols\r\n")).toBe(true);
    expect(head).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    chunks.length = 0;
    socket.write(Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58])); // masked "Hello" from RFC 6455
    await new Promise((r) => setTimeout(r, 100));
    expect([...Buffer.concat(chunks)]).toEqual([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    socket.write(encodeClose(1000, "", true));
    await new Promise((r) => setTimeout(r, 100));
    const closeFrames = new FrameDecoder({ forbidMask: true }).push(Buffer.concat(chunks).subarray(7));
    expect(closeFrames[0]).toMatchObject({ kind: "close", code: 1000 });
    socket.destroy();
  });
  it("answers a malformed handshake with plain HTTP", async () => {
    const socket = connect({ host: "127.0.0.1", port: server.port });
    const chunks: Buffer[] = [];
    socket.on("data", (d: Buffer) => chunks.push(d));
    await new Promise((r) => socket.once("connect", r));
    socket.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: short\r\nSec-WebSocket-Version: 13\r\n\r\n");
    await new Promise((r) => setTimeout(r, 100));
    expect(Buffer.concat(chunks).toString().startsWith("HTTP/1.1 400 Bad Request")).toBe(true);
    socket.destroy();
  });
});

// An independent implementation: the WebSocket client built into Node (undici). Present from Node 22.
describe.skipIf(typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined")("an independent client (Node's built-in WebSocket)", () => {
  it("talks to the server both ways, with text, binary and a large message", async () => {
    const WS = (globalThis as unknown as { WebSocket: new (url: string) => WebSocket }).WebSocket;
    const ws = new WS(server.url);
    ws.binaryType = "arraybuffer";
    const inbox: Array<string | ArrayBuffer> = [];
    ws.onmessage = (e) => inbox.push(e.data as string | ArrayBuffer);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("could not connect"));
    });
    ws.send("from undici 🌱");
    ws.send(Uint8Array.of(9, 8, 7));
    ws.send("y".repeat(60_000));
    for (let i = 0; i < 50 && inbox.length < 3; i++) await new Promise((r) => setTimeout(r, 40));
    expect(inbox[0]).toBe("from undici 🌱");
    expect([...new Uint8Array(inbox[1] as ArrayBuffer)]).toEqual([9, 8, 7]);
    expect((inbox[2] as string).length).toBe(60_000);
    const closed = new Promise<CloseEvent>((resolve) => {
      ws.onclose = resolve;
    });
    ws.close(1000, "done");
    expect((await closed).code).toBe(1000);
  });
});
