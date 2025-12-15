// packages/jobs/src/registry/types.ts

import type { Schema } from "effect";
import type { Effect, Duration } from "effect";
import type { JobRetryConfig } from "../retry/types";

// =============================================================================
// Schedule Types
// =============================================================================

/**
 * Schedule for continuous jobs.
 */
export type ContinuousSchedule =
  | { readonly _tag: "Every"; readonly interval: Duration.DurationInput }
  | { readonly _tag: "Cron"; readonly expression: string };

// =============================================================================
// Unregistered Definition Types (what user creates - no name)
// =============================================================================

/**
 * Unregistered continuous job definition.
 * Created by Continuous.make() - does not have a name yet.
 * Name is assigned when registered via createDurableJobs().
 */
export interface UnregisteredContinuousDefinition<
  S = unknown,
  E = unknown,
  R = never,
> {
  readonly _tag: "ContinuousDefinition";
  /** Schema for state - encoded type can be anything (typically same as S for simple schemas) */
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;
  /**
   * Optional retry configuration for execute handler failures.
   *
   * When configured:
   * - Failed executions are retried up to maxAttempts times
   * - Retries are scheduled via alarm (durable, survives restarts)
   * - After all retries exhausted, onError is called (if defined)
   * - Schedule continues after retry success OR exhaustion
   *
   * When not configured:
   * - Failed executions call onError immediately (if defined)
   * - Schedule continues regardless of error
   */
  readonly retry?: JobRetryConfig<E>;
  /** Function to execute on schedule */
  execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, R>;
  /** Optional error handler - uses method syntax for bivariant type checking */
  onError?(error: E, ctx: ContinuousContext<S>): Effect.Effect<void, never, R>;
}

/**
 * Unregistered debounce job definition.
 * Created by Debounce.make() - does not have a name yet.
 */
export interface UnregisteredDebounceDefinition<
  I = unknown,
  S = unknown,
  E = unknown,
  R = never,
> {
  readonly _tag: "DebounceDefinition";
  readonly eventSchema: Schema.Schema<I, any, never>;
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly flushAfter: Duration.DurationInput;
  readonly maxEvents?: number;
  /**
   * Optional retry configuration for flush/execute handler failures.
   *
   * When configured:
   * - Failed flush executions are retried up to maxAttempts times
   * - Events remain in buffer during retry attempts
   * - Retries are scheduled via alarm
   * - After all retries exhausted, onError is called, then cleanup
   *
   * When not configured:
   * - Failed flush calls onError immediately (if defined)
   * - Cleanup happens regardless of error
   */
  readonly retry?: JobRetryConfig<E>;
  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, E, R>;
  onEvent?(ctx: DebounceEventContext<I, S>): Effect.Effect<S, never, R>;
  onError?(error: E, ctx: DebounceExecuteContext<S>): Effect.Effect<void, never, R>;
}

/**
 * Retry configuration for workerPool jobs.
 */
export interface WorkerPoolRetryConfig {
  readonly maxAttempts: number;
  readonly initialDelay: Duration.DurationInput;
  readonly maxDelay?: Duration.DurationInput;
  readonly backoffMultiplier?: number;
}

/**
 * Unregistered workerPool job definition.
 * Created by WorkerPool.make() - does not have a name yet.
 */
export interface UnregisteredWorkerPoolDefinition<
  E = unknown,
  Err = unknown,
  R = never,
> {
  readonly _tag: "WorkerPoolDefinition";
  readonly eventSchema: Schema.Schema<E, any, never>;
  readonly concurrency: number;
  readonly retry?: WorkerPoolRetryConfig;
  execute(ctx: WorkerPoolExecuteContext<E>): Effect.Effect<void, Err, R>;
  onDeadLetter?(event: E, error: Err, ctx: WorkerPoolDeadLetterContext): Effect.Effect<void, never, R>;
  onEmpty?(ctx: WorkerPoolEmptyContext): Effect.Effect<void, never, R>;
}

/**
 * Union of all unregistered job definition types.
 *
 * Note: Error types use `unknown` to accept definitions with any error type.
 * The stored types (below) handle the runtime representation with unknown errors.
 */
