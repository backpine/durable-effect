# State Management and Recovery Analysis: @packages/jobs

## Executive Summary

This report provides a deep analysis of state management, design patterns, and recovery logic in `@packages/jobs` (formerly primitives), with comparisons to the mature recovery system in `@packages/workflow`. The goal is to identify gaps and propose enhancements for production-ready resilience.

**Key Finding:** The jobs package lacks the sophisticated recovery mechanisms present in workflows. While the current design is functional, it's vulnerable to state loss and silent failures during infrastructure disruptions (deployments, crashes, DO hibernation).

---

## Table of Contents

1. [Current State Management Design](#1-current-state-management-design)
2. [Workflow Recovery System (Reference)](#2-workflow-recovery-system-reference)
3. [Jobs Package Gap Analysis](#3-jobs-package-gap-analysis)
4. [Failure Scenarios & Risks](#4-failure-scenarios--risks)
5. [Proposed Recovery Architecture](#5-proposed-recovery-architecture)
6. [Implementation Recommendations](#6-implementation-recommendations)
7. [Migration Path](#7-migration-path)

---

## 1. Current State Management Design

### 1.1 Storage Key Structure

All job state is stored via centralized keys in `storage-keys.ts`:

```typescript
KEYS = {
  META: "meta",                      // JobMetadata
  STATE: "state",                    // User state (schema-validated)

  CONTINUOUS: {
    RUN_COUNT: "cont:runCount",
    LAST_EXECUTED_AT: "cont:lastAt",
  },

  DEBOUNCE: {
    EVENT_COUNT: "deb:count",
    STARTED_AT: "deb:startedAt",
  },

  WORKER_POOL: {
    EVENTS: "wp:events:{eventId}",
    PENDING: "wp:pending",
    // ... etc
  },

  IDEMPOTENCY: "idem:{eventId}",
}
```

**Strengths:**
- Centralized, well-organized key namespace
- Clear separation between job types
- Idempotency support built-in

**Weaknesses:**
- No recovery-specific metadata (no `runningAt`, `recoveryAttempts`)
- No tracking of "in-progress" execution state
- Metadata status doesn't capture execution phase

### 1.2 Metadata Structure

```typescript
interface JobMetadata {
  readonly type: "continuous" | "debounce" | "workerPool";
  readonly name: string;
  readonly status: "initializing" | "running" | "stopped" | "terminated";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly stopReason?: string;
}
```

**Missing fields for recovery:**
- `executingAt?: number` - When current execution started
- `recoveryAttempts?: number` - How many times we've tried to recover
- `lastSuccessfulRunAt?: number` - Last known good state timestamp
- `executionId?: string` - Correlation ID for current execution

### 1.3 Execution Flow (Continuous)

```
1. START request received
2. Check if metadata exists (idempotent start)
3. Initialize metadata: status = "initializing"
4. Set initial user state
5. Initialize runCount = 0
6. Update status = "running"
7. If startImmediately:
   a. Increment runCount (PERSISTED)
   b. Execute user function (IN-MEMORY state mutations)
   c. Persist state if dirty
8. Schedule next alarm
9. Return response
```

**Critical observation:** Run count is incremented BEFORE execution, but state is persisted AFTER. This creates an inconsistency window.

### 1.4 State Mutation Pattern

State mutations use an in-memory `StateHolder`:

```typescript
interface StateHolder<S> {
  current: S;
  dirty: boolean;
}

// During execution
ctx.updateState((s) => ({ ...s, counter: s.counter + 1 }));
// ^^^ Only updates stateHolder.current in memory

// After execution completes successfully
if (stateHolder.dirty) {
  yield* stateService.set(stateHolder.current);  // NOW persisted
}
```

**Risk:** If crash occurs during execution, all state mutations are lost.

---

## 2. Workflow Recovery System (Reference)

The workflow package has a mature, battle-tested recovery system. Key components:

### 2.1 Recovery Detection

```typescript
// In constructor - runs on every DO wake-up
state.blockConcurrencyWhile(async () => {
  const recovery = yield* RecoveryManager;
  const result = yield* recovery.checkAndScheduleRecovery();

  if (result.scheduled) {
    console.log(`Recovery scheduled: ${result.reason}`);
  }
});
```

### 2.2 Stale Detection

```typescript
// If workflow has been "Running" for > 30 seconds, assume crash
if (status._tag === "Running") {
  const staleDuration = now - status.runningAt;

  if (staleDuration >= staleThresholdMs) {
    return { canRecover: true, reason: "stale_running" };
  }
}
```

### 2.3 Recovery Attempt Tracking

```typescript
// Prevent infinite recovery loops
const stats = yield* service.getStats();
if (stats.attempt >= config.maxRecoveryAttempts) {
  yield* stateMachine.applyTransition(new Fail({
    reason: "max_recovery_attempts_exceeded"
  }));
  return Effect.fail(new RecoveryError(...));
}

// Track attempt
const attempt = yield* stateMachine.incrementRecoveryAttempts();
```

### 2.4 Execution Modes

```typescript
type ExecutionMode = "fresh" | "resume" | "recover";

// Recovery re-executes from beginning, skipping completed steps
yield* executor.execute(definition, {
  mode: "recover",
  completedSteps: status.completedSteps,
});
```

### 2.5 State Machine Transitions

```typescript
// Valid transitions from Running state
Running: ["Complete", "Pause", "Fail", "Cancel", "Recover"]

// Recover transition captures metadata
new Recover({
  reason: "stale_detection" | "infrastructure_restart",
  attempt: number,
})
```

---

## 3. Jobs Package Gap Analysis

| Capability | Workflows | Jobs | Gap |
|------------|-----------|------|-----|
| **Constructor recovery check** | ✅ Yes | ❌ No | Critical |
| **Stale execution detection** | ✅ 30s threshold | ❌ None | Critical |
| **Recovery attempt tracking** | ✅ Counter + max | ❌ None | High |
| **Execution timestamp** | ✅ `runningAt` | ❌ None | High |
| **State machine transitions** | ✅ Formal FSM | ⚠️ Simple status | Medium |
| **Execution modes** | ✅ fresh/resume/recover | ❌ Single mode | Medium |
| **Completed work tracking** | ✅ `completedSteps` | ❌ None | Low* |
| **Event emission on recovery** | ✅ workflow.recovery | ❌ None | Low |

*Jobs don't have "steps" - they have atomic executions.

### 3.1 What Jobs Are Missing

1. **No crash detection** - If a job crashes mid-execution, there's no mechanism to detect and recover on next wake-up.

2. **No execution timestamp** - Can't determine if a "running" job is actually stale.

3. **No recovery attempts limit** - Could theoretically loop forever.

4. **No constructor-time recovery** - Recovery only happens reactively, not proactively.

5. **Silent failures** - If alarm scheduling fails after execution, job becomes dormant with no detection.

---

## 4. Failure Scenarios & Risks

### 4.1 Continuous Job: Crash During Execution

```
Timeline:
  T0: Alarm fires, handleAlarm() starts
  T1: runCount incremented (persisted: runCount = 5)
  T2: User function starts executing
  T3: ctx.updateState() called (in-memory only)
  T4: CRASH (deployment, hibernation, error)

Post-crash state:
  - runCount = 5 (persisted)
  - state = old state (T3 mutation lost)
  - metadata.status = "running"
  - alarm = scheduled for next interval

Next alarm (T5):
  - handleAlarm() runs
  - runCount incremented to 6
  - Execution starts with STALE state
  - User sees runCount=6 but state from T2
```

**Impact:** State mutations lost. Run count doesn't match successful executions.

### 4.2 Continuous Job: Crash After Execution, Before Reschedule

```
Timeline:
  T0: User function completes successfully
  T1: State persisted (dirty=true)
  T2: CRASH before scheduleNext()

Post-crash state:
  - State is current (good)
  - metadata.status = "running"
  - alarm = NONE (previous alarm consumed, new one not scheduled)

Result:
  - Job silently stops running
  - No more alarms fire
  - User thinks job is "running" but it's dormant
```

**Impact:** CRITICAL. Job becomes permanently inactive with no detection.

### 4.3 Debounce: Crash During Add

```
Timeline:
  T0: add() request received
  T1: onEvent() called, state updated
  T2: State persisted
  T3: CRASH before idempotency.mark()

Next request (same eventId):
  T4: Idempotency check - NOT marked
  T5: onEvent() called AGAIN (duplicate processing)
  T6: State updated AGAIN
```

**Impact:** Duplicate event processing possible.

### 4.4 Debounce: Crash During Flush

```
Timeline:
  T0: Flush starts (alarm or maxEvents)
  T1: execute() user function runs
  T2: CRASH before cleanup()

Post-crash:
  - State may or may not exist
  - Metadata still exists
  - Event count may be stale

Next alarm:
  - Checks eventCount
  - If 0: cleanup (idempotent)
  - If >0: May re-flush (duplicate)
```

**Impact:** Potential duplicate flush execution.

### 4.5 Infrastructure Restart

```
Timeline:
  T0: Job running normally
  T1: DO hibernates (Cloudflare decision)
  T2: Hours pass
  T3: Request arrives, DO wakes up

Current behavior:
  - No recovery check in constructor
  - Metadata says "running"
  - Alarm may or may not exist
  - If no alarm, job is dormant

Expected behavior:
  - Constructor detects stale "running" status
  - Schedules recovery
  - Job resumes
```

**Impact:** Jobs can become orphaned after hibernation.

---

## 5. Proposed Recovery Architecture

### 5.1 Enhanced Metadata Schema

```typescript
interface JobMetadata {
  // Existing
  readonly type: "continuous" | "debounce" | "workerPool";
  readonly name: string;
  readonly status: JobStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly stopReason?: string;

  // NEW: Recovery fields
  readonly executingAt?: number;        // When current execution started
  readonly lastSuccessfulAt?: number;   // Last successful completion
  readonly recoveryAttempts: number;    // Recovery attempt counter
  readonly lastRecoveryAt?: number;     // When last recovery occurred
}

type JobStatus =
  | "initializing"
  | "running"
  | "executing"    // NEW: Currently in user code
  | "stopped"
  | "terminated"
  | "failed";      // NEW: Unrecoverable failure
```

### 5.2 Recovery Manager Service

```typescript
interface RecoveryManagerI {
  // Check if recovery needed on wake-up
  readonly checkAndScheduleRecovery: () => Effect<RecoveryCheckResult>;

  // Execute recovery flow
  readonly executeRecovery: () => Effect<RecoveryResult>;

  // Get recovery statistics
  readonly getStats: () => Effect<RecoveryStats>;
}

interface RecoveryCheckResult {
  scheduled: boolean;
  reason:
    | "stale_executing"      // Executing for too long
    | "orphaned_alarm"       // Running but no alarm
    | "pending_resume"       // Paused, needs resume
    | "not_needed"           // All good
    | "no_job"               // No metadata
    | "already_terminal";    // Stopped/terminated/failed
  staleDurationMs?: number;
  currentStatus?: string;
}

interface RecoveryConfig {
  readonly staleThresholdMs: number;      // Default: 30_000
  readonly maxRecoveryAttempts: number;   // Default: 3
  readonly recoveryDelayMs: number;       // Default: 100
}
```

### 5.3 Enhanced Execution Flow (Continuous)

```typescript
// BEFORE execution
yield* metadata.update({
  status: "executing",
  executingAt: now,
});

// Execute
const result = yield* executeUserFunction(...);

// AFTER execution (success path)
yield* metadata.update({
  status: "running",
  executingAt: undefined,
  lastSuccessfulAt: now,
  recoveryAttempts: 0,  // Reset on success
});

// Persist state
if (stateHolder.dirty) {
  yield* stateService.set(stateHolder.current);
}

// Schedule next
yield* scheduleNext(def);
```

### 5.4 Constructor Recovery Check

```typescript
class DurableJobsEngine extends DurableObject {
  constructor(state: DurableObjectState, env: unknown) {
    super(state, env as never);

    // Recovery check on EVERY wake-up
    state.blockConcurrencyWhile(async () => {
      await this.#runEffect(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          const result = yield* recovery.checkAndScheduleRecovery();

          if (result.scheduled) {
            yield* Effect.log(`Recovery scheduled: ${result.reason}`);
          }
        })
      );
    });
  }
}
```

### 5.5 Stale Detection Logic

```typescript
checkAndScheduleRecovery: () =>
  Effect.gen(function* () {
    const meta = yield* metadata.get();

    if (!meta) {
      return { scheduled: false, reason: "no_job" };
    }

    // Terminal states don't need recovery
    if (meta.status === "stopped" || meta.status === "terminated" || meta.status === "failed") {
      return { scheduled: false, reason: "already_terminal" };
    }

    const now = yield* runtime.now();

    // Check for stale execution
    if (meta.status === "executing" && meta.executingAt) {
      const staleDuration = now - meta.executingAt;

      if (staleDuration >= config.staleThresholdMs) {
        // Check max attempts
        if (meta.recoveryAttempts >= config.maxRecoveryAttempts) {
          yield* metadata.update({ status: "failed" });
          return { scheduled: false, reason: "max_attempts_exceeded" };
        }

        // Schedule recovery
        yield* scheduler.schedule(now + config.recoveryDelayMs);
        return {
          scheduled: true,
          reason: "stale_executing",
          staleDurationMs: staleDuration,
        };
      }
    }

    // Check for orphaned alarm (running but no alarm)
    if (meta.status === "running") {
      const scheduledAlarm = yield* scheduler.getScheduled();

      if (!scheduledAlarm) {
        // Job says running but no alarm - orphaned!
        yield* scheduler.schedule(now + config.recoveryDelayMs);
        return { scheduled: true, reason: "orphaned_alarm" };
      }
    }

    return { scheduled: false, reason: "not_needed" };
  });
```

### 5.6 Recovery Execution

```typescript
executeRecovery: () =>
  Effect.gen(function* () {
    const meta = yield* metadata.get();
    if (!meta) return { success: false, reason: "no_job" };

    // Increment recovery attempts
    yield* metadata.update({
      recoveryAttempts: meta.recoveryAttempts + 1,
      lastRecoveryAt: yield* runtime.now(),
    });

    // Route to appropriate handler
    switch (meta.type) {
      case "continuous":
        return yield* recoverContinuous(meta);
      case "debounce":
        return yield* recoverDebounce(meta);
      case "workerPool":
        return yield* recoverWorkerPool(meta);
    }
  });

const recoverContinuous = (meta: JobMetadata) =>
  Effect.gen(function* () {
    // Get definition from registry
    const def = yield* registry.getContinuous(meta.name);
    if (!def) {
      yield* metadata.update({ status: "failed" });
      return { success: false, reason: "definition_not_found" };
    }

    // Reset to running state
    yield* metadata.update({
      status: "running",
      executingAt: undefined,
    });

    // Re-schedule alarm (this is safe - alarm API is idempotent)
    yield* scheduleNext(def);

    // Emit recovery event
    yield* tracker.emit({
      type: "continuous.recovered",
      reason: "stale_execution",
      attempt: meta.recoveryAttempts + 1,
    });

    return { success: true, rescheduled: true };
  });
```

---

## 6. Implementation Recommendations

### 6.1 Phase 1: Metadata Enhancement (Low Risk)

1. Add `executingAt`, `lastSuccessfulAt`, `recoveryAttempts` to metadata schema
2. Update handlers to set `executingAt` before execution
3. Clear `executingAt` and update `lastSuccessfulAt` after success
4. **No behavioral changes** - just tracking

### 6.2 Phase 2: Constructor Recovery Check (Medium Risk)

1. Create `RecoveryManager` service
2. Add `blockConcurrencyWhile()` recovery check to constructor
3. Implement stale detection (30s threshold)
4. Implement orphaned alarm detection
5. Schedule recovery alarm when needed

### 6.3 Phase 3: Recovery Execution (Medium Risk)

1. Implement recovery execution for each job type
2. Add max attempts limit with "failed" terminal state
3. Emit recovery events for observability
4. Add recovery config to `createDurableJobs()`

### 6.4 Phase 4: Atomic Operations (Higher Risk)

Consider using Durable Object transactions for critical paths:

```typescript
// Pseudo-code for atomic execution tracking
yield* storage.transaction((txn) => {
  txn.put(KEYS.META, { ...meta, status: "executing", executingAt: now });
  txn.put(KEYS.CONTINUOUS.RUN_COUNT, runCount + 1);
});

// Execute user code...

yield* storage.transaction((txn) => {
  txn.put(KEYS.META, { ...meta, status: "running", lastSuccessfulAt: now });
  txn.put(KEYS.STATE, newState);
});
```

Note: DO storage doesn't have explicit transactions, but `putBatch()` is atomic for multiple keys.

### 6.5 Configuration Interface

```typescript
interface CreateDurableJobsOptions {
  recovery?: {
    enabled?: boolean;              // Default: true
    staleThresholdMs?: number;      // Default: 30_000
    maxRecoveryAttempts?: number;   // Default: 3
    recoveryDelayMs?: number;       // Default: 100
  };
  tracking?: TrackerConfig;
}
```

---

## 7. Migration Path

### 7.1 Backwards Compatibility

**Existing jobs will continue to work:**
- New metadata fields are optional
- Recovery check is additive (won't break existing flows)
- Failed jobs stay failed (won't auto-recover old jobs)

### 7.2 Version Migration

```typescript
// On first access, migrate metadata
const migrateMetadata = (old: OldJobMetadata): JobMetadata => ({
  ...old,
  recoveryAttempts: 0,
  executingAt: undefined,
  lastSuccessfulAt: undefined,
  lastRecoveryAt: undefined,
});
```

### 7.3 Rollout Strategy

1. **Deploy Phase 1** - Metadata tracking only, no recovery
2. **Monitor** - Watch for stale jobs in logs/metrics
3. **Deploy Phase 2** - Recovery detection (log only, don't act)
4. **Verify** - Confirm detection is accurate
5. **Deploy Phase 3** - Enable recovery execution
6. **Tune** - Adjust thresholds based on production behavior

---

## 8. Summary

### Current State

The jobs package has solid foundational architecture with Effect layers, schema validation, and idempotency. However, it lacks recovery mechanisms that are critical for production resilience:

- No detection of crashed/stale executions
- No constructor-time recovery checks
- No recovery attempt tracking
- Silent failures when alarms aren't rescheduled

### Recommended Enhancements

1. **Enhanced metadata** with execution timestamps and recovery counters
2. **Constructor recovery check** using `blockConcurrencyWhile()`
3. **Stale detection** with configurable threshold (30s default)
4. **Orphaned alarm detection** for running jobs without alarms
5. **Max recovery attempts** to prevent infinite loops
6. **Failed terminal state** for unrecoverable jobs
7. **Recovery events** for observability

### Risk Assessment

| Enhancement | Risk | Effort | Value |
|-------------|------|--------|-------|
| Metadata fields | Low | Small | Foundation |
| Constructor check | Medium | Medium | High |
| Stale detection | Medium | Medium | High |
| Recovery execution | Medium | Medium | High |
| Atomic operations | Higher | Large | Medium |

### Priority

1. **Must Have**: Metadata enhancement + Constructor recovery check
2. **Should Have**: Stale detection + Recovery execution
3. **Nice to Have**: Atomic operations + Advanced tuning

---

## Appendix: File References

- Engine: `packages/jobs/src/engine/engine.ts`
- Handlers: `packages/jobs/src/handlers/continuous/handler.ts`
- Metadata: `packages/jobs/src/services/metadata.ts`
- Storage Keys: `packages/jobs/src/storage-keys.ts`
- Workflow Recovery (reference): `packages/workflow/src/recovery/manager.ts`
- Workflow State Machine (reference): `packages/workflow/src/state/machine.ts`
