# Sibling Task Invocation — Interface Design Options

How should developers define task groups, define tasks with sibling access, and use them?

This doc shows four viable API shapes. All share the same runtime mechanism — `ctx.sibling(name)` dispatches to the target task's DO instance via the namespace. The difference is how TypeScript knows which siblings exist and what events they accept.

---

## Option A: `TaskGroup.from()` + `group.task()`

*Inspired by: Effect's HttpApi (declare shape, then implement connected parts)*

### Define the group

```typescript
// Collect all "independent" task definitions into a group.
// These are tasks that don't need sibling access.
const group = TaskGroup.from({
  sessionVisor: withServices(sessionVisorTask, VisorServicesLive),
  analyticsCollector: withServices(analyticsCollectorTask, AnalyticsServicesLive),
  saveGoogleLocationInfo: withServices(
    saveGoogleLocationInfoTask,
    SaveLocationInfoServicesLive,
  ),
})
```

### Define connected tasks

```typescript
// group.task() gives you a TaskContext whose .sibling() is typed
// against the group's known tasks.
const onboardLocationTask = group.task({
  state: OnboardLocationState,
  event: OnboardLocationEvent,

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) { yield* ctx.purge(); return }

      // ✅ "saveGoogleLocationInfo" autocompletes
      // ✅ event payload is typed as SaveGoogleLocationInfoEvent
      // ❌ "nonExistent" — compile error
      yield* ctx
        .sibling("saveGoogleLocationInfo")
        .send(state.connectedLocationId, {
          type: "start",
          connectedLocationId: state.connectedLocationId,
          workspaceId: state.workspaceId,
        })
    }),
})
```

### Wire up

```typescript
// group.build() merges the original tasks with connected tasks
// and calls createTasks under the hood.
export const { TasksDO, tasks } = group.build(
  { onboardLocation: onboardLocationTask },
  { binding: "TASKS_DO" },
)
```

### Use externally (unchanged)

```typescript
const analytics = tasks(env.TASKS_DO, "analyticsCollector")
yield* analytics.send(id, event)
```

### Pros

- Clear two-phase mental model: "register independents, then define connected"
- `group.task()` is the only new concept — everything else stays the same
- `Task.define()` still works for tasks that don't need siblings
- The group is a plain value — can be imported across files
- No type annotations or manifest needed — types flow from the definitions

### Cons

- Connected tasks can only reference tasks from phase 1 (not each other)
  - Task A calling Task B calling Task A is not possible (but this is arguably a feature — prevents infinite recursion at the DO level)
- Two separate steps to assemble (`group.from()` then `group.build()`)

---

## Option B: Chained Builder

*Inspired by: Effect's `RpcGroup.make().add().add()` with union type accumulation*

### Define, connect, and build in one expression

```typescript
export const { TasksDO, tasks } = TaskGroup.make({ binding: "TASKS_DO" })
  .add("sessionVisor", withServices(sessionVisorTask, VisorServicesLive))
  .add("analyticsCollector", withServices(analyticsCollectorTask, AnalyticsServicesLive))
  .add("saveGoogleLocationInfo", withServices(
    saveGoogleLocationInfoTask,
    SaveLocationInfoServicesLive,
  ))
  // .task() sees all tasks added above in the chain
  .task("onboardLocation", {
    state: OnboardLocationState,
    event: OnboardLocationEvent,

    onAlarm: (ctx) =>
      Effect.gen(function* () {
        const state = yield* ctx.recall()
        if (!state) { yield* ctx.purge(); return }

        // ✅ Typed — knows about sessionVisor, analyticsCollector, saveGoogleLocationInfo
        yield* ctx
          .sibling("saveGoogleLocationInfo")
          .send(state.connectedLocationId, {
            type: "start",
            connectedLocationId: state.connectedLocationId,
            workspaceId: state.workspaceId,
          })
      }),
  })
  .build()
```

### How the types accumulate

```
TaskGroup.make()                        // TaskGroup<{}>
  .add("sessionVisor", ...)             // TaskGroup<{ sessionVisor: TaskDef<...> }>
  .add("saveGoogleLocationInfo", ...)   // TaskGroup<{ sessionVisor: ..., saveGoogleLocationInfo: ... }>
  .task("onboardLocation", { ... })     // ctx.sibling knows about sessionVisor + saveGoogleLocationInfo
  .build()                              // { TasksDO, tasks: TasksAccessor<all three> }
```

Each `.add()` returns a new `TaskGroup` with an expanded type parameter — the same pattern Effect's `RpcGroup` uses. By the time `.task()` is called, the type contains everything added so far.

### Pros

- Single expression — everything in one place
- Familiar fluent builder pattern (similar to `RpcGroup`)
- Order naturally expresses the dependency DAG — connected tasks come after their dependencies
- No intermediate variables or separate files needed

