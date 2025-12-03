# Tracker Finalizer Race Condition

**Status: RESOLVED** - Implemented Option 3 (Ref-based tracker)

## Problem

Fast-finishing workflows lose tracker events because the finalizer in `createHttpBatchTracker` has a race condition with the background consumer fiber.

## Root Cause Analysis

The tracker uses a background consumer fiber that batches events before sending them. The issue is in the finalizer's cleanup sequence.

### Current Implementation (service.ts:236-298)

```typescript
// Background consumer (lines 236-274)
const consumer = Effect.gen(function* () {
  while (true) {
    // 1. Block waiting for first event
    const firstEvent = yield* Queue.take(eventQueue);  // <-- BLOCKING
    const batch = [firstEvent];

    // 2. Race for more events, flush signal, or timeout
    while (batch.length < maxSize) {
      const result = yield* Effect.raceAll([
        Queue.take(eventQueue),     // more events
        Queue.take(flushSignal),    // manual flush
        Effect.sleep(remaining),    // batch timeout
      ]);
      // ... collect events into batch
    }

    // 3. Send batch
    yield* sendBatch(batch);
  }
});

// Finalizer (lines 280-298)
yield* Effect.addFinalizer(() =>
  Effect.gen(function* () {
    yield* Queue.offer(flushSignal, undefined);  // A. Signal flush
    const remaining = yield* Queue.takeAll(eventQueue);  // B. Take remaining
    yield* sendBatch(remaining);
    yield* Queue.shutdown(eventQueue);  // C. Shutdown queues
    yield* Queue.shutdown(flushSignal);
    yield* Fiber.interrupt(consumerFiber);  // D. Interrupt consumer
  }),
);
```

### The Race Condition

**Scenario: Fast workflow completes before batch timeout**

```
Timeline:
─────────────────────────────────────────────────────────────────────────
Consumer Fiber                      │  Main Fiber (Finalizer)
─────────────────────────────────────────────────────────────────────────
Queue.take() waiting...             │
                                    │  emit(event1) → queue
Queue.take() returns event1         │
batch = [event1]                    │
                                    │  emit(event2) → queue
Effect.raceAll() waiting...         │
                                    │  emit(event3) → queue
                                    │  Workflow completes, scope closes
                                    │
                                    │  A. offer(flushSignal)
raceAll: flush signal wins          │
batch = [event1]                    │  B. takeAll() → [event2, event3]
                                    │     sendBatch([event2, event3])
break from loop                     │  C. shutdown(eventQueue)
                                    │  D. interrupt(consumerFiber) ← PROBLEM!
─── INTERRUPTED ───                 │
event1 LOST (in local batch var)    │
─────────────────────────────────────────────────────────────────────────
```

**The problem:** The consumer has `event1` in its local `batch` array, but gets interrupted at step D before it can call `sendBatch(batch)`.

### Why the Flush Signal Doesn't Help

The flush signal only breaks the consumer out of the `raceAll` loop. It doesn't:
1. Wait for the consumer to finish sending
2. Ensure the consumer's current batch is sent before interruption

### Additional Race: Queue.take Blocked

If consumer is blocked on the outer `Queue.take(eventQueue)` (waiting for first event):

```
Timeline:
─────────────────────────────────────────────────────────────────────────
Consumer Fiber                      │  Main Fiber (Finalizer)
─────────────────────────────────────────────────────────────────────────
Queue.take() waiting for event...   │
                                    │  emit(event1) → queue
Queue.take() returns event1         │
batch = [event1]                    │  Workflow completes immediately
raceAll() waiting...                │
                                    │  A. offer(flushSignal)
                                    │  B. takeAll() → [] (empty!)
                                    │  C. shutdown queues
                                    │  D. interrupt consumer
─── INTERRUPTED ───                 │
event1 LOST                         │
─────────────────────────────────────────────────────────────────────────
```

The `takeAll()` at step B finds an empty queue because the consumer already took the event.

## Impact

- Fast-finishing workflows lose events
- Events emitted just before workflow completion are most likely to be lost
- The faster the workflow, the more events are lost
- Multi-step workflows may lose some but not all events (timing-dependent)

