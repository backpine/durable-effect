// Stub for `cloudflare:workers` so the CF adapter (imported transitively by
// tasks/billing/index.ts) loads under vitest/node. The in-memory runtime path
// under test never instantiates a DurableObject.
export class DurableObject {
  protected ctx: unknown
  protected env: unknown
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx
    this.env = env
  }
}
