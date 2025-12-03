# Workflow Lifecycle Events Not Emitted

## Problem

Workflow-level lifecycle events (`workflow.started`, `workflow.completed`, `workflow.paused`, `workflow.failed`, `workflow.resumed`) are not being sent to the tracker, while step-level events (`step.started`, `step.completed`, etc.) work correctly.

## Root Cause

The `EventTracker` layer is only provided to the workflow effect (user code), not to the administrative effects that emit workflow lifecycle events.

### Code Analysis

In `packages/workflow/src/engine.ts`, the tracker layer is provided like this:

```typescript
// lines 294-298
if (this.#trackerLayer) {
  workflowEffect = workflowEffect.pipe(
    Effect.provide(this.#trackerLayer),
  );
}
```

This means the tracker is only available within `workflowEffect` (the user's workflow code).

However, workflow lifecycle events are emitted in **separate** `Effect.runPromise()` calls that do NOT have the tracker layer:

### 1. `workflow.started` - NOT EMITTED

```typescript
// lines 196-208 in run()
const setupEffect = Effect.gen(function* () {
  yield* storeWorkflowMeta(storage, String(workflowName), input);
  yield* setWorkflowStatus(storage, { _tag: "Running" });

  // This emitEvent has NO tracker in context!
  yield* emitEvent({
    ...createBaseEvent(workflowId, String(workflowName)),
    type: "workflow.started",
    input,
  });
});

await Effect.runPromise(setupEffect);  // No tracker layer provided!
```

### 2. `workflow.completed` - NOT EMITTED

```typescript
// lines 310-325 in #executeWorkflow()
await Effect.runPromise(
  Effect.gen(function* () {
    yield* setWorkflowStatus(storage, {
      _tag: "Completed",
      completedAt: Date.now(),
    });

    // This emitEvent has NO tracker in context!
    yield* emitEvent({
      ...createBaseEvent(workflowId, workflowName),
      type: "workflow.completed",
      completedSteps,
      durationMs: Date.now() - startTime,
    });
  }),
);  // No tracker layer provided!
```

### 3. `workflow.paused` - NOT EMITTED

```typescript
// lines 332-351 in #executeWorkflow()
await Effect.runPromise(
  Effect.gen(function* () {
    yield* setWorkflowStatus(storage, { ... });

    // This emitEvent has NO tracker in context!
    yield* emitEvent({
      ...createBaseEvent(workflowId, workflowName),
      type: "workflow.paused",
      ...
    });
  }),
);  // No tracker layer provided!
```

### 4. `workflow.failed` - NOT EMITTED

```typescript
// lines 380-401 in #executeWorkflow()
await Effect.runPromise(
  Effect.gen(function* () {
    yield* setWorkflowStatus(storage, { ... });

    // This emitEvent has NO tracker in context!
    yield* emitEvent({
      ...createBaseEvent(workflowId, workflowName),
      type: "workflow.failed",
      ...
    });
  }),
);  // No tracker layer provided!
```

### 5. `workflow.resumed` - NOT EMITTED

```typescript
// lines 241-251 in alarm()
await Effect.runPromise(
  Effect.gen(function* () {
    yield* setWorkflowStatus(storage, { _tag: "Running" });

    // This emitEvent has NO tracker in context!
    yield* emitEvent({
      ...createBaseEvent(workflowId, workflowName),
      type: "workflow.resumed",
    });
  }),
);  // No tracker layer provided!
```

## Why Step Events Work

Step events (`step.started`, `step.completed`, `retry.scheduled`, etc.) work because they're emitted from within `Workflow.step()`, `Workflow.retry()`, etc. - which execute inside `workflowEffect` that HAS the tracker layer provided.

```typescript
// This runs INSIDE workflowEffect which has the tracker layer
yield* Workflow.step('myStep', Effect.gen(function* () {
  // emitEvent works here because tracker is in context
}));
```

## How `emitEvent` Works

```typescript
// packages/workflow/src/tracker/service.ts lines 80-88
export const emitEvent = (event: InternalWorkflowEvent): Effect.Effect<void> =>
  Effect.gen(function* () {
    const maybeTracker = yield* Effect.serviceOption(EventTracker);

    if (Option.isSome(maybeTracker)) {
      yield* maybeTracker.value.emit(event);
    }
    // If tracker not in context, this is silently a no-op!
  });
```

When `Effect.serviceOption(EventTracker)` is called without the tracker layer in context, it returns `Option.none()`, making the entire function a silent no-op.

## Impact

| Event Type | Working? | Reason |
|------------|----------|--------|
| `workflow.started` | ❌ No | Emitted outside workflowEffect |
| `workflow.completed` | ❌ No | Emitted outside workflowEffect |
| `workflow.paused` | ❌ No | Emitted outside workflowEffect |
| `workflow.failed` | ❌ No | Emitted outside workflowEffect |
| `workflow.resumed` | ❌ No | Emitted outside workflowEffect |
| `step.started` | ✅ Yes | Emitted inside workflowEffect |
| `step.completed` | ✅ Yes | Emitted inside workflowEffect |
| `step.failed` | ✅ Yes | Emitted inside workflowEffect |
| `retry.scheduled` | ✅ Yes | Emitted inside workflowEffect |
| `retry.exhausted` | ✅ Yes | Emitted inside workflowEffect |
| `sleep.started` | ✅ Yes | Emitted inside workflowEffect |
| `sleep.completed` | ✅ Yes | Emitted inside workflowEffect |
| `timeout.set` | ✅ Yes | Emitted inside workflowEffect |
| `timeout.exceeded` | ✅ Yes | Emitted inside workflowEffect |

## Solution Options

### Option A: Provide tracker layer to all administrative effects

Provide the tracker layer to each `Effect.runPromise()` call that emits workflow events:

```typescript
if (this.#trackerLayer) {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* setWorkflowStatus(storage, { _tag: "Completed", ... });
      yield* emitEvent({ ... });
    }).pipe(Effect.provide(this.#trackerLayer))
  );
} else {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* setWorkflowStatus(storage, { _tag: "Completed", ... });
      yield* emitEvent({ ... }); // Still no-op without tracker
    })
  );
}
```

**Pros:**
- Straightforward fix
- Clear where tracker is used

**Cons:**
- Repetitive code
- Need to remember to add layer for each admin effect

### Option B: Create a helper method

Create a helper method that runs effects with the tracker layer:

```typescript
class DurableWorkflowEngine {
  #runWithTracker<A, E>(effect: Effect.Effect<A, E, EventTracker>): Promise<A> {
    if (this.#trackerLayer) {
      return Effect.runPromise(effect.pipe(Effect.provide(this.#trackerLayer)));
    }
    return Effect.runPromise(effect);
  }
}
```

**Pros:**
- DRY
- Single place to manage tracker provisioning

**Cons:**
- Type complexity with optional tracker requirement

### Option C: Combine admin effects with workflow effect (Recommended)

Restructure to include lifecycle event emission inside the workflow effect's execution context:

```typescript
async #executeWorkflow(...): Promise<void> {
  // Build workflow with lifecycle events included
  const fullEffect = Effect.gen(function* () {
    // workflow.started already emitted in run()

    try {
      return yield* workflowDef.definition(input);
    } finally {
      // Emit completion/failure in same context
    }
  }).pipe(
    Effect.provideService(ExecutionContext, execCtx),
    Effect.provideService(WorkflowContext, workflowCtx),
  );

  if (this.#trackerLayer) {
    fullEffect = fullEffect.pipe(Effect.provide(this.#trackerLayer));
  }

  // Now all events emitted within have tracker access
}
```

**Pros:**
- All events in same context
- Natural Effect composition
- Tracker available everywhere

**Cons:**
- Requires restructuring
- More complex control flow for pause/resume

### Option D: Store tracker service instance (Simplest)

Store the tracker service instance and call it directly for admin events:

```typescript
class DurableWorkflowEngine {
  #trackerService: EventTrackerService | undefined;

  constructor(...) {
    if (trackerConfig) {
      // Initialize tracker service
      this.#trackerService = /* create service */;
    }
  }

  async #emitAdminEvent(event: InternalWorkflowEvent) {
    if (this.#trackerService) {
      await Effect.runPromise(this.#trackerService.emit(event));
    }
  }
}
```

**Pros:**
- Simple, direct approach
- No layer management for admin events

**Cons:**
- Bypasses Effect's service pattern
- Tracker lifecycle management more complex

## Recommendation

**Option A** is the quickest fix with minimal code changes. Wrap each administrative `Effect.runPromise()` call with the tracker layer when available.

For a cleaner long-term solution, **Option C** restructures the code to emit all events within the same Effect context, ensuring the tracker is always available when needed.
