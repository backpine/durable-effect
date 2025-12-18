# Report 055: Terminate/Purge Logic Simplification

## Summary

The current `ctx.terminate()` implementation has multiple bugs and the overall termination/purge logic is too fragmented across layers. This report diagnoses the issues and proposes a unified approach.

---

## Current Issues

### Issue 1: `ctx.terminate()` in `execute` - Alarm Still Runs

**Reproduction:**
```typescript
execute: (ctx) => Effect.gen(function* () {
  if (ctx.runCount >= ctx.state.maxRuns) {
    yield* ctx.terminate({ reason: "Max count reached" });
  }
  // ...
}),
```

**Root Cause:** The responsibility is split:
1. `JobExecutionService.execute()` catches `TerminateSignal` and calls `storage.deleteAll()`
2. Handler is supposed to check `result.terminated` and call `alarm.cancel()`

But `storage.deleteAll()` only deletes durable storage - it does NOT cancel the Cloudflare DO alarm. The alarm is a separate API (`ctx.storage.deleteAlarm()` / `ctx.storage.setAlarm()`).

If the handler doesn't properly check the result and cancel the alarm, it continues running.

### Issue 2: `ctx.terminate()` in `onError` Throws Error

**Reproduction:**
```typescript
onError: (error, ctx) => Effect.gen(function* () {
  yield* ctx.terminate({ reason: "Error occurred" });
}),
```

**Expected:** Terminate gracefully, purge state.
**Actual:** `Uncaught Error: Terminate signal: Error occurred`

**Root Cause:** The `TerminateSignal` thrown from `onError` is:
1. Thrown inside `handleExecutionError` callback
2. Should propagate to `handleCaughtError`
3. BUT when retry is configured, `executeWithRetry` treats ALL errors as retryable

Looking at `RetryExecutor.executeWithRetry`:
```typescript
const result = yield* Effect.either(effect);  // Catches EVERYTHING

if (result._tag === "Right") {
  yield* reset();
  return result.right;
}

const error = result.left;

if (config.isRetryable && !config.isRetryable(error)) {
  // Not retryable - fail immediately
  yield* reset();
  return yield* Effect.fail(error);
}

// Check if attempts exhausted...
```

`Effect.either` catches `TerminateSignal` as an error. Then:
- If `isRetryable` is not defined, signal is treated as retryable
- If `isRetryable(TerminateSignal)` returns false, it's re-thrown
- If `isRetryable(TerminateSignal)` returns true (or undefined), it gets retried!

### Issue 3: Signal Type Unsafety

```typescript
terminate: (options?: TerminateOptions) =>
  Effect.fail(
    new TerminateSignal({...})
  ) as Effect.Effect<never, never, never>,  // ← UNSAFE CAST
```

The `TerminateSignal` error is cast away to `never`, hiding it from the type system. This means:
- TypeScript doesn't warn about uncaught signals
- Handlers that expect `Effect<void, never, R>` from `onError` accept code that actually fails

---

## Current Architecture (Fragmented)

```
┌─────────────────────────────────────────────────────────────┐
│                     User Code                                │
│  execute: (ctx) => { yield* ctx.terminate(); }              │
└──────────────────────────┬──────────────────────────────────┘
                           │ throws TerminateSignal
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  RetryExecutor                               │
│  - Effect.either() catches EVERYTHING                       │
│  - May retry or exhaust TerminateSignal as error            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│               JobExecutionService                            │
│  - Catches TerminateSignal in handleCaughtError             │
│  - Calls storage.deleteAll() (if purgeState: true)          │
│  - Returns { terminated: true, purged: true }               │
│  - Does NOT cancel alarm                                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Handler                                   │
│  - Checks result.terminated                                 │
│  - Calls alarm.cancel() (if it remembers)                   │
│  - Updates metadata (if not purged)                         │
│  - May miss cases, different handlers have different logic  │
└─────────────────────────────────────────────────────────────┘
```

Problems:
1. **Leaky abstraction**: Signal must pass through 3+ layers correctly
2. **Inconsistent handling**: Each handler has slightly different termination code
3. **Easy to miss**: Forgetting `alarm.cancel()` in one place breaks everything
4. **Retry interference**: RetryExecutor doesn't know about control signals

---

## Proposed Solution: Unified Cleanup Service

### Design Goals

1. **Single source of truth** for cleanup operations
2. **Signals bypass retry** entirely - they're control flow, not errors
3. **Atomic cleanup** - alarm, storage, metadata all cleaned together
4. **Type-safe** - no hidden error channels

