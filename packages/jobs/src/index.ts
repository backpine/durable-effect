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
  type ContinuousStopResponse,
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
  // Types - Unregistered (what users create)
  type UnregisteredContinuousDefinition,
  type UnregisteredDebounceDefinition,
  type UnregisteredWorkerPoolDefinition,
  type AnyUnregisteredDefinition,
  // Types - Registered (with name)
  type ContinuousSchedule,
  type ContinuousDefinition,
  type DebounceDefinition,
  type WorkerPoolDefinition,
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
  // Types - Registry (legacy)
  type JobRegistry,
  type InferRegistry,
  // Types - Typed Registry (new)
  type TypedJobRegistry,
  type RuntimeJobRegistry,
  type ContinuousKeysOf,
  type DebounceKeysOf,
  type WorkerPoolKeysOf,
  type ContinuousStateOf,
  type ContinuousErrorOf,
  type DebounceEventOf,
  type DebounceStateOf,
  type WorkerPoolEventOf,
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
