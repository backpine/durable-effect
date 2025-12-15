// packages/jobs/src/retry/executor.ts

import { Context, Effect, Layer, Duration } from "effect";
import {
  StorageAdapter,
  RuntimeAdapter,
  resolveDelay,
  addJitter,
  type StorageError,
  type SchedulerError,
} from "@durable-effect/core";
import { AlarmService } from "../services/alarm";
import { KEYS } from "../storage-keys";
import type { JobRetryConfig, RetryExhaustedInfo } from "./types";
import { RetryExhaustedError, RetryScheduledSignal } from "./errors";

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
 */
export interface RetryExecutorI {
  /**
   * Execute an effect with retry logic.
   *
   * On success: resets retry state and returns result.
   * On failure with retries remaining: schedules retry and fails with RetryScheduledSignal.
   * On failure with retries exhausted: calls onRetryExhausted callback and fails with RetryExhaustedError.
   * On non-retryable failure: resets retry state and propagates original error.
   */
  readonly executeWithRetry: <A, E>(
    effect: Effect.Effect<A, E, never>,
    config: JobRetryConfig<E>,
    context: {
      jobType: "continuous" | "debounce";
      jobName: string;
    }
  ) => Effect.Effect<A, E | RetryExhaustedError | RetryScheduledSignal, never>;

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

    const getLastError = <E>(): Effect.Effect<E | undefined, StorageError> =>
      storage.get<E>(KEYS.RETRY.LAST_ERROR);

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
      executeWithRetry: <A, E>(
        effect: Effect.Effect<A, E, never>,
        config: JobRetryConfig<E>,
        context: { jobType: "continuous" | "debounce"; jobName: string }
      ): Effect.Effect<A, E | RetryExhaustedError | RetryScheduledSignal, never> =>
        Effect.gen(function* () {
          const attempt = yield* getAttempt();
          const now = yield* runtime.now();

          // Initialize started_at on first attempt
          if (attempt === 1) {
            yield* setStartedAt(now);
          }

          // Check max duration
          if (config.maxDuration !== undefined) {
            const startedAt = yield* getStartedAt();
            if (startedAt !== undefined) {
              const elapsed = now - startedAt;
              const duration = Duration.decode(config.maxDuration);
              const maxMs = Duration.toMillis(duration);
              if (elapsed >= maxMs) {
                // Duration exceeded, fail without retry
                const lastError = yield* getLastError<E>();
                yield* reset();

                // Call onRetryExhausted callback
                if (config.onRetryExhausted) {
                  const info: RetryExhaustedInfo<E> = {
                    ...context,
                    instanceId: runtime.instanceId,
                    attempts: attempt,
                    lastError: lastError as E,
                    totalDurationMs: elapsed,
                  };
                  try {
                    config.onRetryExhausted(info);
                  } catch {
                    // Ignore callback errors
                  }
                }

                return yield* Effect.fail(
                  new RetryExhaustedError({
                    ...context,
                    instanceId: runtime.instanceId,
                    attempts: attempt,
                    lastError: lastError ?? new Error("Max duration exceeded"),
                    reason: "max_duration_exceeded",
                  })
                );
              }
            }
          }

          // Execute the effect
          const result = yield* Effect.either(effect);

          if (result._tag === "Right") {
            // Success - reset retry state
            yield* reset();
            return result.right;
          }

          // Failure - check if retryable
          const error = result.left;

          if (config.isRetryable && !config.isRetryable(error)) {
            // Not retryable - fail immediately
            yield* reset();
            return yield* Effect.fail(error);
          }

          // Check if attempts exhausted
          if (attempt > config.maxAttempts) {
            // Exhausted - call callback and fail
            const startedAt = (yield* getStartedAt()) ?? now;

            if (config.onRetryExhausted) {
              const info: RetryExhaustedInfo<E> = {
                ...context,
                instanceId: runtime.instanceId,
                attempts: attempt,
                lastError: error,
                totalDurationMs: now - startedAt,
              };
              try {
                config.onRetryExhausted(info);
              } catch {
                // Ignore callback errors
              }
            }

            yield* reset();
            return yield* Effect.fail(
              new RetryExhaustedError({
                ...context,
                instanceId: runtime.instanceId,
                attempts: attempt,
                lastError: error,
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
          // Map storage errors to be part of the error channel
          Effect.catchTag("StorageError", (e) => Effect.die(e)),
          Effect.catchTag("SchedulerError", (e) => Effect.die(e))
        ) as Effect.Effect<A, E | RetryExhaustedError | RetryScheduledSignal, never>,

      isRetrying: () => getAttempt().pipe(Effect.map((a) => a > 1)),

      getAttempt,

      reset,

      getScheduledAt,
    };
  })
);
