# Bug 002: Investigation - Why Does resetAttempt() Exist?

## Summary

This investigation examines whether `stepCtx.resetAttempt()` in `retry.ts` line 245 serves any purpose, and whether it should be removed entirely.

**Conclusion: `resetAttempt()` is unnecessary and should be removed.**

## Current Behavior

In `retry.ts` lines 243-246:
```typescript
if (result.success) {
  // Success! Reset attempt counter and return
  yield* stepCtx.resetAttempt();
  return result.value;
}
```

When a retry succeeds, it resets the attempt counter from N back to 1.

## Attempt Lifecycle Analysis

### Storage Keys

Each step has isolated storage keys namespaced by step name:
```typescript
// step-context.ts
const KEYS = {
  attempt: (stepName: string) => `step:${stepName}:attempt`,
  startedAt: (stepName: string) => `step:${stepName}:startedAt`,
  result: (stepName: string) => `step:${stepName}:result`,
  meta: (stepName: string, key: string) => `step:${stepName}:meta:${key}`,
};
```

**Key insight:** Each step has its OWN attempt counter. Step A's attempts are completely independent of Step B's attempts.

### Attempt Counter Flow

**Initial Execution (attempt 1):**
```
1. step.ts: stepCtx.attempt → 1 (default)
2. step.ts: emit step.started {attempt: 1}
3. retry.ts: attempt = 1, execute effect
4. Effect FAILS
5. retry.ts: incrementAttempt() → attempt = 2
6. retry.ts: throw PauseSignal.retry(..., attempt: 2)
7. Workflow pauses
```

**Resume (attempt 2):**
```
1. step.ts: stepCtx.attempt → 2 (persisted)
2. step.ts: emit step.started {attempt: 2}
3. retry.ts: attempt = 2, execute effect
4. Effect FAILS
5. retry.ts: incrementAttempt() → attempt = 3
6. retry.ts: throw PauseSignal.retry(..., attempt: 3)
7. Workflow pauses
```

**Resume (attempt 3 - SUCCESS):**
```
1. step.ts: stepCtx.attempt → 3 (persisted)
2. step.ts: emit step.started {attempt: 3}
3. retry.ts: attempt = 3, execute effect
4. Effect SUCCEEDS
5. retry.ts: resetAttempt() → attempt = 1  ← THE PROBLEM
6. Return to step.ts
7. step.ts: stepCtx.attempt → 1 (wrong!)
8. step.ts: emit step.completed {attempt: 1}  ← BUG!
```

## What Happens After Step Success?

Once a step succeeds:

1. **Result is cached** (`step.ts` line 222):
   ```typescript
   yield* stepCtx.setResult(result, meta);
   ```

2. **On replay, cached result is returned immediately** (`step.ts` lines 130-134):
   ```typescript
   const cached = yield* stepCtx.getResult<A>();
   if (cached !== undefined) {
     // Step already completed - return cached result (no event needed)
     return cached.value;
   }
   ```

3. **Attempt counter is NEVER read again** - the step skips all execution logic

## Is resetAttempt() Ever Needed?

### Scenario Analysis

| Scenario | Does resetAttempt() matter? |
|----------|---------------------------|
| Step succeeds on attempt 1 | No - resets 1→1, no change |
| Step succeeds on attempt N | **Harmful** - causes bug |
| Same step runs again (replay) | No - returns cached result, never reads attempt |
| Different step runs | No - different storage namespace |
| Different workflow instance | No - different DO, different storage |
| Workflow re-runs from scratch | No - new storage, starts at attempt 1 |

### Questions Explored

**Q: Is the attempt counter shared between steps?**
A: No. Each step has `step:${stepName}:attempt` - completely isolated.

**Q: Is the attempt counter read after success?**
A: No. Once `setResult()` is called, future executions return cached result at line 131.

**Q: Could there be a scenario where we need to reset?**
A: No. The only thing that uses the attempt counter is the retry operator, and once success happens, the step is complete forever (cached).

**Q: What if someone re-uses step names?**
A: Same step name in same workflow instance = returns cached result. Same step name in different workflow instance = different DO storage.

## Why Might resetAttempt() Have Been Added?

Possible reasons (all invalid):

1. **Defensive cleanup** - "Clean up state after success"
   - Invalid: The attempt counter is harmless after success, never read again

2. **Future-proofing** - "In case we need to re-run steps"
   - Invalid: Cached results prevent re-execution by design

3. **Copy-paste from non-durable retry patterns** - Traditional retry patterns reset counters
   - Invalid: Durable retry is fundamentally different - state persists across executions

4. **Misunderstanding scope** - Thought attempt counter was shared
   - Invalid: Each step has isolated storage namespace

## Recommendation

**Remove `resetAttempt()` entirely.**

### Changes Required

**File:** `packages/workflow/src/primitives/retry.ts`

```typescript
// BEFORE (lines 243-247)
if (result.success) {
  // Success! Reset attempt counter and return
  yield* stepCtx.resetAttempt();
  return result.value;
}

// AFTER
if (result.success) {
  // Success! Return value
  // Note: Don't reset attempt counter - it's needed for step.completed event
  return result.value;
}
```

### Why NOT Remove resetAttempt from StepContext?

Keep `resetAttempt()` in the `StepContext` interface because:
1. It might be useful for testing
2. It's part of the public API (breaking change to remove)
3. The fix only requires removing the CALL, not the capability

### Test Impact

The existing test in `step-context.test.ts` lines 77-97 tests `resetAttempt()` in isolation. This test can remain - it validates the function works, even if we don't use it in production code.

## Fix Verification

After removing `resetAttempt()`:

| Attempt | Before Fix | After Fix |
|---------|-----------|-----------|
| step.started attempt: 1 | ✓ | ✓ |
| retry.scheduled attempt: 1 | ✓ | ✓ |
| step.started attempt: 2 | ✓ | ✓ |
| retry.scheduled attempt: 2 | ✓ | ✓ |
| step.started attempt: 3 | ✓ | ✓ |
| step.completed attempt: 1 | ✗ (BUG) | ✓ (attempt: 3) |

## Alternative Fixes Considered

### Alternative 1: Use currentAttempt in step.ts

Change `step.ts` line 214 to use `currentAttempt` (captured before effect execution) instead of reading `stepCtx.attempt` again.

```typescript
// Use already-captured value
const attempt = currentAttempt;
```

**Pros:** Minimal change, doesn't modify retry.ts
**Cons:** Leaves unnecessary resetAttempt() call, wastes a storage write

### Alternative 2: Remove resetAttempt() call (Recommended)

Remove the `resetAttempt()` call in retry.ts.

**Pros:** Removes unnecessary code, saves storage write, fixes root cause
**Cons:** None identified

## Conclusion

`resetAttempt()` in `retry.ts` line 245:
- **Purpose:** None - the attempt counter serves no purpose after step completion
- **Effect:** Harmful - causes step.completed to have wrong attempt number
- **Action:** Remove the call

This is a clear case of unnecessary code that introduces a bug. The simplest fix is to delete the offending line.
