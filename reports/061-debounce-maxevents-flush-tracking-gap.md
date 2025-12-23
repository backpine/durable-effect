# Report 061: Debounce maxEvents Flush Tracking Gap

## Problem Statement

When a flood of events causes debounce to repeatedly hit `maxEvents`, the `debounce.flushed` event is **never emitted** for these maxEvents-triggered flushes. The tracker's `flushEvents` is called after each handle, but the tracking events themselves are incomplete - only `job.executed` is emitted, not `debounce.flushed`.

This makes tracking/reporting incorrect because:
1. The UI/analytics cannot distinguish between timeout flushes and maxEvents flushes
2. The `debounce.flushed` event with `eventCount`, `reason`, and `durationMs` is never recorded for maxEvents triggers
3. The event flow diagram shows incomplete data for rapid debounce scenarios

## Root Cause Analysis

### Code Flow Comparison

**When flush is triggered by `flushAfter` timeout (alarm) or manual flush:**

```
handleAlarm() / handle("flush")
    → handleFlush(def, reason)
        → runFlush(def, reason, meta.id)
            → execution.execute() → emits job.executed ✓
        → emitEvent(debounce.flushed) ✓
        → purge()
```

**When flush is triggered by `maxEvents` in handleAdd:**

```
handle("add")
    → handleAdd(def, request)
        → runFlush(def, "maxEvents", request.id)  // Direct call!
            → execution.execute() → emits job.executed ✓
        → purge()
        // NO debounce.flushed event emitted! ✗
```

### The Gap

In `handler.ts` lines 170-188, when maxEvents is reached:

```typescript
if (def.maxEvents !== undefined && nextCount >= def.maxEvents) {
  // Immediate flush - use request.id since we just initialized or it's the same
  const result = yield* runFlush(def, "maxEvents", request.id);

  if (result.success) {
    // Success - purge state after flush
    yield* purge();
  } else if (result.terminated) {
    // Terminated by CleanupService - already purged
  }

  return { /* response */ };
}
```

Notice that `handleAdd` calls `runFlush` directly instead of `handleFlush`. The `debounce.flushed` event is only emitted in `handleFlush` (lines 232-240):

```typescript
if (result.success) {
  // Emit debounce.flushed event
  yield* emitEvent({
    ...createJobBaseEvent(runtime.instanceId, "debounce", def.name, meta.id),
    type: "debounce.flushed" as const,
    eventCount,
    reason: reason === "flushAfter" ? "timeout" : reason,
    durationMs,
  } satisfies InternalDebounceFlushedEvent);

  // Success - purge state after flush
  yield* purge();
}
```

## Event Flow Diagrams

### Current (Broken) Flow with maxEvents

```
debounce.started (flushAt=...)
    │
    │   ... (events 1-9 accumulate)
    │
    └── job.executed (runCount=1)  ← NO debounce.flushed event!
        │
        └── (purge)

debounce.started (flushAt=...)    ← New cycle starts
    │
    │   ... (events 11-19 accumulate)
    │
    └── job.executed (runCount=1)  ← NO debounce.flushed event!
        │
        └── (purge)

... continues for each batch of maxEvents ...
```

### Expected Flow with maxEvents

```
debounce.started (flushAt=...)
    │
    │   ... (events 1-10 accumulate)
    │
    ├── debounce.flushed (eventCount=10, reason=maxEvents, durationMs=123)
    │
    └── job.executed (runCount=1)
        │
        └── (purge)

debounce.started (flushAt=...)    ← New cycle starts
    │
    │   ... (events 11-20 accumulate)
    │
    ├── debounce.flushed (eventCount=10, reason=maxEvents, durationMs=456)
    │
    └── job.executed (runCount=1)
        │
        └── (purge)
```

## Impact

1. **Analytics Gaps**: Cannot track maxEvents-triggered flushes in dashboards
2. **Incorrect Metrics**: Flush reason distribution is skewed (only shows timeout/manual)
3. **Missing Event Counts**: The `eventCount` for maxEvents batches is never recorded
4. **Duration Tracking**: `durationMs` for debounce collection period is not captured

## Recommended Fix

### Option A: Emit debounce.flushed in handleAdd (Minimal Change)

Add the `debounce.flushed` event emission to `handleAdd` when maxEvents triggers:

```typescript
// In handleAdd, after runFlush for maxEvents
if (def.maxEvents !== undefined && nextCount >= def.maxEvents) {
  // Get startedAt for duration calculation
  const startedAt = yield* getStartedAt();
  const durationMs = startedAt ? Date.now() - startedAt : 0;

  const result = yield* runFlush(def, "maxEvents", request.id);

  if (result.success) {
    // Emit debounce.flushed event for maxEvents trigger
    yield* emitEvent({
      ...createJobBaseEvent(runtime.instanceId, "debounce", def.name, request.id),
      type: "debounce.flushed" as const,
      eventCount: nextCount,
      reason: "maxEvents" as const,
      durationMs,
    } satisfies InternalDebounceFlushedEvent);

    // Success - purge state after flush
    yield* purge();
  }
  // ...
}
```

