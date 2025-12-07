# Infrastructure Failure Recovery Design

## Problem Statement

When Cloudflare deploys new code to a Durable Object (DO), the runtime terminates the current isolate and creates a new one. Workflows in "Running" status during this transition become permanently orphaned because:

1. The alarm handler only processes `Queued` and `Paused` statuses
2. No constructor-based recovery logic exists
3. No mechanism detects stale "Running" workflows

This document designs a comprehensive recovery system to ensure workflows survive infrastructure-level disruptions.

## Goals

1. **Zero orphaned workflows** - Any workflow interrupted by infrastructure should recover
2. **Idempotent recovery** - Multiple recovery attempts should be safe
3. **Minimal latency** - Recovery should happen quickly after restart
4. **Observable** - Recovery events should be trackable for monitoring
5. **Backwards compatible** - Existing workflows should continue working

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       DO Lifecycle with Recovery                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  [Code Deploy] ──► [Isolate Terminated] ──► [New Isolate Created]           │
│                           │                         │                        │
│                           ▼                         ▼                        │
│                  Storage Persists            Constructor Called              │
│                  - workflow:status           blockConcurrencyWhile {         │
│                  - workflow:runningAt          checkForOrphanedWorkflow()    │
│                  - workflow:*                  scheduleRecoveryIfNeeded()    │
│                                              }                               │
│                                                     │                        │
│                                                     ▼                        │
│                                              [Alarm Fires]                   │
│                                                     │                        │
│                                                     ▼                        │
│                                         handleRecovery(status) {             │
│                                           if Running + stale → recover       │
│                                           if Queued → start                  │
│                                           if Paused → resume                 │
│                                         }                                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Storage Schema Additions

### New Storage Keys

| Key | Type | Description |
|-----|------|-------------|
| `workflow:runningAt` | `number` | Timestamp when workflow entered Running state |
| `workflow:lastHeartbeat` | `number` | Last heartbeat timestamp (optional future enhancement) |
| `workflow:recoveryAttempts` | `number` | Number of recovery attempts for this workflow |
| `workflow:maxRecoveryAttempts` | `number` | Max recovery attempts before failing (default: 3) |

### Updated Status Type

```typescript
export type WorkflowStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Queued"; readonly queuedAt: number }
  | {
      readonly _tag: "Running";
      readonly runningAt?: number;  // NEW: when execution started
    }
  | {
      readonly _tag: "Paused";
      readonly reason: string;
      readonly resumeAt: number;
    }
  | { readonly _tag: "Completed"; readonly completedAt: number }
  | {
      readonly _tag: "Failed";
      readonly error: unknown;
      readonly failedAt: number;
    }
  | {
      readonly _tag: "Cancelled";
      readonly cancelledAt: number;
      readonly reason?: string;
    };
```

## Implementation Design

### 1. Constructor Recovery Logic

The constructor should use `blockConcurrencyWhile` to check for and schedule recovery of orphaned workflows:

```typescript
// engine.ts - Updated constructor
constructor(state: DurableObjectState, env: unknown) {
  super(state, env as never);

  state.blockConcurrencyWhile(async () => {
    const storage = state.storage;
    const status = await storage.get<WorkflowStatus>("workflow:status");

    // No workflow - nothing to recover
    if (!status) return;

    // Only Running status needs recovery check
    if (status._tag !== "Running") return;

    const runningAt = await storage.get<number>("workflow:runningAt");
    const now = Date.now();

    // Calculate staleness
    // If runningAt is missing, assume it's stale (legacy workflow)
    const staleDuration = runningAt ? now - runningAt : Infinity;

    // Threshold: workflow running longer than expected indicates interruption
    // Default to 30 seconds - most steps should complete within this time
    const STALE_THRESHOLD_MS = 30_000;

    if (staleDuration > STALE_THRESHOLD_MS) {
      console.log(
        `[Recovery] Detected stale Running workflow. ` +
        `Stale for ${staleDuration}ms. Scheduling recovery.`
      );

      // Schedule alarm to trigger recovery soon
      // Small delay to allow constructor to complete
      await storage.setAlarm(now + 100);
    }
  });
}
```

### 2. Transition Updates (Track runningAt)

Update `transitionWorkflow` to record when workflow enters Running state:

```typescript
// transitions.ts - Updated Start and Resume transitions
case "Start":
  yield* setWorkflowStatus(storage, { _tag: "Running" });
  yield* storagePut(storage, "workflow:runningAt", Date.now());  // NEW
  yield* emitEvent({ ...base, type: "workflow.started", input: t.input });
  break;

case "Resume":
  yield* setWorkflowStatus(storage, { _tag: "Running" });
  yield* storagePut(storage, "workflow:runningAt", Date.now());  // NEW
  yield* emitEvent({ ...base, type: "workflow.resumed" });
  break;
```

