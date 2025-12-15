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
  ContinuousStateOf,
  ContinuousErrorOf,
  DebounceEventOf,
  DebounceStateOf,
  WorkerPoolEventOf,
} from "./typed";

export {
  hasContinuousJob,
  hasDebounceJob,
  hasWorkerPoolJob,
} from "./typed";

export type {
  // Schedule types
  ContinuousSchedule,
  // Unregistered definition types (what user creates)
  UnregisteredContinuousDefinition,
  UnregisteredDebounceDefinition,
  UnregisteredWorkerPoolDefinition,
  AnyUnregisteredDefinition,
  // Registered definition types (with name)
  ContinuousDefinition,
  DebounceDefinition,
  WorkerPoolDefinition,
  WorkerPoolRetryConfig,
  AnyJobDefinition,
  // Stored definition types (error type widened for handlers)
  StoredJobRetryConfig,
  StoredContinuousDefinition,
  StoredDebounceDefinition,
  StoredWorkerPoolDefinition,
  // Context types
  ContinuousContext,
  TerminateOptions,
  DebounceExecuteContext,
  DebounceEventContext,
  WorkerPoolExecuteContext,
  WorkerPoolDeadLetterContext,
  WorkerPoolEmptyContext,
  // Registry types
  JobRegistry,
  InferRegistry,
} from "./types";
