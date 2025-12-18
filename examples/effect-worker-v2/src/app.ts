import { Layer } from "effect";
import {
  CloudflareEnv,
  CloudflareCtx,
  ConfigLive,
  KVLive,
  StorageLive,
  // DatabaseLive,
} from "@/services";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Application Layers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Core Application Layer (without Database)
 *
 * This layer composes core infrastructure services.
 * Services access CloudflareEnv at method CALL time, not construction time.
 *
 * Services included:
 * - Config
 * - KV (multi-binding)
 * - Storage (multi-binding)
 */
export const AppCoreLayer = Layer.mergeAll(ConfigLive, KVLive, StorageLive);

/**
 * Full Application Layer
 *
 * Composes all infrastructure services including Database.
 * Built ONCE at module level into ManagedRuntime.
 *
 * Database connection uses module-level `import { env } from "cloudflare:workers"`
 * to get DATABASE_URL at isolate startup time.
 *
 * Other services (Config, KV, Storage) access CloudflareEnv at method call time,
 * which is provided as Context per-request.
 *
 * @example
 * ```typescript
 * // In worker.ts
 * const runtime = ManagedRuntime.make(AppLayer)
 *
 * export default {
 *   async fetch(request, env, ctx) {
 *     const context = Context.make(CloudflareEnv, { env }).pipe(
 *       Context.add(CloudflareCtx, { ctx })
 *     )
 *     return runtime.runPromise(effect.pipe(Effect.provide(context)))
 *   }
 * }
 * ```
 */
export const AppLayer = Layer.mergeAll(
  ConfigLive,
  KVLive,
  StorageLive,
  // DatabaseLive,
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Type Exports
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Request-scoped context (CloudflareEnv + CloudflareCtx)
 *
 * This is provided as Context per-request via:
 * ```typescript
 * const context = Context.make(CloudflareEnv, { env }).pipe(
 *   Context.add(CloudflareCtx, { ctx })
 * )
 * ```
 */
export type RequestContext = CloudflareEnv | CloudflareCtx;

/**
 * Application Dependencies Type (Core)
 *
 * This type represents services available without Database.
 */
export type AppCoreDependencies = Layer.Layer.Success<typeof AppCoreLayer>;

/**
 * Application Dependencies Type (Full)
 *
 * This type represents all services including Database.
 */
export type AppDependencies = Layer.Layer.Success<typeof AppLayer>;
