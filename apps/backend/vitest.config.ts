import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The protocol package is consumed from source (no build step), so tests need
// the same alias that tsconfig.base.json declares for the type checker.
export default defineConfig({
  resolve: {
    alias: {
      "@proof-explorer/protocol": fileURLToPath(
        new URL("../../packages/protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
