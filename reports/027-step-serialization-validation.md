# Report 027: Step Result Serialization Validation

## Problem

When a `Workflow.step` effect returns a non-serializable value (e.g., Drizzle query result), the framework throws an opaque `UnknownException` without:
1. A clear error message explaining the issue
2. Emitting a `step.failed` event
3. Any compile-time warning

## Goal

1. **Runtime**: Catch serialization errors, provide explicit error messages, and emit `step.failed` event
2. **Compile-time**: Warn users when they might be returning non-serializable values (best effort)

## Technical Background

### Durable Object Storage Serialization

Cloudflare's `storage.put()` uses the [structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm). Non-cloneable values throw `DataCloneError`.

**Not supported:**
- Functions
- Symbols
- DOM nodes
- Proxy objects (common in ORMs!)
- WeakMap / WeakSet
- Class instances with private fields
- Circular references
- Getters/setters (only values are cloned)

### Current Flow (Workflow.ts:140-155)

```typescript
if (result._tag === "Right") {
  // Step effect succeeded
  yield* stepCtx.setResult(result.right);  // ← FAILS HERE (DataCloneError)
  yield* markStepCompleted(name, storage);
  yield* emitEvent({ type: "step.completed", ... });
  return result.right;
}
```

When `setResult` fails, the error propagates as `UnknownException` without emitting `step.failed`.

## Implementation Plan

### 1. New Error Type: `StepSerializationError`

**File: `packages/workflow/src/errors.ts`**

```typescript
/**
 * Step result could not be serialized to Durable Object storage.
 * This happens when the step returns a non-serializable value like
 * functions, Symbols, Proxy objects, or circular references.
 */
export class StepSerializationError extends Data.TaggedError("StepSerializationError")<{
  readonly stepName: string;
  readonly message: string;
  readonly cause: unknown;
  /** Hint about what type of value caused the issue */
  readonly valueType?: string;
}> {
  constructor(props: {
    stepName: string;
    message: string;
    cause: unknown;
    valueType?: string;
  }) {
    super(props);
  }

  /**
   * Create a user-friendly error from a DataCloneError.
   */
  static fromDataCloneError(
    stepName: string,
    cause: unknown,
    value: unknown,
  ): StepSerializationError {
    const valueType = detectValueType(value);
    const hint = getSerializationHint(valueType);

    return new StepSerializationError({
      stepName,
      message:
        `Step "${stepName}" returned a value that cannot be serialized to storage. ` +
        `${hint} ` +
        `Use Effect.asVoid, Effect.as(), or Effect.map() to return a serializable value.`,
      cause,
      valueType,
    });
  }
}

/**
 * Detect the type of value for better error messages.
 */
function detectValueType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return "symbol";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "Date";
  if (value instanceof Map) return "Map";
  if (value instanceof Set) return "Set";
  if (value instanceof WeakMap) return "WeakMap";
  if (value instanceof WeakSet) return "WeakSet";
  if (value instanceof Promise) return "Promise";
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto && proto.constructor && proto.constructor.name !== "Object") {
      return proto.constructor.name; // e.g., "NeonQueryResult", "DrizzleResult"
    }
    return "object";
  }
  return typeof value;
}

/**
 * Get a helpful hint based on the value type.
 */
function getSerializationHint(valueType: string): string {
  const hints: Record<string, string> = {
    function: "Functions cannot be serialized.",
    symbol: "Symbols cannot be serialized.",
    WeakMap: "WeakMap cannot be serialized.",
    WeakSet: "WeakSet cannot be serialized.",
    Promise: "Promises cannot be serialized. Did you forget to await?",
  };

  // Common ORM result types
  if (valueType.includes("Query") || valueType.includes("Result") || valueType.includes("Drizzle")) {
    return `ORM query results (${valueType}) often contain non-serializable properties.`;
  }

  return hints[valueType] || `Value of type "${valueType}" may contain non-serializable properties.`;
}
```

### 2. Update step-context.ts: Safe Serialization

**File: `packages/workflow/src/services/step-context.ts`**

Replace `setResult` with serialization-safe version:

