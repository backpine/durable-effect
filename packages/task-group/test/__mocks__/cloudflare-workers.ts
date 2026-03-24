// Mock for cloudflare:workers — used by vitest to test the CF adapter
// without needing the actual CF runtime.
export class DurableObject {
  protected ctx: unknown
  protected env: unknown
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx
    this.env = env
  }
}