### 3. Enhanced Alarm Handler

The alarm handler should handle Running status as a recoverable state:

```typescript
// engine.ts - Updated alarm handler
async alarm(): Promise<void> {
  const storage = this.ctx.storage;
  const status = await storage.get<WorkflowStatus>("workflow:status");

  // Handle Running status - likely interrupted by infrastructure
  if (status?._tag === "Running") {
    return this.#handleRunningRecovery(storage, status);
  }

  // Existing Queued/Paused handling...
  if (status?._tag !== "Queued" && status?._tag !== "Paused") {
    return;
  }

  // ... rest of existing logic
}

async #handleRunningRecovery(
  storage: DurableObjectStorage,
  status: Extract<WorkflowStatus, { _tag: "Running" }>
): Promise<void> {
  const workflowId = this.ctx.id.toString();

  // Load workflow metadata
  const meta = await Effect.runPromise(loadWorkflowMeta(storage));

  if (!meta.workflowName) {
    console.error("[Recovery] Running workflow has no name - cannot recover");
    return;
  }

  const workflowName = meta.workflowName;
  const executionId = meta.executionId;

  // Check recovery attempts
  const recoveryAttempts = await storage.get<number>("workflow:recoveryAttempts") ?? 0;
  const maxRecoveryAttempts = await storage.get<number>("workflow:maxRecoveryAttempts") ?? 3;

  if (recoveryAttempts >= maxRecoveryAttempts) {
    console.error(
      `[Recovery] Max recovery attempts (${maxRecoveryAttempts}) exceeded for workflow ${workflowId}`
    );

    // Fail the workflow
    const completedSteps = await storage.get<string[]>("workflow:completedSteps") ?? [];
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* transitionWorkflow(
          storage,
          workflowId,
          workflowName,
          {
            _tag: "Fail",
            error: {
              message: `Workflow recovery failed after ${maxRecoveryAttempts} attempts`,
              stack: undefined,
            },
            completedSteps,
          },
          executionId,
        );
        yield* flushEvents;
      }).pipe(Effect.provide(this.#trackerLayer)),
    );

    await storage.deleteAll();
    return;
  }

  // Increment recovery attempts
  await storage.put("workflow:recoveryAttempts", recoveryAttempts + 1);

  console.log(
    `[Recovery] Attempting recovery for workflow ${workflowId}. ` +
    `Attempt ${recoveryAttempts + 1}/${maxRecoveryAttempts}`
  );

  // Emit recovery event
  await Effect.runPromise(
    emitEvent({
      ...createBaseEvent(workflowId, workflowName, executionId),
      type: "workflow.recovery",
      attempt: recoveryAttempts + 1,
      reason: "infrastructure_restart",
    }).pipe(Effect.provide(this.#trackerLayer)),
  );

  // Get workflow definition
  const workflowDef = this.#workflows[workflowName as keyof T];
  if (!workflowDef) {
    console.error(`[Recovery] Unknown workflow: ${workflowName}`);
    return;
  }

  // Determine recovery strategy based on workflow state
  const pendingResumeAt = await storage.get<number>("workflow:pendingResumeAt");

  if (pendingResumeAt !== undefined) {
    // Had a pending pause (sleep/retry) - treat as Resume
    console.log(`[Recovery] Resuming from pending pause at ${new Date(pendingResumeAt).toISOString()}`);
    await this.#executeWorkflow(
      workflowDef,
      meta.input,
      workflowId,
      workflowName,
      { _tag: "Resume" },
      executionId,
    );
  } else {
    // Mid-execution recovery - re-execute from start
    // Completed steps will be skipped (idempotent)
    console.log(`[Recovery] Re-executing workflow from start (completed steps will be skipped)`);
    await this.#executeWorkflow(
      workflowDef,
      meta.input,
      workflowId,
      workflowName,
      { _tag: "Resume" },  // Use Resume to skip re-emitting started event
      executionId,
    );
  }

  // Clear recovery attempts on successful execution
  await storage.delete("workflow:recoveryAttempts");
}
```

### 4. New Event Type for Recovery

Add a recovery event to the event types:

```typescript
// core/src/events.ts - Add new event type
export interface WorkflowRecoveryEvent extends BaseEvent {
  readonly type: "workflow.recovery";
  readonly attempt: number;
  readonly reason: "infrastructure_restart" | "stale_detection" | "manual";
}

// Update WorkflowEvent union
export type WorkflowEvent =
  | WorkflowStartedEvent
  | WorkflowQueuedEvent
  | WorkflowResumedEvent
  | WorkflowCompletedEvent
  | WorkflowPausedEvent
  | WorkflowFailedEvent
  | WorkflowCancelledEvent
  | WorkflowRecoveryEvent;  // NEW
```

