// packages/workflow/src/adapters/index.ts

// Storage
export { StorageAdapter, type StorageAdapterService } from "./storage";

// Scheduler
export { SchedulerAdapter, type SchedulerAdapterService } from "./scheduler";

// Runtime
export {
  RuntimeAdapter,
  type RuntimeAdapterService,
  type RuntimeLayer,
  type LifecycleEvent,
} from "./runtime";

// In-memory implementations (for testing)
export {
  createInMemoryStorage,
  createInMemoryStorageWithErrors,
  type InMemoryStorageState,
} from "./in-memory/storage";

export {
  createInMemoryScheduler,
  shouldAlarmFire,
  type InMemorySchedulerState,
} from "./in-memory/scheduler";

export {
  createInMemoryRuntime,
  type InMemoryRuntimeState,
  type TestRuntimeHandle,
} from "./in-memory/runtime";
