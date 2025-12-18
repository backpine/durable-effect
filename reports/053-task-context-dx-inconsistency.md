# Report 053: Task Context API DX Inconsistency

## Summary

The Task job type (and other job types) have inconsistent patterns for accessing `state` and `event` across different handler contexts. This creates confusion about when to use `yield*` and leads to runtime errors or confusing TypeScript messages.

---

## Current State: The Inconsistency Problem

### Task Job Type

| Handler | `event` | `state` | `setState` |
|---------|---------|---------|------------|
| `onEvent` | `E` (direct) | `S \| null` (direct) | `Effect<void>` |
| `execute` | N/A | `Effect<S \| null>` | `Effect<void>` |
| `onIdle` | N/A | `Effect<S \| null>` | N/A |
| `onError` | N/A | `Effect<S \| null>` | N/A |

**Problem:** `state` is a direct value in `onEvent` but an Effect in `execute`.

```typescript
// In onEvent - NO yield needed
onEvent: (ctx) => Effect.gen(function* () {
  const event = ctx.event;      // ✓ Direct
  const state = ctx.state;      // ✓ Direct
  yield* ctx.setState(newState); // ✓ Effect
})

// In execute - YES yield needed
execute: (ctx) => Effect.gen(function* () {
  const state = yield* ctx.state;  // ✓ Effect - but same property name!
  yield* ctx.setState(newState);   // ✓ Effect
})
```

### Cross-Job Type Comparison

| Job Type | Handler | state | event | setState |
|----------|---------|-------|-------|----------|
| **Continuous** | execute | `S` (direct) | N/A | `void` (sync!) |
| **Debounce** | onEvent | `S` (direct) | `I` (direct) | N/A |
| **Debounce** | execute | `Effect<S>` | N/A | N/A |
| **WorkerPool** | execute | N/A | `E` (direct) | N/A |
| **Task** | onEvent | `S \| null` (direct) | `E` (direct) | `Effect<void>` |
| **Task** | execute | `Effect<S \| null>` | N/A | `Effect<void>` |

**Problems:**
1. Same property (`state`) has different types in different contexts
2. `setState` is synchronous in Continuous but Effect-based in Task
3. No consistent pattern across job types

---

## Why This Is Confusing

### 1. TypeScript Errors Are Cryptic

When developers mistakenly use `yield*` on a direct value:

```typescript
onEvent: (ctx) => Effect.gen(function* () {
  const event = yield* ctx.event;  // Wrong!
})
```

TypeScript error:
```
Type '{ readonly targetRuns: number; }' must have a '[Symbol.iterator]()' method
```

This doesn't tell them "don't yield this" - it's a low-level iterator error.

### 2. Mental Model Mismatch

Developers expect consistency:
- "If `setState` is an Effect, surely `state` is too"
- "If `state` needs yield in `execute`, surely it does in `onEvent` too"

### 3. Copy-Paste Bugs

Code copied from `execute` to `onEvent` (or vice versa) silently breaks:

```typescript
// Works in execute:
const state = yield* ctx.state;

// Silently wrong in onEvent (yields undefined-ish behavior):
const state = yield* ctx.state;  // ctx.state is already the value!
```

---

## Recommended Solutions

### Option A: Separate Event Parameter (Recommended)

Pass `event` as a separate parameter to make the API self-documenting:

```typescript
// Current (confusing)
onEvent: (ctx) => Effect.gen(function* () {
  const event = ctx.event;  // Is this an Effect? Who knows!
})

// Proposed (clear)
onEvent: (event, ctx) => Effect.gen(function* () {
  // event is obviously a direct value - it's a parameter!
  const state = ctx.state;  // Still direct in onEvent
})
```

**Implementation:**

```typescript
// In registry/types.ts
export interface UnregisteredTaskDefinition<S, E, Err, R> {
  // Change signature from (ctx) to (event, ctx)
  onEvent(event: E, ctx: TaskEventContext<S>): Effect.Effect<void, Err, R>;
  // ...
}

// Remove event from TaskEventContext
export interface TaskEventContext<S> {
  readonly state: S | null;
  readonly setState: (state: S) => Effect.Effect<void, never, never>;
  // ... (no event property)
}
```

**Usage becomes:**

```typescript
const myTask = Task.make({
  eventSchema: MyEvent,
  stateSchema: MyState,

  onEvent: (event, ctx) => Effect.gen(function* () {
    // Clear: event is a parameter, must be direct value
    console.log(event.type);

    // Clear: ctx.state follows same pattern as ctx.setState
    if (ctx.state === null) {
      yield* ctx.setState({ count: 0 });
    }
  }),

  execute: (ctx) => Effect.gen(function* () {
    const state = yield* ctx.state;  // Different context, different pattern
  }),
});
```

**Pros:**
- Self-documenting API
- Consistent with `onError: (error, ctx) =>` pattern already used
- TypeScript naturally infers correct types
- No ambiguity about what needs yielding

**Cons:**
- Breaking change to existing code

---

### Option B: Unify State Access Pattern

Make `state` always an Effect across all contexts:

```typescript
// All contexts use Effect for state
export interface TaskEventContext<S, E> {
  readonly event: E;  // Direct (it's the trigger, always available)
  readonly state: Effect.Effect<S | null, never, never>;  // Always Effect
}

export interface TaskExecuteContext<S> {
  readonly state: Effect.Effect<S | null, never, never>;  // Same pattern
}
```

