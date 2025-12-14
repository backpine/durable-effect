// packages/primitives/src/client/types.ts

import type { Context, Effect } from "effect";
import type {
  PrimitiveRegistry,
  UnregisteredContinuousDefinition,
  UnregisteredBufferDefinition,
  UnregisteredQueueDefinition,
} from "../registry/types";
import type {
  ContinuousStartResponse,
  ContinuousStopResponse,
  ContinuousTriggerResponse,
  ContinuousStatusResponse,
  ContinuousGetStateResponse,
  BufferAddResponse,
  BufferFlushResponse,
  BufferClearResponse,
  BufferStatusResponse,
  BufferGetStateResponse,
  QueueEnqueueResponse,
  QueuePauseResponse,
  QueueResumeResponse,
  QueueCancelResponse,
  QueueStatusResponse,
  QueueDrainResponse,
} from "../runtime/types";
import type {
  UnexpectedResponseError,
  PrimitiveCallError,
} from "./response";

// =============================================================================
// Client Error Type
// =============================================================================

/**
 * Combined error type for client operations.
 */
export type ClientError = PrimitiveCallError | UnexpectedResponseError;

// Re-export for convenience
export type { PrimitiveCallError, UnexpectedResponseError };

// =============================================================================
// Client Instance Types
// =============================================================================

/**
 * Type-safe client for continuous primitives.
 */
export interface ContinuousClient<S> {
  /**
   * Start the continuous primitive with initial state.
   *
   * If the instance already exists, returns its current status.
   */
  start(options: {
    readonly id: string;
    readonly input: S;
  }): Effect.Effect<ContinuousStartResponse, ClientError>;

  /**
   * Stop the continuous primitive.
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
 * Type-safe client for buffer primitives.
 */
export interface BufferClient<I, S> {
  /**
   * Add an event to the buffer.
   *
   * Creates the buffer if it doesn't exist.
   */
  add(options: {
    readonly id: string;
    readonly event: I;
    readonly eventId?: string;
  }): Effect.Effect<BufferAddResponse, ClientError>;

  /**
   * Manually flush the buffer.
   */
  flush(id: string): Effect.Effect<BufferFlushResponse, ClientError>;

  /**
   * Clear the buffer without processing.
   */
  clear(id: string): Effect.Effect<BufferClearResponse, ClientError>;

  /**
   * Get current status.
   */
  status(id: string): Effect.Effect<BufferStatusResponse, ClientError>;

  /**
   * Get current accumulated state.
   */
  getState(id: string): Effect.Effect<BufferGetStateResponse, ClientError>;
}

/**
 * Type-safe client for queue primitives.
 */
export interface QueueClient<E> {
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
  }): Effect.Effect<QueueEnqueueResponse, ClientError>;

  /**
   * Pause processing on all or specific instance.
   */
  pause(instanceIndex?: number): Effect.Effect<QueuePauseResponse, ClientError>;

  /**
   * Resume processing on all or specific instance.
   */
  resume(
    instanceIndex?: number
  ): Effect.Effect<QueueResumeResponse, ClientError>;

  /**
   * Cancel a pending event.
   */
  cancel(eventId: string): Effect.Effect<QueueCancelResponse, ClientError>;

  /**
   * Get aggregated status across all instances.
   */
  status(): Effect.Effect<QueueAggregatedStatus, ClientError>;

  /**
   * Get status for a specific instance.
   */
  instanceStatus(
    instanceIndex: number
  ): Effect.Effect<QueueStatusResponse, ClientError>;

  /**
   * Drain all pending events (cancel and cleanup).
   */
  drain(instanceIndex?: number): Effect.Effect<QueueDrainResponse, ClientError>;
}

/**
 * Aggregated queue status across all instances.
 */
export interface QueueAggregatedStatus {
  readonly instances: QueueStatusResponse[];
  readonly totalPending: number;
  readonly totalProcessed: number;
  readonly activeInstances: number;
  readonly pausedInstances: number;
}

// =============================================================================
// Client Factory Types
// =============================================================================

/**
 * The primitives client providing access to all registered primitives.
 */
export interface PrimitivesClient<R extends PrimitiveRegistry> {
  /**
   * Get a typed client for a continuous primitive.
   */
  continuous<K extends ContinuousKeys<R>>(
    name: K
  ): ContinuousClient<ContinuousStateType<R, K>>;

  /**
   * Get a typed client for a buffer primitive.
   */
  buffer<K extends BufferKeys<R>>(
    name: K
  ): BufferClient<BufferEventType<R, K>, BufferStateType<R, K>>;

  /**
   * Get a typed client for a queue primitive.
   */
  queue<K extends QueueKeys<R>>(name: K): QueueClient<QueueEventType<R, K>>;
}

/**
 * Factory for creating primitives clients.
 */
export interface PrimitivesClientFactory<R extends PrimitiveRegistry> {
  /**
   * Create a client from a Durable Object binding.
   */
  fromBinding(binding: DurableObjectNamespace): PrimitivesClient<R>;

  /**
   * Effect Tag for using the client as a service.
   */
  Tag: Context.Tag<PrimitivesClient<R>, PrimitivesClient<R>>;
}

// =============================================================================
// Type Helpers
// =============================================================================

/**
 * Registry with definitions for type inference.
 */
type RegistryWithDefinitions = PrimitiveRegistry & {
  readonly __definitions?: Record<string, unknown>;
};

/**
 * Extract continuous primitive keys from registry.
 * Uses __definitions if available for better type inference.
 */
export type ContinuousKeys<R extends PrimitiveRegistry> =
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
 * Extract buffer primitive keys from registry.
 */
export type BufferKeys<R extends PrimitiveRegistry> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? Extract<
          {
            [K in keyof R["__definitions"]]: R["__definitions"][K] extends UnregisteredBufferDefinition<
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
      : R extends { buffer: Map<infer K, any> }
        ? K & string
        : never
    : R extends { buffer: Map<infer K, any> }
      ? K & string
      : never;

/**
 * Extract queue primitive keys from registry.
 */
export type QueueKeys<R extends PrimitiveRegistry> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? Extract<
          {
            [K in keyof R["__definitions"]]: R["__definitions"][K] extends UnregisteredQueueDefinition<
              any,
              any,
              any
            >
              ? K
              : never;
          }[keyof R["__definitions"]],
          string
        >
      : R extends { queue: Map<infer K, any> }
        ? K & string
        : never
    : R extends { queue: Map<infer K, any> }
      ? K & string
      : never;

/**
 * Extract state type from continuous definition.
 */
export type ContinuousStateType<R extends PrimitiveRegistry, K extends string> =
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
 * Extract event type from buffer definition.
 */
export type BufferEventType<R extends PrimitiveRegistry, K extends string> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? K extends keyof R["__definitions"]
        ? R["__definitions"][K] extends UnregisteredBufferDefinition<
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
 * Extract state type from buffer definition.
 */
export type BufferStateType<R extends PrimitiveRegistry, K extends string> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? K extends keyof R["__definitions"]
        ? R["__definitions"][K] extends UnregisteredBufferDefinition<
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
 * Extract event type from queue definition.
 */
export type QueueEventType<R extends PrimitiveRegistry, K extends string> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? K extends keyof R["__definitions"]
        ? R["__definitions"][K] extends UnregisteredQueueDefinition<infer E, any, any>
          ? E
          : unknown
        : unknown
      : unknown
    : unknown;
