# v5 Redesign: Sibling-First Task Architecture

## The Core Insight

The current architecture creates tasks that own their handlers, then assembles them into a registry. This makes sibling awareness impossible without circular references — a handler needs the registry, but the registry needs the handler.

Flip it. **The registry defines the namespace. Handlers are provided to it.**

```
Current:   TaskDefinition(handlers) → createTasks(definitions) → registry
                ↑___________________________|  (circular)

Redesign:  Task.make(schemas) → TaskRegistry.make(tasks) → registry.implement(handlers)
              (no handlers)        (knows all tasks)          (handlers see all siblings)
```

The type flows in one direction: from task declarations → through the registry → into the handlers. Handlers receive the full registry type as context, so they know every sibling and can invoke them with full type safety.

---

## The Three Primitives

### 1. Task — The Contract

A task is a **declaration**: a name, a state schema, and an event schema. No handler code. Lightweight.

```typescript
const OnboardLocation = Task.make("onboardLocation", {
  state: OnboardLocationState,
  event: OnboardLocationEvent,
})
```

A task tag is also **callable** — it's the entry point for external access:

```typescript
yield* OnboardLocation(env.TASKS_DO).send("loc-123", { type: "start", ... })
```

This is analogous to how Effect's `Rpc.make("GetUser", ...)` creates a declaration that's later implemented, and how a `ServiceMap.Service` tag is both a declaration and an accessor.

### 2. Registry — The Namespace

A registry groups tasks. It's the source of sibling awareness — it knows what tasks exist and what their schemas are.

```typescript
const registry = TaskRegistry.make(
  SessionVisor,
  AnalyticsCollector,
  SaveLocationInfo,
  OnboardLocation,
)
```

The registry's type parameter is a union of all task tags (like `RpcGroup<R>` accumulates RPCs). This type flows into every handler's context.

### 3. Handler — The Implementation

Handlers are provided TO the registry. Because the registry type is already resolved, every handler's `ctx` knows about every sibling.

```typescript
registry.implement({
  onboardLocation: {
    onAlarm: (ctx) =>
      Effect.gen(function* () {
        // ctx.task() is typed against the full registry
        yield* ctx.task(SaveLocationInfo).send(id, event)
      }),
  },
  // ...
})
```

---

## Developer Walkthrough

### File Structure

```
tasks/
  registry.ts                  ← task schemas + registry (one file)
  handlers/
    session-visor.ts           ← one handler per file
    analytics-collector.ts
    save-location-info.ts
    onboard-location.ts
  index.ts                     ← assembly + export
```

This mirrors the current pattern where each task has its own file. The difference: schemas move into a shared `registry.ts` and each handler file imports from it.

### Step 1: Registry — Schemas + Namespace

One file declares every task's contract and creates the registry. No handler code lives here — just names and schemas.

```typescript
// tasks/registry.ts
import { Task, TaskRegistry } from "@backpine/task"
import { Schema } from "effect"

// ── Task Declarations ────────────────────────────────────

export const SessionVisor = Task.make("sessionVisor", {
  state: Schema.Struct({
    sessionId: Schema.String,
    startedAt: Schema.Number,
  }),
  event: Schema.Union(
    Schema.Struct({ type: Schema.Literal("start"), sessionId: Schema.String }),
    Schema.Struct({ type: Schema.Literal("end") }),
  ),
})

export const AnalyticsCollector = Task.make("analyticsCollector", {
  state: Schema.Struct({ buffer: Schema.Array(Schema.Unknown) }),
  event: Schema.Struct({ type: Schema.Literal("track"), payload: Schema.Unknown }),
})

export const SaveLocationInfo = Task.make("saveGoogleLocationInfo", {
  state: Schema.Struct({
    connectedLocationId: Schema.String,
    workspaceId: Schema.String,
    status: Schema.String,
  }),
  event: Schema.Struct({
    type: Schema.Literal("start"),
    connectedLocationId: Schema.String,
    workspaceId: Schema.String,
  }),
})

export const OnboardLocation = Task.make("onboardLocation", {
  state: Schema.Struct({
    connectedLocationId: Schema.String,
    workspaceId: Schema.String,
  }),
  event: Schema.Struct({
    type: Schema.Literal("begin"),
    connectedLocationId: Schema.String,
    workspaceId: Schema.String,
  }),
})

// ── Registry ─────────────────────────────────────────────

export const registry = TaskRegistry.make(
  SessionVisor,
  AnalyticsCollector,
  SaveLocationInfo,
  OnboardLocation,
)
```

