# Task v4 - Durable Task Framework

## Overview

Task is a framework for building durable, stateful computations on top of persistent compute platforms (Cloudflare Durable Objects today, swappable tomorrow). It gives developers a simple interface to:

1. Accept input and persist state
2. Schedule when the compute should wake up
3. Run logic when the alarm fires
4. Repeat or terminate

The framework is built on Effect v4 and organized into three layers.

---

## Architecture

```
 Layer 1: Task Interface         (what the user writes)
         |
 Layer 2: Adapter                (manages state + scheduling, our vocabulary)
         |
 Layer 3: Durable Compute        (Cloudflare DO, swappable)
```

---

## Layer 1 - Task Interface

This is what the user writes. A task definition is a plain object with schemas and handlers. The key simplification from the current system: **the user gets a single `ctx` with everything they need, and services can be required at the task level.**

### Defining a Task

```ts
import { Task } from "@backpine/task"
import { Effect, Schema } from "effect"

// -- schemas/order.ts --

const OrderState = Schema.Struct({
  orderId: Schema.String,
  status: Schema.Literal("pending", "processing", "shipped", "delivered"),
  attempts: Schema.Number,
})

const OrderEvent = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("place"), orderId: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("ship"), trackingId: Schema.String }),
)

// -- tasks/order.ts --

const orderTask = Task.define({
  state: OrderState,
  event: OrderEvent,

  // Called when an event is sent to this task
  onEvent: (event, ctx) =>
    Effect.gen(function* () {
      switch (event._tag) {
        case "place":
          yield* ctx.save({
            orderId: event.orderId,
            status: "pending",
            attempts: 0,
          })
          // Wake up in 5 minutes to check payment
          yield* ctx.scheduleIn("5 minutes")
          break

        case "ship":
          yield* ctx.update((s) => ({ ...s, status: "shipped" }))
          yield* ctx.scheduleIn("24 hours")
          break
      }
    }),

  // Called when the scheduled alarm fires
  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) return

      if (state.status === "pending") {
        // Still pending, retry
        yield* ctx.update((s) => ({ ...s, attempts: s.attempts + 1 }))
        if (state.attempts >= 3) {
          yield* ctx.purge() // Give up, delete everything
        } else {
          yield* ctx.scheduleIn("5 minutes")
        }
      }

      if (state.status === "shipped") {
        yield* ctx.update((s) => ({ ...s, status: "delivered" }))
        yield* ctx.purge()
      }
    }),
})
```

### Task.define API

```ts
Task.define<State, Event, Err, Services>({
  state: Schema<State>,
  event: Schema<Event>,

  // Required
  onEvent: (event: Event, ctx: TaskContext<State>) => Effect<void, Err, Services>,
  onAlarm: (ctx: TaskContext<State>) => Effect<void, Err, Services>,

  // Optional
  onError?: (error: Err, ctx: TaskContext<State>) => Effect<void, never, Services>,
})
```

Key differences from the current system:

- **Two handlers, not four.** `onIdle` is removed (the user can check scheduling state themselves). `onError` stays optional.
- **Single context type.** No more `TaskEventContext`, `TaskExecuteContext`, `TaskIdleContext`, `TaskErrorContext`. One `TaskContext` with all capabilities.
- **Services are declared in the type signature.** The `R` (services) type parameter is no longer forced to `never`. The framework provides them at runtime.
- **Verbs are our own.** `save`, `recall`, `update`, `purge`, `scheduleIn`, `scheduleAt`, `cancelSchedule` - no Durable Object terminology leaking through.

### TaskContext

The context provided to both `onEvent` and `onAlarm`:

