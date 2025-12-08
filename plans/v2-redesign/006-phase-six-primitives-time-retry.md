# Phase 6: Workflow Primitives - Time & Retry (sleep, retry, timeout)

## Overview

This phase implements the time-based workflow primitives: `Workflow.sleep()` for durable pausing, `Workflow.retry()` for durable retries with backoff, and `Workflow.timeout()` for step deadline tracking. These primitives use PauseSignal to pause execution and schedule alarms.

**Duration**: ~3-4 hours
**Dependencies**: Phase 1-5 (adapters, state machine, recovery, context, step)
**Risk Level**: Medium (timing-sensitive logic)

---

## Goals

1. Implement `Workflow.sleep()` for durable pausing
2. Implement `Workflow.retry()` for durable retries with backoff
3. Implement `Workflow.timeout()` for step deadline tracking
4. Create backoff calculation utilities
5. Support pause point tracking for replay

---

## Background: Durable Time Operations

Unlike in-memory sleep/retry, durable time operations must:

1. **Survive restarts** - The operation resumes after process restart
2. **Use pause points** - Track which sleeps/retries have completed
3. **Schedule alarms** - Use the scheduler to wake at the right time
4. **Support replay** - Skip completed pause points on replay

---

## File Structure

```
packages/workflow/src/
├── primitives/
│   ├── sleep.ts               # sleep() implementation
│   ├── retry.ts               # retry() implementation
│   ├── timeout.ts             # timeout() implementation
│   └── backoff.ts             # Backoff calculation utilities
└── test/
    └── primitives/
        ├── sleep.test.ts
        ├── retry.test.ts
        ├── timeout.test.ts
        └── backoff.test.ts
```

---

## Implementation Details

### 1. Backoff Utilities (`primitives/backoff.ts`)

```typescript
// packages/workflow/src/primitives/backoff.ts

/**
 * Backoff strategy for retries.
 */
export type BackoffStrategy =
  | { readonly type: "constant"; readonly delayMs: number }
  | {
      readonly type: "linear";
      readonly initialDelayMs: number;
      readonly incrementMs: number;
      readonly maxDelayMs?: number;
    }
  | {
      readonly type: "exponential";
      readonly initialDelayMs: number;
      readonly multiplier?: number;
      readonly maxDelayMs?: number;
    };

/**
 * Default backoff strategies.
 */
export const BackoffStrategies = {
  /**
   * Constant delay between retries.
   */
  constant: (delayMs: number): BackoffStrategy => ({
    type: "constant",
    delayMs,
  }),

  /**
   * Linear backoff: delay increases by a fixed amount.
   */
  linear: (
    initialDelayMs: number,
    incrementMs: number,
    maxDelayMs?: number
  ): BackoffStrategy => ({
    type: "linear",
    initialDelayMs,
    incrementMs,
    maxDelayMs,
  }),

  /**
   * Exponential backoff: delay doubles (or multiplies) each time.
   */
  exponential: (
    initialDelayMs: number,
    options?: { multiplier?: number; maxDelayMs?: number }
  ): BackoffStrategy => ({
    type: "exponential",
    initialDelayMs,
    multiplier: options?.multiplier ?? 2,
    maxDelayMs: options?.maxDelayMs,
  }),
} as const;

/**
 * Calculate the delay for a given attempt using a backoff strategy.
 *
 * @param strategy - The backoff strategy to use
 * @param attempt - Current attempt number (1-indexed)
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
  strategy: BackoffStrategy,
  attempt: number
): number {
  switch (strategy.type) {
    case "constant":
      return strategy.delayMs;

    case "linear": {
      const delay =
        strategy.initialDelayMs + strategy.incrementMs * (attempt - 1);
      return strategy.maxDelayMs !== undefined
        ? Math.min(delay, strategy.maxDelayMs)
        : delay;
    }

    case "exponential": {
      const multiplier = strategy.multiplier ?? 2;
      const delay = strategy.initialDelayMs * Math.pow(multiplier, attempt - 1);
      return strategy.maxDelayMs !== undefined
        ? Math.min(delay, strategy.maxDelayMs)
        : delay;
    }
  }
}

/**
 * Add jitter to a delay to prevent thundering herd.
 *
 * @param delayMs - Base delay in milliseconds
 * @param jitterFactor - Jitter factor (0-1, default 0.1 = ±10%)
 * @returns Delay with random jitter applied
 */
export function addJitter(delayMs: number, jitterFactor = 0.1): number {
  const jitter = delayMs * jitterFactor;
  return delayMs + (Math.random() * 2 - 1) * jitter;
}

/**
 * Parse a human-readable duration string to milliseconds.
 *
 * Supports: "5s", "5 seconds", "5m", "5 minutes", "5h", "5 hours", "5d", "5 days"
 *
 * @example
 * parseDuration("5 seconds") // 5000
 * parseDuration("1 hour") // 3600000
 * parseDuration("30m") // 1800000
 */
export function parseDuration(duration: string | number): number {
  if (typeof duration === "number") {
    return duration;
  }

  const match = duration.match(/^(\d+(?:\.\d+)?)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days|ms|millisecond|milliseconds)?$/i);

  if (!match) {
    throw new Error(`Invalid duration format: "${duration}"`);
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] || "ms").toLowerCase();

  switch (unit) {
    case "ms":
    case "millisecond":
    case "milliseconds":
      return value;
    case "s":
    case "sec":
    case "second":
    case "seconds":
      return value * 1000;
    case "m":
    case "min":
    case "minute":
    case "minutes":
      return value * 60 * 1000;
    case "h":
    case "hr":
    case "hour":
    case "hours":
      return value * 60 * 60 * 1000;
    case "d":
    case "day":
    case "days":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown duration unit: "${unit}"`);
  }
}
```

### 2. Sleep Primitive (`primitives/sleep.ts`)

```typescript
// packages/workflow/src/primitives/sleep.ts