**Pros:**
- Minimal code change
- Direct fix for the issue
- No changes to existing handleFlush logic

**Cons:**
- Duplicates event emission logic between handleAdd and handleFlush
- eventCount calculation slightly different (nextCount vs getEventCount)

### Option B: Route maxEvents through handleFlush (DRY)

Modify `handleAdd` to call `handleFlush` instead of `runFlush` directly:

```typescript
if (def.maxEvents !== undefined && nextCount >= def.maxEvents) {
  // Use handleFlush for consistency - it emits debounce.flushed
  const result = yield* handleFlush(def, "maxEvents");

  return {
    _type: "debounce.add" as const,
    instanceId: runtime.instanceId,
    eventCount: nextCount,
    willFlushAt: result.retryScheduled ? ((yield* alarm.getScheduled()) ?? null) : null,
    created,
    retryScheduled: result.retryScheduled,
  };
}
```

**Pros:**
- DRY - single point of event emission
- Consistent behavior between all flush triggers
- handleFlush already handles all edge cases

**Cons:**
- handleFlush returns DebounceResponse type, need to transform
- handleFlush fetches eventCount/startedAt again (minor perf impact)
- handleFlush requires metadata to exist (should be fine here)

### Option C: Extract shared flush logic (Most Robust)

Create a shared internal function for the flush-and-emit logic:

```typescript
const executeFlushWithTracking = (
  def: DebounceDefinition<any, any, any, never>,
  reason: "maxEvents" | "flushAfter" | "manual",
  id?: string
): Effect.Effect<ExecutionResult, HandlerError> =>
  Effect.gen(function* () {
    const eventCount = yield* getEventCount();
    const startedAt = yield* getStartedAt();
    const durationMs = startedAt ? Date.now() - startedAt : 0;

    const result = yield* runFlush(def, reason, id);

    if (result.success) {
      yield* emitEvent({
        ...createJobBaseEvent(runtime.instanceId, "debounce", def.name, id),
        type: "debounce.flushed" as const,
        eventCount,
        reason: reason === "flushAfter" ? "timeout" : reason,
        durationMs,
      } satisfies InternalDebounceFlushedEvent);
    }

    return result;
  });
```

Then use `executeFlushWithTracking` in both `handleAdd` (for maxEvents) and `handleFlush`.

**Pros:**
- Single source of truth for flush tracking
- Easy to test
- Clear separation of concerns

**Cons:**
- Requires refactoring handleFlush
- More code changes

## Recommendation

**Option A** is recommended for immediate fix as it has minimal blast radius and directly addresses the issue. The duplication is acceptable given the localized nature of the fix.

**Option C** should be considered for a future cleanup pass to consolidate the flush logic.

## Testing Verification

Add a test case that verifies `debounce.flushed` is emitted for maxEvents:

```typescript
it("emits debounce.flushed when maxEvents triggers flush", async () => {
  const { layer: trackerLayer, handle } = await createTestTrackerLayer();

  // Add maxEvents events
  for (let i = 0; i < 10; i++) {
    await runtime.handle({ type: "debounce", action: "add", name: "test", event: { id: i } });
  }

  const events = await handle.getEvents();

  // Should have debounce.flushed with reason=maxEvents
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "debounce.flushed",
      reason: "maxEvents",
      eventCount: 10,
    })
  );
});
```

## Additional Considerations

### Tracker Flush Timing

The original concern about "flush is not being run until the flood of events finishes" may also be related to HTTP batching. The http-batch tracker sends events when:
1. Buffer reaches `batchSize` (default 100)
2. `flush()` is explicitly called

Each `runtime.handle()` call does call `flushEvents` at the end. However, if the HTTP POST fails silently (errors are caught and ignored per line 150 in http-batch.ts), events could be lost during rapid floods.

This is a separate concern from the missing `debounce.flushed` event and should be addressed if event loss is observed.

### Event Ordering

With the fix, events will be emitted in this order for maxEvents flush:
1. `job.executed` (from execution.execute)
2. `debounce.flushed` (new, after execution)

This ordering matches the handleFlush behavior (execute first, then emit flush event).

## Files to Modify

| File | Change |
|------|--------|
| `packages/jobs/src/handlers/debounce/handler.ts` | Add debounce.flushed emission in handleAdd for maxEvents |
| `packages/jobs/test/debounce.test.ts` | Add test for maxEvents tracking |
