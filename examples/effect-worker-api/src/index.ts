import { pipe, Context } from "effect"
import { handler } from "@/runtime"
import { currentEnv, currentCtx } from "@/services/cloudflare"

// Export Durable Object classes for wrangler
export { BillingDO } from "./tasks/billing/index.js"

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const services = pipe(
      Context.make(currentEnv, env),
      Context.add(currentCtx, ctx),
    )
    return handler(request, services)
  },
} satisfies ExportedHandler<Env>
