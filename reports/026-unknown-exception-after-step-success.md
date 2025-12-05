# Report 026: UnknownException After Successful Step Completion

## Problem

User experiences an `UnknownException` after a workflow step completes successfully:
- The last step (`markNotificationSent`) executes successfully
- No `step.failed` event is emitted
- An opaque `UnknownException: An unknown error occurred` is thrown

Stack trace:
```
UnknownException: An unknown error occurred
 at catch (index.js:196:95737)
 at EffectPrimitive.effect_instruction_i0 (index.js:183:14112)
```

## Root Cause: Step Result Serialization Failure

**The most likely cause is that the step returns a value that cannot be serialized to Durable Object storage.**

### How Step Results Are Cached

After a step's effect succeeds, the result is cached for replay (Workflow.ts:140-155):

```typescript
if (result._tag === "Right") {
  // Success path
  yield* stepCtx.setResult(result.right);  // <-- SERIALIZATION HAPPENS HERE
  yield* markStepCompleted(name, storage);
  yield* emitEvent({ type: "step.completed", ... });
  return result.right;
}
```

The `setResult` function (step-context.ts:109-113):

```typescript
setResult: <T>(value: T) =>
  Effect.tryPromise({
    try: () => storage.put(stepKey(stepName, "result"), value),
    catch: (e) => new UnknownException(e),  // <-- ERROR WRAPPED HERE
  }),
```

### What Fails Serialization?

Durable Object `storage.put()` uses structured clone algorithm. These will fail:

1. **Functions** - Cannot be cloned
2. **Symbols** - Cannot be cloned
3. **WeakMap/WeakSet** - Cannot be cloned
4. **Circular references** - Throw `DataCloneError`
5. **DOM nodes** - Cannot be cloned
6. **Certain Drizzle/ORM result objects** - May have internal getters, proxies, or circular refs

### The Likely Culprit

```typescript
yield* Workflow.step(
  "Mark review as sent",
  markNotificationSent(input.reviewId, input.businessId).pipe(
    Effect.catchAll((e) =>
      Effect.fail(new Error(`Email error: ${String(e)}`)),
    ),
  ),
);
```

**What does `markNotificationSent` return?**

If it returns the raw Drizzle query result (e.g., `db.update(...).returning()`), that object may contain:
- Internal Drizzle metadata
- Proxy objects
- Non-serializable properties

### Why No `step.failed` Event?

The step's **effect** succeeds (the database update works). The failure happens in the **framework's caching logic** after the effect returns:

```
1. markNotificationSent() → SUCCESS (returns Drizzle result)
2. stepCtx.setResult(drizzleResult) → FAIL (can't serialize)
3. UnknownException thrown
4. No step.failed because the effect itself didn't fail
```

## Diagnosis

### Quick Test

Modify your step to return a simple value:

```typescript
yield* Workflow.step(
  "Mark review as sent",
  markNotificationSent(input.reviewId, input.businessId).pipe(
    Effect.catchAll((e) =>
      Effect.fail(new Error(`Email error: ${String(e)}`)),
    ),
    Effect.as(undefined),  // <-- Return undefined instead of query result
  ),
);
```

If the error disappears, the issue is serialization.

### Debug Logging

Add logging to see what's being returned:

```typescript
yield* Workflow.step(
  "Mark review as sent",
  markNotificationSent(input.reviewId, input.businessId).pipe(
    Effect.tap((result) =>
      Effect.log({
        message: "markNotificationSent result",
        result: JSON.stringify(result),  // Will fail if not serializable
        type: typeof result,
      })
    ),
    Effect.catchAll((e) =>
      Effect.fail(new Error(`Email error: ${String(e)}`)),
    ),
  ),
);
```

## Solution

### Option A: Return Explicit Value (Recommended)

```typescript
export const markNotificationSent = (reviewId: string, businessId: string) =>
  query(async (db) => {
    await db.update(reviews)
      .set({ notificationSent: true })
      .where(eq(reviews.id, reviewId));
    return { success: true };  // Return serializable value
  });
```

### Option B: Map to Serializable at Call Site

```typescript
yield* Workflow.step(
  "Mark review as sent",
  markNotificationSent(input.reviewId, input.businessId).pipe(
    Effect.map((result) => ({
      rowCount: result.rowCount,  // Extract only serializable data
    })),
    Effect.catchAll((e) =>
      Effect.fail(new Error(`Email error: ${String(e)}`)),
    ),
  ),
);
```

### Option C: Return void

```typescript
yield* Workflow.step(
  "Mark review as sent",
  markNotificationSent(input.reviewId, input.businessId).pipe(
    Effect.asVoid,  // Discard result entirely
    Effect.catchAll((e) =>
      Effect.fail(new Error(`Email error: ${String(e)}`)),
    ),
  ),
);
```

## Why This is Hard to Debug

1. **Minified stack trace**: Production bundles minify, losing function names
2. **UnknownException wrapping**: Original error is hidden inside `.error` property
3. **Timing**: Error happens AFTER step effect succeeds, BEFORE step completion events
4. **No event emitted**: Error is in framework caching logic, not user code

## Framework Improvement Suggestion

The framework should catch serialization errors and provide better messaging:

```typescript
// step-context.ts - improved setResult
setResult: <T>(value: T) =>
  Effect.tryPromise({
    try: () => storage.put(stepKey(stepName, "result"), value),
    catch: (e) => {
      // Check if it's a serialization error
      if (e instanceof DOMException && e.name === "DataCloneError") {
        return new StepSerializationError({
          stepName,
          message: `Step "${stepName}" returned a value that cannot be serialized. ` +
            `Ensure your step returns a JSON-serializable value. ` +
            `Use Effect.asVoid or Effect.as() to return a simple value.`,
          cause: e,
        });
      }
      return new UnknownException(e);
    },
  }),
```

## Conclusion

**The step's database operation succeeds, but the returned value cannot be serialized to Durable Object storage.**

**Quick fix**: Add `.pipe(Effect.asVoid)` or `.pipe(Effect.as({ success: true }))` to the step's effect.

**Permanent fix**: Ensure all step effects return JSON-serializable values.
