// packages/jobs/src/client/types.ts

import type { Context, Effect } from "effect";
import type {
  UnregisteredContinuousDefinition,
  UnregisteredDebounceDefinition,
  UnregisteredWorkerPoolDefinition,
  AnyUnregisteredDefinition,
} from "../registry/types";
import type {
  TypedJobRegistry,
  ContinuousKeysOf,
  DebounceKeysOf,
  WorkerPoolKeysOf,
  ContinuousStateOf,
  DebounceEventOf,
  DebounceStateOf,
  WorkerPoolEventOf,
} from "../registry/typed";
import type {
  ContinuousStartResponse,
  ContinuousStopResponse,
  ContinuousTriggerResponse,
  ContinuousStatusResponse,
  ContinuousGetStateResponse,
  DebounceAddResponse,
  DebounceFlushResponse,
  DebounceClearResponse,
  DebounceStatusResponse,
  DebounceGetStateResponse,
  WorkerPoolEnqueueResponse,
  WorkerPoolPauseResponse,
  WorkerPoolResumeResponse,
  WorkerPoolCancelResponse,
  WorkerPoolStatusResponse,
  WorkerPoolDrainResponse,
} from "../runtime/types";
import type {
  UnexpectedResponseError,
  JobCallError,
} from "./response";

import type {
  TaskSendResponse,
  TaskTriggerResponse,
  TaskClearResponse,
  TaskStatusResponse,
  TaskGetStateResponse,
} from "../runtime/types";
import type { TaskKeysOf, TaskStateOf, TaskEventOf } from "../registry/typed";

// =============================================================================
// Client Error Type
// =============================================================================

/**
 * Combined error type for client operations.
 */
export type ClientError = JobCallError | UnexpectedResponseError;

// Re-export for convenience
export type { JobCallError, UnexpectedResponseError };

// =============================================================================
// Client Instance Types
// =============================================================================

/**
 * Type-safe client for continuous jobs.
 */
export interface ContinuousClient<S> {
  /**
   * Start the continuous job with initial state.
   *
   * If the instance already exists, returns its current status.
   */
  start(options: {
    readonly id: string;
    readonly input: S;
  }): Effect.Effect<ContinuousStartResponse, ClientError>;

  /**
   * Stop the continuous job.
   */
  stop(
    id: string,
    options?: { readonly reason?: string }
  ): Effect.Effect<ContinuousStopResponse, ClientError>;

  /**
   * Trigger immediate execution (bypass schedule).
   */
  trigger(id: string): Effect.Effect<ContinuousTriggerResponse, ClientError>;

  /**
   * Get current status.
   */
  status(id: string): Effect.Effect<ContinuousStatusResponse, ClientError>;

  /**
   * Get current state.
   */
  getState(id: string): Effect.Effect<ContinuousGetStateResponse, ClientError>;
}

/**
 * Type-safe client for debounce jobs.
 */
export interface DebounceClient<I, S> {
  /**
   * Add an event to the debounce.
   *
   * Creates the debounce if it doesn't exist.
   * The id serves as both instance identifier and idempotency key.
   */
  add(options: {
    readonly id: string;
    readonly event: I;
  }): Effect.Effect<DebounceAddResponse, ClientError>;

  /**
   * Manually flush the debounce.
   */
  flush(id: string): Effect.Effect<DebounceFlushResponse, ClientError>;

  /**
   * Clear the debounce without processing.
   */
  clear(id: string): Effect.Effect<DebounceClearResponse, ClientError>;

  /**
   * Get current status.
   */
  status(id: string): Effect.Effect<DebounceStatusResponse, ClientError>;

  /**
   * Get current accumulated state.
   */
  getState(id: string): Effect.Effect<DebounceGetStateResponse, ClientError>;
}

/**
 * Type-safe client for workerPool jobs.
 */
export interface WorkerPoolClient<E> {
  /**
   * Enqueue an event for processing.
   *
   * @param options.id - Unique event ID for idempotency
   * @param options.event - The event data
   * @param options.partitionKey - Optional partition key for routing
   * @param options.priority - Optional priority (higher = processed first)
   */
  enqueue(options: {
    readonly id: string;
    readonly event: E;
    readonly partitionKey?: string;
    readonly priority?: number;
  }): Effect.Effect<WorkerPoolEnqueueResponse, ClientError>;

  /**
   * Pause processing on all or specific instance.
   */
  pause(instanceIndex?: number): Effect.Effect<WorkerPoolPauseResponse, ClientError>;

  /**
   * Resume processing on all or specific instance.
   */
  resume(
    instanceIndex?: number
  ): Effect.Effect<WorkerPoolResumeResponse, ClientError>;

  /**
   * Cancel a pending event.
   */
  cancel(eventId: string): Effect.Effect<WorkerPoolCancelResponse, ClientError>;

  /**
   * Get aggregated status across all instances.
   */
  status(): Effect.Effect<WorkerPoolAggregatedStatus, ClientError>;

  /**
   * Get status for a specific instance.
   */
  instanceStatus(
    instanceIndex: number
  ): Effect.Effect<WorkerPoolStatusResponse, ClientError>;

  /**
   * Drain all pending events (cancel and cleanup).
   */
  drain(instanceIndex?: number): Effect.Effect<WorkerPoolDrainResponse, ClientError>;
}

