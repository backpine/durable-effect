# Report 034: Step Failure Tracking Gaps

## Problem Statement

Intermittently, step-level failures result in:
- A `workflow.failed` event with an opaque `UnknownException: An unknown error occurred`
- **No `step.failed` event** being emitted
- No step context (stepName, attempt) in the workflow failure details

This makes debugging production issues extremely difficult.

## Root Cause Analysis

The `Workflow.step()` function (workflow.ts:103-263) has **multiple code paths where errors can occur outside the Effect.either boundary**, meaning they bypass the step failure tracking logic.

### Step Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│  BEFORE Effect.either (errors = UnknownException, no step.failed)      │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Check cancellation flag (storage.get)                    Line 121  │
│  2. Load cancel reason (storage.get)                         Line 125  │
│  3. Load step attempt count (loadStepAttempt)                Line 137  │
│  4. Create step context                                      Line 138  │
│  5. Check if step already completed (hasCompleted)           Line 141  │
│  6. Get cached result (stepCtx.getResult)                    Line 143  │
│  7. Record start time (stepCtx.recordStartTime)              Line 162  │
│  8. Emit step.started event                                  Line 166  │
├─────────────────────────────────────────────────────────────────────────┤
│  INSIDE Effect.either (errors caught and handled properly)             │
├─────────────────────────────────────────────────────────────────────────┤
│  9. Execute user effect                                      Line 177  │
├─────────────────────────────────────────────────────────────────────────┤
│  AFTER Effect.either success (errors = incomplete step state)          │
├─────────────────────────────────────────────────────────────────────────┤
│  10. Cache result (stepCtx.setResult) - HAS step.failed!    Line 184  │
│  11. Mark step completed (markStepCompleted)                 Line 217  │
│  12. Emit step.completed event                               Line 220  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Gap 1: Pre-Execution Storage Failures

**Location**: workflow.ts lines 121-171

If any storage operation fails before the user's effect runs:

```typescript
// These can all throw UnknownException without step.failed
const cancelled = yield* Effect.promise(() => storage.get<boolean>("workflow:cancelled"));
const attempt = yield* loadStepAttempt(name, storage);
yield* stepCtx.recordStartTime;
yield* emitEvent({ type: "step.started", ... });
```

**Symptoms**:
- `step.started` may or may not be emitted (depends on where failure occurs)
- No `step.failed` event
- `workflow.failed` with no stepName context

### Gap 2: Post-Success Storage Failures

**Location**: workflow.ts lines 217-227

After the user's effect succeeds and result is cached:

```typescript
// If this fails after setResult succeeds:
yield* markStepCompleted(name, storage);  // Can throw UnknownException

// This also runs after:
yield* emitEvent({ type: "step.completed", ... });
```

**Symptoms**:
- Step effect succeeded
- Result is cached (will replay on resume)
- Step not marked as completed in the list
- `step.completed` may not be emitted
- Workflow fails with UnknownException

### Gap 3: Retry Operator Infrastructure Failures

**Location**: workflow.ts lines 325-444

The retry operator has its own storage and alarm operations:

```typescript
// Line 343-354: getMeta/setMeta for retry start time
yield* stepCtx.getMeta<number>(retryStartKey);
yield* stepCtx.setMeta(retryStartKey, retryStartTime);

// Line 423: setAlarm for retry
yield* ctx.setAlarm(resumeAt);

// Line 426-434: emitEvent
yield* emitEvent({ type: "retry.scheduled", ... });
```

**Symptoms**:
- Retry logic fails before/after step execution
- No step.failed event (retry is framework infrastructure)
- Workflow pauses indefinitely or fails with UnknownException

### Gap 4: Timeout Operator Infrastructure Failures

**Location**: workflow.ts lines 457-548

Similar issues in timeout operator:

```typescript
// Line 473-481: deadline storage
const existingDeadline = yield* stepCtx.deadline;
yield* stepCtx.setMeta("deadline", deadline);

// Line 484-494: emitEvent for timeout.set
yield* emitEvent({ type: "timeout.set", ... });
```