## Test Evidence

The new test at `test/workflow/tracker-sync.test.ts` demonstrates this:

```
Test: "should send all events when workflow completes quickly"
Expected: 4+ events (workflow.started, step.started, step.completed, workflow.completed)
Actual: 2 events
Result: FAIL - Events lost due to race condition
```

## Proposed Fix

The finalizer needs to **wait for the consumer to finish** before interrupting it.

### Option 1: Join with Timeout

```typescript
yield* Effect.addFinalizer(() =>
  Effect.gen(function* () {
    // Signal flush
    yield* Queue.offer(flushSignal, undefined);

    // Shutdown queue - this will cause Queue.take to fail
    yield* Queue.shutdown(eventQueue);
    yield* Queue.shutdown(flushSignal);

    // Wait for consumer to finish (with timeout)
    yield* Fiber.join(consumerFiber).pipe(
      Effect.timeout(Duration.millis(5000)),
      Effect.ignore, // Ignore timeout/errors - we tried our best
    );
  }),
);
```

### Option 2: Graceful Shutdown Flag

```typescript
const shutdownRef = yield* Ref.make(false);

const consumer = Effect.gen(function* () {
  while (!(yield* Ref.get(shutdownRef))) {
    // ... same logic but check shutdown flag
  }
});

yield* Effect.addFinalizer(() =>
  Effect.gen(function* () {
    yield* Ref.set(shutdownRef, true);
    yield* Queue.offer(flushSignal, undefined);
    yield* Fiber.join(consumerFiber).pipe(Effect.timeout(...), Effect.ignore);
  }),
);
```

### Option 3: Remove Background Consumer (Simpler)

For the Cloudflare Workers environment where workflows are short-lived, a simpler synchronous approach might be better:

```typescript
// Accumulate events in a Ref instead of Queue+Consumer
const eventsRef = yield* Ref.make<InternalWorkflowEvent[]>([]);

return {
  emit: (event) => Ref.update(eventsRef, (events) => [...events, event]),
  flush: Effect.gen(function* () {
    const events = yield* Ref.getAndSet(eventsRef, []);
    yield* sendBatch(events);
  }),
};

// Finalizer just calls flush
yield* Effect.addFinalizer(() => flush);
```

## Recommendation

**Option 3** is recommended for this use case because:
1. Simpler - no background fiber, no race conditions
2. Predictable - events are sent synchronously on flush
3. Appropriate for Cloudflare Workers where request lifetime is bounded
4. The engine already calls `flushEvents` explicitly before scope closes

The background consumer pattern is better suited for long-running services where batching provides real throughput benefits. For short-lived workflows, the complexity isn't worth it.

## Resolution

**Option 3 was implemented** in `packages/workflow/src/tracker/service.ts`.

### Changes Made

1. **Replaced Queue+Consumer with Ref**: Events are now accumulated in a `Ref<InternalWorkflowEvent[]>` instead of a sliding queue with a background consumer fiber.

2. **Simplified flush logic**: The `flush` effect atomically takes all events from the Ref and sends them synchronously.

3. **Removed race condition**: No background fiber means no race between the consumer and finalizer.

4. **Added test coverage**: New test file `test/workflow/tracker-sync.test.ts` verifies that fast-finishing workflows correctly send all events.

### Code Diff Summary

```typescript
// Before: Queue + Background Consumer
const eventQueue = yield* Queue.sliding<InternalWorkflowEvent>(1000);
const consumerFiber = yield* Effect.fork(consumer);
// ... complex race condition prone logic

// After: Simple Ref
const eventsRef = yield* Ref.make<InternalWorkflowEvent[]>([]);

return {
  emit: (event) => Ref.update(eventsRef, (events) => [...events, event]),
  flush: Effect.gen(function* () {
    const events = yield* Ref.getAndSet(eventsRef, []);
    yield* sendBatch(events);
  }),
  pendingCount: Ref.get(eventsRef).pipe(Effect.map((e) => e.length)),
};
```

### Test Results

All 148 tests pass, including 4 new tracker sync tests that specifically verify events are not lost for fast-finishing workflows.
