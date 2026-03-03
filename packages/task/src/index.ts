// Errors
export {
  TaskError,
  PurgeSignal,
  TaskNotFoundError,
  TaskValidationError,
  TaskExecutionError,
} from "./errors.js"

// Platform services
export { Storage, StorageError } from "./services/Storage.js"
export { Alarm, AlarmError } from "./services/Alarm.js"

// User-facing API
export { Task } from "./Task.js"
export type { TaskContext } from "./TaskContext.js"
export type { PureSchema, TaskDefineConfig, TaskDefinition } from "./TaskDefinition.js"
export { withServices } from "./TaskDefinition.js"

// Framework services
export {
  TaskRegistry,
  registerTask,
  registerTaskWithLayer,
  buildRegistryLayer,
} from "./services/TaskRegistry.js"
export type {
  RegisteredTask,
  TaskRegistryConfig,
} from "./services/TaskRegistry.js"
export { TaskRunner } from "./services/TaskRunner.js"

// Live implementations
export { TaskRunnerLive } from "./live/TaskRunnerLive.js"
export { makeInMemoryStorage } from "./live/InMemoryStorage.js"
export type { InMemoryStorageHandle } from "./live/InMemoryStorage.js"
export { makeInMemoryAlarm } from "./live/InMemoryAlarm.js"
export type { InMemoryAlarmHandle } from "./live/InMemoryAlarm.js"
