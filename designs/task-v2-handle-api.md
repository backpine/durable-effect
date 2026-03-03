# Task V2: Type-Safe Task Handle API

## Problem

The current `createTasks` API returns a `tasks` object where every call requires threading the DO namespace and task name:

```typescript
const { TasksDO, tasks } = createTasks({ counter, emailer })

// Every call repeats doNamespace + name
yield* tasks.send(env.TASKS_DO, "counter", params.counterId, { _tag: "Start" })
yield* tasks.alarm(env.TASKS_DO, "counter", params.counterId)
yield* tasks.send(env.TASKS_DO, "emailer", params.emailId, { _tag: "Send", to: "x@y.com" })
```

Issues:
1. **Repetitive** — DO namespace and task name are threaded through every call
2. **Flat client surface** — `tasks` is a single object with `send`/`alarm`, no way to get a reference to a specific task type
3. **Hard to pass around** — you can't hand off "a counter task client" to another function without also passing the namespace and name

## Proposed API

`tasks` becomes a callable function. Calling it with a DO namespace and task name returns a **TaskHandle** — a bound, type-safe client for a specific task.

```typescript
const { TasksDO, tasks } = createTasks({ counter, emailer })

// Bind to a specific task — name is type-checked against the definitions
const counterTask = tasks(env.TASKS_DO, "counter")

// send() and alarm() now only need instance-specific params
yield* counterTask.send(params.counterId, { _tag: "Start" })
//                                        ^^^^^^^^^^^^^^^^^
//                        type-narrowed to counter's event schema

yield* counterTask.alarm(params.counterId)

// Different task, different event type
const emailTask = tasks(env.TASKS_DO, "emailer")
yield* emailTask.send(params.emailId, { _tag: "Send", to: "x@y.com" })
//                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                      type-narrowed to emailer's event schema
```

### Handler Usage

```typescript
// Before
export const CounterGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "counter",
  (handlers) =>
    handlers.handle("start", ({ params }) =>
      Effect.gen(function* () {
        yield* tasks
          .send(env.TASKS_DO, "counter", params.counterId, { _tag: "Start" })
          .pipe(Effect.orDie)
        return { status: "ok" as const, counterId: params.counterId }
      }),
    ),
)

// After
export const CounterGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "counter",
  (handlers) =>
    handlers.handle("start", ({ params }) =>
      Effect.gen(function* () {
        const counter = tasks(env.TASKS_DO, "counter")
        yield* counter.send(params.counterId, { _tag: "Start" }).pipe(Effect.orDie)
        return { status: "ok" as const, counterId: params.counterId }
      }),
    ),
)
```

## Type Design

### Core Types

```typescript
/**
 * A handle for a specific task, bound to a DO namespace and task name.
 * E is the event type, narrowed from the task definition.
 */
interface TaskHandle<E> {
  readonly send: (id: string, event: E) => Effect.Effect<void, TaskClientError>
  readonly alarm: (id: string) => Effect.Effect<void, TaskClientError>
}

/**
 * Callable accessor returned by createTasks.
 * Calling it with a namespace and name returns a TaskHandle
 * with the event type narrowed to that task's schema.
 */
interface TasksAccessor<
  T extends Record<string, TaskDefinition<any, any, any, never>>,
> {
  <K extends keyof T & string>(
    doNamespace: DurableObjectNamespaceLike,
    name: K,
  ): TaskHandle<EventOf<T, K>>
}
```

### Type Flow

```
createTasks({ counter, emailer })
  T = { counter: TaskDefinition<CounterState, StartEvent, ...>,
        emailer: TaskDefinition<EmailState, SendEvent, ...> }
         │
         ▼
tasks: TasksAccessor<T>
         │
         │  tasks(env.TASKS_DO, "counter")
         │    K = "counter" (literal, via const generic)
         │    EventOf<T, "counter"> = StartEvent
         ▼
TaskHandle<StartEvent>
  .send(id, event: StartEvent)  ← type-safe
  .alarm(id)
```

No casts. `K` is inferred as a string literal from the argument. `EventOf<T, K>` extracts the event type. The generic flows naturally into `TaskHandle<E>`.

### Supporting Type (unchanged)

```typescript
type EventOf<
  T extends Record<string, TaskDefinition<any, any, any, never>>,
  K extends keyof T,
> = T[K] extends TaskDefinition<any, infer E, any, any> ? E : never
```

## Implementation

### Changes to `createTasks.ts`

Replace `TasksClient<T>` with `TasksAccessor<T>` + `TaskHandle<E>`:

```typescript
import { Effect } from "effect"
import type { TaskDefinition } from "../TaskDefinition.js"
import { registerTask } from "../services/TaskRegistry.js"
import type { TaskRegistryConfig } from "../services/TaskRegistry.js"
import { makeTaskEngine } from "./TaskEngine.js"
import type { DurableObjectState } from "./TaskEngine.js"
import { TaskClientError } from "./errors.js"

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type EventOf<
  T extends Record<string, TaskDefinition<any, any, any, never>>,
  K extends keyof T,
> = T[K] extends TaskDefinition<any, infer E, any, any> ? E : never

// ---------------------------------------------------------------------------
// Structural types
// ---------------------------------------------------------------------------

export interface DurableObjectNamespaceLike {
  idFromName(name: string): { toString(): string }
  get(id: { toString(): string }): {
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response>
  }
}

// ---------------------------------------------------------------------------
// TaskHandle — bound client for a single task type
// ---------------------------------------------------------------------------

export interface TaskHandle<E> {
  readonly send: (id: string, event: E) => Effect.Effect<void, TaskClientError>
  readonly alarm: (id: string) => Effect.Effect<void, TaskClientError>
}

// ---------------------------------------------------------------------------
// TasksAccessor — callable that returns a TaskHandle
// ---------------------------------------------------------------------------

export interface TasksAccessor<
  T extends Record<string, TaskDefinition<any, any, any, never>>,
> {
  <K extends keyof T & string>(
    doNamespace: DurableObjectNamespaceLike,
    name: K,
  ): TaskHandle<EventOf<T, K>>
}

// ---------------------------------------------------------------------------
// createTasks
// ---------------------------------------------------------------------------

export function createTasks<
  const T extends Record<string, TaskDefinition<any, any, any, never>>,
>(
  definitions: T,
): {
  TasksDO: {
    new (state: DurableObjectState): {
      fetch(request: Request): Promise<Response>
      alarm(): Promise<void>
    }
  }
  tasks: TasksAccessor<T>
} {
  const registryConfig: TaskRegistryConfig = {}
  for (const [name, def] of Object.entries(definitions)) {
    registryConfig[name] = registerTask(def)
  }

  class TasksDO {
    private engine: ReturnType<typeof makeTaskEngine>

    constructor(state: DurableObjectState) {
      this.engine = makeTaskEngine(state, {
        name: "__multi__",
        tasks: registryConfig,
      })
    }

    fetch(request: Request): Promise<Response> {
      return this.engine.fetch(request)
    }

    alarm(): Promise<void> {
      return this.engine.alarm()
    }
  }

  const makeHandle = (
    doNamespace: DurableObjectNamespaceLike,
    name: string,
  ): TaskHandle<any> => ({
    send(id, event) {
      return Effect.tryPromise({
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
            throw new Error(`DO error: ${resp.status} ${text}`)
          }
        },
        catch: (cause) =>
          new TaskClientError({
            message:
              cause instanceof Error
                ? cause.message
                : "Unknown error sending event",
            cause,
          }),
      })
    },
    alarm(id) {
      return Effect.tryPromise({
        try: async () => {
          const instanceId = `${name}:${id}`
          const doId = doNamespace.idFromName(instanceId)
          const stub = doNamespace.get(doId)
          const resp = await stub.fetch("http://task/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "alarm", name, id }),
          })
          if (!resp.ok) {
            const text = await resp.text()
            throw new Error(`DO error: ${resp.status} ${text}`)
          }
        },
        catch: (cause) =>
          new TaskClientError({
            message:
              cause instanceof Error
                ? cause.message
                : "Unknown error triggering alarm",
            cause,
          }),
      })
    },
  })

  const tasks: TasksAccessor<T> = (doNamespace, name) =>
    makeHandle(doNamespace, name)

  return { TasksDO, tasks }
}
```

### What Doesn't Change

- `TaskDefinition` — unchanged
- `Task.define()` — unchanged
- `TaskEngine` — unchanged (request format stays the same)
- `TaskRegistry` / `TaskRunner` — unchanged
- `Storage` / `Alarm` services — unchanged
- All test infrastructure — unchanged

The refactor is **entirely in the client surface**. The DO internals, wire protocol, and task definition API are untouched.

## Design Decisions

### Why `TaskHandle<E>` only carries the event type `E`

The handle is a **client** — it sends events over the wire. It doesn't need to know `S` (state) or `Err` (handler errors) because:
- State is internal to the DO, never exposed to the client
- Handler errors are caught inside the DO and returned as HTTP errors → `TaskClientError`

The only type the caller needs is `E` to construct a valid event.

### Why `makeHandle` uses `TaskHandle<any>` internally

The generic `K` flowing through `TasksAccessor` ensures type safety at the call site. Inside `makeHandle`, the `name` is already a `string` and `event` is `unknown` at the wire level (it's JSON-serialized). The `any` is internal implementation detail — callers never see it because `TasksAccessor`'s generic signature narrows the return type.

This is the same pattern Effect's `HttpApiBuilder` uses: the outer generic boundary ensures safety, the internal implementation works with runtime values.

### Why not an Effect service

`TaskHandle` is a plain object, not an Effect service. This is intentional:
- Creating a handle is not effectful (no I/O, no failures)
- Handles are lightweight — just closures over namespace + name
- Making it a service would add ceremony without benefit
- The effects happen in `send()` / `alarm()`, which return `Effect`

## Files Changed

| File | Change |
|------|--------|
| `packages/task-v2/src/cloudflare/createTasks.ts` | Replace `TasksClient` with `TasksAccessor` + `TaskHandle` |
| `examples/effect-worker-api/src/tasks/counter.ts` | No change (createTasks call stays the same) |
| `examples/effect-worker-api/src/handlers/counter.ts` | Update send call to new API |

## Migration

```diff
- yield* tasks.send(env.TASKS_DO, "counter", id, event)
+ const counter = tasks(env.TASKS_DO, "counter")
+ yield* counter.send(id, event)

- yield* tasks.alarm(env.TASKS_DO, "counter", id)
+ const counter = tasks(env.TASKS_DO, "counter")
+ yield* counter.alarm(id)
```

Or inline:
```diff
- yield* tasks.send(env.TASKS_DO, "counter", id, event)
+ yield* tasks(env.TASKS_DO, "counter").send(id, event)
```

## Effect V4 Patterns Used

1. **Const generic inference** — `const T extends Record<...>` preserves literal keys so `K` infers as `"counter"` not `string`
2. **Conditional type extraction** — `EventOf<T, K>` uses `infer E` to pull the event type from the definition, same pattern as `HttpApiEndpoint.Success<>`
3. **Generic narrowing at call boundary** — The accessor's generic `K extends keyof T & string` narrows at the call site, flowing into `TaskHandle<EventOf<T, K>>` without any cast
4. **Closure-captured context** — Handle captures `doNamespace` and `name` in closure, same pattern as Effect's layer/service constructors