```typescript
import { StepSerializationError } from "@/errors";

/**
 * Safely serialize a value for storage.
 * Uses structuredClone to detect non-serializable values before storage.put().
 */
function safeSerialize<T>(
  stepName: string,
  value: T,
): Effect.Effect<T, StepSerializationError> {
  return Effect.try({
    try: () => {
      // Pre-validate with structuredClone (same algorithm as storage.put)
      structuredClone(value);
      return value;
    },
    catch: (error) => {
      // DataCloneError or similar
      return StepSerializationError.fromDataCloneError(stepName, error, value);
    },
  });
}

// In createStepContext:
setResult: <T>(value: T) =>
  Effect.gen(function* () {
    // First, validate the value is serializable
    yield* safeSerialize(stepName, value);

    // Then store it
    yield* Effect.tryPromise({
      try: () => storage.put(stepKey(stepName, "result"), value),
      catch: (error) => {
        // Fallback if storage.put fails for other reasons
        if (error instanceof DOMException && error.name === "DataCloneError") {
          return StepSerializationError.fromDataCloneError(stepName, error, value);
        }
        return new UnknownException(error);
      },
    });
  }),
```

### 3. Update Workflow.step: Emit step.failed on Serialization Error

**File: `packages/workflow/src/Workflow.ts`**

Modify the success path to catch serialization errors:

```typescript
if (result._tag === "Right") {
  // Success - try to cache result
  const cacheResult = yield* stepCtx.setResult(result.right).pipe(Effect.either);

  if (cacheResult._tag === "Left") {
    const error = cacheResult.left;

    // Emit step.failed for serialization errors
    yield* emitEvent({
      ...createBaseEvent(workflowCtx.workflowId, workflowCtx.workflowName),
      type: "step.failed",
      stepName: name,
      attempt,
      error: {
        message: error instanceof StepSerializationError
          ? error.message
          : "Failed to cache step result",
        stack: error instanceof Error ? error.stack : undefined,
      },
      willRetry: false,
    });

    // Wrap in StepError for consistent error handling
    return yield* Effect.fail(
      new StepError({
        stepName: name,
        cause: error,
        attempt,
      }),
    );
  }

  yield* markStepCompleted(name, storage);

  // Emit step completed event
  yield* emitEvent({
    ...createBaseEvent(workflowCtx.workflowId, workflowCtx.workflowName),
    type: "step.completed",
    stepName: name,
    attempt,
    durationMs: Date.now() - startTime,
    cached: false,
  });

  return result.right;
}
```

### 4. Compile-Time Warning: Branded Type (Optional Enhancement)

Create a branded type that hints at serializability. This won't catch everything but provides documentation and some type safety.

**File: `packages/workflow/src/types.ts`**

```typescript
/**
 * Branded type indicating a value should be JSON-serializable.
 * This is a compile-time hint - actual validation happens at runtime.
 *
 * @example
 * ```typescript
 * // Return type hints that result should be serializable
 * const fetchUser = (id: string): Effect.Effect<Serializable<User>, Error> => ...
 * ```
 */
export type Serializable<T> = T & { readonly __serializable: unique symbol };

/**
 * Types that are known to NOT be serializable.
 * Used for compile-time warnings.
 */
export type NonSerializable =
  | ((...args: any[]) => any)  // Functions
  | symbol
  | WeakMap<any, any>
  | WeakSet<any>;

/**
 * Check if a type might be non-serializable.
 * Returns `never` if T contains known non-serializable types.
 */
export type AssertSerializable<T> =
  T extends NonSerializable
    ? never
    : T extends object
      ? { [K in keyof T]: AssertSerializable<T[K]> }
      : T;
```

**Updated step signature (optional strictness):**

```typescript
/**
 * Execute a durable step with automatic caching.
 *
 * ⚠️ IMPORTANT: The effect's return value MUST be serializable (JSON-safe).
 * Non-serializable values (functions, Symbols, Proxy objects, circular refs)
 * will cause a StepSerializationError at runtime.
 *
 * If your effect returns a complex object (e.g., ORM result), map it to a
 * plain object: `.pipe(Effect.map(r => ({ id: r.id, name: r.name })))`
 * Or discard it: `.pipe(Effect.asVoid)`
 */
export function step<T, E, R>(
  name: string,
  effect: Effect.Effect<T, E, ForbidWorkflowScope<R>>,
): Effect.Effect<
  T,
  E | StepError | StepSerializationError | PauseSignal | UnknownException,
  WorkflowScope | Exclude<R, StepContext> | ExecutionContext | WorkflowContext
> {
  // ... implementation
}
```

### 5. Export New Error Type

