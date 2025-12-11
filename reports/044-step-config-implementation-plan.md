# Report 044: Step Config API Implementation Plan

**Date**: 2024-12-10
**Package**: `@durable-effect/workflow`
**Scope**: Complete implementation plan for unified step configuration API

---

## Executive Summary

This document provides a complete implementation plan to replace the piped `Workflow.retry()` and `Workflow.timeout()` operators with a unified config-based `Workflow.step()` API. This is a **breaking change** that simplifies the codebase by removing two primitives and consolidating functionality into the step function.

### Key Decisions

1. **Breaking change** - Remove `Workflow.retry()` and `Workflow.timeout()` pipeable operators
2. **Config-based step** - All step options in a single configuration object
3. **Unified patterns** - Reuse existing `Backoff`, `BackoffStrategies`, `parseDuration` utilities
4. **Schema validation deferred** - Input/output validation to be added later
5. **Cleaner code** - Fewer primitives, simpler mental model

---

## Part 1: Current State

### 1.1 Files to Modify/Delete

| File | Action | Reason |
|------|--------|--------|
| `src/primitives/step.ts` | **Modify** | Add config overload, integrate retry/timeout |
| `src/primitives/retry.ts` | **Delete** | Logic moves into step.ts |
| `src/primitives/timeout.ts` | **Delete** | Logic moves into step.ts |
| `src/primitives/backoff.ts` | **Keep** | Shared utilities (no changes) |
| `src/primitives/index.ts` | **Modify** | Update exports |
| `src/index.ts` | **Modify** | Update exports |
| `test/primitives/retry.test.ts` | **Delete → Merge** | Tests move to step.test.ts |
| `test/primitives/timeout.test.ts` | **Delete → Merge** | Tests move to step.test.ts |
| `test/primitives/step.test.ts` | **Modify** | Add config-based tests |
| `examples/effect-worker/src/workflows.ts` | **Modify** | Update to new API |

### 1.2 Current Exports to Remove

```typescript
// From src/primitives/index.ts - TO REMOVE:
export {
  retry,                // REMOVE - becomes step config
  Backoff,              // KEEP - reexport from backoff.ts
  RetryExhaustedError,  // KEEP - still needed
  type RetryOptions,    // REMOVE - replaced by RetryConfig
  type DelayConfig,     // REMOVE - replaced by unified type
} from "./retry";

export { timeout, WorkflowTimeoutError } from "./timeout";
// timeout - REMOVE
// WorkflowTimeoutError - KEEP - still needed
```

### 1.3 Current Line Counts

| File | Lines | After Consolidation |
|------|-------|---------------------|
| `step.ts` | 242 | ~350 (absorbs retry/timeout logic) |
| `retry.ts` | 360 | 0 (deleted) |
| `timeout.ts` | 156 | 0 (deleted) |
| **Total** | 758 | ~350 (**54% reduction**) |

---

## Part 2: New API Design

### 2.1 Step Function Signatures

```typescript
// Signature 1: Simple step (name + effect)
export function step<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, StepErrors<E>, StepRequirements<R>>;

// Signature 2: Config-based step
export function step<A, E, R>(
  name: string,
  config: StepConfig<A, E, R>,
): Effect.Effect<A, StepErrors<E>, StepRequirements<R>>;
```

### 2.2 StepConfig Interface

```typescript
/**
 * Configuration for a durable workflow step.
 */
export interface StepConfig<A, E, R> {
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
```

### 2.3 RetryConfig Interface

```typescript
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
   *
   * @example
   * isRetryable: (e) => !(e instanceof ValidationError)
   */
  readonly isRetryable?: (error: unknown) => boolean;

  /**
   * Maximum total duration for all retry attempts.
   * If exceeded, fails with RetryExhaustedError.
   */
  readonly maxDuration?: DurationInput;
}
```

### 2.4 Duration Input Type

```typescript
/**
 * Flexible duration input supporting multiple formats.
 */
export type DurationInput = string | number;
// string: "5 seconds", "1 minute", "500ms", etc.
// number: milliseconds
```

---

## Part 3: Usage Examples

### 3.1 Simple Step (Unchanged)

