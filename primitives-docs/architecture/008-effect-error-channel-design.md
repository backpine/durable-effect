# Effect Error Channel Design for Job Definitions

## Problem Statement

Currently, job definitions (debounce, continuous, workerPool) have issues with Effect's typed error channel:

```typescript
// User's code - this SHOULD work
const webhookDebounce = Debounce.make({
  execute: (ctx) =>
    Effect.gen(function* () {
      yield* Effect.fail(new Error("Processing failure"));
    }),
  onError: (error, ctx) => {
    // error is typed as `never` - WRONG!
    // Should be typed as `Error`
    console.log(error.message); // Type error
  },
});
```

### Root Cause

The issue stems from `AnyUnregisteredDefinition` using `never` for the error type:

```typescript
// packages/jobs/src/registry/types.ts
export type AnyUnregisteredDefinition =
  | UnregisteredContinuousDefinition<any, never, any>
  | UnregisteredDebounceDefinition<any, any, never, any>
  | UnregisteredWorkerPoolDefinition<any, never, any>;
```

This was necessary because `JobRetryConfig<E>` has a contravariant callback:

```typescript
interface JobRetryConfig<E> {
  maxAttempts: number;
  delay: DelayConfig;
  shouldRetry?: (error: E) => boolean; // Contravariant in E!
}
```

With contravariance:
- `(error: never) => boolean` is assignable to `(error: Error) => boolean` ✓
- `(error: any) => boolean` is NOT assignable to `(error: Error) => boolean` ✗

Using `any` would break type assignability for definitions with `E = never`.

---

## Proposed Solution

### 1. Separate Error Type from Registration

Create a registration-time type that erases the error type, while preserving it for user-facing APIs.

```typescript
// Internal type for registry storage (error type erased)
export type RegistrableDebounceDefinition<I, S, R> = {
  readonly _tag: "DebounceDefinition";
  readonly eventSchema: Schema.Schema<I, any, never>;
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly flushAfter: Duration.DurationInput;
  readonly maxEvents?: number;
  readonly retry?: JobRetryConfigErased; // Error type erased
  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, unknown, R>;
  onEvent?(ctx: DebounceEventContext<I, S>): Effect.Effect<S, never, R>;
  onError?(error: unknown, ctx: DebounceExecuteContext<S>): Effect.Effect<void, never, R>;
};

// Retry config with erased error type for storage
interface JobRetryConfigErased {
  readonly maxAttempts: number;
  readonly delay: DelayConfig;
  readonly shouldRetry?: (error: unknown) => boolean;
}
```

### 2. Preserve Error Types in User-Facing API

The `Debounce.make()` function maintains full type inference:

```typescript
export const Debounce = {
  make: <I, S = I, E = never, R = never>(
    config: DebounceMakeConfig<I, S, E, R>
  ): UnregisteredDebounceDefinition<I, S, E, R> => {
    // Full type preservation at definition site
    return {
      _tag: "DebounceDefinition",
      eventSchema: config.eventSchema,
      stateSchema: config.stateSchema ?? config.eventSchema,
      flushAfter: config.flushAfter,
      maxEvents: config.maxEvents,
      retry: config.retry,
      execute: config.execute,
      onEvent: config.onEvent ?? defaultOnEvent,
      onError: config.onError,
    };
  },
};
```

### 3. Type-Safe Error Handling Flow

```
execute() fails with E
        │
        ▼
┌─────────────────────┐
│   Retry Logic       │  ← shouldRetry(error: E) determines if retry
│   (if configured)   │
└─────────────────────┘
        │
        ▼ (retries exhausted OR no retry configured)
┌─────────────────────┐
│   onError(E, ctx)   │  ← Receives typed error E
└─────────────────────┘
        │
        ▼
┌─────────────────────┐
│   Cleanup/Purge     │  ← Error channel cleared after onError
└─────────────────────┘
```

---

## Implementation Details

### Step 1: Update Type Definitions

