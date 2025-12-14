// packages/jobs/src/registry/index.ts

export {
  createJobRegistry,
  getContinuousDefinition,
  getDebounceDefinition,
  getWorkerPoolDefinition,
  getJobDefinition,
  getAllJobNames,
} from "./registry";

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