export type AnyUnregisteredDefinition =
  | UnregisteredContinuousDefinition<any, unknown, any>
  | UnregisteredDebounceDefinition<any, any, unknown, any>
  | UnregisteredWorkerPoolDefinition<any, unknown, any>;

// =============================================================================
// Stored Definition Types (error type widened to unknown for registry storage)
// =============================================================================

/**
 * Retry config with error type widened to unknown for storage.
 * Uses method syntax for callbacks to match JobRetryConfig bivariance.
 */
export interface StoredJobRetryConfig {
  readonly maxAttempts: number;
  readonly delay?: import("@durable-effect/core").RetryDelay;
  readonly jitter?: boolean;
  readonly maxDuration?: Duration.DurationInput;
  isRetryable?(error: unknown): boolean;
  onRetryExhausted?(info: {
    readonly jobType: "continuous" | "debounce";
    readonly jobName: string;
    readonly instanceId: string;
    readonly attempts: number;
    readonly lastError: unknown;
    readonly totalDurationMs: number;
  }): void;
}

/**
 * Stored continuous job definition (error type widened to unknown).
 */
export interface StoredContinuousDefinition<S = unknown, R = never> {
  readonly _tag: "ContinuousDefinition";
  readonly name: string;
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;
  readonly retry?: StoredJobRetryConfig;
  execute(ctx: ContinuousContext<S>): Effect.Effect<void, unknown, R>;
  onError?(error: unknown, ctx: ContinuousContext<S>): Effect.Effect<void, never, R>;
}

/**
 * Stored debounce job definition (error type widened to unknown).
 */
export interface StoredDebounceDefinition<I = unknown, S = unknown, R = never> {
  readonly _tag: "DebounceDefinition";
  readonly name: string;
  readonly eventSchema: Schema.Schema<I, any, never>;
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly flushAfter: Duration.DurationInput;
  readonly maxEvents?: number;
  readonly retry?: StoredJobRetryConfig;
  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, unknown, R>;
  onEvent?(ctx: DebounceEventContext<I, S>): Effect.Effect<S, never, R>;
  onError?(error: unknown, ctx: DebounceExecuteContext<S>): Effect.Effect<void, never, R>;
}

/**
 * Stored workerPool job definition (error type widened to unknown).
 */
export interface StoredWorkerPoolDefinition<E = unknown, R = never> {
  readonly _tag: "WorkerPoolDefinition";
  readonly name: string;
  readonly eventSchema: Schema.Schema<E, any, never>;
  readonly concurrency: number;
  readonly retry?: WorkerPoolRetryConfig;
  execute(ctx: WorkerPoolExecuteContext<E>): Effect.Effect<void, unknown, R>;
  onDeadLetter?(event: E, error: unknown, ctx: WorkerPoolDeadLetterContext): Effect.Effect<void, never, R>;
  onEmpty?(ctx: WorkerPoolEmptyContext): Effect.Effect<void, never, R>;
}

// =============================================================================
// Registered Definition Types (with name - stored in registry)
// =============================================================================

/**
 * Continuous job definition with name (after registration).
 */
export interface ContinuousDefinition<
  S = unknown,
  E = unknown,
  R = never,
> extends UnregisteredContinuousDefinition<S, E, R> {
  readonly name: string;
}

/**
 * Debounce job definition with name (after registration).
 */
export interface DebounceDefinition<
  I = unknown,
  S = unknown,
  E = unknown,
  R = never,
> extends UnregisteredDebounceDefinition<I, S, E, R> {
  readonly name: string;
}

/**
 * WorkerPool job definition with name (after registration).
 */
export interface WorkerPoolDefinition<
  E = unknown,
  Err = unknown,
  R = never,
> extends UnregisteredWorkerPoolDefinition<E, Err, R> {
  readonly name: string;
}

/**
 * Union of all registered job definition types.
 */
export type AnyJobDefinition =
  | ContinuousDefinition<any, any, any>
  | DebounceDefinition<any, any, any, any>
  | WorkerPoolDefinition<any, any, any>;

// =============================================================================
// Context Types (provided to user functions)
// =============================================================================

/**
 * Options for terminating a continuous job.
 */
export interface TerminateOptions {
  /** Optional reason for termination (stored in metadata) */
  readonly reason?: string;
  /** Whether to purge all state (default: true) */
  readonly purgeState?: boolean;
}

