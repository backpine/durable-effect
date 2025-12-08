// @ts-nocheck
import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Mock cloudflare:workers for testing
      "cloudflare:workers": resolve(__dirname, "./test/__mocks__/cloudflare-workers.ts"),
      "@durable-effect/core": resolve(__dirname, "../core/src"),
    },
  },
});
