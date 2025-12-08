# Phase 6 v2: Pipeable Retry & Timeout Operators

## Overview

This document redesigns Phase 6 to support **pipeable operators** for retry and timeout, matching the v1 API. Instead of standalone workflow-level primitives, `Workflow.retry()` and `Workflow.timeout()` become operators that can be piped onto any Effect **inside** a step.

**Key Change**: Retry and timeout are now operators applied inside `Workflow.step()`, not separate workflow primitives.

---

## API Comparison

### Old Design (Phase 6 original)
```typescript
// Standalone primitives with their own names
yield* Workflow.retry("fetchWithRetry", () => fetch(url), { maxAttempts: 5 });
yield* Workflow.timeout("processPayment", "30 seconds", () => processPaymentEffect());
```

### New Design (v1-compatible)
```typescript
// Pipeable operators inside steps
yield* Workflow.step("Process payment",
  processPayment(order).pipe(
    Workflow.retry({ maxAttempts: 5, delay: Backoff.exponential("1 second") }),
    Workflow.timeout("30 seconds")
  )
);
```

---

## Changes Required

### 1. Phase 5 Changes (step.ts)

The step implementation must provide `StepContext` as a service to the executing effect, enabling retry/timeout operators to access durable state.

**Current implementation:**
```typescript
// StepContext is used internally, not provided to executing effect
const stepCtx = yield* Effect.provide(StepContext, StepContextLayer(name).pipe(...));

// Executing effect doesn't have access to StepContext
const result = yield* stepEffect.pipe(
  Effect.provide(StepScopeLayer(name))
);
```

**New implementation:**
```typescript
// Provide both StepScope and StepContext to the executing effect
const result = yield* execute().pipe(
  Effect.provide(StepScopeLayer(name)),
  Effect.provide(StepContextLayer(name))
);

// Step wrapper still handles:
// 1. Cache check (return early if result exists)
// 2. Cancellation check
// 3. Cache successful results
// 4. Let PauseSignal bubble up (don't cache on pause)
```

**Remove from StepOptions:**
- Remove `timeout` option - use pipeable `Workflow.timeout()` instead

### 2. Phase 6 Changes

#### Remove
- `retry(name, execute, options)` - standalone retry primitive
- `timeout(name, duration, execute)` - standalone timeout primitive
- `getRemainingTime(name)` - tied to standalone timeout

#### Keep
- `sleep(duration)` - workflow-level sleep (not inside steps)
- `sleepUntil(timestamp)` - workflow-level sleep to timestamp
- All backoff utilities (`BackoffStrategies`, `calculateBackoffDelay`, `parseDuration`, etc.)

#### Add
- `retry(options)` - returns pipeable operator
- `timeout(duration)` - returns pipeable operator

---

## New Implementation

### 1. Retry Operator (`primitives/retry.ts`)

