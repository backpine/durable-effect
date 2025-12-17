// packages/jobs/src/registry/index.ts

export {
  createJobRegistry,
  createTypedJobRegistry,
  toRuntimeRegistry,
  getContinuousDefinition,
  getDebounceDefinition,
  getWorkerPoolDefinition,
  getJobDefinition,
  getAllJobNames,
} from "./registry";

export type {
  TypedJobRegistry,
  RuntimeJobRegistry,
  ContinuousKeysOf,
  DebounceKeysOf,
  WorkerPoolKeysOf,
  TaskKeysOf,
  ContinuousStateOf,
  ContinuousErrorOf,
  DebounceEventOf,
  DebounceStateOf,
  WorkerPoolEventOf,
  TaskStateOf,
  TaskEventOf,
} from "./typed";

export {
  hasContinuousJob,
  hasDebounceJob,
  hasWorkerPoolJob,
  hasTaskJob,
} from "./typed";

export type {
  // Schedule types
  ContinuousSchedule,
  // Unregistered definition types (what user creates)
  UnregisteredContinuousDefinition,
  UnregisteredDebounceDefinition,
  UnregisteredWorkerPoolDefinition,
  UnregisteredTaskDefinition,
  AnyUnregisteredDefinition,
  // Registered definition types (with name)
  ContinuousDefinition,
  DebounceDefinition,
  WorkerPoolDefinition,
  TaskDefinition,
  WorkerPoolRetryConfig,
  AnyJobDefinition,
  // Stored definition types (error type widened for handlers)
  StoredJobRetryConfig,
  StoredContinuousDefinition,
  StoredDebounceDefinition,
  StoredWorkerPoolDefinition,
  StoredTaskDefinition,
  // Context types
  ContinuousContext,
  TerminateOptions,
  DebounceExecuteContext,
  DebounceEventContext,
  WorkerPoolExecuteContext,
  WorkerPoolDeadLetterContext,
  WorkerPoolEmptyContext,
  TaskEventContext,
  TaskExecuteContext,
  TaskIdleContext,
  TaskErrorContext,
  // Registry types
  JobRegistry,
  InferRegistry,
} from "./types";
