# Design: Sibling Task Invocation

## Problem

Tasks in the same registry cannot invoke each other from within handlers without hitting a circular type reference.

Currently, the only way to dispatch to another task is through the `tasks()` accessor returned by `createTasks()`:

```typescript
const { TasksDO, tasks } = createTasks({
  onboardLocation: onboardLocationTask,
  saveGoogleLocationInfo: withServices(saveGoogleLocationInfoTask, SaveLocationInfoServicesLive),
})

// Inside onboardLocationTask's onAlarm handler:
const saveLocationInfo = tasks(env.TASKS_DO, "saveGoogleLocationInfo")
yield* saveLocationInfo.send(id, event)
```

This produces a TypeScript error:

```
'saveLocationInfo' implicitly has type 'any' because it does not have a type annotation
and is referenced directly or indirectly in its own initializer.
```

**Root cause**: The handler closure captures `tasks`, which is the return value of `createTasks()`, which takes `onboardLocationTask` as input. TypeScript sees the value-level cycle: `tasks` -> `createTasks({..onboardLocation..})` -> `onboardLocationTask.onAlarm` -> `tasks` and gives up on inference.

This isn't just a type problem — it's also architecturally wrong. `tasks()` dispatches via HTTP to a DO stub. Since all tasks in the registry share the same DO class, the correct dispatch mechanism is through the DO namespace (Cloudflare RPC), not through a closed-over variable that creates a dependency cycle.

## Goals

1. Enable task handlers to invoke sibling tasks in the same registry
2. Provide compile-time type safety for sibling task names and event types
3. Minimal change to the existing API surface — `Task.define()`, `createTasks()`, `TaskContext<S>`, and `tasks()` should remain as they are
4. Dispatch correctly via DO namespace (not through a closed-over value)

## Design Overview

Two-tier approach:

| Tier | Mechanism | Type Safety | API Change |
|------|-----------|-------------|------------|
| **Core** | `ctx.sibling(name)` on `TaskContext` | Runtime (schema validation) | Additive — new method on existing interface |
| **Opt-in** | `TaskGroup` helper | Compile-time (full autocomplete + event types) | New export, fully additive |

Tasks that don't need sibling access are completely unaffected by either tier.

---

## Tier 1: Core — `ctx.sibling(name)`

### TaskContext Addition

```typescript
interface TaskContext<S> {
  // ... all existing methods unchanged ...

  /**
   * Get a handle to a sibling task in the same registry.
   * The returned handle dispatches via the DO namespace — each
   * name:id pair maps to its own DO instance with isolated storage.
   */
  readonly sibling: (name: string) => SiblingHandle
}

interface SiblingHandle {
  /** Send an event to the sibling task instance. Event is schema-validated at the target. */
  readonly send: (id: string, event: unknown) => Effect.Effect<void, TaskError>
  /** Read the sibling task instance's current state. */
  readonly getState: (id: string) => Effect.Effect<unknown, TaskError>
}
```

### How It Works at Runtime

The sibling dispatch needs the DO namespace to reach the target task's DO instance. This flows through the system as follows:

```
createTasks(definitions, { binding: "TASKS_DO" })
  └─ TasksDO constructor(state, env)
       └─ captures env[binding] as doNamespace
            └─ makeTaskEngine(state, config, doNamespace)
                 └─ builds SiblingDispatch layer from doNamespace
                      └─ TaskRunnerLive passes dispatch to handlers
                           └─ buildTaskContext(..., dispatch)
                                └─ ctx.sibling(name) uses dispatch
```

### New Internal Service: `SiblingDispatch`

```typescript
class SiblingDispatch extends ServiceMap.Service<SiblingDispatch, {
  readonly send: (name: string, id: string, event: unknown) => Effect.Effect<void, TaskError>
  readonly getState: (name: string, id: string) => Effect.Effect<unknown, TaskError>
}>()("@task/SiblingDispatch") {}
```

Implementation (built by `makeTaskEngine` when `doNamespace` is available):

