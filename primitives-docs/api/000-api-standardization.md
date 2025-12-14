# Jobs API Standardization

This document defines the standard naming conventions and patterns across all durable jobs to ensure consistency and predictability.

---

## Executive Summary: Changes Required

| Primitive | Current | Change To | Reason |
|-----------|---------|-----------|--------|
| WorkerPool | `process` | `execute` | Consistent main handler name |
| Debounce | `inputSchema` | `eventSchema` | Consistent schema naming |
| Debounce | `currentState: S \| undefined` | `state: S \| null` | Consistent null semantics |
| Continuous | `scheduleNext(when)` | `schedule(when)` | Shorter, matches Task |

---

## 1. Main Handler: `execute`

**Standard**: All jobs use `execute` as the main execution handler.

| Primitive | Handler | Description |
|-----------|---------|-------------|
| Continuous | `execute(ctx)` | Called on each scheduled alarm |
| Debounce | `execute(ctx)` | Called when debounce flushes |
| WorkerPool | `execute(ctx)` | Called for each event (one at a time) |
| Task | `execute(ctx)` | Called for each event |

**Rationale**: "Execute" is the universal term for "do the main work". While "process" is also valid, having one consistent name reduces cognitive load.

```ts
// All jobs follow this pattern:
Primitive.make({
  execute: (ctx) => Effect.gen(function* () {
    // Main work happens here
  }),
});
```

---

## 2. Schema Naming: `eventSchema` and `stateSchema`

**Standard**: Use `eventSchema` for incoming event schema, `stateSchema` for persistent state schema.

| Primitive | Event Schema | State Schema | Notes |
|-----------|-------------|--------------|-------|
| Continuous | N/A | `stateSchema` (required) | Schedule-driven, no events |
| Debounce | `eventSchema` | `stateSchema` (optional) | Defaults to eventSchema |
| WorkerPool | `eventSchema` | N/A | No persistent state |
| Task | `eventSchema` | `stateSchema` (optional) | Both optional |

**Change Required**: Debounce currently uses `inputSchema` → rename to `eventSchema`.

```ts
// Debounce - BEFORE
Debounce.make({
  inputSchema: MyEvent,  // ❌ Old
  stateSchema: MyState,
});

// Debounce - AFTER
Debounce.make({
  eventSchema: MyEvent,  // ✅ Standard
  stateSchema: MyState,
});
```

---

## 3. Null Semantics for State

**Standard**: State is `null` when uninitialized (first event), `undefined` when instance doesn't exist.

| Value | Meaning |
|-------|---------|
| `S` | State exists and has value |
| `null` | Instance exists, but state not yet set (first event) |
| `undefined` | Instance does not exist (client getState only) |

**Context Access**:
```ts
// In execute context
readonly state: Effect.Effect<S | null, never, never>;

// Returns null on first event, S on subsequent events
const state = yield* ctx.state;
if (state === null) {
  // First event - initialize state
}
```

**Client Access**:
```ts
// Client getState returns undefined if instance doesn't exist
const state = yield* client.task("name").getState(id);
// state: S | null | undefined

if (state === undefined) {
  // Instance doesn't exist
} else if (state === null) {
  // Instance exists but no state set yet
} else {
  // Instance exists with state
}
```

**Change Required**: Debounce's `onEvent` uses `currentState: S | undefined` → change to `state: S | null`.

---

## 4. Context Property Patterns

### 4.1 Effect vs Direct Value

**Standard**: Use Effects for stored/async data, direct values for current-invocation data.

| Property Type | Access Pattern | Example |
|--------------|----------------|---------|
| Stored data | `Effect<T>` | `ctx.state`, `ctx.eventCount`, `ctx.createdAt` |
| Current invocation | Direct value | `ctx.instanceId`, `ctx.executionStartedAt` |

```ts
interface StandardContext<S> {
  // Stored data - requires yield*
  readonly state: Effect.Effect<S | null, never, never>;
  readonly eventCount: Effect.Effect<number, never, never>;
  readonly createdAt: Effect.Effect<number, never, never>;

  // Current invocation - direct access
  readonly instanceId: string;
  readonly executionStartedAt: number;
}
```

### 4.2 Event Access

**Standard**: Events are accessed via Effect.

```ts
// In execute context
readonly event: Effect.Effect<E, never, never>;

// Usage
const event = yield* ctx.event;
```