import { Effect, Option } from "effect";
import { WorkflowContext } from "../context/workflow-context";
import { WorkflowScope, WorkflowScopeError } from "../context/workflow-scope";
import { RuntimeAdapter } from "../adapters/runtime";
import { StorageError } from "../errors";
import { PauseSignal } from "./pause-signal";
import { parseDuration } from "./backoff";

/**
 * Durable sleep that survives process restarts.
 *
 * Unlike Effect.sleep, this:
 * - Persists the wake-up time
 * - Pauses workflow execution
 * - Schedules an alarm to resume
 * - Skips if already completed on replay
 *
 * @param duration - Duration to sleep (string like "5 seconds" or number in ms)
 *
 * @example
 * ```ts
 * // Sleep for 1 hour (survives process restarts!)
 * yield* Workflow.sleep("1 hour");
 *
 * // Sleep for 5 seconds
 * yield* Workflow.sleep("5s");
 *
 * // Sleep for specific milliseconds
 * yield* Workflow.sleep(30000);
 * ```
 */
export function sleep(
  duration: string | number
): Effect.Effect<
  void,
  PauseSignal | StorageError | WorkflowScopeError,
  WorkflowContext | WorkflowScope | RuntimeAdapter
> {
  return Effect.gen(function* () {
    // Verify we're in a workflow scope
    const scope = yield* Effect.serviceOption(WorkflowScope);
    if (Option.isNone(scope)) {
      return yield* Effect.fail(
        new WorkflowScopeError({
          message: "Workflow.sleep() can only be used inside a workflow",
        })
      );
    }

    const workflowCtx = yield* WorkflowContext;
    const runtime = yield* RuntimeAdapter;

    // Get current pause index and increment
    const pauseIndex = yield* workflowCtx.incrementPauseIndex();

    // Check if this pause point was already completed
    const shouldExecute = yield* workflowCtx.shouldExecutePause(pauseIndex);

    if (!shouldExecute) {
      // Already completed on replay - skip
      return;
    }

    // Calculate resume time
    const now = yield* runtime.now();
    const durationMs = parseDuration(duration);
    const resumeAt = now + durationMs;

    // Store pending resume time
    yield* workflowCtx.setPendingResumeAt(resumeAt);

    // Throw PauseSignal - orchestrator will catch this and schedule alarm
    return yield* Effect.fail(PauseSignal.sleep(resumeAt));
  });
}

