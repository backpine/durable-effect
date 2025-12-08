/// <reference path="../worker-configuration.d.ts" />

import { Context, Effect, Layer } from "effect";
import type { Context as HonoContext } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// =============================================================================
// Effect Services for Dependency Injection
// =============================================================================

/**
 * Service providing access to Cloudflare Worker environment bindings
 */
export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
  CloudflareEnv,
  Env
>() {}

/**
 * Service providing access to Hono's request context
 */
export class HonoCtx extends Context.Tag("HonoCtx")<
  HonoCtx,
  HonoContext<{ Bindings: Env }>
>() {}

// =============================================================================
// Type Aliases for Convenience
// =============================================================================

/**
 * Standard dependencies for route handlers
 */
export type RouteDeps = CloudflareEnv | HonoCtx;

/**
 * Type for route handler effects - E defaults to unknown to allow any error type
 */
export type RouteEffect<T, E = unknown> = Effect.Effect<T, E, RouteDeps>;

// =============================================================================
// Adapter Functions
// =============================================================================

/**
 * Wraps an Effect-returning function as a Hono handler.
 * Provides CloudflareEnv and HonoCtx services to the Effect.
 * Errors are caught and returned as 500 JSON responses.
 *
 * @example
 * ```ts
 * const getHealth = Effect.gen(function* () {
 *   const ctx = yield* HonoCtx;
 *   return ctx.text("OK");
 * });
 *
 * app.get("/health", effectHandler(getHealth));
 * ```
 */
export const effectHandler = <T, E>(
  effect: Effect.Effect<T, E, RouteDeps>,
) => {
  return async (c: HonoContext<{ Bindings: Env }>): Promise<Response> => {
    const layer = Layer.mergeAll(
      Layer.succeed(CloudflareEnv, c.env),
      Layer.succeed(HonoCtx, c),
    );

    const program = effect.pipe(
      Effect.catchAll((error) => {
        console.error("Effect handler error:", error);
        return Effect.succeed(c.json({ error: "Internal Server Error" }, 500));
      }),
      Effect.provide(layer),
    );

    return Effect.runPromise(program) as Promise<Response>;
  };
};

/**
 * Creates an Effect handler that catches errors and returns a JSON error response.
 * Useful for handlers that may fail with typed errors.
 */
export const effectHandlerWithErrors = <T, E>(
  effect: Effect.Effect<T, E, RouteDeps>,
  mapError?: (error: E) => { message: string; status: ContentfulStatusCode },
) => {
  return async (c: HonoContext<{ Bindings: Env }>): Promise<Response> => {
    const layer = Layer.mergeAll(
      Layer.succeed(CloudflareEnv, c.env),
      Layer.succeed(HonoCtx, c),
    );

    const program = effect.pipe(
      Effect.map((result) => c.json(result) as Response),
      Effect.catchAll((error) => {
        const mapped = mapError?.(error) ?? {
          message: "Internal Server Error",
          status: 500 as ContentfulStatusCode,
        };
        return Effect.succeed(
          c.json({ error: mapped.message }, mapped.status) as Response,
        );
      }),
      Effect.provide(layer),
    );

    return Effect.runPromise(program);
  };
};
