// packages/primitives/src/factory.ts

import { Context } from "effect";
import { DurableObject } from "cloudflare:workers";
import { DurablePrimitivesEngine, type PrimitivesEngineConfig } from "./engine";
import {
  createPrimitiveRegistry,
  type AnyUnregisteredDefinition,
  type PrimitiveRegistry,
  type UnregisteredContinuousDefinition,
  type UnregisteredBufferDefinition,
  type UnregisteredQueueDefinition,
  type ContinuousDefinition,
  type BufferDefinition,
  type QueueDefinition,
} from "./registry";
import {
  createPrimitivesClient,
  type PrimitivesClient,
  type PrimitivesClientFactory,
} from "./client";

/**
 * Result of creating durable primitives.
 */
export interface CreateDurablePrimitivesResult<
  T extends Record<string, AnyUnregisteredDefinition>,
> {
  /**
   * The Durable Object class to export for Cloudflare.
   *
   * @example
   * ```ts
   * // Export in worker entry point
   * export { Primitives };
   * ```
   */
  readonly Primitives: typeof DurablePrimitivesEngine;

  /**
   * Factory for creating typed clients.
   *
   * @example
   * ```ts
   * const client = PrimitivesClient.fromBinding(env.PRIMITIVES);
   * await client.continuous("tokenRefresher").start({ id: "user-123", input: {...} });
   * ```
   */
  readonly PrimitivesClient: PrimitivesClientFactory<
    InferRegistryFromDefinitions<T>
  >;

  /**
   * The primitive registry (for advanced use cases).
   */
  readonly registry: PrimitiveRegistry;
}

/**
 * Type helper to infer a typed registry from definitions object.
 * Preserves the literal keys for autocomplete support.
 */
export type InferRegistryFromDefinitions<
  T extends Record<string, AnyUnregisteredDefinition>,
> = {
  readonly continuous: Map<
    Extract<
      { [K in keyof T]: T[K] extends UnregisteredContinuousDefinition<any, any, any> ? K : never }[keyof T],
      string
    >,
    ContinuousDefinition<any, any, any>
  >;
  readonly buffer: Map<
    Extract<
      { [K in keyof T]: T[K] extends UnregisteredBufferDefinition<any, any, any, any> ? K : never }[keyof T],
      string
    >,
    BufferDefinition<any, any, any, any>
  >;
  readonly queue: Map<
    Extract<
      { [K in keyof T]: T[K] extends UnregisteredQueueDefinition<any, any, any> ? K : never }[keyof T],
      string
    >,
    QueueDefinition<any, any, any>
  >;
  /** Original definitions object for type inference */
  readonly __definitions: T;
};

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a Durable Primitives engine for a set of primitives.
 *
 * This is the main factory function for creating production primitives engines.
 * It returns:
 * - `Primitives`: The Durable Object class to export
 * - `PrimitivesClient`: Factory for creating typed clients
 * - `registry`: The primitive registry (for advanced use cases)
 *
 * @param definitions - Object of primitive definitions (keys become primitive names)
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { createDurablePrimitives, Continuous, Buffer, Queue } from "@durable-effect/primitives";
 *
 * // Define primitives
 * const tokenRefresher = Continuous.make({
 *   stateSchema: Schema.Struct({
 *     accessToken: Schema.String,
 *     refreshToken: Schema.String,
 *     expiresAt: Schema.Number,
 *   }),
 *   schedule: Continuous.every("30 minutes"),
 *   execute: (ctx) => Effect.gen(function* () {
 *     // Refresh token logic
 *     ctx.setState({ ...ctx.state, accessToken: "new_token" });
 *   }),
 * });
 *
 * // Create engine and client - keys become primitive names
 * const { Primitives, PrimitivesClient } = createDurablePrimitives({
 *   tokenRefresher,
 * });
 *
 * // Export for Cloudflare
 * export { Primitives };
 *
 * // Use client in worker
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     const client = PrimitivesClient.fromBinding(env.PRIMITIVES);
 *
 *     // Start continuous primitive - name comes from object key
 *     yield* client.continuous("tokenRefresher").start({
 *       id: "user-123",
 *       input: { accessToken: "", refreshToken: "rt_abc", expiresAt: 0 },
 *     });
 *
 *     return new Response("OK");
 *   },
 * };
 * ```
 */
export function createDurablePrimitives<
  const T extends Record<string, AnyUnregisteredDefinition>,
>(
  definitions: T
): CreateDurablePrimitivesResult<T> {
  // Create registry from definitions
  const registry = createPrimitiveRegistry(definitions);

  // Create bound DO class with registry and config injected
  class BoundPrimitivesEngine extends DurablePrimitivesEngine {
    constructor(state: DurableObjectState, env: unknown) {
      // Inject registry and tracker config into environment
      const enrichedEnv: PrimitivesEngineConfig = {
        ...(env as object),
        __PRIMITIVE_REGISTRY__: registry,
      };

      super(state, enrichedEnv);
    }
  }

  // Create Effect Tag for the client
  const ClientTag = Context.GenericTag<
    PrimitivesClient<InferRegistryFromDefinitions<T>>
  >("@durable-effect/primitives/Client");

  // Create client factory
  // Cast the registry to include the type-level __definitions property
  const typedRegistry = registry as unknown as InferRegistryFromDefinitions<T>;

  const PrimitivesClientFactory: PrimitivesClientFactory<
    InferRegistryFromDefinitions<T>
  > = {
    fromBinding: (binding: DurableObjectNamespace) =>
      createPrimitivesClient(binding, typedRegistry),
    Tag: ClientTag,
  };

  return {
    Primitives: BoundPrimitivesEngine as typeof DurablePrimitivesEngine,
    PrimitivesClient: PrimitivesClientFactory,
    registry,
  };
}