### New Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     User Code                                │
│  execute: (ctx) => { yield* ctx.terminate(); }              │
└──────────────────────────┬──────────────────────────────────┘
                           │ throws TerminateSignal
                           ▼
┌─────────────────────────────────────────────────────────────┐
│               JobExecutionService                            │
│  1. Check for TerminateSignal BEFORE retry logic            │
│  2. On TerminateSignal: call CleanupService.terminate()     │
│  3. Return result (no signal escapes)                       │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  CleanupService                              │
│  terminate(options):                                         │
│    1. alarm.cancel()                                         │
│    2. storage.deleteAll()                                    │
│    3. (metadata already deleted by deleteAll)                │
│  Result: Everything cleaned in one atomic operation          │
└─────────────────────────────────────────────────────────────┘
```

### Implementation Plan

#### 1. Create CleanupService

```typescript
// packages/jobs/src/services/cleanup.ts

export interface CleanupServiceI {
  /**
   * Full termination - cancel alarm and delete all storage.
   * Used by ctx.terminate() and external terminate API.
   */
  readonly terminate: () => Effect.Effect<void, StorageError | SchedulerError>;

  /**
   * Clear only - cancel alarm and delete storage, but keep metadata option.
   * Used by Task's ctx.clear().
   */
  readonly clear: (options?: { keepMetadata?: boolean }) =>
    Effect.Effect<void, StorageError | SchedulerError>;
}

export const CleanupServiceLayer = Layer.effect(
  CleanupService,
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const alarm = yield* AlarmService;

    return {
      terminate: () => Effect.gen(function* () {
        yield* alarm.cancel();
        yield* storage.deleteAll();
      }),

      clear: (options) => Effect.gen(function* () {
        yield* alarm.cancel();
        if (options?.keepMetadata) {
          // Delete specific keys, keep metadata
          yield* storage.delete(KEYS.STATE);
          yield* storage.delete(KEYS.RUN_COUNT);
          // etc.
        } else {
          yield* storage.deleteAll();
        }
      }),
    };
  })
);
```

#### 2. Modify RetryExecutor to Bypass Signals

```typescript
// packages/jobs/src/retry/executor.ts

executeWithRetry: <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  config: JobRetryConfig<E>,
  context: { ... }
): Effect.Effect<A, E | RetryExhaustedError | RetryScheduledSignal, R> =>
  Effect.gen(function* () {
    // Execute and catch errors
    const result = yield* effect.pipe(
      // Let signals escape - don't catch them
      Effect.catchAllCause((cause) => {
        // Check if it's a TerminateSignal - let it through
        const failure = Cause.failureOption(cause);
        if (failure._tag === "Some" && failure.value instanceof TerminateSignal) {
          return Effect.failCause(cause);  // Re-throw as-is
        }
        // For other errors, convert to Either
        return Effect.fail(Cause.squash(cause));
      })
    );

    // If we get here, it succeeded - reset retry state
    yield* reset();
    return result;
  }).pipe(
    // Now handle regular errors with retry logic
    Effect.catchAll((error) => {
      // ... existing retry logic ...
    })
  );
```

Actually, simpler approach - check signal type explicitly before retry logic:

```typescript
executeWithRetry: (...) => Effect.gen(function* () {
  const attempt = yield* getAttempt();

  // Execute the effect - but first wrap to detect signals
  const result = yield* effect.pipe(
    Effect.map((a) => ({ _tag: "Success" as const, value: a })),
    Effect.catchAll((e) =>
      e instanceof TerminateSignal
        ? Effect.fail(e)  // Let signals escape immediately
        : Effect.succeed({ _tag: "Failure" as const, error: e })
    )
  );

  if (result._tag === "Success") {
    yield* reset();
    return result.value;
  }

  // Regular error - apply retry logic
  const error = result.error;
  // ... existing retry logic ...
});
```

#### 3. Simplify JobExecutionService

```typescript
// packages/jobs/src/services/execution.ts