/**
 * Aggregated workerPool status across all instances.
 */
export interface WorkerPoolAggregatedStatus {
  readonly instances: WorkerPoolStatusResponse[];
  readonly totalPending: number;
  readonly totalProcessed: number;
  readonly activeInstances: number;
  readonly pausedInstances: number;
}

/**
 * Type-safe client for task jobs.
 */
export interface TaskClient<S, E> {
  /**
   * Send an event to a task instance.
   * Creates the instance if it doesn't exist.
   */
  send(options: {
    readonly id: string;
    readonly event: E;
  }): Effect.Effect<TaskSendResponse, ClientError>;

  /**
   * Manually trigger execution.
   */
  trigger(id: string): Effect.Effect<TaskTriggerResponse, ClientError>;

  /**
   * Clear task immediately (delete all state + cancel alarms).
   */
  clear(id: string): Effect.Effect<TaskClearResponse, ClientError>;

  /**
   * Get current status.
   */
  status(id: string): Effect.Effect<TaskStatusResponse, ClientError>;

  /**
   * Get current state.
   */
  getState(id: string): Effect.Effect<TaskGetStateResponse, ClientError>;
}

// =============================================================================
// Client Factory Types
// =============================================================================

/**
 * The jobs client providing access to all registered jobs.
 *
 * Now uses TypedJobRegistry which preserves literal keys via the __definitions property.
 */
export interface JobsClient<R extends TypedJobRegistry<any>> {
  /**
   * Get a typed client for a continuous job.
   */
  continuous<K extends ContinuousKeys<R>>(
    name: K
  ): ContinuousClient<ContinuousStateType<R, K>>;

  /**
   * Get a typed client for a debounce job.
   */
  debounce<K extends DebounceKeys<R>>(
    name: K
  ): DebounceClient<DebounceEventType<R, K>, DebounceStateType<R, K>>;

  /**
   * Get a typed client for a workerPool job.
   */
  workerPool<K extends WorkerPoolKeys<R>>(name: K): WorkerPoolClient<WorkerPoolEventType<R, K>>;

  /**
   * Get a typed client for a task job.
   */
  task<K extends TaskKeys<R>>(name: K): TaskClient<TaskStateType<R, K>, TaskEventType<R, K>>;
}

/**
 * Factory for creating jobs clients.
 */
export interface JobsClientFactory<R extends TypedJobRegistry<any>> {
  /**
   * Create a client from a Durable Object binding.
   */
  fromBinding(binding: DurableObjectNamespace): JobsClient<R>;

  /**
   * Effect Tag for using the client as a service.
   */
  Tag: Context.Tag<JobsClient<R>, JobsClient<R>>;
}

// =============================================================================
// Type Helpers - Simplified with TypedJobRegistry
// =============================================================================

/**
 * Extract the definitions type from a TypedJobRegistry.
 */
type DefinitionsOf<R extends TypedJobRegistry<any>> =
  R extends TypedJobRegistry<infer T> ? T : never;

/**
 * Extract continuous job keys from registry.
 *
 * Simplified: directly uses ContinuousKeysOf from the __definitions type.
 */
export type ContinuousKeys<R extends TypedJobRegistry<any>> =
  ContinuousKeysOf<DefinitionsOf<R>>;

/**
 * Extract debounce job keys from registry.
 */
export type DebounceKeys<R extends TypedJobRegistry<any>> =
  DebounceKeysOf<DefinitionsOf<R>>;

/**
 * Extract workerPool job keys from registry.
 */
export type WorkerPoolKeys<R extends TypedJobRegistry<any>> =
  WorkerPoolKeysOf<DefinitionsOf<R>>;

/**
 * Extract task job keys from registry.
 */
export type TaskKeys<R extends TypedJobRegistry<any>> =
  TaskKeysOf<DefinitionsOf<R>>;

/**
 * Extract state type from continuous definition.
 */
export type ContinuousStateType<
  R extends TypedJobRegistry<any>,
  K extends ContinuousKeys<R>,
> = ContinuousStateOf<DefinitionsOf<R>, K>;

/**
 * Extract event type from debounce definition.
 */
export type DebounceEventType<
  R extends TypedJobRegistry<any>,
  K extends DebounceKeys<R>,
> = DebounceEventOf<DefinitionsOf<R>, K>;

/**
 * Extract state type from debounce definition.
 */
export type DebounceStateType<
  R extends TypedJobRegistry<any>,
  K extends DebounceKeys<R>,
> = DebounceStateOf<DefinitionsOf<R>, K>;

/**
 * Extract event type from workerPool definition.
 */
export type WorkerPoolEventType<
  R extends TypedJobRegistry<any>,
  K extends WorkerPoolKeys<R>,
> = WorkerPoolEventOf<DefinitionsOf<R>, K>;

/**
 * Extract state type from task definition.
 */
export type TaskStateType<
  R extends TypedJobRegistry<any>,
  K extends TaskKeys<R>,
> = TaskStateOf<DefinitionsOf<R>, K>;

/**
 * Extract event type from task definition.
 */
export type TaskEventType<
  R extends TypedJobRegistry<any>,
  K extends TaskKeys<R>,
> = TaskEventOf<DefinitionsOf<R>, K>;
