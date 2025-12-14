// packages/jobs/src/factory.ts

import { Context } from "effect";
import { DurableObject } from "cloudflare:workers";
import { DurableJobsEngine, type JobsEngineConfig } from "./engine";
import {
  createJobRegistry,
  type AnyUnregisteredDefinition,
  type JobRegistry,
  type UnregisteredContinuousDefinition,
  type UnregisteredDebounceDefinition,
  type UnregisteredWorkerPoolDefinition,
  type ContinuousDefinition,
  type DebounceDefinition,
  type WorkerPoolDefinition,
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
  readonly JobsClient: JobsClientFactory<
    InferRegistryFromDefinitions<T>
  >;

  /**
   * The job registry (for advanced use cases).
   */
  readonly registry: JobRegistry;
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
  readonly debounce: Map<
    Extract<
      { [K in keyof T]: T[K] extends UnregisteredDebounceDefinition<any, any, any, any> ? K : never }[keyof T],
      string
    >,
    DebounceDefinition<any, any, any, any>
  >;
  readonly workerPool: Map<
    Extract<
      { [K in keyof T]: T[K] extends UnregisteredWorkerPoolDefinition<any, any, any> ? K : never }[keyof T],
      string
    >,
    WorkerPoolDefinition<any, any, any>
  >;
  /** Original definitions object for type inference */
  readonly __definitions: T;
};

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
  // Create registry from definitions
  const registry = createJobRegistry(definitions);

  // Create bound DO class with registry and config injected
  class BoundJobsEngine extends DurableJobsEngine {
    constructor(state: DurableObjectState, env: unknown) {
      // Inject registry and tracker config into environment
      const enrichedEnv: JobsEngineConfig = {
        ...(env as object),
        __JOB_REGISTRY__: registry,
      };

      super(state, enrichedEnv);
    }
  }

  // Create Effect Tag for the client
  const ClientTag = Context.GenericTag<
    JobsClient<InferRegistryFromDefinitions<T>>
  >("@durable-effect/jobs/Client");

  // Create client factory
  // Cast the registry to include the type-level __definitions property
  const typedRegistry = registry as unknown as InferRegistryFromDefinitions<T>;

  const JobsClientFactory: JobsClientFactory<
    InferRegistryFromDefinitions<T>
  > = {
    fromBinding: (binding: DurableObjectNamespace) =>
      createJobsClient(binding, typedRegistry),
    Tag: ClientTag,
  };

  return {
    Jobs: BoundJobsEngine as typeof DurableJobsEngine,
    JobsClient: JobsClientFactory,
    registry,
  };
}
