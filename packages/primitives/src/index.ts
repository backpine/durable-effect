// packages/primitives/src/index.ts

/**
 * @durable-effect/primitives
 *
 * Durable primitives for Effect on Cloudflare Workers.
 *
 * Phase 1: Runtime Foundation
 * - Services (MetadataService, AlarmService, IdempotencyService, EntityStateService)
 * - Runtime types (PrimitiveRequest, PrimitiveResponse)
 * - Dispatcher (shell implementation)
 * - Runtime factory (createPrimitivesRuntime)
 *
 * Phase 2: DO Shell & Client Foundation
 * - Registry (primitive definitions and type-safe lookup)
 * - Engine (thin DO shell)
 * - Client (typed client for calling primitives)
 * - Factory (createDurablePrimitives)
 */

// =============================================================================
// Main Factory (Primary API)
// =============================================================================

export {
  createDurablePrimitives,
  type CreateDurablePrimitivesOptions,
  type CreateDurablePrimitivesResult,
  type InferRegistryFromDefinitions,
} from "./factory";

// =============================================================================
// Errors
// =============================================================================

export {
  // Re-exported from core
  StorageError,
  SchedulerError,
  // Primitive-specific errors
  PrimitiveNotFoundError,
  InstanceNotFoundError,
  InvalidStateError,
  ValidationError,
  ExecutionError,
  RetryExhaustedError,
  UnknownPrimitiveTypeError,
  DuplicateEventError,
  // Terminate signal (for advanced use cases)
  TerminateSignal,
  type PrimitiveError,
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
  type PrimitiveMetadata,
  type PrimitiveType,
  type PrimitiveStatus,
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
  type PrimitiveRequest,
  type PrimitiveResponse,
  type ContinuousRequest,
  type BufferRequest,
  type QueueRequest,
  // Response types
  type ContinuousStartResponse,
  type ContinuousStopResponse,
  type ContinuousTriggerResponse,
  type ContinuousStatusResponse,
  type ContinuousGetStateResponse,
  type BufferAddResponse,
  type BufferFlushResponse,
  type BufferClearResponse,
  type BufferStatusResponse,
  type BufferGetStateResponse,
  type QueueEnqueueResponse,
  type QueuePauseResponse,
  type QueueResumeResponse,
  type QueueCancelResponse,
  type QueueStatusResponse,
  type QueueDrainResponse,
  // Dispatcher
  Dispatcher,
  DispatcherLayer,
  type DispatcherServiceI,
  // Runtime
  createPrimitivesRuntime,
  createPrimitivesRuntimeFromLayer,
  type PrimitivesRuntime,
  type PrimitivesRuntimeConfig,
} from "./runtime";

// =============================================================================
// Registry
// =============================================================================

export {
  createPrimitiveRegistry,
  getContinuousDefinition,
  getBufferDefinition,
  getQueueDefinition,
  getPrimitiveDefinition,
  getAllPrimitiveNames,
  // Types
  type ContinuousSchedule,
  type PrimitiveDefinitionBase,
  type ContinuousDefinition,
  type BufferDefinition,
  type QueueDefinition,
  type QueueRetryConfig,
  type AnyPrimitiveDefinition,
  type ContinuousContext,
  type TerminateOptions,
  type BufferExecuteContext,
  type BufferEventContext,
  type QueueExecuteContext,
  type QueueDeadLetterContext,
  type QueueEmptyContext,
  type PrimitiveRegistry,
  type InferRegistry,
} from "./registry";

// =============================================================================
// Engine
// =============================================================================

export {
  DurablePrimitivesEngine,
  type DurablePrimitivesEngineInterface,
  type PrimitivesEngineConfig,
  type TrackerConfig,
  type PrimitivesEnv,
} from "./engine";

// =============================================================================
// Client
// =============================================================================

export {
  createPrimitivesClient,
  narrowResponseEffect,
  primitiveCallError,
  UnexpectedResponseError,
  type ContinuousClient,
  type BufferClient,
  type QueueClient,
  type QueueAggregatedStatus,
  type PrimitivesClient,
  type PrimitivesClientFactory,
  type ContinuousKeys,
  type BufferKeys,
  type QueueKeys,
  type ContinuousStateType,
  type BufferEventType,
  type BufferStateType,
  type QueueEventType,
  type ClientError,
  type PrimitiveCallError,
} from "./client";

// =============================================================================
// Definition Factories
// =============================================================================

export {
  Continuous,
  type ContinuousMakeConfig,
  type ContinuousNamespace,
} from "./definitions";

// =============================================================================
// Handlers
// =============================================================================

export {
  ContinuousHandler,
  ContinuousHandlerLayer,
  createContinuousContext,
  executeUserFunction,
  type ContinuousHandlerI,
  type ContinuousResponse,
  type StateHolder,
  PrimitiveHandlersLayer,
} from "./handlers";