```ts
interface TaskContext<S> {
  // -- State --
  recall(): Effect<S | null>         // Get current state
  save(state: S): Effect<void>       // Set state (full replace)
  update(fn: (s: S) => S): Effect<void>  // Modify existing state

  // -- Scheduling --
  scheduleIn(delay: DurationInput): Effect<void>  // Wake up after delay
  scheduleAt(time: Date | number): Effect<void>   // Wake up at specific time
  cancelSchedule(): Effect<void>                  // Cancel pending alarm
  nextAlarm(): Effect<number | null>              // When is the next alarm?

  // -- Lifecycle --
  purge(): Effect<never>             // Delete all state + cancel alarm + terminate

  // -- Metadata --
  readonly id: string                // Instance ID
  readonly name: string              // Task name
}
```

### Providing Services to a Task

Effect v4 uses `ServiceMap.Service` for dependency injection. Tasks that need external services declare them in their return type, and the framework wires them in.

```ts
// -- services/email.ts --
class EmailService extends ServiceMap.Service<EmailService, {
  send: (to: string, body: string) => Effect<void>
}>()("EmailService") {}

// -- services/email-live.ts --
const EmailServiceLive = Layer.effect(
  EmailService,
  Effect.succeed({
    send: (to, body) => Effect.log(`Sending to ${to}: ${body}`),
  }),
)

// -- tasks/notification.ts --
const notificationTask = Task.define({
  state: NotificationState,
  event: NotificationEvent,

  onEvent: (event, ctx) =>
    Effect.gen(function* () {
      const email = yield* EmailService
      yield* email.send(event.to, event.body)
      yield* ctx.save({ sentAt: Date.now(), to: event.to })
      yield* ctx.scheduleIn("1 hour") // Follow-up check
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const email = yield* EmailService
      const state = yield* ctx.recall()
      if (state) {
        yield* email.send(state.to, "Follow-up: did you see our message?")
      }
      yield* ctx.purge()
    }),
})
```

The services are provided when registering the task:

```ts
const { Tasks, TasksClient } = createTasks({
  notification: {
    task: notificationTask,
    services: EmailServiceLive,
  },
  order: {
    task: orderTask,
    // No services needed - handlers return Effect<void, Err, never>
  },
})
```

The `services` field accepts a `Layer<Services>` that satisfies whatever `R` the handlers require. The framework merges this with the built-in layers (TaskContext, etc.) before running the effect.

---

## Layer 2 - Adapter

The adapter is the bridge between the task interface and the underlying compute platform. It owns the vocabulary, orchestrates lifecycle, and delegates actual persistence to Layer 3.

### Adapter Services (Effect v4)

```ts
// -- adapter/store.ts --
// Manages durable key-value state with schema validation

class Store extends ServiceMap.Service<Store, {
  get<T>(schema: Schema<T>): Effect<T | null, StoreError>
  set<T>(schema: Schema<T>, value: T): Effect<void, StoreError>
  delete(): Effect<void, StoreError>
  deleteAll(): Effect<void, StoreError>
}>()("@task/Store") {}

// -- adapter/scheduler.ts --
// Manages alarm scheduling

class Scheduler extends ServiceMap.Service<Scheduler, {
  scheduleIn(delay: DurationInput): Effect<void, SchedulerError>
  scheduleAt(time: Date | number): Effect<void, SchedulerError>
  cancel(): Effect<void, SchedulerError>
  getNext(): Effect<number | null, SchedulerError>
}>()("@task/Scheduler") {}

// -- adapter/instance.ts --
// Instance identity and metadata

class Instance extends ServiceMap.Service<Instance, {
  readonly id: string
  readonly name: string
  readonly taskName: string
}>()("@task/Instance") {}
```

### How the Adapter Orchestrates Execution

When an event arrives or an alarm fires, the adapter:

1. Resolves the task definition from the registry
2. Creates the `TaskContext` (backed by Store + Scheduler services)
3. Provides the user's services layer + adapter services
4. Runs the user's effect
5. Catches `PurgeSignal` to clean up state
6. Catches user errors and routes to `onError` if defined

