# Analysis: `onRetryExhausted` Feature Implementation Status

## Executive Summary

**Status: PARTIALLY IMPLEMENTED - Feature exists but is NOT wired through to consumers**

The `onRetryExhausted` callback feature is implemented in the core execution layer (`JobExecutionService`) but is **completely unusable** because:
1. Job definition types do not expose the `onRetryExhausted` property
2. Job handlers do not pass the callback through from definitions to the execution service
3. No tests validate the feature
4. No examples demonstrate usage

---

## Feature Overview

### Purpose
The `onRetryExhausted` callback provides users with control over what happens when all retry attempts have been exhausted for a job execution. Without this callback, jobs are terminated (state purged) by default.

### Design Intent (from Report 056)
The feature was designed to:
- Give users a "last-ditch" opportunity to handle exhausted retries
- Provide typed error access (the actual error type `E` from the execute function)
- Allow three actions:
  1. **terminate()** - Cancel alarm, delete all storage
  2. **reschedule(delay)** - Reset retry count, try again later
  3. **Return without action** - Preserve state, job becomes "paused"

### Context Type Definition

```typescript
// From execution.ts lines 43-62
export interface OnRetryExhaustedContext<S> {
  readonly state: S | null;
  readonly instanceId: string;
  readonly jobName: string;
  readonly attempts: number;
  readonly totalDurationMs: number;
  readonly terminate: () => Effect.Effect<void, never, never>;
  readonly reschedule: (delay: Duration.DurationInput) => Effect.Effect<void, never, never>;
}
```

---

## Implementation Analysis

### What IS Implemented

#### 1. Core Execution Layer (`execution.ts`)
The `JobExecutionService` fully implements `onRetryExhausted` handling at lines 274-351:

```typescript
// From execution.ts - lines 290-339
if (error instanceof RetryExhaustedSignal) {
  retryExhausted = true;

  // Emit job.retryExhausted event
  const retryExhaustedEvent = emitEvent({...});

  // AGENT-LOOK comment is HERE (line 290)
  if (onRetryExhausted) {
    // User has handler - create context and call it
    const exhaustedCtx: OnRetryExhaustedContext<S> = {
      state: stateHolder.current,
      instanceId: runtime.instanceId,
      jobName,
      attempts: error.attempts,
      totalDurationMs: error.totalDurationMs,
      terminate: () => cleanup.terminate()...,
      reschedule: (delay) => Effect.gen(function* () { ... }),
    };
    return retryExhaustedEvent.pipe(
      Effect.zipRight(onRetryExhausted(error.lastError as E, exhaustedCtx))
    );
  }

  // No handler - default behavior: terminate
  return retryExhaustedEvent.pipe(
    Effect.zipRight(cleanup.terminate())
  );
}
```

#### 2. ExecuteOptions Type Definition

```typescript
// From execution.ts lines 64-88
export interface ExecuteOptions<S, E, R, Ctx> {
  // ... other properties
  readonly onRetryExhausted?: (
    error: E,
    ctx: OnRetryExhaustedContext<S>,
  ) => Effect.Effect<void, never, R>;
}
```

#### 3. RetryExhaustedSignal

```typescript
// From retry/errors.ts
export class RetryExhaustedSignal extends Data.TaggedError("RetryExhaustedSignal")<
  RetryExhaustedInfo & {
    readonly reason: "max_attempts_exceeded" | "max_duration_exceeded";
  }
> {}
```

### What is NOT Implemented (The Gap)

#### 1. Job Definition Types Missing `onRetryExhausted`

**File: `registry/types.ts`**

| Definition Type | Has `onRetryExhausted`? |
|-----------------|-------------------------|
| `UnregisteredContinuousDefinition` | NO |
| `UnregisteredDebounceDefinition` | NO |
| `UnregisteredTaskDefinition` | NO |
| `UnregisteredWorkerPoolDefinition` | NO |

Users cannot define `onRetryExhausted` on their job configurations because the types don't allow it.

#### 2. Handlers Don't Pass Callback Through

**ContinuousHandler (`handlers/continuous/handler.ts` lines 105-141):**
```typescript
const runExecution = (def, runCount, id?) =>
  execution.execute({
    jobType: "continuous",
    jobName: def.name,
    schema: def.stateSchema,
    retryConfig: def.retry,
    runCount,
    id,
    run: (ctx) => def.execute(ctx),
    createContext: (base) => { ... },
    // MISSING: onRetryExhausted: def.onRetryExhausted,
  });
```

**DebounceHandler (`handlers/debounce/handler.ts` lines 97-125):**
```typescript
const runFlush = (def, flushReason, id?) =>
  execution.execute({
    jobType: "debounce",
    jobName: def.name,
    schema: def.stateSchema,
    retryConfig: def.retry,
    runCount: 0,
    id,
    run: (ctx) => def.execute(ctx),
    createContext: (base) => { ... },
    // MISSING: onRetryExhausted: def.onRetryExhausted,
  });
```

**TaskHandler (`handlers/task/handler.ts` lines 149-155):**
```typescript
const runExecution = (def, runCount, triggerType, event?, id?) =>
  execution.execute({
    jobType: "task",
    jobName: def.name,
    schema: def.stateSchema,
    retryConfig: undefined,  // Note: Task doesn't even use retry!
    runCount,
    id,
    allowNullState: true,
    createContext: (base) => { ... },
    run: (metaCtx) => { ... },
    // MISSING: onRetryExhausted: def.onRetryExhausted,
  });
```