```typescript
function makeSiblingDispatchLayer(
  doNamespace: DurableObjectNamespaceLike,
): Layer.Layer<SiblingDispatch> {
  return Layer.succeed(SiblingDispatch, {
    send: (name, id, event) =>
      Effect.tryPromise({
        try: async () => {
          const instanceId = `${name}:${id}`
          const doId = doNamespace.idFromName(instanceId)
          const stub = doNamespace.get(doId)
          const resp = await stub.fetch("http://task/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "event", name, id, event }),
          })
          if (!resp.ok) {
            const text = await resp.text()
            throw new Error(`Sibling dispatch error: ${resp.status} ${text}`)
          }
        },
        catch: (cause) =>
          new TaskError({
            message: cause instanceof Error ? cause.message : "Sibling dispatch failed",
            cause,
          }),
      }),
    getState: (name, id) =>
      Effect.tryPromise({
        try: async () => {
          const instanceId = `${name}:${id}`
          const doId = doNamespace.idFromName(instanceId)
          const stub = doNamespace.get(doId)
          const resp = await stub.fetch("http://task/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "state", name, id }),
          })
          if (!resp.ok) throw new Error(`Sibling state error: ${resp.status}`)
          const body = (await resp.json()) as { state: unknown }
          return body.state
        },
        catch: (cause) =>
          new TaskError({
            message: cause instanceof Error ? cause.message : "Sibling getState failed",
            cause,
          }),
      }),
  })
}
```

### Changes to `createTasks`

```typescript
export function createTasks<
  const T extends Record<string, TaskDefinition<any, any, any, any, never>>,
>(
  definitions: T,
  options?: { binding?: string },  // NEW — optional DO binding key
): {
  TasksDO: {
    new (state: DurableObjectState, env: Record<string, unknown>): {
      fetch(request: Request): Promise<Response>
      alarm(): Promise<void>
    }
  }
  tasks: TasksAccessor<T>
}
```

The generated `TasksDO` class now accepts `env` in the constructor (CF already passes this — it was being ignored):

```typescript
class TasksDO {
  private engine: ReturnType<typeof makeTaskEngine>

  constructor(state: DurableObjectState, env: Record<string, unknown>) {
    const doNamespace = options?.binding
      ? (env[options.binding] as DurableObjectNamespaceLike | undefined)
      : undefined

    this.engine = makeTaskEngine(state, {
      name: "__multi__",
      tasks: registryConfig,
    }, doNamespace)
  }

  fetch(request: Request): Promise<Response> { return this.engine.fetch(request) }
  alarm(): Promise<void> { return this.engine.alarm() }
}
```

### Changes to `RegisteredTask` and `buildTaskContext`

`RegisteredTask` handler signatures gain a `dispatch` parameter:

```typescript
export interface RegisteredTask {
  readonly handleEvent: (
    storage: Storage["Service"],
    alarm: Alarm["Service"],
    dispatch: SiblingDispatch["Service"] | null,  // NEW
    id: string,
    name: string,
    event: unknown,
  ) => Effect.Effect<void, TaskValidationError | TaskExecutionError>

  readonly handleAlarm: (
    storage: Storage["Service"],
    alarm: Alarm["Service"],
    dispatch: SiblingDispatch["Service"] | null,  // NEW
    id: string,
    name: string,
  ) => Effect.Effect<void, TaskExecutionError>

  readonly handleGetState: (
    storage: Storage["Service"],
    alarm: Alarm["Service"],
    dispatch: SiblingDispatch["Service"] | null,  // NEW
    id: string,
    name: string,
  ) => Effect.Effect<unknown, TaskExecutionError>
}
```

`buildTaskContext` adds the `sibling` method:

```typescript
function buildTaskContext<S>(
  storage: Storage["Service"],
  alarm: Alarm["Service"],
  dispatch: SiblingDispatch["Service"] | null,
  id: string,
  name: string,
  decodeState: ...,
  encodeState: ...,
): TaskContext<S> {
  // ... existing methods unchanged ...

  const sibling = (targetName: string): SiblingHandle => {
    if (!dispatch) {
      return {
        send: () => Effect.fail(new TaskError({
          message: "Sibling dispatch not configured. Pass { binding: \"YOUR_DO_BINDING\" } to createTasks().",
        })),
        getState: () => Effect.fail(new TaskError({
          message: "Sibling dispatch not configured. Pass { binding: \"YOUR_DO_BINDING\" } to createTasks().",
        })),
      }
    }
    return {
      send: (targetId, event) => dispatch.send(targetName, targetId, event),
      getState: (targetId) => dispatch.getState(targetName, targetId),
    }
  }

  return {
    recall, save, update, scheduleIn, scheduleAt,
    cancelSchedule, nextAlarm, purge, id, name,
    sibling,  // NEW
  }
}
```