/**
 * Sleep until a specific timestamp.
 *
 * @param timestamp - Unix timestamp in milliseconds to wake at
 */
export function sleepUntil(
  timestamp: number
): Effect.Effect<
  void,
  PauseSignal | StorageError | WorkflowScopeError,
  WorkflowContext | WorkflowScope | RuntimeAdapter
> {
  return Effect.gen(function* () {
    const scope = yield* Effect.serviceOption(WorkflowScope);
    if (Option.isNone(scope)) {
      return yield* Effect.fail(
        new WorkflowScopeError({
          message: "Workflow.sleepUntil() can only be used inside a workflow",
        })
      );
    }

    const workflowCtx = yield* WorkflowContext;
    const runtime = yield* RuntimeAdapter;

    const pauseIndex = yield* workflowCtx.incrementPauseIndex();
    const shouldExecute = yield* workflowCtx.shouldExecutePause(pauseIndex);

    if (!shouldExecute) {
      return;
    }

    // Check if timestamp is in the past
    const now = yield* runtime.now();
    if (timestamp <= now) {
      // Already past - no need to pause
      return;
    }

    yield* workflowCtx.setPendingResumeAt(timestamp);
    return yield* Effect.fail(PauseSignal.sleep(timestamp));
  });
}
```

### 3. Retry Primitive (`primitives/retry.ts`)

```typescript
// packages/workflow/src/primitives/retry.ts

import { Effect, Option } from "effect";
import { WorkflowContext } from "../context/workflow-context";
import { StepContext, StepContextLayer } from "../context/step-context";
import { WorkflowScope, WorkflowScopeError } from "../context/workflow-scope";
import { StorageAdapter } from "../adapters/storage";
import { RuntimeAdapter } from "../adapters/runtime";
import { StorageError } from "../errors";
import { PauseSignal } from "./pause-signal";
import {
  type BackoffStrategy,
  BackoffStrategies,
  calculateBackoffDelay,
  addJitter,
} from "./backoff";

// =============================================================================
// Types
// =============================================================================

/**
 * Options for durable retry.
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts.
   */
  readonly maxAttempts: number;

  /**
   * Backoff strategy for calculating delays.
   * Default: exponential with 1 second initial delay
   */
  readonly backoff?: BackoffStrategy;

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
}

/**
 * Default retry options.
 */
const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, "isRetryable">> & {
  isRetryable: undefined;
} = {
  maxAttempts: 3,
  backoff: BackoffStrategies.exponential(1000, { maxDelayMs: 60000 }),
  jitter: true,
  isRetryable: undefined,
};

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
 * Execute a step with durable retry logic.
 *
 * Unlike in-memory retries, this:
 * - Survives process restarts
 * - Uses alarms for delays (not blocking)
 * - Tracks attempt count in storage
 * - Allows workflow to be cancelled between retries
 *
 * @param name - Unique name for this retry step
 * @param execute - The effect to execute
 * @param options - Retry configuration
 *
 * @example
 * ```ts
 * const result = yield* Workflow.retry(
 *   "fetchWithRetry",
 *   () => Effect.tryPromise(() => fetch(url)),
 *   {
 *     maxAttempts: 5,
 *     backoff: BackoffStrategies.exponential(1000, { maxDelayMs: 30000 }),
 *   }
 * );
 * ```
 */
