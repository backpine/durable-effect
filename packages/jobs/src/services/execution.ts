// packages/jobs/src/services/execution.ts

import { Context, Effect, Layer, type Schema } from "effect";
import {
  RuntimeAdapter,
  StorageAdapter,
  createJobBaseEvent,
  emitEvent,
  type InternalJobExecutedEvent,
  type InternalJobFailedEvent,
  type InternalJobRetryExhaustedEvent,
  type JobType,
} from "@durable-effect/core";
import {
  RetryExecutor,
  RetryExhaustedSignal,
  RetryScheduledSignal,
  type JobRetryConfig,
} from "../retry";
import { createEntityStateService } from "./entity-state";
import { CleanupService } from "./cleanup";
import { AlarmService } from "./alarm";
import { ExecutionError, TerminateSignal } from "../errors";
import { withLogSpan } from "./job-logging";

// =============================================================================
// Types
// =============================================================================

export interface ExecutionContextBase<S> {
  readonly getState: () => S | null;
  readonly instanceId: string;
  readonly runCount: number;
  readonly attempt: number;
  readonly isRetry: boolean;
  readonly setState: (s: S) => void;
  readonly updateState: (fn: (s: S) => S) => void;
}

/**
 * Context provided to onRetryExhausted handler.
 */
export interface OnRetryExhaustedContext<S> {
  /** Current state (may be null) */
  readonly state: S | null;
  readonly instanceId: string;
  readonly jobName: string;
  /** Number of attempts made before exhaustion */
  readonly attempts: number;
  /** Total time spent retrying (ms) */
  readonly totalDurationMs: number;
  /** Terminate the job - cancel alarm, delete all storage */
  readonly terminate: () => Effect.Effect<void, never, never>;
  /** Reschedule execution - reset retry count, try again later */
  readonly reschedule: (
    delay: import("effect").Duration.DurationInput,
  ) => Effect.Effect<void, never, never>;
  /** Internal: track if terminate was called */
  readonly _terminated: boolean;
  /** Internal: track if reschedule was called */
  readonly _rescheduled: boolean;
}

export interface ExecuteOptions<S, E, R, Ctx> {
  readonly jobType: "continuous" | "debounce" | "task" | "workerPool";
  readonly jobName: string;
  readonly schema: Schema.Schema<S, any, never>;
  readonly retryConfig?: JobRetryConfig;
  readonly runCount?: number;
  readonly allowNullState?: boolean;
  /** User-provided ID for business logic correlation (included in events) */
  readonly id?: string;

  readonly run: (ctx: Ctx) => Effect.Effect<void, E, R>;
  readonly createContext: (base: ExecutionContextBase<S>) => Ctx;

  /**
   * Called when all retry attempts are exhausted.
   * If not provided, the job is terminated (state purged) by default.
   *
   * @param error - The last error (typed)
   * @param ctx - Context with state access and actions (terminate, reschedule)
   */
  readonly onRetryExhausted?: (
    error: E,
    ctx: OnRetryExhaustedContext<S>,
  ) => Effect.Effect<void, never, R>;
}

export interface ExecutionResult {
  readonly success: boolean;
  readonly retryScheduled: boolean;
  readonly terminated: boolean;
  readonly rescheduled: boolean;
  readonly retryExhausted: boolean;
  readonly terminateReason?: string;
}

export interface JobExecutionServiceI {
  readonly execute: <S, E, R, Ctx>(
    options: ExecuteOptions<S, E, R, Ctx>,
  ) => Effect.Effect<ExecutionResult, ExecutionError, R>;
}

// =============================================================================
// Service Tag
// =============================================================================

export class JobExecutionService extends Context.Tag(
  "@durable-effect/jobs/JobExecutionService",
)<JobExecutionService, JobExecutionServiceI>() {}

// =============================================================================
// Implementation
// =============================================================================

