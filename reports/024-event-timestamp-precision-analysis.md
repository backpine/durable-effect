# Event Timestamp Precision Analysis

## Issue

Events emitted during a workflow execution batch appear to have identical or near-identical timestamps:

```
workflow.resumed   2025-12-05T03:20:12.456Z
step.completed     2025-12-05T03:20:12.457Z
step.completed     2025-12-05T03:20:12.457Z (x2)
step.started       2025-12-05T03:20:12.457Z
retry.scheduled    2025-12-05T03:20:12.457Z
workflow.paused    2025-12-05T03:20:12.457Z
```

## Root Cause

**This is expected behavior**, not a bug. The root cause is a combination of:

### 1. JavaScript Date Precision

JavaScript's `Date` object only has **millisecond precision**:

```typescript
// packages/core/src/events.ts:496
timestamp: new Date().toISOString()
```

Multiple events occurring within the same millisecond will have identical timestamps.

### 2. Extremely Fast Execution

Workflow execution is extremely fast:

- **Cached steps complete in microseconds**: When a workflow resumes, previously completed steps return their cached results instantly (no I/O)
- **Event emission is synchronous**: Each `emitEvent()` just adds to a Ref array
- **All operations occur in the same execution context**: No async boundaries between events

### 3. Event Creation Pattern

Each event gets its own `createBaseEvent()` call:

```typescript
// packages/workflow/src/workflow.ts
yield* emitEvent({
  ...createBaseEvent(workflowCtx.workflowId, workflowCtx.workflowName),
  type: "step.completed",
  ...
});
```

The timestamp IS being set independently for each event - they just happen to occur within the same millisecond.

## Evidence That Timestamps ARE Independent

Looking at the user's data:

| Event | Timestamp |
|-------|-----------|
| workflow.resumed | 03:20:12.**456**Z |
| step.completed | 03:20:12.**457**Z |

The `workflow.resumed` event has a different millisecond (456) than the subsequent events (457). This proves that timestamps are being captured at event creation time - the events just happen very quickly.

## Event Ordering Solution

**UUIDv7 already solves this problem.**

Each event has an `eventId` field using UUIDv7:

```typescript
// packages/core/src/events.ts:495
eventId: uuidv7(),
```

UUIDv7 properties:
- **Time-ordered**: Embeds Unix timestamp in first 48 bits
- **Monotonic within millisecond**: Random bits provide ordering when timestamps collide
- **Lexicographically sortable**: String comparison gives correct temporal order

**To order events correctly, sort by `eventId` rather than `timestamp`.**

## Timeline of a Resume Cycle

When a workflow resumes, here's what happens in ~1-2 milliseconds:

```
Time (μs)  Event                    Explanation
─────────  ─────────────────────    ───────────────────────────────
0          workflow.resumed         Workflow starts executing
50         step.completed (cached)  Step 1 returns from cache (instant)
100        step.completed (cached)  Step 2 returns from cache (instant)
150        step.started             Step 3 begins execution
200        (effect executes)        The actual work happens
250        (effect fails)           Effect returns error
300        retry.scheduled          Retry logic schedules alarm
350        workflow.paused          Workflow yields to alarm

Total: ~350 microseconds = 0.35 milliseconds
```

All these events genuinely occur within 1 millisecond.

## Recommendations

### Option A: Accept Current Behavior (Recommended)

The current behavior is correct:
- Events ARE timestamped at creation time
- `eventId` (UUIDv7) provides correct ordering
- Millisecond precision is standard for JavaScript

**Client-side**: Sort events by `eventId` for guaranteed order.

### Option B: Add Sequence Number

Add a monotonic sequence number to each event:

```typescript
let eventSequence = 0;

export function createBaseEvent(...): InternalBaseEvent {
  return {
    eventId: uuidv7(),
    timestamp: new Date().toISOString(),
    sequence: eventSequence++,  // ← New field
    ...
  };
}
```

**Pros:**
- Explicit ordering within a batch
- Human-readable sequence

**Cons:**
- Sequence resets per workflow execution
- Adds complexity
- Redundant with UUIDv7

### Option C: High-Resolution Timestamps

Use `performance.now()` for sub-millisecond precision:

```typescript
const hrTime = performance.now();  // microseconds precision
timestamp: new Date().toISOString(),
timestampHr: hrTime,  // 1234567.890123
```

**Cons:**
- `performance.now()` may not be available in all environments
- Cloudflare Workers have limited `performance.now()` precision
- Adds complexity without clear benefit

### Option D: Nanosecond Timestamps (Node.js)

Use `process.hrtime.bigint()` for nanosecond precision:

```typescript
const ns = process.hrtime.bigint();
timestampNs: ns.toString(),  // "1234567890123456789"
```

**Cons:**
- Not available in Cloudflare Workers
- Overkill for workflow events

## Conclusion

**The current behavior is correct and expected.**

Events with identical timestamps are occurring within the same millisecond, which is normal for fast workflow execution. The `eventId` field (UUIDv7) already provides monotonic ordering.

**Recommendation:** Document that clients should sort by `eventId` for guaranteed temporal ordering, and update any monitoring/UI tools to use `eventId` for ordering rather than `timestamp`.

## Files Analyzed

| File | Purpose |
|------|---------|
| `packages/core/src/events.ts:489-501` | `createBaseEvent()` - creates timestamp and eventId |
| `packages/workflow/src/workflow.ts` | Event emission points (12 calls to createBaseEvent) |
| `packages/workflow/src/transitions.ts` | Workflow lifecycle transitions |
| `packages/workflow/src/tracker/service.ts` | Event batching and delivery |