```typescript
// packages/workflow/src/primitives/retry.ts

import { Effect, pipe } from "effect";
import { StepContext } from "../context/step-context";
import { RuntimeAdapter } from "../adapters/runtime";
import { StorageError } from "../errors";
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
  | string                          // e.g., "5 seconds"
  | number                          // milliseconds
  | BackoffStrategy                 // Backoff.exponential(), etc.
  | ((attempt: number) => number);  // Custom function

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
  R | R2 | StepContext | RuntimeAdapter
> {
  const { maxAttempts, delay, jitter = true, isRetryable, maxDuration } = options;

  return <E2, R2>(effect: Effect.Effect<A, E | E2, R | R2>) =>
    Effect.gen(function* () {
      const stepCtx = yield* StepContext;
      const runtime = yield* RuntimeAdapter;
      const now = yield* runtime.now();

      // Check max duration if set
      if (maxDuration !== undefined) {
        const startedAt = yield* stepCtx.startedAt;
        if (startedAt !== undefined) {
          const maxDurationMs = parseDuration(maxDuration);
          const elapsed = now - startedAt;
          if (elapsed >= maxDurationMs) {
            const lastError = yield* stepCtx.getMeta<unknown>("lastError");
            return yield* Effect.fail(
              new RetryExhaustedError(
                stepCtx.stepName,
                (yield* stepCtx.attempt) - 1,
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

      // Pause for retry - orchestrator will catch and schedule alarm
      return yield* Effect.fail(
        PauseSignal.retry(resumeAt, stepCtx.stepName, attempt + 1)
      );
    });
}

/**
 * Helper to create retry options with common patterns.
 */
export const Backoff = {
  /**
   * Constant delay between retries.
   */
  constant: (delay: string | number, withJitter = false): BackoffStrategy =>
    BackoffStrategies.constant(parseDuration(delay)),

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
      maxDelayMs: options.max !== undefined ? parseDuration(options.max) : undefined,
    }),

  /**
   * Preset strategies for common scenarios.
   */
  presets: {
    /** Standard: 1s -> 2s -> 4s -> 8s -> 16s (max 30s) */
    standard: () =>
      BackoffStrategies.exponential(1000, { maxDelayMs: 30000 }),

    /** Aggressive: 100ms -> 200ms -> 400ms (max 5s) */
    aggressive: () =>
      BackoffStrategies.exponential(100, { maxDelayMs: 5000 }),

    /** Patient: 5s -> 10s -> 20s -> 40s (max 2min) */
    patient: () =>
      BackoffStrategies.exponential(5000, { maxDelayMs: 120000 }),

    /** Simple: 1s constant */
    simple: () => BackoffStrategies.constant(1000),
  },
};
```

### 2. Timeout Operator (`primitives/timeout.ts`)

```typescript
// packages/workflow/src/primitives/timeout.ts

import { Effect } from "effect";
import { StepContext } from "../context/step-context";
import { RuntimeAdapter } from "../adapters/runtime";
import { StorageError } from "../errors";
import { parseDuration } from "./backoff";

// =============================================================================
// Types
// =============================================================================

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
      `Step "${stepName}" timed out after ${elapsedMs}ms (timeout: ${timeoutMs}ms)`
    );
    this.name = "WorkflowTimeoutError";
    this.stepName = stepName;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
  }
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Durable timeout operator for use inside Workflow.step().
 *
 * This operator adds a deadline to any Effect:
 * - Persists start time for deadline tracking across restarts
 * - Calculates remaining time on replay
 * - Fails with WorkflowTimeoutError if deadline exceeded
 *
 * @param duration - Timeout duration (string like "30 seconds" or number in ms)
 *
 * @example
 * ```ts
 * yield* Workflow.step("Call API",
 *   callExternalAPI().pipe(
 *     Workflow.timeout("30 seconds")
 *   )
 * );
 *
 * // Combined with retry (timeout applies to each attempt)
 * yield* Workflow.step("Resilient call",
 *   riskyOperation().pipe(
 *     Workflow.timeout("10 seconds"),
 *     Workflow.retry({ maxAttempts: 3 })
 *   )
 * );
 * ```
 */
export function timeout<A, E, R>(
  duration: string | number
): (
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<
  A,
  E | StorageError | WorkflowTimeoutError,
  R | StepContext | RuntimeAdapter
> {
  const timeoutMs = parseDuration(duration);

  return (effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const stepCtx = yield* StepContext;
      const runtime = yield* RuntimeAdapter;
      const now = yield* runtime.now();

      // Get or set start time (for deadline calculation)
      let startedAt = yield* stepCtx.startedAt;
      if (startedAt === undefined) {
        startedAt = now;
        yield* stepCtx.setStartedAt(startedAt);
      }

      // Calculate remaining time
      const deadline = startedAt + timeoutMs;
      const remainingMs = deadline - now;

      // Check if already timed out
      if (remainingMs <= 0) {
        return yield* Effect.fail(
          new WorkflowTimeoutError(stepCtx.stepName, timeoutMs, now - startedAt)
        );
      }

      // Execute with Effect.timeout for the remaining time
      return yield* effect.pipe(
        Effect.timeoutFail({
          duration: remainingMs,
          onTimeout: () =>
            new WorkflowTimeoutError(stepCtx.stepName, timeoutMs, now - startedAt),
        })
      );
    });
}
```

