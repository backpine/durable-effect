import { Context } from "effect"

// ---------------------------------------------------------------------------
// CloudflareEnv — platform context service provided by the DO runtime.
// Stores the Cloudflare env bindings (KV, R2, Hyperdrive, secrets, etc.)
// that are available in the DO constructor but not at module scope.
//
// Typed as `unknown` internally. Users get type safety via the
// cloudflareServices<Env>() factory which casts to their wrangler-generated
// Env interface.
// ---------------------------------------------------------------------------

export class CloudflareEnv extends Context.Service<CloudflareEnv, unknown>()(
  "@durable-effect/CloudflareEnv",
) {}