```typescript
// Works exactly as before
const user = yield* Workflow.step("Fetch user", fetchUser(userId));
```

### 3.2 Step with Retry

```typescript
// Before (piped)
const data = yield* Workflow.step("Fetch data",
  fetchData().pipe(
    Workflow.retry({ maxAttempts: 3 })
  )
);

// After (config)
const data = yield* Workflow.step("Fetch data", {
  execute: fetchData(),
  retry: { maxAttempts: 3 },
});
```

### 3.3 Step with Timeout

```typescript
// Before (piped)
const result = yield* Workflow.step("Process",
  heavyComputation().pipe(
    Workflow.timeout("30 seconds")
  )
);

// After (config)
const result = yield* Workflow.step("Process", {
  execute: heavyComputation(),
  timeout: "30 seconds",
});
```

### 3.4 Step with Retry + Timeout

```typescript
// Before (order matters!)
const payment = yield* Workflow.step("Process payment",
  processPayment(order).pipe(
    Workflow.timeout("10 seconds"),  // Must be BEFORE retry
    Workflow.retry({
      maxAttempts: 3,
      delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
    }),
  )
);

// After (order enforced by design)
const payment = yield* Workflow.step("Process payment", {
  execute: processPayment(order),
  timeout: "10 seconds",
  retry: {
    maxAttempts: 3,
    delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
  },
});
```

### 3.5 Step with Selective Retry

```typescript
const result = yield* Workflow.step("External API", {
  execute: callExternalAPI(),
  retry: {
    maxAttempts: 5,
    delay: Backoff.presets.patient(),
    isRetryable: (error) => {
      // Only retry transient errors
      if (error instanceof ValidationError) return false;
      if (error instanceof AuthenticationError) return false;
      return true;
    },
  },
  timeout: "30 seconds",
});
```

### 3.6 Step with Max Duration

```typescript
const result = yield* Workflow.step("Long running task", {
  execute: longRunningTask(),
  retry: {
    maxAttempts: 10,
    delay: Backoff.exponential({ base: "1 second", max: "1 minute" }),
    maxDuration: "5 minutes",  // Total time budget
  },
  timeout: "30 seconds",  // Per-attempt timeout
});
```

---

## Part 4: Implementation Details

### 4.1 New step.ts Structure

