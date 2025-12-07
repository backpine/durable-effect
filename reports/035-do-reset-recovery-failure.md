# DO Reset Recovery Failure Analysis

## Problem Statement

When a Durable Object (DO) is reset due to code deployment, running workflows stop and fail to recover. The Cloudflare logs show:

```
Durable Object reset because its code was updated
```

After this message, workflows that were in progress become permanently orphaned.

## Executive Summary

**Root Cause**: A race condition between alarm scheduling and status transitions, combined with the alarm handler ignoring "Running" status, causes workflows to become orphaned when a DO resets.

**Impact**: Any workflow that is actively executing (status = "Running") when a code deployment occurs will never recover, even if an alarm was set.

## Technical Analysis

### The DO Lifecycle During Reset

When Cloudflare deploys new code to a Durable Object:

1. The current isolate is terminated (all in-memory state lost)
2. A new isolate is created with the new code
3. The constructor is called
4. **Durable storage persists** (including workflow status and alarm)
5. **Scheduled alarms persist** (if any were set)

### Current Code Flow

#### Sleep/Pause Flow (`workflow.ts:786-806`)

```typescript
// 1. Write pendingResumeAt to storage
yield* workflowCtx.setPendingResumeAt(resumeAt);

// 2. Set alarm (survives DO reset)
yield* ctx.setAlarm(resumeAt);

// 3. Emit event (in-memory - LOST on reset)
yield* emitEvent({ type: "sleep.started", ... });

// 4. Throw PauseSignal to exit workflow
return yield* Effect.fail(new PauseSignal({ reason: "sleep", resumeAt }));
```

#### Pause Signal Handling (`engine.ts:626-644`)

```typescript
if (failureOption.value instanceof PauseSignal) {
  // 5. Update status to "Paused" (storage write)
  yield* transitionWorkflow(storage, ..., { _tag: "Pause", ... });
  return;
}
```

#### Alarm Handler (`engine.ts:328-335`)

```typescript
async alarm(): Promise<void> {
  const status = await storage.get<WorkflowStatus>("workflow:status");

  // CRITICAL: Only handles Queued or Paused
  if (status?._tag !== "Queued" && status?._tag !== "Paused") {
    return;  // Silent return for "Running" status!
  }
  // ... rest of recovery logic
}
```

### The Race Condition

```
Timeline during normal sleep:

  setPendingResumeAt()    setAlarm()        PauseSignal thrown    status → "Paused"
          │                   │                     │                    │
          ▼                   ▼                     ▼                    ▼
    ┌─────────────────────────────────────────────────────────────────────┐
    │                        Execution timeline                           │
    └─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │
                    DO RESET WINDOW

If DO resets here:
  - Alarm IS set ✓
  - Status is still "Running" ✗
```

**What happens after reset:**

1. DO restarts with new code
2. Constructor runs (does nothing)
3. Alarm fires at scheduled time
4. `alarm()` reads status: "Running"
5. Check: `status !== "Queued" && status !== "Paused"` → TRUE
6. Handler returns silently
7. **Workflow orphaned forever in "Running" state**

### Constructor Does No Recovery

```typescript
// engine.ts:222-224
constructor(state: DurableObjectState, env: unknown) {
  super(state, env as never);
  // No recovery logic!
}
```

Cloudflare Durable Objects support `blockConcurrencyWhile()` in the constructor for initialization logic. This could be used to detect and recover orphaned workflows, but it's not being used.

### Status Never Recovered

Even with a pending alarm, the alarm handler explicitly ignores "Running" status:

```typescript
// engine.ts:333-335
if (status?._tag !== "Queued" && status?._tag !== "Paused") {
  return;
}
```

This means:
- A workflow in "Running" state with a pending alarm → ignored
- A workflow in "Running" state without an alarm → orphaned forever

## Impact Analysis

| Scenario | Storage | Alarm | Recovery |
|----------|---------|-------|----------|
| Reset during step execution | Running | None | ❌ Never recovers |
| Reset during sleep (after setAlarm, before status update) | Running | Set | ❌ Alarm fires, ignored |
| Reset during sleep (after status update) | Paused | Set | ✓ Recovers normally |
| Reset while Queued | Queued | Set | ✓ Recovers normally |

## What's Lost on Reset

| State | Survives? | Notes |
|-------|-----------|-------|
| Workflow status | ✓ | Durable storage |
| Completed steps | ✓ | Durable storage |
| Step results (cached) | ✓ | Durable storage |
| Scheduled alarms | ✓ | DO alarm system |
| Pending resume time | ✓ | Durable storage |
| In-memory pause counter | ❌ | Resets to 0 |
| Event batch queue | ❌ | Ref discarded |
| Active JS execution | ❌ | Isolate terminated |

