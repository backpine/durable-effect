# Task `onIdle` Naming Analysis

## Issue

The `onIdle` callback in Task is misleadingly named. The actual trigger condition is:

> **Called when `onEvent` or `execute` completes AND no alarm is scheduled**

This is not "idle" in the traditional sense. A task with state but no schedule is "waiting for events", not "idle". The current name creates confusion about when the callback fires.

## Current Behavior Analysis

### Task Handler Flow (handler.ts:282-317)

```typescript
// Maybe run onIdle
if (def.onIdle) {
  // Check if scheduled
  const scheduled = scheduleHolder.dirty
    ? scheduleHolder.scheduledAt
    : yield* getScheduledAt();

  if (scheduled === null) {
    // ... runs onIdle
  }
}
```

The callback triggers when:
1. `onEvent` finishes AND didn't call `schedule()`
2. `execute` finishes AND didn't call `schedule()`

### Comparison with Other Jobs

| Job Type | Equivalent Callback | Semantics |
|----------|---------------------|-----------|
| **Continuous** | None | Always reschedules via `scheduleNext()` - never "unscheduled" |
| **Debounce** | None | After flush, state is purged - task is "done" |
| **WorkerPool** | `onEmpty` | Called when queue is drained (different concept) |
| **Task** | `onIdle` | Called when no schedule is set after handler |

### The Naming Problem

"Idle" typically means "inactive" or "doing nothing". But a Task in this state:
- Still has persisted state
- Still accepts new events via `send()`
- Is actively waiting for input

The actual condition is about **scheduling state**, not activity level:
- **Has schedule** → Will execute at scheduled time
- **No schedule** → Waiting for external events

## Naming Options Analysis

### Option 1: `onUnscheduled` (Recommended)

**Pros:**
- Accurately describes the trigger condition
- Clear that it's about scheduling state
- Parallels `schedule()` and `cancelSchedule()` methods

**Cons:**
- More technical sounding

**Example:**
```typescript
onUnscheduled: (ctx) => Effect.gen(function* () {
  // No execution scheduled - schedule cleanup
  yield* ctx.schedule(Duration.hours(1));
})
```

### Option 2: `onNoSchedule`

**Pros:**
- Very literal about the condition
- Easy to understand

**Cons:**
- Awkward grammar
- Less elegant

### Option 3: `afterExecution` + condition parameter

**Pros:**
- Generic hook that fires after every handler
- More flexible

**Cons:**
- Changes semantics significantly
- User must check condition themselves
- Breaking change to behavior

### Option 4: `onWaiting`

**Pros:**
- Describes the task's state (waiting for events)
- More intuitive

**Cons:**
- Could be confused with "waiting for schedule"
- Less precise about trigger

### Option 5: Keep `onIdle` + improve docs

**Pros:**
- No breaking change
- Zero migration effort

**Cons:**
- Name remains misleading
- Docs can only do so much

## Recommendation

**Rename `onIdle` to `onUnscheduled`**

This is the most accurate name for the trigger condition and aligns with the existing scheduling API (`schedule`, `cancelSchedule`, `getScheduledTime`).

## Implementation Plan (Task-only)

### Phase 1: Add new name as alias

1. Add `onUnscheduled` to `TaskMakeConfig` (definitions/task.ts)
2. Add `onUnscheduled` to `UnregisteredTaskDefinition` and `StoredTaskDefinition` (registry/types.ts)
3. Handler reads either `onUnscheduled` or `onIdle` (handler.ts)
4. Update `TaskIdleContext` to `TaskUnscheduledContext` (keep old as alias)

### Phase 2: Deprecation

1. Mark `onIdle` as `@deprecated` in JSDoc
2. Add migration guide to README
3. Log warning if `onIdle` is used (optional)

### Phase 3: Removal (major version)

1. Remove `onIdle` support
2. Rename `idleReason` context property to `unscheduledReason` or `trigger`

## Code Changes

### definitions/task.ts

```typescript
export interface TaskMakeConfig<S, E, Err> {
  // ... existing fields ...

  /**
   * Called when `onEvent` or `execute` completes and no alarm is scheduled.
   *
   * Use this to:
   * - Schedule delayed cleanup
   * - Log unscheduled state
   * - Trigger maintenance tasks
   */
  readonly onUnscheduled?: (ctx: TaskUnscheduledContext<S>) => Effect.Effect<void, never, never>;

  /**
   * @deprecated Use `onUnscheduled` instead. Will be removed in next major version.
   */
  readonly onIdle?: (ctx: TaskIdleContext<S>) => Effect.Effect<void, never, never>;
}
```

### registry/types.ts

```typescript
/**
 * Context provided to task onUnscheduled handler.
 */
export interface TaskUnscheduledContext<S> {
  // ... same fields as TaskIdleContext ...

  /** What handler triggered the unscheduled state */
  readonly trigger: "onEvent" | "execute";
}

/** @deprecated Use TaskUnscheduledContext instead */
export type TaskIdleContext<S> = TaskUnscheduledContext<S> & {
  /** @deprecated Use `trigger` instead */
  readonly idleReason: "onEvent" | "execute";
};
```

### handler.ts

```typescript
// In runExecution
const onUnscheduledHandler = def.onUnscheduled ?? def.onIdle;
if (onUnscheduledHandler) {
  const scheduled = scheduleHolder.dirty
    ? scheduleHolder.scheduledAt
    : yield* getScheduledAt();

  if (scheduled === null) {
    const ctx = createTaskUnscheduledContext(/* ... */);
    yield* onUnscheduledHandler(ctx);
    yield* applyScheduleChanges(scheduleHolder, def.name, "unscheduled", id);
  }
}
```

### context.ts

```typescript
export function createTaskUnscheduledContext<S>(
  // ... params ...
  trigger: "onEvent" | "execute",
): TaskUnscheduledContext<S> {
  return {
    // ... scheduling effects ...
    trigger,
    // Backwards compat
    idleReason: trigger,
  };
}

/** @deprecated */
export const createTaskIdleContext = createTaskUnscheduledContext;
```

## Files to Modify

All changes scoped to Task:

| File | Changes |
|------|---------|
| `src/definitions/task.ts` | Add `onUnscheduled`, deprecate `onIdle` |
| `src/registry/types.ts` | Add `TaskUnscheduledContext`, type aliases |
| `src/handlers/task/handler.ts` | Use either callback, update trigger name |
| `src/handlers/task/context.ts` | Add `createTaskUnscheduledContext` |
| `test/handlers/task.test.ts` | Add tests for new name |

## Migration Guide

```typescript
// Before
const task = Task.make({
  // ...
  onIdle: (ctx) => Effect.gen(function* () {
    if (ctx.idleReason === "execute") {
      yield* ctx.schedule(Duration.hours(1));
    }
  }),
});

// After
const task = Task.make({
  // ...
  onUnscheduled: (ctx) => Effect.gen(function* () {
    if (ctx.trigger === "execute") {
      yield* ctx.schedule(Duration.hours(1));
    }
  }),
});
```

## Testing Strategy

1. Existing `onIdle` tests should continue to pass (backwards compat)
2. Add parallel tests using `onUnscheduled`
3. Test that both can't be specified simultaneously (or define precedence)
4. Test context property availability (`trigger` vs `idleReason`)

## Conclusion

Renaming `onIdle` to `onUnscheduled` provides:
- Accurate description of trigger condition
- Consistency with scheduling API
- Clear migration path
- No changes to other job types
