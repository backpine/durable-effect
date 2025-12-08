# Fix: Retry Attempt Counter Off-by-One Bug

## Problem Statement

When workflow emits retry-related events, the attempt numbers are off by one after the first retry:

- First execution: `step.started` shows attempt=1 ✅
- First failure → retry scheduled with attempt=1 ✅
- **Second execution (after retry): `step.started` STILL shows attempt=1 ❌ (should be 2)**
- **Second failure → retry scheduled STILL shows attempt=1 ❌ (should be 2)**
- Third execution: `step.started` shows attempt=2 ❌ (should be 3)

## Root Cause Analysis

The bug is in `packages/workflow/src/context/step-context.ts` - a semantic mismatch between how `attempt` and `incrementAttempt()` handle the "no value in storage" case.

### Current Code (step-context.ts:156-167)

```typescript
// Reading current attempt - defaults to 1 if nothing stored
attempt: storage
  .get<number>(KEYS.attempt(stepName))
  .pipe(Effect.map((a) => a ?? 1)),  // ← defaults to 1

// Incrementing attempt - defaults to 0 if nothing stored
incrementAttempt: () =>
  Effect.gen(function* () {
    const current =
      (yield* storage.get<number>(KEYS.attempt(stepName))) ?? 0;  // ← defaults to 0!
    const next = current + 1;
    yield* storage.put(KEYS.attempt(stepName), next);
    return next;
  }),
```

### The Problem Flow

1. **First execution** (no prior state):
   - `stepCtx.attempt` → storage empty → returns `1` ✅
   - Step fails
   - `incrementAttempt()` → storage empty → `0 + 1 = 1` → **stores 1**

2. **Second execution** (after retry):
   - `stepCtx.attempt` → storage has `1` → returns `1` ❌ **Should be 2!**
   - Events emit with attempt=1 ❌
   - Step fails again
   - `incrementAttempt()` → storage has `1` → `1 + 1 = 2` → **stores 2**

3. **Third execution**:
   - `stepCtx.attempt` → storage has `2` → returns `2` ❌ **Should be 3!**

### The Fix

Change `incrementAttempt()` to default to `1` instead of `0`:

```typescript
incrementAttempt: () =>
  Effect.gen(function* () {
    const current =
      (yield* storage.get<number>(KEYS.attempt(stepName))) ?? 1;  // ← Changed from 0 to 1
    const next = current + 1;
    yield* storage.put(KEYS.attempt(stepName), next);
    return next;
  }),
```

### Fixed Flow

1. **First execution**:
   - `stepCtx.attempt` → storage empty → returns `1` ✅
   - Step fails
   - `incrementAttempt()` → storage empty → `1 + 1 = 2` → **stores 2**

2. **Second execution**:
   - `stepCtx.attempt` → storage has `2` → returns `2` ✅
   - Events correctly emit with attempt=2 ✅
   - Step fails again
   - `incrementAttempt()` → storage has `2` → `2 + 1 = 3` → **stores 3**

3. **Third execution**:
   - `stepCtx.attempt` → storage has `3` → returns `3` ✅

## Impact on Retry Logic

### Does this break maxAttempts checks? NO

Looking at `retry.ts`:

```typescript
// Line 214: Check if we've exceeded max attempts
if (attempt > maxAttempts + 1) { ... }

// Line 250: Check if we've exhausted retries
if (attempt > maxAttempts) { ... }
```

With `maxAttempts: 3`:
- Attempt 1: First try (passes both checks)
- Attempt 2: After 1st failure (passes both checks)
- Attempt 3: After 2nd failure (passes both checks)
- Attempt 4: After 3rd failure → `4 > 3` triggers exhaustion ✅

The retry exhaustion logic is correct and unchanged. The fix only affects when the storage value is incremented - it now correctly represents "the NEXT attempt number" after a failure.

### Does this break PauseSignal? NO

Looking at `retry.ts:290`:
```typescript
return yield* Effect.fail(
  PauseSignal.retry(resumeAt, stepCtx.stepName, attempt + 1)
);
```

This already adds 1 to the current attempt when creating the signal. After the fix:
- First failure: attempt=1, signal carries 2 ✅
- Second failure: attempt=2, signal carries 3 ✅

No change needed here.

## Files to Change

### 1. `packages/workflow/src/context/step-context.ts`

**Change at line 163:**
```diff
 incrementAttempt: () =>
   Effect.gen(function* () {
     const current =
-      (yield* storage.get<number>(KEYS.attempt(stepName))) ?? 0;
+      (yield* storage.get<number>(KEYS.attempt(stepName))) ?? 1;
     const next = current + 1;
     yield* storage.put(KEYS.attempt(stepName), next);
     return next;
   }),
```

### 2. `packages/workflow/test/context/step-context.test.ts`

**Update test at lines 60-72:**
```diff
 it("should increment attempts", async () => {
   const result = await runWithStep(
     "myStep",
     Effect.gen(function* () {
       const ctx = yield* StepContext;
       const a1 = yield* ctx.incrementAttempt();
       const a2 = yield* ctx.incrementAttempt();
       const a3 = yield* ctx.incrementAttempt();
       return { a1, a2, a3 };
     })
   );

-  expect(result).toEqual({ a1: 1, a2: 2, a3: 3 });
+  // incrementAttempt moves from current attempt (default 1) to next
+  // So first call: 1 → 2, second: 2 → 3, third: 3 → 4
+  expect(result).toEqual({ a1: 2, a2: 3, a3: 4 });
 });
```

## Testing Plan

1. Run existing tests to see what breaks:
   ```bash
   pnpm test:all
   ```

2. After the fix, verify:
   - `step-context.test.ts` - updated test passes
   - `retry.test.ts` - all retry tests still pass
   - `step.test.ts` - all step tests still pass
   - `orchestrator.test.ts` - integration tests pass

3. Manual verification: Create a test workflow that retries and inspect emitted events to confirm attempt numbers are correct.

## Risk Assessment

**Low Risk** - This is a surgical one-line fix with clear semantics:

1. Only one line of production code changes
2. The change aligns `incrementAttempt()` with `attempt`'s default behavior
3. Retry exhaustion logic uses the `attempt` value, not the return value of `incrementAttempt()`
4. The fix makes the storage value correctly represent "what attempt we're on after increment"

## Alternative Considered

**Initialize attempt=1 in storage at step start:**

```typescript
// In step.ts before reading attempt
const existingAttempt = yield* storage.get<number>(KEYS.attempt(stepName));
if (existingAttempt === undefined) {
  yield* storage.put(KEYS.attempt(stepName), 1);
}
```

Rejected because:
- More invasive (changes step.ts)
- Adds extra storage operation on every step start
- The simpler fix in `incrementAttempt` is more elegant
