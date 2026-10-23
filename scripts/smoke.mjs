// Packs the three packages, installs the tarballs into a clean project, and drives the installed CLI over a real socket.
// This is what proves the published files are complete: nothing here touches the source tree.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "hypout-smoke-"));
const PORT = 4391;
const ENV = { ...process.env, HYPOUT_SECRET: "smoke-secret-0123456789abc" };
let server;
process.on("exit", () => server?.kill("SIGKILL"));
let failed = false;
const step = (m) => console.log(`\n› ${m}`);
const check = (cond, msg) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`  ok  ${msg}`);
};
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

try {
  step("pack");
  const tarballs = {};
  for (const pkg of ["core", "react", "cli"]) {
    const dir = join(root, "packages", pkg);
    check(existsSync(join(dir, "dist")), `packages/${pkg}/dist is built`);
    const out = run("npm", ["pack", "--pack-destination", work, "--silent"], { cwd: dir }).trim().split("\n").at(-1);
    tarballs[pkg] = join(work, out);
  }
  check(existsSync(join(root, "packages/cli/studio/index.html")), "the Studio is bundled into the CLI package");

  step("install into a clean project");
  const proj = join(work, "project");
  run("mkdir", ["-p", proj]);
  // The packages depend on each other by version; the override makes npm use the local tarball instead of the registry.
  writeFileSync(
    join(proj, "package.json"),
    JSON.stringify({
      name: "smoke", private: true, type: "module",
      dependencies: { "@hypout/core": `file:${tarballs.core}`, "@hypout/cli": `file:${tarballs.cli}`, "@hypout/react": `file:${tarballs.react}`, zod: "^4", react: "^19", "react-dom": "^19" },
      overrides: { "@hypout/core": "$@hypout/core" },
    }),
  );
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: proj, timeout: 240_000 });
  const bin = join(proj, "node_modules/.bin/hypout");
  check(existsSync(bin), "the hypout binary is linked");
  check(/^\d+\.\d+\.\d+/.test(run(bin, ["--version"], { cwd: proj }).trim()), "hypout --version prints a version");

  step("init and validate");
  run(bin, ["init"], { cwd: proj });
  check(/3 namespaces valid/.test(run(bin, ["validate"], { cwd: proj })), "the scaffolded channels validate");

  step("start the server");
  // A leftover server from an aborted run would answer instead of ours; refuse to continue if the port is taken.
  check(!(await fetch(`http://127.0.0.1:${PORT}/health`).then(() => true, () => false)), `port ${PORT} is free`);
  server = spawn(bin, ["studio", "--port", String(PORT), "--quiet"], { cwd: proj, stdio: ["ignore", "pipe", "pipe"], env: ENV });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100 && !log.includes("Studio"); i++) await new Promise((r) => setTimeout(r, 100));
  check(log.includes(`127.0.0.1:${PORT}`), "the server announced itself");

  step("talk to it over a real WebSocket (Node's built-in client)");
  const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  check(health.ok === true, "/health answers");
  const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  check(html.includes("<html") && html.includes("Hypout"), "the Studio is served at /");
  const got = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, "hypout.v1");
    const timer = setTimeout(() => reject(new Error("no event received")), 8000);
    ws.onmessage = (m) => {
      try {
        handle(JSON.parse(String(m.data)));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    };
    const handle = (msg) => {
      if (msg.t === "welcome") ws.send(JSON.stringify({ t: "sub", ch: "alerts" }));
      if (msg.t === "sub.ok") {
        const out = run(bin, ["publish", "alerts", "notice", '{"level":"info","message":"smoke"}', "--port", String(PORT)], { cwd: proj, env: ENV });
        check(/published alerts #1/.test(out), `hypout publish reaches the server (got: ${out.trim()})`);
      }
      if (msg.t === "event") {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    };
    ws.onerror = () => reject(new Error("socket error"));
  });
  check(got.ch === "alerts" && got.data.message === "smoke", "the published event arrives over the socket");

  step("the installed React package loads");
  writeFileSync(join(proj, "check.mjs"), `import { HypoutClient, HypoutLogo } from "@hypout/react"; import { PresenceCRDT } from "@hypout/core/protocol"; import { encodeText } from "@hypout/core"; if (typeof HypoutClient !== "function" || typeof HypoutLogo !== "function" || typeof PresenceCRDT !== "function" || encodeText("x").length !== 3) process.exit(1); console.log("loaded");`);
  check(run("node", ["check.mjs"], { cwd: proj }).trim() === "loaded", "@hypout/react and @hypout/core import cleanly");
  let nodeFiles = [];
  try {
    nodeFiles = run("grep", ["-rlE", "(from|require\\()\\s*[\"']node:", join(proj, "node_modules/@hypout/react/dist")]).trim().split("\n").filter((f) => !f.endsWith(".map") && f.length);
  } catch {
    /* grep exits 1 when nothing matches, which is what we want */
  }
  check(nodeFiles.length === 0, "the React bundle has no node: imports");
  console.log("\nSmoke test passed.");
} catch (e) {
  failed = true;
  console.error(`\n${e instanceof Error ? e.message : e}`);
} finally {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
