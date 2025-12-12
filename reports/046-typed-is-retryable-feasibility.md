# Typed `isRetryable` Feasibility Report

## Problem Statement

Currently, the `isRetryable` function in the retry configuration receives `unknown`:

```ts
readonly isRetryable?: (error: unknown) => boolean;
```

Since `execute` is an Effect with a typed error channel (`Effect<A, E, R>`), we should be able to infer the error type `E` and pass it to `isRetryable`:

```ts
readonly isRetryable?: (error: E) => boolean;
```

This would provide compile-time type safety when handling specific error types.

## Exploration: Standalone TypeScript + Effect Examples

### Approach 1: Simple Generic Propagation

The most straightforward approach - make `RetryConfig` generic over the error type.

```ts
import { Effect } from "effect";

// ─────────────────────────────────────────────────────────────────────────────
// Approach 1: Generic RetryConfig
// ─────────────────────────────────────────────────────────────────────────────

interface RetryConfig<E> {
  readonly maxAttempts: number;
  readonly isRetryable?: (error: E) => boolean;
}

interface StepConfig<A, E, R> {
  readonly name: string;
  readonly execute: Effect.Effect<A, E, R>;
  readonly retry?: RetryConfig<E>;
}

function step<A, E, R>(config: StepConfig<A, E, R>): Effect.Effect<A, E, R> {
  // Implementation would use config.retry?.isRetryable with type E
  return config.execute;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage Example
// ─────────────────────────────────────────────────────────────────────────────

class PaymentError extends Error {
  readonly _tag = "PaymentError";
  constructor(readonly code: "FRAUD" | "DECLINED" | "NETWORK") {
    super(`Payment failed: ${code}`);
  }
}

class ValidationError extends Error {
  readonly _tag = "ValidationError";
}

declare function processPayment(
  orderId: string
): Effect.Effect<{ txId: string }, PaymentError | ValidationError, never>;

// ✅ This works! Error is inferred as PaymentError | ValidationError
const result = step({
  name: "Process payment",
  execute: processPayment("order-123"),
  retry: {
    maxAttempts: 3,
    isRetryable: (error) => {
      // TypeScript knows: error is PaymentError | ValidationError
      if (error instanceof PaymentError) {
        return error.code === "FRAUD"; // ✅ Type-safe access to .code
      }
      return false;
    },
  },
});
```

**Verdict**: ✅ Works perfectly. TypeScript infers `E` from the `execute` Effect.

### Approach 2: Handling Union Error Types

When the effect can fail with multiple error types, the union is correctly inferred.

```ts
import { Effect } from "effect";

// ─────────────────────────────────────────────────────────────────────────────
// Union Error Types
// ─────────────────────────────────────────────────────────────────────────────

class NetworkError extends Error {
  readonly _tag = "NetworkError";
  readonly retryable = true;
}

class AuthError extends Error {
  readonly _tag = "AuthError";
  readonly retryable = false;
}

class RateLimitError extends Error {
  readonly _tag = "RateLimitError";
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super(`Rate limited, retry after ${retryAfter}ms`);
    this.retryAfter = retryAfter;
  }
}

type ApiError = NetworkError | AuthError | RateLimitError;

declare function callApi(): Effect.Effect<string, ApiError, never>;

interface RetryConfig<E> {
  readonly maxAttempts: number;
  readonly isRetryable?: (error: E) => boolean;
}

interface StepConfig<A, E, R> {
  readonly name: string;
  readonly execute: Effect.Effect<A, E, R>;
  readonly retry?: RetryConfig<E>;
}

function step<A, E, R>(config: StepConfig<A, E, R>): Effect.Effect<A, E, R> {
  return config.execute;
}

// ✅ TypeScript correctly infers E as ApiError (union of all three)
const apiCall = step({
  name: "Call API",
  execute: callApi(),
  retry: {
    maxAttempts: 5,
    isRetryable: (error) => {
      // error: NetworkError | AuthError | RateLimitError
      switch (error._tag) {
        case "NetworkError":
          return true; // Always retry network errors
        case "RateLimitError":
          return error.retryAfter < 60000; // ✅ Type-safe access
        case "AuthError":
          return false; // Never retry auth errors
      }
    },
  },
});
```

**Verdict**: ✅ Union types work correctly with discriminated unions.

### Approach 3: The `never` Error Case

What happens when the effect cannot fail (`Effect<A, never, R>`)?

