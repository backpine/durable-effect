import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

// The database-backed checks: `test/integration/**`. They need the Docker
// Postgres (`node scripts/postgres.mjs up`), and the `worker` file also needs a
// running Worker (`LEDGER_API_URL`). `pnpm test:db` sets all of it up.
export default defineConfig({
  test: {
    globals: true,
    server: { deps: { inline: ["@durable-effect/task"] } },
    environment: "node",
    include: ["test/integration/**/*.int.test.ts"],
    // One Postgres, watched by connection count: never two files at once.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
})