This file is the single source of truth for what tasks exist. Every handler file imports from it. Since it has no handler code, nothing imports FROM handler files — no cycles possible.

### Step 2: Handlers — One Per File

Each handler file imports the registry and exports a handler. This is where `registry.handler()` does its work — it takes the task name, looks up the schema from the registry's type, and gives you a fully typed `ctx` and `event`.

```typescript
// tasks/handlers/session-visor.ts
import { Effect } from "effect"
import { registry } from "../registry"

export const sessionVisorHandler = registry.handler("sessionVisor", {
  services: VisorServicesLive,

  onEvent: (ctx, event) =>
    // ctx: TaskCtx<{ sessionId: string, startedAt: number }, AllTags>
    // event: { type: "start", sessionId: string } | { type: "end" }
    Effect.gen(function* () {
      if (event.type === "start") {
        yield* ctx.save({ sessionId: event.sessionId, startedAt: Date.now() })
        yield* ctx.scheduleIn("30 minutes")
      }
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      yield* ctx.purge()
    }),
})
```

```typescript
// tasks/handlers/save-location-info.ts
import { Effect } from "effect"
import { registry } from "../registry"

export const saveLocationInfoHandler = registry.handler("saveGoogleLocationInfo", {
  services: SaveLocationInfoServicesLive,

  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      yield* ctx.save({
        connectedLocationId: event.connectedLocationId,
        workspaceId: event.workspaceId,
        status: "processing",
      })
      yield* ctx.scheduleIn("30 seconds")
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) { yield* ctx.purge(); return }
      // ... fetch from Google API ...
      yield* ctx.update((s) => ({ ...s, status: "done" }))
    }),
})
```

```typescript
// tasks/handlers/onboard-location.ts
import { Effect } from "effect"
import { registry, SaveLocationInfo } from "../registry"

export const onboardLocationHandler = registry.handler("onboardLocation", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      yield* ctx.save({
        connectedLocationId: event.connectedLocationId,
        workspaceId: event.workspaceId,
      })
      yield* ctx.scheduleIn("5 seconds")
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) { yield* ctx.purge(); return }

      // ✅ Fully typed sibling invocation:
      //    - SaveLocationInfo autocompletes from the registry
      //    - .send() requires { type: "start", connectedLocationId, workspaceId }
      //    - wrong fields = compile error
      //    - "nonExistentTask" = compile error
      yield* ctx.task(SaveLocationInfo).send(
        state.connectedLocationId,
        {
          type: "start",
          connectedLocationId: state.connectedLocationId,
          workspaceId: state.workspaceId,
        },
      )

      yield* ctx.purge()
    }),
})
```

What TypeScript knows inside each handler:
- `ctx` is `TaskCtx<S, Tags>` — typed to this task's state AND aware of all siblings
- `event` is the exact event type for this task
- `ctx.task(SaveLocationInfo)` returns `TaskHandle<SaveState, SaveEvent>` — fully typed
- `ctx.task(SessionVisor)` also works — any sibling is accessible
- `ctx.task(SomeUnknownTag)` — compile error, not in the registry

### Step 3: Assembly

The assembly file imports the registry and all handlers, wires them together, and exports the DO class. Identical shape to the current `createTasks({ name: taskDef })` pattern.

