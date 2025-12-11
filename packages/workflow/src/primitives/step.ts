// packages/workflow/src/primitives/step.ts

import { Effect, Layer, Option } from "effect";
import { createBaseEvent } from "@durable-effect/core";
import { WorkflowContext } from "../context/workflow-context";
import {
  StepContext,
  createStepContext,
  type StepResultMeta,
} from "../context/step-context";
import { WorkflowScope, WorkflowScopeError } from "../context/workflow-scope";
import { StepScope, StepScopeError } from "../context/step-scope";
import { WorkflowLevel } from "../context/workflow-level";
import { StorageAdapter } from "../adapters/storage";
import { RuntimeAdapter } from "../adapters/runtime";
import { emitEvent } from "../tracker";
import type { StorageError } from "../errors";
import { PauseSignal, isPauseSignal } from "./pause-signal";
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
 * Flexible duration input supporting multiple formats.
 */
export type DurationInput = string | number;

/**
 * Configuration for step retry behavior.
 */
export interface RetryConfig {
  /**
   * Maximum number of retry attempts (not including initial attempt).
   */
  readonly maxAttempts: number;

  /**
   * Delay between retries.
   * - string: Human-readable duration ("5 seconds", "1 minute")
   * - number: Milliseconds
   * - BackoffStrategy: From Backoff.constant/linear/exponential
   * - function: Custom delay based on attempt number
   *
   * Default: Exponential backoff starting at 1 second
   */
  readonly delay?: DurationInput | BackoffStrategy | ((attempt: number) => number);

  /**
   * Whether to add jitter to delays to prevent thundering herd.
   * Default: true
   */
  readonly jitter?: boolean;

  /**
   * Optional predicate to determine if an error is retryable.
   * Default: All errors are retryable.
   */
  readonly isRetryable?: (error: unknown) => boolean;

  /**
   * Maximum total duration for all retry attempts.
   * If exceeded, fails with RetryExhaustedError.
   */
  readonly maxDuration?: DurationInput;
}

/**
 * Configuration for a durable workflow step.
 */
export interface StepConfig<A, E, R> {
  /**
   * Unique name for this step within the workflow.
   * Used for caching, logging, and debugging.
   */
  readonly name: string;

  /**
   * The effect to execute.
   */
  readonly execute: Effect.Effect<A, E, R>;

  /**
   * Retry configuration.
   * If provided, failed executions will be retried with the specified options.
   */
  readonly retry?: RetryConfig;

  /**
   * Timeout for each execution attempt (not total time).
   * Applied before retry - each attempt gets the full timeout.
   */
  readonly timeout?: DurationInput;
}

// =============================================================================
// Error Classes
// =============================================================================

/**
 * Error when a step is cancelled.
 */
export class StepCancelledError extends Error {
  readonly _tag = "StepCancelledError";
  readonly stepName: string;

