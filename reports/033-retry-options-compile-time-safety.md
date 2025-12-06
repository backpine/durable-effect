# Retry Options Compile-Time Safety

## Problem

Users can currently specify both `delay` and `backoff` in `RetryOptions`, resulting in a runtime error:

```
Error: RetryOptions: Cannot specify both 'delay' and 'backoff'. Use one or the other.
```

This error only surfaces after deployment, which is a poor developer experience. TypeScript should catch this at compile time.

## Current API

```typescript
export interface RetryOptions {
  readonly maxAttempts: number;
  readonly delay?: Duration.DurationInput | ((attempt: number) => Duration.DurationInput);
  readonly backoff?: BackoffConfig;
  readonly maxDuration?: Duration.DurationInput;
}
```

The problem: both `delay` and `backoff` are optional, allowing invalid combinations.

---

## Solution: Unified `delay` Field

Consolidate `delay` and `backoff` into a single field that accepts all delay strategies:

```typescript
export interface RetryOptions {
  readonly maxAttempts: number;

  /**
   * Delay strategy between retries.
   *
   * Accepts:
   * - Duration: Fixed delay (e.g., "5 seconds")
   * - Function: Custom delay per attempt (e.g., (attempt) => `${2 ** attempt} seconds`)
   * - BackoffConfig: Structured backoff (e.g., Backoff.exponential({ base: "1 second" }))
   */
  readonly delay?:
    | Duration.DurationInput
    | ((attempt: number) => Duration.DurationInput)
    | BackoffConfig;

  readonly maxDuration?: Duration.DurationInput;
}
```

### Why This Works

1. **Single field** - Impossible to specify conflicting options
2. **Type-safe** - TypeScript enforces the union at compile time
3. **Backwards compatible** - Existing `delay` usage continues to work
4. **Clean API** - Natural extension of the existing `delay` concept

### Detection Logic

Differentiate between the three types at runtime:

```typescript
function isBackoffConfig(value: unknown): value is BackoffConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    ["Exponential", "Linear", "Constant"].includes((value as any)._tag)
  );
}

// In retry():
let delayDuration: Duration.Duration;

if (delay === undefined) {
  delayDuration = Duration.seconds(1); // Default
} else if (typeof delay === "function") {
  delayDuration = Duration.decode(delay(stepCtx.attempt));
} else if (isBackoffConfig(delay)) {
  delayDuration = calculateDelay(delay, stepCtx.attempt);
} else {
  delayDuration = Duration.decode(delay);
}
```

---

## Migration

### Before (Invalid - Runtime Error)

```typescript
Workflow.retry({
  maxAttempts: 3,
  delay: "5 seconds",
  backoff: Backoff.exponential({ base: "1 second" }) // ❌ Runtime error
})
```

### After (Type Error at Compile Time)

```typescript
// ❌ TypeScript error: 'backoff' does not exist in type 'RetryOptions'
Workflow.retry({
  maxAttempts: 3,
  delay: "5 seconds",
  backoff: Backoff.exponential({ base: "1 second" })
})
```

### Updated Usage

```typescript
// Fixed delay (unchanged)
Workflow.retry({ maxAttempts: 3, delay: "5 seconds" })

// Custom function (unchanged)
Workflow.retry({
  maxAttempts: 3,
  delay: (attempt) => Duration.millis(1000 * Math.pow(2, attempt))
})

// Exponential backoff (was: backoff, now: delay)
Workflow.retry({
  maxAttempts: 3,
  delay: Backoff.exponential({ base: "1 second" })
})

// Preset (was: backoff, now: delay)
Workflow.retry({
  maxAttempts: 5,
  delay: Backoff.presets.standard()
})

// With maxDuration
Workflow.retry({
  maxAttempts: 10,
  delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
  maxDuration: "5 minutes"
})
```

---

## Implementation Plan

### Step 1: Update `RetryOptions` Type

**File:** `packages/workflow/src/types.ts`

```typescript
export interface RetryOptions {
  /** Maximum number of retries (not including the initial attempt) */
  readonly maxAttempts: number;

  /**
   * Delay strategy between retries. Defaults to 1 second if not specified.
   *
   * Accepts:
   * - `Duration.DurationInput`: Fixed delay (e.g., "5 seconds", Duration.minutes(1))
   * - `(attempt: number) => Duration.DurationInput`: Custom delay function
   * - `BackoffConfig`: Structured backoff via Backoff.exponential/linear/constant
   *
   * @example
   * ```typescript
   * // Fixed delay
   * delay: "5 seconds"
   *
   * // Custom function
   * delay: (attempt) => Duration.seconds(Math.pow(2, attempt))
   *
   * // Exponential backoff
   * delay: Backoff.exponential({ base: "1 second", max: "30 seconds" })
   *
   * // Preset
   * delay: Backoff.presets.standard()
   * ```
   */
  readonly delay?:
    | Duration.DurationInput
    | ((attempt: number) => Duration.DurationInput)
    | BackoffConfig;

  /**
   * Maximum total time across all retry attempts.
   * If the next retry would exceed this duration, retries are exhausted early.
   */
  readonly maxDuration?: Duration.DurationInput;
}
```

