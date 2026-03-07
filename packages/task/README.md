# @durable-effect/task

Durable, event-driven tasks on Cloudflare Workers backed by [Effect](https://effect.website) and Durable Objects. Define type-safe state machines with schemas, schedule alarms, persist state — all with zero boilerplate.

## Install

```bash
npm install @durable-effect/task effect
```

## Quick Start

### 1. Define a Task

A task is a state machine. You provide schemas for state and events, then write handlers.

```typescript
// src/tasks/counter.ts
import { Effect, Schema } from "effect"
import { Task } from "@durable-effect/task"
import { createTasks } from "@durable-effect/task/cloudflare"

// -- Schemas --

const CounterState = Schema.Struct({
  count: Schema.Number,
})

const StartEvent = Schema.Struct({
  _tag: Schema.Literal("Start"),
})

// -- Task definition --

const counter = Task.define({
  state: CounterState,
  event: StartEvent,

  onEvent: (ctx, _event) =>
    Effect.gen(function* () {
      yield* ctx.save({ count: 0 })
      yield* ctx.scheduleIn("2 seconds")
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const current = yield* ctx.recall()
      const count = (current?.count ?? 0) + 1
      yield* ctx.save({ count })

      if (count >= 10) {
        yield* ctx.purge() // delete all state, stop the task
      }

      yield* ctx.scheduleIn("2 seconds")
    }),
})

// -- Export DO class + typed client --

export const { TasksDO, tasks } = createTasks({ counter })
```

`Task.define()` returns a `TaskDefinition`. `createTasks()` takes a record of definitions and returns:

- **`TasksDO`** — A Durable Object class. Export this from your worker.
- **`tasks`** — A type-safe accessor function for sending events to tasks.

### 2. Export the Durable Object

Your worker entry point must export the DO class so Cloudflare can instantiate it.

```typescript
// src/index.ts
export { TasksDO } from "./tasks/counter.js"

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // your fetch handler
  },
} satisfies ExportedHandler<Env>
```

### 3. Configure wrangler

Bind the DO class in your `wrangler.jsonc` (or `wrangler.toml`):

```jsonc
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      {
        "name": "TASKS_DO",
        "class_name": "TasksDO"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_classes": ["TasksDO"]
    }
  ]
}
```

### 4. Send Events & Read State

Use the `tasks` accessor to get a type-safe handle for a specific task, then call `send()`, `getState()`, or `alarm()`.

```typescript
import { Effect } from "effect"
import { tasks } from "./tasks/counter.js"
import { env } from "cloudflare:workers"

// Get a handle — name is type-checked against your definitions
const counter = tasks(env.TASKS_DO, "counter")

// Send an event — event shape is type-checked against the task's schema
yield* counter.send("my-counter-id", { _tag: "Start" }).pipe(Effect.orDie)

// Read the current state — returns S | null (null if no state has been saved yet)
const state = yield* counter.getState("my-counter-id").pipe(Effect.orDie)
// state is typed as { count: number } | null
```

The accessor signature is `tasks(doNamespace, taskName)` and returns a `TaskHandle` bound to that namespace and task. The handle has three methods:

```typescript
counter.send(id: string, event: StartEvent)     // => Effect<void, TaskClientError>
counter.getState(id: string)                     // => Effect<CounterState | null, TaskClientError>
counter.alarm(id: string)                        // => Effect<void, TaskClientError>
```

Both the task name and the event payload are fully type-safe — no string guessing, no casts. The state return type is inferred from your task's state schema.

---

## Core Concepts

### TaskContext

Every handler receives a `TaskContext<S>` where `S` is your state type. This is your entire API inside a task:

```typescript
interface TaskContext<S> {
  // State
  recall(): Effect<S | null, TaskError>       // read persisted state (null if none)
  save(state: S): Effect<void, TaskError>     // write state
  update(fn: (s: S) => S): Effect<void, TaskError>  // read-modify-write

  // Scheduling
  scheduleIn(delay: Duration.Input): Effect<void, TaskError>  // e.g. "5 seconds", "1 minute"
  scheduleAt(time: Date | number): Effect<void, TaskError>    // absolute timestamp
  cancelSchedule(): Effect<void, TaskError>
  nextAlarm(): Effect<number | null, TaskError>

  // Lifecycle
  purge(): Effect<never, PurgeSignal>  // delete all state, cancel alarms

  // Identity
  id: string    // instance ID (what you passed to send())
  name: string  // task name (the key in your definitions record)
}
```

### Schemas Must Be Pure

State and event schemas cannot have service dependencies for encoding/decoding. They must satisfy `PureSchema<T>`:

```typescript
// Good — pure schemas
const MyState = Schema.Struct({ count: Schema.Number })
const MyEvent = Schema.Struct({ _tag: Schema.Literal("Go"), value: Schema.String })

// Bad — schema that requires services to decode (won't compile)
```

This ensures task data can be serialized independently of the Effect runtime.

### Error Handling

Tasks can define an optional `onError` handler that catches errors from `onEvent` and `onAlarm`:

```typescript
const myTask = Task.define({
  state: MyState,
  event: MyEvent,

  onEvent: (_ctx, _event) => Effect.fail(new Error("something broke")),
  onAlarm: () => Effect.void,

  onError: (ctx, error) =>
    Effect.gen(function* () {
      // error is unknown — the raw caught value
      yield* ctx.save({ count: -1 }) // save recovery state
    }),
})
```

If no `onError` is provided, handler errors propagate as `TaskExecutionError`.

### Tasks with Service Dependencies

If your handlers need Effect services, use `withServices()` to provide a layer and eliminate the `R` type parameter before passing to `createTasks`:

```typescript
import { withServices } from "@durable-effect/task"

const myTask = Task.define({
  state: MyState,
  event: MyEvent,
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      const db = yield* DatabaseService
      // ...
    }),
  onAlarm: () => Effect.void,
})

// Provide the layer to eliminate R
const myTaskResolved = withServices(myTask, DatabaseServiceLive)

export const { TasksDO, tasks } = createTasks({
  myTask: myTaskResolved,
})
```

### Multiple Tasks in One DO

Pass multiple task definitions to `createTasks`. They share a single Durable Object class but each task has its own isolated state per instance:

```typescript
const counter = Task.define({ /* ... */ })
const emailer = Task.define({ /* ... */ })
const scheduler = Task.define({ /* ... */ })

export const { TasksDO, tasks } = createTasks({ counter, emailer, scheduler })

// Each returns a handle with the correct event type
const c = tasks(env.TASKS_DO, "counter")    // TaskHandle<CounterState, CounterEvent>
const e = tasks(env.TASKS_DO, "emailer")    // TaskHandle<EmailState, EmailEvent>
const s = tasks(env.TASKS_DO, "scheduler")  // TaskHandle<SchedulerState, SchedulerEvent>
```

---

## Testing

The package provides in-memory implementations of Storage and Alarm for testing without Cloudflare:

```typescript
import { Effect, Layer, Schema } from "effect"
import {
  Task,
  TaskRunner,
  registerTask,
  buildRegistryLayer,
  TaskRunnerLive,
  makeInMemoryStorage,
  makeInMemoryAlarm,
} from "@durable-effect/task"

// -- Set up test stack --

const CounterState = Schema.Struct({ count: Schema.Number })
const IncrementEvent = Schema.Struct({
  _tag: Schema.Literal("Increment"),
  amount: Schema.Number,
})

const counterTask = Task.define({
  state: CounterState,
  event: IncrementEvent,
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      const current = yield* ctx.recall()
      const count = current ? current.count : 0
      yield* ctx.save({ count: count + event.amount })
    }),
  onAlarm: () => Effect.void,
})

function makeTestStack() {
  const { layer: storageLayer, handle: storageHandle } = makeInMemoryStorage()
  const { layer: alarmLayer, handle: alarmHandle } = makeInMemoryAlarm()
  const registryLayer = buildRegistryLayer({
    counter: registerTask(counterTask),
  })

  const fullLayer = Layer.provide(
    TaskRunnerLive,
    Layer.mergeAll(registryLayer, storageLayer, alarmLayer),
  )

  return { fullLayer, storageHandle, alarmHandle }
}

// -- Test --

const { fullLayer, storageHandle, alarmHandle } = makeTestStack()

const program = Effect.gen(function* () {
  const runner = yield* TaskRunner
  yield* runner.handleEvent("counter", "c-1", { _tag: "Increment", amount: 5 })
  yield* runner.handleEvent("counter", "c-1", { _tag: "Increment", amount: 3 })
})

await Effect.runPromise(Effect.provide(program, fullLayer))

// Inspect state
storageHandle.getData().get("t:state") // => { count: 8 }

// Inspect alarms
alarmHandle.isScheduled()     // => false (no alarm was set)
alarmHandle.getScheduledTime() // => null
```

### Test Stack Components

| Function | Returns | Purpose |
|----------|---------|---------|
| `makeInMemoryStorage()` | `{ layer, handle }` | In-memory Storage + inspection handle |
| `makeInMemoryAlarm()` | `{ layer, handle }` | In-memory Alarm + inspection handle |
| `buildRegistryLayer(config)` | `Layer<TaskRegistry>` | Registry layer from name-to-task map |
| `TaskRunnerLive` | `Layer<TaskRunner>` | Runner wired to Registry + Storage + Alarm |
| `registerTask(definition)` | `RegisteredTask` | Registers a definition (R must be `never`) |

---

## API Reference

### Exports from `@durable-effect/task`

```typescript
// Define tasks
Task.define(config)         // => TaskDefinition<S, E, Err, R>
withServices(def, layer)    // => TaskDefinition<S, E, Err, never>

// Registry (for testing / custom runtimes)
registerTask(def)           // => RegisteredTask
registerTaskWithLayer(def, layer)  // => RegisteredTask
buildRegistryLayer(config)  // => Layer<TaskRegistry>
TaskRunnerLive              // Layer<TaskRunner, never, TaskRegistry | Storage | Alarm>

// In-memory test implementations
makeInMemoryStorage()       // => { layer: Layer<Storage>, handle: InMemoryStorageHandle }
makeInMemoryAlarm()         // => { layer: Layer<Alarm>, handle: InMemoryAlarmHandle }

// Services
TaskRunner                  // Effect service for running tasks
TaskRegistry                // Effect service for task lookup
Storage                     // Effect service for key-value persistence
Alarm                       // Effect service for scheduling

// Errors
TaskError                   // Handler context errors
TaskNotFoundError           // Unknown task name
TaskValidationError         // Event schema decode failure
TaskExecutionError          // Handler threw
PurgeSignal                 // Internal control flow (you don't catch this)
```

### Exports from `@durable-effect/task/cloudflare`

```typescript
// Factory
createTasks(definitions)    // => { TasksDO, tasks: TasksAccessor<T> }

// Low-level (for custom DO setups)
makeTaskEngine(state, config)     // => { fetch, alarm }
makeCloudflareStorage(doStorage)  // => Layer<Storage>
makeCloudflareAlarm(doStorage)    // => Layer<Alarm>

// Types
TaskHandle<S, E>            // Bound client: { send(id, event), getState(id), alarm(id) }
TasksAccessor<T>            // (doNamespace, name) => TaskHandle<StateOf<T, K>, EventOf<T, K>>
DurableObjectNamespaceLike  // Structural type for CF DO namespace
EventOf<T, K>               // Extract event type from definitions record
StateOf<T, K>               // Extract state type from definitions record
TaskClientError             // Error from client-side DO fetch
```

## How It Works

When you call `counter.send("my-id", { _tag: "Start" })`:

1. The client builds a DO instance ID: `"counter:my-id"`
2. Fetches the DO stub via `doNamespace.idFromName()` / `doNamespace.get()`
3. POSTs `{ type: "event", name: "counter", id: "my-id", event: { _tag: "Start" } }` to the DO
4. Inside the DO, `TaskEngine` receives the request:
   - Looks up `"counter"` in the `TaskRegistry`
   - Decodes the event against the task's schema (fails with `TaskValidationError` if invalid)
   - Builds a `TaskContext` wrapping Cloudflare's storage and alarm APIs
   - Runs `onEvent(ctx, decodedEvent)` inside the Effect runtime
5. State changes via `ctx.save()` persist to Durable Object storage
6. Alarms scheduled via `ctx.scheduleIn()` use Durable Object alarms
7. When an alarm fires, Cloudflare calls the DO's `alarm()` method, which runs `onAlarm(ctx)`

When you call `counter.getState("my-id")`:

1. The client builds the same DO instance ID: `"counter:my-id"`
2. POSTs `{ type: "state", name: "counter", id: "my-id" }` to the DO
3. The DO reads the persisted state from storage and returns it as JSON
4. The client returns the decoded state (or `null` if no state exists yet)

Each task instance (unique combination of task name + ID) gets its own isolated Durable Object with its own storage.
