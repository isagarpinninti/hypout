import { defineConfig } from "tsup";

export default defineConfig({
  // `protocol` is the browser-safe subset (frames, messages, presence CRDT, schemas); `index` adds the Node parts.
  entry: { index: "src/index.ts", protocol: "src/protocol.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  external: ["zod"],
});