## Recommended Fixes

### Fix 1: Handle "Running" Status in Alarm Handler (Critical)

The alarm handler should treat "Running" as a recoverable state:

```typescript
async alarm(): Promise<void> {
  const status = await storage.get<WorkflowStatus>("workflow:status");

  // Handle Running status - workflow was interrupted
  if (status?._tag === "Running") {
    // Check if there's pending work to resume
    const pendingResumeAt = await storage.get<number>("workflow:pendingResumeAt");
    if (pendingResumeAt !== undefined) {
      // Had a pending sleep/retry - treat as Paused
      await this.#executeWorkflow(
        workflowDef,
        meta.input,
        workflowId,
        meta.workflowName,
        { _tag: "Resume" },
        meta.executionId,
      );
      return;
    }

    // No pending resume - workflow was mid-execution
    // Option A: Re-execute from start (idempotent steps will skip)
    // Option B: Mark as failed with "interrupted" error
    // Option C: Set alarm to retry later (backoff)
  }

  // Existing logic for Queued/Paused...
}
```

### Fix 2: Add Recovery in Constructor

Use `blockConcurrencyWhile` to check for orphaned workflows:

```typescript
constructor(state: DurableObjectState, env: unknown) {
  super(state, env as never);

  state.blockConcurrencyWhile(async () => {
    const status = await state.storage.get<WorkflowStatus>("workflow:status");

    // Check for stale "Running" status (likely interrupted)
    if (status?._tag === "Running") {
      const runningAt = await state.storage.get<number>("workflow:runningAt");
      const staleDuration = Date.now() - (runningAt ?? 0);

      // If running for too long, schedule recovery
      if (staleDuration > STALE_THRESHOLD_MS) {
        await state.storage.setAlarm(Date.now() + 100); // Trigger alarm soon
      }
    }
  });
}
```

### Fix 3: Atomic Status Transition Before Alarm

Change the order so status is updated before the alarm is set:

```typescript
// In sleep():
// First: Transition to Paused
yield* workflowCtx.setStatus({ _tag: "Paused", resumeAt });

// Then: Set alarm
yield* ctx.setAlarm(resumeAt);

// Then: Emit event
yield* emitEvent({ ... });
```

This requires refactoring to separate the status transition from the `handleWorkflowResult` function.

### Fix 4: Store "Running Since" Timestamp

Track when a workflow entered "Running" state:

```typescript
// In transitionWorkflow, for Start and Resume:
case "Start":
case "Resume":
  yield* setWorkflowStatus(storage, { _tag: "Running" });
  yield* storagePut(storage, "workflow:runningAt", Date.now());
  // ...
```

This enables detection of stale workflows (running too long = likely crashed).

### Fix 5: Add Watchdog Alarm

Set a "watchdog" alarm when entering Running state:

```typescript
// When transitioning to Running:
const maxExecutionTime = 30_000; // 30 seconds
await storage.setAlarm(Date.now() + maxExecutionTime);

// In alarm handler:
if (status?._tag === "Running") {
  // Watchdog triggered - execution took too long
  // Either: recover, fail, or extend watchdog
}
```

## Recommended Implementation Order

1. **Fix 1** (Critical): Handle "Running" in alarm handler - immediate fix for the race condition
2. **Fix 4**: Store "runningAt" timestamp - enables detecting stale workflows
3. **Fix 2**: Constructor recovery - handles cases without pending alarms
4. **Fix 5**: Watchdog alarm - proactive detection of stuck workflows
5. **Fix 3**: Atomic status transition - prevents the race entirely (larger refactor)

## Testing Considerations

To test DO reset recovery:

1. Start a workflow with a long-running step
2. Trigger a DO reset (deploy new code)
3. Verify workflow recovers and completes

Mock testing approach:
```typescript
it("recovers workflow after DO reset during execution", async () => {
  // Start workflow
  await stub.run({ workflow: "longRunning", input: {} });

  // Simulate reset: clear in-memory state, call constructor again
  // Status should still be "Running" in storage

  // Trigger alarm (or constructor recovery)
  await stub.alarm();

  // Verify workflow completed or is back in progress
  const status = await stub.getStatus();
  expect(status?._tag).toMatch(/Completed|Running|Paused/);
});
```

## Conclusion

The root cause is a combination of:

1. **Race condition**: Alarm set before status updates to "Paused"
2. **Incomplete alarm handler**: Ignores "Running" status
3. **No constructor recovery**: Nothing detects orphaned workflows

The fix requires handling "Running" status in the alarm handler and optionally adding constructor-based recovery. These changes will ensure workflows survive code deployments without becoming permanently orphaned.