```ts
import { Effect } from "effect";

interface RetryConfig<E> {
  readonly maxAttempts: number;
  readonly isRetryable?: (error: E) => boolean;
}

interface StepConfig<A, E, R> {
  readonly name: string;
  readonly execute: Effect.Effect<A, E, R>;
  readonly retry?: RetryConfig<E>;
}

function step<A, E, R>(config: StepConfig<A, E, R>): Effect.Effect<A, E, R> {
  return config.execute;
}

// Effect that never fails
const infallible: Effect.Effect<string, never, never> = Effect.succeed("ok");

// ✅ This still compiles - isRetryable receives `never` (impossible to call)
const result = step({
  name: "Infallible step",
  execute: infallible,
  retry: {
    maxAttempts: 3,
    isRetryable: (error) => {
      // error: never - this function can never be called
      return false;
    },
  },
});

// Note: TypeScript allows this because a function (never) => boolean
// is valid - it just can never be called. This is actually correct behavior!
```

**Verdict**: ✅ Works correctly. The `never` type is sound - the function exists but can never be invoked.

### Approach 4: Workflow Context - Adding Infrastructure Errors

In a real workflow, the step function adds its own errors (storage errors, cancellation, etc.). How do we handle this?

```ts
import { Effect } from "effect";

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure Errors (added by the step wrapper)
// ─────────────────────────────────────────────────────────────────────────────

class StorageError extends Error {
  readonly _tag = "StorageError";
}

class StepCancelledError extends Error {
  readonly _tag = "StepCancelledError";
}

class RetryExhaustedError extends Error {
  readonly _tag = "RetryExhaustedError";
}

type InfrastructureError = StorageError | StepCancelledError | RetryExhaustedError;

// ─────────────────────────────────────────────────────────────────────────────
// User Errors
// ─────────────────────────────────────────────────────────────────────────────

class PaymentError extends Error {
  readonly _tag = "PaymentError";
  constructor(readonly code: "FRAUD" | "DECLINED") {
    super(`Payment: ${code}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Key Insight: isRetryable only sees USER errors (E), not infrastructure errors
// ─────────────────────────────────────────────────────────────────────────────

interface RetryConfig<E> {
  readonly maxAttempts: number;
  // isRetryable receives E, the user's error type
  readonly isRetryable?: (error: E) => boolean;
}

interface StepConfig<A, E, R> {
  readonly name: string;
  readonly execute: Effect.Effect<A, E, R>;
  readonly retry?: RetryConfig<E>;
}

// The step function's output error is E | InfrastructureError
// But isRetryable only operates on E - infrastructure errors are handled separately
function step<A, E, R>(
  config: StepConfig<A, E, R>
): Effect.Effect<A, E | InfrastructureError, R> {
  return Effect.gen(function* () {
    const result = yield* config.execute.pipe(
      Effect.catchAll((error) => {
        // isRetryable only receives E (user errors)
        if (config.retry?.isRetryable && !config.retry.isRetryable(error)) {
          return Effect.fail(error);
        }
        // ... retry logic
        return Effect.fail(error);
      })
    );
    return result;
  });
}

declare function processPayment(): Effect.Effect<string, PaymentError, never>;

// ✅ isRetryable correctly receives PaymentError only
const payment = step({
  name: "Process payment",
  execute: processPayment(),
  retry: {
    maxAttempts: 3,
    isRetryable: (error) => {
      // error: PaymentError (not PaymentError | InfrastructureError)
      return error.code === "FRAUD"; // ✅ Type-safe!
    },
  },
});
```

**Verdict**: ✅ This is the correct design. `isRetryable` only sees user errors `E`, while the step function adds infrastructure errors to the output type.

### Approach 5: Optional Retry Config with Constraints

Making retry optional while maintaining type safety:

```ts
import { Effect } from "effect";

interface RetryConfig<E> {
  readonly maxAttempts: number;
  readonly isRetryable?: (error: E) => boolean;
}

// Option A: retry is directly generic
interface StepConfigA<A, E, R> {
  readonly name: string;
  readonly execute: Effect.Effect<A, E, R>;
  readonly retry?: RetryConfig<E>;
}

// This works - E is inferred from execute, retry.isRetryable gets it
function stepA<A, E, R>(config: StepConfigA<A, E, R>): Effect.Effect<A, E, R> {
  return config.execute;
}

class MyError extends Error {
  readonly code: number = 500;
}

declare function doWork(): Effect.Effect<string, MyError, never>;

// ✅ Works
stepA({
  name: "test",
  execute: doWork(),
  retry: {
    maxAttempts: 3,
    isRetryable: (e) => e.code === 500, // ✅ e is MyError
  },
});

// ✅ Also works without retry
stepA({
  name: "test",
  execute: doWork(),
});
```

**Verdict**: ✅ Optional retry with generic `E` works perfectly.

## Integration with Workflow Package

Looking at the current implementation in `packages/workflow/src/primitives/step.ts`:

### Current Implementation

```ts
export interface RetryConfig {
  readonly maxAttempts: number;
  readonly delay?: DurationInput | BackoffStrategy | ((attempt: number) => number);
  readonly jitter?: boolean;
  readonly isRetryable?: (error: unknown) => boolean;  // ← Current: unknown
  readonly maxDuration?: DurationInput;
}

