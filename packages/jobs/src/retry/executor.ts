// packages/jobs/src/retry/executor.ts

import { Context, Effect, Layer, Duration } from "effect";
import {
  StorageAdapter,
  RuntimeAdapter,
  resolveDelay,
  addJitter,
  type StorageError,
} from "@durable-effect/core";
import { AlarmService } from "../services/alarm";
import { KEYS } from "../storage-keys";
import type { JobRetryConfig } from "./types";
import { RetryExhaustedSignal, RetryScheduledSignal } from "./errors";
import { TerminateSignal } from "../errors";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * RetryExecutor handles retry logic for job executions.
 *
 * Key responsibilities:
 * - Track retry attempts via durable storage
 * - Calculate retry delays using configured backoff
 * - Schedule retry alarms
 * - Signal when retries are exhausted
 *
 * Important: TerminateSignal bypasses retry logic entirely.
 * All other errors from user code are considered retryable.
 */
export interface RetryExecutorI {
  /**
   * Execute an effect with retry logic.
   *
   * - On success: resets retry state and returns result
   * - On TerminateSignal: bypasses retry, propagates signal
   * - On failure with retries remaining: schedules retry, fails with RetryScheduledSignal
   * - On failure with retries exhausted: resets retry state, fails with RetryExhaustedSignal
   */
  readonly executeWithRetry: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    config: JobRetryConfig,
    context: {
      jobType: "continuous" | "debounce" | "task" | "workerPool";
      jobName: string;
    }
  ) => Effect.Effect<A, E | RetryExhaustedSignal | RetryScheduledSignal, R>;

  /**
   * Check if we're currently in a retry sequence.
   */
  readonly isRetrying: () => Effect.Effect<boolean, StorageError>;

  /**
   * Get current attempt number (1 = first attempt).
   */
  readonly getAttempt: () => Effect.Effect<number, StorageError>;

  /**
   * Reset retry state (called after success or exhaustion).
   */
  readonly reset: () => Effect.Effect<void, StorageError>;

  /**
   * Get the scheduled retry timestamp, if any.
   */
  readonly getScheduledAt: () => Effect.Effect<number | undefined, StorageError>;
}

// =============================================================================
// Service Tag
// =============================================================================

export class RetryExecutor extends Context.Tag(
  "@durable-effect/jobs/RetryExecutor"
)<RetryExecutor, RetryExecutorI>() {}

// =============================================================================
// Implementation
// =============================================================================

export const RetryExecutorLayer = Layer.effect(
  RetryExecutor,
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;
    const alarm = yield* AlarmService;

    // Storage helpers
    const getAttempt = (): Effect.Effect<number, StorageError> =>
      storage.get<number>(KEYS.RETRY.ATTEMPT).pipe(Effect.map((a) => a ?? 1));

    const setAttempt = (attempt: number): Effect.Effect<void, StorageError> =>
      storage.put(KEYS.RETRY.ATTEMPT, attempt);

    const getStartedAt = (): Effect.Effect<number | undefined, StorageError> =>
      storage.get<number>(KEYS.RETRY.STARTED_AT);

    const setStartedAt = (timestamp: number): Effect.Effect<void, StorageError> =>
      storage.put(KEYS.RETRY.STARTED_AT, timestamp);

    const setLastError = <E>(error: E): Effect.Effect<void, StorageError> =>
      storage.put(KEYS.RETRY.LAST_ERROR, error);

    const getScheduledAt = (): Effect.Effect<number | undefined, StorageError> =>
      storage.get<number>(KEYS.RETRY.SCHEDULED_AT);

    const setScheduledAt = (timestamp: number): Effect.Effect<void, StorageError> =>
      storage.put(KEYS.RETRY.SCHEDULED_AT, timestamp);

    const reset = (): Effect.Effect<void, StorageError> =>
      Effect.gen(function* () {
        yield* storage.delete(KEYS.RETRY.ATTEMPT);
        yield* storage.delete(KEYS.RETRY.STARTED_AT);
        yield* storage.delete(KEYS.RETRY.LAST_ERROR);
        yield* storage.delete(KEYS.RETRY.SCHEDULED_AT);
      });

    return {
      executeWithRetry: <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        config: JobRetryConfig,
        context: { jobType: "continuous" | "debounce" | "task" | "workerPool"; jobName: string }
      ): Effect.Effect<A, E | RetryExhaustedSignal | RetryScheduledSignal, R> =>
        Effect.gen(function* () {
          const attempt = yield* getAttempt();
          const now = yield* runtime.now();

          // Initialize started_at on first attempt
          if (attempt === 1) {
            yield* setStartedAt(now);
          }

          // Check max duration before executing
          if (config.maxDuration !== undefined) {
            const startedAt = yield* getStartedAt();
            if (startedAt !== undefined) {
              const elapsed = now - startedAt;
              const duration = Duration.decode(config.maxDuration);
              const maxMs = Duration.toMillis(duration);
              if (elapsed >= maxMs) {
                // Duration exceeded - signal exhaustion
                yield* reset();
                return yield* Effect.fail(
                  new RetryExhaustedSignal({
                    ...context,
                    instanceId: runtime.instanceId,
                    attempts: attempt,
                    lastError: new Error("Max duration exceeded"),
                    totalDurationMs: elapsed,
                    reason: "max_duration_exceeded",
                  })
                );
              }
            }
          }

          // Execute the effect, but let TerminateSignal bypass retry
          const result = yield* effect.pipe(
            Effect.map((a) => ({ _tag: "Success" as const, value: a })),
            Effect.catchAll((e) => {
              // TerminateSignal bypasses retry entirely
              if (e instanceof TerminateSignal) {
                return Effect.fail(e as E);
              }
              // Regular errors go through retry logic
              return Effect.succeed({ _tag: "Failure" as const, error: e });
            })
          );

          if (result._tag === "Success") {
            // Success - reset retry state
            yield* reset();
            return result.value;
          }

          // Failure - all errors are retryable (removed isRetryable check)
          const error = result.error;

          // Check if attempts exhausted
          if (attempt >= config.maxAttempts) {
            // Exhausted - signal it (handler will terminate the job)
            const startedAt = (yield* getStartedAt()) ?? now;
            yield* reset();

            return yield* Effect.fail(
              new RetryExhaustedSignal({
                ...context,
                instanceId: runtime.instanceId,
                attempts: attempt,
                lastError: error,
                totalDurationMs: now - startedAt,
                reason: "max_attempts_exceeded",
              })
            );
          }

          // Schedule retry
          yield* setLastError(error);
          yield* setAttempt(attempt + 1);

          const baseDelay = resolveDelay(config.delay, attempt);
          const delayMs = config.jitter !== false ? addJitter(baseDelay) : baseDelay;
          const resumeAt = now + delayMs;

          yield* alarm.schedule(resumeAt);
          yield* setScheduledAt(resumeAt);

          // Return a signal that the handler will catch
          return yield* Effect.fail(
            new RetryScheduledSignal({ resumeAt, attempt: attempt + 1 })
          );
        }).pipe(
          // Map storage/scheduler errors to defects (they shouldn't happen)
          Effect.catchTag("StorageError", (e) => Effect.die(e)),
          Effect.catchTag("SchedulerError", (e) => Effect.die(e))
        ) as Effect.Effect<A, E | RetryExhaustedSignal | RetryScheduledSignal, R>,

      isRetrying: () => getAttempt().pipe(Effect.map((a) => a > 1)),

      getAttempt,

      reset,

      getScheduledAt,
    };
  })
);
