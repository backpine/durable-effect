# Report 057: Standardize Context API to Effects

**Status: IMPLEMENTED**

## Overview

This report analyzes the inconsistency between Continuous jobs (synchronous state access) and other job types (Effect-based state access), and proposes a plan to standardize all job types on the Effect pattern.

## Current State Analysis

### Continuous Jobs - Synchronous Pattern

```typescript
// packages/jobs/src/registry/types.ts
export interface ContinuousContext<S> {
  readonly state: S;                                    // synchronous getter
  readonly setState: (state: S) => void;               // synchronous void
  readonly updateState: (fn: (current: S) => S) => void;  // synchronous void
  readonly terminate: (...) => Effect.Effect<never>;    // Effect (escape hatch)
}
```

Usage in handlers:
```typescript
execute: (ctx) => Effect.gen(function* () {
  // Synchronous access - no yield needed
  const currentState = ctx.state;

  // Synchronous mutation - no yield needed
  ctx.setState({ ...ctx.state, count: ctx.state.count + 1 });

  // But terminate is still an Effect!
  if (ctx.state.shouldStop) {
    return yield* ctx.terminate();
  }
})
```

### Task Jobs - Mixed Pattern

```typescript
// TaskEventContext - SYNCHRONOUS state access
export interface TaskEventContext<S> {
  readonly state: S | null;                            // synchronous
  readonly setState: (state: S) => Effect.Effect<void>; // Effect
  readonly updateState: (...) => Effect.Effect<void>;   // Effect
}

// TaskExecuteContext - EFFECT-based state access
export interface TaskExecuteContext<S> {
  readonly state: Effect.Effect<S | null>;             // Effect
  readonly setState: (state: S) => Effect.Effect<void>; // Effect
  readonly updateState: (...) => Effect.Effect<void>;   // Effect
}
```

### Debounce Jobs - Effect-based Pattern

```typescript
export interface DebounceExecuteContext<S> {
  readonly state: Effect.Effect<S>;                    // Effect
  readonly eventCount: Effect.Effect<number>;          // Effect
}
```

## Problems with Current Inconsistency

### 1. Learning Curve / Cognitive Load

Developers must remember which job type uses which pattern:
- Continuous: `ctx.state` (synchronous)
- Task onEvent: `ctx.state` (synchronous)
- Task execute: `yield* ctx.state` (Effect)
- Debounce: `yield* ctx.state` (Effect)

This creates confusion and errors when switching between job types.

### 2. Inconsistent Mutation Semantics

Continuous uses synchronous mutations while others use Effect-based:
```typescript
// Continuous - synchronous
ctx.setState({ count: 1 });

// Task/Debounce - Effect
yield* ctx.setState({ count: 1 });
```

### 3. Mixed Patterns within Same Context

Continuous has a jarring mix where `terminate()` returns an Effect but `setState()` is synchronous:
```typescript
// Synchronous mutation
ctx.updateState(s => ({ ...s, count: s.count + 1 }));

// But this needs yield*
if (done) return yield* ctx.terminate();
```

### 4. Limits Composability

Synchronous access can't be composed with other Effects in the natural way:
```typescript
// Can't do this with synchronous state:
const newState = yield* pipe(
  ctx.state,  // Would need to be Effect
  Effect.map(s => transform(s)),
  Effect.flatMap(s => validate(s))
);
```

### 5. Hidden Implementation Details

The synchronous pattern exposes that state is pre-loaded in memory, which is an implementation detail that shouldn't leak into the API.

## Benefits of Effect-Based Pattern

### 1. Consistency

All job types use the same pattern:
```typescript
// Same pattern everywhere
const state = yield* ctx.state;
yield* ctx.setState(newState);
yield* ctx.updateState(fn);
```

### 2. Composability

Effects compose naturally:
```typescript
const result = yield* pipe(
  ctx.state,
  Effect.flatMap(s => processState(s)),
  Effect.flatMap(s => ctx.setState(s))
);
```

### 3. Lazy Evaluation

State is only loaded when actually needed:
```typescript
execute: (ctx) => Effect.gen(function* () {
  if (shouldSkip) return;  // No state loaded
  const state = yield* ctx.state;  // Load only when needed
})
```

### 4. Error Handling Integration

Effects naturally integrate with error handling:
```typescript
const state = yield* ctx.state.pipe(
  Effect.catchAll(e => Effect.succeed(defaultState))
);
```

### 5. Future Flexibility

Effect-based APIs can later add:
- Retries on storage errors
- Caching
- Validation
- Logging/telemetry

Without breaking the interface.

## Implementation Plan

### Phase 1: Update ContinuousContext Type Definition

**File: `packages/jobs/src/registry/types.ts`**

Change from synchronous to Effect-based:

```typescript
// Before
export interface ContinuousContext<S> {
  readonly state: S;
  readonly setState: (state: S) => void;
  readonly updateState: (fn: (current: S) => S) => void;
  // ...
}

// After
export interface ContinuousContext<S> {
  readonly state: Effect.Effect<S, never, never>;
  readonly setState: (state: S) => Effect.Effect<void, never, never>;
  readonly updateState: (fn: (current: S) => S) => Effect.Effect<void, never, never>;
  // ...
}
```

