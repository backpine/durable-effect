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

export interface ExecuteOptions<S, E, R, Ctx> {
  readonly jobType: "continuous" | "debounce" | "task" | "workerPool";
  readonly jobName: string;
  readonly schema: Schema.Schema<S, any, never>;
  readonly retryConfig?: JobRetryConfig;
  readonly runCount?: number;
  readonly allowNullState?: boolean;
  /** User-provided ID for business logic correlation (included in events) */
  readonly id?: string;
  /** Include pre-execution state in tracking events (default: true) */
  readonly includeStateInEvents?: boolean;

  readonly run: (ctx: Ctx) => Effect.Effect<void, E, R>;
  readonly createContext: (base: ExecutionContextBase<S>) => Ctx;
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
              id,
              includeStateInEvents = true,
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

            // Capture pre-execution state snapshot for tracking events
            // This is the state BEFORE user code runs
            const preExecutionState = includeStateInEvents
              ? loadedState
              : undefined;

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
                  // error.attempt is the NEXT attempt; subtract 1 to get the attempt that just failed
                  const failedAttempt = error.attempt - 1;
                  // Emit job.failed event with willRetry: true
                  return emitEvent({
                    ...createJobBaseEvent(
                      runtime.instanceId,
                      jobType,
                      jobName,
                      id,
                    ),
                    type: "job.failed" as const,
                    error: {
                      message: `Retry scheduled for attempt ${error.attempt}`,
                    },
                    runCount: options.runCount ?? 0,
                    attempt: failedAttempt,
                    willRetry: true,
                    ...(preExecutionState !== undefined && { preExecutionState }),
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

                  // Terminate and purge state when retries exhausted
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
                    jobType,
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
                  ...(preExecutionState !== undefined && { preExecutionState }),
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
                ...(preExecutionState !== undefined && { preExecutionState }),
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
          "execution",
        ),
    };
  }),
);
