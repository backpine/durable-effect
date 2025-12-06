# Report 029: Ranked Architecture Improvements

## Executive Summary

After comprehensive analysis of the `@durable-effect/workflow` package, this report identifies and ranks improvements by impact, risk, and implementation complexity. The codebase is well-architected (9/10) with clean layering, strong type safety, and excellent Effect patterns. However, several opportunities exist to improve robustness, developer experience, and operational safety.

## Architecture Overview

```
PUBLIC API (Workflow namespace)
        ↓ provides
ENGINE LAYER (DurableWorkflowEngine, transitions)
        ↓ requires
SERVICE LAYER (WorkflowContext, StepContext, WorkflowScope, StepClock, EventTracker)
        ↓ uses
STORAGE LAYER (DurableObjectStorage)
```

**Strengths:** Clean layering, type-safe compile-time guards (ForbidWorkflowScope), discriminated unions, idempotent operations, excellent testability.

**Weaknesses:** Pause point fragility, no workflow versioning, storage batch inefficiency, limited error recovery.

---

## Ranked Improvements

### Tier 1: Critical (High Impact, Addresses Correctness/Safety)

---

#### #1: Named Pause Points (Replace Index-Based Tracking)

**Priority:** Critical
**Impact:** High
**Complexity:** Medium
**Risk:** Breaking change

**Problem:**

Pause points (sleep, retry) are tracked by execution order index, not by name. This creates fragility:

```typescript
// Original workflow
yield* Workflow.sleep("5s");     // pauseIndex = 1
yield* Workflow.sleep("10s");    // pauseIndex = 2
// User paused at index 2

// After refactoring (adds conditional)
if (condition) {
  yield* Workflow.sleep("5s");   // pauseIndex = 1 (only if condition)
}
yield* Workflow.sleep("10s");    // pauseIndex = 1 or 2 depending on condition
// Resume at index 2 → MISALIGNED
```

**Current Code:** `workflow-context.ts:93-112`

```typescript
readonly nextPauseIndex: Effect.Effect<number, never, never>;
// Uses a runtime counter that increments on each pause point
```

**Solution:**

Require named pause points, similar to how steps have names:

```typescript
// New API
yield* Workflow.sleep("wait-for-webhook", "5 minutes");
yield* Workflow.retry("fetch-with-retry", { maxAttempts: 3 });

// Storage key becomes deterministic
// workflow:pause:wait-for-webhook:completedAt
```

**Implementation:**
1. Add `name` parameter to `Workflow.sleep()` and implicit pause points in `Workflow.retry()`
2. Store completion by name: `workflow:pause:${name}:completed`
3. Check completion by name on resume
4. Remove `pauseCounter` and `completedPauseIndex`
5. Migration: v2 API with deprecation warnings

**Breaking Change Mitigation:**
- Introduce as `Workflow.namedSleep()` first
- Deprecate `Workflow.sleep()` with migration guide
- Provide codemod for automatic refactoring

---

#### #2: Workflow Determinism Validation

**Priority:** Critical
**Impact:** High
**Complexity:** High
**Risk:** New feature

**Problem:**

Workflows can accidentally use non-deterministic operations that break replay:

```typescript
const workflow = Workflow.make((_: void) =>
  Effect.gen(function* () {
    if (Math.random() > 0.5) {
      yield* Workflow.step("A", ...);  // May or may not run
    }
    yield* Workflow.step("B", ...);    // Step A cached but not executed = crash
  })
);
```

**Current State:** No detection or warning.

**Solution:**

Record step/pause execution sequence and validate on resume:

```typescript
// Storage: workflow:executionSequence
// ["step:FetchUser", "pause:sleep-1", "step:ProcessData"]

// On resume, validate sequence matches
// If step names differ → DeterminismError
```

**Implementation:**
1. Add `workflow:executionSequence` array in storage
2. Append step/pause names during execution
3. On resume, compare current sequence against stored
4. Fail with `WorkflowDeterminismError` on mismatch
5. Include in error message: expected vs actual sequence

---

#### #3: Storage Transient Error Retry

**Priority:** High
**Impact:** Medium
**Complexity:** Low
**Risk:** Low

**Problem:**

Storage operations can fail transiently (network issues, DO migration). Currently, failures immediately crash the workflow:

```typescript
// step-context.ts:109-113
setResult: <T>(value: T) =>
  Effect.tryPromise({
    try: () => storage.put(stepKey(stepName, "result"), value),
    catch: (e) => new UnknownException(e),  // No retry
  }),
```

**Solution:**

Add retry with exponential backoff for storage operations:

```typescript
const storageRetryPolicy = Schedule.exponential("50 millis", 2).pipe(
  Schedule.intersect(Schedule.recurs(3)),
  Schedule.upTo("500 millis"),
);

const safeStoragePut = <T>(key: string, value: T) =>
  Effect.tryPromise({
    try: () => storage.put(key, value),
    catch: (e) => new StorageError(key, "put", e),
  }).pipe(
    Effect.retry(storageRetryPolicy),
    Effect.catchAll((e) => Effect.fail(new UnknownException(e))),
  );
```

