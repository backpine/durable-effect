# Enhanced Retry Features

## Summary

Add exponential backoff and other retry strategies to the workflow package with an ergonomic, type-safe API that maintains backward compatibility.

## Current State

The existing `RetryOptions` interface supports:

```typescript
export interface RetryOptions {
  readonly maxAttempts: number;
  readonly delay?: Duration.DurationInput | ((attempt: number) => Duration.DurationInput);
  readonly while?: (error: unknown) => boolean;
}
```

**Current capabilities:**
- Fixed delay: `delay: "5 seconds"`
- Custom function: `delay: (attempt) => Duration.millis(1000 * Math.pow(2, attempt))`
- Conditional retry: `while: (err) => isTransient(err)`

**Limitation:** Users must manually implement exponential backoff, jitter, and caps.

---

## Design Goals

1. **Simplify API** - Remove unused `while` option
2. **Backward compatible** - Existing `delay` option continues working
3. **Progressive complexity** - Simple cases stay simple
4. **Composable** - Strategies can be combined with jitter, caps
5. **Effect-idiomatic** - Uses Duration types
6. **Type-safe** - Discriminated unions for backoff types
7. **Ergonomic** - Presets for common patterns

---

## Step 1: Remove the `while` Feature

The `while` conditional retry predicate is being removed to simplify the API. This is a breaking change but the feature is unused.

### Rationale

1. **Unused complexity** - No current usage of `while` in the codebase
2. **Simplifies retry logic** - One less branch in the retry operator
3. **Cleaner API** - Reduces cognitive load for users
4. **Error handling belongs elsewhere** - Conditional logic can be handled in the step itself using Effect's error handling

### Current Implementation to Remove

In `/packages/workflow/src/types.ts`:
```typescript
export interface RetryOptions {
  readonly maxAttempts: number;
  readonly delay?: Duration.DurationInput | ((attempt: number) => Duration.DurationInput);
  readonly while?: (error: unknown) => boolean;  // REMOVE THIS
}
```

In `/packages/workflow/src/workflow.ts`:
```typescript
// Remove this logic from the retry function:
const shouldRetry = options.while;
// ...
if (shouldRetry && !shouldRetry(error)) {
  return yield* Effect.fail(error);
}
```

### Files to Modify

| File | Change |
|------|--------|
| `packages/workflow/src/types.ts` | Remove `while` from `RetryOptions` |
| `packages/workflow/src/workflow.ts` | Remove `while` handling in `retry()` |
| `packages/workflow/test/retry.test.ts` | Remove tests for `while` predicate |

### Alternative Pattern

Users who need conditional retry can handle it in their step logic:

```typescript
// Before (with while)
Workflow.retry({
  maxAttempts: 5,
  while: (err) => err instanceof TransientError,
})

// After (without while) - handle in step
const result = yield* Workflow.step("fetch",
  fetchData().pipe(
    Effect.catchAll((err) =>
      err instanceof TransientError
        ? Effect.fail(err)  // Will be retried
        : Effect.die(err)   // Won't be retried, fails workflow
    ),
    Workflow.retry({ maxAttempts: 5 })
  )
);
```

---

## Proposed API

### Enhanced RetryOptions

```typescript
// types.ts
export interface RetryOptions {
  /** Maximum number of retries (not including the initial attempt) */
  readonly maxAttempts: number;

  /** Simple delay - use OR with backoff, not both */
  readonly delay?:
    | Duration.DurationInput
    | ((attempt: number) => Duration.DurationInput);

  /** Backoff strategy - mutually exclusive with delay */
  readonly backoff?: BackoffConfig;

  /** Maximum total time across all retry attempts */
  readonly maxDuration?: Duration.DurationInput;
}
```

### Backoff Configuration Types