execute: (...) => Effect.gen(function* () {
  // ... setup ...

  const cleanup = yield* CleanupService;

  // Run user code
  const runResult = yield* executeUserLogic.pipe(
    Effect.map(() => ({ terminated: false, purged: false })),
    Effect.catchAll((error) => {
      // Handle TerminateSignal
      if (error instanceof TerminateSignal) {
        if (error.purgeState) {
          return cleanup.terminate().pipe(
            Effect.map(() => ({
              terminated: true,
              purged: true,
              reason: error.reason
            }))
          );
        }
        // Mark as terminated but don't purge
        return Effect.succeed({
          terminated: true,
          purged: false,
          reason: error.reason
        });
      }

      // Regular error - call onError if defined
      if (onError) {
        return onError(error, ctx).pipe(
          // onError might also terminate
          Effect.catchAll((onErrorError) => {
            if (onErrorError instanceof TerminateSignal) {
              if (onErrorError.purgeState) {
                return cleanup.terminate().pipe(
                  Effect.map(() => ({
                    terminated: true,
                    purged: true,
                    reason: onErrorError.reason
                  }))
                );
              }
              return Effect.succeed({
                terminated: true,
                purged: false,
                reason: onErrorError.reason
              });
            }
            // Re-throw other errors
            return Effect.fail(onErrorError);
          }),
          Effect.map(() => ({ terminated: false, purged: false }))
        );
      }

      // No onError - let error propagate
      return Effect.fail(error);
    })
  );

  // Save state if not purged
  if (runResult.purged === false && stateHolder.dirty && stateHolder.current !== null) {
    yield* stateService.set(stateHolder.current);
  }

  return runResult;
});
```

#### 4. Simplify Handlers

Handlers no longer need to check `result.terminated` and call `alarm.cancel()`:

```typescript
// Before (in handleTrigger):
const result = yield* runExecution(def, runCount);

if (result.terminated) {
  yield* alarm.cancel();  // ← Had to remember this
  if (!result.purged) {
    yield* metadata.updateStatus("stopped");
  }
  return { ... };
}

// After:
const result = yield* runExecution(def, runCount);

if (result.terminated) {
  // CleanupService already handled alarm + storage
  // Just return the response
  return {
    _type: "continuous.trigger",
    triggered: true,
    terminated: true
  };
}
```

---

## Alternative: Return-Based API Instead of Signals

Instead of signals, use a return value pattern:

```typescript
// Current (signal-based):
execute: (ctx) => Effect.gen(function* () {
  if (done) {
    yield* ctx.terminate({ reason: "Done" });  // throws
  }
  // ... continue
});

// Alternative (return-based):
execute: (ctx) => Effect.gen(function* () {
  if (done) {
    return ctx.terminate({ reason: "Done" });  // returns special value
  }
  // ... continue
});
```

Where `ctx.terminate()` returns a `TerminateResult` that the framework checks:

```typescript
interface TerminateResult {
  readonly _tag: "terminate";
  readonly reason?: string;
  readonly purgeState: boolean;
}

// In execution service:
const result = yield* userExecute(ctx);

if (result && typeof result === "object" && result._tag === "terminate") {
  yield* cleanup.terminate();
  return { terminated: true, purged: result.purgeState };
}
```

**Pros:**
- No signal propagation complexity
- Type-safe (return type includes `TerminateResult | void`)
- Can't accidentally catch/swallow it

**Cons:**
- User must `return` the terminate call
- Less ergonomic for early exit from deep nesting
- Breaking API change

---

## Recommended Approach

**Phase 1: Fix immediate bugs**
1. Add `TerminateSignal` check in `RetryExecutor.executeWithRetry` before retry logic
2. Ensure `JobExecutionService` handles `TerminateSignal` from `onError`

**Phase 2: Consolidate cleanup**
1. Create `CleanupService` with `terminate()` and `clear()` methods
2. `JobExecutionService` uses `CleanupService` for all cleanup
3. Handlers only check result, don't call cleanup directly

**Phase 3: Simplify handlers**
1. Remove duplicate alarm/storage cleanup code from handlers
2. Handlers become focused on request/response logic only

---

## Files to Modify

1. `packages/jobs/src/services/cleanup.ts` - NEW: CleanupService
2. `packages/jobs/src/retry/executor.ts` - Bypass signals before retry
3. `packages/jobs/src/services/execution.ts` - Use CleanupService, handle signals from onError
4. `packages/jobs/src/handlers/continuous/handler.ts` - Remove manual cleanup
5. `packages/jobs/src/handlers/task/handler.ts` - Remove manual cleanup
6. `packages/jobs/src/handlers/debounce/handler.ts` - Remove manual cleanup

---

## Summary

| Aspect | Current | Proposed |
|--------|---------|----------|
| Alarm cancellation | Handler responsibility | CleanupService |
| Storage deletion | JobExecutionService | CleanupService |
| Signal handling in retry | Treated as error | Bypassed entirely |
| Signal handling in onError | May escape uncaught | Explicitly handled |
| Code duplication | High (each handler) | Low (centralized) |
| Bug potential | High (easy to miss) | Low (single point) |
