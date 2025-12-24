# Report 062: Debounce Execution Failure Does Not Purge State

## Problem Statement

When a debounce job's `execute` function fails and no retry is configured (or an unhandled error occurs), the debounce state (event count, startedAt, user state) is **never purged**. This leaves the debounce in a "zombie" state where:

1. The alarm has already fired (and won't fire again)
2. The execute function failed
3. The state remains in storage indefinitely
4. New events will increment the existing state instead of starting fresh

## Root Cause Analysis

### Execution Flow for Failures

When `execute` fails, the error flow is:

```
User's execute() throws error
    ↓
execution.execute() catches in Effect.catchAll (lines 348-370)
    ↓
Error is NOT a signal (RetryScheduled, Terminate, RetryExhausted)
    ↓
Emits job.failed event with willRetry: false
    ↓
Returns Effect.fail(wrapError(error))  ← ERROR PROPAGATES
    ↓
runFlush() fails with ExecutionError
    ↓
handleAdd/handleFlush doesn't catch ExecutionError  ← PURGE NEVER CALLED
    ↓
Error propagates to dispatcher/runtime
```

### Code Evidence

**In execution.ts lines 348-370:**
```typescript
// Unknown/unhandled error - emit job.failed event with willRetry: false
const errorMessage = error instanceof Error ? error.message : String(error);
return emitEvent({
  type: "job.failed" as const,
  willRetry: false,
  // ...
}).pipe(
  Effect.zipRight(Effect.fail(wrapError(error))),  // ← ERROR THROWN
);
```

**In debounce handler.ts handleFlush (lines 243-268):**
```typescript
const result = yield* runFlush(def, reason, meta.id);

if (result.success) {
  yield* purge();  // ← Only purges on SUCCESS
} else if (result.terminated) {
  // CleanupService already purged
}
// NO handling for execution failure! ← BUG
```

**In debounce handler.ts error catching (lines 348-368):**
```typescript
.pipe(
  Effect.catchTag("StorageError", ...),
  Effect.catchTag("SchedulerError", ...),
  // ExecutionError is NOT caught! ← BUG
)
```

### When Does This Happen?

1. **No retry configured**: Execute fails → error propagates → no purge
2. **Retry configured but exhausted with onRetryExhausted handler that doesn't terminate**: retryExhausted=true but terminated=false → no purge in handler (though cleanup happens in execution service)
3. **Infrastructure error during execute**: Any unexpected error that's not a retry signal

## Impact

1. **Zombie state**: Debounce lingers with stale data
2. **Incorrect event counts**: New events add to old count instead of starting fresh
3. **Wrong startedAt**: Duration calculations are wrong
4. **State accumulation**: User state from failed batch persists
5. **No visibility**: UI shows debounce as "collecting" but it's actually dead

## Recommended Fix

### Option A: Always Purge on Execution Failure (Recommended)

Catch ExecutionError in handleFlush and purge on failure:

```typescript
const handleFlush = (def, reason) =>
  Effect.gen(function* () {
    // ... existing logic ...

    const result = yield* runFlush(def, reason, meta.id).pipe(
      Effect.catchTag("ExecutionError", (error) => {
        // Execution failed - still need to purge to avoid zombie state
        return Effect.succeed({
          success: false,
          retryScheduled: false,
          terminated: false,
          rescheduled: false,
          retryExhausted: false,
          executionError: error,
        } as ExecutionResult & { executionError?: ExecutionError });
      })
    );

    if (result.success) {
      yield* emitEvent({ type: "debounce.flushed", ... });
      yield* purge();
    } else if (result.terminated) {
      // Already purged by CleanupService
    } else if (!result.retryScheduled && !result.rescheduled) {
      // Execution failed without retry - purge to avoid zombie state
      yield* purge();
    }

    // ...
  });
```

**Same pattern needed in handleAdd for maxEvents case.**

### Option B: Purge in Finally Block

Use Effect.ensuring to always clean up:

```typescript
if (def.maxEvents !== undefined && nextCount >= def.maxEvents) {
  const startedAt = yield* getStartedAt();
  const durationMs = startedAt ? Date.now() - startedAt : 0;

  yield* runFlush(def, "maxEvents", request.id).pipe(
    Effect.tap((result) => {
      if (result.success) {
        return emitEvent({ type: "debounce.flushed", ... });
      }
      return Effect.void;
    }),
    Effect.ensuring(
      // Always purge after flush attempt (success or failure)
      // Only skip if retry is scheduled
      Effect.gen(function* () {
        const isRetrying = yield* retryExecutor.isRetrying().pipe(
          Effect.catchAll(() => Effect.succeed(false))
        );
        if (!isRetrying) {
          yield* purge();
        }
      })
    )
  );
}
```

### Option C: Handle at Execution Service Level

Make execution service always return success/failure result, never throw:

```typescript
// In execution.ts, change unknown error handling:
// Unknown/unhandled error
return emitEvent({...}).pipe(
  Effect.zipRight(Effect.succeed({
    success: false,
    retryScheduled: false,
    terminated: true,  // Mark as terminated so handler knows to purge
    rescheduled: false,
    retryExhausted: false,
    terminateReason: `Execution failed: ${errorMessage}`,
  }))
);
```

This would require the execution service to also call cleanup.terminate().

## Comparison of Options

| Aspect | Option A | Option B | Option C |
|--------|----------|----------|----------|
| Blast radius | Debounce handler only | Debounce handler only | All job types |
| Complexity | Low | Medium | High |
| Retry handling | Explicit check | Uses retryExecutor | Automatic |
| Error info | Preserved | Preserved | Lost (converted to result) |
| Other handlers | Need similar fix | Need similar fix | Automatic |

## Recommendation

**Option A** is recommended because:
1. It's explicit about what happens on failure
2. It preserves error information for logging/debugging
3. It's localized to the debounce handler
4. It follows the existing pattern (check result flags)

The same fix pattern should be applied to:
- `handleAdd` (maxEvents case)
- `handleFlush` (timeout/manual case)
- `handleAlarm` (calls handleFlush)

## Files to Modify

| File | Change |
|------|--------|
| `packages/jobs/src/handlers/debounce/handler.ts` | Catch ExecutionError and purge on failure |

## Test Cases

```typescript
it("purges state when execution fails without retry", async () => {
  const failingDebounce = Debounce.make({
    eventSchema: TestEvent,
    flushAfter: "5 seconds",
    // NO retry configured
    execute: () => Effect.fail(new Error("Always fails")),
  });

  // Add event
  await runtime.handle({ type: "debounce", action: "add", name: "test", event: {} });

  // Trigger alarm (flush)
  await scheduler.fire();
  await runtime.handleAlarm();

  // State should be purged
  const status = await runtime.handle({ type: "debounce", action: "status", name: "test" });
  expect(status.status).toBe("not_found");
});

it("purges state when execution fails after retries exhausted", async () => {
  const failingDebounce = Debounce.make({
    eventSchema: TestEvent,
    flushAfter: "5 seconds",
    retry: { delay: "100ms", maxAttempts: 2 },
    execute: () => Effect.fail(new Error("Always fails")),
  });

  // Add event and exhaust retries
  await runtime.handle({ type: "debounce", action: "add", name: "test", event: {} });
  await scheduler.fire(); // First attempt
  await runtime.handleAlarm();
  await scheduler.fire(); // Retry 1
  await runtime.handleAlarm();
  await scheduler.fire(); // Retry 2 (exhausted)
  await runtime.handleAlarm();

  // State should be purged
  const status = await runtime.handle({ type: "debounce", action: "status", name: "test" });
  expect(status.status).toBe("not_found");
});
```

## Event Flow After Fix

### Execution Fails Without Retry
```
debounce.started
    │
    │   ... (events accumulate)
    │
    ├── job.failed (willRetry=false)
    │
    └── (purge)  ← NEW: State cleaned up
```

### Execution Fails With Retry Exhausted
```
debounce.started
    │
    ├── job.failed (willRetry=true)
    ├── job.failed (willRetry=true)
    ├── job.failed (willRetry=false)
    │
    ├── job.retryExhausted
    │
    └── (purge via cleanup.terminate)  ← Already works
```