```ts
// -- adapter/executor.ts --

class TaskExecutor extends ServiceMap.Service<TaskExecutor, {
  handleEvent(taskName: string, instanceId: string, event: unknown): Effect<EventResult, TaskError>
  handleAlarm(taskName: string, instanceId: string): Effect<void, TaskError>
}>()("@task/TaskExecutor") {}

// Implementation sketch:
const TaskExecutorLive = Layer.effect(
  TaskExecutor,
  Effect.gen(function* () {
    const registry = yield* TaskRegistry
    const store = yield* Store
    const scheduler = yield* Scheduler

    return {
      handleEvent: (taskName, instanceId, event) =>
        Effect.gen(function* () {
          const def = registry.get(taskName)

          // Validate event against schema
          const validated = yield* Schema.decodeUnknown(def.event)(event)

          // Build TaskContext backed by real services
          const ctx = createTaskContext(store, scheduler, instanceId, taskName)

          // Run user code with their services provided
          yield* def.onEvent(validated, ctx).pipe(
            Effect.provide(def.servicesLayer),
            Effect.catch((error) => {
              if (error instanceof PurgeSignal) {
                return store.deleteAll().pipe(
                  Effect.zipRight(scheduler.cancel())
                )
              }
              if (def.onError) {
                return def.onError(error, ctx).pipe(
                  Effect.provide(def.servicesLayer)
                )
              }
              return Effect.fail(error)
            }),
          )
        }),

      handleAlarm: (taskName, instanceId) =>
        Effect.gen(function* () {
          const def = registry.get(taskName)
          const ctx = createTaskContext(store, scheduler, instanceId, taskName)

          yield* def.onAlarm(ctx).pipe(
            Effect.provide(def.servicesLayer),
            Effect.catch((error) => {
              if (error instanceof PurgeSignal) {
                return store.deleteAll().pipe(
                  Effect.zipRight(scheduler.cancel())
                )
              }
              if (def.onError) {
                return def.onError(error, ctx).pipe(
                  Effect.provide(def.servicesLayer)
                )
              }
              return Effect.fail(error)
            }),
          )
        }),
    }
  }),
)
```

### Adapter Storage Keys

The adapter defines its own key namespace:

```ts
const KEYS = {
  STATE: "t:state",           // User's schema-validated state
  META: "t:meta",             // Internal metadata (task name, status, created)
  ALARM: "t:alarm",           // Scheduled alarm timestamp
  EVENT_COUNT: "t:events",    // Number of events received
  ALARM_COUNT: "t:alarms",    // Number of alarms fired
  CREATED_AT: "t:created",    // When this instance was first created
}
```

### TaskContext Implementation

The `TaskContext` is a thin wrapper over Store + Scheduler:

```ts
function createTaskContext<S>(
  store: Store,
  scheduler: Scheduler,
  id: string,
  name: string,
  stateSchema: Schema<S>,
): TaskContext<S> {
  return {
    recall: () => store.get(stateSchema),

    save: (state) => store.set(stateSchema, state),

    update: (fn) =>
      Effect.gen(function* () {
        const current = yield* store.get(stateSchema)
        if (current !== null) {
          yield* store.set(stateSchema, fn(current))
        }
      }),

    scheduleIn: (delay) => scheduler.scheduleIn(delay),
    scheduleAt: (time) => scheduler.scheduleAt(time),
    cancelSchedule: () => scheduler.cancel(),
    nextAlarm: () => scheduler.getNext(),

    purge: () => Effect.fail(new PurgeSignal()),

    id,
    name,
  }
}
```

---

## Layer 3 - Durable Compute

This layer provides the actual implementations of `Store` and `Scheduler` backed by a real durable platform. Today that's Cloudflare Durable Objects. Tomorrow it could be something else.

### Cloudflare DO Implementation