### Cons

- Long chains can be hard to read
- Task definitions are inline rather than standalone — harder to test in isolation
- `.task()` can only reference tasks added ABOVE it in the chain (order matters)
- Defining tasks separately and importing them is less natural with this pattern

### Variation: `.add()` for everything, `.task()` only for connected

If most tasks don't need siblings, you'd only use `.task()` for the few that do:

```typescript
export const { TasksDO, tasks } = TaskGroup.make({ binding: "TASKS_DO" })
  .add("sessionVisor", withServices(sessionVisorTask, VisorServicesLive))
  .add("analyticsCollector", withServices(analyticsCollectorTask, AnalyticsServicesLive))
  .add("saveGoogleLocationInfo", withServices(saveGoogleLocationInfoTask, SaveLocationInfoServicesLive))
  .add("onboardLocation", onboardLocationTask) // no siblings needed? use .add()
  .task("coordinator", { ... })                // needs siblings? use .task()
  .build()
```

---

## Option C: Schema Manifest

*Inspired by: Effect's HttpApiGroup (declare all endpoints upfront, implement later)*

### Declare the manifest (just schemas — no implementations)

```typescript
// This is a pure type declaration. It tells the system what tasks exist
// and what their state/event shapes are. No handler code here.
const manifest = TaskManifest.make({
  sessionVisor: {
    state: SessionVisorState,
    event: SessionVisorEvent,
  },
  analyticsCollector: {
    state: AnalyticsState,
    event: AnalyticsEvent,
  },
  saveGoogleLocationInfo: {
    state: SaveLocationInfoState,
    event: SaveLocationInfoEvent,
  },
  onboardLocation: {
    state: OnboardLocationState,
    event: OnboardLocationEvent,
  },
})
```

### Define tasks using the manifest

```typescript
// manifest.define() gives you typed sibling access to ALL tasks in the manifest.
// Every task can reference every other task — no ordering constraints.

const sessionVisorTask = manifest.define("sessionVisor", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      // ✅ Can reference any sibling — including onboardLocation
      yield* ctx.sibling("analyticsCollector").send(id, { type: "track", ... })
    }),
  onAlarm: (ctx) => Effect.gen(function* () { ... }),
})

const onboardLocationTask = manifest.define("onboardLocation", {
  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) { yield* ctx.purge(); return }

      // ✅ Fully typed — event must match SaveLocationInfoEvent
      yield* ctx
        .sibling("saveGoogleLocationInfo")
        .send(state.connectedLocationId, {
          type: "start",
          connectedLocationId: state.connectedLocationId,
          workspaceId: state.workspaceId,
        })
    }),
})
```

### Wire up

```typescript
// manifest.build() validates that every task in the manifest has an implementation
export const { TasksDO, tasks } = manifest.build(
  {
    sessionVisor: withServices(sessionVisorTask, VisorServicesLive),
    analyticsCollector: withServices(analyticsCollectorTask, AnalyticsServicesLive),
    saveGoogleLocationInfo: withServices(saveGoogleLocationInfoTask, SaveLocationInfoServicesLive),
    onboardLocation: onboardLocationTask,
  },
  { binding: "TASKS_DO" },
)
```

### Pros

- **Any task can reference any task** — no ordering constraints, no phase restrictions
- Mutual references work (A calls B, B calls A) — the manifest knows all shapes upfront
- The manifest is a single source of truth for what tasks exist
- `manifest.define(name, ...)` validates the handlers match the declared schemas
- Closest to how you'd think about it conceptually: "these are my tasks, they can talk to each other"

### Cons

- Schemas declared twice: once in the manifest, once in the task definition
  - Could be mitigated: `manifest.define()` infers state/event from the manifest entry, so you don't pass schemas in the config
- More boilerplate upfront (the manifest declaration)
- New concept (`TaskManifest`) that doesn't exist in the current API
- `manifest.build()` must validate at the type level that all tasks are provided — this requires a mapped type constraint which can produce verbose error messages

---

## Option D: Untyped `ctx.sibling()` + Typed Utility

*The pragmatic option — minimal API change, maximum compatibility.*

### No group concept at all

