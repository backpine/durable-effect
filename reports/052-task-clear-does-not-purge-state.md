# Report 052: Task `ctx.clear()` Does Not Purge State

## Summary

When calling `yield* ctx.clear()` in a Task's `execute` handler (triggered by alarm), **the state is NOT deleted** even though the alarm is cleared. This is a bug caused by two issues in the error handling flow.

---

## Expected Behavior

```typescript
execute: (ctx) => Effect.gen(function* () {
  const state = yield* ctx.state;
  if (state.currentRun >= state.targetRuns) {
    yield* ctx.clear();  // Should delete ALL storage including state
  }
})
```

After `ctx.clear()`:
- Alarm is cancelled ✓
- All storage keys deleted (including state) ✗ **BUG: state persists**

---

## Root Cause Analysis

### Issue 1: `ClearSignal` is Wrapped in `ExecutionError`

**Location:** `packages/jobs/src/services/execution.ts:193-220`

The `JobExecutionService` only recognizes `TerminateSignal`, not `ClearSignal`:

```typescript
// execution.ts:199-212
const handleCaughtError = (error: unknown) => {
  if (error instanceof RetryScheduledSignal) { ... }
  if (error instanceof TerminateSignal) {        // ← Only checks TerminateSignal
    terminated = true;
    if (error.purgeState) {
      return stateService.delete().pipe(...)
    }
    return Effect.void;
  }
  if (error instanceof RetryExhaustedError) { ... }

  return Effect.fail(wrapError(error));  // ← ClearSignal falls through here!
};
```

When `ctx.clear()` throws `ClearSignal`, it's **wrapped in `ExecutionError`** instead of being recognized and handled.

### Issue 2: `handleAlarm` Doesn't Catch `ClearSignal`

**Location:** `packages/jobs/src/handlers/task/handler.ts:476-498`

Even if `ClearSignal` propagated correctly, `handleAlarm` has no handler for it:

```typescript
// handler.ts:476-498
handleAlarm: (): Effect.Effect<void, JobError, any> =>
  Effect.gen(function* () {
    const meta = yield* metadata.get();
    if (!meta || meta.type !== "task") return;

    const def = yield* getDefinition(meta.name);
    yield* incrementExecuteCount();
    yield* runExecution(def, 0, "execute");  // ClearSignal thrown here
  }).pipe(
    Effect.catchTag("StorageError", (e) => ...)  // ← No ClearSignal handler!
  ),
```

Compare with `handleSend` and `handleTrigger` which DO have handlers:

```typescript
// handler.ts:430-442
return yield* handleSend(def, request).pipe(
  Effect.catchTag("ClearSignal", () =>  // ← This handler exists
    Effect.gen(function* () {
      yield* purge();                     // ← But ClearSignal is wrapped,
      return { ... };                     //   so this never executes
    }),
  ),
);
```

---

## Error Flow Trace

```
1. Alarm fires
   ↓
2. handleAlarm() called
   ↓
3. runExecution(def, 0, "execute") called
   ↓
4. execution.execute() (JobExecutionService)
   ↓
5. User's execute handler runs: yield* ctx.clear()
   ↓
6. ctx.clear() throws ClearSignal (context.ts:187-188)
   ↓
7. runWithErrorHandling catches and re-throws ClearSignal (handler.ts:171)
   ↓
8. handleCaughtError in execution.ts doesn't recognize ClearSignal
   ↓
9. ClearSignal wrapped in ExecutionError (execution.ts:219)
   ↓
10. ExecutionError propagates to handleAlarm
    ↓
11. handleAlarm has no catchTag("ClearSignal", ...) or catchTag("ExecutionError", ...)
    ↓
12. Error propagates up - state NOT deleted, alarm already fired so appears "cleared"
```

---

## Why Alarm Appears Cleared

The alarm "appears" cleared because:
1. The alarm has **already fired** (that's why `handleAlarm` was called)
2. Cloudflare automatically removes fired alarms
3. No new alarm is scheduled

So it's not that `clear()` clears the alarm - the alarm was already gone.

---

## Two-Part Fix Required

### Fix A: Add ClearSignal Handler to `handleAlarm`

```typescript
// handler.ts - Add to handleAlarm like other handlers
handleAlarm: (): Effect.Effect<void, JobError, any> =>
  Effect.gen(function* () {
    const meta = yield* metadata.get();
    if (!meta || meta.type !== "task") return;

    const def = yield* getDefinition(meta.name);
    yield* incrementExecuteCount();
    yield* runExecution(def, 0, "execute");
  }).pipe(
    Effect.catchTag("ClearSignal", () =>
      Effect.gen(function* () {
        yield* purge();  // alarm.cancel() + storage.deleteAll()
      })
    ),
    Effect.catchTag("StorageError", (e) => ...)
  ),
```

### Fix B: Have JobExecutionService Recognize ClearSignal

Either map `ClearSignal` to `TerminateSignal`:

```typescript
// In runExecution's runWithErrorHandling:
Effect.catchAll(error => {
  if (error instanceof ClearSignal) {
    return Effect.fail(new TerminateSignal({ reason: "clear", purgeState: true }));
  }
  // ...
})
```

Or add `ClearSignal` handling directly to `JobExecutionService`:

```typescript
// execution.ts handleCaughtError
const handleCaughtError = (error: unknown) => {
  // ... existing checks ...

  if (error instanceof ClearSignal) {  // ← Add this
    return stateService.delete().pipe(
      withStorage,
      Effect.mapError(wrapError),
      Effect.flatMap(() => storage.deleteAll().pipe(Effect.mapError(wrapError))),
      Effect.flatMap(() => setPurged)
    );
  }

  return Effect.fail(wrapError(error));
};
```

---

## Design Consideration

The cleaner solution is **Fix B** - treat `ClearSignal` as equivalent to `TerminateSignal({ purgeState: true })` in `JobExecutionService`. This:

1. Ensures consistent behavior across all trigger paths (send, trigger, alarm)
2. Centralizes the cleanup logic
3. Avoids needing to add `catchTag("ClearSignal", ...)` to every handler path

Alternatively, consider merging `ClearSignal` into `TerminateSignal` entirely:

```typescript
// Just use TerminateSignal in ctx.clear()
clear: (): Effect.Effect<never, never, never> =>
  Effect.fail(new TerminateSignal({ reason: "clear", purgeState: true }))
```

This would make `clear()` work immediately since `TerminateSignal` is already handled correctly in `JobExecutionService.execute()`.

---

## Summary

| Symptom | Cause | Fix |
|---------|-------|-----|
| Alarm cleared | Already fired (not a bug) | N/A |
| State persists | `ClearSignal` wrapped in `ExecutionError` | Handle `ClearSignal` in `JobExecutionService` |
| State persists | `handleAlarm` missing `ClearSignal` handler | Add handler or use Fix B |