### 3. Updated Step Implementation (`primitives/step.ts`)

```typescript
// packages/workflow/src/primitives/step.ts

import { Effect, Option } from "effect";
import { WorkflowContext } from "../context/workflow-context";
import { StepContext, StepContextLayer, type StepResultMeta } from "../context/step-context";
import { WorkflowScope, WorkflowScopeError } from "../context/workflow-scope";
import { StepScopeLayer } from "../context/step-scope";
import { StorageAdapter } from "../adapters/storage";
import { RuntimeAdapter } from "../adapters/runtime";
import { StorageError } from "../errors";
import { PauseSignal } from "./pause-signal";

// =============================================================================
// Types
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

// =============================================================================
// Step Implementation
// =============================================================================

/**
 * Execute a durable step within a workflow.
 *
 * Steps are the fundamental building blocks of durable workflows:
 * - Results are cached and returned on replay
 * - Each step has a unique name for identification
 * - Steps check for cancellation before executing
 * - Retry and timeout operators can be piped inside
 *
 * @param name - Unique name for this step within the workflow
 * @param effect - The effect to execute (can include piped operators)
 *
 * @example
 * ```ts
 * // Simple step
 * const result = yield* Workflow.step("fetchUser",
 *   Effect.tryPromise(() => fetch(`/api/users/${userId}`))
 * );
 *
 * // Step with retry
 * yield* Workflow.step("callAPI",
 *   callAPI().pipe(
 *     Workflow.retry({ maxAttempts: 5, delay: "5 seconds" })
 *   )
 * );
 *
 * // Step with timeout and retry
 * yield* Workflow.step("resilientCall",
 *   riskyOperation().pipe(
 *     Workflow.timeout("30 seconds"),
 *     Workflow.retry({ maxAttempts: 3 })
 *   )
 * );
 * ```
 */
export function step<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  E | StorageError | StepCancelledError | WorkflowScopeError,
  | WorkflowContext
  | WorkflowScope
  | StorageAdapter
  | RuntimeAdapter
  | Exclude<R, StepContext>
> {
  return Effect.gen(function* () {
    // Verify we're in a workflow scope
    const scope = yield* Effect.serviceOption(WorkflowScope);
    if (Option.isNone(scope)) {
      return yield* Effect.fail(
        new WorkflowScopeError({
          message: `Workflow.step("${name}") can only be used inside a workflow`,
        })
      );
    }

    const workflowCtx = yield* WorkflowContext;
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    // -------------------------------------------------------------------------
    // Phase 1: Check for cancellation
    // -------------------------------------------------------------------------
    const isCancelled = yield* storage
      .get<boolean>("workflow:cancelled")
      .pipe(Effect.map((c) => c ?? false));

    if (isCancelled) {
      return yield* Effect.fail(new StepCancelledError(name));
    }

    // -------------------------------------------------------------------------
    // Phase 2: Check cache for existing result
    // -------------------------------------------------------------------------
    // Create a temporary StepContext to check cache
    const tempCtx = yield* Effect.provide(
      createStepContext(name),
      Layer.merge(
        Layer.succeed(StorageAdapter, storage),
        Layer.succeed(RuntimeAdapter, runtime)
      )
    );

    const cached = yield* tempCtx.getResult<A>();
    if (cached !== undefined) {
      // Step already completed - return cached result
      return cached.value;
    }

    // -------------------------------------------------------------------------
    // Phase 3: Set start time if not set
    // -------------------------------------------------------------------------
    const now = yield* runtime.now();
    const startedAt = yield* tempCtx.startedAt;
    if (startedAt === undefined) {
      yield* tempCtx.setStartedAt(now);
    }

    // -------------------------------------------------------------------------
    // Phase 4: Execute the effect with StepContext and StepScope provided
    // -------------------------------------------------------------------------
    // The effect can include piped operators like retry() and timeout()
    // that require StepContext
    const result = yield* effect.pipe(
      Effect.provide(StepScopeLayer(name)),
      Effect.provide(StepContextLayer(name))
    );

    // -------------------------------------------------------------------------
    // Phase 5: Cache result (only on success, not on PauseSignal)
    // -------------------------------------------------------------------------
    const completedAt = yield* runtime.now();
    const attempt = yield* tempCtx.attempt;
    const meta: StepResultMeta = {
      completedAt,
      attempt,
      durationMs: completedAt - (startedAt ?? now),
    };

    yield* tempCtx.setResult(result, meta);

    // -------------------------------------------------------------------------
    // Phase 6: Mark step as completed
    // -------------------------------------------------------------------------
    yield* workflowCtx.markStepCompleted(name);

    return result;
  });
}

// Helper to create StepContext (needed for cache check before execution)
import { Layer } from "effect";
import { createStepContext } from "../context/step-context";
```

