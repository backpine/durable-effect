# Retry Configuration Plan for @packages/jobs

## Executive Summary

This document outlines a plan to add optional retry configuration to the jobs package (`@packages/jobs`) for Continuous and Debounce job types. The retry system will be modeled after the mature implementation in `@packages/workflow`, with shared types and utilities centralized in `@packages/core`.

**Goals:**
1. Share retry config types and backoff utilities via `@packages/core`
2. Add optional `retry` config to Continuous and Debounce job definitions
3. Implement retry logic within execute handlers using alarm-based scheduling
4. Maintain consistency with existing WorkerPool retry behavior

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Proposed Architecture](#2-proposed-architecture)
3. [Shared Core Types](#3-shared-core-types)
4. [Jobs Package Integration](#4-jobs-package-integration)
5. [Implementation Details](#5-implementation-details)
6. [Migration & Compatibility](#6-migration--compatibility)
7. [Implementation Phases](#7-implementation-phases)

---

## 1. Current State Analysis

### 1.1 Workflow Retry Config (Reference)

The workflow package has a mature retry system in `packages/workflow/src/primitives/`:

```typescript
// packages/workflow/src/primitives/step.ts
interface RetryConfig<E = unknown> {
  readonly maxAttempts: number;
  readonly delay?: DurationInput | BackoffStrategy | ((attempt: number) => number);
  readonly jitter?: boolean;
  readonly isRetryable?: (error: E) => boolean;
  readonly maxDuration?: DurationInput;
}
```

**Backoff Strategies** (`packages/workflow/src/primitives/backoff.ts`):
- `constant` - Fixed delay
- `linear` - Delay increases by fixed amount
- `exponential` - Delay multiplies each attempt
- Presets: `standard`, `aggressive`, `patient`, `simple`

**Utilities:**
- `calculateBackoffDelay(strategy, attempt)` - Compute delay for attempt
- `addJitter(delayMs, factor)` - Add randomness to prevent thundering herd
- `parseDuration(duration)` - Parse human-readable strings like "5 seconds"

### 1.2 Jobs Package Current State

**WorkerPool** already has retry config:
```typescript
// packages/jobs/src/registry/types.ts
interface WorkerPoolRetryConfig {
  readonly maxAttempts: number;
  readonly initialDelay: DurationInput;
  readonly maxDelay?: DurationInput;
  readonly backoffMultiplier?: number;
}
```

**Continuous** - No retry config (errors go to `onError` handler)
**Debounce** - No retry config (errors go to `onError` handler)

### 1.3 Key Differences Between Job Types

| Job Type | Execution Pattern | Retry Semantics |
|----------|-------------------|-----------------|
| **Continuous** | Scheduled, repeating | Retry current execution, then continue schedule |
| **Debounce** | Event-triggered, batched | Retry flush execution before cleanup |
| **WorkerPool** | Event-driven, concurrent | Retry per-event processing |

---

## 2. Proposed Architecture

### 2.1 Package Responsibilities

```
@packages/core
├── retry/
│   ├── types.ts      # RetryConfig, BackoffStrategy types
│   ├── backoff.ts    # Backoff calculation utilities
│   └── index.ts      # Exports

@packages/workflow
├── primitives/
│   ├── step.ts       # Uses core retry types + workflow-specific extensions
│   └── backoff.ts    # Re-exports from core (for backward compatibility)

@packages/jobs
├── retry/
│   ├── executor.ts   # Retry execution logic for jobs
│   └── index.ts
├── handlers/
│   ├── continuous/
│   │   └── handler.ts  # Uses retry executor
│   └── debounce/
│       └── handler.ts  # Uses retry executor
```

### 2.2 Type Hierarchy

```
Core RetryConfig (shared)
    │
    ├── WorkflowRetryConfig (extends with workflow-specific options)
    │   └── isRetryable predicate with WorkflowTimeoutError
    │
    └── JobRetryConfig (extends with job-specific options)
        └── onRetryExhausted callback option
```

---

## 3. Shared Core Types

### 3.1 New Files in @packages/core

#### `packages/core/src/retry/types.ts`

```typescript
import type { Duration } from "effect";

/**
 * Backoff strategy for calculating retry delays.
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
 * Duration input - supports human-readable strings or milliseconds.
 */
export type DurationInput = Duration.DurationInput;

/**
 * Delay configuration for retries.
 * Can be a fixed duration, backoff strategy, or custom function.
 */
export type RetryDelay =
  | DurationInput
  | BackoffStrategy
  | ((attempt: number) => number);

/**
 * Base retry configuration shared across packages.
 */
export interface BaseRetryConfig {
  /**
   * Maximum number of retry attempts (not including initial attempt).
   * Example: maxAttempts: 3 means up to 4 total executions.
   */
  readonly maxAttempts: number;

  /**
   * Delay between retries.
   * - string: Human-readable duration ("5 seconds", "1 minute")
   * - number: Milliseconds
   * - BackoffStrategy: Structured backoff (constant/linear/exponential)
   * - function: Custom delay based on attempt number
   *
   * @default Backoff.presets.standard() (exponential, 1s base, 30s max)
   */
  readonly delay?: RetryDelay;

  /**
   * Whether to add random jitter to delays.
   * Helps prevent thundering herd when multiple jobs retry simultaneously.
   *
   * @default true
   */
  readonly jitter?: boolean;

  /**
   * Maximum total time for all retry attempts.
   * If exceeded, fails immediately without further retries.
   */
  readonly maxDuration?: DurationInput;
}
```

#### `packages/core/src/retry/backoff.ts`

Move the existing backoff utilities from workflow:

```typescript
// Re-export types
export type { BackoffStrategy, DurationInput, RetryDelay } from "./types";

/**
 * Backoff strategy constructors (low-level, milliseconds).
 */
export const BackoffStrategies = {
  constant: (delayMs: number): BackoffStrategy => ({ type: "constant", delayMs }),
  linear: (initialDelayMs: number, incrementMs: number, maxDelayMs?: number): BackoffStrategy => ({
    type: "linear", initialDelayMs, incrementMs, maxDelayMs,
  }),
  exponential: (initialDelayMs: number, options?: { multiplier?: number; maxDelayMs?: number }): BackoffStrategy => ({
    type: "exponential", initialDelayMs, multiplier: options?.multiplier ?? 2, maxDelayMs: options?.maxDelayMs,
  }),
};

/**
 * Calculate delay for a given attempt using backoff strategy.
 */
export function calculateBackoffDelay(strategy: BackoffStrategy, attempt: number): number;

/**
 * Add jitter to a delay value.
 */
export function addJitter(delayMs: number, jitterFactor?: number): number;

/**
 * Parse human-readable duration string to milliseconds.
 */
export function parseDuration(duration: string | number): number;

/**
 * Helper to create backoff strategies with human-readable durations.
 */
export const Backoff = {
  constant: (delay: DurationInput): BackoffStrategy => ...,
  linear: (options: { initial: DurationInput; increment: DurationInput; max?: DurationInput }): BackoffStrategy => ...,
  exponential: (options: { base: DurationInput; factor?: number; max?: DurationInput }): BackoffStrategy => ...,
  presets: {
    standard: () => ...,   // 1s -> 2s -> 4s -> 8s (max 30s)
    aggressive: () => ..., // 100ms -> 200ms -> 400ms (max 5s)
    patient: () => ...,    // 5s -> 10s -> 20s (max 2min)
    simple: () => ...,     // 1s constant
  },
};

/**
 * Resolve delay configuration to milliseconds for a given attempt.
 */
export function resolveDelay(delay: RetryDelay | undefined, attempt: number): number;
```

#### `packages/core/src/retry/index.ts`

```typescript
export type {
  BackoffStrategy,
  DurationInput,
  RetryDelay,
  BaseRetryConfig,
} from "./types";

export {
  BackoffStrategies,
  Backoff,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
  resolveDelay,
} from "./backoff";
```

#### Update `packages/core/src/index.ts`

```typescript
// ... existing exports

// Retry utilities
export type {
  BackoffStrategy,
  DurationInput,
  RetryDelay,
  BaseRetryConfig,
} from "./retry";

export {
  BackoffStrategies,
  Backoff,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
  resolveDelay,
} from "./retry";
```

---

## 4. Jobs Package Integration

### 4.1 Job-Specific Retry Config

```typescript
// packages/jobs/src/retry/types.ts

import type { BaseRetryConfig, DurationInput } from "@durable-effect/core";

/**
 * Retry configuration for job execute handlers.
 * Extends base config with job-specific options.
 */
export interface JobRetryConfig<E = unknown> extends BaseRetryConfig {
  /**
   * Predicate to determine if an error is retryable.
   * Return false to fail immediately without retrying.
   *
   * @default () => true (all errors are retryable)
   */
  readonly isRetryable?: (error: E) => boolean;

  /**
   * Called when all retry attempts are exhausted.
   * Useful for logging, alerting, or custom cleanup.
   *
   * Note: This is called BEFORE the final error is propagated.
   * If this callback throws, the original error is still used.
   */
  readonly onRetryExhausted?: (info: RetryExhaustedInfo<E>) => void;
}

export interface RetryExhaustedInfo<E> {
  readonly jobType: "continuous" | "debounce";
  readonly jobName: string;
  readonly instanceId: string;
  readonly attempts: number;
  readonly lastError: E;
  readonly totalDurationMs: number;
}
```

### 4.2 Updated Job Definitions

#### Continuous Definition

```typescript
// packages/jobs/src/registry/types.ts

export interface UnregisteredContinuousDefinition<S, E, R> {
  readonly _tag: "ContinuousDefinition";
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;

  /**
   * Optional retry configuration for execute handler failures.
   *
   * When configured:
   * - Failed executions are retried up to maxAttempts times
   * - Retries are scheduled via alarm (durable, survives restarts)
   * - After all retries exhausted, onError is called (if defined)
   * - Schedule continues after retry success OR exhaustion
   *
   * When not configured:
   * - Failed executions call onError immediately (if defined)
   * - Schedule continues regardless of error
   */
  readonly retry?: JobRetryConfig<E>;

  execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, R>;
  onError?(error: E, ctx: ContinuousContext<S>): Effect.Effect<void, never, R>;
}
```

#### Debounce Definition

```typescript
export interface UnregisteredDebounceDefinition<I, S, E, R> {
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
   * - After all retries exhausted, onError is called, then cleanup
   *
   * When not configured:
   * - Failed flush calls onError immediately (if defined)
   * - Cleanup happens regardless of error
   */
  readonly retry?: JobRetryConfig<E>;

  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, E, R>;
  onEvent?(ctx: DebounceEventContext<I, S>): Effect.Effect<S, never, R>;
  onError?(error: E, ctx: DebounceExecuteContext<S>): Effect.Effect<void, never, R>;
}
```

### 4.3 Updated Definition Factories

```typescript
// packages/jobs/src/definitions/continuous.ts

import type { JobRetryConfig } from "../retry/types";

export interface ContinuousMakeConfig<S, E, R> {
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;

  /** Optional retry configuration for execute failures */
  readonly retry?: JobRetryConfig<E>;

  execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, R>;
  onError?(error: E, ctx: ContinuousContext<S>): Effect.Effect<void, never, R>;
}

export const Continuous = {
  make: <S, E = never, R = never>(
    config: ContinuousMakeConfig<S, E, R>
  ): UnregisteredContinuousDefinition<S, E, R> => ({
    _tag: "ContinuousDefinition",
    stateSchema: config.stateSchema,
    schedule: config.schedule,
    startImmediately: config.startImmediately,
    retry: config.retry,
    execute: config.execute,
    onError: config.onError,
  }),
};
```

---

## 5. Implementation Details

### 5.1 Retry State Storage

New storage keys for retry tracking:

```typescript
// packages/jobs/src/storage-keys.ts

export const KEYS = {
  // ... existing keys

  // Retry tracking (shared across job types)
  RETRY: {
    ATTEMPT: "retry:attempt",           // Current attempt (1-indexed)
    STARTED_AT: "retry:startedAt",      // When retry sequence started
    LAST_ERROR: "retry:lastError",      // Serialized last error
    SCHEDULED_AT: "retry:scheduledAt",  // When next retry is scheduled
  },
} as const;
```

### 5.2 Retry Executor Service

```typescript
// packages/jobs/src/retry/executor.ts

import { Context, Effect, Layer } from "effect";
import {
  StorageAdapter,
  RuntimeAdapter,
  resolveDelay,
  addJitter,
} from "@durable-effect/core";
import { AlarmService } from "../services/alarm";
import { KEYS } from "../storage-keys";
import type { JobRetryConfig, RetryExhaustedInfo } from "./types";

export interface RetryExecutorI {
  /**
   * Execute an effect with retry logic.
   * Returns the result or fails with RetryExhaustedError.
   */
  readonly executeWithRetry: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    config: JobRetryConfig<E>,
    context: {
      jobType: "continuous" | "debounce";
      jobName: string;
    }
  ) => Effect.Effect<A, E | RetryExhaustedError, R>;

  /**
   * Check if we're currently in a retry attempt.
   */
  readonly isRetrying: () => Effect.Effect<boolean>;

  /**
   * Get current attempt number (1 = first attempt).
   */
  readonly getAttempt: () => Effect.Effect<number>;

  /**
   * Reset retry state (called after success or exhaustion).
   */
  readonly reset: () => Effect.Effect<void>;

  /**
   * Schedule a retry attempt via alarm.
   */
  readonly scheduleRetry: (
    config: JobRetryConfig<unknown>,
    attempt: number
  ) => Effect.Effect<number>; // Returns resumeAt timestamp
}

export class RetryExecutor extends Context.Tag(
  "@durable-effect/jobs/RetryExecutor"
)<RetryExecutor, RetryExecutorI>() {}

export const RetryExecutorLayer = Layer.effect(
  RetryExecutor,
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;
    const alarm = yield* AlarmService;

    const getAttempt = (): Effect.Effect<number> =>
      storage.get<number>(KEYS.RETRY.ATTEMPT).pipe(
        Effect.map((a) => a ?? 1)
      );

    const setAttempt = (attempt: number): Effect.Effect<void> =>
      storage.put(KEYS.RETRY.ATTEMPT, attempt);

    const getStartedAt = (): Effect.Effect<number | undefined> =>
      storage.get<number>(KEYS.RETRY.STARTED_AT);

    const setStartedAt = (timestamp: number): Effect.Effect<void> =>
      storage.put(KEYS.RETRY.STARTED_AT, timestamp);

    const reset = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* storage.delete(KEYS.RETRY.ATTEMPT);
        yield* storage.delete(KEYS.RETRY.STARTED_AT);
        yield* storage.delete(KEYS.RETRY.LAST_ERROR);
        yield* storage.delete(KEYS.RETRY.SCHEDULED_AT);
      });

    return {
      executeWithRetry: <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        config: JobRetryConfig<E>,
        context: { jobType: "continuous" | "debounce"; jobName: string }
      ): Effect.Effect<A, E | RetryExhaustedError, R> =>
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
              const maxMs = Duration.toMillis(config.maxDuration);
              if (elapsed >= maxMs) {
                // Duration exceeded, fail without retry
                const lastError = yield* storage.get<E>(KEYS.RETRY.LAST_ERROR);
                yield* reset();
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
            if (config.onRetryExhausted) {
              const startedAt = (yield* getStartedAt()) ?? now;
              config.onRetryExhausted({
                ...context,
                instanceId: runtime.instanceId,
                attempts: attempt,
                lastError: error,
                totalDurationMs: now - startedAt,
              });
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
          yield* storage.put(KEYS.RETRY.LAST_ERROR, error);
          yield* setAttempt(attempt + 1);

          const baseDelay = resolveDelay(config.delay, attempt);
          const delayMs = config.jitter !== false ? addJitter(baseDelay) : baseDelay;
          const resumeAt = now + delayMs;

          yield* alarm.scheduleAt(resumeAt);
          yield* storage.put(KEYS.RETRY.SCHEDULED_AT, resumeAt);

          // Return a special signal that the handler will catch
          return yield* Effect.fail(new RetryScheduledSignal({ resumeAt, attempt: attempt + 1 }));
        }),

      isRetrying: () => getAttempt().pipe(Effect.map((a) => a > 1)),
      getAttempt,
      reset,

      scheduleRetry: (config, attempt) =>
        Effect.gen(function* () {
          const now = yield* runtime.now();
          const baseDelay = resolveDelay(config.delay, attempt);
          const delayMs = config.jitter !== false ? addJitter(baseDelay) : baseDelay;
          const resumeAt = now + delayMs;

          yield* alarm.scheduleAt(resumeAt);
          yield* storage.put(KEYS.RETRY.SCHEDULED_AT, resumeAt);

          return resumeAt;
        }),
    };
  })
);
```

### 5.3 Handler Integration (Continuous)

```typescript
// packages/jobs/src/handlers/continuous/handler.ts

// In executeUserFunction, wrap with retry logic:

const executeWithOptionalRetry = (
  def: ContinuousDefinition<S, E, R>,
  stateService: EntityStateServiceI<S>,
  runCount: number
): Effect.Effect<void, JobError | RetryScheduledSignal> =>
  Effect.gen(function* () {
    const executeEffect = executeUserFunction(def, stateService, runCount);

    if (!def.retry) {
      // No retry - execute directly, call onError on failure
      return yield* executeEffect.pipe(
        Effect.catchAll((error) => {
          if (def.onError) {
            return def.onError(error, ctx);
          }
          return Effect.fail(error);
        })
      );
    }

    // With retry - use retry executor
    const retryExecutor = yield* RetryExecutor;
    return yield* retryExecutor.executeWithRetry(
      executeEffect,
      def.retry,
      { jobType: "continuous", jobName: def.name }
    ).pipe(
      // On retry exhausted, call onError then propagate
      Effect.catchTag("RetryExhaustedError", (exhausted) =>
        Effect.gen(function* () {
          if (def.onError) {
            yield* def.onError(exhausted.lastError as E, ctx);
          }
          // Don't re-throw - continue to next schedule
          yield* Effect.log(`Retry exhausted for ${def.name}, continuing schedule`);
        })
      ),
      // Let RetryScheduledSignal propagate to skip rescheduling
      Effect.catchTag("RetryScheduledSignal", (signal) =>
        Effect.fail(signal)
      )
    );
  });

// In handleAlarm, check for retry vs normal schedule:

handleAlarm: () =>
  Effect.gen(function* () {
    const retryExecutor = yield* RetryExecutor;
    const isRetrying = yield* retryExecutor.isRetrying();

    if (isRetrying) {
      // This alarm is a retry attempt
      // Don't increment runCount, use same execution context
      yield* executeWithOptionalRetry(def, stateService, lastRunCount);
    } else {
      // Normal scheduled execution
      const runCount = yield* incrementRunCount();
      yield* executeWithOptionalRetry(def, stateService, runCount);
    }

    // Only reschedule if not in retry mode
    const stillRetrying = yield* retryExecutor.isRetrying();
    if (!stillRetrying && currentMeta?.status === "running") {
      yield* scheduleNext(def);
    }
  });
```

### 5.4 Retry Context Extension

Add retry information to execution context:

```typescript
// packages/jobs/src/registry/types.ts

export interface ContinuousContext<S> {
  // ... existing fields

  /**
   * Current retry attempt (1 = first attempt, 2+ = retry).
   * Only available when retry is configured.
   */
  readonly attempt?: number;

  /**
   * Whether this execution is a retry of a previous failure.
   */
  readonly isRetry?: boolean;
}
```

---

## 6. Migration & Compatibility

### 6.1 Backward Compatibility

**No breaking changes:**
- `retry` is optional on all job types
- Existing jobs without retry continue to work
- WorkerPool keeps its existing retry config (but can migrate to shared types)

### 6.2 WorkerPool Migration

The existing `WorkerPoolRetryConfig` can be aligned with the shared types:

```typescript
// Current
interface WorkerPoolRetryConfig {
  readonly maxAttempts: number;
  readonly initialDelay: DurationInput;
  readonly maxDelay?: DurationInput;
  readonly backoffMultiplier?: number;
}

// Can be expressed as JobRetryConfig with:
retry: {
  maxAttempts: 3,
  delay: Backoff.exponential({
    base: "1 second",
    factor: 2,
    max: "30 seconds",
  }),
}
```

**Option A:** Keep WorkerPoolRetryConfig as-is (simpler, specific to queue semantics)
**Option B:** Migrate to JobRetryConfig (consistency, richer options)

**Recommendation:** Keep both for now, deprecate WorkerPoolRetryConfig in future version.

### 6.3 Workflow Package Migration

Update workflow to import shared types from core:

```typescript
// packages/workflow/src/primitives/backoff.ts
// Change to re-export from core

export {
  BackoffStrategy,
  BackoffStrategies,
  Backoff,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
} from "@durable-effect/core";
```

---

## 7. Implementation Phases

### Phase 1: Core Package (Low Risk)

**Files to create/modify:**
- `packages/core/src/retry/types.ts` (new)
- `packages/core/src/retry/backoff.ts` (new - moved from workflow)
- `packages/core/src/retry/index.ts` (new)
- `packages/core/src/index.ts` (update exports)

**Tasks:**
1. Create retry types in core
2. Move backoff utilities from workflow to core
3. Update workflow to import from core (re-export for compatibility)
4. Add tests for backoff utilities in core

**Effort:** Small
**Risk:** Low (mostly moving existing code)

### Phase 2: Jobs Retry Types (Low Risk)

**Files to create/modify:**
- `packages/jobs/src/retry/types.ts` (new)
- `packages/jobs/src/retry/index.ts` (new)
- `packages/jobs/src/registry/types.ts` (add retry to definitions)
- `packages/jobs/src/definitions/continuous.ts` (add retry to config)
- `packages/jobs/src/definitions/debounce.ts` (add retry to config)
- `packages/jobs/src/storage-keys.ts` (add retry keys)

**Tasks:**
1. Create JobRetryConfig type
2. Add retry property to definition types
3. Update definition factories
4. Add retry storage keys

**Effort:** Small
**Risk:** Low (additive changes only)

### Phase 3: Retry Executor Service (Medium Risk)

**Files to create/modify:**
- `packages/jobs/src/retry/executor.ts` (new)
- `packages/jobs/src/services/index.ts` (export executor)

**Tasks:**
1. Implement RetryExecutor service
2. Add RetryScheduledSignal error type
3. Add RetryExhaustedError error type
4. Unit tests for executor logic

**Effort:** Medium
**Risk:** Medium (new execution logic)

### Phase 4: Handler Integration (Medium Risk)

**Files to modify:**
- `packages/jobs/src/handlers/continuous/handler.ts`
- `packages/jobs/src/handlers/continuous/context.ts`
- `packages/jobs/src/handlers/debounce/handler.ts`

**Tasks:**
1. Integrate retry executor in continuous handler
2. Integrate retry executor in debounce handler
3. Add retry info to contexts
4. Handle RetryScheduledSignal properly
5. Integration tests for retry scenarios

**Effort:** Medium
**Risk:** Medium (modifying core execution paths)

### Phase 5: Tracking Events (Optional)

**Files to modify:**
- `packages/jobs/src/events.ts` (if exists, or create)

**Tasks:**
1. Add `retry.scheduled` event
2. Add `retry.exhausted` event
3. Emit events from retry executor

**Effort:** Small
**Risk:** Low (additive)

---

## 8. Usage Examples

### 8.1 Continuous with Retry

```typescript
const apiPoller = Continuous.make({
  stateSchema: PollerState,
  schedule: { _tag: "Every", interval: "5 minutes" },

  retry: {
    maxAttempts: 3,
    delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
    jitter: true,
    isRetryable: (error) => error._tag !== "AuthenticationError",
    onRetryExhausted: (info) => {
      console.error(`Poller ${info.jobName} failed after ${info.attempts} attempts`);
    },
  },

  execute: (ctx) =>
    Effect.gen(function* () {
      if (ctx.isRetry) {
        yield* Effect.log(`Retry attempt ${ctx.attempt}`);
      }

      const data = yield* fetchExternalAPI();
      ctx.updateState((s) => ({ ...s, lastData: data }));
    }),

  onError: (error, ctx) =>
    Effect.log(`All retries exhausted, error: ${error.message}`),
});
```

### 8.2 Debounce with Retry

```typescript
const webhookBatcher = Debounce.make({
  eventSchema: WebhookEvent,
  stateSchema: BatchState,
  flushAfter: "30 seconds",
  maxEvents: 100,

  retry: {
    maxAttempts: 5,
    delay: Backoff.presets.patient(),
    maxDuration: "5 minutes",
  },

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      yield* sendToBatchProcessor(state.events);
    }),

  onError: (error) =>
    Effect.log(`Batch processing failed: ${error.message}`),
});
```

---

## 9. Open Questions

1. **Should retry reset on partial success?**
   - Continuous: If execute succeeds but state persistence fails, retry?
   - Debounce: If execute succeeds but cleanup fails, retry?

2. **Retry scope for debounce?**
   - Should retry only apply to `execute`, or also to `onEvent`?

3. **Alarm conflict resolution?**
   - If retry alarm conflicts with next scheduled alarm, which takes priority?
   - Recommendation: Retry takes priority, reschedule after retry completes

4. **Tracking event granularity?**
   - Track every retry attempt, or just scheduled/exhausted?
   - Recommendation: Track scheduled and exhausted only (volume concern)

---

## 10. Summary

This plan introduces a shared retry system across the durable-effect packages:

1. **Core package** gets reusable retry types and backoff utilities
2. **Jobs package** gets optional retry config for Continuous and Debounce
3. **Workflow package** benefits from shared types (reduces duplication)

The implementation is phased to minimize risk, with each phase delivering incremental value. The retry semantics are designed to be intuitive for job authors while providing robust error handling for production workloads.