**Exception**: Debounce's `onEvent` reducer receives event as direct value since it's a synchronous reducer:

```ts
// Debounce's onEvent is a special case - synchronous reducer
onEvent: (ctx) => {
  const { event, state } = ctx;  // Direct values, not Effects
  return newState;  // Synchronous return
}
```

### 4.3 Standard Timestamp Properties

| Property | Type | Description |
|----------|------|-------------|
| `executionStartedAt` | `number` | When current execution started |
| `createdAt` | `Effect<number>` | When instance was first created |

Primitive-specific:
- WorkerPool: `enworkerPooldAt: number` - when event was enworkerPoold
- Debounce: `debounceStartedAt: Effect<number>` - when first event arrived

### 4.4 Standard Count Properties

| Property | Type | Description |
|----------|------|-------------|
| `eventCount` | `Effect<number>` | Total events processed by instance |

Primitive-specific:
- Continuous: `runCount: Effect<number>` (same concept, different name for clarity)
- WorkerPool: `pendingCount: Effect<number>`, `processedCount: Effect<number>`

---

## 5. Schedule API

**Standard**: Use `schedule()` for scheduling, not `scheduleNext()`.

| Method | Description |
|--------|-------------|
| `schedule(when)` | Schedule alarm to fire at time/duration |
| `cancelSchedule()` | Cancel any scheduled alarm |
| `getScheduledTime()` | Get currently scheduled time (if any) |

**Change Required**: Continuous uses `scheduleNext()` → rename to `schedule()`.

```ts
// Continuous - BEFORE
yield* ctx.scheduleNext(Duration.hours(1));  // ❌ Old

// Continuous - AFTER
yield* ctx.schedule(Duration.hours(1));  // ✅ Standard
```

**Signature**:
```ts
readonly schedule: (
  when: Duration.DurationInput | number | Date
) => Effect.Effect<void, never, never>;
```

---

## 6. Purge API

**Standard**: Jobs with manual purge control use these methods:

| Method | Description | Return |
|--------|-------------|--------|
| `purge()` | Delete all state immediately | `Effect<never>` |
| `schedulePurge(when)` | Schedule future deletion | `Effect<void>` |
| `cancelPurge()` | Cancel scheduled purge | `Effect<void>` |

**Stop vs Purge**:
- `stop(reason)` - Continuous-specific: stops recurring execution AND purges
- `purge()` - Task-specific: just deletes data

This distinction is intentional:
- Continuous is a "running process" that you "stop"
- Task is "data" that you "purge"

---

## 7. Error Handling

**Standard**: Use `onError` for general errors, `onDeadLetter` for exhausted retries.

| Primitive | Handler | When Called |
|-----------|---------|-------------|
| Continuous | `onError` | Any error in `execute` |
| Debounce | `onError` | Any error in `execute` |
| WorkerPool | `onDeadLetter` | Event fails after all retries |
| Task | `onError` | Any error in `execute` or `onAlarm` |

WorkerPool's `onDeadLetter` is semantically different - it's specifically for events that exhausted all retry attempts. This is the standard workerPool/messaging pattern.

**Signature for onError**:
```ts
readonly onError?: (
  error: E,
  ctx: ErrorContext<S>
) => Effect.Effect<void, never, R>;
```

**Signature for onDeadLetter**:
```ts
readonly onDeadLetter?: (
  event: E,
  error: Err,
  ctx: DeadLetterContext
) => Effect.Effect<void, never, R>;
```

---

## 8. Client API Verbs

**Standard**: Each primitive uses domain-appropriate verbs, but follows consistent patterns.

### Sending Events

| Primitive | Method | Rationale |
|-----------|--------|-----------|
| Continuous | `start({ id, input })` | Starting a process |
| Debounce | `add({ id, event })` | Adding to a debounce |
| WorkerPool | `enworkerPool({ id, event })` | Adding to a workerPool |
| Task | `send({ id, event })` | Sending an event |

These are intentionally different because the mental model differs:
- Debounce: You "add" items to a debounce
- WorkerPool: You "enworkerPool" jobs to a workerPool
- Task: You "send" events to a task
- Continuous: You "start" a recurring process

### Common Methods

All jobs support:

| Method | Description |
|--------|-------------|
| `status(id)` | Get current status |
| `getState(id)` | Get current state (if applicable) |

Primitive-specific:

| Primitive | Methods |
|-----------|---------|
| Continuous | `stop(id)`, `trigger(id)` |
| Debounce | `flush(id)`, `clear(id)` |
| WorkerPool | `pause()`, `resume()`, `cancel(id)`, `drain()` |
| Task | `trigger(id)`, `purge(id)` |

---

## 9. First Event Detection

**Standard Pattern**: Check if state is null.

```ts
execute: (ctx) =>
  Effect.gen(function* () {
    const state = yield* ctx.state;

    if (state === null) {
      // First event - initialize state
      yield* ctx.setState(initialState);
      return;
    }

    // Subsequent events - update state
    yield* ctx.updateState((s) => ({ ... }));
  }),
```

**Convenience Helper** (Task only):
```ts
execute: (ctx) =>
  Effect.gen(function* () {
    const isFirst = yield* ctx.isFirstEvent;
    // ...
  }),
```

Consider adding `isFirstEvent` to Debounce if there's demand.

---

## 10. Summary of Changes

### Debounce Changes
```ts
// BEFORE
Debounce.make({
  inputSchema: MyEvent,  // ❌
  onEvent: (ctx) => {
    const { event, currentState } = ctx;  // currentState: S | undefined ❌
    // ...
  },
});

// AFTER
Debounce.make({
  eventSchema: MyEvent,  // ✅
  onEvent: (ctx) => {
    const { event, state } = ctx;  // state: S | null ✅
    // ...
  },
});
```

### WorkerPool Changes
```ts
// BEFORE
WorkerPool.make({
  process: (ctx) => { ... },  // ❌
});

// AFTER
WorkerPool.make({
  execute: (ctx) => { ... },  // ✅
});
```

### Continuous Changes
```ts
// BEFORE
execute: (ctx) =>
  Effect.gen(function* () {
    yield* ctx.scheduleNext(Duration.hours(1));  // ❌
  }),

// AFTER
execute: (ctx) =>
  Effect.gen(function* () {
    yield* ctx.schedule(Duration.hours(1));  // ✅
  }),
```

---

## 11. Complete Standard Context Shapes

### Base Context (all jobs)
```ts
interface BaseContext {
  readonly instanceId: string;
  readonly executionStartedAt: number;
}
```

### Event-Driven Context (Debounce, WorkerPool, Task)
```ts
interface EventContext<E> extends BaseContext {
  readonly event: Effect.Effect<E, never, never>;
  readonly eventId: string | undefined;
  readonly eventCount: Effect.Effect<number, never, never>;
}
```

### Stateful Context (Continuous, Debounce execute, Task)
```ts
interface StatefulContext<S> extends BaseContext {
  readonly state: Effect.Effect<S | null, never, never>;
  readonly setState: (state: S) => Effect.Effect<void, never, never>;
  readonly updateState: (updater: (s: S) => Partial<S>) => Effect.Effect<void, never, never>;
  readonly createdAt: Effect.Effect<number, never, never>;
}
```

### Schedulable Context (Continuous, Task)
```ts
interface SchedulableContext extends BaseContext {
  readonly schedule: (when: Duration.DurationInput | number | Date) => Effect.Effect<void, never, never>;
  readonly cancelSchedule: () => Effect.Effect<void, never, never>;
  readonly getScheduledTime: () => Effect.Effect<number | null, never, never>;
}
```

### Purgeable Context (Task)
```ts
interface PurgeableContext extends BaseContext {
  readonly purge: () => Effect.Effect<never, never, never>;
  readonly schedulePurge: (when: Duration.DurationInput | number | Date) => Effect.Effect<void, never, never>;
  readonly cancelPurge: () => Effect.Effect<void, never, never>;
}
```

---

## 12. Primitive Context Compositions

| Primitive | Contexts |
|-----------|----------|
| Continuous | Base + Stateful + Schedulable |
| Debounce (execute) | Base + Stateful (read-only) |
| Debounce (onEvent) | Special reducer context |
| WorkerPool | Base + Event-Driven |
| Task | Base + Event-Driven + Stateful + Schedulable + Purgeable |

Task is the most powerful, combining all capabilities.

---

## Migration Checklist

- [ ] Debounce: Rename `inputSchema` to `eventSchema`
- [ ] Debounce: Rename `currentState` to `state`, change `undefined` to `null`
- [ ] WorkerPool: Rename `process` to `execute`
- [ ] Continuous: Rename `scheduleNext` to `schedule`
- [ ] Update all documentation to reflect changes
- [ ] Update all examples to use new names