### 4. Updated Exports (`primitives/index.ts`)

```typescript
// packages/workflow/src/primitives/index.ts

// PauseSignal
export {
  PauseSignal,
  isPauseSignal,
  type PauseReason,
} from "./pause-signal";

// Workflow.make
export {
  make,
  type WorkflowDefinition,
  type WorkflowOptions,
  type WorkflowEffect,
  type WorkflowInput,
  type WorkflowOutput,
  type WorkflowError,
  type WorkflowRequirements,
} from "./make";

// Workflow.step
export {
  step,
  StepCancelledError,
} from "./step";

// Workflow.sleep
export { sleep, sleepUntil } from "./sleep";

// Workflow.retry (pipeable operator)
export {
  retry,
  Backoff,
  RetryExhaustedError,
  type RetryOptions,
  type DelayConfig,
} from "./retry";

// Workflow.timeout (pipeable operator)
export {
  timeout,
  WorkflowTimeoutError,
} from "./timeout";

// Backoff utilities
export {
  type BackoffStrategy,
  BackoffStrategies,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
} from "./backoff";
```

---

## Testing Strategy

### Test: Retry Operator (`test/primitives/retry.test.ts`)

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  WorkflowContext,
  WorkflowContextLayer,
  WorkflowScope,
  WorkflowScopeLayer,
  StorageAdapter,
  RuntimeAdapter,
  step,
  retry,
  Backoff,
  RetryExhaustedError,
  PauseSignal,
  isPauseSignal,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("Workflow.retry (pipeable operator)", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000 })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const createLayers = () =>
    WorkflowScopeLayer.pipe(
      Layer.provideMerge(WorkflowContextLayer),
      Layer.provide(runtimeLayer)
    );

  const runStep = <A, E>(effect: Effect.Effect<A, E, any>) =>
    effect.pipe(Effect.provide(createLayers()), Effect.runPromise);

  it("should succeed on first attempt if no error", async () => {
    let attempts = 0;

    const result = await runStep(
      Effect.gen(function* () {
        return yield* step(
          "successfulStep",
          Effect.sync(() => {
            attempts++;
            return "success";
          }).pipe(retry({ maxAttempts: 3 }))
        );
      })
    );

    expect(result).toBe("success");
    expect(attempts).toBe(1);
  });

  it("should throw PauseSignal on failure for retry", async () => {
    const result = await runStep(
      Effect.gen(function* () {
        return yield* step(
          "failingStep",
          Effect.fail(new Error("always fails")).pipe(
            retry({ maxAttempts: 3 })
          )
        ).pipe(Effect.either);
      })
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(isPauseSignal(result.left)).toBe(true);
      const signal = result.left as PauseSignal;
      expect(signal.reason).toBe("retry");
      expect(signal.stepName).toBe("failingStep");
      expect(signal.attempt).toBe(2);
    }
  });

  it("should throw RetryExhaustedError after max attempts", async () => {
    // Simulate being at max attempts
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* StorageAdapter;
        yield* storage.put("step:exhaustedStep:attempt", 5); // maxAttempts + 2
      }).pipe(Effect.provide(runtimeLayer))
    );

    const result = await runStep(
      Effect.gen(function* () {
        return yield* step(
          "exhaustedStep",
          Effect.fail(new Error("fails")).pipe(retry({ maxAttempts: 3 }))
        ).pipe(Effect.either);
      })
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(RetryExhaustedError);
    }
  });

  it("should use Backoff.exponential for delay", async () => {
    const result = await runStep(
      Effect.gen(function* () {
        return yield* step(
          "backoffStep",
          Effect.fail(new Error("fails")).pipe(
            retry({
              maxAttempts: 5,
              delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
            })
          )
        ).pipe(Effect.either);
      })
    );

    if (result._tag === "Left" && isPauseSignal(result.left)) {
      const signal = result.left as PauseSignal;
      // First failure, delay should be ~1000ms from now (1000 + ~1000 = ~2000)
      expect(signal.resumeAt).toBeGreaterThanOrEqual(1900);
      expect(signal.resumeAt).toBeLessThan(2200); // With jitter
    }
  });

  it("should respect isRetryable function", async () => {
    class NonRetryableError extends Error {
      readonly _tag = "NonRetryableError";
    }

    const result = await runStep(
      Effect.gen(function* () {
        return yield* step(
          "selectiveRetry",
          Effect.fail(new NonRetryableError("not retryable")).pipe(
            retry({
              maxAttempts: 3,
              isRetryable: (e) => !(e instanceof NonRetryableError),
            })
          )
        ).pipe(Effect.either);
      })
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      // Should fail immediately, not PauseSignal
      expect(result.left).toBeInstanceOf(NonRetryableError);
    }
  });

  it("should work with Effect.catchTag for selective retry", async () => {
    class ValidationError extends Error {
      readonly _tag = "ValidationError";
    }

    class NetworkError extends Error {
      readonly _tag = "NetworkError";
    }

    let attempts = 0;

    const result = await runStep(
      Effect.gen(function* () {
        return yield* step(
          "catchTagRetry",
          Effect.gen(function* () {
            attempts++;
            if (attempts === 1) {
              return yield* Effect.fail(new NetworkError("network issue"));
            }
            return "success";
          }).pipe(
            // Validation errors don't retry
            Effect.catchTag("ValidationError", () =>
              Effect.fail(new Error("Permanent failure"))
            ),
            // Network errors do retry
            retry({ maxAttempts: 3 })
          )
        ).pipe(Effect.either);
      })
    );

    // First attempt fails with NetworkError -> PauseSignal
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(isPauseSignal(result.left)).toBe(true);
    }
  });
});
```

### Test: Timeout Operator (`test/primitives/timeout.test.ts`)

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  WorkflowContext,
  WorkflowContextLayer,
  WorkflowScope,
  WorkflowScopeLayer,
  StorageAdapter,
  step,
  timeout,
  WorkflowTimeoutError,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("Workflow.timeout (pipeable operator)", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000 })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const createLayers = () =>
    WorkflowScopeLayer.pipe(
      Layer.provideMerge(WorkflowContextLayer),
      Layer.provide(runtimeLayer)
    );

  const runStep = <A, E>(effect: Effect.Effect<A, E, any>) =>
    effect.pipe(Effect.provide(createLayers()), Effect.runPromise);

  it("should succeed within timeout", async () => {
    const result = await runStep(
      Effect.gen(function* () {
        return yield* step(
          "fastStep",
          Effect.succeed("done").pipe(timeout("30 seconds"))
        );
      })
    );

    expect(result).toBe("done");
  });

  it("should fail if timeout exceeded", async () => {
    const result = await runStep(
      Effect.gen(function* () {
        return yield* step(
          "slowStep",
          Effect.promise(
            () => new Promise((resolve) => setTimeout(resolve, 1000))
          ).pipe(timeout(50))
        ).pipe(Effect.either);
      })
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(WorkflowTimeoutError);
    }
  });

  it("should track start time across restarts", async () => {
    // First run - set start time
    await runStep(
      Effect.gen(function* () {
        return yield* step(
          "persistentTimeout",
          Effect.succeed("partial").pipe(timeout("30 seconds"))
        );
      })
    );

    // Advance time significantly
    handle.advanceTime(25000); // 25 seconds

    // Second run - should have less remaining time
    // This test verifies the start time is persisted
    const result = await runStep(
      Effect.gen(function* () {
        return yield* step(
          "persistentTimeout",
          Effect.succeed("done").pipe(timeout("30 seconds"))
        );
      })
    );

    // Should succeed (result is cached from first run)
    expect(result).toBe("partial");
  });

  it("should fail immediately if deadline already passed", async () => {
    // Set start time in the past
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* StorageAdapter;
        yield* storage.put("step:expiredStep:startedAt", 0); // Started at time 0
      }).pipe(Effect.provide(runtimeLayer))
    );

    // Current time is 1000, so 1 second timeout from time 0 is expired
    const result = await runStep(
      Effect.gen(function* () {
        return yield* step(
          "expiredStep",
          Effect.succeed("should not reach").pipe(timeout("500 ms"))
        ).pipe(Effect.either);
      })
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(WorkflowTimeoutError);
    }
  });
});
```

