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
   * - After all retries exhausted, job is terminated (state purged)
   *
   * When not configured:
   * - Failed executions fail immediately
   */
  readonly retry?: JobRetryConfig;
  /** Function to execute on schedule */
  execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, R>;
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
   * - After all retries exhausted, job is terminated (state purged)
   *
   * When not configured:
   * - Failed flush fails immediately
   */
  readonly retry?: JobRetryConfig;
  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, E, R>;
  onEvent?(ctx: DebounceEventContext<I, S>): Effect.Effect<S, never, R>;
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
 * Unregistered task job definition.
 * Created by Task.make() - does not have a name yet.
 *
 * Task provides user-controlled durable state machines:
 * - Events update state and optionally schedule execution
 * - Execute runs when alarm fires
 * - User controls lifecycle via schedule/clear
 *
 * Type Parameters:
 * - S: State schema type (decoded)
 * - E: Event schema type (decoded)
 * - Err: Error type from handlers
 * - R: Effect requirements (context)
 */
export interface UnregisteredTaskDefinition<
  S = unknown,
  E = unknown,
  Err = unknown,
  R = never,
> {
  readonly _tag: "TaskDefinition";
  /** Schema for validating and serializing state */
  readonly stateSchema: Schema.Schema<S, any, never>;
  /** Schema for validating incoming events */
  readonly eventSchema: Schema.Schema<E, any, never>;

  /**
   * Handler called for each incoming event.
   * Updates state and optionally schedules execution.
   *
   * @param event - The incoming event (already validated against eventSchema)
   * @param ctx - Context for state access, scheduling, and metadata
   */
  onEvent(event: E, ctx: TaskEventContext<S>): Effect.Effect<void, Err, R>;

  /**
   * Handler called when alarm fires.
   * Processes state and optionally schedules next execution.
   */
  execute(ctx: TaskExecuteContext<S>): Effect.Effect<void, Err, R>;

  /**
   * Optional handler called when either `onEvent` or `execute` completes
   * and no alarm is scheduled.
   */
  onIdle?(ctx: TaskIdleContext<S>): Effect.Effect<void, never, R>;

  /**
   * Optional error handler for onEvent/execute failures.
   * If not provided, errors are logged and task continues.
   */
  onError?(error: Err, ctx: TaskErrorContext<S>): Effect.Effect<void, never, R>;
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
  | UnregisteredWorkerPoolDefinition<any, unknown, any>
  | UnregisteredTaskDefinition<any, any, unknown, any>;

// =============================================================================
// Stored Definition Types (error type widened to unknown for registry storage)
// =============================================================================

/**
 * Retry config with error type widened to unknown for storage.
 * Simplified to only contain timing configuration.
 */
export interface StoredJobRetryConfig {
  readonly maxAttempts: number;
  readonly delay?: import("@durable-effect/core").RetryDelay;
  readonly jitter?: boolean;
  readonly maxDuration?: Duration.DurationInput;
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

/**
 * Stored task job definition (error type widened to unknown).
 */
export interface StoredTaskDefinition<S = unknown, E = unknown, R = never> {
  readonly _tag: "TaskDefinition";
  readonly name: string;
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly eventSchema: Schema.Schema<E, any, never>;
  onEvent(event: E, ctx: TaskEventContext<S>): Effect.Effect<void, unknown, R>;
  execute(ctx: TaskExecuteContext<S>): Effect.Effect<void, unknown, R>;
  onIdle?(ctx: TaskIdleContext<S>): Effect.Effect<void, never, R>;
  onError?(error: unknown, ctx: TaskErrorContext<S>): Effect.Effect<void, never, R>;
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
 * Task job definition with name (after registration).
 */
export interface TaskDefinition<
  S = unknown,
  E = unknown,
  Err = unknown,
  R = never,
> extends UnregisteredTaskDefinition<S, E, Err, R> {
  readonly name: string;
}

/**
 * Union of all registered job definition types.
 */
export type AnyJobDefinition =
  | ContinuousDefinition<any, any, any>
  | DebounceDefinition<any, any, any, any>
  | WorkerPoolDefinition<any, any, any>
  | TaskDefinition<any, any, any, any>;

// =============================================================================
// Context Types (provided to user functions)
// =============================================================================

/**
 * Options for terminating a continuous job.
 */
export interface TerminateOptions {
  /** Optional reason for termination */
  readonly reason?: string;
}

/**
 * Context provided to continuous job execute function.
 */
export interface ContinuousContext<S> {
  /** Current state value */
  readonly state: Effect.Effect<S, never, never>;
  /** Replace the entire state */
  readonly setState: (state: S) => Effect.Effect<void, never, never>;
  /** Update state via transformation function */
  readonly updateState: (fn: (current: S) => S) => Effect.Effect<void, never, never>;
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
   * 2. Delete all state from storage
   * 3. Short-circuit the current execution (no further code runs)
   *
   * @param options.reason - Optional reason for termination
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
// Task Context Types
// =============================================================================

/**
 * Context provided to task onEvent handler.
 *
 * The event is passed as the first parameter to onEvent, not on the context.
 * This makes it clear that the event is a direct value, not an Effect.
 *
 * The onEvent handler receives each incoming event and should:
 * - Update state based on the event
 * - Schedule execution if needed (via ctx.schedule)
 * - Optionally terminate the task (via ctx.terminate)
 */
export interface TaskEventContext<S> {
  // State access (Effect-based)
  /** Current state (null if no state set yet) */
  readonly state: Effect.Effect<S | null, never, never>;

  // State mutations
  /** Replace the entire state */
  readonly setState: (state: S) => Effect.Effect<void, never, never>;
  /** Update state via transformation function (no-op if state is null) */
  readonly updateState: (fn: (current: S) => S) => Effect.Effect<void, never, never>;

  // Scheduling
  /**
   * Schedule execution at a specific time.
   * @param when - Duration from now, timestamp (ms), or Date
   */
  readonly schedule: (when: Duration.DurationInput | number | Date) => Effect.Effect<void, never, never>;
  /** Cancel any scheduled execution */
  readonly cancelSchedule: () => Effect.Effect<void, never, never>;
  /** Get the currently scheduled execution time (null if none) */
  readonly getScheduledTime: () => Effect.Effect<number | null, never, never>;

  // Cleanup
  /**
   * Terminate this task - cancel alarms and delete all state.
   * Short-circuits the current handler (no further code runs).
   */
  readonly terminate: () => Effect.Effect<never, never, never>;

  // Metadata (synchronous)
  /** The unique instance ID for this task */
  readonly instanceId: string;
  /** The name of this job (as registered) */
  readonly jobName: string;
  /** When this handler invocation started (ms since epoch) */
  readonly executionStartedAt: number;
  /** True if this is the first event (state was null) */
  readonly isFirstEvent: boolean;

  // Metadata (Effects)
  /** Total number of events received (Effect for lazy loading) */
  readonly eventCount: Effect.Effect<number, never, never>;
  /** When this task was created (Effect for lazy loading) */
  readonly createdAt: Effect.Effect<number, never, never>;
}

/**
 * Context provided to task execute handler.
 *
 * The execute handler runs when an alarm fires and should:
 * - Process the current state
 * - Schedule next execution if needed
 * - Clear the task when complete
 */
export interface TaskExecuteContext<S> {
  // State access (Effect - loaded on demand)
  /** Get current state (null if no state set) */
  readonly state: Effect.Effect<S | null, never, never>;

  // State mutations
  /** Replace the entire state */
  readonly setState: (state: S) => Effect.Effect<void, never, never>;
  /** Update state via transformation function */
  readonly updateState: (fn: (current: S) => S) => Effect.Effect<void, never, never>;

  // Scheduling
  /**
   * Schedule next execution at a specific time.
   * @param when - Duration from now, timestamp (ms), or Date
   */
  readonly schedule: (when: Duration.DurationInput | number | Date) => Effect.Effect<void, never, never>;
  /** Cancel any scheduled execution */
  readonly cancelSchedule: () => Effect.Effect<void, never, never>;
  /** Get the currently scheduled execution time (null if none) */
  readonly getScheduledTime: () => Effect.Effect<number | null, never, never>;

  // Cleanup
  /**
   * Terminate this task - cancel alarms and delete all state.
   * Short-circuits the current handler.
   */
  readonly terminate: () => Effect.Effect<never, never, never>;

  // Metadata
  /** The unique instance ID for this task */
  readonly instanceId: string;
  /** The name of this job (as registered) */
  readonly jobName: string;
  /** When this handler invocation started (ms since epoch) */
  readonly executionStartedAt: number;

  // Metadata (Effects)
  /** Total number of events received */
  readonly eventCount: Effect.Effect<number, never, never>;
  /** When this task was created */
  readonly createdAt: Effect.Effect<number, never, never>;
  /** Number of times execute has been called (1-indexed) */
  readonly executeCount: Effect.Effect<number, never, never>;
}

/**
 * Context provided to task onIdle handler.
 *
 * Called when either onEvent or execute completes without scheduling
 * another execution. Use this to schedule cleanup or maintenance.
 */
export interface TaskIdleContext<S> {
  /** Get current state */
  readonly state: Effect.Effect<S | null, never, never>;
  /** Schedule execution (e.g., for delayed cleanup) */
  readonly schedule: (when: Duration.DurationInput | number | Date) => Effect.Effect<void, never, never>;
  /** Terminate the task immediately - cancel alarms and delete all state */
  readonly terminate: () => Effect.Effect<never, never, never>;

  /** The unique instance ID for this task */
  readonly instanceId: string;
  /** The name of this job (as registered) */
  readonly jobName: string;
  /** What triggered the idle state */
  readonly idleReason: "onEvent" | "execute";
}

/**
 * Context provided to task onError handler.
 *
 * Called when onEvent or execute throws an error.
 * Use this to log errors, update state, or schedule retries.
 */
export interface TaskErrorContext<S> {
  /** Get current state */
  readonly state: Effect.Effect<S | null, never, never>;
  /** Update state (e.g., to track error count) */
  readonly updateState: (fn: (current: S) => S) => Effect.Effect<void, never, never>;
  /** Schedule execution (e.g., for retry) */
  readonly schedule: (when: Duration.DurationInput | number | Date) => Effect.Effect<void, never, never>;
  /** Terminate the task immediately - cancel alarms and delete all state */
  readonly terminate: () => Effect.Effect<never, never, never>;

  /** The unique instance ID for this task */
  readonly instanceId: string;
  /** The name of this job (as registered) */
  readonly jobName: string;
  /** Which handler produced the error */
  readonly errorSource: "onEvent" | "execute";
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
