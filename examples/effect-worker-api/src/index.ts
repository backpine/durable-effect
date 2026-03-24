import { pipe, ServiceMap } from "effect"
import { handler } from "@/runtime"
import { currentEnv, currentCtx } from "@/services/cloudflare"

// Export Durable Object classes for wrangler
export { TasksDO } from "./tasks/counter.js"
export { BillingDO } from "./tasks/billing/index.js"

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const services = pipe(
      ServiceMap.make(currentEnv, env),
      ServiceMap.add(currentCtx, ctx),
    )
    return handler(request, services)
  },
} satisfies ExportedHandler<Env>
