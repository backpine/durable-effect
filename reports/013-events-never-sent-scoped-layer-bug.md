# Workflow Events Never Sent: Scoped Layer Lifecycle Bug

## Problem

No workflow events are being sent to the tracking endpoint. Step events (`step.started`, `step.completed`), workflow lifecycle events (`workflow.started`, `workflow.completed`), sleep events, retry events - none are transmitted.

## Root Cause

**The tracker layer is `Layer.scoped`, which creates a new tracker instance for each `Effect.runPromise()` call. Each instance's scope closes before events can be sent.**

### How the Tracker is Created

```typescript
// engine.ts lines 141-146
const trackerLayer: Layer.Layer<EventTracker> = trackerConfig
  ? Layer.scoped(EventTracker, createHttpBatchTracker(trackerConfig)).pipe(
      Layer.provide(FetchHttpClient.layer),
    )
  : NoopTrackerLayer;
```

`Layer.scoped` means: when this layer is provided to an effect, create a scope, run the setup (creating queues, starting consumer fiber), and when the effect completes, run finalizers (flush, shutdown).

### How Events Are Emitted

```typescript
// engine.ts line 221 - workflow.started
await Effect.runPromise(this.#withTracker(setupEffect));

// engine.ts line 311 - workflow effect (step events)
const result = await Effect.runPromiseExit(workflowEffect);

// engine.ts line 334 - workflow.completed
await Effect.runPromise(this.#withTracker(completedEffect));
```

Each `Effect.runPromise()` is a **completely independent execution** with its own runtime.

