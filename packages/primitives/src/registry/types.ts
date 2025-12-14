// packages/primitives/src/registry/types.ts

import type { Schema } from "effect";
import type { Effect, Duration } from "effect";

// =============================================================================
// Schedule Types
// =============================================================================

/**
 * Schedule for continuous primitives.
 */
export type ContinuousSchedule =
  | { readonly _tag: "Every"; readonly interval: Duration.DurationInput }
  | { readonly _tag: "Cron"; readonly expression: string };

// =============================================================================
// Definition Types
// =============================================================================

/**
 * Base definition shape shared by all primitives.
 */
export interface PrimitiveDefinitionBase {
  readonly _tag: "continuous" | "buffer" | "queue";
  readonly name: string;
}

/**
 * Continuous primitive definition.
 *
 * Continuous primitives execute a function on a schedule.
 */
export interface ContinuousDefinition<
  S = unknown,
  E = unknown,
  R = never,
> extends PrimitiveDefinitionBase {
  readonly _tag: "continuous";
  /** Schema for state - encoded type can be anything (typically same as S for simple schemas) */
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;
  /** Function to execute on schedule */
  execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, R>;
  /** Optional error handler - uses method syntax for bivariant type checking */
  onError?(error: E, ctx: ContinuousContext<S>): Effect.Effect<void, never, R>;
}

/**
 * Buffer primitive definition.
 *
 * Buffer primitives accumulate events and flush on a schedule or threshold.
 */
export interface BufferDefinition<
  I = unknown,
  S = unknown,
  E = unknown,
  R = never,
> extends PrimitiveDefinitionBase {
  readonly _tag: "buffer";
  readonly eventSchema: Schema.Schema<I, any, never>;
  readonly stateSchema?: Schema.Schema<S, any, never>;
  readonly flushAfter: Duration.DurationInput;
  readonly maxEvents?: number;
  execute(ctx: BufferExecuteContext<S>): Effect.Effect<void, E, R>;
  onEvent?(ctx: BufferEventContext<I, S>): S;
  onError?(error: E, ctx: BufferExecuteContext<S>): Effect.Effect<void, never, R>;
}

/**
 * Retry configuration for queue primitives.
 */
export interface QueueRetryConfig {
  readonly maxAttempts: number;
  readonly initialDelay: Duration.DurationInput;
  readonly maxDelay?: Duration.DurationInput;
  readonly backoffMultiplier?: number;
}

/**
 * Queue primitive definition.
 *
 * Queue primitives process events one at a time with retry support.
 */
export interface QueueDefinition<
  E = unknown,
  Err = unknown,
  R = never,
> extends PrimitiveDefinitionBase {
  readonly _tag: "queue";
  readonly eventSchema: Schema.Schema<E, any, never>;
  readonly concurrency: number;
  readonly retry?: QueueRetryConfig;
  execute(ctx: QueueExecuteContext<E>): Effect.Effect<void, Err, R>;
  onDeadLetter?(event: E, error: Err, ctx: QueueDeadLetterContext): Effect.Effect<void, never, R>;
  onEmpty?(ctx: QueueEmptyContext): Effect.Effect<void, never, R>;
}

/**
 * Union of all primitive definition types.
 */
export type AnyPrimitiveDefinition =
  | ContinuousDefinition<any, any, any>
  | BufferDefinition<any, any, any, any>
  | QueueDefinition<any, any, any>;

// =============================================================================
// Context Types (provided to user functions)
// =============================================================================

/**
 * Options for terminating a continuous primitive.
 */
export interface TerminateOptions {
  /** Optional reason for termination (stored in metadata) */
  readonly reason?: string;
  /** Whether to purge all state (default: true) */
  readonly purgeState?: boolean;
}

/**
 * Context provided to continuous primitive execute function.
 */
export interface ContinuousContext<S> {
  /** Current state value (synchronous access) */
  readonly state: S;
  /** Replace the entire state */
  readonly setState: (state: S) => void;
  /** Update state via transformation function */
  readonly updateState: (fn: (current: S) => S) => void;
  /** The unique instance ID for this primitive instance */
  readonly instanceId: string;
  /** The number of times execute has been called (1-indexed) */
  readonly runCount: number;
  /** The name of this primitive (as registered) */
  readonly primitiveName: string;

  /**
   * Terminate this primitive instance.
   *
   * When called, the primitive will:
   * 1. Cancel any scheduled alarm
   * 2. Update status to "stopped" or "terminated"
   * 3. Optionally purge all state from storage
   * 4. Short-circuit the current execution (no further code runs)
   *
   * @param options.reason - Optional reason for termination
   * @param options.purgeState - Whether to delete all state (default: true)
   * @returns Effect<never> - short-circuits execution
   *
   * @example
   * ```ts
   * if (ctx.state.failureCount > 10) {
   *   return yield* ctx.terminate({ reason: "Too many failures" });
   * }
   * ```
   */
  readonly terminate: (
    options?: TerminateOptions
  ) => Effect.Effect<never, never, never>;
}

/**
 * Context provided to buffer primitive execute function.
 */
export interface BufferExecuteContext<S> {
  readonly state: S;
  readonly eventCount: number;
  readonly instanceId: string;
  readonly primitiveName: string;
}

/**
 * Context provided to buffer primitive onEvent function.
 */
export interface BufferEventContext<I, S> {
  readonly event: I;
  readonly currentState: S | null;
  readonly eventCount: number;
  readonly instanceId: string;
  readonly primitiveName: string;
}

/**
 * Context provided to queue primitive execute function.
 */
export interface QueueExecuteContext<E> {
  readonly event: E;
  readonly eventId: string;
  readonly attempt: number;
  readonly instanceId: string;
  readonly instanceIndex: number;
  readonly primitiveName: string;
}

/**
 * Context provided to queue primitive onDeadLetter function.
 */
export interface QueueDeadLetterContext {
  readonly eventId: string;
  readonly attempts: number;
  readonly instanceId: string;
  readonly instanceIndex: number;
  readonly primitiveName: string;
}

/**
 * Context provided to queue primitive onEmpty function.
 */
export interface QueueEmptyContext {
  readonly instanceId: string;
  readonly instanceIndex: number;
  readonly primitiveName: string;
  readonly processedCount: number;
}

// =============================================================================
// Registry Types
// =============================================================================

/**
 * Registry of primitive definitions.
 *
 * Organized by primitive type for efficient lookup.
 */
export interface PrimitiveRegistry {
  readonly continuous: Map<string, ContinuousDefinition<any, any, any>>;
  readonly buffer: Map<string, BufferDefinition<any, any, any, any>>;
  readonly queue: Map<string, QueueDefinition<any, any, any>>;
}

/**
 * Type helper to extract the registry type from a definitions object.
 */
export type InferRegistry<T extends Record<string, AnyPrimitiveDefinition>> = {
  continuous: {
    [K in keyof T as T[K] extends ContinuousDefinition<any, any, any>
      ? K
      : never]: T[K] extends ContinuousDefinition<infer S, infer E, infer R>
      ? ContinuousDefinition<S, E, R>
      : never;
  };
  buffer: {
    [K in keyof T as T[K] extends BufferDefinition<any, any, any, any>
      ? K
      : never]: T[K] extends BufferDefinition<infer I, infer S, infer E, infer R>
      ? BufferDefinition<I, S, E, R>
      : never;
  };
  queue: {
    [K in keyof T as T[K] extends QueueDefinition<any, any, any>
      ? K
      : never]: T[K] extends QueueDefinition<infer E, infer Err, infer R>
      ? QueueDefinition<E, Err, R>
      : never;
  };
};