### Usage (Tier 1 — Untyped)

```typescript
const onboardLocationTask = Task.define({
  state: OnboardLocationState,
  event: OnboardLocationEvent,
  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) { yield* ctx.purge(); return }

      // Dispatch to sibling — no circular reference!
      yield* ctx.sibling("saveGoogleLocationInfo").send(
        state.connectedLocationId,
        { type: "start", connectedLocationId: state.connectedLocationId, workspaceId: state.workspaceId },
      )
    }),
})

const { TasksDO, tasks } = createTasks({
  onboardLocation: onboardLocationTask,
  saveGoogleLocationInfo: withServices(saveGoogleLocationInfoTask, SaveLocationInfoServicesLive),
}, { binding: "TASKS_DO" })
```

`ctx.sibling` has no dependency on `tasks` or `createTasks` — the circular reference is eliminated. The event type is `unknown`, but the target task's schema validates it at runtime. A bad event produces a `TaskError` with the schema validation message.

---

## Tier 2: Type-Safe — `TaskGroup`

For compile-time type safety on sibling task names and event types.

### Core Idea

Separate task assembly into two phases:
1. **Register** the tasks whose types are known (they don't need sibling access)
2. **Define** connected tasks using a helper that carries the registry type

This breaks the circular reference because connected tasks are defined AFTER the registry type is established — they reference the type but not the value.

### API

```typescript
// Phase 1: Create a group with independent task definitions
const group = TaskGroup.from({
  sessionVisor: withServices(sessionVisorTask, VisorServicesLive),
  analyticsCollector: withServices(analyticsCollectorTask, AnalyticsServicesLive),
  saveGoogleLocationInfo: withServices(saveGoogleLocationInfoTask, SaveLocationInfoServicesLive),
})

// Phase 2: Define connected tasks — ctx.sibling is fully typed
const onboardLocationTask = group.task({
  state: OnboardLocationState,
  event: OnboardLocationEvent,
  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) { yield* ctx.purge(); return }

      // FULLY TYPED:
      // - "saveGoogleLocationInfo" autocompletes from the group's known task names
      // - The event parameter is typed as SaveGoogleLocationInfoEvent
      // - "nonExistentTask" would be a compile error
      yield* ctx.sibling("saveGoogleLocationInfo").send(
        state.connectedLocationId,
        { type: "start", connectedLocationId: state.connectedLocationId, workspaceId: state.workspaceId },
      )
    }),
})

// Phase 3: Build the final registry
const { TasksDO, tasks } = group.build(
  { onboardLocation: onboardLocationTask },
  { binding: "TASKS_DO" },
)
```

### Type Definitions

```typescript
// -----------------------------------------------------------------------
// SiblingCtx — TaskContext with typed sibling access
// -----------------------------------------------------------------------

interface TypedSiblingHandle<S, E> {
  readonly send: (id: string, event: E) => Effect.Effect<void, TaskError>
  readonly getState: (id: string) => Effect.Effect<S | null, TaskError>
}

interface SiblingCtx<
  S,
  T extends Record<string, TaskDefinition<any, any, any, any, never>>,
> {
  // Every member from TaskContext<S> — identical signatures
  readonly recall: () => Effect.Effect<S | null, TaskError>
  readonly save: (state: S) => Effect.Effect<void, TaskError>
  readonly update: (fn: (s: S) => S) => Effect.Effect<void, TaskError>
  readonly scheduleIn: (delay: Duration.Input) => Effect.Effect<void, TaskError>
  readonly scheduleAt: (time: Date | number) => Effect.Effect<void, TaskError>
  readonly cancelSchedule: () => Effect.Effect<void, TaskError>
  readonly nextAlarm: () => Effect.Effect<number | null, TaskError>
  readonly purge: () => Effect.Effect<never, PurgeSignal>
  readonly id: string
  readonly name: string

  // Typed sibling access
  readonly sibling: <K extends keyof T & string>(
    name: K,
  ) => TypedSiblingHandle<StateOf<T, K>, EventOf<T, K>>
}

// -----------------------------------------------------------------------
// TaskDefineConfigWithSiblings — like TaskDefineConfig but with typed ctx
// -----------------------------------------------------------------------

interface TaskDefineConfigWithSiblings<
  S, E, EErr, AErr, R, OErr, GErr,
  T extends Record<string, TaskDefinition<any, any, any, any, never>>,
> {
  readonly state: PureSchema<S>
  readonly event: PureSchema<E>
  readonly onEvent: (
    ctx: SiblingCtx<S, T>,
    event: E,
  ) => Effect.Effect<void, EErr, R>
  readonly onAlarm: (
    ctx: SiblingCtx<S, T>,
  ) => Effect.Effect<void, AErr, R>
  readonly onError?: (
    ctx: SiblingCtx<S, T>,
    error: EErr | AErr,
  ) => Effect.Effect<void, OErr, R>
  readonly onClientGetState?: (
    ctx: SiblingCtx<S, T>,
    state: S | null,
  ) => Effect.Effect<S | null, GErr, R>
}

// -----------------------------------------------------------------------
// TaskGroup
// -----------------------------------------------------------------------

class TaskGroup<T extends Record<string, TaskDefinition<any, any, any, any, never>>> {
  static from<T extends Record<string, TaskDefinition<any, any, any, any, never>>>(
    definitions: T,
  ): TaskGroup<T>

  /** Define a task with typed sibling access to all tasks in this group. */
  task<S, E, EErr, AErr, R, OErr = never, GErr = never>(
    config: TaskDefineConfigWithSiblings<S, E, EErr, AErr, R, OErr, GErr, T>,
  ): TaskDefinition<S, E, EErr, AErr, R, OErr, GErr>

  /** Build the final registry, merging group tasks with additional tasks. */
  build<Extra extends Record<string, TaskDefinition<any, any, any, any, never>>>(
    extraDefinitions: Extra,
    options?: { binding?: string },
  ): {
    TasksDO: { new (state: DurableObjectState, env: Record<string, unknown>): { fetch(request: Request): Promise<Response>; alarm(): Promise<void> } }
    tasks: TasksAccessor<T & Extra>
  }
}
```

### Why the Types Work — Compatibility Proof

The critical question: can a handler typed with `SiblingCtx<S, T>` be assigned to a slot expecting `TaskContext<S>`?

**Yes**, and no casts are needed. Here's why:

`group.task(config)` accepts handlers with `SiblingCtx<S, T>` parameters and produces a standard `TaskDefinition<S, E, ...>` with `TaskContext<S>` parameters. This works because of **structural subtyping** and **function parameter contravariance**.

For a handler `(ctx: SiblingCtx<S, T>) => Effect<...>` to be assignable to `(ctx: TaskContext<S>) => Effect<...>`, TypeScript requires `TaskContext<S>` to be assignable to `SiblingCtx<S, T>` (contravariance — the slot provides `TaskContext`, the handler expects `SiblingCtx`).

Check each member:

| Member | `TaskContext<S>` | `SiblingCtx<S, T>` | Assignable? |
|--------|------------------|---------------------|-------------|
| `recall` | `() => Effect<S \| null, TaskError>` | identical | Yes |
| `save` | `(state: S) => Effect<void, TaskError>` | identical | Yes |
| `sibling` | `(name: string) => SiblingHandle` | `<K extends keyof T & string>(name: K) => TypedSiblingHandle<...>` | **See below** |

For `sibling`:
- **Parameter**: `SiblingCtx.sibling` accepts `keyof T & string` (narrower). `TaskContext.sibling` accepts `string` (wider). By contravariance, the wider-accepting function IS assignable to the narrower-accepting slot. **Yes.**
- **Return**: `SiblingHandle` has `send(id: string, event: unknown)`. `TypedSiblingHandle` has `send(id: string, event: EventOf<T, K>)`. By contravariance on `send`'s `event` parameter, `SiblingHandle.send` (accepts `unknown`) IS assignable to `TypedSiblingHandle.send` (accepts specific type), because the specific type is assignable to `unknown`. **Yes.**

Therefore `TaskContext<S>` is assignable to `SiblingCtx<S, T>`. The handler assignment is valid. **No casts needed.**

### `group.task()` Implementation

```typescript
task<S, E, EErr, AErr, R, OErr = never, GErr = never>(
  config: TaskDefineConfigWithSiblings<S, E, EErr, AErr, R, OErr, GErr, T>,
): TaskDefinition<S, E, EErr, AErr, R, OErr, GErr> {
  // Direct delegation — types are structurally compatible
  return Task.define(config as TaskDefineConfig<S, E, EErr, AErr, R, OErr, GErr>)
}
```

The `as TaskDefineConfig` cast exists only because TypeScript may not automatically resolve the structural compatibility of the two config interfaces (they're nominally different even though structurally compatible). This is a safe cast — the proof above guarantees it.

At runtime, `group.task()` is purely a type-level operation. The actual `SiblingCtx` behavior comes from `buildTaskContext` (Tier 1), which builds `ctx.sibling` using the `SiblingDispatch` service regardless of whether `TaskGroup` was used.

---

## Assumptions to Validate

These assumptions must hold for the design to work. Each can be validated with a small TypeScript snippet before implementation.

### 1. Generic Function Assignability

`TaskContext.sibling` is a non-generic function: `(name: string) => SiblingHandle`.
`SiblingCtx.sibling` is a generic function: `<K extends keyof T & string>(name: K) => TypedSiblingHandle<StateOf<T, K>, EventOf<T, K>>`.

**Assumption**: TypeScript considers the non-generic version assignable to the generic version.

**Validation snippet**:
```typescript
interface SiblingHandle { send(id: string, event: unknown): void }
interface TypedHandle<E> { send(id: string, event: E): void }

type TaskDefs = { foo: { event: { type: "start" } }; bar: { event: { type: "stop" } } }

type Loose = (name: string) => SiblingHandle
type Strict = <K extends keyof TaskDefs & string>(name: K) => TypedHandle<TaskDefs[K]["event"]>

// Does this compile?
declare const loose: Loose
const strict: Strict = loose  // <-- VALIDATE THIS
```

If this fails, fallback: make `SiblingCtx.sibling` non-generic with an overload per key, or use a mapped type approach.

### 2. Handler Assignability Across Config Interfaces

**Assumption**: A `TaskDefineConfigWithSiblings<..., T>` value is assignable to `TaskDefineConfig<...>` (the first argument to `Task.define`).

**Validation snippet**:
```typescript
// Simplified
type Ctx = { sibling: (name: string) => { send: (id: string, event: unknown) => void } }
type NarrowCtx = { sibling: (name: "foo" | "bar") => { send: (id: string, event: { type: string }) => void } }

type HandlerA = (ctx: NarrowCtx) => void
type HandlerB = (ctx: Ctx) => void

declare const a: HandlerA
const b: HandlerB = a  // <-- VALIDATE THIS
```

### 3. Cloudflare DO Constructor Receives `env`

**Assumption**: Cloudflare passes `env` as the second argument to DO constructors. The current code ignores it. Adding it to the constructor signature is non-breaking.

**Validation**: Check CF documentation or test with a deployed worker.

### 4. DO Stub Fetch Within a Handler

**Assumption**: A DO handler can make `fetch` calls to other DO instances (via stubs from the namespace) without deadlocking or violating CF's execution model.

**Validation**: This is standard CF DO practice (documented), but worth confirming there are no caveats when the calling and target DOs share the same class.

---

## What Does NOT Change

- `Task.define()` — unchanged. Tasks that don't use siblings work exactly as before.
- `withServices()` — unchanged.
- `tasks()` accessor — unchanged. External callers still use it the same way.
- `TaskHandle` — unchanged.
- `TaskRunner` / `TaskRunnerLive` — internal changes only (threading dispatch), no API change.
- Error types — unchanged.
- Storage / Alarm services — unchanged.

---

## Backward Compatibility

| Change | Impact |
|--------|--------|
| `TaskContext<S>` gains `sibling` member | Additive — existing code doesn't use it |
| `createTasks` accepts optional `options` param | Additive — existing calls work without it |
| `TasksDO` constructor accepts `env` | Non-breaking — CF already passes it, was ignored |
| `RegisteredTask` handler signatures gain `dispatch` param | Internal — not user-facing |
| `TaskGroup` export | New export — fully additive |
| `SiblingHandle`, `TypedSiblingHandle`, `SiblingCtx` types | New exports — fully additive |

The only potentially sensitive change is `RegisteredTask` gaining the `dispatch` parameter. If anyone directly constructs `RegisteredTask` values (unlikely — it's an internal type), they'd need to add the parameter. The `registerTask` and `registerTaskWithLayer` functions handle this internally.

---

## Implementation Phases

### Phase 1: Core Sibling Dispatch (Tier 1)

1. Add `SiblingDispatch` service
2. Update `buildTaskContext` to accept dispatch and build `ctx.sibling`
3. Update `RegisteredTask` and `buildRegisteredTask` to thread dispatch
4. Update `TaskRunnerLive` to resolve and pass dispatch
5. Update `makeTaskEngine` to accept `doNamespace` and build dispatch layer
6. Update `createTasks` to accept `options.binding` and capture namespace in DO constructor
7. Add `SiblingHandle` to `TaskContext` interface
8. Export new types
9. Update tests — verify sibling dispatch works end-to-end
10. Update in-memory test stack to support sibling dispatch (optional mock)

### Phase 2: Type-Safe TaskGroup (Tier 2)

1. Add `SiblingCtx` interface
2. Add `TypedSiblingHandle` interface
3. Add `TaskDefineConfigWithSiblings` interface
4. Implement `TaskGroup` class with `from()`, `task()`, `build()`
5. Export new types and `TaskGroup`
6. Add type-level tests (typecheck.test.ts) validating:
   - `group.task()` provides autocomplete on sibling names
   - Wrong event types produce compile errors
   - Non-existent sibling names produce compile errors
   - Handler assignability works without casts
7. Add integration test — connected task dispatches to sibling

---

## Alternatives Considered

### A. Explicit Type Annotation (Workaround)

```typescript
const saveLocationInfo: TaskHandle<SaveState, SaveEvent> = tasks(env.TASKS_DO, "saveGoogleLocationInfo")
```

Breaks the TS inference cycle by providing an explicit type. But:
- Still uses `tasks()` inside the handler (value-level closure on `createTasks` output)
- Dispatch goes through the external HTTP path instead of the DO namespace
- User must manually keep type annotations in sync
- Fragile — adding/renaming tasks silently breaks

### B. Effect Service Tag for Siblings

Make sibling access an Effect service (`yield* MySiblings`) instead of a context method.

```typescript
class MySiblings extends ServiceMap.Service<MySiblings, SiblingServiceShape<MyDefs>>()("@app/Siblings") {}
```

Rejected because:
- Each project would need to define its own service tag
- The service needs the registry type, creating the same forward-reference problem
- `withServices` would need to provide it, adding boilerplate
- Less ergonomic than `ctx.sibling(name)`

### C. Factory Functions in `createTasks`

```typescript
createTasks({
  saveGoogleLocationInfo: saveGoogleLocationInfoTask,
  onboardLocation: (siblings) => Task.define({ ... })  // factory
})
```

Rejected because:
- TypeScript can't infer `T` from `createTasks`'s argument while simultaneously using `T` to type the factory's `siblings` parameter
- This is a higher-kinded inference problem that TypeScript doesn't support
- Would produce `any` types in practice

### D. Single Generic `TaskContext<S, T>`

Add the registry type as a second generic parameter to `TaskContext`:

```typescript
interface TaskContext<S, T = Record<string, never>> { ... }
```

Rejected because:
- Pollutes every use of `TaskContext` with a second type parameter
- Every existing handler signature would need updating
- `TaskDefinition` would gain another generic parameter
- Fundamentally changes the API surface

### E. Fully Untyped (Runtime Only)

Just add `ctx.sibling(name)` with `unknown` types and rely on runtime schema validation.

This is **Tier 1** of the recommended design. It's not rejected — it's the foundation. Tier 2 (`TaskGroup`) layers compile-time safety on top for users who want it.
