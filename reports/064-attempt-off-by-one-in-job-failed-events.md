# Report 064: Attempt Off-by-One in job.failed Events

## Summary

The `attempt` field in `job.failed` events is incorrectly set to the *next* attempt number rather than the attempt where the failure occurred. This causes the first failure to report `attempt: 2` instead of `attempt: 1`.

## Observed Behavior

Query results from a debounce job show the following pattern:

```json
{"event_type":"job.executed","payload":{"attempt":1,...},...}
{"event_type":"job.failed","payload":{"attempt":2,"error":{"message":"Retry scheduled for attempt 3"},...},...}
{"event_type":"job.executed","payload":{"attempt":2,...},...}
```

The problem:
- First successful execution correctly shows `attempt: 1`
- First failure shows `attempt: 2` with message "Retry scheduled for attempt 3"
- This is off-by-one: the failure occurred on attempt 1, not attempt 2

## Root Cause Analysis

The issue spans two files with a semantic mismatch between them:

### 1. RetryExecutor (`packages/jobs/src/retry/executor.ts`)

When a failure occurs at line 200-213:

```typescript
// Schedule retry
yield* setLastError(error);
yield* setAttempt(attempt + 1);  // Line 202: Increments attempt BEFORE creating signal

const baseDelay = resolveDelay(config.delay, attempt);
const delayMs = config.jitter !== false ? addJitter(baseDelay) : baseDelay;
const resumeAt = now + delayMs;

yield* alarm.schedule(resumeAt);
yield* setScheduledAt(resumeAt);

// Return a signal that the handler will catch
return yield* Effect.fail(
  new RetryScheduledSignal({ resumeAt, attempt: attempt + 1 })  // Line 213: Passes NEXT attempt
);
```

The `RetryScheduledSignal.attempt` represents the **next** attempt number (the attempt that will be scheduled).

### 2. JobExecutionService (`packages/jobs/src/services/execution.ts`)

When catching the `RetryScheduledSignal` at line 242-259:

```typescript
if (error instanceof RetryScheduledSignal) {
  retryScheduled = true;
  return emitEvent({
    ...createJobBaseEvent(...),
    type: "job.failed" as const,
    error: {
      message: `Retry scheduled for attempt ${error.attempt + 1}`,  // This becomes attempt+2!
    },
    runCount: options.runCount ?? 0,
    attempt: error.attempt,  // <-- BUG: Uses the NEXT attempt, not the failed attempt
    willRetry: true,
  } satisfies InternalJobFailedEvent);
}
```

### The Semantic Mismatch

| Field | Current Meaning | Expected Meaning |
|-------|-----------------|------------------|
| `RetryScheduledSignal.attempt` | Next attempt to be scheduled | Next attempt to be scheduled (correct) |
| `InternalJobFailedEvent.attempt` | Currently: next attempt | Should be: attempt where failure occurred |

The event schema comment confirms the expected semantics:
```typescript
/** Retry attempt when failure occurred */
attempt: Schema.Number,
```

## Execution Flow Example

When first attempt fails:

1. `getAttempt()` returns `1` (first attempt)
2. User code fails
3. `setAttempt(1 + 1)` stores `2` in storage
4. `RetryScheduledSignal` created with `{ attempt: 2 }` (next attempt)
5. `job.failed` event emitted with:
   - `attempt: 2` (wrong - should be 1)
   - `message: "Retry scheduled for attempt 3"` (wrong - should be "for attempt 2")

## Impact

1. **UI Display**: The attempt counter shown in monitoring dashboards is off-by-one
2. **Analytics**: Any metrics or alerts based on attempt numbers will be incorrect
3. **Confusion**: Users see failures labeled as attempt 2 when it's actually the first failure

## Fix Options

### Option A: Fix in JobExecutionService (Recommended)

Subtract 1 when emitting the event:

```typescript
if (error instanceof RetryScheduledSignal) {
  retryScheduled = true;
  const failedAttempt = error.attempt - 1;  // The attempt that just failed
  return emitEvent({
    ...createJobBaseEvent(...),
    type: "job.failed" as const,
    error: {
      message: `Retry scheduled for attempt ${error.attempt}`,  // Next attempt
    },
    runCount: options.runCount ?? 0,
    attempt: failedAttempt,  // The attempt where failure occurred
    willRetry: true,
  } satisfies InternalJobFailedEvent);
}
```

**Pros**: Minimal change, localized fix
**Cons**: Adjustment logic in consumer rather than producer

### Option B: Add `failedAttempt` to RetryScheduledSignal

Modify `RetryScheduledSignal` to carry both values:

```typescript
export class RetryScheduledSignal extends Data.TaggedError("RetryScheduledSignal")<{
  readonly resumeAt: number;
  readonly attempt: number;      // Existing: next attempt
  readonly failedAttempt: number; // New: where failure occurred
}> {}
```

And in RetryExecutor:
```typescript
return yield* Effect.fail(
  new RetryScheduledSignal({
    resumeAt,
    attempt: attempt + 1,
    failedAttempt: attempt  // Add the current attempt
  })
);
```

**Pros**: Explicit semantics, no arithmetic in consumer
**Cons**: More invasive change

### Option C: Rename for Clarity

Rename `attempt` in `RetryScheduledSignal` to `nextAttempt` to clarify semantics:

```typescript
export class RetryScheduledSignal extends Data.TaggedError("RetryScheduledSignal")<{
  readonly resumeAt: number;
  readonly nextAttempt: number;  // Renamed for clarity
}> {}
```

And derive `failedAttempt = nextAttempt - 1` at the call site.

**Pros**: Self-documenting code
**Cons**: Renaming could break other consumers

## Recommendation

**Option A** is the simplest fix with minimal risk. The message correction is also needed:

```typescript
if (error instanceof RetryScheduledSignal) {
  retryScheduled = true;
  const failedAttempt = error.attempt - 1;
  return emitEvent({
    ...createJobBaseEvent(...),
    type: "job.failed" as const,
    error: {
      message: `Retry scheduled for attempt ${error.attempt}`,
    },
    runCount: options.runCount ?? 0,
    attempt: failedAttempt,
    willRetry: true,
  } satisfies InternalJobFailedEvent);
}
```

This ensures:
- `attempt: 1` when the first attempt fails
- Message says "Retry scheduled for attempt 2" (the next attempt)

## Affected Files

- `packages/jobs/src/services/execution.ts:242-259` - Where the fix should be applied
- `packages/jobs/src/retry/executor.ts:200-214` - Source of the signal (no change needed for Option A)
- `packages/jobs/src/retry/errors.ts` - Signal definition (no change needed for Option A)