```typescript
// packages/jobs/src/registry/types.ts

/**
 * Unregistered debounce job definition.
 * E is the error type from execute().
 */
export interface UnregisteredDebounceDefinition<
  I = unknown,
  S = unknown,
  E = never,  // Default to never (no errors)
  R = never,
> {
  readonly _tag: "DebounceDefinition";
  readonly eventSchema: Schema.Schema<I, any, never>;
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly flushAfter: Duration.DurationInput;
  readonly maxEvents?: number;
  readonly retry?: JobRetryConfig<E>;

  // execute CAN fail with typed error E
  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, E, R>;

  // onEvent should NOT fail (accumulation is infallible)
  onEvent?(ctx: DebounceEventContext<I, S>): Effect.Effect<S, never, R>;

  // onError receives the typed error E, returns void (error handled)
  onError?(error: E, ctx: DebounceExecuteContext<S>): Effect.Effect<void, never, R>;
}
```

### Step 2: Fix AnyUnregisteredDefinition

Instead of using `never` which breaks type assignment, use a mapped type approach:

```typescript
/**
 * Type for registry storage that accepts any error type.
 * Uses `unknown` for error in execute() and onError().
 */
export type AnyUnregisteredDefinition =
  | UnregisteredContinuousDefinition<any, unknown, any>
  | UnregisteredDebounceDefinition<any, any, unknown, any>
  | UnregisteredWorkerPoolDefinition<any, unknown, any>;
```

But this causes the contravariance issue with `shouldRetry`. Solution:

```typescript
/**
 * Retry config stored in registry (error type widened to unknown).
 */
export interface StoredRetryConfig {
  readonly maxAttempts: number;
  readonly delay: DelayConfig;
  readonly shouldRetry?: (error: unknown) => boolean;
}

/**
 * Type for definitions as stored in registry.
 * Error type is widened to unknown for storage compatibility.
 */
export interface StoredDebounceDefinition<I, S, R> {
  readonly _tag: "DebounceDefinition";
  readonly name: string;
  readonly eventSchema: Schema.Schema<I, any, never>;
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly flushAfter: Duration.DurationInput;
  readonly maxEvents?: number;
  readonly retry?: StoredRetryConfig;
  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, unknown, R>;
  onEvent?(ctx: DebounceEventContext<I, S>): Effect.Effect<S, never, R>;
  onError?(error: unknown, ctx: DebounceExecuteContext<S>): Effect.Effect<void, never, R>;
}
```

### Step 3: Update Factory to Widen Types on Registration

```typescript
// packages/jobs/src/factory.ts

function registerDebounce<I, S, E, R>(
  name: string,
  def: UnregisteredDebounceDefinition<I, S, E, R>
): StoredDebounceDefinition<I, S, R> {
  return {
    ...def,
    name,
    // Types are widened to unknown for storage
    // Runtime behavior preserved - just type-level change
  } as StoredDebounceDefinition<I, S, R>;
}
```

### Step 4: Handler Uses Unknown and Catches All

```typescript
// packages/jobs/src/handlers/debounce/handler.ts

const runExecute = (
  def: StoredDebounceDefinition<any, any, never>,
  // ...
): Effect.Effect<void, ExecutionError> =>
  Effect.gen(function* () {
    // Execute can fail with unknown error
    yield* def.execute(ctx).pipe(
      Effect.catchAll((error: unknown) => {
        // Wrap in ExecutionError or call onError
        if (def.onError) {
          return def.onError(error, ctx);
        }
        return Effect.fail(new ExecutionError({ cause: error }));
      })
    );
  });
```

---

## User-Facing API Examples

### Basic Usage (No Errors)

```typescript
const simpleDebounce = Debounce.make({
  eventSchema: Schema.Struct({ id: Schema.String }),
  flushAfter: "5 seconds",
  execute: (ctx) => Effect.log(`Flushing ${ctx.state.id}`),
  // E inferred as never - execute cannot fail
});
```