```typescript
// tasks/index.ts
import { registry } from "./registry"
import { sessionVisorHandler } from "./handlers/session-visor"
import { analyticsCollectorHandler } from "./handlers/analytics-collector"
import { saveLocationInfoHandler } from "./handlers/save-location-info"
import { onboardLocationHandler } from "./handlers/onboard-location"

export const { TasksDO, client } = registry.build({
  sessionVisor: sessionVisorHandler,
  analyticsCollector: analyticsCollectorHandler,
  saveGoogleLocationInfo: saveLocationInfoHandler,
  onboardLocation: onboardLocationHandler,
}, { binding: "TASKS_DO" })

// Re-export tags for external use
export {
  SessionVisor,
  AnalyticsCollector,
  SaveLocationInfo,
  OnboardLocation,
} from "./registry"
```

The `registry.build()` mapped type ensures every task in the registry has a handler. If you forget one:

```typescript
registry.build({
  sessionVisor: sessionVisorHandler,
  // ❌ Property 'analyticsCollector' is missing
  // ❌ Property 'saveGoogleLocationInfo' is missing
  // ❌ Property 'onboardLocation' is missing
})
```

### Import Graph — No Cycles

```
registry.ts            (imports: @backpine/task, effect — no project files)
    ↓
handlers/*.ts          (imports: registry.ts)
    ↓
index.ts               (imports: registry.ts + handlers/*.ts)
    ↓
worker.ts / routes     (imports: index.ts or registry.ts for tags)
```

Every arrow points down. No file imports from a file below it. This is guaranteed by the architecture — schemas + registry live in one file, handlers import from it, assembly imports handlers.

### Comparison With Current Pattern

Current:
```typescript
// session-visor-task.ts
export const sessionVisorTask = Task.define({
  state: SessionVisorState,
  event: SessionVisorEvent,
  onEvent: (ctx, event) => ...,
  onAlarm: (ctx) => ...,
})

// tasks/index.ts
export const { TasksDO, tasks } = createTasks({
  sessionVisor: withServices(sessionVisorTask, VisorServicesLive),
  saveGoogleLocationInfo: withServices(saveGoogleLocationInfoTask, SaveLocationInfoServicesLive),
  onboardLocation: onboardLocationTask,
})
```

New:
```typescript
// tasks/handlers/session-visor.ts
export const sessionVisorHandler = registry.handler("sessionVisor", {
  services: VisorServicesLive,
  onEvent: (ctx, event) => ...,
  onAlarm: (ctx) => ...,
})

// tasks/index.ts
export const { TasksDO, client } = registry.build({
  sessionVisor: sessionVisorHandler,
  saveGoogleLocationInfo: saveLocationInfoHandler,
  onboardLocation: onboardLocationHandler,
}, { binding: "TASKS_DO" })
```

The assembly file is nearly identical — a record mapping names to implementations. The handler files are nearly identical — same `onEvent`/`onAlarm` shape. The key difference is that the schema moves from the handler file to `registry.ts`, and `registry.handler()` replaces `Task.define()`.

### Step 4: Use Externally

From a worker route, API handler, or anywhere outside the durable runtime:

```typescript
// worker.ts
import { OnboardLocation, SaveLocationInfo } from "./tasks"

export default {
  async fetch(request: Request, env: Env) {
    // The task tag is callable — pass the DO namespace, get a typed handle
    yield* OnboardLocation(env.TASKS_DO).send("location-123", {
      type: "begin",
      connectedLocationId: "loc-456",
      workspaceId: "ws-789",
    })

    // Read state
    const state = yield* SaveLocationInfo(env.TASKS_DO).getState("loc-456")
  },
}
```

No `tasks()` accessor needed. The tag IS the accessor. Import the tag, call it with the namespace, get a typed handle.

### Inline Handlers (Small Registries)

For small projects where file-per-handler is overkill, `registry.implement()` lets you define everything in one place:

```typescript
// tasks/index.ts
import { registry, SaveLocationInfo } from "./registry"

export const { TasksDO, client } = registry.implement({
  sessionVisor: {
    services: VisorServicesLive,
    onEvent: (ctx, event) => ...,
    onAlarm: (ctx) => ...,
  },
  saveGoogleLocationInfo: {
    services: SaveLocationInfoServicesLive,
    onEvent: (ctx, event) => ...,
    onAlarm: (ctx) => ...,
  },
  onboardLocation: {
    onAlarm: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.task(SaveLocationInfo).send(...)
      }),
  },
}).build({ binding: "TASKS_DO" })
```

Same type safety, just all in one file. Use whichever pattern fits the project size.

---

## How `ctx.task()` Works

### The Type

```typescript
interface TaskCtx<S, Tags extends TaskTag<any, any, any>> {
  // ── State ──────────────────────────────────────────────
  readonly recall: () => Effect.Effect<S | null, TaskError>
  readonly save: (state: S) => Effect.Effect<void, TaskError>
  readonly update: (fn: (s: S) => S) => Effect.Effect<void, TaskError>

  // ── Scheduling ─────────────────────────────────────────
  readonly scheduleIn: (delay: Duration.Input) => Effect.Effect<void, TaskError>
  readonly scheduleAt: (time: Date | number) => Effect.Effect<void, TaskError>
  readonly cancelSchedule: () => Effect.Effect<void, TaskError>
  readonly nextAlarm: () => Effect.Effect<number | null, TaskError>

  // ── Lifecycle ──────────────────────────────────────────
  readonly purge: () => Effect.Effect<never, PurgeSignal>

  // ── Identity ───────────────────────────────────────────
  readonly id: string
  readonly name: string

  // ── Sibling Access ─────────────────────────────────────
  readonly task: <T extends Tags>(tag: T) => TaskHandle<StateOf<T>, EventOf<T>>
}
```

`Tags` is the union of all task tags from the registry. When you write `ctx.task(SaveLocationInfo)`, TypeScript:

1. Narrows `T` to `typeof SaveLocationInfo` (which is `TaskTag<"saveGoogleLocationInfo", SaveState, SaveEvent>`)
2. Extracts `StateOf<T>` → `SaveState`
3. Extracts `EventOf<T>` → `SaveEvent`
4. Returns `TaskHandle<SaveState, SaveEvent>`

The handle's `.send()` now requires the exact event type. Wrong fields, wrong shape, missing discriminant — all caught at compile time.

### The Runtime

At runtime, `ctx.task(tag)` does:

1. Read `tag.name` → `"saveGoogleLocationInfo"`
2. Build a `TaskHandle` using the name + the DO namespace (captured by the engine at construction)
3. The handle's `.send(id, event)` POSTs to the target DO instance (`saveGoogleLocationInfo:${id}`)

Same dispatch mechanism as external access. Each task+id pair is its own DO instance with isolated storage.

---

## Type Flow Diagram

```
Task.make("name", { state, event })
  → TaskTag<"name", S, E>

TaskRegistry.make(Tag1, Tag2, Tag3)
  → TaskRegistry<Tag1 | Tag2 | Tag3>
                      │
                      │  (Tags type parameter)
                      ▼
registry.implement({ ... })  or  registry.handler("name", config)
                      │
                      │  (Tags flows into handler config)
                      ▼
  TaskHandlerConfig<S, E, Tags>
    ctx: TaskCtx<S, Tags>
      ctx.task(Tag2) → TaskHandle<S2, E2>    ← fully typed
      ctx.recall()   → Effect<S | null>       ← knows own state
      event          → E                      ← knows own event
```

No step in this chain depends on a later step. Types flow strictly forward.

---

## Key Type Definitions

