// packages/jobs/src/index.ts

/**
 * @durable-effect/jobs
 *
 * Durable jobs for Effect on Cloudflare Workers.
 *
 * Phase 1: Runtime Foundation
 * - Services (MetadataService, AlarmService, IdempotencyService, EntityStateService)
 * - Runtime types (JobRequest, JobResponse)
 * - Dispatcher (shell implementation)
 * - Runtime factory (createJobsRuntime)
 *
 * Phase 2: DO Shell & Client Foundation
 * - Registry (job definitions and type-safe lookup)
 * - Engine (thin DO shell)
 * - Client (typed client for calling jobs)
 * - Factory (createDurableJobs)
 */

// =============================================================================
// Main Factory (Primary API)
// =============================================================================

export {
  createDurableJobs,
  type CreateDurableJobsResult,
  type CreateDurableJobsOptions,
  type InferRegistryFromDefinitions,
} from "./factory";

// =============================================================================
// Errors
// =============================================================================

export {
  // Re-exported from core
  StorageError,
  SchedulerError,
  // Job-specific errors
  JobNotFoundError,
  InstanceNotFoundError,
  InvalidStateError,
  ValidationError,
  ExecutionError,
  RetryExhaustedError,
  UnknownJobTypeError,
  DuplicateEventError,
  // Terminate signal (for advanced use cases)
  TerminateSignal,
  type JobError,
} from "./errors";

// =============================================================================
// Storage Keys
// =============================================================================

export { KEYS } from "./storage-keys";

// =============================================================================
// Services
// =============================================================================

export {
  // Metadata
  MetadataService,
  MetadataServiceLayer,
  type MetadataServiceI,
  type JobMetadata,
  type JobType,
  type JobStatus,
  // Entity State
  createEntityStateService,
  type EntityStateServiceI,
  // Alarm
  AlarmService,
  AlarmServiceLayer,
  type AlarmServiceI,
  // Idempotency
  IdempotencyService,
  IdempotencyServiceLayer,
  type IdempotencyServiceI,
  // Combined layer
  RuntimeServicesLayer,
} from "./services";

// =============================================================================
// Runtime
// =============================================================================

export {
  // Types
  type JobRequest,
  type JobResponse,
  type ContinuousRequest,
  type DebounceRequest,
  type WorkerPoolRequest,
  // Response types
  type ContinuousStartResponse,
  type ContinuousTerminateResponse,
  type ContinuousTriggerResponse,
  type ContinuousStatusResponse,
  type ContinuousGetStateResponse,
  type DebounceAddResponse,
  type DebounceFlushResponse,
  type DebounceClearResponse,
  type DebounceStatusResponse,
  type DebounceGetStateResponse,
  type WorkerPoolEnqueueResponse,
  type WorkerPoolPauseResponse,
  type WorkerPoolResumeResponse,
  type WorkerPoolCancelResponse,
  type WorkerPoolStatusResponse,
  type WorkerPoolDrainResponse,
  // Dispatcher
  Dispatcher,
  DispatcherLayer,
  type DispatcherServiceI,
  // Runtime
  createJobsRuntime,
  createJobsRuntimeFromLayer,
  type JobsRuntime,
  type JobsRuntimeConfig,
} from "./runtime";

// =============================================================================
// Registry
// =============================================================================

export {
  createJobRegistry,
  createTypedJobRegistry,
  toRuntimeRegistry,
  getContinuousDefinition,
  getDebounceDefinition,
  getWorkerPoolDefinition,
  getJobDefinition,
  getAllJobNames,
  hasContinuousJob,
  hasDebounceJob,
  hasWorkerPoolJob,
  hasTaskJob,
  // Types - Unregistered (what users create)
  type UnregisteredContinuousDefinition,
  type UnregisteredDebounceDefinition,
  type UnregisteredWorkerPoolDefinition,
  type UnregisteredTaskDefinition,
  type AnyUnregisteredDefinition,
  // Types - Registered (with name)
  type ContinuousSchedule,
  type ContinuousDefinition,
  type DebounceDefinition,
  type WorkerPoolDefinition,
  type TaskDefinition,
  type WorkerPoolRetryConfig,
  type AnyJobDefinition,
  // Types - Context
  type ContinuousContext,
  type TerminateOptions,
  type DebounceExecuteContext,
  type DebounceEventContext,
  type WorkerPoolExecuteContext,
  type WorkerPoolDeadLetterContext,
  type WorkerPoolEmptyContext,
  type TaskEventContext,
  type TaskExecuteContext,
  type TaskIdleContext,
  type TaskErrorContext,
  // Types - Registry (legacy)
  type JobRegistry,
  type InferRegistry,
  // Types - Typed Registry (new)
  type TypedJobRegistry,
  type RuntimeJobRegistry,
  type ContinuousKeysOf,
  type DebounceKeysOf,
  type WorkerPoolKeysOf,
  type TaskKeysOf,
  type ContinuousStateOf,
  type ContinuousErrorOf,
  type DebounceEventOf,
  type DebounceStateOf,
  type WorkerPoolEventOf,
  type TaskStateOf,
  type TaskEventOf,
  // Types - Stored (for handlers)
  type StoredTaskDefinition,
  // Types - Logging
  type LoggingOption,
} from "./registry";

// =============================================================================
// Engine
// =============================================================================

export {
  DurableJobsEngine,
  type DurableJobsEngineInterface,
  type JobsEngineConfig,
  type JobsEnv,
} from "./engine";

// =============================================================================
// Client
// =============================================================================

export {
  createJobsClient,
  narrowResponseEffect,
  jobCallError,
  UnexpectedResponseError,
  type ContinuousClient,
  type DebounceClient,
  type WorkerPoolClient,
  type WorkerPoolAggregatedStatus,
  type JobsClient,
  type JobsClientFactory,
  type ContinuousKeys,
  type DebounceKeys,
  type WorkerPoolKeys,
  type ContinuousStateType,
  type DebounceEventType,
  type DebounceStateType,
  type WorkerPoolEventType,
  type ClientError,
  type JobCallError,
} from "./client";

// =============================================================================
// Definition Factories
// =============================================================================

export {
  Continuous,
  type ContinuousMakeConfig,
  type ContinuousNamespace,
  Debounce,
  type DebounceMakeConfig,
  type DebounceNamespace,
  Task,
  type TaskMakeConfig,
  type TaskNamespace,
} from "./definitions";

// =============================================================================
// Handlers
// =============================================================================

export {
  ContinuousHandler,
  ContinuousHandlerLayer,
  createContinuousContext,
  type ContinuousHandlerI,
  type ContinuousResponse,
  type StateHolder,
  DebounceHandler,
  DebounceHandlerLayer,
  type DebounceHandlerI,
  type DebounceResponse,
  JobHandlersLayer,
} from "./handlers";

// =============================================================================
// Tracker (Re-exported from @durable-effect/core)
// =============================================================================

export {
  // Tracker config
  type HttpBatchTrackerConfig,
  // Job event types
  type InternalJobEvent,
  type InternalJobStartedEvent,
  type InternalJobExecutedEvent,
  type InternalJobFailedEvent,
  type InternalJobRetryExhaustedEvent,
  type InternalJobTerminatedEvent,
  type InternalDebounceStartedEvent,
  type InternalDebounceFlushedEvent,
  type InternalTaskScheduledEvent,
  // Wire event types (with env/serviceKey)
  type JobEvent,
} from "@durable-effect/core";