### 5. Watchdog Alarm (Optional Enhancement)

For additional safety, set a watchdog alarm when entering Running state:

```typescript
// In transitions.ts - Add watchdog when starting
case "Start":
case "Resume": {
  yield* setWorkflowStatus(storage, { _tag: "Running" });
  yield* storagePut(storage, "workflow:runningAt", Date.now());

  // Set watchdog alarm - will fire if execution exceeds expected time
  // This catches cases where constructor recovery doesn't trigger
  const WATCHDOG_TIMEOUT_MS = 60_000; // 1 minute
  yield* Effect.promise(() =>
    storage.setAlarm(Date.now() + WATCHDOG_TIMEOUT_MS)
  );

  yield* emitEvent({ ... });
  break;
}
```

**Note**: The watchdog approach has a trade-off - it will reschedule the alarm even for successful executions that complete quickly. This needs careful consideration:

- **Option A**: Always set watchdog, clear on completion
- **Option B**: Only use constructor-based detection (simpler, less coverage)
- **Option C**: Set watchdog only for long-running workflows (requires config)

**Recommendation**: Start with Option B (constructor-based only) and add watchdog later if needed.

## State Diagram

```
                                    ┌─────────────────────────────────────────┐
                                    │                                         │
                                    │     Infrastructure Failure Recovery     │
                                    │                                         │
                                    └─────────────────────────────────────────┘

    ┌──────────┐                                                      ┌───────────┐
    │          │                                                      │           │
    │ Pending  │──────────────────────────────────────────────────────│ Completed │
    │          │                                                      │           │
    └────┬─────┘                                                      └───────────┘
         │                                                                  ▲
         │ run()                                                            │
         ▼                                                                  │
    ┌──────────┐          ┌──────────┐         ┌──────────┐                │
    │          │  alarm   │          │ success │          │────────────────┘
    │  Queued  │─────────►│ Running  │────────►│ Complete │
    │          │          │          │         │          │
    └──────────┘          └────┬─────┘         └──────────┘
                               │
                               │ infrastructure
                               │ failure
                               ▼
                          ┌──────────┐
                          │          │
                          │ Running  │◄─────────────────────┐
                          │ (stale)  │                      │
                          └────┬─────┘                      │
                               │                            │
                    ┌──────────┴──────────┐                 │
                    │                     │                 │
                    ▼                     ▼                 │
          constructor detects      alarm fires              │
          stale Running            (watchdog)               │
                    │                     │                 │
                    └──────────┬──────────┘                 │
                               │                            │
                               ▼                            │
                    ┌─────────────────────┐                 │
                    │                     │                 │
                    │  Recovery Handler   │                 │
                    │                     │                 │
                    └──────────┬──────────┘                 │
                               │                            │
              ┌────────────────┼────────────────┐           │
              │                │                │           │
              ▼                ▼                ▼           │
         pendingResumeAt   no pending      max attempts     │
         exists            resume          exceeded         │
              │                │                │           │
              ▼                ▼                ▼           │
         Resume from       Re-execute       Fail with       │
         pause point       (steps skip)     recovery error  │
              │                │                            │
              └────────────────┴────────────────────────────┘
                               │
                               ▼
                          [Running]
                               │
                               ▼
                    (normal execution continues)
```

## Implementation Order

### Phase 1: Core Recovery (Critical Path)

1. **Add `workflow:runningAt` tracking**
   - Update `transitionWorkflow` to record timestamp on Start/Resume
   - Low risk, additive change

2. **Add recovery handling in alarm()**
   - Handle `Running` status with recovery logic
   - Check `pendingResumeAt` for intelligent recovery
   - Add `workflow:recoveryAttempts` counter

3. **Add constructor recovery**
   - Use `blockConcurrencyWhile` to detect stale Running
   - Schedule immediate alarm for recovery

### Phase 2: Observability

4. **Add `workflow.recovery` event type**
   - Emit on recovery attempts
   - Include attempt count and reason

5. **Add recovery metrics**
   - Track recovery attempts per workflow
   - Track recovery success/failure rates

### Phase 3: Enhanced Safety (Optional)

6. **Add watchdog alarm**
   - Set alarm when entering Running state
   - Clear on successful completion
   - Provides additional coverage beyond constructor

7. **Configurable thresholds**
   - Allow per-workflow stale threshold
   - Allow per-workflow max recovery attempts

## Testing Strategy

### Unit Tests