## Why handleWorkflowResult Doesn't Help

The `handleWorkflowResult` function (engine.ts:593-712) attempts to extract step context from errors:

```typescript
// Lines 688-689
const stepName = error instanceof StepError ? error.stepName : undefined;
const attempt = error instanceof StepError ? error.attempt : undefined;
```

**Problem**: This only works if the error is a `StepError`. All the infrastructure failures throw `UnknownException`, which has no step context attached.

## Specific Failure Scenarios

### Scenario 1: Transient Storage Error During Step Setup

```
1. Workflow resumes
2. Step "ProcessPayment" starts
3. storage.get("workflow:cancelled") → transient error after 3 retries
4. UnknownException thrown
5. workflow.failed emitted with { error: { message: "Storage get failed" } }
6. No step.failed, no stepName in error
```

### Scenario 2: Storage Error After Step Success

```
1. Step "SendEmail" effect runs successfully
2. setResult(result) → succeeds
3. markStepCompleted("SendEmail") → storage.put fails
4. UnknownException thrown
5. workflow.failed emitted with generic error
6. On resume: Step replays from cache (good)
7. But: We have no record of what happened (bad)
```

### Scenario 3: Alarm Setting Failure in Retry

```
1. Step "FetchAPI" fails (retryable)
2. Retry logic calculates next attempt time
3. ctx.setAlarm(resumeAt) → fails (hypothetical)
4. UnknownException thrown
5. workflow.failed with no step context
6. Retry was scheduled but never triggers
```

## Proposed Solutions

### Solution 1: Wrap Entire Step in Error Context

Add a step context wrapper that catches ALL errors and enriches them with step information:

```typescript
export function step<T, E, R>(
  name: string,
  effect: Effect.Effect<T, E, ForbidWorkflowScope<R>>,
): Effect.Effect<...> {
  return Effect.gen(function* () {
    // All existing logic...
  }).pipe(
    // NEW: Catch all errors and wrap with step context
    Effect.catchAllDefect((defect) =>
      Effect.fail(new StepError({
        stepName: name,
        cause: defect,
        attempt: 0, // May not have loaded yet
      }))
    ),
    Effect.catchAll((error) => {
      // If already a StepError, propagate
      if (error instanceof StepError) {
        return Effect.fail(error);
      }
      // Wrap other errors with step context
      return Effect.fail(new StepError({
        stepName: name,
        cause: error,
        attempt: 0,
      }));
    })
  );
}
```

**Pros**:
- All step errors have step context
- handleWorkflowResult can extract stepName reliably

**Cons**:
- Requires loading attempt before catching (chicken-and-egg)
- May double-wrap errors

### Solution 2: Emit step.failed on All Exit Paths

Add a guarantee that step.failed is emitted whenever a step doesn't complete successfully:

```typescript
export function step<T, E, R>(
  name: string,
  effect: Effect.Effect<T, E, ForbidWorkflowScope<R>>,
): Effect.Effect<...> {
  return Effect.gen(function* () {
    const workflowCtx = yield* WorkflowContext;
    let stepStarted = false;
    let attempt = 0;

    try {
      // Load attempt early
      attempt = yield* loadStepAttempt(name, storage).pipe(
        Effect.orElseSucceed(() => 0)
      );

      // ... existing logic ...
      stepStarted = true;

      // ... execute effect ...

    } catch (error) {
      // Emit step.failed if we got past step setup
      if (stepStarted) {
        yield* emitEvent({
          ...createBaseEvent(workflowCtx.workflowId, workflowCtx.workflowName),
          type: "step.failed",
          stepName: name,
          attempt,
          error: { message: error instanceof Error ? error.message : String(error) },
          willRetry: false,
        }).pipe(Effect.ignore);
      }
      throw error;
    }
  });
}
```

**Problem**: This approach doesn't work well with Effect's functional error handling. Need Effect-native approach.

### Solution 3: Effect.ensuring + Error Tracking Ref

