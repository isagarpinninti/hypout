// Fan-out benchmark over real sockets plus a codec micro-benchmark. Budgets are generous on purpose: they catch a
// 10x regression, not noise. Set HYPOUT_PERF_BUDGET_MS to loosen the fan-out budget on a slow machine.
import { performance } from "node:perf_hooks";
import { FrameDecoder, encodeText, WsClient, mintToken, parseCapabilities } from "../packages/core/dist/index.js";
import { createHypoutServer } from "../packages/cli/dist/index.js";

const BUDGET_MS = Number(process.env.HYPOUT_PERF_BUDGET_MS ?? 10_000);
const SUBSCRIBERS = Number(process.env.HYPOUT_BENCH_SUBS ?? 100);
const MESSAGES = Number(process.env.HYPOUT_BENCH_MSGS ?? 2000);
const SECRET = "bench-secret-0123456789abcdef";
let failed = false;
const report = (name, value, unit, budget) => {
  const ok = budget === undefined || value <= budget;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(34)} ${value.toFixed(1).padStart(10)} ${unit}${budget !== undefined ? `  (budget ${budget})` : ""}`);
};

// 1. codec: encode and decode masked text frames of 256 bytes.
{
  const body = "x".repeat(256);
  const N = 200_000;
  const frames = [];
  for (let i = 0; i < 1000; i++) frames.push(encodeText(body, true));
  const t0 = performance.now();
  for (let i = 0; i < N; i++) encodeText(body, true);
  const enc = performance.now() - t0;
  report("encode 256 B masked frames", N / (enc / 1000) / 1000, "k frames/s");
  const dec = new FrameDecoder({ requireMask: true, maxPayload: 1024 });
  const blob = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    blob.set(f, at);
    at += f.length;
  }
  const t1 = performance.now();
  let count = 0;
  for (let r = 0; r < N / 1000; r++) count += dec.push(blob).length;
  report("decode 256 B masked frames", count / ((performance.now() - t1) / 1000) / 1000, "k frames/s");
}

// 2. fan-out: one publisher, many subscribers, every delivery timed.
{
  const server = createHypoutServer({ secret: SECRET, port: 0, channels: [{ namespace: "bench", access: { subscribe: "public", publish: "token" }, retention: { events: 1000 }, rateLimit: { capacity: 10000, refillPerSecond: 10000 } }] });
  const { port } = await server.listen();
  const url = `ws://127.0.0.1:${port}/ws`;
  const token = mintToken(SECRET, { sub: "bench", caps: parseCapabilities("bench=sub,pub"), ttlSeconds: 600 });
  const lat = [];
  let delivered = 0;
  const expected = SUBSCRIBERS * MESSAGES;
  let done;
  const finished = new Promise((r) => (done = r));
  const clients = [];
  for (let i = 0; i < SUBSCRIBERS; i++) {
    const c = await WsClient.connect(`${url}?token=${token}`);
    c.onMessage = (m) => {
      if (m.binary) return;
      const msg = JSON.parse(m.text);
      if (msg.t !== "event") return;
      lat.push(performance.timeOrigin + performance.now() - msg.data.t);
      if (++delivered === expected) done();
    };
    c.sendText(JSON.stringify({ t: "sub", ch: "bench" }));
    clients.push(c);
  }
  await new Promise((r) => setTimeout(r, 500));
  const start = performance.now();
  for (let i = 0; i < MESSAGES; i++) {
    server.broker.publish("bench", "tick", { t: performance.timeOrigin + performance.now(), i });
    if (i % 50 === 49) await new Promise((r) => setImmediate(r));
  }
  const timeout = setTimeout(() => done(), BUDGET_MS * 2);
  await finished;
  clearTimeout(timeout);
  const ms = performance.now() - start;
  lat.sort((a, b) => a - b);
  console.log(`\n${SUBSCRIBERS} subscribers x ${MESSAGES} messages = ${expected.toLocaleString()} deliveries`);
  report("all deliveries completed", delivered === expected ? 1 : 0, "(1 = yes)");
  if (delivered !== expected) failed = true;
  report("fan-out wall time", ms, "ms", BUDGET_MS);
  report("throughput", delivered / (ms / 1000) / 1000, "k deliveries/s");
  report("latency p50", lat[Math.floor(lat.length * 0.5)] ?? 0, "ms");
  report("latency p99", lat[Math.floor(lat.length * 0.99)] ?? 0, "ms");
  report("heap used", process.memoryUsage().heapUsed / 1048576, "MiB");
  for (const c of clients) c.destroy();
  await server.close();
}
process.exit(failed ? 1 : 0);