```typescript
// backoff.ts
export type BackoffConfig =
  | ExponentialBackoff
  | LinearBackoff
  | ConstantBackoff;

export interface ExponentialBackoff {
  readonly _tag: "Exponential";
  /** Base delay for first retry */
  readonly base: Duration.DurationInput;
  /** Multiplier for each subsequent retry (default: 2) */
  readonly factor?: number;
  /** Maximum delay cap per attempt */
  readonly max?: Duration.DurationInput;
  /** Add jitter to prevent thundering herd */
  readonly jitter?: boolean | JitterConfig;
}

export interface LinearBackoff {
  readonly _tag: "Linear";
  /** Initial delay for first retry */
  readonly initial: Duration.DurationInput;
  /** Amount added for each subsequent retry */
  readonly increment: Duration.DurationInput;
  /** Maximum delay cap per attempt */
  readonly max?: Duration.DurationInput;
  /** Add jitter */
  readonly jitter?: boolean | JitterConfig;
}

export interface ConstantBackoff {
  readonly _tag: "Constant";
  /** Fixed delay between retries */
  readonly duration: Duration.DurationInput;
  /** Add jitter */
  readonly jitter?: boolean | JitterConfig;
}

export interface JitterConfig {
  /** Jitter algorithm */
  readonly type: "full" | "equal" | "decorrelated";
  /** Factor for jitter calculation (default varies by type) */
  readonly factor?: number;
}
```

### Jitter Types Explained

| Type | Algorithm | Use Case |
|------|-----------|----------|
| `full` | `random(0, delay)` | Maximum spread, good for many clients |
| `equal` | `delay/2 + random(0, delay/2)` | Balanced - never zero delay |
| `decorrelated` | `random(base, prevDelay * 3)` | AWS-style, prevents correlation |

---

## Utility Functions

```typescript
// backoff.ts
export const Backoff = {
  /**
   * Exponential backoff: base * factor^attempt
   * @example Backoff.exponential({ base: "1 second", factor: 2, max: "30 seconds" })
   */
  exponential: (config: Omit<ExponentialBackoff, "_tag">): ExponentialBackoff => ({
    _tag: "Exponential",
    ...config,
  }),

  /**
   * Linear backoff: initial + (attempt * increment)
   * @example Backoff.linear({ initial: "1 second", increment: "2 seconds" })
   */
  linear: (config: Omit<LinearBackoff, "_tag">): LinearBackoff => ({
    _tag: "Linear",
    ...config,
  }),

  /**
   * Constant delay between retries
   * @example Backoff.constant("5 seconds", true)
   */
  constant: (
    duration: Duration.DurationInput,
    jitter?: boolean | JitterConfig,
  ): ConstantBackoff => ({
    _tag: "Constant",
    duration,
    jitter,
  }),

  /** Common presets for typical use cases */
  presets: {
    /**
     * Standard exponential: 1s → 2s → 4s → 8s → 16s (max 30s)
     * Good for external API calls
     */
    standard: (): ExponentialBackoff => ({
      _tag: "Exponential",
      base: "1 second",
      factor: 2,
      max: "30 seconds",
      jitter: true,
    }),

    /**
     * Aggressive: 100ms → 200ms → 400ms → 800ms (max 5s)
     * Good for internal services, fast recovery
     */
    aggressive: (): ExponentialBackoff => ({
      _tag: "Exponential",
      base: "100 millis",
      factor: 2,
      max: "5 seconds",
      jitter: true,
    }),

    /**
     * Patient: 5s → 10s → 20s → 40s (max 2min)
     * Good for rate-limited APIs, eventual consistency
     */
    patient: (): ExponentialBackoff => ({
      _tag: "Exponential",
      base: "5 seconds",
      factor: 2,
      max: "2 minutes",
      jitter: true,
    }),

    /**
     * No backoff, constant 1 second with jitter
     * Good for simple polling scenarios
     */
    simple: (): ConstantBackoff => ({
      _tag: "Constant",
      duration: "1 second",
      jitter: true,
    }),
  },
};
```

---

## Usage Examples

### Basic Usage (Unchanged)

```typescript
// Fixed delay - works exactly as before
Workflow.retry({ maxAttempts: 3, delay: "5 seconds" })

// Custom function - works exactly as before
Workflow.retry({
  maxAttempts: 5,
  delay: (attempt) => Duration.seconds(Math.pow(2, attempt))
})
```

### Exponential Backoff