Use Effect.ensuring to guarantee cleanup:

```typescript
export function step<T, E, R>(
  name: string,
  effect: Effect.Effect<T, E, ForbidWorkflowScope<R>>,
): Effect.Effect<...> {
  return Effect.gen(function* () {
    const workflowCtx = yield* WorkflowContext;
    const stepStateRef = yield* Ref.make<{
      started: boolean;
      completed: boolean;
      attempt: number;
    }>({ started: false, completed: false, attempt: 0 });

    return yield* Effect.gen(function* () {
      // ... setup logic ...

      yield* Ref.update(stepStateRef, (s) => ({ ...s, started: true, attempt }));

      // ... execute effect ...

      yield* Ref.update(stepStateRef, (s) => ({ ...s, completed: true }));

      return result;
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const state = yield* Ref.get(stepStateRef);
          if (state.started && !state.completed) {
            // Step started but didn't complete - emit step.failed
            yield* emitEvent({
              type: "step.failed",
              stepName: name,
              attempt: state.attempt,
              error: { message: "Step failed due to infrastructure error" },
              willRetry: false,
            }).pipe(Effect.ignore);
          }
        })
      )
    );
  });
}
```

**Pros**:
- Guarantees step.failed on any failure after step started
- Effect-native approach

**Cons**:
- Adds Ref overhead
- May emit step.failed for pause signals (need to filter)

### Solution 4: Structured Step Context Error Type

Create a new error type that all step infrastructure uses:

```typescript
// errors.ts
export class StepInfrastructureError extends Data.TaggedError("StepInfrastructureError")<{
  readonly stepName: string;
  readonly phase: "setup" | "execution" | "caching" | "cleanup";
  readonly cause: unknown;
  readonly attempt: number;
}> {}

// workflow.ts
function step<T, E, R>(name: string, effect: Effect.Effect<T, E, R>) {
  return Effect.gen(function* () {
    let currentPhase: "setup" | "execution" | "caching" | "cleanup" = "setup";
    let attempt = 0;

    const wrapInfraError = <A, E2>(eff: Effect.Effect<A, E2>) =>
      eff.pipe(
        Effect.mapError((e) => {
          if (e instanceof PauseSignal || e instanceof WorkflowCancelledError) {
            return e; // Don't wrap control flow signals
          }
          return new StepInfrastructureError({
            stepName: name,
            phase: currentPhase,
            cause: e,
            attempt,
          });
        })
      );

    // Setup phase
    attempt = yield* wrapInfraError(loadStepAttempt(name, storage));
    currentPhase = "execution";

    // ... rest of logic with wrapInfraError on infrastructure calls ...
  });
}
```

Then update `handleWorkflowResult` to recognize `StepInfrastructureError`:

```typescript
// engine.ts
const stepName =
  error instanceof StepError ? error.stepName :
  error instanceof StepInfrastructureError ? error.stepName :
  undefined;
```

**Pros**:
- Clear categorization of error types
- Preserves phase information for debugging
- Works with existing handleWorkflowResult

**Cons**:
- Requires wrapping all infrastructure calls
- Verbose

## Recommended Approach

**Combine Solutions 3 and 4**:

1. **StepInfrastructureError** for all infrastructure failures
2. **Effect.ensuring** to guarantee step.failed emission
3. **Filter out control flow signals** (PauseSignal, WorkflowCancelledError)

### Implementation Steps

1. Add `StepInfrastructureError` to errors.ts
2. Refactor step() to track phase and wrap infrastructure errors
3. Add Effect.ensuring to emit step.failed on unexpected exits
4. Update handleWorkflowResult to extract context from StepInfrastructureError
5. Add tests for each failure scenario

## Edge Cases to Consider

1. **What if emitEvent itself fails in the ensuring block?**
   - Use Effect.ignore to swallow emission failures
   - Log warning but don't prevent cleanup

2. **What about PauseSignal during setup?**
   - PauseSignal should only come from the user effect or retry logic
   - If it appears in setup, it's a bug