export interface StepConfig<A, E, R> {
  readonly name: string;
  readonly execute: Effect.Effect<A, E, R>;
  readonly retry?: RetryConfig;  // ← Not using E
}
```

### Proposed Implementation

```ts
export interface RetryConfig<E = unknown> {
  readonly maxAttempts: number;
  readonly delay?: DurationInput | BackoffStrategy | ((attempt: number) => number);
  readonly jitter?: boolean;
  readonly isRetryable?: (error: E) => boolean;  // ← Now typed!
  readonly maxDuration?: DurationInput;
}

export interface StepConfig<A, E, R> {
  readonly name: string;
  readonly execute: Effect.Effect<A, E, R>;
  readonly retry?: RetryConfig<E>;  // ← Uses E from execute
}
```

### Implementation Changes Required

The actual runtime code doesn't need significant changes. The key change is in line 476:

```ts
// Current (line 476):
if (config.retry.isRetryable && !config.retry.isRetryable(error)) {

// Still works because at runtime, error is the actual value
// TypeScript just provides better types at compile time
```

## Backward Compatibility

### Default Parameter Approach

Using `E = unknown` as a default type parameter maintains backward compatibility:

```ts
interface RetryConfig<E = unknown> {
  readonly isRetryable?: (error: E) => boolean;
}
```

This means:
- Existing code with `RetryConfig` (no type param) continues to work
- New code can use `RetryConfig<PaymentError>` for type safety
- When used within `StepConfig<A, E, R>`, `E` is automatically inferred

### Migration Path

No breaking changes. Users get improved type inference automatically:

```ts
// Before: worked, but error was unknown
retry: {
  maxAttempts: 3,
  isRetryable: (error) => {
    if (error instanceof PaymentError) {
      return error.code === "FRAUD";
    }
    return false;
  },
}

// After: same code, but error is now PaymentError
// TypeScript narrows the type automatically
retry: {
  maxAttempts: 3,
  isRetryable: (error) => {
    // No need for instanceof check if there's only one error type!
    return error.code === "FRAUD";  // ← error is already PaymentError
  },
}
```

## Edge Cases and Considerations

### 1. Error Type Widening

If users explicitly type their effect with a wider error type, that will flow through:

```ts
// If user writes this:
const effect: Effect.Effect<string, Error, never> = processPayment();

step({
  execute: effect,
  retry: {
    isRetryable: (error) => {
      // error is now just Error, not PaymentError
      // User loses type information - but this is expected behavior
    },
  },
});
```

**Mitigation**: Document that users should let TypeScript infer types rather than explicitly widening.

### 2. Defects vs Errors

Effect distinguishes between:
- **Errors** (typed, in the `E` channel) - what `isRetryable` handles
- **Defects** (untyped, cause crashes) - should not be retried

Current implementation already handles this correctly - `isRetryable` only sees errors that were in the `E` channel.

### 3. Serialization Concerns

When errors are serialized/deserialized for durability, class type information may be lost:

```ts
// After deserialization, instanceof checks may not work
isRetryable: (error) => {
  // error instanceof PaymentError might be false after replay!
  // Need to use _tag or other serializable discriminants
}
```

**Recommendation**: Document that users should use `_tag` discriminated unions rather than `instanceof` for durable workflows.

## Feasibility Assessment

| Aspect | Assessment |
|--------|------------|
| **Type Safety** | ✅ Fully achievable |
| **Backward Compatibility** | ✅ No breaking changes |
| **Implementation Complexity** | ✅ Minimal - mostly type changes |
| **Runtime Changes** | ✅ None required |
| **Edge Cases** | ⚠️ Some documentation needed |

## Recommendation

**Proceed with implementation.** This is a straightforward improvement that:

1. Provides better developer experience with type-safe error handling
2. Requires no runtime changes
3. Is fully backward compatible
4. Follows Effect's philosophy of leveraging the type system

### Implementation Steps

1. Add generic parameter to `RetryConfig<E = unknown>`
2. Update `StepConfig` to pass `E` to `RetryConfig`
3. Update any tests that explicitly type `RetryConfig`
4. Add documentation about:
   - Using `_tag` discriminants for serialization safety
   - Avoiding explicit type widening of effects

### Minimal Diff

```diff
-export interface RetryConfig {
+export interface RetryConfig<E = unknown> {
   readonly maxAttempts: number;
   readonly delay?: DurationInput | BackoffStrategy | ((attempt: number) => number);
   readonly jitter?: boolean;
-  readonly isRetryable?: (error: unknown) => boolean;
+  readonly isRetryable?: (error: E) => boolean;
   readonly maxDuration?: DurationInput;
 }

 export interface StepConfig<A, E, R> {
   readonly name: string;
   readonly execute: Effect.Effect<A, E, R>;
-  readonly retry?: RetryConfig;
+  readonly retry?: RetryConfig<E>;
 }
```

That's it - a 4-line change for full type safety!