```typescript
// Using utility function
Workflow.retry({
  maxAttempts: 5,
  backoff: Backoff.exponential({
    base: "1 second",
    factor: 2,
    max: "30 seconds",
    jitter: true,
  }),
})

// Using preset
Workflow.retry({
  maxAttempts: 5,
  backoff: Backoff.presets.standard(),
})
```

### Linear Backoff

```typescript
// 1s → 3s → 5s → 7s → 9s
Workflow.retry({
  maxAttempts: 5,
  backoff: Backoff.linear({
    initial: "1 second",
    increment: "2 seconds",
    max: "10 seconds",
  }),
})
```

### With Jitter Configuration

```typescript
// Full jitter (AWS recommended)
Workflow.retry({
  maxAttempts: 5,
  backoff: Backoff.exponential({
    base: "1 second",
    jitter: { type: "full" },
  }),
})

// Equal jitter (never zero delay)
Workflow.retry({
  maxAttempts: 5,
  backoff: Backoff.exponential({
    base: "1 second",
    jitter: { type: "equal" },
  }),
})
```

### With Maximum Total Duration

```typescript
// Stop retrying after 5 minutes total
Workflow.retry({
  maxAttempts: 10,
  backoff: Backoff.exponential({ base: "1 second" }),
  maxDuration: "5 minutes",
})
```

---

## Implementation Plan

### Step 2: Add Backoff Types

Create `/packages/workflow/src/backoff.ts`:

```typescript
import { Duration } from "effect";

// Type definitions
export type BackoffConfig = ExponentialBackoff | LinearBackoff | ConstantBackoff;

export interface ExponentialBackoff { /* ... */ }
export interface LinearBackoff { /* ... */ }
export interface ConstantBackoff { /* ... */ }
export interface JitterConfig { /* ... */ }

// Utility constructors
export const Backoff = { /* ... */ };

// Internal: Calculate delay for attempt
export function calculateDelay(
  config: BackoffConfig,
  attempt: number,
): Duration.Duration {
  const baseDelay = calculateBaseDelay(config, attempt);
  const cappedDelay = applyMax(config, baseDelay);
  const jitteredDelay = applyJitter(config, cappedDelay);
  return jitteredDelay;
}

function calculateBaseDelay(config: BackoffConfig, attempt: number): Duration.Duration {
  switch (config._tag) {
    case "Exponential": {
      const factor = config.factor ?? 2;
      const baseMs = Duration.toMillis(Duration.decode(config.base));
      return Duration.millis(baseMs * Math.pow(factor, attempt));
    }
    case "Linear": {
      const initialMs = Duration.toMillis(Duration.decode(config.initial));
      const incrementMs = Duration.toMillis(Duration.decode(config.increment));
      return Duration.millis(initialMs + attempt * incrementMs);
    }
    case "Constant": {
      return Duration.decode(config.duration);
    }
  }
}

function applyMax(config: BackoffConfig, delay: Duration.Duration): Duration.Duration {
  if ("max" in config && config.max) {
    const maxDuration = Duration.decode(config.max);
    return Duration.min(delay, maxDuration);
  }
  return delay;
}

function applyJitter(config: BackoffConfig, delay: Duration.Duration): Duration.Duration {
  const jitter = config.jitter;
  if (!jitter) return delay;

  const jitterConfig: JitterConfig =
    typeof jitter === "boolean" ? { type: "full" } : jitter;

  const delayMs = Duration.toMillis(delay);

  switch (jitterConfig.type) {
    case "full":
      // random(0, delay)
      return Duration.millis(Math.random() * delayMs);

    case "equal":
      // delay/2 + random(0, delay/2)
      return Duration.millis(delayMs / 2 + Math.random() * (delayMs / 2));

    case "decorrelated":
      // For first attempt, use base delay with jitter
      // For subsequent, use random(base, prevDelay * 3) - simplified here
      const factor = jitterConfig.factor ?? 3;
      return Duration.millis(Math.random() * delayMs * factor);
  }
}
```

### Step 3: Update RetryOptions

Update `/packages/workflow/src/types.ts`:

