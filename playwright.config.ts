import { defineConfig, devices } from "@playwright/test";

export const E2E_PORT = 4377;
export const E2E_SECRET = "e2e-secret-0123456789abcdef";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  // The real CLI, serving the real Studio, against the example project: nothing mocked.
  webServer: {
    command: `node ../../packages/cli/dist/bin.js studio --port ${E2E_PORT} --no-ledger --quiet`,
    cwd: "examples/basic",
    env: { HYPOUT_SECRET: E2E_SECRET },
    url: `http://127.0.0.1:${E2E_PORT}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: { baseURL: `http://127.0.0.1:${E2E_PORT}`, ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", screenshot: "only-on-failure" },
});