**Scope:**
- `storage.put()` in step-context.ts
- `storage.put()` in workflow-context.ts
- `storage.get()` operations (read retries are always safe)

---

### Tier 2: Important (Improves Robustness/DX)

---

#### #4: Workflow Versioning System

**Priority:** High
**Impact:** High
**Complexity:** Medium
**Risk:** New feature

**Problem:**

When workflow logic changes, in-flight workflows may break:
- Step names change → cached results orphaned
- Step order changes → wrong cached results used
- Return types change → deserialization fails

**Solution:**

Add explicit versioning with migration support:

```typescript
const workflow = Workflow.make({
  name: "processOrder",
  version: 2,
  migrations: {
    1: (state) => ({ ...state, newField: "default" }),
  },
  definition: (input: OrderInput) => Effect.gen(function* () {
    // ...
  }),
});
```

**Implementation:**
1. Store `workflow:version` in metadata
2. On resume, check stored version vs current
3. If mismatch, run migrations in order
4. Fail with `VersionMismatchError` if no migration path
5. Optional: Allow "breaking" versions that fail in-flight workflows

---

#### #5: Storage Batch Operations

**Priority:** Medium
**Impact:** Medium
**Complexity:** Low
**Risk:** Low

**Problem:**

Each step completion triggers multiple individual storage writes:

```typescript
// Current: 3 separate storage operations per step
yield* stepCtx.setResult(value);           // storage.put()
yield* markStepCompleted(name, storage);   // storage.put()
yield* stepCtx.recordStartTime();          // storage.put() (if not recorded)
```

Durable Objects support `storage.put(entries)` for batch writes.

**Solution:**

Batch storage operations per step completion:

```typescript
// New: Single batched write
yield* Effect.tryPromise({
  try: () => storage.put({
    [stepKey(name, "result")]: value,
    [stepKey(name, "completedAt")]: Date.now(),
    ["workflow:completedSteps"]: [...completed, name],
  }),
  catch: (e) => new StorageError("batch", e),
});
```

**Benefits:**
- Fewer storage transactions (billing)
- Atomic step completion (no partial state)
- Lower latency

---

#### #6: StepClock Type-Level Enforcement

**Priority:** Medium
**Impact:** Low
**Complexity:** Medium
**Risk:** Low

**Problem:**

`Effect.sleep()` inside steps is prevented via runtime `die()`:

```typescript
// step-clock.ts:28-34
sleep: (duration) =>
  Effect.die(
    new StepSleepForbiddenError({
      message: "Effect.sleep is not allowed inside a Workflow.step",
      requestedDuration: duration,
    }),
  ),
```

This is a runtime error, not compile-time.

**Solution:**

Use the same `ForbidWorkflowScope` pattern for Clock:

```typescript
// New: StepClockScope that step() removes from R
class StepClockScope extends Context.Tag("StepClockScope")<...>() {}

// step() signature
export function step<T, E, R>(
  name: string,
  effect: Effect.Effect<T, E, ForbidWorkflowScope<R>>,
): Effect.Effect<T, E | ..., WorkflowScope | Exclude<R, StepClockScope> | ...>
```

**Trade-off:** May be too restrictive if users legitimately need Clock for non-sleep operations inside steps.

---

#### #7: Structured Workflow Errors

**Priority:** Medium
**Impact:** Medium
**Complexity:** Low
**Risk:** Low

**Problem:**

`UnknownException` wrapping loses error context:

```typescript
catch: (e) => new UnknownException(e)  // Opaque
```

**Solution:**

Create domain-specific error types:

```typescript
// New error hierarchy
class WorkflowStorageError extends Data.TaggedError("WorkflowStorageError")<{
  readonly operation: "get" | "put" | "delete";
  readonly key: string;
  readonly cause: unknown;
}> {}

class WorkflowTransitionError extends Data.TaggedError("WorkflowTransitionError")<{
  readonly from: WorkflowStatus;
  readonly to: WorkflowTransition;
  readonly cause: unknown;
}> {}

class WorkflowContextError extends Data.TaggedError("WorkflowContextError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}
```

**Benefits:**
- Pattern matching on error types
- Better error messages
- Easier debugging

---

### Tier 3: Enhancements (Nice to Have)

---

#### #8: Workflow Cancellation Support

**Priority:** Low
**Impact:** Medium
**Complexity:** High
**Risk:** Medium

**Problem:**

No way to cancel a running or paused workflow:

```typescript
// Current: No cancel method
client.run(input);
// ... later
// client.cancel() ← doesn't exist
```

**Solution:**

Add cancellation with cleanup:

```typescript
// New API
yield* client.cancel(executionId, { reason: "user requested" });

// Storage: workflow:cancelled = true
// On resume, check cancelled flag before continuing
// Emit workflow.cancelled event
```

**Implementation:**
1. Add `cancel()` to WorkflowClientInstance
2. Store `workflow:cancelled` flag
3. Check flag at start of execution and after each pause
4. Emit `workflow.cancelled` event
5. Optional: Allow cancellation handlers for cleanup

---

#### #9: Event Tracker Lazy Initialization

