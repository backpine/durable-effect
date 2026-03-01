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
export type { TaskDefineConfig, TaskDefinition } from "./TaskDefinition.js"

// Framework services
export {
  TaskRegistry,
  registerTask,
  buildRegistryLayer,
} from "./services/TaskRegistry.js"
export type {
  RegisteredTask,
  TaskRegistryConfig,
} from "./services/TaskRegistry.js"
export { TaskRunner } from "./services/TaskRunner.js"
