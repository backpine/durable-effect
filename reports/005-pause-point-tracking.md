# Pause Point Tracking for Durable Workflows

## Problem Statement

When a workflow resumes after a `sleep` alarm:
1. The alarm triggers and re-executes the workflow
2. Each `step` runs and pulls from cache (correct behavior)
3. When it hits `sleep` again, the workflow thinks it's the first time and sets another alarm
4. This creates an infinite loop

The core issue: **`sleep` is stateless**. Unlike `step`, which has a name and tracks completion, `sleep` has no way to know if it already executed.

---

## Requirements

1. Track when a pause point (sleep, wait, etc.) has been "passed"
2. On resume, skip the pause point that triggered the resume
3. Support multiple pause points in a single workflow
4. Support future jobs like `wait` (wait for external event)
5. **No API changes** - keep `sleep(duration)` simple
6. No user-provided names required

---

## Proposed Solution: Execution Order Tracking

### Core Insight

Workflow execution is **deterministic**. Given the same inputs and cached step results, the workflow follows the same code path every time. This means pause points execute in the same order on every run.

We can track pause points by their **execution index** rather than by name.

### How It Works

Track two pieces of state:
1. **Runtime counter** - Which pause point we're currently at (resets each run)
2. **Persisted completion index** - How many pause points have completed

```
Runtime (in-memory):     pauseIndex = 0, 1, 2, ... (increments as we encounter pauses)
Storage (persisted):     workflow:completedPauseIndex = N (highest completed index)
                         workflow:pendingResumeAt = timestamp (when to resume)
```

### Execution Flow

**First run with two sleeps:**

```typescript
yield* Workflow.sleep("5 seconds");   // pauseIndex = 1
yield* doSomeStep();
yield* Workflow.sleep("10 seconds");  // pauseIndex = 2
```

| State | pauseIndex | completedPauseIndex | pendingResumeAt |
|-------|------------|---------------------|-----------------|
| Start | 0 | 0 | undefined |
| sleep1 runs | 1 | 0 | undefined |
| 1 > 0, not completed, no pending → **PAUSE** | 1 | 0 | T1 |

**After alarm at T1:**

| State | pauseIndex | completedPauseIndex | pendingResumeAt |
|-------|------------|---------------------|-----------------|
| Start | 0 | 0 | T1 |
| sleep1 runs | 1 | 0 | T1 |
| 1 > 0, not completed, but pending exists and now >= T1 → **RESUME** | 1 | **1** | cleared |
| step runs (cached) | 1 | 1 | undefined |
| sleep2 runs | 2 | 1 | undefined |
| 2 > 1, not completed, no pending → **PAUSE** | 2 | 1 | T2 |

**After alarm at T2:**

| State | pauseIndex | completedPauseIndex | pendingResumeAt |
|-------|------------|---------------------|-----------------|
| Start | 0 | 1 | T2 |
| sleep1 runs | 1 | 1 | T2 |
| 1 <= 1, already completed → **SKIP** | 1 | 1 | T2 |
| step runs (cached) | 1 | 1 | T2 |
| sleep2 runs | 2 | 1 | T2 |
| 2 > 1, not completed, but pending exists and now >= T2 → **RESUME** | 2 | **2** | cleared |
| workflow completes | 2 | 2 | undefined |

### Storage Schema

```
workflow:completedPauseIndex  → number    // Highest completed pause index
workflow:pendingResumeAt      → number    // When the pending pause should resume
```

### Implementation

#### 1. Add Pause Index to WorkflowContext

The pause index is a **runtime counter** that resets each execution. We use an Effect `Ref` to track it:

```typescript
// In workflow-context.ts
export interface WorkflowContextService {
  // ... existing fields ...

  /** Get the next pause index (increments counter) */
  nextPauseIndex: Effect.Effect<number, never>;

  /** Get the completed pause index from storage */
  completedPauseIndex: Effect.Effect<number, UnknownException>;

  /** Set the completed pause index */
  setCompletedPauseIndex: (index: number) => Effect.Effect<void, UnknownException>;

  /** Get pending resume timestamp */
  pendingResumeAt: Effect.Effect<Option<number>, UnknownException>;

  /** Set pending resume timestamp */
  setPendingResumeAt: (time: number) => Effect.Effect<void, UnknownException>;

  /** Clear pending resume */
  clearPendingResumeAt: Effect.Effect<void, UnknownException>;
}
```

