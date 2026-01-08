// packages/jobs/test/handlers/test-utils.ts

import { Effect, Layer } from "effect";
import { createTestRuntime, NoopTrackerLayer } from "@durable-effect/core";
import { MetadataServiceLayer } from "../../src/services/metadata";
import { AlarmServiceLayer } from "../../src/services/alarm";
import { RegistryServiceLayer } from "../../src/services/registry";
import { JobExecutionServiceLayer } from "../../src/services/execution";
import { CleanupServiceLayer } from "../../src/services/cleanup";
import { RetryExecutorLayer } from "../../src/retry";
import {
  ContinuousHandler,
  ContinuousHandlerLayer,
} from "../../src/handlers/continuous";
import {
  DebounceHandler,
  DebounceHandlerLayer,
} from "../../src/handlers/debounce";
import { TaskHandler, TaskHandlerLayer } from "../../src/handlers/task";
import type { RuntimeJobRegistry } from "../../src/registry/typed";

// =============================================================================
// Registry Factory
// =============================================================================

/**
 * Create a test registry with optional job definitions.
 */
export const createTestRegistry = (
  overrides: Partial<{
    continuous: Record<string, any>;
    debounce: Record<string, any>;
    task: Record<string, any>;
    workerPool: Record<string, any>;
  }> = {}
): RuntimeJobRegistry => ({
  continuous: overrides.continuous ?? ({} as Record<string, any>),
  debounce: overrides.debounce ?? ({} as Record<string, any>),
  task: overrides.task ?? ({} as Record<string, any>),
  workerPool: overrides.workerPool ?? ({} as Record<string, any>),
});

// =============================================================================
// Layer Factories
// =============================================================================

/**
 * Build the shared services layer (metadata, alarm, tracker).
 */
const buildServicesLayer = (coreLayer: Layer.Layer<any>) =>
  Layer.mergeAll(MetadataServiceLayer, AlarmServiceLayer).pipe(
    Layer.provideMerge(NoopTrackerLayer),
    Layer.provideMerge(coreLayer)
  );

/**
 * Build the execution layer stack (retry, cleanup, execution).
 */
const buildExecutionLayer = (
  servicesLayer: Layer.Layer<any>,
  coreLayer: Layer.Layer<any>
) => {
  const retryLayer = RetryExecutorLayer.pipe(Layer.provideMerge(servicesLayer));
  const cleanupLayer = CleanupServiceLayer.pipe(
    Layer.provideMerge(servicesLayer)
  );
  const executionLayer = JobExecutionServiceLayer.pipe(
    Layer.provideMerge(retryLayer),
    Layer.provideMerge(cleanupLayer),
    Layer.provideMerge(coreLayer)
  );
  return { retryLayer, cleanupLayer, executionLayer };
};

/**
 * Create test layer for ContinuousHandler.
 */
export const createContinuousTestLayer = (
  registry: RuntimeJobRegistry,
  initialTime = 1000000
) => {
  const {
    layer: coreLayer,
    time,
    handles,
  } = createTestRuntime("test-instance", initialTime);

  const servicesLayer = buildServicesLayer(coreLayer);
  const { retryLayer, executionLayer } = buildExecutionLayer(
    servicesLayer,
    coreLayer
  );

  const handlerLayer = ContinuousHandlerLayer.pipe(
    Layer.provideMerge(RegistryServiceLayer(registry)),
    Layer.provideMerge(servicesLayer),
    Layer.provideMerge(retryLayer),
    Layer.provideMerge(executionLayer)
  ) as Layer.Layer<ContinuousHandler>;

  return { layer: handlerLayer, time, handles, coreLayer };
};

/**
 * Create test layer for DebounceHandler.
 */
export const createDebounceTestLayer = (
  registry: RuntimeJobRegistry,
  initialTime = 1000000
) => {
  const {
    layer: coreLayer,
    time,
    handles,
  } = createTestRuntime("test-instance", initialTime);

  const servicesLayer = buildServicesLayer(coreLayer);
  const { retryLayer, executionLayer } = buildExecutionLayer(
    servicesLayer,
    coreLayer
  );

  const handlerLayer = DebounceHandlerLayer.pipe(
    Layer.provideMerge(RegistryServiceLayer(registry)),
    Layer.provideMerge(servicesLayer),
    Layer.provideMerge(retryLayer),
    Layer.provideMerge(executionLayer)
  ) as Layer.Layer<DebounceHandler>;

  return { layer: handlerLayer, time, handles, coreLayer };
};

/**
 * Create test layer for TaskHandler.
 */
export const createTaskTestLayer = (
  registry: RuntimeJobRegistry,
  initialTime = 1000000
) => {
  const {
    layer: coreLayer,
    time,
    handles,
  } = createTestRuntime("test-instance", initialTime);

  const servicesLayer = buildServicesLayer(coreLayer);
  const { executionLayer } = buildExecutionLayer(servicesLayer, coreLayer);

  const handlerLayer = TaskHandlerLayer.pipe(
    Layer.provideMerge(RegistryServiceLayer(registry)),
    Layer.provideMerge(servicesLayer),
    Layer.provideMerge(executionLayer)
  ) as Layer.Layer<TaskHandler>;

  return { layer: handlerLayer, time, handles, coreLayer };
};

// =============================================================================
// Run Helpers
// =============================================================================

/**
 * Run Effect with layer, bypassing strict R parameter checking.
 * This is needed because the test registry uses `as Record<string, any>` which
 * causes `any` to leak into Effect R parameters.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const runWithLayer = <A, E>(
  effect: Effect.Effect<A, E, any>,
  layer: Layer.Layer<any>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>
  );

/**
 * Run Effect with layer and return Exit, bypassing strict R parameter checking.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const runExitWithLayer = <A, E>(
  effect: Effect.Effect<A, E, any>,
  layer: Layer.Layer<any>
) =>
  Effect.runPromiseExit(
    effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>
  );
