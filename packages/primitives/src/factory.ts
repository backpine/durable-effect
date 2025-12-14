// packages/primitives/src/factory.ts

import { Context } from "effect";
import { DurableObject } from "cloudflare:workers";
import {
  DurablePrimitivesEngine,
  type PrimitivesEngineConfig,
  type TrackerConfig,
} from "./engine";
import {
  createPrimitiveRegistry,
  type AnyPrimitiveDefinition,
  type PrimitiveRegistry,
  type ContinuousDefinition,
  type BufferDefinition,
  type QueueDefinition,
} from "./registry";
import {
  createPrimitivesClient,
  type PrimitivesClient,
  type PrimitivesClientFactory,
} from "./client";

// =============================================================================
// Factory Options
// =============================================================================

/**
 * Options for creating durable primitives.
 */
export interface CreateDurablePrimitivesOptions<
  T extends Record<string, AnyPrimitiveDefinition>,
> {
  /**
   * The primitive definitions to register.
   *
   * Keys become the primitive names used for lookup.
   */
  readonly primitives: T;

  /**
   * Optional tracking configuration.
   */
  readonly tracking?: {
    readonly enabled: boolean;
    readonly endpoint?: string;
    readonly env?: string;
    readonly serviceKey?: string;
  };
}

/**
 * Result of creating durable primitives.
 */
export interface CreateDurablePrimitivesResult<
  T extends Record<string, AnyPrimitiveDefinition>,
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
  T extends Record<string, AnyPrimitiveDefinition>,
> = {
  readonly continuous: Map<
    Extract<
      { [K in keyof T]: T[K] extends ContinuousDefinition<any, any, any> ? K : never }[keyof T],
      string
    >,
    ContinuousDefinition<any, any, any>
  >;
  readonly buffer: Map<
    Extract<
      { [K in keyof T]: T[K] extends BufferDefinition<any, any, any, any> ? K : never }[keyof T],
      string
    >,
    BufferDefinition<any, any, any, any>
  >;
  readonly queue: Map<
    Extract<
      { [K in keyof T]: T[K] extends QueueDefinition<any, any, any> ? K : never }[keyof T],
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
 *   schedule: { _tag: "Every", interval: "30 minutes" },
 *   execute: (ctx) => Effect.gen(function* () {
 *     // Refresh token logic
 *     ctx.setState({ ...ctx.state, accessToken: "new_token" });
 *   }),
 * });
 *
 * const webhookBuffer = Buffer.make({
 *   eventSchema: Schema.Struct({
 *     type: Schema.String,
 *     data: Schema.Unknown,
 *   }),
 *   flushAfter: "5 minutes",
 *   maxEvents: 100,
 *   execute: (ctx) => Effect.gen(function* () {
 *     // Batch process events
 *     yield* sendWebhooks(ctx.state);
 *   }),
 * });
 *
 * const emailQueue = Queue.make({
 *   eventSchema: Schema.Struct({
 *     to: Schema.String,
 *     template: Schema.String,
 *   }),
 *   concurrency: 5,
 *   execute: (ctx) => Effect.gen(function* () {
 *     // Send email
 *     yield* sendEmail(ctx.event);
 *   }),
 * });
 *
 * // Create engine and client
 * const { Primitives, PrimitivesClient } = createDurablePrimitives({
 *   primitives: {
 *     tokenRefresher,
 *     webhookBuffer,
 *     emailQueue,
 *   },
 *   tracking: {
 *     enabled: true,
 *     endpoint: "https://events.example.com/ingest",
 *     env: "production",
 *     serviceKey: "my-service",
 *   },
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
 *     // Start continuous primitive
 *     await client.continuous("tokenRefresher").start({
 *       id: "user-123",
 *       input: { accessToken: "", refreshToken: "rt_abc", expiresAt: 0 },
 *     });
 *
 *     // Add to buffer
 *     await client.buffer("webhookBuffer").add({
 *       id: "contact-456",
 *       event: { type: "contact.updated", data: { email: "new@example.com" } },
 *     });
 *
 *     // Enqueue for processing
 *     await client.queue("emailQueue").enqueue({
 *       id: "email-789",
 *       event: { to: "user@example.com", template: "welcome" },
 *     });
 *
 *     return new Response("OK");
 *   },
 * };
 * ```
 */
export function createDurablePrimitives<
  const T extends Record<string, AnyPrimitiveDefinition>,
>(
  options: CreateDurablePrimitivesOptions<T>
): CreateDurablePrimitivesResult<T> {
  // Create registry from definitions
  const registry = createPrimitiveRegistry(options.primitives);

  // Create tracker config if provided
  const trackerConfig: TrackerConfig | undefined = options.tracking
    ? {
        enabled: options.tracking.enabled,
        endpoint: options.tracking.endpoint,
        env: options.tracking.env,
        serviceKey: options.tracking.serviceKey,
      }
    : undefined;

  // Create bound DO class with registry and config injected
  class BoundPrimitivesEngine extends DurablePrimitivesEngine {
    constructor(state: DurableObjectState, env: unknown) {
      // Inject registry and tracker config into environment
      const enrichedEnv: PrimitivesEngineConfig = {
        ...(env as object),
        __PRIMITIVE_REGISTRY__: registry,
        __TRACKER_CONFIG__: trackerConfig,
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