3. **What if attempt count can't be loaded?**
   - Default to 0
   - Include "unknown" flag in error

4. **Retry already in progress?**
   - Need to distinguish first attempt from retry
   - Check for existing step:${name}:attempt key

## Testing Strategy

1. **Unit tests for each failure point**:
   ```typescript
   test("emits step.failed when cancellation check fails", async () => {
     mockStorage.get.mockRejectedValue(new Error("Storage unavailable"));
     // ... assert step.failed emitted with correct stepName
   });
   ```

2. **Integration tests for recovery**:
   - Step fails during setup → resume → step should retry from beginning
   - Step fails after success → resume → step should return cached result

3. **Event ordering tests**:
   - Ensure step.failed always precedes workflow.failed when both occur
   - Ensure step.started + step.failed are always paired

## Implementation (Completed)

The following changes were implemented to address the gaps:

### 1. Added `StepInfrastructureError` (errors.ts:65-82)

New error type that wraps failures in step infrastructure operations:

```typescript
export class StepInfrastructureError extends Data.TaggedError(
  "StepInfrastructureError",
)<{
  readonly stepName: string;
  readonly phase: "setup" | "execution" | "caching" | "completion" | "cleanup";
  readonly cause: unknown;
  readonly attempt: number;
}> {
  get message(): string {
    return `Step "${this.stepName}" infrastructure failure during ${this.phase} (attempt ${this.attempt}): ${causeMessage}`;
  }
}
```

### 2. Refactored `step()` with State Tracking (workflow.ts:157-440)

Key changes:

1. **Added `StepState` interface** to track:
   - `phase`: Current execution phase (init, setup, started, executing, caching, completion, completed)
   - `attempt`: Current attempt number
   - `stepFailedEmitted`: Whether step.failed has been emitted

2. **Added `wrapInfraError` helper** that wraps ALL infrastructure operations with `StepInfrastructureError`:
   ```typescript
   const wrapInfraError = <A>(
     eff: Effect.Effect<A, unknown>,
     phase: StepInfrastructureError["phase"],
   ): Effect.Effect<A, StepInfrastructureError>
   ```

3. **Added `Effect.onExit`** handler as safety net for step.failed emission:
   - Only emits step.failed if:
     - Phase is past "started" (step.started was emitted)
     - Phase is not "completed" (step already finished)
     - step.failed wasn't already emitted
     - Error is not a control flow signal (PauseSignal, WorkflowCancelledError)

### 3. Updated `handleWorkflowResult` (engine.ts:688-702)

Now extracts step context from both `StepError` and `StepInfrastructureError`:

```typescript
const stepName =
  error instanceof StepError
    ? error.stepName
    : error instanceof StepInfrastructureError
      ? error.stepName
      : undefined;
```

### 4. Added Tests (test/step-infrastructure.test.ts)

New test file with 11 tests covering:
- StepInfrastructureError creation for setup/completion phase failures
- step.failed event emission via onExit when infrastructure fails after step.started
- NO step.failed emission when failure occurs before step.started
- Proper handling of cancellation (no step.failed emitted)
- Cache lookup failure handling

### 5. Enhanced MockStorage (test/mocks/storage.ts)

Added `simulateFailure()` method to test infrastructure failures:
```typescript
storage.simulateFailure({
  keys: ["step:TestStep:result"],
  operations: ["put"],
  error: new Error("Write failed"),
});
```

## Conclusion

**The implementation ensures that:**

1. **All step infrastructure errors have step context** (stepName, attempt, phase) via `StepInfrastructureError`
2. **step.failed events are guaranteed** via `Effect.onExit` when a step fails after starting
3. **handleWorkflowResult can extract step context** from both user errors (`StepError`) and infrastructure errors (`StepInfrastructureError`)
4. **Control flow signals are properly filtered** - PauseSignal and WorkflowCancelledError don't trigger step.failed

This makes debugging production issues much easier by ensuring every step failure is properly tracked with full context.
