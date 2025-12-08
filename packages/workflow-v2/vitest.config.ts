import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Mock cloudflare:workers for testing
      "cloudflare:workers": path.resolve(__dirname, "./test/__mocks__/cloudflare-workers.ts"),
      "@durable-effect/core": path.resolve(__dirname, "../core/src"),
    },
  },
});
