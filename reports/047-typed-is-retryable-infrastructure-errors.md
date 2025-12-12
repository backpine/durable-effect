# Typed `isRetryable`: Infrastructure Error Considerations

## The Problem

When implementing typed `isRetryable`, we encounter a type mismatch:

```ts
// Line 381: Effect can fail with E or WorkflowTimeoutError
let effect: Effect.Effect<A, E | WorkflowTimeoutError, R> = config.execute;

// Line 482: error is E | WorkflowTimeoutError
if (config.retry.isRetryable && !config.retry.isRetryable(error)) {
//                                                         ^^^^^
// Error: Argument of type 'E | WorkflowTimeoutError' is not assignable
// to parameter of type 'E'
```

The `isRetryable` function is typed as `(error: E) => boolean`, but at runtime it receives `E | WorkflowTimeoutError`.

### Why This Happens

The step implementation adds infrastructure errors:

1. **WorkflowTimeoutError** - Added when `timeout` is configured (line 381-419)
2. **PauseSignal** - Control flow signal (handled separately, line 454-457)
3. **StepScopeError** - Programming error (handled separately, line 459-462)

## Chosen Solution: Include `WorkflowTimeoutError` in Error Type

The simplest and most honest approach: widen `isRetryable` to include `WorkflowTimeoutError`.

```ts
interface RetryConfig<E = unknown> {
  readonly maxAttempts: number;
  readonly isRetryable?: (error: E | WorkflowTimeoutError) => boolean;
}
```

### Rationale

1. **Honest types** - The type accurately reflects what can happen at runtime
2. **User control** - Advanced users can suppress timeout retries the same way as other errors
3. **Consistency** - One mechanism for all retry decisions
4. **Simplicity** - No separate `isTimeoutRetryable` option needed

### Default Behavior

When `isRetryable` is not provided, **all errors are retryable by default**, including `WorkflowTimeoutError`. This is the existing behavior and remains unchanged.

## Implementation

### Type Changes

```ts
export interface RetryConfig<E = unknown> {
  /**
   * Maximum number of retry attempts (not including initial attempt).
   */
  readonly maxAttempts: number;

  /**
   * Delay between retries.
   */
  readonly delay?: DurationInput | BackoffStrategy | ((attempt: number) => number);

  /**
   * Whether to add jitter to delays.
   * Default: true
   */
  readonly jitter?: boolean;

  /**
   * Predicate to determine if an error is retryable.
   * Receives both user errors (E) and WorkflowTimeoutError (if timeout is configured).
   * Default: All errors are retryable.
   */
  readonly isRetryable?: (error: E | WorkflowTimeoutError) => boolean;

  /**
   * Maximum total duration for all retry attempts.
   */
  readonly maxDuration?: DurationInput;
}

export interface StepConfig<A, E, R> {
  readonly name: string;
  readonly execute: Effect.Effect<A, E, R>;
  readonly retry?: RetryConfig<E>;
  readonly timeout?: DurationInput;
}
```

### Code Change

The implementation at line 482 now type-checks correctly:

```ts
// error is E | WorkflowTimeoutError
// isRetryable expects (error: E | WorkflowTimeoutError) => boolean
// ✅ Types match!
if (config.retry.isRetryable && !config.retry.isRetryable(error)) {
  // Not retryable
}
```

## Usage Examples

### Basic: Let TypeScript Infer

```ts
class PaymentError extends Error {
  readonly _tag = "PaymentError";
  constructor(readonly code: "FRAUD" | "DECLINED") {
    super(`Payment: ${code}`);
  }
}

const payment = yield* Workflow.step({
  name: "Process payment",
  execute: processPayment(order), // Effect<Receipt, PaymentError, never>
  timeout: "30 seconds",
  retry: {
    maxAttempts: 3,
    isRetryable: (error) => {
      // error: PaymentError | WorkflowTimeoutError
      if (error instanceof WorkflowTimeoutError) {
        return true; // Retry timeouts
      }
      return error.code === "FRAUD";
    },
  },
});
```

### Using Discriminated Unions (Recommended for Durability)

```ts
class PaymentError extends Error {
  readonly _tag = "PaymentError";
  constructor(readonly code: "FRAUD" | "DECLINED") {
    super(`Payment: ${code}`);
  }
}

const payment = yield* Workflow.step({
  name: "Process payment",
  execute: processPayment(order),
  timeout: "30 seconds",
  retry: {
    maxAttempts: 3,
    isRetryable: (error) => {
      // Use _tag for serialization safety
      if (error._tag === "WorkflowTimeoutError") {
        return true;
      }
      if (error._tag === "PaymentError") {
        return error.code === "FRAUD";
      }
      return false;
    },
  },
});
```

### Suppress Timeout Retries

```ts
retry: {
  maxAttempts: 3,
  isRetryable: (error) => {
    // Don't retry timeouts - fail fast
    if (error instanceof WorkflowTimeoutError) {
      return false;
    }
    // Retry all user errors
    return true;
  },
}
```

### No Timeout Configured

When `timeout` is not set, `WorkflowTimeoutError` can never occur at runtime:

```ts
const result = yield* Workflow.step({
  name: "Simple step",
  execute: doWork(), // Effect<string, MyError, never>
  // No timeout!
  retry: {
    maxAttempts: 3,
    isRetryable: (error) => {
      // error: MyError | WorkflowTimeoutError
      // WorkflowTimeoutError is in the type but can never happen
      // Users can ignore it or handle it defensively
      return error._tag === "MyError" && error.retryable;
    },
  },
});
```

**Note:** TypeScript will still include `WorkflowTimeoutError` in the union even when timeout isn't configured. This is a minor inconvenience but keeps the API simple. Users can:
1. Ignore it (it will never be called with `WorkflowTimeoutError`)
2. Handle it defensively (recommended)

## Helper Export (Optional)

For ergonomic handling, export `WorkflowTimeoutError` and a type guard:

```ts
// Already exported from errors.ts
export { WorkflowTimeoutError } from "./errors";

// Optional helper
export function isWorkflowTimeoutError(error: unknown): error is WorkflowTimeoutError {
  return error instanceof WorkflowTimeoutError;
}
```

## Summary

| Aspect | Details |
|--------|---------|
| **Type Change** | `isRetryable?: (error: E \| WorkflowTimeoutError) => boolean` |
| **Default Behavior** | All errors retryable (including timeout) |
| **Breaking Change** | No - existing code continues to work |
| **User Control** | Full control over all error types |
| **Implementation** | Types now match runtime behavior |

### Minimal Diff

```diff
-export interface RetryConfig {
+export interface RetryConfig<E = unknown> {
   readonly maxAttempts: number;
   readonly delay?: DurationInput | BackoffStrategy | ((attempt: number) => number);
   readonly jitter?: boolean;
-  readonly isRetryable?: (error: unknown) => boolean;
+  readonly isRetryable?: (error: E | WorkflowTimeoutError) => boolean;
   readonly maxDuration?: DurationInput;
 }

 export interface StepConfig<A, E, R> {
   readonly name: string;
   readonly execute: Effect.Effect<A, E, R>;
-  readonly retry?: RetryConfig;
+  readonly retry?: RetryConfig<E>;
   readonly timeout?: DurationInput;
 }
```

This approach:
- Fixes the type error at line 482
- Gives users type-safe access to error properties
- Maintains full control over retry behavior
- Requires no runtime changes
