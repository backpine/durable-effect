// Type declaration for cloudflare:workers — allows tsc to compile
// the CF adapter without @cloudflare/workers-types installed.
// At runtime, Cloudflare's bundler resolves this module natively.
// In tests, vitest aliases it to test/__mocks__/cloudflare-workers.ts.

declare module "cloudflare:workers" {
  export class DurableObject {
    protected ctx: unknown
    protected env: unknown
    constructor(ctx: unknown, env: unknown)
  }
}
