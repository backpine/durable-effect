# Report 051: Effect Type Incompatibility in effect-worker-v2

## Summary

The type error `Effect<void, never, never> is missing properties [EffectTypeId], [SinkTypeId], [StreamTypeId], [ChannelTypeId]` in `effect-worker-v2` is caused by **two separate issues**:

1. **Stale duplicate Effect package** in node_modules
2. **Incorrect API usage** in `basic-task.ts`

---

## Issue 1: Duplicate Effect Packages (IDE Error)

### Finding

There are two versions of the `effect` package in node_modules:

```
node_modules/.pnpm/effect@3.19.8/   ← Catalog version (correct)
node_modules/.pnpm/effect@3.19.12/  ← Stale orphaned version
```

Additionally, a stale `@effect/platform@0.93.8` references `effect@3.19.12`:
```
node_modules/.pnpm/@effect+platform@0.93.8_effect@3.19.12/
```

### Cause

The `pnpm-lock.yaml` does **not** contain `effect@3.19.12`, meaning this is orphaned data from a previous install. The workspace catalog correctly specifies:

```yaml
# pnpm-workspace.yaml
catalog:
  effect: ^3.19.8
  "@effect/platform": ^0.75.0
```

### Impact

When the IDE (VS Code, etc.) resolves types, it may pick up `Effect` types from `effect@3.19.12` for some imports while the `@durable-effect/jobs` package uses `effect@3.19.8`. TypeScript sees these as incompatible types even though they have identical structures.

### Solution

Clean and reinstall node_modules:

```bash
rm -rf node_modules
rm -rf examples/*/node_modules
rm -rf packages/*/node_modules
pnpm install
```

---

## Issue 2: Incorrect API Usage (Compiler Error)

### Finding

In `examples/effect-worker-v2/src/jobs/basic-task.ts`:

```typescript
// WRONG: Using yield* on a plain value
onEvent: (ctx) =>
  Effect.gen(function* () {
    const event = yield* ctx.event;  // ❌ ctx.event is not an Effect
  }),
```

### TypeScript Error

```
TS2488: Type '{ readonly targetRuns: number; }' must have a '[Symbol.iterator]()' method that returns an iterator.
```

### Explanation

Looking at the `TaskEventContext` type definition in `packages/jobs/src/registry/types.ts:468-471`:

```typescript
export interface TaskEventContext<S, E> {
  /** The incoming event (already validated against eventSchema) */
  readonly event: E;  // ← Direct value, NOT an Effect

  // State access (synchronous - already loaded)
  readonly state: S | null;

  // These ARE Effects:
  readonly setState: (state: S) => Effect.Effect<void, never, never>;
  readonly updateState: (fn: (current: S) => S) => Effect.Effect<void, never, never>;
}
```

`ctx.event` is a **synchronous property** (the decoded event value), not an Effect. The `yield*` operator expects an iterable (like an Effect), but receives a plain object.

### Correct Usage

Reference the working example in `examples/effect-worker/src/jobs.ts:133-134`:

```typescript
// CORRECT: Direct property access
onEvent: (ctx) =>
  Effect.gen(function* () {
    const event = ctx.event;  // ✅ Direct access, no yield*

    // Use event directly
    switch (event._tag) {
      case "Start":
        yield* ctx.setState({ ... });  // ✅ setState IS an Effect
        break;
    }
  }),
```

### Key API Reference

**In `onEvent` (TaskEventContext):**

| Property/Method | Type | Usage |
|----------------|------|-------|
| `ctx.event` | `E` (plain value) | `const e = ctx.event` |
| `ctx.state` | `S \| null` (plain value) | `if (ctx.state !== null)` |
| `ctx.setState(s)` | `Effect<void>` | `yield* ctx.setState(...)` |
| `ctx.updateState(fn)` | `Effect<void>` | `yield* ctx.updateState(...)` |
| `ctx.schedule(time)` | `Effect<void>` | `yield* ctx.schedule(...)` |

**In `execute` (TaskExecuteContext):**

| Property/Method | Type | Usage |
|----------------|------|-------|
| `ctx.state` | `Effect<S \| null>` | `const s = yield* ctx.state` |
| `ctx.setState(s)` | `Effect<void>` | `yield* ctx.setState(...)` |
| `ctx.updateState(fn)` | `Effect<void>` | `yield* ctx.updateState(...)` |
| `ctx.schedule(time)` | `Effect<void>` | `yield* ctx.schedule(...)` |

Note: In `onEvent`, state is pre-loaded and synchronous. In `execute`, state is loaded on-demand via Effect.

---

## Corrected basic-task.ts

```typescript
import { Task } from "@durable-effect/jobs";
import { Effect, Schema } from "effect";

export const TaskState = Schema.Struct({
  targetRuns: Schema.Number,
  currentRun: Schema.Number,
});

export const TaskEvent = Schema.Struct({
  targetRuns: Schema.Number,
});

export const basicTask = Task.make({
  eventSchema: TaskEvent,
  stateSchema: TaskState,

  onEvent: (ctx) =>
    Effect.gen(function* () {
      // In onEvent: event and state are direct values (pre-loaded)
      const event = ctx.event;  // ✅ Direct access
      const currentState = ctx.state;  // ✅ Direct access (S | null)

      if (currentState === null) {
        yield* ctx.setState({
          targetRuns: event.targetRuns,
          currentRun: 0,
        });
      } else {
        yield* ctx.updateState((s) => ({
          ...s,
          targetRuns: event.targetRuns,
        }));
      }
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      // In execute: state is an Effect (loaded on-demand)
      const state = yield* ctx.state;  // ✅ In execute, state IS an Effect
      if (state === null) return;

      if (state.currentRun < state.targetRuns) {
        yield* ctx.updateState((s) => ({
          ...s,
          currentRun: s.currentRun + 1,
        }));
      } else {
        yield* ctx.clear();  // Cleanup when done
      }
    }),
});
```

---

## Summary of Actions

1. **Clean node_modules** to remove stale `effect@3.19.12`:
   ```bash
   rm -rf node_modules examples/*/node_modules packages/*/node_modules && pnpm install
   ```

2. **Fix API usage** in `basic-task.ts`:
   - Change `yield* ctx.event` to `ctx.event`
   - Access `ctx.state` directly (not with `yield*`)

3. **Restart TypeScript server** in your IDE after cleanup to pick up fresh types.