### Step 2: Add Type Guard to Backoff Module

**File:** `packages/workflow/src/backoff.ts`

```typescript
/**
 * Type guard to check if a value is a BackoffConfig.
 */
export function isBackoffConfig(value: unknown): value is BackoffConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof (value as Record<string, unknown>)._tag === "string" &&
    ["Exponential", "Linear", "Constant"].includes(
      (value as Record<string, unknown>)._tag as string
    )
  );
}
```

### Step 3: Update `retry()` Implementation

**File:** `packages/workflow/src/workflow.ts`

```typescript
import { calculateDelay, isBackoffConfig } from "@/backoff";

export function retry<T, E, R>(options: RetryOptions) {
  const { maxAttempts, delay, maxDuration } = options;

  // Remove runtime validation - no longer needed!
  // Was: if (delay !== undefined && backoff !== undefined) { throw ... }

  return (effect) =>
    Effect.gen(function* () {
      // ... existing context setup ...

      // Calculate delay for next attempt
      let delayDuration: Duration.Duration;

      if (delay === undefined) {
        delayDuration = Duration.seconds(1);
      } else if (typeof delay === "function") {
        delayDuration = Duration.decode(delay(stepCtx.attempt));
      } else if (isBackoffConfig(delay)) {
        delayDuration = calculateDelay(delay, stepCtx.attempt);
      } else {
        delayDuration = Duration.decode(delay);
      }

      // ... rest of implementation unchanged ...
    });
}
```

### Step 4: Update JSDoc Examples

**File:** `packages/workflow/src/workflow.ts`

Update the `retry()` function's JSDoc:

```typescript
/**
 * Durable retry operator.
 * Persists retry state across workflow restarts.
 *
 * @example
 * ```typescript
 * // Fixed delay
 * effect.pipe(Workflow.retry({ maxAttempts: 3, delay: '5 seconds' }))
 *
 * // Custom backoff function
 * effect.pipe(Workflow.retry({
 *   maxAttempts: 5,
 *   delay: (attempt) => Duration.millis(1000 * Math.pow(2, attempt))
 * }))
 *
 * // Exponential backoff with preset
 * effect.pipe(Workflow.retry({
 *   maxAttempts: 5,
 *   delay: Backoff.presets.standard()
 * }))
 *
 * // Custom exponential with jitter
 * effect.pipe(Workflow.retry({
 *   maxAttempts: 5,
 *   delay: Backoff.exponential({
 *     base: '1 second',
 *     factor: 2,
 *     max: '30 seconds',
 *     jitter: true
 *   })
 * }))
 *
 * // With max total duration
 * effect.pipe(Workflow.retry({
 *   maxAttempts: 10,
 *   delay: Backoff.exponential({ base: '1 second' }),
 *   maxDuration: '5 minutes'
 * }))
 * ```
 */
```

### Step 5: Update Exports

**File:** `packages/workflow/src/index.ts`

```typescript
export {
  Backoff,
  calculateDelay,
  isBackoffConfig,  // Add export
  type BackoffConfig,
  type ExponentialBackoff,
  type LinearBackoff,
  type ConstantBackoff,
  type JitterConfig,
} from "@/backoff";
```

### Step 6: Update Tests

- Update all tests using `backoff:` to use `delay:` instead
- Remove tests for "delay and backoff both specified" runtime error
- Add type-level test to verify compile error (optional, via `// @ts-expect-error`)

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/workflow/src/types.ts` | Remove `backoff`, expand `delay` type |
| `packages/workflow/src/backoff.ts` | Add `isBackoffConfig()` type guard |
| `packages/workflow/src/workflow.ts` | Update delay logic, remove runtime check |
| `packages/workflow/src/index.ts` | Export `isBackoffConfig` |
| `packages/workflow/test/retry.test.ts` | Update tests to use `delay:` |
| `packages/workflow/test/workflow/retry-lifecycle.test.ts` | Update tests |
| `packages/workflow/test/backoff.test.ts` | Add `isBackoffConfig` tests |

---

## Benefits

1. **Compile-time safety** - Invalid configs caught before deployment
2. **Simpler API** - One field instead of two
3. **Backwards compatible** - Existing `delay` usage unchanged
4. **Self-documenting** - Union type makes options clear
5. **No runtime overhead** - Type guard is simple and fast

---

## Summary

By consolidating `delay` and `backoff` into a single polymorphic `delay` field, we eliminate the possibility of conflicting options at the type level. This shifts validation from runtime to compile time, catching errors before deployment rather than after.