export function retry<A, E, R>(
  name: string,
  execute: () => Effect.Effect<A, E, R>,
  options?: Partial<RetryOptions>
): Effect.Effect<
  A,
  E | StorageError | PauseSignal | RetryExhaustedError | WorkflowScopeError,
  WorkflowContext | WorkflowScope | StorageAdapter | RuntimeAdapter | R
> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };

  return Effect.gen(function* () {
    // Verify we're in a workflow scope
    const scope = yield* Effect.serviceOption(WorkflowScope);
    if (Option.isNone(scope)) {
      return yield* Effect.fail(
        new WorkflowScopeError({
          message: `Workflow.retry("${name}") can only be used inside a workflow`,
        })
      );
    }

    const workflowCtx = yield* WorkflowContext;
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    // Create step context for this retry step
    const stepCtx = yield* Effect.provide(
      StepContext,
      StepContextLayer(name).pipe(
        Effect.provideService(StorageAdapter, storage),
        Effect.provideService(RuntimeAdapter, runtime)
      )
    );

    // Check for cached result (step already succeeded)
    const cached = yield* stepCtx.getResult<A>();
    if (cached !== undefined) {
      return cached.value;
    }

    // Check cancellation
    const isCancelled = yield* storage
      .get<boolean>("workflow:cancelled")
      .pipe(Effect.map((c) => c ?? false));

    if (isCancelled) {
      return yield* Effect.fail(
        new RetryExhaustedError(name, 0, new Error("Workflow cancelled"))
      );
    }

    // Get or initialize attempt counter
    const attempt = yield* stepCtx.attempt;

    // Check if we've exceeded max attempts
    if (attempt > opts.maxAttempts) {
      const lastError = yield* stepCtx.getMeta<unknown>("lastError");
      return yield* Effect.fail(
        new RetryExhaustedError(name, attempt - 1, lastError)
      );
    }

    // Set started time if first attempt
    const startedAt = yield* stepCtx.startedAt;
    const now = yield* runtime.now();
    if (startedAt === undefined) {
      yield* stepCtx.setStartedAt(now);
    }

    // Execute the step
    const result = yield* execute().pipe(
      Effect.map((value) => ({ success: true as const, value })),
      Effect.catchAll((error) =>
        Effect.succeed({ success: false as const, error })
      )
    );

    if (result.success) {
      // Success! Cache result and return
      const completedAt = yield* runtime.now();
      yield* stepCtx.setResult(result.value, {
        completedAt,
        attempt,
        durationMs: completedAt - (startedAt ?? now),
      });
      yield* workflowCtx.markStepCompleted(name);

      return result.value;
    }

    // Failure - check if retryable
    if (opts.isRetryable && !opts.isRetryable(result.error)) {
      // Not retryable - fail immediately
      return yield* Effect.fail(result.error as E);
    }

    // Store last error for reporting
    yield* stepCtx.setMeta("lastError", result.error);

    // Increment attempt for next try
    yield* stepCtx.incrementAttempt();

    // Check if we've exhausted retries
    if (attempt >= opts.maxAttempts) {
      return yield* Effect.fail(
        new RetryExhaustedError(name, attempt, result.error)
      );
    }

    // Calculate delay for next attempt
    let delayMs = calculateBackoffDelay(opts.backoff, attempt);
    if (opts.jitter) {
      delayMs = addJitter(delayMs);
    }

    const resumeAt = now + delayMs;

    // Store pending resume
    yield* workflowCtx.setPendingResumeAt(resumeAt);

    // Pause for retry
    return yield* Effect.fail(
      PauseSignal.retry(resumeAt, name, attempt + 1)
    );
  });
}

/**
 * Helper to create retry options with common patterns.
 */