```typescript
import type { BackoffConfig } from "./backoff.js";

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly delay?:
    | Duration.DurationInput
    | ((attempt: number) => Duration.DurationInput);
  readonly backoff?: BackoffConfig;
  readonly maxDuration?: Duration.DurationInput;
}
```

### Step 4: Update Retry Operator

Update `/packages/workflow/src/workflow.ts`:

```typescript
import { calculateDelay } from "./backoff.js";

export function retry<T, E, R>(options: RetryOptions) {
  return (effect: Effect.Effect<T, E, R>) =>
    Effect.gen(function* () {
      const { maxAttempts, delay, backoff, maxDuration } = options;
      const ctx = yield* ExecutionContext;
      const stepCtx = yield* StepContext;

      // Track start time for maxDuration
      const startTime = maxDuration ? Date.now() : undefined;

      // ... existing logic ...

      // Calculate delay - prefer backoff over delay
      let retryDelay: Duration.Duration;
      if (backoff) {
        retryDelay = calculateDelay(backoff, stepCtx.attempt);
      } else if (typeof delay === "function") {
        retryDelay = Duration.decode(delay(stepCtx.attempt));
      } else if (delay) {
        retryDelay = Duration.decode(delay);
      } else {
        retryDelay = Duration.seconds(1);
      }

      // Check maxDuration before scheduling retry
      if (startTime && maxDuration) {
        const elapsed = Date.now() - startTime;
        const maxMs = Duration.toMillis(Duration.decode(maxDuration));
        if (elapsed + Duration.toMillis(retryDelay) > maxMs) {
          // Would exceed max duration, exhaust retries
          yield* emitRetryExhausted(stepCtx, "max_duration_exceeded");
          return yield* Effect.fail(error);
        }
      }

      // ... continue with existing alarm/pause logic ...
    });
}
```

### Step 5: Update Events (Optional Enhancement)

Update `/packages/core/src/events.ts`:

```typescript
export const InternalRetryScheduledEvent = Schema.Struct({
  type: Schema.Literal("retry.scheduled"),
  stepName: Schema.String,
  attempt: Schema.Number,
  nextAttemptAt: Schema.String,
  delayMs: Schema.Number,
  // New optional fields
  backoffType: Schema.optional(
    Schema.Literal("exponential", "linear", "constant", "custom"),
  ),
  jitterApplied: Schema.optional(Schema.Boolean),
  baseDelayMs: Schema.optional(Schema.Number),
});
```

### Step 6: Export from Package

Update `/packages/workflow/src/index.ts`:

```typescript
export { Backoff, type BackoffConfig, type ExponentialBackoff, type LinearBackoff, type ConstantBackoff, type JitterConfig } from "./backoff.js";
```

### Step 7: Add Tests

Create `/packages/workflow/test/backoff.test.ts`:

```typescript
describe("Backoff", () => {
  describe("calculateDelay", () => {
    it("calculates exponential delay correctly", () => {
      const config = Backoff.exponential({ base: "1 second", factor: 2 });
      expect(Duration.toMillis(calculateDelay(config, 0))).toBe(1000);
      expect(Duration.toMillis(calculateDelay(config, 1))).toBe(2000);
      expect(Duration.toMillis(calculateDelay(config, 2))).toBe(4000);
    });

    it("respects max cap", () => {
      const config = Backoff.exponential({
        base: "1 second",
        factor: 2,
        max: "5 seconds",
      });
      expect(Duration.toMillis(calculateDelay(config, 10))).toBe(5000);
    });

    it("applies jitter", () => {
      const config = Backoff.exponential({ base: "1 second", jitter: true });
      const delays = Array.from({ length: 100 }, () =>
        Duration.toMillis(calculateDelay(config, 0))
      );
      // All delays should be between 0 and 1000
      expect(delays.every((d) => d >= 0 && d <= 1000)).toBe(true);
      // Should have some variance
      const unique = new Set(delays);
      expect(unique.size).toBeGreaterThan(1);
    });
  });

  describe("presets", () => {
    it("standard preset has expected config", () => {
      const preset = Backoff.presets.standard();
      expect(preset._tag).toBe("Exponential");
      expect(Duration.toMillis(Duration.decode(preset.base))).toBe(1000);
      expect(preset.factor).toBe(2);
      expect(Duration.toMillis(Duration.decode(preset.max!))).toBe(30000);
      expect(preset.jitter).toBe(true);
    });
  });
});
```

