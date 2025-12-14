// packages/jobs/src/client/types.ts

import type { Context, Effect } from "effect";
import type {
  JobRegistry,
  UnregisteredContinuousDefinition,
  UnregisteredDebounceDefinition,
  UnregisteredWorkerPoolDefinition,
} from "../registry/types";
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
   */
  add(options: {
    readonly id: string;
    readonly event: I;
    readonly eventId?: string;
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

// =============================================================================
// Client Factory Types
// =============================================================================

/**
 * The jobs client providing access to all registered jobs.
 */
export interface JobsClient<R extends JobRegistry> {
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
}

/**
 * Factory for creating jobs clients.
 */
export interface JobsClientFactory<R extends JobRegistry> {
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
// Type Helpers
// =============================================================================

/**
 * Registry with definitions for type inference.
 */
type RegistryWithDefinitions = JobRegistry & {
  readonly __definitions?: Record<string, unknown>;
};

/**
 * Extract continuous job keys from registry.
 * Uses __definitions if available for better type inference.
 */
export type ContinuousKeys<R extends JobRegistry> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? Extract<
          {
            [K in keyof R["__definitions"]]: R["__definitions"][K] extends UnregisteredContinuousDefinition<
              any,
              any,
              any
            >
              ? K
              : never;
          }[keyof R["__definitions"]],
          string
        >
      : R extends { continuous: Map<infer K, any> }
        ? K & string
        : never
    : R extends { continuous: Map<infer K, any> }
      ? K & string
      : never;

/**
 * Extract debounce job keys from registry.
 */
export type DebounceKeys<R extends JobRegistry> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? Extract<
          {
            [K in keyof R["__definitions"]]: R["__definitions"][K] extends UnregisteredDebounceDefinition<
              any,
              any,
              any,
              any
            >
              ? K
              : never;
          }[keyof R["__definitions"]],
          string
        >
      : R extends { debounce: Map<infer K, any> }
        ? K & string
        : never
    : R extends { debounce: Map<infer K, any> }
      ? K & string
      : never;

/**
 * Extract workerPool job keys from registry.
 */
export type WorkerPoolKeys<R extends JobRegistry> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? Extract<
          {
            [K in keyof R["__definitions"]]: R["__definitions"][K] extends UnregisteredWorkerPoolDefinition<
              any,
              any,
              any
            >
              ? K
              : never;
          }[keyof R["__definitions"]],
          string
        >
      : R extends { workerPool: Map<infer K, any> }
        ? K & string
        : never
    : R extends { workerPool: Map<infer K, any> }
      ? K & string
      : never;

/**
 * Extract state type from continuous definition.
 */
export type ContinuousStateType<R extends JobRegistry, K extends string> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? K extends keyof R["__definitions"]
        ? R["__definitions"][K] extends UnregisteredContinuousDefinition<infer S, any, any>
          ? S
          : unknown
        : unknown
      : unknown
    : unknown;

/**
 * Extract event type from debounce definition.
 */
export type DebounceEventType<R extends JobRegistry, K extends string> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? K extends keyof R["__definitions"]
        ? R["__definitions"][K] extends UnregisteredDebounceDefinition<
            infer I,
            any,
            any,
            any
          >
          ? I
          : unknown
        : unknown
      : unknown
    : unknown;

/**
 * Extract state type from debounce definition.
 */
export type DebounceStateType<R extends JobRegistry, K extends string> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? K extends keyof R["__definitions"]
        ? R["__definitions"][K] extends UnregisteredDebounceDefinition<
            any,
            infer S,
            any,
            any
          >
          ? S
          : unknown
        : unknown
      : unknown
    : unknown;

/**
 * Extract event type from workerPool definition.
 */
export type WorkerPoolEventType<R extends JobRegistry, K extends string> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? K extends keyof R["__definitions"]
        ? R["__definitions"][K] extends UnregisteredWorkerPoolDefinition<infer E, any, any>
          ? E
          : unknown
        : unknown
      : unknown
    : unknown;
