import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  test: {
    globals: true,
    server: { deps: { inline: ["@durable-effect/task"] } },
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The database-backed checks have their own config (`pnpm test:integration`).
    exclude: ["test/integration/**", "node_modules/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
})
