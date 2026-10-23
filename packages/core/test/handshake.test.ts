import { describe, expect, it } from "vitest";
import { WEBSOCKET_GUID, buildClientRequest, buildUpgradeResponse, checkUpgrade, computeWebSocketAccept, handleUpgrade, hasToken, validateServerHandshake } from "../src/codec/handshake";

const goodHeaders = (): Record<string, string> => ({
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
});
const req = (headers: Record<string, string | string[] | undefined> = goodHeaders(), method = "GET") => ({ method, httpVersion: "1.1", headers });

class FakeSocket {
  written: string[] = [];
  ended = false;
  write(chunk: string | Uint8Array): boolean {
    this.written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1"));
    return true;
  }
  end(chunk?: string | Uint8Array): void {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
  }
}

describe("Sec-WebSocket-Accept", () => {
  it("matches the example in RFC 6455 section 1.3", () => {
    expect(computeWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
  it("uses the fixed GUID", () => {
    expect(WEBSOCKET_GUID).toBe("258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  });
});

describe("opening handshake", () => {
  it("accepts a valid request and writes the exact 101 response", () => {
    const socket = new FakeSocket();
    const result = handleUpgrade(req(), socket);
    expect(result.ok).toBe(true);
    expect(socket.written.join("")).toBe(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
    );
    expect(socket.ended).toBe(false);
  });
  it("accepts tokens in any case and a Connection list", () => {
    const h = { ...goodHeaders(), upgrade: "WebSocket", connection: "keep-alive, Upgrade" };
    expect(checkUpgrade(req(h)).ok).toBe(true);
    expect(hasToken("keep-alive, Upgrade", "upgrade")).toBe(true);
    expect(hasToken(undefined, "upgrade")).toBe(false);
  });
  it("negotiates the first subprotocol both sides support, and never an extension", () => {
    const socket = new FakeSocket();
    const h = { ...goodHeaders(), "sec-websocket-protocol": "chat, hypout.v1", "sec-websocket-extensions": "permessage-deflate" };
    const result = handleUpgrade(req(h), socket, { protocols: ["hypout.v1"] });
    expect(result).toMatchObject({ ok: true, protocol: "hypout.v1" });
    const text = socket.written.join("");
    expect(text).toContain("Sec-WebSocket-Protocol: hypout.v1");
    expect(text.toLowerCase()).not.toContain("sec-websocket-extensions");
  });
  it("rejects with the right HTTP status", () => {
    const cases: Array<[string, Record<string, string | undefined>, string, number]> = [
      ["wrong method", goodHeaders(), "POST", 405],
      ["no Upgrade", { ...goodHeaders(), upgrade: undefined as unknown as string }, "GET", 400],
      ["no Connection: Upgrade", { ...goodHeaders(), connection: "close" }, "GET", 400],
      ["no key", { ...goodHeaders(), "sec-websocket-key": undefined as unknown as string }, "GET", 400],
      ["short key", { ...goodHeaders(), "sec-websocket-key": "abc" }, "GET", 400],
      ["wrong version", { ...goodHeaders(), "sec-websocket-version": "8" }, "GET", 426],
    ];
    for (const [name, headers, method, status] of cases) {
      const socket = new FakeSocket();
      const result = handleUpgrade(req(headers, method), socket);
      expect(result.ok, name).toBe(false);
      expect(socket.written.join(""), name).toContain(`HTTP/1.1 ${status} `);
      expect(socket.ended, name).toBe(true);
    }
  });
  it("tells a client with the wrong version which one to use", () => {
    const socket = new FakeSocket();
    handleUpgrade(req({ ...goodHeaders(), "sec-websocket-version": "8" }), socket);
    expect(socket.written.join("")).toContain("Sec-WebSocket-Version: 13");
  });
});

describe("client side", () => {
  it("builds a request the server accepts", () => {
    const text = buildClientRequest({ host: "example.com:80", path: "/ws?x=1", key: "dGhlIHNhbXBsZSBub25jZQ==", protocols: ["hypout.v1"], origin: "https://app.example.com" });
    expect(text.startsWith("GET /ws?x=1 HTTP/1.1\r\nHost: example.com:80\r\n")).toBe(true);
    expect(text.endsWith("\r\n\r\n")).toBe(true);
  });
  it("validates a server reply", () => {
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    const ok = buildUpgradeResponse(computeWebSocketAccept(key)).trimEnd();
    expect(validateServerHandshake(ok, key)).toBeNull();
    expect(validateServerHandshake(ok.replace("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "wrong="), key)).toMatch(/does not match/);
    expect(validateServerHandshake("HTTP/1.1 200 OK\r\n", key)).toMatch(/not 101/);
  });
});
