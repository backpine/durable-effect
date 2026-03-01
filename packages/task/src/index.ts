export {
  StoreError,
  SchedulerError,
  ValidationError,
  TaskNotFoundError,
  ClientError,
  PurgeSignal,
} from "./errors.js";

export type {
  TaskContext,
  TaskDefineConfig,
  TaskDefinition,
  ProvidedTaskDefinition,
} from "./types.js";

export { Task } from "./define.js";

// Adapter layer
export { KEYS } from "./adapter/keys.js";
export { Store } from "./adapter/store.js";
export { Scheduler } from "./adapter/scheduler.js";
export { Instance } from "./adapter/instance.js";
export { createTaskContext } from "./adapter/context.js";
export type { StoreShape, SchedulerShape, CreateTaskContextOptions } from "./adapter/context.js";
export { createTaskRegistry } from "./adapter/registry.js";
export type { TaskRegistry } from "./adapter/registry.js";
export { createTaskExecutor } from "./adapter/executor.js";
export type { TaskExecutor } from "./adapter/executor.js";

// Testing utilities
export {
  createTestStore,
  createTestScheduler,
  createTestLayer,
} from "./testing/index.js";
export type {
  TestStoreHandle,
  TestSchedulerHandle,
  TestClock,
  TestHandles,
} from "./testing/index.js";
