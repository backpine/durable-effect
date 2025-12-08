// packages/workflow-v2/src/primitives/retry.ts

import { Effect } from "effect";
import { createBaseEvent } from "@durable-effect/core";
import { StepContext } from "../context/step-context";
import { WorkflowContext } from "../context/workflow-context";
import { RuntimeAdapter } from "../adapters/runtime";
import { emitEvent } from "../tracker";
import type { StorageError } from "../errors";
import { PauseSignal } from "./pause-signal";
import {
  type BackoffStrategy,
  BackoffStrategies,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
} from "./backoff";

// =============================================================================
// Types
// =============================================================================

/**
 * Delay configuration for retries.
 */
export type DelayConfig =
  | string // e.g., "5 seconds"
  | number // milliseconds
  | BackoffStrategy // Backoff.exponential(), etc.
  | ((attempt: number) => number); // Custom function

/**
 * Options for durable retry.
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts (not including initial attempt).
   */
  readonly maxAttempts: number;

  /**
   * Delay between retries.
   * Default: exponential backoff starting at 1 second
   */
  readonly delay?: DelayConfig;

  /**
   * Whether to add jitter to delays.
   * Default: true
   */
  readonly jitter?: boolean;

  /**
   * Optional function to determine if error is retryable.
   * Default: all errors are retryable
   */
  readonly isRetryable?: (error: unknown) => boolean;

  /**
   * Maximum total duration for all retry attempts.
   * If exceeded, throws RetryExhaustedError.
   */
  readonly maxDuration?: string | number;
}

/**
 * Error when all retries are exhausted.
 */