```typescript
// ── Task Tag ─────────────────────────────────────────────

interface TaskTag<Name extends string, S, E> {
  readonly _tag: "TaskTag"
  readonly name: Name
  readonly state: PureSchema<S>
  readonly event: PureSchema<E>

  // Callable — external access
  (namespace: DurableObjectNamespaceLike): TaskHandle<S, E>
}

// ── Task Handle ──────────────────────────────────────────

interface TaskHandle<S, E> {
  readonly send: (id: string, event: E) => Effect.Effect<void, TaskClientError>
  readonly alarm: (id: string) => Effect.Effect<void, TaskClientError>
  readonly getState: (id: string) => Effect.Effect<S | null, TaskClientError>
}

// ── Registry ─────────────────────────────────────────────

interface TaskRegistry<Tags extends TaskTag<any, any, any>> {
  // Implement all handlers at once (validates completeness)
  implement(handlers: {
    [K in Tags["name"]]: TaskHandlerConfig<
      StateFor<Tags, K>,
      EventFor<Tags, K>,
      Tags
    >
  }): {
    build(options?: { binding?: string }): {
      TasksDO: DurableObjectClass
      client: TaskClient<Tags>
    }
  }

  // Implement one handler (for file splitting)
  handler<K extends Tags["name"]>(
    name: K,
    config: TaskHandlerConfig<StateFor<Tags, K>, EventFor<Tags, K>, Tags>,
  ): TaskHandler<K>

  // Build from individual handlers (validates completeness)
  build(
    handlers: { [K in Tags["name"]]: TaskHandler<K> },
    options?: { binding?: string },
  ): {
    TasksDO: DurableObjectClass
    client: TaskClient<Tags>
  }
}

// ── Handler Config ───────────────────────────────────────

interface TaskHandlerConfig<S, E, Tags extends TaskTag<any, any, any>, R = never> {
  readonly services?: Layer.Layer<R>
  readonly onEvent: (ctx: TaskCtx<S, Tags>, event: E) => Effect.Effect<void, any, R>
  readonly onAlarm: (ctx: TaskCtx<S, Tags>) => Effect.Effect<void, any, R>
  readonly onError?: (ctx: TaskCtx<S, Tags>, error: any) => Effect.Effect<void, any, R>
  readonly onClientGetState?: (ctx: TaskCtx<S, Tags>, state: S | null) => Effect.Effect<S | null, any, R>
}

// ── Type Helpers ─────────────────────────────────────────

type StateFor<Tags, K> = Extract<Tags, { name: K }> extends TaskTag<any, infer S, any> ? S : never
type EventFor<Tags, K> = Extract<Tags, { name: K }> extends TaskTag<any, any, infer E> ? E : never
type StateOf<T> = T extends TaskTag<any, infer S, any> ? S : never
type EventOf<T> = T extends TaskTag<any, any, infer E> ? E : never
```

---

## What Changes From the Current Design

| Concept | Current | Redesign |
|---------|---------|----------|
| **Task declaration** | `Task.define({ state, event, onEvent, onAlarm })` — schemas + handlers together | `Task.make("name", { state, event })` — schemas only, handlers separate |
| **Handler location** | Inside the task definition | Provided to the registry via `implement()` or `handler()` |
| **Registry creation** | `createTasks({ name: taskDef })` — implicit from definitions | `TaskRegistry.make(Tag1, Tag2)` — explicit from task tags |
| **Context type** | `TaskContext<S>` — knows own state only | `TaskCtx<S, Tags>` — knows own state + all siblings |
| **Sibling access** | Not possible (circular reference) | `ctx.task(Tag).send(id, event)` — fully typed |
| **External access** | `tasks(env.TASKS_DO, "name").send(id, event)` | `MyTask(env.TASKS_DO).send(id, event)` — tag is callable |
| **Services** | `withServices(taskDef, layer)` wraps the definition | `services: layer` field in the handler config |
| **File structure** | Task definition = one file per task (schemas + handlers) | Schemas, registry, and handlers can be separate files |

