// packages/jobs/src/factory.ts

import { Context } from "effect";
import { DurableObject } from "cloudflare:workers";
import { DurableJobsEngine, type JobsEngineConfig } from "./engine";
import {
  createTypedJobRegistry,
  toRuntimeRegistry,
  type AnyUnregisteredDefinition,
  type TypedJobRegistry,
  type RuntimeJobRegistry,
} from "./registry";
import {
  createJobsClient,
  type JobsClient,
  type JobsClientFactory,
} from "./client";

/**
 * Result of creating durable jobs.
 */
export interface CreateDurableJobsResult<
  T extends Record<string, AnyUnregisteredDefinition>,
> {
  /**
   * The Durable Object class to export for Cloudflare.
   *
   * @example
   * ```ts
   * // Export in worker entry point
   * export { Jobs };
   * ```
   */
  readonly Jobs: typeof DurableJobsEngine;

  /**
   * Factory for creating typed clients.
   *
   * @example
   * ```ts
   * const client = JobsClient.fromBinding(env.JOBS);
   * await client.continuous("tokenRefresher").start({ id: "user-123", input: {...} });
   * ```
   */
  readonly JobsClient: JobsClientFactory<TypedJobRegistry<T>>;

  /**
   * The typed job registry with full type information.
   */
  readonly registry: TypedJobRegistry<T>;

  /**
   * Runtime registry for handler use (backwards compatibility).
   */
  readonly runtimeRegistry: RuntimeJobRegistry;
}

/**
 * Type alias for backwards compatibility.
 * @deprecated Use TypedJobRegistry directly instead.
 */
export type InferRegistryFromDefinitions<
  T extends Record<string, AnyUnregisteredDefinition>,
> = TypedJobRegistry<T>;

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a Durable Jobs engine for a set of jobs.
 *
 * This is the main factory function for creating production jobs engines.
 * It returns:
 * - `Jobs`: The Durable Object class to export
 * - `JobsClient`: Factory for creating typed clients
 * - `registry`: The job registry (for advanced use cases)
 *
 * @param definitions - Object of job definitions (keys become job names)
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { createDurableJobs, Continuous, Debounce, WorkerPool } from "@durable-effect/jobs";
 *
 * // Define jobs
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
 * // Create engine and client - keys become job names
 * const { Jobs, JobsClient } = createDurableJobs({
 *   tokenRefresher,
 * });
 *
 * // Export for Cloudflare
 * export { Jobs };
 *
 * // Use client in worker
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     const client = JobsClient.fromBinding(env.JOBS);
 *
 *     // Start continuous job - name comes from object key
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
export function createDurableJobs<
  const T extends Record<string, AnyUnregisteredDefinition>,
>(
  definitions: T
): CreateDurableJobsResult<T> {
  // Create typed registry from definitions (preserves literal keys)
  const registry = createTypedJobRegistry(definitions);

  // Create runtime registry for handlers (uses object lookup)
  const runtimeRegistry = toRuntimeRegistry(registry);

  // Create bound DO class with runtime registry injected
  class BoundJobsEngine extends DurableJobsEngine {
    constructor(state: DurableObjectState, env: unknown) {
      // Inject runtime registry into environment
      const enrichedEnv: JobsEngineConfig = {
        ...(env as object),
        __JOB_REGISTRY__: runtimeRegistry,
      };

      super(state, enrichedEnv);
    }
  }

  // Create Effect Tag for the client
  const ClientTag = Context.GenericTag<
    JobsClient<TypedJobRegistry<T>>
  >("@durable-effect/jobs/Client");

  // Create client factory - no phantom type cast needed!
  // The registry already has __definitions as a real property
  const JobsClientFactory: JobsClientFactory<TypedJobRegistry<T>> = {
    fromBinding: (binding: DurableObjectNamespace) =>
      createJobsClient(binding, registry),
    Tag: ClientTag,
  };

  return {
    Jobs: BoundJobsEngine as typeof DurableJobsEngine,
    JobsClient: JobsClientFactory,
    registry,
    runtimeRegistry,
  };
}