```typescript
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

export type DurationInput = string | number;

export interface RetryConfig {
  readonly maxAttempts: number;
  readonly delay?: DurationInput | BackoffStrategy | ((attempt: number) => number);
  readonly jitter?: boolean;
  readonly isRetryable?: (error: unknown) => boolean;
  readonly maxDuration?: DurationInput;
}

export interface StepConfig<A, E, R> {
  readonly execute: Effect.Effect<A, E, R>;
  readonly retry?: RetryConfig;
  readonly timeout?: DurationInput;
}

export class StepCancelledError extends Error {
  readonly _tag = "StepCancelledError";
  readonly stepName: string;
  constructor(stepName: string) {
    super(`Step "${stepName}" was cancelled`);
    this.name = "StepCancelledError";
    this.stepName = stepName;
  }
}

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
// Type Guards
// =============================================================================

function isStepConfig<A, E, R>(
  value: StepConfig<A, E, R> | Effect.Effect<A, E, R>
): value is StepConfig<A, E, R> {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    Effect.isEffect((value as StepConfig<A, E, R>).execute)
  );
}

function isBackoffStrategy(value: unknown): value is BackoffStrategy {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    ["constant", "linear", "exponential"].includes((value as any).type)
  );
}

// =============================================================================
// Delay Calculation (from retry.ts)
// =============================================================================

function getDelay(
  config: RetryConfig["delay"],
  attempt: number
): number {
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

// =============================================================================
// Main Step Implementation
// =============================================================================

export function step<A, E, R>(
  name: string,
  configOrEffect: StepConfig<A, E, R> | Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  | E
  | StorageError
  | StepCancelledError
  | WorkflowScopeError
  | PauseSignal
  | RetryExhaustedError
  | WorkflowTimeoutError,
  | WorkflowContext
  | StorageAdapter
  | RuntimeAdapter
  | WorkflowLevel
  | Exclude<R, StepContext | StorageAdapter | RuntimeAdapter | StepScope>
> {
  // Normalize to config
  const config: StepConfig<A, E, R> = isStepConfig(configOrEffect)
    ? configOrEffect
    : { execute: configOrEffect };

  return stepWithConfig(name, config);
}

function stepWithConfig<A, E, R>(
  name: string,
  config: StepConfig<A, E, R>,
): Effect.Effect<A, /* errors */, /* requirements */> {
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
        })
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
              lastError ?? new Error("Max duration exceeded")
            )
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
          new RetryExhaustedError(name, currentAttempt - 1, lastError)
        );
      }
    }

    // -------------------------------------------------------------------------
    // Phase 6: Build the effect with timeout if configured
    // -------------------------------------------------------------------------
    let effect = config.execute;

    if (config.timeout) {
      const timeoutMs = parseDuration(config.timeout);
      const effectStartedAt = startedAt ?? now;
      const deadline = effectStartedAt + timeoutMs;
      const remainingMs = deadline - now;

      if (remainingMs <= 0) {
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName, executionId),
          type: "timeout.exceeded",
          stepName: name,
          timeoutMs,
        });

        return yield* Effect.fail(
          new WorkflowTimeoutError(name, timeoutMs, now - effectStartedAt)
        );
      }

      effect = effect.pipe(
        Effect.timeoutFail({
          duration: remainingMs,
          onTimeout: () => new WorkflowTimeoutError(name, timeoutMs, now - effectStartedAt),
        })
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
      Layer.succeed(RuntimeAdapter, runtime)
    );

    const effectResult = yield* effect.pipe(
      Effect.provide(stepLayer),
      Effect.map((value) => ({ _tag: "Success" as const, value })),
      Effect.catchAll((error) =>
        Effect.succeed({ _tag: "Failure" as const, error: error as E | WorkflowTimeoutError })
      )
    );

    // -------------------------------------------------------------------------
    // Phase 8: Handle failure with retry logic
    // -------------------------------------------------------------------------
    if (effectResult._tag === "Failure") {
      const error = effectResult.error;

      // Never retry PauseSignal, StepScopeError, or WorkflowTimeoutError at max attempts
      if (isPauseSignal(error)) {
        return yield* Effect.fail(error);
      }

      if (error instanceof StepScopeError) {
        return yield* Effect.fail(error);
      }

      // Check if retry is configured
      if (!config.retry) {
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
          new RetryExhaustedError(name, currentAttempt, error)
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
        PauseSignal.retry(resumeAt, name, currentAttempt + 1)
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
```

### 4.2 Updated primitives/index.ts

```typescript
// packages/workflow/src/primitives/index.ts

// PauseSignal
export { PauseSignal, isPauseSignal, type PauseReason } from "./pause-signal";

// Workflow.make
export {
  make,
  type WorkflowDefinition,
  type WorkflowEffect,
  type WorkflowInput,
  type WorkflowOutput,
  type WorkflowError,
  type WorkflowRequirements,
} from "./make";

// Workflow.step (with integrated retry/timeout)
export {
  step,
  StepCancelledError,
  RetryExhaustedError,
  WorkflowTimeoutError,
  type StepConfig,
  type RetryConfig,
  type DurationInput,
} from "./step";

// Workflow.sleep
export { sleep, sleepUntil } from "./sleep";

// Backoff utilities
export {
  Backoff,
  type BackoffStrategy,
  BackoffStrategies,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
} from "./backoff";
```

### 4.3 Updated backoff.ts (Add Backoff Export)

```typescript
// packages/workflow/src/primitives/backoff.ts

// ... existing code ...

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
      maxDelayMs: options.max !== undefined ? parseDuration(options.max) : undefined,
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
```

---

## Part 5: Test Updates

### 5.1 New step.test.ts Structure