```ts
// -- compute/cloudflare/store.ts --

const CloudflareStoreLive = (state: DurableObjectState): Layer<Store> =>
  Layer.succeed(Store, {
    get: (schema) =>
      Effect.gen(function* () {
        const raw = yield* Effect.tryPromise(() => state.storage.get(KEYS.STATE))
        if (raw === undefined) return null
        return yield* Schema.decodeUnknown(schema)(raw)
      }),

    set: (schema, value) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encode(schema)(value)
        yield* Effect.tryPromise(() => state.storage.put(KEYS.STATE, encoded))
      }),

    delete: () =>
      Effect.tryPromise(() => state.storage.delete(KEYS.STATE)).pipe(Effect.asVoid),

    deleteAll: () =>
      Effect.tryPromise(() => state.storage.deleteAll()).pipe(Effect.asVoid),
  })

// -- compute/cloudflare/scheduler.ts --

const CloudflareSchedulerLive = (state: DurableObjectState): Layer<Scheduler> =>
  Layer.succeed(Scheduler, {
    scheduleIn: (delay) =>
      Effect.tryPromise(() => {
        const ms = Duration.toMillis(Duration.decode(delay))
        return state.storage.setAlarm(Date.now() + ms)
      }),

    scheduleAt: (time) =>
      Effect.tryPromise(() => {
        const ts = time instanceof Date ? time.getTime() : time
        return state.storage.setAlarm(ts)
      }),

    cancel: () =>
      Effect.tryPromise(() => state.storage.deleteAlarm()).pipe(Effect.asVoid),

    getNext: () =>
      Effect.tryPromise(() => state.storage.getAlarm()).pipe(
        Effect.map((t) => t ?? null),
      ),
  })
```

### The Durable Object Shell

The DO itself is extremely thin. It just routes `call()` and `alarm()` to the adapter:

```ts
// -- compute/cloudflare/engine.ts --

export class TaskEngine extends DurableObject {
  #executor: TaskExecutor | null = null

  private getExecutor(): TaskExecutor {
    if (!this.#executor) {
      // Build the full layer stack
      const computeLayer = Layer.mergeAll(
        CloudflareStoreLive(this.ctx),
        CloudflareSchedulerLive(this.ctx),
        InstanceLive(this.ctx.id.toString()),
      )

      const fullLayer = TaskExecutorLive.pipe(
        Layer.provide(computeLayer),
        Layer.provide(registryLayer),
      )

      this.#executor = // ... resolve from layer
    }
    return this.#executor
  }

  async call(request: TaskRequest): Promise<TaskResponse> {
    const executor = this.getExecutor()
    return Effect.runPromise(executor.handleEvent(...))
  }

  async alarm(): Promise<void> {
    const executor = this.getExecutor()
    return Effect.runPromise(executor.handleAlarm(...))
  }
}
```

### Swappability

Because Layer 2 only depends on `Store`, `Scheduler`, and `Instance` services (not Cloudflare types), you can swap Layer 3:

```ts
// For testing
const TestStoreLive = Layer.succeed(Store, {
  get: () => ...,   // backed by a Map
  set: () => ...,
  ...
})

// For a hypothetical future platform
const FlyMachineStoreLive = Layer.effect(Store, ...)
```

---

## Registration & Client

### Creating the Task Engine

```ts
// -- index.ts (worker entry) --
import { createTasks } from "@backpine/task"
import { orderTask, notificationTask } from "./tasks"
import { EmailServiceLive } from "./services"

const { Tasks, TasksClient } = createTasks({
  order: { task: orderTask },
  notification: {
    task: notificationTask,
    services: EmailServiceLive,
  },
})

// Export the DO class
export { Tasks }

// Use the client in your worker
export default {
  async fetch(request: Request, env: Env) {
    const client = TasksClient.fromBinding(env.TASKS)

    // Send an event - the key "order" is the task name
    const result = await Effect.runPromise(
      client.task("order").send({
        id: "order-123",
        event: { _tag: "place", orderId: "order-123" },
      })
    )

    return Response.json(result)
  },
}
```