### Phase 2: Update Context Factory

**File: `packages/jobs/src/handlers/continuous/context.ts`**

Update `createContinuousContext` to return Effect-wrapped values:

```typescript
export function createContinuousContext<S>(
  stateHolder: StateHolder<S>,
  instanceId: string,
  runCount: number,
  jobName: string,
  attempt: number = 1
): ContinuousContext<S> {
  return {
    // Effect-wrapped state access
    get state() {
      return Effect.sync(() => stateHolder.current);
    },

    // Effect-wrapped mutations
    setState: (newState: S) =>
      Effect.sync(() => {
        stateHolder.current = newState;
        stateHolder.dirty = true;
      }),

    updateState: (fn: (current: S) => S) =>
      Effect.sync(() => {
        stateHolder.current = fn(stateHolder.current);
        stateHolder.dirty = true;
      }),

    // ...rest unchanged
  };
}
```

### Phase 3: Update Handler Usage

**File: `packages/jobs/src/handlers/continuous/handler.ts`**

The handler doesn't need changes - it reads from `stateHolder` after execution, not from `ctx.state`.

### Phase 4: Update Example Jobs

**File: `examples/effect-worker/src/jobs.ts`**
**File: `examples/effect-worker-v2/src/jobs/heartbeat.ts`**

Update from synchronous to Effect pattern:

```typescript
// Before
execute: (ctx) =>
  Effect.gen(function* () {
    ctx.updateState((state) => ({
      ...state,
      count: state.count + 1,
    }));
  }),

// After
execute: (ctx) =>
  Effect.gen(function* () {
    yield* ctx.updateState((state) => ({
      ...state,
      count: state.count + 1,
    }));
  }),
```

### Phase 5: Standardize TaskEventContext

Currently `TaskEventContext.state` is synchronous while `TaskExecuteContext.state` is Effect-based. Standardize to Effect:

**File: `packages/jobs/src/registry/types.ts`**

```typescript
// Before
export interface TaskEventContext<S> {
  readonly state: S | null;  // synchronous
  // ...
}

// After
export interface TaskEventContext<S> {
  readonly state: Effect.Effect<S | null, never, never>;  // Effect
  // ...
}
```

**File: `packages/jobs/src/handlers/task/context.ts`**

Update `createTaskEventContext` to wrap state in Effect.

### Phase 6: Update Tests

**File: `packages/jobs/test/handlers/continuous.test.ts`**

Update test fixtures to use Effect pattern:

```typescript
// Before
execute: (ctx) => Effect.gen(function* () {
  ctx.updateState((s) => ({ ...s, count: s.count + 1 }));
})

// After
execute: (ctx) => Effect.gen(function* () {
  yield* ctx.updateState((s) => ({ ...s, count: s.count + 1 }));
})
```

### Phase 7: Update Documentation Comments

Update JSDoc comments in registry/types.ts to reflect Effect-based access patterns.

## Migration Summary

| Job Type | Property | Before | After |
|----------|----------|--------|-------|
| Continuous | `state` | `S` | `Effect<S>` |
| Continuous | `setState` | `void` | `Effect<void>` |
| Continuous | `updateState` | `void` | `Effect<void>` |
| Task (onEvent) | `state` | `S \| null` | `Effect<S \| null>` |
| Task (execute) | `state` | `Effect<S \| null>` | No change |
| Debounce | `state` | `Effect<S>` | No change |

## Breaking Changes

This is a **breaking change** for:
1. All existing Continuous job definitions
2. Task job onEvent handlers that access `ctx.state` synchronously

Migration is straightforward - add `yield*` before state access/mutations.

## Recommendation

**Proceed with implementation.** The consistency and composability benefits outweigh the migration cost. The migration pattern is mechanical and can be documented clearly:

```typescript
// Migration guide
// Before: ctx.state
// After:  yield* ctx.state

// Before: ctx.setState(newState)
// After:  yield* ctx.setState(newState)

// Before: ctx.updateState(fn)
// After:  yield* ctx.updateState(fn)
```

## Timeline

- Phase 1-3: Core type and context changes
- Phase 4: Example updates
- Phase 5: TaskEventContext standardization
- Phase 6: Test updates
- Phase 7: Documentation

## Implementation Summary

All phases completed successfully:

1. **ContinuousContext** - Updated type and context factory to use Effect-wrapped state access
2. **TaskEventContext** - Updated `state` property from synchronous to Effect-based
3. **Examples** - Updated `effect-worker/src/jobs.ts` and `effect-worker-v2/src/jobs/heartbeat.ts`
4. **Tests** - Updated all continuous handler test fixtures

### Files Modified

- `packages/jobs/src/registry/types.ts` - ContinuousContext and TaskEventContext types
- `packages/jobs/src/handlers/continuous/context.ts` - createContinuousContext factory
- `packages/jobs/src/handlers/task/context.ts` - createTaskEventContext factory
- `examples/effect-worker/src/jobs.ts` - tokenRefresher and countdownTimer examples
- `examples/effect-worker-v2/src/jobs/heartbeat.ts` - heartbeat example
- `packages/jobs/test/handlers/continuous.test.ts` - test fixtures

### Results

- All 71 jobs tests pass
- All 266 workflow tests pass
- Build succeeds for all packages