What stays the same:
- `TaskHandle<S, E>` — the interface for send/alarm/getState
- `TaskContext` methods — recall, save, update, scheduleIn, scheduleAt, purge, etc.
- Error types — TaskError, PurgeSignal, TaskExecutionError, etc.
- Storage/Alarm service abstractions
- Runtime dispatch — POST to DO stub via namespace
- The DO class pattern — TasksDO with fetch/alarm

---

## Why This Eliminates the Circular Reference

The current circular reference:

```typescript
// ❌ Current — handler value closes over `tasks` value from createTasks output
const { tasks } = createTasks({ onboardLocation: Task.define({
  onAlarm: (ctx) => {
    tasks(env.TASKS_DO, "save").send(...)  // `tasks` not yet defined!
  }
})})
```

The redesign has no cycle because declarations, registry, and handlers are three separate steps:

```typescript
// Step 1: Declaration (no handler code, no dependency on registry)
const Save = Task.make("save", { state: ..., event: ... })
const Onboard = Task.make("onboard", { state: ..., event: ... })

// Step 2: Registry (depends on declarations, not on handlers)
const registry = TaskRegistry.make(Save, Onboard)

// Step 3: Handlers (depend on registry — but registry doesn't depend on handlers)
registry.implement({
  onboard: {
    onAlarm: (ctx) => ctx.task(Save).send(...)  // ✅ registry type is resolved
  },
  save: { ... }
})
```

Each step depends only on the previous step. No cycles.

---

## Open Questions

**1. Should `ctx.task(tag)` also support string-based access?**

```typescript
// Tag-based (primary)
ctx.task(SaveLocationInfo).send(id, event)

// String-based (convenience)
ctx.task("saveGoogleLocationInfo").send(id, event)
```

Both could be supported via overloads. The string version gets the same type safety (the string literal is constrained to `Tags["name"]`). Trade-off: string-based doesn't require importing the tag.

**2. Should `implement()` require ALL tasks or allow partial?**

Requiring all tasks (mapped type) catches forgotten implementations at compile time. But it means you can't partially build. The per-file `handler()` + `build()` pattern already handles progressive assembly.

Recommendation: `implement()` requires all. `build()` from individual handlers also validates completeness.

**3. How does the `client` return work?**

```typescript
const { TasksDO, client } = registry.build(...)

// Is `client` needed if tags are already callable?
OnboardLocation(env.TASKS_DO).send(...)    // tag-based — no client needed
client(env.TASKS_DO, "onboardLocation")    // string-based — uses client
```

The tag-based external access doesn't need `client` at all — the tag is self-sufficient. `client` could still exist as a string-based accessor for cases where you don't have the tag imported, keeping backward compatibility with the current `tasks()` pattern.

**4. Should the task tag carry the name as a type-level literal?**

Yes. `TaskTag<"onboardLocation", S, E>` — the name is a string literal type. This enables:
- `Tags["name"]` produces `"sessionVisor" | "saveGoogleLocationInfo" | "onboardLocation"`
- `Extract<Tags, { name: "onboardLocation" }>` narrows to the specific tag
- String-based `ctx.task("name")` gets full type inference

**5. What about error type tracking per handler?**

The current design tracks `EErr`, `AErr`, `OErr`, `GErr` separately. The redesign should preserve this. The `TaskHandlerConfig` would have the same granular error params, and `onError` receives `EErr | AErr` typed.

**6. Runtime adapter pattern?**

The current `makeTaskEngine` / Cloudflare adapter stays. The `registry.build({ binding })` call produces the Cloudflare-specific `TasksDO` class. For other runtimes, a different build target:

```typescript
registry.build(handlers, { binding: "TASKS_DO" })           // → Cloudflare DO
registry.buildForDeno(handlers, { kv: "TASKS_KV" })         // → hypothetical Deno adapter
```

The handler configs are runtime-agnostic. Only the build step is platform-specific.