### Client Interface

```ts
interface TaskClient<State, Event> {
  send(opts: { id: string; event: Event }): Effect<SendResult>
  trigger(id: string): Effect<TriggerResult>
  terminate(id: string): Effect<TerminateResult>
  status(id: string): Effect<StatusResult>
  getState(id: string): Effect<GetStateResult<State>>
}

interface TasksClientI<Registry> {
  task<K extends keyof Registry>(name: K): TaskClient<StateOf<K>, EventOf<K>>
}
```

---

## Error Model

```ts
// User-facing errors
class StoreError extends Data.TaggedError("StoreError")<{
  message: string
  cause?: unknown
}> {}

class SchedulerError extends Data.TaggedError("SchedulerError")<{
  message: string
  cause?: unknown
}> {}

class ValidationError extends Data.TaggedError("ValidationError")<{
  message: string
  cause?: unknown
}> {}

// Internal signals
class PurgeSignal extends Data.TaggedError("PurgeSignal")<{}> {}

// Client errors
class TaskNotFoundError extends Data.TaggedError("TaskNotFoundError")<{
  name: string
}> {}

class ClientError extends Data.TaggedError("ClientError")<{
  message: string
  cause?: unknown
}> {}
```

---

## File Structure

```
packages/task/
  src/
    index.ts                   # Public exports
    define.ts                  # Task.define() factory
    types.ts                   # TaskContext, TaskDefinition types
    errors.ts                  # Error types + PurgeSignal
    factory.ts                 # createTasks() registration

    adapter/
      store.ts                 # Store service definition
      scheduler.ts             # Scheduler service definition
      instance.ts              # Instance service definition
      executor.ts              # TaskExecutor orchestration
      context.ts               # createTaskContext implementation
      keys.ts                  # Storage key constants
      registry.ts              # Task registry service

    compute/
      cloudflare/
        store.ts               # CF DO storage implementation
        scheduler.ts           # CF DO alarm implementation
        engine.ts              # The thin DO shell
        index.ts

      testing/
        store.ts               # In-memory store for tests
        scheduler.ts           # In-memory scheduler for tests
        harness.ts             # Test harness for running tasks
        index.ts

    client/
      client.ts                # TasksClient implementation
      types.ts                 # Client types + responses
      index.ts
```

---

## Effect v4 Patterns Used

| Pattern | Where | Why |
|---|---|---|
| `ServiceMap.Service` class syntax | Store, Scheduler, Instance, TaskExecutor | Clean service definitions with type inference |
| `Layer.effect` / `Layer.succeed` | All service implementations | Composable dependency wiring |
| `Schema.Struct`, `Schema.Union` | Task state/event schemas | v4 schema API for validation + encoding |
| `Effect.gen` + `yield*` | All handlers and implementations | Readable async-like code |
| `Data.TaggedError` | All error types | Discriminated union errors with `_tag` |
| `Effect.provide(layer)` | User services injection | Satisfying `R` type parameter per-task |
| `Effect.catch` | Error handling in executor | v4 renamed from `catchAll` |

---

## Design Principles

1. **Two handlers, one context.** Users write `onEvent` and `onAlarm`. That's it. One context type with everything.

2. **Our vocabulary.** `save`, `recall`, `update`, `purge`, `scheduleIn`, `scheduleAt`. No "Durable Object storage" or "alarm" in the user-facing API.

3. **Services at the task level.** Tasks can require services (`R` type parameter). The framework provides them during registration.

4. **Thin compute layer.** The DO is a shell. All logic lives in the adapter. Swap the compute layer without touching anything else.

5. **Schema-first.** State and events are always schema-validated. This gives us encoding for persistence and decoding for retrieval automatically.

6. **Effect v4 native.** Built on `ServiceMap.Service`, new Schema API, `Effect.catch`, and the flattened `Cause` model. No v3 compat shims.
