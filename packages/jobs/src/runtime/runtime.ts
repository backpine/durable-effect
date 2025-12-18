// packages/jobs/src/runtime/runtime.ts

import { Effect, Layer } from "effect";
import { createDurableObjectRuntime, flushEvents, type RuntimeLayer } from "@durable-effect/core";
import { RuntimeServicesLayer, RegistryServiceLayer, JobExecutionServiceLayer, CleanupServiceLayer } from "../services";
import { JobHandlersLayer, RetryExecutorLayer } from "../handlers";
import { Dispatcher, DispatcherLayer } from "./dispatcher";
import type { JobRequest, JobResponse } from "./types";
import type { RuntimeJobRegistry } from "../registry/typed";

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for creating a jobs runtime.
 */
export interface JobsRuntimeConfig {
  /**
   * Durable Object state (provides storage + alarm).
   */
  readonly doState: DurableObjectState;

  /**
   * Registry of job definitions.
   * Required for handlers to look up definitions.
   */
  readonly registry: RuntimeJobRegistry;
}

/**
 * The jobs runtime interface.
 *
 * This is what the DO shell delegates to. It's a simple interface
 * that hides all the Effect complexity from the DO class.
 */
export interface JobsRuntime {
  /**
   * Handle a job request.
   */
  readonly handle: (request: JobRequest) => Promise<JobResponse>;

  /**
   * Handle an alarm.
   */
  readonly handleAlarm: () => Promise<void>;

  /**
   * Flush any pending events.
   * Should be called via waitUntil after handle/handleAlarm.
   */
  readonly flush: () => Promise<void>;
}

// =============================================================================
// Shared Layer Composition
// =============================================================================

/**
 * Create the full dispatcher layer from a core layer and registry.
 *
 * This is the shared layer composition logic used by both
 * createJobsRuntime and createJobsRuntimeFromLayer.
 */
function createDispatcherLayer(
  coreLayer: RuntimeLayer,
  registry: RuntimeJobRegistry
): Layer.Layer<Dispatcher> {
  // Registry layer
  const registryLayer = RegistryServiceLayer(registry);

  // Runtime services layer (MetadataService, AlarmService, IdempotencyService)
  const servicesLayer = RuntimeServicesLayer.pipe(Layer.provideMerge(coreLayer));

  // Cleanup service layer (depends on AlarmService and StorageAdapter)
  const cleanupLayer = CleanupServiceLayer.pipe(Layer.provideMerge(servicesLayer));

  // Retry executor layer (depends on AlarmService from servicesLayer)
  const retryLayer = RetryExecutorLayer.pipe(Layer.provideMerge(servicesLayer));

  // Job Execution Service (depends on RetryExecutor, CleanupService, and Core)
  const executionLayer = JobExecutionServiceLayer.pipe(
    Layer.provideMerge(retryLayer),
    Layer.provideMerge(cleanupLayer),
    Layer.provideMerge(coreLayer)
  );

  // Handlers layer (ContinuousHandler, DebounceHandler, etc.)
  // Depends on: registry, services, retry executor, execution service
  const handlersLayer = JobHandlersLayer.pipe(
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(servicesLayer),
    Layer.provideMerge(retryLayer),
    Layer.provideMerge(executionLayer)
  );

  // Dispatcher layer (routes requests to handlers)
  return DispatcherLayer.pipe(Layer.provideMerge(handlersLayer));
}

/**
 * Create runtime implementation from dispatcher layer.
 */
function createRuntimeFromDispatcherLayer(
  dispatcherLayer: Layer.Layer<Dispatcher>
): JobsRuntime {
  // Helper to run effects with full layer stack
  const runEffect = <A, E>(
    effect: Effect.Effect<A, E, Dispatcher>
  ): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(dispatcherLayer)));

  return {
    handle: (request: JobRequest) =>
      runEffect(
        Effect.gen(function* () {
          const dispatcher = yield* Dispatcher;
          return yield* dispatcher.handle(request);
        })
      ),

    handleAlarm: () =>
      runEffect(
        Effect.gen(function* () {
          const dispatcher = yield* Dispatcher;
          yield* dispatcher.handleAlarm();
        })
      ),

    flush: () => runEffect(flushEvents),
  };
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Creates a jobs runtime from DO state.
 *
 * This is the main entry point for the runtime layer. The DO class
 * creates this once in its constructor and delegates all operations to it.
 *
 * @example
 * ```ts
 * class DurableJobsEngine extends DurableObject {
 *   #runtime: JobsRuntime;
 *
 *   constructor(state: DurableObjectState, env: Env) {
 *     super(state, env);
 *     this.#runtime = createJobsRuntime({
 *       doState: state,
 *       registry: env.__JOB_REGISTRY__,
 *     });
 *   }
 *
 *   async call(request: JobRequest): Promise<JobResponse> {
 *     const result = await this.#runtime.handle(request);
 *     this.ctx.waitUntil(this.#runtime.flush());
 *     return result;
 *   }
 *
 *   async alarm(): Promise<void> {
 *     await this.#runtime.handleAlarm();
 *     this.ctx.waitUntil(this.#runtime.flush());
 *   }
 * }
 * ```
 */
export function createJobsRuntime(
  config: JobsRuntimeConfig
): JobsRuntime {
  if (!config.registry) {
    throw new Error("createJobsRuntime requires a registry");
  }

  const coreLayer = createDurableObjectRuntime(config.doState);
  const dispatcherLayer = createDispatcherLayer(coreLayer, config.registry);

  return createRuntimeFromDispatcherLayer(dispatcherLayer);
}

// =============================================================================
// Test Runtime Factory
// =============================================================================

/**
 * Creates a jobs runtime from a provided layer with a registry.
 *
 * Used for testing with in-memory adapters.
 *
 * @example
 * ```ts
 * const { layer, handles } = createTestRuntime("test-instance", 1000000);
 * const runtime = createJobsRuntimeFromLayer(layer, registry);
 *
 * await runtime.handle({ type: "continuous", action: "start", ... });
 * handles.scheduler.fire();
 * await runtime.handleAlarm();
 * ```
 */
export function createJobsRuntimeFromLayer(
  coreLayer: RuntimeLayer,
  registry: RuntimeJobRegistry
): JobsRuntime {
  const dispatcherLayer = createDispatcherLayer(coreLayer, registry);

  return createRuntimeFromDispatcherLayer(dispatcherLayer);
}
