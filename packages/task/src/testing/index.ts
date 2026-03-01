import { Layer } from "effect";
import { Instance } from "../adapter/instance.js";
import { createTestStore, type TestStoreHandle } from "./store.js";
import { createTestScheduler, type TestSchedulerHandle } from "./scheduler.js";
import { Store } from "../adapter/store.js";
import { Scheduler } from "../adapter/scheduler.js";

export { createTestStore, type TestStoreHandle } from "./store.js";
export { createTestScheduler, type TestSchedulerHandle } from "./scheduler.js";

export interface TestClock {
  readonly get: () => number;
  readonly set: (ms: number) => void;
  readonly advance: (ms: number) => void;
}

export interface TestHandles {
  readonly store: TestStoreHandle;
  readonly scheduler: TestSchedulerHandle;
  readonly clock: TestClock;
}

export function createTestLayer(options?: {
  id?: string;
  name?: string;
  now?: number;
}): { layer: Layer.Layer<Store | Scheduler | Instance>; handles: TestHandles } {
  const { layer: storeLayer, handle: store } = createTestStore();
  const { layer: schedulerLayer, handle: scheduler } = createTestScheduler();

  let currentTime = options?.now ?? 0;
  const clock: TestClock = {
    get: () => currentTime,
    set: (ms) => { currentTime = ms; },
    advance: (ms) => { currentTime += ms; },
  };

  const instanceLayer = Layer.succeed(Instance)({
    id: options?.id ?? "test-id",
    name: options?.name ?? "test-task",
  });

  const layer = Layer.mergeAll(storeLayer, schedulerLayer, instanceLayer);

  return { layer, handles: { store, scheduler, clock } };
}