export const RetryStrategies = {
  /**
   * Simple retry with constant delay.
   */
  constant: (
    maxAttempts: number,
    delayMs: number
  ): Partial<RetryOptions> => ({
    maxAttempts,
    backoff: BackoffStrategies.constant(delayMs),
  }),

  /**
   * Exponential backoff with sensible defaults.
   */
  exponential: (
    maxAttempts: number,
    options?: {
      initialDelayMs?: number;
      maxDelayMs?: number;
    }
  ): Partial<RetryOptions> => ({
    maxAttempts,
    backoff: BackoffStrategies.exponential(options?.initialDelayMs ?? 1000, {
      maxDelayMs: options?.maxDelayMs ?? 60000,
    }),
  }),

  /**
   * Aggressive retry for idempotent operations.
   */
  aggressive: (): Partial<RetryOptions> => ({
    maxAttempts: 10,
    backoff: BackoffStrategies.exponential(100, { maxDelayMs: 5000 }),
    jitter: true,
  }),

  /**
   * Patient retry for external services.
   */
  patient: (): Partial<RetryOptions> => ({
    maxAttempts: 5,
    backoff: BackoffStrategies.exponential(5000, { maxDelayMs: 300000 }),
    jitter: true,
  }),
};
```

### 4. Timeout Primitive (`primitives/timeout.ts`)

```typescript
// packages/workflow/src/primitives/timeout.ts

import { Effect, Option } from "effect";
import { WorkflowContext } from "../context/workflow-context";
import { StepContext, StepContextLayer } from "../context/step-context";
import { WorkflowScope, WorkflowScopeError } from "../context/workflow-scope";
import { StorageAdapter } from "../adapters/storage";
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
 * Execute an effect with a durable timeout.
 *
 * Unlike Effect.timeout, this:
 * - Tracks deadline across process restarts
 * - Works with workflow replay
 * - Uses storage to persist start time
 *
 * @param name - Unique name for deadline tracking
 * @param duration - Timeout duration (string like "5 seconds" or number in ms)
 * @param execute - The effect to execute
 *
 * @example
 * ```ts
 * const result = yield* Workflow.timeout(
 *   "processPayment",
 *   "30 seconds",
 *   () => processPaymentEffect()
 * );
 * ```
 */
export function timeout<A, E, R>(
  name: string,
  duration: string | number,
  execute: () => Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  E | StorageError | WorkflowTimeoutError | WorkflowScopeError,
  WorkflowContext | WorkflowScope | StorageAdapter | RuntimeAdapter | R
> {
  return Effect.gen(function* () {
    // Verify we're in a workflow scope
    const scope = yield* Effect.serviceOption(WorkflowScope);
    if (Option.isNone(scope)) {
      return yield* Effect.fail(
        new WorkflowScopeError({
          message: `Workflow.timeout("${name}") can only be used inside a workflow`,
        })
      );
    }

    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    // Create step context for deadline tracking
    const stepCtx = yield* Effect.provide(
      StepContext,
      StepContextLayer(name).pipe(
        Effect.provideService(StorageAdapter, storage),
        Effect.provideService(RuntimeAdapter, runtime)
      )
    );

    // Check for cached result
    const cached = yield* stepCtx.getResult<A>();
    if (cached !== undefined) {
      return cached.value;
    }

    // Get or set start time
    const timeoutMs = parseDuration(duration);
    const now = yield* runtime.now();

    let startedAt = yield* stepCtx.startedAt;
    if (startedAt === undefined) {
      startedAt = now;
      yield* stepCtx.setStartedAt(startedAt);
    }

    // Calculate deadline
    const deadline = startedAt + timeoutMs;
    const remainingMs = deadline - now;

    // Check if already timed out
    if (remainingMs <= 0) {
      return yield* Effect.fail(
        new WorkflowTimeoutError(name, timeoutMs, now - startedAt)
      );
    }

    // Execute with Effect.timeout for the remaining time
    const result = yield* execute().pipe(
      Effect.timeoutFail({
        duration: remainingMs,
        onTimeout: () =>
          new WorkflowTimeoutError(name, timeoutMs, now - startedAt),
      })
    );

    // Cache successful result
    const completedAt = yield* runtime.now();
    yield* stepCtx.setResult(result, {
      completedAt,
      attempt: 1,
      durationMs: completedAt - startedAt,
    });

    return result;
  });
}

/**
 * Check remaining time for a timeout scope.
 *
 * Useful for checking if there's enough time before starting expensive operations.
 */
export function getRemainingTime(
  name: string
): Effect.Effect<
  number | undefined,
  StorageError,
  StorageAdapter | RuntimeAdapter
> {
  return Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    const stepCtx = yield* Effect.provide(
      StepContext,
      StepContextLayer(name).pipe(
        Effect.provideService(StorageAdapter, storage),
        Effect.provideService(RuntimeAdapter, runtime)
      )
    );

    const startedAt = yield* stepCtx.startedAt;
    if (startedAt === undefined) {
      return undefined;
    }

    const deadline = yield* stepCtx.getMeta<number>("deadline");
    if (deadline === undefined) {
      return undefined;
    }

    const now = yield* runtime.now();
    return Math.max(0, deadline - now);
  });
}
```

### 5. Update Primitives Index

```typescript
// packages/workflow/src/primitives/index.ts