```typescript
describe("Infrastructure Recovery", () => {
  it("detects stale Running workflow in constructor", async () => {
    // Setup: workflow in Running state with old runningAt
    await storage.put("workflow:status", { _tag: "Running" });
    await storage.put("workflow:runningAt", Date.now() - 60_000);
    await storage.put("workflow:name", "testWorkflow");

    // Create new DO instance (simulates restart)
    const do = new DurableWorkflowEngine(state, env);

    // Verify alarm was scheduled
    expect(await storage.getAlarm()).toBeDefined();
  });

  it("recovers Running workflow via alarm handler", async () => {
    // Setup: stale Running workflow with completed steps
    await storage.put("workflow:status", { _tag: "Running" });
    await storage.put("workflow:name", "testWorkflow");
    await storage.put("workflow:input", {});
    await storage.put("workflow:completedSteps", ["step1"]);

    // Trigger alarm
    await do.alarm();

    // Verify workflow continued (step1 skipped, step2 executed)
    const steps = await storage.get("workflow:completedSteps");
    expect(steps).toContain("step2");
  });

  it("fails after max recovery attempts", async () => {
    await storage.put("workflow:status", { _tag: "Running" });
    await storage.put("workflow:recoveryAttempts", 3);
    await storage.put("workflow:maxRecoveryAttempts", 3);

    await do.alarm();

    // Should be in Failed state
    const status = await storage.get("workflow:status");
    expect(status._tag).toBe("Failed");
  });

  it("resumes from pendingResumeAt if present", async () => {
    await storage.put("workflow:status", { _tag: "Running" });
    await storage.put("workflow:pendingResumeAt", Date.now() - 1000);

    await do.alarm();

    // Should resume from pause point
    // Verify by checking pendingResumeAt is cleared
    expect(await storage.get("workflow:pendingResumeAt")).toBeUndefined();
  });
});
```

### Integration Tests

```typescript
describe("Infrastructure Recovery Integration", () => {
  it("survives DO reset during step execution", async () => {
    // Start workflow with slow step
    const stub = env.WORKFLOWS.get(id);
    const runPromise = stub.run({ workflow: "slowWorkflow", input: {} });

    // Wait for workflow to enter Running
    await waitForStatus(stub, "Running");

    // Simulate DO reset by creating new stub
    // (In real test, trigger deployment)
    const newStub = env.WORKFLOWS.get(id);

    // Wait for recovery
    await eventually(async () => {
      const status = await newStub.getStatus();
      return status?._tag === "Completed";
    });
  });

  it("survives DO reset during sleep", async () => {
    const stub = env.WORKFLOWS.get(id);
    await stub.run({ workflow: "sleepingWorkflow", input: {} });

    // Should be Paused
    const status = await stub.getStatus();
    expect(status?._tag).toBe("Paused");

    // Reset and wait for alarm
    const newStub = env.WORKFLOWS.get(id);
    await advanceTime(10_000);
    await newStub.alarm();

    // Should complete
    expect((await newStub.getStatus())?._tag).toBe("Completed");
  });
});
```

## Migration Considerations

### Existing Workflows

Workflows in Running state before this change is deployed:
- Will have `runningAt` missing
- Constructor will treat missing `runningAt` as "definitely stale"
- Recovery will trigger immediately on next restart

This is **safe** because:
- If workflow was actually interrupted: recovery is correct
- If workflow is still running: re-execution will skip completed steps

### Rollback Plan

If issues arise:
1. Remove constructor recovery logic (safest rollback)
2. Keep alarm recovery (less aggressive)
3. Monitor `workflow.recovery` events for anomalies

## Monitoring & Alerting

### Key Metrics

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `workflow.recovery.triggered` | Recovery attempts | > 10/hour |
| `workflow.recovery.failed` | Recovery failures | Any |
| `workflow.recovery.max_attempts_exceeded` | Permanent failures | Any |
| `workflow.stale_duration_ms` | How long workflow was stale | > 5 minutes |

### Dashboard Queries

```sql
-- Recovery events by reason
SELECT
  reason,
  COUNT(*) as count,
  AVG(attempt) as avg_attempts
FROM workflow_events
WHERE type = 'workflow.recovery'
GROUP BY reason;

-- Workflows that required recovery
SELECT
  workflowId,
  workflowName,
  MAX(attempt) as total_recovery_attempts,
  MIN(timestamp) as first_recovery,
  MAX(timestamp) as last_recovery
FROM workflow_events
WHERE type = 'workflow.recovery'
GROUP BY workflowId, workflowName
ORDER BY total_recovery_attempts DESC;
```

## Security Considerations

1. **Denial of Service**: Max recovery attempts prevent infinite retry loops
2. **Data Integrity**: Idempotent steps ensure no duplicate side effects
3. **Audit Trail**: Recovery events provide forensic visibility

## Conclusion

This design provides a robust recovery system that:

1. **Detects** orphaned workflows via constructor and alarm-based checks
2. **Recovers** intelligently based on workflow state (pending pause vs mid-execution)
3. **Limits** recovery attempts to prevent infinite loops
4. **Observes** all recovery activity via events

The phased implementation approach allows incremental rollout with clear fallback options.