```typescript
// packages/workflow/test/primitives/step.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  StorageAdapter,
  WorkflowContextLayer,
  WorkflowScopeLayer,
  WorkflowLevelLayer,
  step,
  Backoff,
  StepCancelledError,
  RetryExhaustedError,
  WorkflowTimeoutError,
  PauseSignal,
  isPauseSignal,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("Workflow.step", () => {
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
      Layer.provideMerge(WorkflowLevelLayer),
      Layer.provideMerge(runtimeLayer)
    );

  const runStep = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(createLayers() as Layer.Layer<R>),
      Effect.runPromise
    );

  // ===========================================================================
  // BASIC EXECUTION (existing tests)
  // ===========================================================================
  describe("basic execution", () => {
    it("should execute step and return result", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("myStep", Effect.succeed(42));
        })
      );
      expect(result).toBe(42);
    });

    it("should execute config-based step and return result", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("myStep", {
            execute: Effect.succeed(42),
          });
        })
      );
      expect(result).toBe(42);
    });

    // ... rest of existing basic tests ...
  });

  // ===========================================================================
  // RETRY (from retry.test.ts)
  // ===========================================================================
  describe("retry", () => {
    it("should succeed on first attempt if no error", async () => {
      let attempts = 0;

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("successfulStep", {
            execute: Effect.sync(() => {
              attempts++;
              return "success";
            }),
            retry: { maxAttempts: 3 },
          });
        })
      );

      expect(result).toBe("success");
      expect(attempts).toBe(1);
    });

    it("should throw PauseSignal on failure for retry", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("failingStep", {
            execute: Effect.fail(new Error("always fails")),
            retry: { maxAttempts: 3 },
          }).pipe(Effect.either);
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

    it("should calculate delay using backoff strategy", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("backoffStep", {
            execute: Effect.fail(new Error("fails")),
            retry: {
              maxAttempts: 5,
              delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
              jitter: false,
            },
          }).pipe(Effect.either);
        })
      );

      if (result._tag === "Left" && isPauseSignal(result.left)) {
        const signal = result.left as PauseSignal;
        expect(signal.resumeAt).toBe(2000); // 1000 (now) + 1000 (delay)
      }
    });

    it("should throw RetryExhaustedError after max attempts", async () => {
      // Simulate being at max attempts
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("step:exhaustedStep:attempt", 5);
        }).pipe(Effect.provide(runtimeLayer))
      );

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("exhaustedStep", {
            execute: Effect.fail(new Error("fails")),
            retry: { maxAttempts: 3 },
          }).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RetryExhaustedError);
      }
    });

    it("should respect isRetryable function", async () => {
      class NonRetryableError extends Error {
        readonly _tag = "NonRetryableError";
      }

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("selectiveRetry", {
            execute: Effect.fail(new NonRetryableError("not retryable")),
            retry: {
              maxAttempts: 3,
              isRetryable: (e) => !(e instanceof NonRetryableError),
            },
          }).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(NonRetryableError);
      }
    });

    describe("delay config variations", () => {
      it("should accept string delay", async () => {
        const result = await runStep(
          Effect.gen(function* () {
            return yield* step("stringDelay", {
              execute: Effect.fail(new Error("fails")),
              retry: { maxAttempts: 3, delay: "2 seconds", jitter: false },
            }).pipe(Effect.either);
          })
        );

        if (result._tag === "Left" && isPauseSignal(result.left)) {
          expect(result.left.resumeAt).toBe(3000); // 1000 + 2000
        }
      });

      it("should accept number delay", async () => {
        const result = await runStep(
          Effect.gen(function* () {
            return yield* step("numberDelay", {
              execute: Effect.fail(new Error("fails")),
              retry: { maxAttempts: 3, delay: 1500, jitter: false },
            }).pipe(Effect.either);
          })
        );

        if (result._tag === "Left" && isPauseSignal(result.left)) {
          expect(result.left.resumeAt).toBe(2500); // 1000 + 1500
        }
      });

      it("should accept function delay", async () => {
        const result = await runStep(
          Effect.gen(function* () {
            return yield* step("functionDelay", {
              execute: Effect.fail(new Error("fails")),
              retry: {
                maxAttempts: 3,
                delay: (attempt) => attempt * 1000,
                jitter: false,
              },
            }).pipe(Effect.either);
          })
        );

        if (result._tag === "Left" && isPauseSignal(result.left)) {
          expect(result.left.resumeAt).toBe(2000); // 1000 + 1000
        }
      });
    });
  });

  // ===========================================================================
  // TIMEOUT (from timeout.test.ts)
  // ===========================================================================
  describe("timeout", () => {
    it("should succeed within timeout", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("fastStep", {
            execute: Effect.succeed("done"),
            timeout: "30 seconds",
          });
        })
      );

      expect(result).toBe("done");
    });

    it("should fail if operation times out", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("slowStep", {
            execute: Effect.promise(
              () => new Promise((resolve) => setTimeout(resolve, 1000))
            ),
            timeout: 50,
          }).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(WorkflowTimeoutError);
        const error = result.left as WorkflowTimeoutError;
        expect(error.stepName).toBe("slowStep");
        expect(error.timeoutMs).toBe(50);
      }
    });

    it("should fail immediately if deadline already passed", async () => {
      // Set start time in the past
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("step:expiredStep:startedAt", 0);
        }).pipe(Effect.provide(runtimeLayer))
      );

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("expiredStep", {
            execute: Effect.succeed("should not reach"),
            timeout: "500ms",
          }).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(WorkflowTimeoutError);
      }
    });
  });

  // ===========================================================================
  // COMBINED RETRY + TIMEOUT
  // ===========================================================================
  describe("retry + timeout combined", () => {
    it("should apply timeout per attempt", async () => {
      let attempts = 0;

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("retryWithTimeout", {
            execute: Effect.gen(function* () {
              attempts++;
              // Simulate slow operation that times out
              yield* Effect.promise(
                () => new Promise((resolve) => setTimeout(resolve, 1000))
              );
              return "done";
            }),
            timeout: 50,  // Will timeout
            retry: { maxAttempts: 3 },
          }).pipe(Effect.either);
        })
      );

      expect(attempts).toBe(1);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        // First timeout should trigger retry pause
        expect(isPauseSignal(result.left)).toBe(true);
      }
    });

    it("should succeed on retry after previous timeout", async () => {
      let attempts = 0;

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("retryAfterTimeout", {
            execute: Effect.sync(() => {
              attempts++;
              return "success";
            }),
            timeout: "30 seconds",
            retry: { maxAttempts: 3 },
          });
        })
      );

      expect(result).toBe("success");
      expect(attempts).toBe(1);
    });
  });
});
```