```typescript
// Tasks are defined exactly as today — nothing changes
const onboardLocationTask = Task.define({
  state: OnboardLocationState,
  event: OnboardLocationEvent,

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) { yield* ctx.purge(); return }

      // ctx.sibling exists on every TaskContext.
      // It's untyped — event is `unknown`.
      // The target task's schema validates at runtime.
      yield* ctx
        .sibling("saveGoogleLocationInfo")
        .send(state.connectedLocationId, {
          type: "start",
          connectedLocationId: state.connectedLocationId,
          workspaceId: state.workspaceId,
        })
    }),
})

// createTasks is the same, just with an optional binding option
export const { TasksDO, tasks } = createTasks(
  {
    sessionVisor: withServices(sessionVisorTask, VisorServicesLive),
    analyticsCollector: withServices(analyticsCollectorTask, AnalyticsServicesLive),
    saveGoogleLocationInfo: withServices(saveGoogleLocationInfoTask, SaveLocationInfoServicesLive),
    onboardLocation: onboardLocationTask,
  },
  { binding: "TASKS_DO" },
)
```

### Opt-in type narrowing with a helper

For developers who want type safety, provide a `SiblingOf` utility type:

```typescript
import type { SiblingOf } from "@backpine/task"

// Create a typed sibling helper from any task definition map
type Sibling = SiblingOf<typeof definitions>

// Use it in the task definition with a type annotation
const onboardLocationTask = Task.define({
  state: OnboardLocationState,
  event: OnboardLocationEvent,

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) { yield* ctx.purge(); return }

      // Type annotation narrows the handle
      const save: Sibling<"saveGoogleLocationInfo"> = ctx.sibling("saveGoogleLocationInfo")

      // ✅ Now event is typed
      yield* save.send(state.connectedLocationId, {
        type: "start",
        connectedLocationId: state.connectedLocationId,
        workspaceId: state.workspaceId,
      })
    }),
})

// Definitions must be in a separate variable (not destructured from createTasks)
// to avoid the circular reference
const definitions = {
  sessionVisor: withServices(sessionVisorTask, VisorServicesLive),
  saveGoogleLocationInfo: withServices(saveGoogleLocationInfoTask, SaveLocationInfoServicesLive),
  onboardLocation: onboardLocationTask,
}

export const { TasksDO, tasks } = createTasks(definitions, { binding: "TASKS_DO" })
```

### Pros

- **Zero new concepts** — `ctx.sibling(name)` is just a new method on the existing `TaskContext`
- Works today for every task, no restructuring needed
- Type narrowing is opt-in — can add it later without changing anything
- `Task.define()` and `createTasks()` signatures barely change
- Lowest migration cost

### Cons

- No compile-time safety by default — wrong task name or wrong event shape compiles fine, fails at runtime
- The opt-in type narrowing requires a separate `definitions` variable and a type annotation — not as ergonomic as the other options
- Circular reference between `definitions` and task handlers is avoided only because the type annotation exists — fragile
- IDE autocomplete doesn't help you discover sibling task names

---

## Comparison

| | Option A | Option B | Option C | Option D |
|---|---|---|---|---|
| **Pattern** | Two-phase group | Chained builder | Schema manifest | Untyped + utility |
| **Inspired by** | HttpApi | RpcGroup | HttpApiGroup declare/implement | — |
| **New concepts** | `TaskGroup.from`, `group.task`, `group.build` | `TaskGroup.make`, `.add`, `.task`, `.build` | `TaskManifest.make`, `manifest.define`, `manifest.build` | `ctx.sibling` method |
| **Type safety** | Full (for tasks in group) | Full (for tasks above in chain) | Full (all tasks) | Runtime only (opt-in types via annotation) |
| **Mutual references** | No (only phase-1 → phase-2) | No (only upward in chain) | Yes (any → any) | N/A |
| **API change** | Additive | Additive | Additive | Minimal |
| **Existing code change** | None | None | None | None |
| **Can define tasks in separate files** | Yes | Awkward (chain is one expression) | Yes | Yes |
| **IDE autocomplete on sibling names** | Yes | Yes | Yes | No (unless using type utility) |
| **Risk of runtime schema mismatch** | Low (compile-time) | Low (compile-time) | Low (compile-time) | Medium (runtime only) |

---

## Recommendation

**Start with Option D (untyped `ctx.sibling`) as the foundation.** It's the runtime mechanism regardless of which typed layer you choose, and it's immediately useful with zero API disruption.

**Then layer Option A (`TaskGroup.from` + `group.task`) on top for type safety.** It's the best balance of type safety, simplicity, and compatibility with the existing `Task.define` + `createTasks` workflow:

- Tasks that don't need siblings are defined with `Task.define()` as before
- Tasks that need typed siblings use `group.task()` — one new method to learn
- The two-phase model is easy to explain: "put your tasks in a group, then connected tasks can see them"
- Works naturally across files (the group is just a value you import)

Option C (manifest) is worth considering if mutual references become a real need (task A calls task B, task B calls task A). But in practice, inter-task dependencies tend to be DAG-shaped, making Option A sufficient.

Option B (chained builder) is elegant for small registries but becomes unwieldy when tasks are defined in separate files (which is the common case for real projects).