// ... existing exports ...

// Sleep
export { sleep, sleepUntil } from "./sleep";

// Retry
export {
  retry,
  RetryStrategies,
  RetryExhaustedError,
  type RetryOptions,
} from "./retry";

// Timeout
export {
  timeout,
  getRemainingTime,
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

### 6. Update Main Index

```typescript
// packages/workflow/src/index.ts

// ... existing exports ...

// Add to primitives exports
export {
  // ... existing ...
  // Sleep
  sleep,
  sleepUntil,
  // Retry
  retry,
  RetryStrategies,
  RetryExhaustedError,
  type RetryOptions,
  // Timeout
  timeout,
  getRemainingTime,
  WorkflowTimeoutError,
  // Backoff
  type BackoffStrategy,
  BackoffStrategies,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
} from "./primitives";
```

---

## Testing Strategy

### Test File: `test/primitives/backoff.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import {
  BackoffStrategies,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
} from "../../src";

describe("Backoff Utilities", () => {
  describe("calculateBackoffDelay", () => {
    it("should calculate constant delay", () => {
      const strategy = BackoffStrategies.constant(1000);

      expect(calculateBackoffDelay(strategy, 1)).toBe(1000);
      expect(calculateBackoffDelay(strategy, 2)).toBe(1000);
      expect(calculateBackoffDelay(strategy, 10)).toBe(1000);
    });

    it("should calculate linear delay", () => {
      const strategy = BackoffStrategies.linear(1000, 500);

      expect(calculateBackoffDelay(strategy, 1)).toBe(1000);
      expect(calculateBackoffDelay(strategy, 2)).toBe(1500);
      expect(calculateBackoffDelay(strategy, 3)).toBe(2000);
    });

    it("should respect linear max delay", () => {
      const strategy = BackoffStrategies.linear(1000, 500, 2000);

      expect(calculateBackoffDelay(strategy, 5)).toBe(2000);
    });

    it("should calculate exponential delay", () => {
      const strategy = BackoffStrategies.exponential(1000);

      expect(calculateBackoffDelay(strategy, 1)).toBe(1000);
      expect(calculateBackoffDelay(strategy, 2)).toBe(2000);
      expect(calculateBackoffDelay(strategy, 3)).toBe(4000);
      expect(calculateBackoffDelay(strategy, 4)).toBe(8000);
    });

    it("should respect exponential max delay", () => {
      const strategy = BackoffStrategies.exponential(1000, { maxDelayMs: 5000 });

      expect(calculateBackoffDelay(strategy, 10)).toBe(5000);
    });
  });

  describe("addJitter", () => {
    it("should add jitter within bounds", () => {
      const base = 1000;
      const jitterFactor = 0.1;

      for (let i = 0; i < 100; i++) {
        const result = addJitter(base, jitterFactor);
        expect(result).toBeGreaterThanOrEqual(base * 0.9);
        expect(result).toBeLessThanOrEqual(base * 1.1);
      }
    });
  });

  describe("parseDuration", () => {
    it("should parse seconds", () => {
      expect(parseDuration("5s")).toBe(5000);
      expect(parseDuration("5 seconds")).toBe(5000);
      expect(parseDuration("5 second")).toBe(5000);
    });

    it("should parse minutes", () => {
      expect(parseDuration("5m")).toBe(300000);
      expect(parseDuration("5 minutes")).toBe(300000);
    });

    it("should parse hours", () => {
      expect(parseDuration("1h")).toBe(3600000);
      expect(parseDuration("1 hour")).toBe(3600000);
    });

    it("should parse days", () => {
      expect(parseDuration("1d")).toBe(86400000);
      expect(parseDuration("1 day")).toBe(86400000);
    });

    it("should pass through numbers", () => {
      expect(parseDuration(5000)).toBe(5000);
    });

    it("should throw on invalid format", () => {
      expect(() => parseDuration("invalid")).toThrow();
    });
  });
});
```

### Test File: `test/primitives/sleep.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  WorkflowContext,
  WorkflowContextLayer,
  WorkflowScope,
  WorkflowScopeLayer,
  sleep,
  sleepUntil,
  PauseSignal,
  isPauseSignal,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("Workflow.sleep", () => {
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

  const runSleep = <A, E>(effect: Effect.Effect<A, E, any>) =>
    effect.pipe(Effect.provide(createLayers()), Effect.runPromise);

  it("should throw PauseSignal with correct resumeAt", async () => {
    const result = await runSleep(
      Effect.gen(function* () {
        return yield* sleep("5 seconds").pipe(Effect.either);
      })
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(isPauseSignal(result.left)).toBe(true);
      const signal = result.left as PauseSignal;
      expect(signal.reason).toBe("sleep");
      expect(signal.resumeAt).toBe(1000 + 5000);
    }
  });

  it("should skip completed pause points on replay", async () => {
    // First run - will pause
    await runSleep(
      Effect.gen(function* () {
        yield* sleep("5 seconds").pipe(Effect.either);
      })
    );

    // Manually update pause index to simulate completed
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* require("../../src").StorageAdapter;
        yield* storage.put("workflow:completedPauseIndex", 1);
      }).pipe(Effect.provide(runtimeLayer))
    );

    // Second run - should skip
    const result = await runSleep(
      Effect.gen(function* () {
        yield* sleep("5 seconds");
        return "completed";
      })
    );

    expect(result).toBe("completed");
  });

  it("should fail outside workflow scope", async () => {
    const result = await Effect.gen(function* () {
      return yield* sleep("5 seconds").pipe(Effect.either);
    }).pipe(
      // No WorkflowScopeLayer
      Effect.provide(WorkflowContextLayer),
      Effect.provide(runtimeLayer),
      Effect.runPromise
    );

    expect(result._tag).toBe("Left");
  });
});