---

## Part 6: Migration Checklist

### 6.1 Files to Create/Modify

| # | File | Action | Description |
|---|------|--------|-------------|
| 1 | `src/primitives/step.ts` | Modify | Add config support, integrate retry/timeout |
| 2 | `src/primitives/backoff.ts` | Modify | Add `Backoff` helper export |
| 3 | `src/primitives/retry.ts` | Delete | Logic moved to step.ts |
| 4 | `src/primitives/timeout.ts` | Delete | Logic moved to step.ts |
| 5 | `src/primitives/index.ts` | Modify | Update exports |
| 6 | `src/index.ts` | Modify | Update exports |
| 7 | `test/primitives/step.test.ts` | Modify | Add config tests, merge retry/timeout tests |
| 8 | `test/primitives/retry.test.ts` | Delete | Tests moved to step.test.ts |
| 9 | `test/primitives/timeout.test.ts` | Delete | Tests moved to step.test.ts |
| 10 | `examples/effect-worker/src/workflows.ts` | Modify | Update to new API |
| 11 | `README.md` | Modify | Update examples |
| 12 | `ARCHITECTURE.md` | Modify | Update primitives section |

### 6.2 Export Changes

**Remove from public API:**
- `retry` function
- `timeout` function
- `RetryOptions` type
- `DelayConfig` type

**Keep in public API:**
- `Backoff` (move from retry.ts to backoff.ts)
- `RetryExhaustedError` (move to step.ts)
- `WorkflowTimeoutError` (move to step.ts)
- `BackoffStrategy` type
- `BackoffStrategies`
- `parseDuration`

**Add to public API:**
- `StepConfig` type
- `RetryConfig` type
- `DurationInput` type

### 6.3 Implementation Order

