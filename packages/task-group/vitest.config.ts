import { defineConfig } from "vitest/config"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "cloudflare:workers": resolve(__dirname, "./test/__mocks__/cloudflare-workers.ts"),
    },
  },
})