**Priority:** Low
**Impact:** Low
**Complexity:** Low
**Risk:** Low

**Problem:**

EventTracker is always instantiated, even when not configured:

```typescript
// engine.ts:178-185
this.#trackerLayer = config.eventTracker
  ? createHttpBatchTracker(config.eventTracker)
  : NoopTrackerLayer;

// Even NoopTrackerLayer has overhead
```

**Solution:**

Fully lazy tracker with compile-time flag:

```typescript
// Option A: Skip tracker creation entirely
if (!config.eventTracker) {
  // Don't include emitEvent calls in effect chain
}

// Option B: Dead code elimination via build-time flag
if (process.env.WORKFLOW_EVENTS_ENABLED) {
  yield* emitEvent(...);
}
```

---

#### #10: Storage Quota Monitoring

**Priority:** Low
**Impact:** Medium
**Complexity:** Low
**Risk:** Low

**Problem:**

Durable Objects have storage limits (default 1GB). Large workflows or many steps can exhaust quota without warning.

**Solution:**

Add quota monitoring and warnings:

```typescript
// Periodic check (every N steps)
const checkStorageQuota = Effect.gen(function* () {
  const usage = yield* Effect.tryPromise(() => storage.usage());
  const quota = 1024 * 1024 * 1024; // 1GB default

  if (usage > quota * 0.8) {
    yield* emitEvent({
      type: "workflow.warning",
      warning: "storage_quota_80_percent",
      usage,
      quota,
    });
  }
});
```

---

#### #11: Step Result Schema Validation

**Priority:** Low
**Impact:** Medium
**Complexity:** Medium
**Risk:** Low

**Problem:**

Step results are validated via `structuredClone()` at runtime. No schema validation for data correctness.

**Solution:**

Allow optional Effect Schema for step results:

```typescript
import { Schema } from "@effect/schema";

const UserSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

yield* Workflow.step(
  "FetchUser",
  fetchUser(id),
  { schema: UserSchema }  // Optional validation
);
```

**Benefits:**
- Catch data corruption on resume
- Type-safe cached result access
- Documentation of expected shape

---

#### #12: Middleware/Hook System

**Priority:** Low
**Impact:** Medium
**Complexity:** High
**Risk:** Medium

**Problem:**

No extension points for cross-cutting concerns:
- Custom logging per step
- Metrics collection
- Rate limiting
- Circuit breakers

**Solution:**

Add middleware layer:

```typescript
const loggingMiddleware: WorkflowMiddleware = {
  beforeStep: (ctx) => Effect.log(`Starting step: ${ctx.stepName}`),
  afterStep: (ctx, result) => Effect.log(`Completed: ${ctx.stepName}`),
  onStepError: (ctx, error) => Effect.log(`Failed: ${ctx.stepName}`),
};

const workflow = Workflow.make({
  middleware: [loggingMiddleware, metricsMiddleware],
  definition: (input) => ...
});
```

---

## Implementation Roadmap

### Phase 1: Safety & Correctness (Weeks 1-2)
1. Storage transient error retry (#3)
2. Structured workflow errors (#7)

### Phase 2: Robustness (Weeks 3-4)
3. Storage batch operations (#5)
4. Workflow versioning system (#4)

### Phase 3: Breaking Changes (Major Version)
5. Named pause points (#1)
6. Workflow determinism validation (#2)

### Phase 4: Enhancements (Backlog)
7. StepClock type-level enforcement (#6)
8. Workflow cancellation (#8)
9. Event tracker lazy init (#9)
10. Storage quota monitoring (#10)
11. Step result schema validation (#11)
12. Middleware system (#12)

---

## Summary Table

| # | Improvement | Priority | Impact | Complexity | Risk | Phase |
|---|-------------|----------|--------|------------|------|-------|
| 1 | Named Pause Points | Critical | High | Medium | Breaking | 3 |
| 2 | Determinism Validation | Critical | High | High | New | 3 |
| 3 | Storage Error Retry | High | Medium | Low | Low | 1 |
| 4 | Workflow Versioning | High | High | Medium | New | 2 |
| 5 | Storage Batch Ops | Medium | Medium | Low | Low | 2 |
| 6 | StepClock Type-Level | Medium | Low | Medium | Low | 4 |
| 7 | Structured Errors | Medium | Medium | Low | Low | 1 |
| 8 | Cancellation | Low | Medium | High | Medium | 4 |
| 9 | Lazy Tracker | Low | Low | Low | Low | 4 |
| 10 | Quota Monitoring | Low | Medium | Low | Low | 4 |
| 11 | Schema Validation | Low | Medium | Medium | Low | 4 |
| 12 | Middleware System | Low | Medium | High | Medium | 4 |

---

## Conclusion

The `@durable-effect/workflow` package is exceptionally well-designed. The most impactful improvements are:

1. **Named pause points** - Eliminates fragility in workflow evolution
2. **Determinism validation** - Catches bugs before production
3. **Storage error retry** - Improves reliability with minimal code
4. **Workflow versioning** - Enables safe workflow evolution

Phase 1-2 improvements can be shipped without breaking changes. Phase 3 requires a major version bump but addresses fundamental correctness issues.