export class RetryExhaustedError extends Error {
  readonly _tag = "RetryExhaustedError";
  readonly stepName: string;
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(stepName: string, attempts: number, lastError: unknown) {
    super(
      `Step "${stepName}" failed after ${attempts} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
    this.name = "RetryExhaustedError";
    this.stepName = stepName;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Calculate delay from DelayConfig.
 */
function getDelay(config: DelayConfig | undefined, attempt: number): number {
  if (config === undefined) {
    // Default: exponential backoff starting at 1 second
    return calculateBackoffDelay(
      BackoffStrategies.exponential(1000, { maxDelayMs: 60000 }),
      attempt
    );
  }

  if (typeof config === "string") {
    return parseDuration(config);
  }

  if (typeof config === "number") {
    return config;
  }

  if (typeof config === "function") {
    return config(attempt);
  }

  // BackoffStrategy
  return calculateBackoffDelay(config, attempt);
}

/**
 * Durable retry operator for use inside Workflow.step().
 *
 * This operator adds retry logic to any Effect. When the Effect fails:
 * - Tracks attempt count durably in storage
 * - Throws PauseSignal to schedule retry after delay
 * - Returns cached result on replay if step already succeeded
 *
 * @param options - Retry configuration
 *
 * @example
 * ```ts
 * yield* Workflow.step("Call API",
 *   callExternalAPI().pipe(
 *     Workflow.retry({ maxAttempts: 5, delay: "5 seconds" })
 *   )
 * );
 *
 * // With exponential backoff
 * yield* Workflow.step("Fetch data",
 *   fetchData().pipe(
 *     Workflow.retry({
 *       maxAttempts: 5,
 *       delay: Backoff.exponential({ base: "1 second", max: "60 seconds" }),
 *     })
 *   )
 * );
 *
 * // With selective retry
 * yield* Workflow.step("Process",
 *   process().pipe(
 *     Effect.catchTag("ValidationError", (e) => Effect.fail(new PermanentError(e))),
 *     Workflow.retry({ maxAttempts: 3 })
 *   )
 * );
 * ```
 */
export function retry<A, E, R>(
  options: RetryOptions
): <E2, R2>(
  effect: Effect.Effect<A, E | E2, R | R2>
) => Effect.Effect<
  A,
  E | E2 | StorageError | PauseSignal | RetryExhaustedError,
  R | R2 | StepContext | RuntimeAdapter | WorkflowContext
> {
  const { maxAttempts, delay, jitter = true, isRetryable, maxDuration } =
    options;

  return <E2, R2>(effect: Effect.Effect<A, E | E2, R | R2>) =>
    Effect.gen(function* () {
      const stepCtx = yield* StepContext;
      const runtime = yield* RuntimeAdapter;
      const workflowCtx = yield* WorkflowContext;
      const now = yield* runtime.now();

      // Get workflow identity for events
      const workflowId = yield* workflowCtx.workflowId;
      const workflowName = yield* workflowCtx.workflowName;
      const executionId = yield* workflowCtx.executionId;

      // Check max duration if set
      if (maxDuration !== undefined) {
        const startedAt = yield* stepCtx.startedAt;
        if (startedAt !== undefined) {
          const maxDurationMs = parseDuration(maxDuration);
          const elapsed = now - startedAt;
          if (elapsed >= maxDurationMs) {
            const attempts = (yield* stepCtx.attempt) - 1;

            // Emit retry.exhausted event
            yield* emitEvent({
              ...createBaseEvent(workflowId, workflowName, executionId),
              type: "retry.exhausted",
              stepName: stepCtx.stepName,
              attempts,
            });

            const lastError = yield* stepCtx.getMeta<unknown>("lastError");
            return yield* Effect.fail(
              new RetryExhaustedError(
                stepCtx.stepName,
                attempts,
                lastError ?? new Error("Max duration exceeded")
              )
            );
          }
        }
      }

      // Get current attempt (1-indexed)
      const attempt = yield* stepCtx.attempt;

      // Check if we've exceeded max attempts
      if (attempt > maxAttempts + 1) {
        // Emit retry.exhausted event
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName, executionId),
          type: "retry.exhausted",
          stepName: stepCtx.stepName,
          attempts: attempt - 1,
        });

        const lastError = yield* stepCtx.getMeta<unknown>("lastError");
        return yield* Effect.fail(
          new RetryExhaustedError(stepCtx.stepName, attempt - 1, lastError)
        );
      }

      // Execute the effect
      const result = yield* effect.pipe(
        Effect.map((value) => ({ success: true as const, value })),
        Effect.catchAll((error) =>
          Effect.succeed({ success: false as const, error: error as E | E2 })
        )
      );

      if (result.success) {
        // Success! Reset attempt counter and return
        yield* stepCtx.resetAttempt();
        return result.value;
      }

      // Failure - check if retryable
      if (isRetryable && !isRetryable(result.error)) {
        // Not retryable - fail immediately
        return yield* Effect.fail(result.error);
      }

      // Check if we've exhausted retries
      if (attempt > maxAttempts) {
        // Emit retry.exhausted event
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName, executionId),
          type: "retry.exhausted",
          stepName: stepCtx.stepName,
          attempts: attempt,
        });

        return yield* Effect.fail(
          new RetryExhaustedError(stepCtx.stepName, attempt, result.error)
        );
      }

      // Store last error for reporting
      yield* stepCtx.setMeta("lastError", result.error);

      // Increment attempt for next try
      yield* stepCtx.incrementAttempt();

      // Calculate delay for next attempt
      let delayMs = getDelay(delay, attempt);
      if (jitter) {
        delayMs = addJitter(delayMs);
      }

      const resumeAt = now + delayMs;

      // Emit retry.scheduled event
      yield* emitEvent({
        ...createBaseEvent(workflowId, workflowName, executionId),
        type: "retry.scheduled",
        stepName: stepCtx.stepName,
        attempt,
        nextAttemptAt: new Date(resumeAt).toISOString(),
        delayMs,
      });

      // Pause for retry - orchestrator will catch and schedule alarm
      return yield* Effect.fail(
        PauseSignal.retry(resumeAt, stepCtx.stepName, attempt + 1)
      );
    });
}

/**
 * Helper to create backoff strategies with human-readable durations.
 */
export const Backoff = {
  /**
   * Constant delay between retries.
   */
  constant: (delayValue: string | number): BackoffStrategy =>
    BackoffStrategies.constant(parseDuration(delayValue)),

  /**
   * Linear backoff: delay increases by a fixed amount.
   */
  linear: (options: {
    initial: string | number;
    increment: string | number;
    max?: string | number;
  }): BackoffStrategy =>
    BackoffStrategies.linear(
      parseDuration(options.initial),
      parseDuration(options.increment),
      options.max !== undefined ? parseDuration(options.max) : undefined
    ),

  /**
   * Exponential backoff: delay doubles (or multiplies) each time.
   */
  exponential: (options: {
    base: string | number;
    factor?: number;
    max?: string | number;
  }): BackoffStrategy =>
    BackoffStrategies.exponential(parseDuration(options.base), {
      multiplier: options.factor,
      maxDelayMs:
        options.max !== undefined ? parseDuration(options.max) : undefined,
    }),

  /**
   * Preset strategies for common scenarios.
   */
  presets: {
    /** Standard: 1s -> 2s -> 4s -> 8s -> 16s (max 30s) */
    standard: () => BackoffStrategies.exponential(1000, { maxDelayMs: 30000 }),

    /** Aggressive: 100ms -> 200ms -> 400ms (max 5s) */
    aggressive: () => BackoffStrategies.exponential(100, { maxDelayMs: 5000 }),

    /** Patient: 5s -> 10s -> 20s -> 40s (max 2min) */
    patient: () => BackoffStrategies.exponential(5000, { maxDelayMs: 120000 }),

    /** Simple: 1s constant */
    simple: () => BackoffStrategies.constant(1000),
  },
};