### With Typed Errors

```typescript
class WebhookError extends Data.TaggedError("WebhookError")<{
  readonly statusCode: number;
  readonly message: string;
}> {}

const webhookDebounce = Debounce.make({
  eventSchema: Schema.Struct({
    contactId: Schema.String,
    type: Schema.String,
  }),
  flushAfter: "10 seconds",
  retry: {
    maxAttempts: 3,
    delay: "1 second",
    shouldRetry: (error) => error.statusCode >= 500, // Typed as WebhookError!
  },
  execute: (ctx) =>
    Effect.gen(function* () {
      const response = yield* sendWebhook(ctx.state);
      if (!response.ok) {
        yield* Effect.fail(new WebhookError({
          statusCode: response.status,
          message: "Webhook failed",
        }));
      }
    }),
  onError: (error, ctx) =>
    Effect.gen(function* () {
      // error is typed as WebhookError!
      yield* Effect.log(`Webhook failed with ${error.statusCode}: ${error.message}`);
      yield* alertOps(error);
    }),
});
```

### With Multiple Error Types (Union)

```typescript
class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly url: string;
}> {}

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly field: string;
}> {}

type ProcessingError = NetworkError | ValidationError;

const processor = Debounce.make({
  eventSchema: EventSchema,
  flushAfter: "30 seconds",
  execute: (ctx): Effect.Effect<void, ProcessingError> =>
    Effect.gen(function* () {
      // Can fail with either error type
    }),
  onError: (error, ctx) =>
    // error is ProcessingError - can pattern match!
    error._tag === "NetworkError"
      ? Effect.log(`Network error: ${error.url}`)
      : Effect.log(`Validation error: ${error.field}`),
});
```

---

## Error Flow with Retry

```typescript
const withRetry = Debounce.make({
  eventSchema: Schema.Struct({ data: Schema.String }),
  flushAfter: "5 seconds",
  retry: {
    maxAttempts: 3,
    delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
    shouldRetry: (error: ProcessingError) =>
      error._tag === "NetworkError", // Only retry network errors
  },
  execute: (ctx) => processData(ctx.state),
  onError: (error, ctx) =>
    Effect.gen(function* () {
      // Called AFTER retries exhausted (or shouldRetry returns false)
      yield* Effect.log(`All retries failed: ${error._tag}`);
      yield* sendToDeadLetter(ctx.state, error);
    }),
});
```

**Flow:**
1. `execute()` fails with `NetworkError`
2. `shouldRetry(error)` returns `true` → schedule retry
3. Retry 1 fails with `NetworkError` → schedule retry
4. Retry 2 fails with `NetworkError` → schedule retry
5. Retry 3 fails with `NetworkError` → retries exhausted
6. `onError(error, ctx)` called with the final error
7. Cleanup/purge state

---

## Migration Path

### Phase 1: Type Changes (Non-Breaking)

1. Update `AnyUnregisteredDefinition` to use `unknown` instead of `never`
2. Add `StoredDebounceDefinition` type
3. Update handler to use `unknown` error type

### Phase 2: Verify Type Inference

Ensure `Debounce.make()` correctly infers `E` from:
- Explicit return type annotation on `execute`
- `Effect.fail()` calls within `execute`
- `shouldRetry` callback parameter type

### Phase 3: Update Tests

Add tests verifying:
- Error type inference works correctly
- `onError` receives properly typed errors
- `shouldRetry` receives properly typed errors
- Error channel is cleared after `onError`

---

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| Error type in execute | Inferred but lost | Preserved and flows through |
| Error type in onError | `never` | Matches execute's error type |
| Error type in shouldRetry | `never` | Matches execute's error type |
| AnyUnregisteredDefinition | Uses `never` (breaks assignment) | Uses `unknown` (accepts all) |
| Type safety | Broken | Fully typed error channel |

This design enables idiomatic Effect error handling while maintaining compatibility with the registry system and retry logic.
