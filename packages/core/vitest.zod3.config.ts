import { defineConfig } from "vitest/config";

// The same tests, with `zod` resolved to Zod 3: the package supports ^3.23 and ^4 as a peer dependency.
export default defineConfig({
  resolve: { alias: { zod: "zod3" } },
  test: { include: ["test/units.test.ts", "test/broker.test.ts"], testTimeout: 30000 },
});