**File: `packages/workflow/src/index.ts`**

```typescript
export { StepError, StepTimeoutError, StepSerializationError } from "./errors";
```

## Changes Summary

| File | Change |
|------|--------|
| `errors.ts` | Add `StepSerializationError` with helper methods |
| `step-context.ts` | Add `safeSerialize` function, update `setResult` |
| `Workflow.ts` | Catch serialization errors in step success path, emit `step.failed` |
| `types.ts` | Add `Serializable<T>` branded type (optional) |
| `index.ts` | Export new error type |

## Test Cases

### 1. Non-serializable value throws StepSerializationError

```typescript
it("fails with StepSerializationError for non-serializable result", async () => {
  const workflow = Workflow.make((_: void) =>
    Effect.gen(function* () {
      yield* Workflow.step("bad", Effect.succeed({ fn: () => {} })); // Function
    }),
  );

  const harness = createWorkflowHarness(workflow, { eventCapture });
  await harness.run(undefined);

  expect(await harness.getStatus()).toMatchObject({ _tag: "Failed" });

  const failedEvents = eventCapture.events.filter(e => e.type === "step.failed");
  expect(failedEvents).toHaveLength(1);
  expect(failedEvents[0].stepName).toBe("bad");
  expect(failedEvents[0].error.message).toContain("cannot be serialized");
});
```

### 2. Clear error message for ORM results

```typescript
it("provides helpful error for ORM-like results", async () => {
  // Simulate Drizzle result with non-serializable properties
  class DrizzleResult {
    rows = [{ id: 1 }];
    command = "UPDATE";
    // Proxy or getter that causes issues
    get _internal() { return this; } // Circular ref
  }

  const workflow = Workflow.make((_: void) =>
    Effect.gen(function* () {
      yield* Workflow.step("db", Effect.succeed(new DrizzleResult()));
    }),
  );

  const harness = createWorkflowHarness(workflow);

  try {
    await harness.run(undefined);
    fail("Should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(StepError);
    expect(error.cause).toBeInstanceOf(StepSerializationError);
    expect(error.cause.message).toContain("DrizzleResult");
    expect(error.cause.message).toContain("Effect.asVoid");
  }
});
```

### 3. Serializable values work normally

```typescript
it("allows serializable values", async () => {
  const workflow = Workflow.make((_: void) =>
    Effect.gen(function* () {
      const result = yield* Workflow.step("good",
        Effect.succeed({
          id: 1,
          name: "test",
          nested: { arr: [1, 2, 3] },
          date: new Date().toISOString(), // String, not Date object
        })
      );
      return result;
    }),
  );

  const harness = createWorkflowHarness(workflow, { eventCapture });
  await harness.run(undefined);

  expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });

  const completedEvents = eventCapture.events.filter(e => e.type === "step.completed");
  expect(completedEvents).toHaveLength(1);
});
```

## User Experience After Change

### Before (Current)

```
UnknownException: An unknown error occurred
 at catch (index.js:196:95737)
```

No `step.failed` event. User has no idea what went wrong.

### After (Proposed)

```
StepSerializationError: Step "Mark review as sent" returned a value that cannot
be serialized to storage. ORM query results (NeonQueryResult) often contain
non-serializable properties. Use Effect.asVoid, Effect.as(), or Effect.map()
to return a serializable value.
```

Plus a `step.failed` event with the full error message.

## Migration Guide

Users experiencing this error should:

```typescript
// Before (broken)
yield* Workflow.step("update", updateDatabase(id));

// After (fixed) - Option A: Discard result
yield* Workflow.step("update", updateDatabase(id).pipe(Effect.asVoid));

// After (fixed) - Option B: Map to serializable
yield* Workflow.step("update",
  updateDatabase(id).pipe(
    Effect.map(result => ({ rowCount: result.rowCount }))
  )
);

// After (fixed) - Option C: Return explicit value
yield* Workflow.step("update",
  updateDatabase(id).pipe(Effect.as({ success: true }))
);
```

## Future Enhancements

1. **ESLint Rule**: Custom rule that warns when step effects return known ORM types
2. **Schema Validation**: Allow users to provide a Schema for step results, validating at runtime
3. **Dev Mode Warning**: In development, log warnings for suspicious result types even when serialization succeeds

## Sources

- [Cloudflare Durable Objects Storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/)
- [MDN Structured Clone Algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm)
