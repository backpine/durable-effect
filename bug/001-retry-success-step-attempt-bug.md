# Bug 001: step.completed Event Has Wrong Attempt Number After Retry Success

## Summary

When a step succeeds after multiple retry attempts, the `step.completed` event incorrectly reports `attempt: 1` instead of the actual successful attempt number.

## Symptoms

- Step succeeds on attempt 4
- `step.completed` event has `attempt: 1`
- UI shows wrong attempt as successful (attempt 1 shows green checkmark, attempt 4 shows blank)

## Event Timeline Example

```
step.started    attempt: 1  ← First attempt starts
retry.scheduled attempt: 1  ← First attempt fails
step.started    attempt: 2  ← Second attempt starts
retry.scheduled attempt: 2  ← Second attempt fails
step.started    attempt: 3  ← Third attempt starts
retry.scheduled attempt: 3  ← Third attempt fails
step.started    attempt: 4  ← Fourth attempt starts
step.completed  attempt: 1  ← SUCCESS but wrong attempt! Should be 4
```

## Root Cause

The bug is in the interaction between `retry.ts` and `step.ts`.

### Code Flow

**In `step.ts` (lines 139-152):**
```typescript
const now = yield* runtime.now();
const startedAt = yield* stepCtx.startedAt;
const currentAttempt = yield* stepCtx.attempt;  // ← Captures attempt BEFORE effect
// ...
// Emit step.started event
yield* emitEvent({
  // ...
  attempt: currentAttempt,  // ← Correct here
});
```

**In `retry.ts` (lines 243-246):**
```typescript
if (result.success) {
  // Success! Reset attempt counter and return
  yield* stepCtx.resetAttempt();  // ← RESETS ATTEMPT TO 1!
  return result.value;
}
```

**Back in `step.ts` (lines 213-237):**
```typescript
const completedAt = yield* runtime.now();
const attempt = yield* stepCtx.attempt;  // ← Reads AFTER resetAttempt() → returns 1!
// ...
yield* emitEvent({
  // ...
  type: "step.completed",
  attempt,  // ← WRONG! This is 1, not the actual attempt
});
```

### The Problem

1. `step.ts` captures `currentAttempt = 4` before executing the effect
2. Effect (with retry) executes and succeeds on attempt 4
3. `retry.ts` calls `stepCtx.resetAttempt()` → storage now has `attempt = 1`
4. Control returns to `step.ts`
5. `step.ts` reads `stepCtx.attempt` AGAIN → gets `1` (wrong!)
6. `step.completed` event emitted with `attempt: 1`

## Fix

### Option 1: Use Already-Captured Attempt (Simplest)

`step.ts` already captures `currentAttempt` at line 141 before executing the effect. Use that instead of reading again.

**File:** `packages/workflow/src/primitives/step.ts`

**Before (line 214):**
```typescript
const attempt = yield* stepCtx.attempt;
```

**After:**
```typescript
// Use currentAttempt captured before effect execution
// (stepCtx.attempt may have been reset by retry operator)
const attempt = currentAttempt;
```

### Option 2: Don't Reset Attempt on Retry Success

Remove the `resetAttempt()` call in retry.ts since the attempt counter is step-scoped and doesn't affect other steps.

**File:** `packages/workflow/src/primitives/retry.ts`

**Before (lines 243-246):**
```typescript
if (result.success) {
  // Success! Reset attempt counter and return
  yield* stepCtx.resetAttempt();
  return result.value;
}
```

**After:**
```typescript
if (result.success) {
  // Success! Return value
  // Note: Don't reset attempt - it's used by step.completed event
  return result.value;
}
```

### Recommendation

**Use Option 1** - it's the minimal, safest change:
- Only changes one line in `step.ts`
- `currentAttempt` is already captured and correct
- Doesn't change retry behavior
- Easy to reason about

Option 2 is also valid but requires understanding why `resetAttempt` was there in the first place (it appears to be unnecessary since each step has its own attempt counter in storage).

## Files to Modify

- `packages/workflow/src/primitives/step.ts` (line 214)

## Test Case

```typescript
it("should emit correct attempt number on retry success", async () => {
  const events: any[] = [];

  let attempts = 0;
  const result = await runWorkflow(
    Effect.gen(function* () {
      return yield* step(
        "flaky",
        Effect.gen(function* () {
          attempts++;
          if (attempts < 3) {
            return yield* Effect.fail(new Error("fail"));
          }
          return "success";
        }).pipe(retry({ maxAttempts: 5, delay: 0 }))
      );
    }),
    { onEvent: (e) => events.push(e) }
  );

  const completed = events.find(e => e.type === "step.completed");
  expect(completed.attempt).toBe(3);  // Should be 3, not 1
});
```

## Impact

- **Severity:** Medium
- **Affected:** All workflows using `Workflow.retry()`
- **User Impact:** Incorrect attempt shown in monitoring UI