---

## Delay Calculation Table

### Exponential (base=1s, factor=2, max=30s)

| Attempt | Raw Delay | Capped | With Full Jitter (avg) |
|---------|-----------|--------|------------------------|
| 0 | 1s | 1s | 0.5s |
| 1 | 2s | 2s | 1s |
| 2 | 4s | 4s | 2s |
| 3 | 8s | 8s | 4s |
| 4 | 16s | 16s | 8s |
| 5 | 32s | 30s | 15s |
| 6 | 64s | 30s | 15s |

### Linear (initial=1s, increment=2s, max=10s)

| Attempt | Raw Delay | Capped |
|---------|-----------|--------|
| 0 | 1s | 1s |
| 1 | 3s | 3s |
| 2 | 5s | 5s |
| 3 | 7s | 7s |
| 4 | 9s | 9s |
| 5 | 11s | 10s |

---

## Migration Guide

### Existing Code (No Changes Required)

```typescript
// This continues to work exactly as before
Workflow.retry({ maxAttempts: 3, delay: "5 seconds" })
```

### Upgrading to Backoff

```typescript
// Before: Manual exponential
Workflow.retry({
  maxAttempts: 5,
  delay: (attempt) => Duration.millis(1000 * Math.pow(2, attempt))
})

// After: Using Backoff
Workflow.retry({
  maxAttempts: 5,
  backoff: Backoff.exponential({ base: "1 second" })
})
```

---

## Validation Rules

1. **Mutual exclusion**: `delay` and `backoff` cannot both be specified
2. **Positive values**: `maxAttempts`, base delays, and increments must be positive
3. **Factor range**: Exponential factor must be > 1 (otherwise not exponential)
4. **Max >= base**: Maximum delay should be >= base delay (warning if not)

```typescript
function validateRetryOptions(options: RetryOptions): void {
  if (options.delay && options.backoff) {
    throw new Error("Cannot specify both 'delay' and 'backoff'");
  }
  if (options.maxAttempts < 0) {
    throw new Error("maxAttempts must be non-negative");
  }
  if (options.backoff?._tag === "Exponential") {
    const factor = options.backoff.factor ?? 2;
    if (factor <= 1) {
      throw new Error("Exponential factor must be greater than 1");
    }
  }
}
```

---

## Future Considerations

### Circuit Breaker Pattern

Could add a circuit breaker that stops retrying after too many failures:

```typescript
Workflow.retry({
  maxAttempts: 10,
  backoff: Backoff.presets.standard(),
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeout: "1 minute",
  },
})
```

### Fallback Action

Execute alternative action after retries exhausted:

```typescript
Workflow.retry({
  maxAttempts: 3,
  backoff: Backoff.presets.aggressive(),
  fallback: () => getFromCache(),
})
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/workflow/src/types.ts` | Modify | Remove `while`, add BackoffConfig to RetryOptions |
| `packages/workflow/src/workflow.ts` | Modify | Remove `while` handling, add backoff support |
| `packages/workflow/src/backoff.ts` | Create | Backoff types and utilities |
| `packages/workflow/src/index.ts` | Modify | Export Backoff |
| `packages/core/src/events.ts` | Modify | Add backoff info to events |
| `packages/workflow/test/backoff.test.ts` | Create | Unit tests for backoff |
| `packages/workflow/test/retry.test.ts` | Modify | Remove `while` tests, add backoff integration tests |

---

## Summary

This design provides:

1. **Simplified API** by removing the unused `while` conditional predicate
2. **Exponential backoff** with configurable base, factor, and max
3. **Linear backoff** for predictable delays
4. **Constant backoff** with optional jitter
5. **Jitter support** (full, equal, decorrelated)
6. **Delay caps** per-attempt and total duration
7. **Presets** for common patterns (standard, aggressive, patient)
8. **Full backward compatibility** with existing delay option
9. **Type-safe** discriminated unions
