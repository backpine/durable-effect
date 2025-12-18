import { Context, Effect, ManagedRuntime } from "effect";
import { handleRequest } from "./handler";
import { AppLayer } from "./app";
import { CloudflareEnv, CloudflareCtx } from "./services";

// Export the Jobs Durable Object class for Cloudflare
export { Jobs } from "./jobs";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Module-Level Runtime (built ONCE per isolate)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Singleton managed runtime.
 *
 * Built once when the worker isolate initializes.
 * Contains all application services (Database, Config, KV, Storage).
 *
 * Database connection is established at this point using module-level env.
 * Other services are built but will access CloudflareEnv at method call time.
 */
const runtime = ManagedRuntime.make(AppLayer);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Worker Export
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Cloudflare Worker Entry Point
 *
 * Following the effect-cloudflare pattern:
 * - Runtime is built ONCE at module level (contains Database, Config, KV, Storage)
 * - Request-scoped data (env, ctx) is provided as Context per-request
 * - Providing Context is O(1) - just adds to the context map
 * - No layer rebuilding per request!
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Create Context (NOT Layer!) for request-scoped data
    // This is O(1) - just adds service instances to the context map
    const requestContext = Context.make(CloudflareEnv, { env }).pipe(
      Context.add(CloudflareCtx, { ctx }),
    );

    const effect = handleRequest(request).pipe(
      Effect.provide(requestContext),
    );

    return runtime.runPromise(effect);
  },
};