**Usage:**

```typescript
onEvent: (ctx) => Effect.gen(function* () {
  const event = ctx.event;        // Direct - it's the trigger
  const state = yield* ctx.state; // Effect - consistent everywhere
})

execute: (ctx) => Effect.gen(function* () {
  const state = yield* ctx.state; // Effect - same pattern!
})
```

**Pros:**
- Consistent mental model
- `state` always needs yield

**Cons:**
- More verbose for `onEvent` where state is already loaded
- Still has mixed pattern (event is direct, state is Effect)

---

### Option C: Type-Level Documentation with Branded Types

Use branded types to make the difference visible:

```typescript
// Branded types for clarity
type SyncValue<T> = T & { readonly _sync: unique symbol };
type AsyncValue<T> = Effect.Effect<T, never, never> & { readonly _async: unique symbol };

export interface TaskEventContext<S, E> {
  readonly event: SyncValue<E>;      // Type hints "sync"
  readonly state: SyncValue<S | null>;
}

export interface TaskExecuteContext<S> {
  readonly state: AsyncValue<S | null>;  // Type hints "async"
}
```

**Pros:**
- IDE shows different types
- Backward compatible

**Cons:**
- Confusing branded types
- Doesn't prevent misuse at runtime

---

### Option D: Accessor Methods Instead of Properties

Replace properties with explicit getter methods:

```typescript
export interface TaskEventContext<S, E> {
  readonly getEvent: () => E;           // Sync getter
  readonly getState: () => S | null;    // Sync getter
  readonly setState: (s: S) => Effect.Effect<void>;
}

export interface TaskExecuteContext<S> {
  readonly getState: () => Effect.Effect<S | null>;  // Async getter
  readonly setState: (s: S) => Effect.Effect<void>;
}
```

**Usage:**

```typescript
onEvent: (ctx) => Effect.gen(function* () {
  const event = ctx.getEvent();  // Sync - obvious from ()
  const state = ctx.getState();  // Sync - returns value directly
})

execute: (ctx) => Effect.gen(function* () {
  const state = yield* ctx.getState();  // Async - returns Effect
})
```

**Pros:**
- Method syntax hints at behavior
- TypeScript forces correct usage

**Cons:**
- More verbose
- Still not perfectly clear

---

## Recommendation

**Option A (Separate Event Parameter)** is the best choice because:

1. **Self-documenting**: Parameters are obviously direct values
2. **Consistent with existing patterns**: `onError: (error, ctx) =>` already does this
3. **Type-safe**: No way to accidentally yield a parameter
4. **Clean migration**: Simple find-replace refactor

### Migration Path

```typescript
// Before
onEvent: (ctx) => Effect.gen(function* () {
  const event = ctx.event;
  // ...
})

// After
onEvent: (event, ctx) => Effect.gen(function* () {
  // event is now a parameter
  // ...
})
```

This is a mechanical transformation that can be done with a codemod.

---

## Implementation Plan

### Phase 1: Update Type Definitions

```typescript
// registry/types.ts
export interface TaskEventContext<S> {  // Remove E from generic
  // Remove: readonly event: E;
  readonly state: S | null;
  readonly setState: (state: S) => Effect.Effect<void, never, never>;
  readonly updateState: (fn: (current: S) => S) => Effect.Effect<void, never, never>;
  // ... rest unchanged
}

export interface UnregisteredTaskDefinition<S, E, Err, R> {
  // Change signature
  onEvent(event: E, ctx: TaskEventContext<S>): Effect.Effect<void, Err, R>;
  // ... rest unchanged
}
```

### Phase 2: Update Context Factory

```typescript
// handlers/task/context.ts
export function createTaskEventContext<S>(
  stateHolder: TaskStateHolder<S>,
  scheduleHolder: TaskScheduleHolder,
  // Remove: event: E,
  instanceId: string,
  // ...
): TaskEventContext<S> {  // Remove E
  return {
    // Remove: event,
    get state() { return stateHolder.current; },
    // ...
  };
}
```

### Phase 3: Update Handler

```typescript
// handlers/task/handler.ts
if (triggerType === "onEvent") {
  const ctx = createTaskEventContext(
    proxyStateHolder,
    scheduleHolder,
    // event removed from here
    base.instanceId,
    // ...
  );
  // Pass event as first argument to user's handler
  yield* runWithErrorHandling(def.onEvent(validatedEvent, ctx), "onEvent");
}
```

### Phase 4: Update Definition Factory

```typescript
// definitions/task.ts
export interface TaskMakeConfig<S, E, Err, R> {
  // Update signature
  onEvent(event: E, ctx: TaskEventContext<S>): Effect.Effect<void, Err, R>;
}
```

---

## Also Consider: Apply to Debounce

The same pattern could apply to Debounce:

```typescript
// Current
onEvent: (ctx) => Effect.gen(function* () {
  const event = ctx.event;
  const state = ctx.state;
})

// Proposed
onEvent: (event, ctx) => Effect.gen(function* () {
  // event is parameter
  // state still on ctx (it's derived, not the trigger)
})
```

This would make all "event handler" signatures consistent:
- `onEvent: (event, ctx) => ...`
- `onError: (error, ctx) => ...`