#### 2. Update createWorkflowContext Factory

```typescript
export function createWorkflowContext(
  workflowId: string,
  workflowName: string,
  input: unknown,
  storage: DurableObjectStorage,
): WorkflowContextService {
  // Runtime pause counter (resets each execution)
  let pauseCounter = 0;

  return {
    workflowId,
    workflowName,
    input,

    // ... existing methods ...

    nextPauseIndex: Effect.sync(() => ++pauseCounter),

    completedPauseIndex: Effect.tryPromise({
      try: () => storage.get<number>("workflow:completedPauseIndex"),
      catch: (e) => new UnknownException(e),
    }).pipe(Effect.map((n) => n ?? 0)),

    setCompletedPauseIndex: (index: number) =>
      Effect.tryPromise({
        try: () => storage.put("workflow:completedPauseIndex", index),
        catch: (e) => new UnknownException(e),
      }),

    pendingResumeAt: Effect.tryPromise({
      try: () => storage.get<number>("workflow:pendingResumeAt"),
      catch: (e) => new UnknownException(e),
    }).pipe(Effect.map((t) => (t !== undefined ? Option.some(t) : Option.none()))),

    setPendingResumeAt: (time: number) =>
      Effect.tryPromise({
        try: () => storage.put("workflow:pendingResumeAt", time),
        catch: (e) => new UnknownException(e),
      }),

    clearPendingResumeAt: Effect.tryPromise({
      try: () => storage.delete("workflow:pendingResumeAt"),
      catch: (e) => new UnknownException(e),
    }),
  };
}
```

#### 3. Update Sleep Implementation

```typescript
export function sleep(
  duration: Duration.DurationInput,
): Effect.Effect<void, PauseSignal | UnknownException, ExecutionContext | WorkflowContext> {
  return Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    const workflowCtx = yield* WorkflowContext;

    // Get this pause point's index
    const pauseIndex = yield* workflowCtx.nextPauseIndex;
    const completedIndex = yield* workflowCtx.completedPauseIndex;

    // Already completed - skip
    if (pauseIndex <= completedIndex) {
      return;
    }

    // Check if we're resuming from this pause
    const pendingResumeAt = yield* workflowCtx.pendingResumeAt;
    if (Option.isSome(pendingResumeAt) && Date.now() >= pendingResumeAt.value) {
      // This is the pause we're resuming from
      yield* workflowCtx.setCompletedPauseIndex(pauseIndex);
      yield* workflowCtx.clearPendingResumeAt;
      return;
    }

    // New pause - set alarm and pause
    const durationMs = Duration.toMillis(Duration.decode(duration));
    const resumeAt = Date.now() + durationMs;

    yield* workflowCtx.setPendingResumeAt(resumeAt);
    yield* ctx.setAlarm(resumeAt);

    return yield* Effect.fail(
      new PauseSignal({
        reason: "sleep",
        resumeAt,
      }),
    );
  });
}
```

---

## Future: Wait Primitive

The execution order model extends naturally to `wait`. The key difference is that `wait` doesn't have a known `resumeAt` - it waits for an external signal.

```typescript
// Wait for an external event
const orderConfirmed = yield* Workflow.wait<OrderEvent>({
  event: "order-confirmation",
  timeout: "1 hour"
});

// External system signals the workflow:
await engine.signal("order-confirmation", { orderId: "123", status: "confirmed" });
```

### Wait Storage Schema

```
workflow:completedPauseIndex  → number           // Shared with sleep
workflow:pendingWait          → {
  event: string,
  timeoutAt?: number,
  payload?: unknown,        // Filled when signal received
}
```

### Wait Implementation Sketch