export const JobExecutionServiceLayer = Layer.effect(
  JobExecutionService,
  Effect.gen(function* () {
    const runtime = yield* RuntimeAdapter;
    const storage = yield* StorageAdapter;
    const retryExecutor = yield* RetryExecutor;
    const cleanup = yield* CleanupService;

    const withStorage = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, Exclude<R, StorageAdapter>> =>
      Effect.provideService(effect, StorageAdapter, storage);

    return {
      execute: <S, E, R, Ctx>(
        options: ExecuteOptions<S, E, R, Ctx>,
      ): Effect.Effect<ExecutionResult, ExecutionError, R> =>
        withLogSpan(
          Effect.gen(function* () {
            const {
              jobType,
              jobName,
              schema,
              retryConfig,
              run,
              createContext,
              onRetryExhausted,
              id,
            } = options;

          // Track execution start time for duration calculation
          const startTime = Date.now();

          const stateService = yield* withStorage(
            createEntityStateService(schema),
          );

          const loadedState = yield* stateService.get().pipe(
            withStorage,
            Effect.mapError(
              (e) =>
                new ExecutionError({
                  jobType,
                  jobName,
                  instanceId: runtime.instanceId,
                  cause: e,
                }),
            ),
          );

          // If no state and not allowed, treat as already terminated
          if (loadedState === null && !options.allowNullState) {
            return {
              success: false,
              retryScheduled: false,
              terminated: true,
              rescheduled: false,
              retryExhausted: false,
            };
          }

          const stateHolder = {
            current: loadedState as S | null,
            dirty: false,
          };

          const setState = (s: S) => {
            stateHolder.current = s;
            stateHolder.dirty = true;
          };

          const updateState = (fn: (s: S) => S) => {
            if (stateHolder.current !== null) {
              stateHolder.current = fn(stateHolder.current as S);
              stateHolder.dirty = true;
            }
          };

          const attempt = yield* retryExecutor
            .getAttempt()
            .pipe(Effect.catchAll(() => Effect.succeed(1)));
          const isRetry = attempt > 1;

          const ctx = createContext({
            getState: () => stateHolder.current,
            instanceId: runtime.instanceId,
            runCount: options.runCount ?? 0,
            attempt,
            isRetry,
            setState,
            updateState,
          });

          const executeUserLogic = run(ctx);

          // Build execution effect with optional retry
          const executionEffect = retryConfig
            ? retryExecutor.executeWithRetry(executeUserLogic, retryConfig, {
                jobType,
                jobName,
              })
            : executeUserLogic;

          // Result tracking
          let success = false;
          let retryScheduled = false;
          let terminated = false;
          let rescheduled = false;
          let retryExhausted = false;
          let terminateReason: string | undefined = undefined;

          const wrapError = (e: unknown) =>
            e instanceof ExecutionError
              ? e
              : new ExecutionError({
                  jobType,
                  jobName,
                  instanceId: runtime.instanceId,
                  cause: e,
                });

          // Execute and handle signals
          yield* executionEffect.pipe(
            Effect.catchAll((error) => {
              // Handle retry scheduled signal
              if (error instanceof RetryScheduledSignal) {
                retryScheduled = true;
                // Emit job.failed event with willRetry: true
                return emitEvent({
                  ...createJobBaseEvent(
                    runtime.instanceId,
                    jobType as JobType,
                    jobName,
                    id,
                  ),
                  type: "job.failed" as const,
                  error: {
                    message: `Retry scheduled for attempt ${error.attempt + 1}`,
                  },
                  runCount: options.runCount ?? 0,
                  attempt: error.attempt,
                  willRetry: true,
                } satisfies InternalJobFailedEvent);
              }

              // Handle terminate signal (from ctx.terminate())
              if (error instanceof TerminateSignal) {
                terminated = true;
                terminateReason = error.reason;
                return cleanup.terminate().pipe(
                  Effect.catchAll(() => Effect.void), // Ignore cleanup errors
                );
              }

              // Handle retry exhausted signal
              if (error instanceof RetryExhaustedSignal) {
                retryExhausted = true;

                // Emit job.retryExhausted event then continue with handler logic
                const retryExhaustedEvent = emitEvent({
                  ...createJobBaseEvent(
                    runtime.instanceId,
                    jobType,
                    jobName,
                    id,
                  ),
                  type: "job.retryExhausted" as const,
                  attempts: error.attempts,
                  reason: "max_attempts" as const,
                } satisfies InternalJobRetryExhaustedEvent);

                if (onRetryExhausted) {
                  // User has handler - create context and call it
                  const exhaustedCtx: OnRetryExhaustedContext<S> = {
                    state: stateHolder.current,
                    instanceId: runtime.instanceId,
                    jobName,
                    attempts: error.attempts,
                    totalDurationMs: error.totalDurationMs,
                    _terminated: false,
                    _rescheduled: false,
                    terminate: () =>
                      cleanup.terminate().pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            (exhaustedCtx as any)._terminated = true;
                            terminated = true;
                          }),
                        ),
                        Effect.catchAll(() => Effect.void),
                      ),
                    reschedule: (delay) =>
                      Effect.gen(function* () {
                        const alarm = yield* AlarmService;
                        yield* alarm.schedule(delay);
                        (exhaustedCtx as any)._rescheduled = true;
                        rescheduled = true;
                      }).pipe(
                        Effect.catchAll(() => Effect.void),
                      ) as Effect.Effect<void, never, never>,
                  };

                  return retryExhaustedEvent.pipe(
                    Effect.zipRight(
                      (
                        onRetryExhausted(
                          error.lastError as E,
                          exhaustedCtx,
                        ) as Effect.Effect<void, never, any>
                      ).pipe(
                        Effect.tap(() => {
                          // If user didn't take action, leave state intact (paused)
                          terminated = exhaustedCtx._terminated;
                          rescheduled = exhaustedCtx._rescheduled;
                        }),
                        Effect.catchAll(() => Effect.void),
                      ),
                    ),
                  );
                }

                // No handler - default behavior: terminate (purge everything)
                terminated = true;
                terminateReason = `Retry exhausted after ${error.attempts} attempts`;
                return retryExhaustedEvent.pipe(
                  Effect.zipRight(
                    cleanup
                      .terminate()
                      .pipe(Effect.catchAll(() => Effect.void)),
                  ),
                );
              }

              // Unknown/unhandled error - emit job.failed event with willRetry: false
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              const errorStack =
                error instanceof Error ? error.stack : undefined;
              return emitEvent({
                ...createJobBaseEvent(
                  runtime.instanceId,
                  jobType as JobType,
                  jobName,
                  id,
                ),
                type: "job.failed" as const,
                error: {
                  message: errorMessage,
                  stack: errorStack,
                },
                runCount: options.runCount ?? 0,
                attempt,
                willRetry: false,
              } satisfies InternalJobFailedEvent).pipe(
                Effect.zipRight(Effect.fail(wrapError(error))),
              );
            }),
          );

          // Determine success
          if (
            !retryScheduled &&
            !terminated &&
            !rescheduled &&
            !retryExhausted
          ) {
            success = true;
            // Emit job.executed event on success
            const durationMs = Date.now() - startTime;
            yield* emitEvent({
              ...createJobBaseEvent(
                runtime.instanceId,
                jobType as JobType,
                jobName,
                id,
              ),
              type: "job.executed" as const,
              runCount: options.runCount ?? 0,
              durationMs,
              attempt,
            } satisfies InternalJobExecutedEvent);
          }

          // Save state if modified and not terminated
          if (
            stateHolder.dirty &&
            !terminated &&
            !retryScheduled &&
            stateHolder.current !== null
          ) {
            yield* stateService
              .set(stateHolder.current as S)
              .pipe(withStorage, Effect.mapError(wrapError));
          }

          return {
            success,
            retryScheduled,
            terminated,
            rescheduled,
            retryExhausted,
            terminateReason,
          };
        }),
          "execution"
        ),
    };
  }),
);