/**
 * Context provided to continuous job execute function.
 */
export interface ContinuousContext<S> {
  /** Current state value (synchronous access) */
  readonly state: S;
  /** Replace the entire state */
  readonly setState: (state: S) => void;
  /** Update state via transformation function */
  readonly updateState: (fn: (current: S) => S) => void;
  /** The unique instance ID for this job instance */
  readonly instanceId: string;
  /** The number of times execute has been called (1-indexed) */
  readonly runCount: number;
  /** The name of this job (as registered) */
  readonly jobName: string;
  /**
   * Current retry attempt (1 = first attempt, 2+ = retry).
   * Only relevant when retry is configured.
   */
  readonly attempt: number;
  /**
   * Whether this execution is a retry of a previous failure.
   */
  readonly isRetry: boolean;

  /**
   * Terminate this job instance.
   *
   * When called, the job will:
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
 * Context provided to debounce job execute function.
 */
export interface DebounceExecuteContext<S> {
  readonly state: Effect.Effect<S, never, never>;
  readonly eventCount: Effect.Effect<number, never, never>;
  readonly instanceId: string;
  readonly debounceStartedAt: Effect.Effect<number, never, never>;
  readonly executionStartedAt: number;
  readonly flushReason: "maxEvents" | "flushAfter" | "manual";
  /**
   * Current retry attempt (1 = first attempt, 2+ = retry).
   * Only relevant when retry is configured.
   */
  readonly attempt: number;
  /**
   * Whether this execution is a retry of a previous failure.
   */
  readonly isRetry: boolean;
}

/**
 * Context provided to debounce job onEvent function.
 *
 * Note: On the first event, `state` equals `event` (auto-initialized).
 * This means `I` should be assignable to `S` for proper type safety.
 */
export interface DebounceEventContext<I, S> {
  readonly event: I;
  readonly state: S;
  readonly eventCount: number;
  readonly instanceId: string;
}

/**
 * Context provided to workerPool job execute function.
 */
export interface WorkerPoolExecuteContext<E> {
  readonly event: E;
  readonly eventId: string;
  readonly attempt: number;
  readonly instanceId: string;
  readonly instanceIndex: number;
  readonly jobName: string;
}

/**
 * Context provided to workerPool job onDeadLetter function.
 */
export interface WorkerPoolDeadLetterContext {
  readonly eventId: string;
  readonly attempts: number;
  readonly instanceId: string;
  readonly instanceIndex: number;
  readonly jobName: string;
}

/**
 * Context provided to workerPool job onEmpty function.
 */
export interface WorkerPoolEmptyContext {
  readonly instanceId: string;
  readonly instanceIndex: number;
  readonly jobName: string;
  readonly processedCount: number;
}

// =============================================================================
// Registry Types
// =============================================================================

/**
 * Registry of job definitions.
 *
 * Organized by job type for efficient lookup.
 */
export interface JobRegistry {
  readonly continuous: Map<string, ContinuousDefinition<any, any, any>>;
  readonly debounce: Map<string, DebounceDefinition<any, any, any, any>>;
  readonly workerPool: Map<string, WorkerPoolDefinition<any, any, any>>;
}

/**
 * Type helper to extract the registry type from a definitions object.
 */
export type InferRegistry<T extends Record<string, AnyJobDefinition>> = {
  continuous: {
    [K in keyof T as T[K] extends ContinuousDefinition<any, any, any>
      ? K
      : never]: T[K] extends ContinuousDefinition<infer S, infer E, infer R>
      ? ContinuousDefinition<S, E, R>
      : never;
  };
  debounce: {
    [K in keyof T as T[K] extends DebounceDefinition<any, any, any, any>
      ? K
      : never]: T[K] extends DebounceDefinition<infer I, infer S, infer E, infer R>
      ? DebounceDefinition<I, S, E, R>
      : never;
  };
  workerPool: {
    [K in keyof T as T[K] extends WorkerPoolDefinition<any, any, any>
      ? K
      : never]: T[K] extends WorkerPoolDefinition<infer E, infer Err, infer R>
      ? WorkerPoolDefinition<E, Err, R>
      : never;
  };
};
