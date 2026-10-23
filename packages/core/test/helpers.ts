import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { CloseCode, FrameDecoder, ProtocolError, encodeBinary, encodeClose, encodePong, encodeText, handleUpgrade } from "../src";

export interface EchoServer {
  port: number;
  url: string;
  close: () => Promise<void>;
  sockets: Set<Socket>;
}

/**
 * A server that completes the handshake with Hypout's own code and echoes every message, answers pings, and
 * runs the closing handshake. It is the "other end" for interop tests.
 */
export async function startEchoServer(opts: { maxPayload?: number } = {}): Promise<EchoServer> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((_req, res) => res.writeHead(426).end("upgrade required"));
  server.on("upgrade", (req, socket: Socket, head) => {
    const result = handleUpgrade(req, socket, { protocols: ["hypout.v1"] });
    if (!result.ok) return;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    // http.Server sockets are half-open: without this, a client that disappears leaves the socket open forever.
    socket.on("end", () => socket.end());
    const decoder = new FrameDecoder({ requireMask: true, maxPayload: opts.maxPayload ?? 1024 * 1024, maxMessage: (opts.maxPayload ?? 1024 * 1024) * 4 });
    const onData = (chunk: Uint8Array): void => {
      try {
        for (const item of decoder.push(chunk)) {
          if (item.kind === "message") socket.write(item.opcode === 1 ? encodeText(item.text ?? "") : encodeBinary(item.data ?? new Uint8Array()));
          else if (item.kind === "ping") socket.write(encodePong(item.payload));
          else if (item.kind === "close") {
            socket.end(encodeClose(item.code ?? CloseCode.Normal));
          }
        }
      } catch (e) {
        socket.end(encodeClose(e instanceof ProtocolError ? e.code : CloseCode.ProtocolError, e instanceof Error ? e.message.slice(0, 100) : ""));
      }
    };
    if (head.length > 0) onData(head);
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `ws://127.0.0.1:${port}/`,
    sockets,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