```typescript
export function wait<T>(
  options: { event: string; timeout?: Duration.DurationInput },
): Effect.Effect<T, WaitTimeoutError | PauseSignal | UnknownException, ExecutionContext | WorkflowContext> {
  return Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    const workflowCtx = yield* WorkflowContext;

    // Get this pause point's index
    const pauseIndex = yield* workflowCtx.nextPauseIndex;
    const completedIndex = yield* workflowCtx.completedPauseIndex;

    // Already completed - return cached payload or throw timeout
    if (pauseIndex <= completedIndex) {
      const pendingWait = yield* workflowCtx.getPendingWait;
      if (Option.isSome(pendingWait) && pendingWait.value.payload !== undefined) {
        return pendingWait.value.payload as T;
      }
      // Completed without payload means timeout
      return yield* Effect.fail(new WaitTimeoutError({ event: options.event }));
    }

    // Check if signal already received
    const pendingWait = yield* workflowCtx.getPendingWait;
    if (Option.isSome(pendingWait) && pendingWait.value.payload !== undefined) {
      yield* workflowCtx.setCompletedPauseIndex(pauseIndex);
      yield* workflowCtx.clearPendingWait;
      return pendingWait.value.payload as T;
    }

    // Check if we're resuming (timeout case)
    if (Option.isSome(pendingWait) && pendingWait.value.timeoutAt) {
      if (Date.now() >= pendingWait.value.timeoutAt) {
        yield* workflowCtx.setCompletedPauseIndex(pauseIndex);
        yield* workflowCtx.clearPendingWait;
        return yield* Effect.fail(new WaitTimeoutError({ event: options.event }));
      }
    }

    // Set up wait
    const timeoutAt = options.timeout
      ? Date.now() + Duration.toMillis(Duration.decode(options.timeout))
      : undefined;

    yield* workflowCtx.setPendingWait({
      event: options.event,
      timeoutAt,
    });

    if (timeoutAt) {
      yield* ctx.setAlarm(timeoutAt);
    }

    return yield* Effect.fail(
      new PauseSignal({
        reason: "wait",
        resumeAt: timeoutAt,
      }),
    );
  });
}
```

### Engine Signal Method

```typescript
// In engine.ts
async signal<T>(event: string, payload: T): Promise<void> {
  const storage = this.ctx.storage;

  const pendingWait = await storage.get<PendingWait>("workflow:pendingWait");
  if (pendingWait?.event === event) {
    // Store the payload
    await storage.put("workflow:pendingWait", {
      ...pendingWait,
      payload,
    });

    // Resume workflow immediately
    await this.alarm();
  }
}
```

---

## Determinism Requirement

This approach relies on **deterministic workflow execution**. Each run must encounter pause points in the same order.

**Valid patterns:**
```typescript
yield* sleep("5 seconds");
const result = yield* step("fetch", fetchData());
yield* sleep("10 seconds");
```

**Invalid pattern (non-deterministic):**
```typescript
if (Math.random() > 0.5) {
  yield* sleep("5 seconds");  // Sometimes index 1, sometimes skipped!
}
yield* sleep("10 seconds");   // Sometimes index 1, sometimes index 2!
```

**Valid conditional (deterministic):**
```typescript
const shouldWait = yield* step("check", checkCondition());
if (shouldWait) {
  yield* sleep("5 seconds");  // Deterministic because shouldWait is cached
}
```

This is a standard requirement for durable workflow systems (Temporal, Durable Functions, etc.).

---

## Summary

**Execution order tracking** provides a robust solution without API changes:

1. **No names required** - `sleep(duration)` API unchanged
2. **Automatic tracking** - Pause points identified by execution order
3. **Simple storage** - Just two keys: `completedPauseIndex` and `pendingResumeAt`
4. **Extensible** - Same pattern works for `wait` and future jobs
5. **Standard constraint** - Requires deterministic workflows (same as all durable workflow systems)

The key insight is that deterministic execution means pause points always occur in the same order, making explicit naming unnecessary.