### The Fatal Sequence

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Effect.runPromise(this.#withTracker(setupEffect))                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. New scope created                                                         │
│ 2. createHttpBatchTracker runs:                                              │
│    - Creates fresh Queue A (eventQueue)                                      │
│    - Creates fresh Queue B (flushSignal)                                     │
│    - Forks consumer fiber (waiting on Queue A)                               │
│    - Registers finalizer                                                     │
│ 3. emitEvent({ type: "workflow.started" }) → Queue.offer(Queue A, event)    │
│ 4. Consumer takes event from Queue A, starts batch collection               │
│    (waits for maxWaitMs=1000ms or more events)                              │
│ 5. setupEffect completes (takes ~1-5ms)                                      │
│ 6. Scope closes → Finalizer runs:                                            │
│    - Queue.takeAll(Queue A) → EMPTY (consumer already took the event!)      │
│    - Fiber.interrupt(consumer) → Consumer interrupted before sending!        │
│ 7. Event LOST                                                                │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ Effect.runPromiseExit(workflowEffect)  // Different runtime!                │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. New scope created                                                         │
│ 2. createHttpBatchTracker runs AGAIN:                                        │
│    - Creates fresh Queue C (completely separate from Queue A!)               │
│    - Creates fresh Queue D                                                   │
│    - Forks NEW consumer fiber                                                │
│ 3. Step events emitted → Queue C                                             │
│ 4. workflowEffect completes                                                  │
│ 5. Scope closes → Same race condition → Events LOST                          │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ Effect.runPromise(this.#withTracker(completedEffect))  // Third runtime!    │
├─────────────────────────────────────────────────────────────────────────────┤
│ Same pattern → workflow.completed event LOST                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why Tests Pass

Tests use `SimpleEventCapture` which creates a synchronous layer with `Layer.succeed`:

```typescript
// test/mocks/tracker.ts lines 71-73
createLayer(): Layer.Layer<EventTracker> {
  return Layer.succeed(EventTracker, this.createService());
}
```

`Layer.succeed` is:
- Synchronous (no async setup)
- Not scoped (no finalizers)
- Events captured immediately to an in-memory array

This completely bypasses the batching/async/scope lifecycle that breaks production.

### The Race Condition in Detail

The `createHttpBatchTracker` consumer does:

```typescript
// service.ts lines 236-249
const consumer = Effect.gen(function* () {
  while (true) {
    const firstEvent = yield* Queue.take(eventQueue);  // Takes event
    const batch = [firstEvent];

    // Collect more events until maxSize or maxWaitMs (default 1000ms)
    while (batch.length < maxSize) {
      const remaining = Math.max(0, maxWaitMs - elapsed);
      if (remaining === 0) break;

      // Wait for more events OR flush signal OR timeout
      const result = yield* Effect.raceAll([...]);
      // ...
    }

    yield* sendBatch(batch);  // Send happens AFTER collection
  }
});
```

The finalizer does:

```typescript
// service.ts lines 280-298
yield* Effect.addFinalizer(() =>
  Effect.gen(function* () {
    yield* Queue.offer(flushSignal, undefined);
    const remaining = yield* Queue.takeAll(eventQueue);  // Empty! Consumer took it.
    if (Chunk.size(remaining) > 0) {
      yield* sendBatch(remaining);  // Never runs
    }
    yield* Fiber.interrupt(consumerFiber);  // Kills consumer before it sends!
  }),
);
```

Timeline:
1. `emit()` adds event to queue
2. Consumer's `Queue.take()` removes event from queue
3. Consumer starts batch timeout (waiting 1000ms)
4. Effect completes (~5ms later)
5. Scope closes
6. Finalizer's `Queue.takeAll()` finds empty queue
7. Finalizer interrupts consumer
8. **Event is in consumer's local `batch` array - never sent, lost forever**

## Why This Wasn't Caught

1. **Tests use different layer type**: `Layer.succeed` vs `Layer.scoped`
2. **No integration test with real HTTP**: Tests mock the tracker
3. **Silent failure**: `emitEvent` uses `serviceOption`, so missing tracker = silent no-op
4. **Batching hides the problem**: Single events don't trigger immediate send

## Solution: Single Tracker Instance Per Workflow Execution

The tracker should be created **once** and live for the **entire workflow execution** (across all `Effect.runPromise` calls).

### Implementation

**1. Create tracker service eagerly (not as a layer):**

```typescript
// In createDurableWorkflows, create a shared tracker promise
const getTracker = trackerConfig
  ? () => Effect.runPromise(
      Effect.scoped(
        createHttpBatchTracker(trackerConfig).pipe(
          Effect.provide(FetchHttpClient.layer)
        )
      )
    )
  : () => Promise.resolve(noopTracker);
```

Wait, this still has the scope problem. Let me think differently...

**Better approach: Use `Layer.succeed` with a pre-created service, or restructure to single execution:**

```typescript
export function createDurableWorkflows<const T extends WorkflowRegistry>(
  workflows: T,
  options?: CreateDurableWorkflowsOptions,
): new (state: DurableObjectState, env: unknown) => DurableWorkflowInstance<T> {
  const trackerConfig = options?.tracker;

  return class DurableWorkflowEngine extends DurableObject implements TypedWorkflowEngine<T> {
    readonly #workflows: T = workflows;

    /**
     * Run a workflow with the given call.
     */
    async run(call: WorkflowCall<T>): Promise<WorkflowRunResult> {
      const { workflow: workflowName, input } = call;
      const workflowId = this.ctx.id.toString();

      // ... validation and idempotency checks ...

      // Create tracker layer for THIS execution
      const trackerLayer: Layer.Layer<EventTracker> = trackerConfig
        ? Layer.scoped(EventTracker, createHttpBatchTracker(trackerConfig)).pipe(
            Layer.provide(FetchHttpClient.layer),
          )
        : NoopTrackerLayer;

      // Single scoped execution that encompasses ALL events
      const fullExecution = Effect.scoped(
        Effect.gen(function* () {
          // Store metadata and emit workflow.started
          yield* storeWorkflowMeta(storage, String(workflowName), input);
          yield* setWorkflowStatus(storage, { _tag: "Running" });
          yield* emitEvent({
            ...createBaseEvent(workflowId, String(workflowName)),
            type: "workflow.started",
            input,
          });

          // Execute workflow
          const result = yield* Effect.exit(workflowDef.definition(input).pipe(
            Effect.provideService(ExecutionContext, execCtx),
            Effect.provideService(WorkflowContext, workflowCtx),
          ));

          // Handle result and emit completion event (all in same scope)
          if (result._tag === "Success") {
            yield* setWorkflowStatus(storage, { _tag: "Completed", completedAt: Date.now() });
            yield* emitEvent({
              ...createBaseEvent(workflowId, String(workflowName)),
              type: "workflow.completed",
              // ...
            });
          } else if (/* pause */) {
            yield* emitEvent({ type: "workflow.paused", ... });
          } else {
            yield* emitEvent({ type: "workflow.failed", ... });
          }

          // Scope closes here → finalizer flushes all events in one batch
        })
      ).pipe(Effect.provide(trackerLayer));

      await Effect.runPromise(fullExecution);
      return { id: workflowId };
    }
  };
}
```

### Key Changes

1. **Single `Effect.scoped` wraps the entire execution** - setup, workflow, and completion events
2. **Single `Effect.runPromise` call** - one runtime, one tracker instance
3. **Tracker scope matches workflow scope** - finalizer runs after ALL events are emitted
4. **Batching works** - all events collected in same queue, sent together on scope close

### Benefits

- All events from one workflow execution go to the same tracker instance
- Scope closes AFTER all events are emitted
- Finalizer can properly flush the batch
- No race condition between consumer and finalizer

### Alternative: Synchronous Tracker

If batching isn't needed, use a synchronous tracker that sends immediately:

```typescript
export const createSyncTracker = (config: EventTrackerConfig): EventTrackerService => ({
  emit: (event) => Effect.gen(function* () {
    const enriched = enrichEvent(event, config.env, config.serviceKey);
    yield* HttpClientRequest.post(config.url).pipe(
      HttpClientRequest.bodyJson({ events: [enriched] }),
      // ... immediate send
    );
  }),
  flush: Effect.void,
  pendingCount: Effect.succeed(0),
});
```

This would work with the current multi-`runPromise` structure but loses batching benefits.

## Recommendation

Restructure `engine.ts` to use a **single scoped execution** per workflow run. This:

1. Fixes the root cause (scope lifecycle)
2. Preserves batching benefits
3. Simplifies the code (no `#withTracker` helper needed)
4. Makes the tracker lifecycle explicit and correct