describe("Workflow.sleepUntil", () => {
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

  it("should throw PauseSignal with exact timestamp", async () => {
    const result = await Effect.gen(function* () {
      return yield* sleepUntil(5000).pipe(Effect.either);
    }).pipe(Effect.provide(createLayers()), Effect.runPromise);

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const signal = result.left as PauseSignal;
      expect(signal.resumeAt).toBe(5000);
    }
  });

  it("should not pause if timestamp is in the past", async () => {
    const result = await Effect.gen(function* () {
      yield* sleepUntil(500); // Past (current time is 1000)
      return "completed";
    }).pipe(Effect.provide(createLayers()), Effect.runPromise);

    expect(result).toBe("completed");
  });
});
```

### Test File: `test/primitives/retry.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  WorkflowContext,
  WorkflowContextLayer,
  WorkflowScope,
  WorkflowScopeLayer,
  StorageAdapter,
  retry,
  RetryStrategies,
  RetryExhaustedError,
  PauseSignal,
  isPauseSignal,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("Workflow.retry", () => {
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

  const runRetry = <A, E>(effect: Effect.Effect<A, E, any>) =>
    effect.pipe(Effect.provide(createLayers()), Effect.runPromise);

  it("should succeed on first attempt if no error", async () => {
    let attempts = 0;

    const result = await runRetry(
      Effect.gen(function* () {
        return yield* retry(
          "successfulStep",
          () =>
            Effect.sync(() => {
              attempts++;
              return "success";
            }),
          { maxAttempts: 3 }
        );
      })
    );

    expect(result).toBe("success");
    expect(attempts).toBe(1);
  });

  it("should return cached result on replay", async () => {
    let attempts = 0;

    // First run - success
    await runRetry(
      Effect.gen(function* () {
        return yield* retry(
          "cachedStep",
          () =>
            Effect.sync(() => {
              attempts++;
              return "cached";
            }),
          { maxAttempts: 3 }
        );
      })
    );

    expect(attempts).toBe(1);

    // Second run - should use cache
    const result = await runRetry(
      Effect.gen(function* () {
        return yield* retry(
          "cachedStep",
          () =>
            Effect.sync(() => {
              attempts++;
              return "new";
            }),
          { maxAttempts: 3 }
        );
      })
    );

    expect(result).toBe("cached");
    expect(attempts).toBe(1); // Still 1
  });

  it("should throw PauseSignal on failure for retry", async () => {
    const result = await runRetry(
      Effect.gen(function* () {
        return yield* retry(
          "failingStep",
          () => Effect.fail(new Error("always fails")),
          { maxAttempts: 3 }
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
        yield* storage.put("step:exhaustedStep:attempt", 4); // Already at attempt 4 > maxAttempts 3
      }).pipe(Effect.provide(runtimeLayer))
    );

    const result = await runRetry(
      Effect.gen(function* () {
        return yield* retry(
          "exhaustedStep",
          () => Effect.fail(new Error("fails")),
          { maxAttempts: 3 }
        ).pipe(Effect.either);
      })
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(RetryExhaustedError);
    }
  });

  it("should use backoff strategy for delay calculation", async () => {
    const result = await runRetry(
      Effect.gen(function* () {
        return yield* retry(
          "backoffStep",
          () => Effect.fail(new Error("fails")),
          RetryStrategies.exponential(5, { initialDelayMs: 1000 })
        ).pipe(Effect.either);
      })
    );

    if (result._tag === "Left" && isPauseSignal(result.left)) {
      const signal = result.left as PauseSignal;
      // First failure, delay should be ~1000ms from now
      expect(signal.resumeAt).toBeGreaterThanOrEqual(2000);
      expect(signal.resumeAt).toBeLessThan(3000); // With jitter
    }
  });
});
```

---

## Definition of Done

- [ ] Backoff strategies implemented (constant, linear, exponential)
- [ ] parseDuration handles all time formats
- [ ] addJitter provides random variation
- [ ] Workflow.sleep() throws PauseSignal
- [ ] Workflow.sleepUntil() handles specific timestamps
- [ ] Sleep skips completed pause points
- [ ] Workflow.retry() implements durable retry
- [ ] Retry caches successful results
- [ ] RetryExhaustedError thrown after max attempts
- [ ] Workflow.timeout() tracks deadlines
- [ ] All tests passing
- [ ] Package builds without errors

---

## Notes for Implementation

1. **Pause points must be deterministic** - Same pause index on replay
2. **PauseSignal is control flow** - Not an error, caught by orchestrator
3. **Backoff with jitter prevents thundering herd** - Always add some randomness
4. **Timeout deadlines persist** - Start time saved for replay
5. **parseDuration is user-friendly** - Accept "5 seconds" not just milliseconds
