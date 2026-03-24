// Errors
export {
  TaskError,
  PurgeSignal,
  TaskNotFoundError,
  TaskValidationError,
  TaskExecutionError,
  SystemFailure,
} from "./errors.js"

// Platform services
export { Storage, StorageError } from "./services/Storage.js"
export { Alarm, AlarmError } from "./services/Alarm.js"

// Task declaration
export { Task } from "./TaskTag.js"
export type {
  TaskTag,
  AnyTaskTag,
  PureSchema,
  StateOf,
  EventOf,
  NameOf,
  StateFor,
  EventFor,
} from "./TaskTag.js"

// Context
export type { TaskCtx, SiblingHandle } from "./TaskCtx.js"

// Registration
export { TaskRegistry, withServices } from "./TaskRegistry.js"
export type { TaskHandler, TaskRegistryConfig, HandlerConfig, TaskHelpers } from "./TaskRegistry.js"

// Internal (for adapters)
export type { RegisteredTask, DispatchFn, HandlerContext, ResolvedHandlerConfig } from "./RegisteredTask.js"
export { buildRegisteredTask } from "./RegisteredTask.js"

// Runtime interface (shared by all adapters)
export type { TaskRuntime } from "./TaskRuntime.js"

// Runner (for single-instance adapters)
export { TaskRunner, makeTaskRunnerLayer } from "./TaskRunner.js"

// In-memory runtime (full adapter with per-instance isolation)
export { InMemoryRuntime, makeInMemoryRuntime } from "./InMemoryRuntime.js"
export type { ScheduledAlarm } from "./InMemoryRuntime.js"

// Legacy test utilities (kept for backward compat with single-instance tests)
export { makeInMemoryStorage } from "./InMemoryStorage.js"
export type { InMemoryStorageHandle } from "./InMemoryStorage.js"
export { makeInMemoryAlarm } from "./InMemoryAlarm.js"
export type { InMemoryAlarmHandle } from "./InMemoryAlarm.js"