```
Phase 1: Preparation
├── 1.1 Move Backoff export to backoff.ts
├── 1.2 Move RetryExhaustedError to step.ts
└── 1.3 Move WorkflowTimeoutError to step.ts

Phase 2: Core Implementation
├── 2.1 Add StepConfig types to step.ts
├── 2.2 Add isStepConfig type guard
├── 2.3 Implement stepWithConfig function
├── 2.4 Update step function to handle both signatures
└── 2.5 Integrate retry and timeout logic

Phase 3: Cleanup
├── 3.1 Delete retry.ts
├── 3.2 Delete timeout.ts
├── 3.3 Update primitives/index.ts exports
└── 3.4 Update src/index.ts exports

Phase 4: Tests
├── 4.1 Merge retry.test.ts into step.test.ts
├── 4.2 Merge timeout.test.ts into step.test.ts
├── 4.3 Add new config-based tests
├── 4.4 Delete old test files
└── 4.5 Run full test suite

Phase 5: Examples & Docs
├── 5.1 Update examples/effect-worker/src/workflows.ts
├── 5.2 Update README.md
└── 5.3 Update ARCHITECTURE.md
```

---

## Part 7: Breaking Changes Summary

### 7.1 Removed APIs

| Removed | Replacement |
|---------|-------------|
| `Workflow.retry({ ... })` | `Workflow.step(name, { execute: effect, retry: { ... } })` |
| `Workflow.timeout(duration)` | `Workflow.step(name, { execute: effect, timeout: duration })` |
| `effect.pipe(Workflow.retry(...))` | `{ execute: effect, retry: ... }` |
| `effect.pipe(Workflow.timeout(...))` | `{ execute: effect, timeout: ... }` |
| `RetryOptions` type | `RetryConfig` type |
| `DelayConfig` type | `DurationInput | BackoffStrategy | ((attempt: number) => number)` |

### 7.2 Migration Examples

```typescript
// BEFORE: Retry only
yield* Workflow.step("fetch",
  fetchData().pipe(Workflow.retry({ maxAttempts: 3 }))
);

// AFTER
yield* Workflow.step("fetch", {
  execute: fetchData(),
  retry: { maxAttempts: 3 },
});

// BEFORE: Timeout only
yield* Workflow.step("process",
  heavyComputation().pipe(Workflow.timeout("30 seconds"))
);

// AFTER
yield* Workflow.step("process", {
  execute: heavyComputation(),
  timeout: "30 seconds",
});

// BEFORE: Both (order matters!)
yield* Workflow.step("payment",
  processPayment().pipe(
    Workflow.timeout("10 seconds"),
    Workflow.retry({ maxAttempts: 3, delay: Backoff.exponential({ base: "1s" }) })
  )
);

// AFTER (order enforced)
yield* Workflow.step("payment", {
  execute: processPayment(),
  timeout: "10 seconds",
  retry: {
    maxAttempts: 3,
    delay: Backoff.exponential({ base: "1s" }),
  },
});
```

---

## Part 8: Benefits

### 8.1 Code Reduction

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Primitive files | 5 | 3 | -40% |
| Total lines | ~758 | ~350 | -54% |
| Public exports | 18 | 14 | -22% |
| Test files | 5 | 3 | -40% |

### 8.2 DX Improvements

1. **No order-dependence** - Timeout is always per-attempt by design
2. **Discoverability** - All options visible in config object
3. **Type inference** - Single source of truth for step configuration
4. **Simpler mental model** - One function to learn, not three

### 8.3 Maintenance Benefits

1. **Single implementation** - Retry/timeout logic in one place
2. **Fewer edge cases** - No pipe ordering bugs
3. **Easier testing** - Unified test structure
4. **Cleaner architecture** - Fewer primitives to maintain

---

## Conclusion

This implementation plan consolidates `Workflow.step()`, `Workflow.retry()`, and `Workflow.timeout()` into a single, config-based API. The result is:

1. **~54% reduction in primitive code**
2. **Cleaner public API** with fewer exports
3. **Better DX** with discoverable config options
4. **Correct semantics enforced by design** (timeout per attempt)
5. **Simpler maintenance** with unified implementation

The breaking change is justified because:
- The old API had a subtle footgun (pipe order)
- The new API is more intuitive
- Migration is straightforward (find-and-replace patterns)
- Benefits outweigh migration cost
