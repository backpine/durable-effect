// packages/core/src/testing/runtime.ts

import { Effect, Layer } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { SchedulerAdapter } from "../adapters/scheduler";
import { RuntimeAdapter, type RuntimeLayer } from "../adapters/runtime";
import { createInMemoryStorage, createInMemoryStorageWithHandle } from "./storage";
import { createInMemoryScheduler, createInMemorySchedulerWithHandle } from "./scheduler";

/**
 * Create an in-memory runtime layer for testing.
 *
 * @param instanceId - Optional instance ID (defaults to "test-instance")
 */
export function createInMemoryRuntime(instanceId: string = "test-instance"): RuntimeLayer {
  const storageService = createInMemoryStorage();
  const schedulerService = createInMemoryScheduler();

  const runtimeService = {
    instanceId,
    now: () => Effect.sync(() => Date.now()),
  };

  return Layer.mergeAll(
    Layer.succeed(StorageAdapter, storageService),
    Layer.succeed(SchedulerAdapter, schedulerService),
    Layer.succeed(RuntimeAdapter, runtimeService),
  );
}

/**
 * Handles for testing access.
 */
export interface InMemoryRuntimeHandles {
  readonly storage: ReturnType<typeof createInMemoryStorageWithHandle>;
  readonly scheduler: ReturnType<typeof createInMemorySchedulerWithHandle>;
}

/**
 * Create an in-memory runtime layer with test handles.
 *
 * Returns both the layer and handles to inspect/manipulate state.
 *
 * @param instanceId - Optional instance ID (defaults to "test-instance")
 */
export function createInMemoryRuntimeWithHandles(
  instanceId: string = "test-instance",
): { layer: RuntimeLayer; handles: InMemoryRuntimeHandles } {
  const storage = createInMemoryStorageWithHandle();
  const scheduler = createInMemorySchedulerWithHandle();

  const runtimeService = {
    instanceId,
    now: () => Effect.sync(() => Date.now()),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(StorageAdapter, storage),
    Layer.succeed(SchedulerAdapter, scheduler),
    Layer.succeed(RuntimeAdapter, runtimeService),
  );

  return {
    layer,
    handles: { storage, scheduler },
  };
}

/**
 * Create a test runtime with controlled time.
 *
 * @param instanceId - Optional instance ID (defaults to "test-instance")
 * @param initialTime - Optional initial time in ms (defaults to Date.now())
 */
export function createTestRuntime(
  instanceId: string = "test-instance",
  initialTime?: number,
): {
  layer: RuntimeLayer;
  handles: InMemoryRuntimeHandles;
  time: {
    get: () => number;
    set: (ms: number) => void;
    advance: (ms: number) => void;
  };
} {
  const storage = createInMemoryStorageWithHandle();
  const scheduler = createInMemorySchedulerWithHandle();
  let currentTime = initialTime ?? Date.now();

  const runtimeService = {
    instanceId,
    now: () => Effect.sync(() => currentTime),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(StorageAdapter, storage),
    Layer.succeed(SchedulerAdapter, scheduler),
    Layer.succeed(RuntimeAdapter, runtimeService),
  );

  return {
    layer,
    handles: { storage, scheduler },
    time: {
      get: () => currentTime,
      set: (ms: number) => {
        currentTime = ms;
      },
      advance: (ms: number) => {
        currentTime += ms;
      },
    },
  };
}
