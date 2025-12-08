// packages/workflow/src/adapters/in-memory/runtime.ts

import { Effect, Layer, Ref } from "effect";
import { StorageAdapter } from "../storage";
import { SchedulerAdapter } from "../scheduler";
import { RuntimeAdapter, type RuntimeLayer } from "../runtime";
import { createInMemoryStorage, type InMemoryStorageState } from "./storage";
import {
  createInMemoryScheduler,
  type InMemorySchedulerState,
} from "./scheduler";

/**
 * Combined state for the in-memory runtime.
 * Exposed for test inspection.
 */
export interface InMemoryRuntimeState {
  readonly storage: InMemoryStorageState;
  readonly scheduler: InMemorySchedulerState;
  readonly currentTime: number;
}

/**
 * Test runtime handle for controlling time and inspecting state.
 */
export interface TestRuntimeHandle {
  /**
   * Get current storage state for assertions.
   */
  readonly getStorageState: () => Effect.Effect<InMemoryStorageState>;

  /**
   * Get current scheduler state for assertions.
   */
  readonly getSchedulerState: () => Effect.Effect<InMemorySchedulerState>;

  /**
   * Get current simulated time.
   */
  readonly getCurrentTime: () => Effect.Effect<number>;

  /**
   * Advance simulated time by milliseconds.
   */
  readonly advanceTime: (ms: number) => Effect.Effect<void>;

  /**
   * Set simulated time to specific value.
   */
  readonly setTime: (time: number) => Effect.Effect<void>;

  /**
   * Check if alarm should fire at current time.
   */
  readonly shouldAlarmFire: () => Effect.Effect<boolean>;

  /**
   * Clear the scheduled alarm (simulates alarm firing).
   */
  readonly clearAlarm: () => Effect.Effect<void>;
}

/**
 * Create an in-memory runtime for testing.
 *
 * Returns both the Layer and a handle for test control.
 */
export function createInMemoryRuntime(options?: {
  instanceId?: string;
  initialTime?: number;
}): Effect.Effect<{
  layer: RuntimeLayer;
  handle: TestRuntimeHandle;
}> {
  return Effect.gen(function* () {
    const instanceId = options?.instanceId ?? crypto.randomUUID();
    const initialTime = options?.initialTime ?? Date.now();

    // Create shared refs for state inspection
    const storageRef = yield* Ref.make<InMemoryStorageState>({
      data: new Map(),
    });
    const schedulerRef = yield* Ref.make<InMemorySchedulerState>({
      scheduledTime: undefined,
    });
    const timeRef = yield* Ref.make<number>(initialTime);

    // Create adapters with shared refs
    const storageService = yield* createInMemoryStorage(storageRef);
    const schedulerService = yield* createInMemoryScheduler(schedulerRef);

    const runtimeService = {
      instanceId,
      now: () => Ref.get(timeRef),
    };

    // Create the layer
    const layer = Layer.mergeAll(
      Layer.succeed(StorageAdapter, storageService),
      Layer.succeed(SchedulerAdapter, schedulerService),
      Layer.succeed(RuntimeAdapter, runtimeService),
    );

    // Create test handle
    const handle: TestRuntimeHandle = {
      getStorageState: () => Ref.get(storageRef),
      getSchedulerState: () => Ref.get(schedulerRef),
      getCurrentTime: () => Ref.get(timeRef),
      advanceTime: (ms: number) => Ref.update(timeRef, (t) => t + ms),
      setTime: (time: number) => Ref.set(timeRef, time),
      shouldAlarmFire: () =>
        Effect.all([Ref.get(schedulerRef), Ref.get(timeRef)]).pipe(
          Effect.map(
            ([scheduler, time]) =>
              scheduler.scheduledTime !== undefined &&
              time >= scheduler.scheduledTime,
          ),
        ),
      clearAlarm: () => Ref.set(schedulerRef, { scheduledTime: undefined }),
    };

    return { layer, handle };
  });
}