  constructor(stepName: string) {
    super(`Step "${stepName}" was cancelled`);
    this.name = "StepCancelledError";
    this.stepName = stepName;
  }
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
      }`,
    );
    this.name = "RetryExhaustedError";
    this.stepName = stepName;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Error when a step times out.
 */
export class WorkflowTimeoutError extends Error {
  readonly _tag = "WorkflowTimeoutError";
  readonly stepName: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;

  constructor(stepName: string, timeoutMs: number, elapsedMs: number) {
    super(
      `Step "${stepName}" timed out after ${elapsedMs}ms (timeout: ${timeoutMs}ms)`,
    );
    this.name = "WorkflowTimeoutError";
    this.stepName = stepName;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
  }
}

// =============================================================================
// Type Guards
// =============================================================================

function isBackoffStrategy(value: unknown): value is BackoffStrategy {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    ["constant", "linear", "exponential"].includes((value as { type: string }).type)
  );
}

// =============================================================================
// Delay Calculation
// =============================================================================

function getDelay(
  config: RetryConfig["delay"],
  attempt: number,
): number {
  if (config === undefined) {
    // Default: exponential backoff starting at 1 second
    return calculateBackoffDelay(
      BackoffStrategies.exponential(1000, { maxDelayMs: 60000 }),
      attempt,
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

// =============================================================================
// Step Implementation
// =============================================================================

type StepErrors<E> =
  | E
  | StorageError
  | StepCancelledError
  | WorkflowScopeError
  | PauseSignal
  | RetryExhaustedError
  | WorkflowTimeoutError;

type StepRequirements<R> =
  | WorkflowContext
  | StorageAdapter
  | RuntimeAdapter
  | WorkflowLevel
  | Exclude<R, StepContext | StorageAdapter | RuntimeAdapter | StepScope>;

/**
 * Execute a durable step within a workflow.
 *
 * Steps are the fundamental building blocks of durable workflows:
 * - Results are cached and returned on replay
 * - Each step has a unique name for identification
 * - Steps check for cancellation before executing
 * - Retry and timeout can be configured
 *
 * @param config - Step configuration
 *
 * @example
 * ```ts
 * // Simple step
 * const user = yield* Workflow.step({
 *   name: "Fetch user",
 *   execute: fetchUser(userId),
 * });
 *
 * // Step with retry
 * const data = yield* Workflow.step({
 *   name: "Call API",
 *   execute: callAPI(),
 *   retry: { maxAttempts: 5, delay: "5 seconds" },
 * });
 *
 * // Step with timeout and retry
 * const result = yield* Workflow.step({
 *   name: "Resilient call",
 *   execute: riskyOperation(),
 *   timeout: "30 seconds",
 *   retry: {
 *     maxAttempts: 3,
 *     delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
 *   },
 * });
 * ```
 */
export function step<A, E, R>(
  config: StepConfig<A, E, R>,
): Effect.Effect<A, StepErrors<E>, StepRequirements<R>> {
  const { name } = config;

  return Effect.gen(function* () {
    // -------------------------------------------------------------------------
    // Phase 1: Validate workflow context
    // -------------------------------------------------------------------------
    yield* WorkflowLevel;

    const scope = yield* Effect.serviceOption(WorkflowScope);
    if (Option.isNone(scope)) {
      return yield* Effect.fail(
        new WorkflowScopeError({
          message: `Workflow.step("${name}") can only be used inside a workflow`,
        }),
      );
    }

    const workflowCtx = yield* WorkflowContext;
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    // -------------------------------------------------------------------------
    // Phase 2: Check for cancellation
    // -------------------------------------------------------------------------
    const isCancelled = yield* storage
      .get<boolean>("workflow:cancelled")
      .pipe(Effect.map((c) => c ?? false));

    if (isCancelled) {
      return yield* Effect.fail(new StepCancelledError(name));
    }

    // -------------------------------------------------------------------------
    // Phase 3: Check cache for existing result
    // -------------------------------------------------------------------------
    const stepCtx = yield* createStepContext(name);

    const workflowId = yield* workflowCtx.workflowId;
    const workflowName = yield* workflowCtx.workflowName;
    const executionId = yield* workflowCtx.executionId;

    const cached = yield* stepCtx.getResult<A>();
    if (cached !== undefined) {
      return cached.value;
    }

    // -------------------------------------------------------------------------
    // Phase 4: Initialize step state
    // -------------------------------------------------------------------------
    const now = yield* runtime.now();
    const startedAt = yield* stepCtx.startedAt;
    const currentAttempt = yield* stepCtx.attempt;

    if (startedAt === undefined) {
      yield* stepCtx.setStartedAt(now);
    }

    yield* emitEvent({
      ...createBaseEvent(workflowId, workflowName, executionId),
      type: "step.started",
      stepName: name,
      attempt: currentAttempt,
    });

    // -------------------------------------------------------------------------
    // Phase 5: Check retry exhaustion and max duration
    // -------------------------------------------------------------------------
    if (config.retry) {
      // Check max duration
      if (config.retry.maxDuration !== undefined && startedAt !== undefined) {
        const maxDurationMs = parseDuration(config.retry.maxDuration);
        const elapsed = now - startedAt;
        if (elapsed >= maxDurationMs) {
          yield* emitEvent({
            ...createBaseEvent(workflowId, workflowName, executionId),
            type: "retry.exhausted",
            stepName: name,
            attempts: currentAttempt - 1,
          });

          const lastError = yield* stepCtx.getMeta<unknown>("lastError");
          return yield* Effect.fail(
            new RetryExhaustedError(
              name,
              currentAttempt - 1,
              lastError ?? new Error("Max duration exceeded"),
            ),
          );
        }
      }

      // Check max attempts
      if (currentAttempt > config.retry.maxAttempts + 1) {
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName, executionId),
          type: "retry.exhausted",
          stepName: name,
          attempts: currentAttempt - 1,
        });

        const lastError = yield* stepCtx.getMeta<unknown>("lastError");
        return yield* Effect.fail(
          new RetryExhaustedError(name, currentAttempt - 1, lastError),
        );
      }
    }

    // -------------------------------------------------------------------------
    // Phase 6: Build the effect with timeout if configured
    // -------------------------------------------------------------------------
    let effect: Effect.Effect<A, E | WorkflowTimeoutError, R> = config.execute;

    if (config.timeout) {
      const timeoutMs = parseDuration(config.timeout);
      const effectStartedAt = startedAt ?? now;
      const deadline = effectStartedAt + timeoutMs;
      const remainingMs = deadline - now;

      // Emit timeout.set event on first execution
      if (startedAt === undefined) {
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName, executionId),
          type: "timeout.set",
          stepName: name,
          deadline: new Date(deadline).toISOString(),
          timeoutMs,
        });
      }

      if (remainingMs <= 0) {
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName, executionId),
          type: "timeout.exceeded",
          stepName: name,
          timeoutMs,
        });

        return yield* Effect.fail(
          new WorkflowTimeoutError(name, timeoutMs, now - effectStartedAt),
        );
      }

      effect = effect.pipe(
        Effect.timeoutFail({
          duration: remainingMs,
          onTimeout: () => new WorkflowTimeoutError(name, timeoutMs, now - effectStartedAt),
        }),
      );
    }

    // -------------------------------------------------------------------------
    // Phase 7: Execute the effect with provided context
    // -------------------------------------------------------------------------
    const stepScopeService = {
      _marker: "step-scope-active" as const,
      stepName: name,
    };

    const stepLayer = Layer.mergeAll(
      Layer.succeed(StepContext, stepCtx),
      Layer.succeed(StepScope, stepScopeService),
      Layer.succeed(StorageAdapter, storage),
      Layer.succeed(RuntimeAdapter, runtime),
    );

    const effectResult = yield* effect.pipe(
      Effect.provide(stepLayer),
      Effect.map((value) => ({ _tag: "Success" as const, value })),
      Effect.catchAll((error) =>
        Effect.succeed({ _tag: "Failure" as const, error: error as E | WorkflowTimeoutError }),
      ),
    );

    // -------------------------------------------------------------------------
    // Phase 8: Handle failure with retry logic
    // -------------------------------------------------------------------------
    if (effectResult._tag === "Failure") {
      const error = effectResult.error;

      // Never retry PauseSignal - it's a control flow signal
      if (isPauseSignal(error)) {
        return yield* Effect.fail(error as unknown as PauseSignal);
      }

      // Never retry StepScopeError - it's a programming error
      if (error instanceof StepScopeError) {
        return yield* Effect.fail(error as unknown as E);
      }

      // Check if retry is configured
      if (!config.retry) {
        // No retry configured - emit failure and propagate error
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName, executionId),
          type: "step.failed",
          stepName: name,
          attempt: currentAttempt,
          error: {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          willRetry: false,
        });
        return yield* Effect.fail(error);
      }

      // Check isRetryable
      if (config.retry.isRetryable && !config.retry.isRetryable(error)) {
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName, executionId),
          type: "step.failed",
          stepName: name,
          attempt: currentAttempt,
          error: {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          willRetry: false,
        });
        return yield* Effect.fail(error);
      }

      // Check if retries exhausted
      if (currentAttempt > config.retry.maxAttempts) {
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName, executionId),
          type: "retry.exhausted",
          stepName: name,
          attempts: currentAttempt,
        });

        return yield* Effect.fail(
          new RetryExhaustedError(name, currentAttempt, error),
        );
      }

      // Schedule retry
      yield* stepCtx.setMeta("lastError", error);
      yield* stepCtx.incrementAttempt();

      const baseDelay = getDelay(config.retry.delay, currentAttempt);
      const jitter = config.retry.jitter ?? true;
      const delayMs = jitter ? addJitter(baseDelay) : baseDelay;
      const resumeAt = now + delayMs;

      yield* emitEvent({
        ...createBaseEvent(workflowId, workflowName, executionId),
        type: "retry.scheduled",
        stepName: name,
        attempt: currentAttempt,
        nextAttemptAt: new Date(resumeAt).toISOString(),
        delayMs,
      });

      return yield* Effect.fail(
        PauseSignal.retry(resumeAt, name, currentAttempt + 1),
      );
    }

    // -------------------------------------------------------------------------
    // Phase 9: Cache successful result
    // -------------------------------------------------------------------------
    const result = effectResult.value;
    const completedAt = yield* runtime.now();
    const attempt = yield* stepCtx.attempt;
    const durationMs = completedAt - (startedAt ?? now);

    const meta: StepResultMeta = {
      completedAt,
      attempt,
      durationMs,
    };

    yield* stepCtx.setResult(result, meta);
    yield* workflowCtx.markStepCompleted(name);

    yield* emitEvent({
      ...createBaseEvent(workflowId, workflowName, executionId),
      type: "step.completed",
      stepName: name,
      attempt,
      durationMs,
      cached: false,
    });

    return result;
  });
}