#### 3. No Test Coverage

```bash
# Search results in test directory
grep -r "onRetryExhausted\|RetryExhausted" packages/jobs/test/
# Result: No matches found
```

#### 4. No Example Usage

```bash
# Search results in examples directory
grep -r "onRetryExhausted" examples/
# Result: No matches found
```

---

## Code Flow Trace

### Current Flow (Broken)

```
User defines job:
  Continuous.make({
    retry: { maxAttempts: 3 },
    onRetryExhausted: (e, ctx) => { ... }  // TypeScript ERROR: Property doesn't exist
  })

  --> TypeScript prevents compilation because types don't include onRetryExhausted
```

### Intended Flow (Not Implemented)

```
1. User defines job with onRetryExhausted callback
   |
   v
2. Job definition stored in registry with callback
   |
   v
3. Handler retrieves definition
   |
   v
4. Handler passes def.onRetryExhausted to execution.execute()
   |
   v
5. ExecutionService catches RetryExhaustedSignal
   |
   v
6. ExecutionService calls onRetryExhausted(error, ctx)
   |
   v
7. User callback executes with typed error and action context
```

---

## Impact Assessment

### Severity: Medium-Low
- Feature is documented in design docs (Report 056)
- Core implementation exists and appears correct
- Default behavior (terminate on exhaustion) still works
- No users are currently using this feature (impossible to use)

### Risk
- If users expect this feature based on documentation, they cannot use it
- The partial implementation creates technical debt
- Comment at line 290 indicates this was known to be incomplete

---

## Recommendations

### Option 1: Complete the Implementation (Recommended if feature is wanted)

**Changes Required:**

1. **Update Job Definition Types** (`registry/types.ts`):
```typescript
export interface UnregisteredContinuousDefinition<S, E, R> {
  // ... existing
  onRetryExhausted?: (error: E, ctx: OnRetryExhaustedContext<S>) => Effect.Effect<void, never, R>;
}
// Same for Debounce and Task definitions
```

2. **Update Stored Definition Types** (`registry/types.ts`):
```typescript
export interface StoredContinuousDefinition<S, R> {
  // ... existing
  onRetryExhausted?: (error: unknown, ctx: OnRetryExhaustedContext<S>) => Effect.Effect<void, never, R>;
}
```

3. **Wire Through in Handlers** (all three handlers):
```typescript
const runExecution = (def, ...) =>
  execution.execute({
    // ... existing
    onRetryExhausted: def.onRetryExhausted,
  });
```

4. **Add Tests**:
- Test callback is invoked on retry exhaustion
- Test terminate() action works
- Test reschedule() action works
- Test no-action behavior (state preserved)

5. **Add Documentation/Examples**

**Effort Estimate:** ~1-2 days

### Option 2: Deprecate and Remove

If the feature is not needed:

1. Remove `onRetryExhausted` from `ExecuteOptions` in `execution.ts`
2. Remove `OnRetryExhaustedContext` type
3. Simplify retry exhaustion handling to always terminate
4. Update Report 056 to mark this as deprecated
5. Remove the AGENT-LOOK comment

**Effort Estimate:** ~2-4 hours

### Option 3: Document as Internal-Only

If the feature might be useful later:

1. Mark `onRetryExhausted` as `@internal` in JSDoc
2. Keep the implementation for potential future use
3. Add a comment explaining it's not wired to consumers yet
4. Create a tracking issue for future completion

**Effort Estimate:** ~30 minutes

---

## Files Involved

### Core Implementation (exists)
- `/packages/jobs/src/services/execution.ts` - Lines 41-62 (types), 274-351 (implementation)
- `/packages/jobs/src/retry/errors.ts` - `RetryExhaustedSignal` class
- `/packages/jobs/src/retry/types.ts` - Documentation references

### Types Needing Update (for Option 1)
- `/packages/jobs/src/registry/types.ts` - All job definition interfaces

### Handlers Needing Update (for Option 1)
- `/packages/jobs/src/handlers/continuous/handler.ts` - `runExecution` function
- `/packages/jobs/src/handlers/debounce/handler.ts` - `runFlush` function
- `/packages/jobs/src/handlers/task/handler.ts` - `runExecution` function

### Tests Needed (for Option 1)
- `/packages/jobs/test/handlers/continuous.test.ts`
- `/packages/jobs/test/handlers/debounce.test.ts`
- `/packages/jobs/test/services/execution.test.ts` (new file)

### Documentation
- `/reports/056-unified-termination-implementation-plan.md` - Original design

---

## Conclusion

The AGENT-LOOK comment at line 290 correctly identifies that `onRetryExhausted` is not wired to actual jobs. The feature was part of a larger unified termination plan (Report 056) that was only partially implemented.

**The core mechanism works correctly** - if `onRetryExhausted` were passed to `execution.execute()`, it would be called appropriately. The gap is purely in the "plumbing":
1. Types don't expose it to users
2. Handlers don't pass it through

**Recommendation:** If this feature provides value, complete the implementation (Option 1). The hardest part (the core execution logic) is already done. Otherwise, clean it up to reduce confusion (Option 2 or 3).