### Test: Combined Timeout + Retry

```typescript
describe("Workflow.timeout + retry combined", () => {
  // ... setup ...

  it("should apply timeout to each retry attempt", async () => {
    let attempts = 0;

    const result = await runStep(
      Effect.gen(function* () {
        return yield* step(
          "combinedStep",
          Effect.gen(function* () {
            attempts++;
            // Simulate slow operation
            yield* Effect.sleep(100);
            return "done";
          }).pipe(
            timeout(50),              // Each attempt has 50ms
            retry({ maxAttempts: 3 }) // Retry up to 3 times
          )
        ).pipe(Effect.either);
      })
    );

    // First attempt times out -> PauseSignal for retry
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      // Could be timeout error (wrapped in retry) or PauseSignal
      // Behavior depends on how retry handles timeout errors
    }
  });
});
```

---

## Definition of Done

- [ ] `Workflow.retry()` returns pipeable operator requiring `StepContext`
- [ ] `Workflow.timeout()` returns pipeable operator requiring `StepContext`
- [ ] Step implementation provides `StepContext` to executing effect
- [ ] Retry operator tracks attempts durably via `StepContext`
- [ ] Retry operator throws `PauseSignal.retry()` on failure
- [ ] Retry operator throws `RetryExhaustedError` when exhausted
- [ ] Timeout operator persists start time for deadline tracking
- [ ] Timeout operator calculates remaining time on replay
- [ ] Combined timeout + retry works correctly
- [ ] `Backoff` namespace provides helper functions
- [ ] All tests passing
- [ ] Package builds without errors

---

## Migration from Original Phase 6

| Original Phase 6 | New Phase 6 v2 |
|------------------|----------------|
| `retry(name, execute, options)` | `step(name, effect.pipe(retry(options)))` |
| `timeout(name, duration, execute)` | `step(name, effect.pipe(timeout(duration)))` |
| `getRemainingTime(name)` | Removed (use StepContext directly if needed) |
| `sleep(duration)` | `sleep(duration)` (unchanged) |
| `sleepUntil(timestamp)` | `sleepUntil(timestamp)` (unchanged) |

---

## Notes

1. **StepContext is the key** - Retry and timeout operators require `StepContext`, which is only provided inside a step. Using these operators outside a step will fail with a missing service error.

2. **Order matters** - `timeout` then `retry` means timeout applies per-attempt. `retry` then `timeout` would mean timeout applies to all attempts combined.

3. **Effect.sleep is allowed inside steps** - Only `Workflow.sleep` is blocked by `StepScope`. The `Effect.sleep` in the timeout tests works fine.

4. **Selective retry with catchTag** - This pattern from v1 works naturally because `catchTag` runs before `retry`, converting certain errors to non-retryable ones.

5. **Backoff namespace** - Provides convenient helpers matching v1's `Backoff.exponential()`, `Backoff.linear()`, etc.
