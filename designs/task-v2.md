# Task V2 - Service-Oriented Design

## Guiding Principle

Everything is a service. The entire task framework is a composition of Effect services with clearly defined interfaces. No live implementations in this design - just interfaces and how they compose. The live implementations arrive at the outermost layer when the end user wires things together.

No "adapter layer." No "compute layer." Just services that depend on services.

---

## Service Overview

```
                    ┌───────────────┐
                    │  TaskRunner   │
                    │  (framework)  │
                    └──┬────┬────┬──┘
                       │    │    │
            ┌──────────┘    │    └──────────┐
            ▼               ▼               ▼
      ┌───────────┐  ┌────────────┐  ┌─────────────┐
      │  Storage   │  │   Alarm    │  │ TaskRegistry │
      │ (platform) │  │ (platform) │  │ (framework)  │
      └───────────┘  └────────────┘  └─────────────┘
```

Four services. Two are platform primitives. Two are ours.

---

## Platform Services

These are interfaces. The compute platform provides the live implementation. Today that's Cloudflare DOs. Tomorrow it's whatever.

### Storage

Raw key-value persistence. Nothing more.

```ts
class Storage extends ServiceMap.Service<Storage, {
  readonly get: (key: string) => Effect<unknown | null, StorageError>
  readonly set: (key: string, value: unknown) => Effect<void, StorageError>
  readonly delete: (key: string) => Effect<void, StorageError>
  readonly deleteAll: () => Effect<void, StorageError>
}>()("@task/Storage") {}

class StorageError extends Schema.TaggedErrorClass<StorageError>()(
  "StorageError",
  { cause: Schema.Defect }
) {}
```

### Alarm

Set a timer. Cancel it. Ask when the next one fires. That's it.

```ts
class Alarm extends ServiceMap.Service<Alarm, {
  readonly set: (timestamp: number) => Effect<void, AlarmError>
  readonly cancel: () => Effect<void, AlarmError>
  readonly next: () => Effect<number | null, AlarmError>
}>()("@task/Alarm") {}

class AlarmError extends Schema.TaggedErrorClass<AlarmError>()(
  "AlarmError",
  { cause: Schema.Defect }
) {}
```

That's the entire platform contract. Two services, five methods total. Any durable compute platform that can store key-value pairs and set a timer can implement these.

---

## Framework Services

### TaskRegistry

Holds task definitions. Built from the user's configuration at setup time. This is a data service - it doesn't do work, it just knows what tasks exist and what their definitions look like.

```ts
class TaskRegistry extends ServiceMap.Service<TaskRegistry, {
  readonly get: (name: string) => Option<TaskDefinition<any, any, any, any>>
  readonly names: () => ReadonlyArray<string>
}>()("@task/Registry") {}
```

Created from user config via a static factory:

```ts
// TaskRegistry has a factory that creates a Layer from task definitions
TaskRegistry.from({
  order: orderTask,
  notification: notificationTask,
})
// => Layer<TaskRegistry>
```

### TaskRunner

The single orchestration service. Depends on Storage, Alarm, and TaskRegistry. Handles everything: event dispatch, alarm dispatch, schema validation, context creation, error routing, purge handling.

```ts
class TaskRunner extends ServiceMap.Service<TaskRunner, {
  readonly handleEvent: (
    name: string,
    id: string,
    event: unknown,
  ) => Effect<void, TaskRunnerError>
  readonly handleAlarm: (
    name: string,
    id: string,
  ) => Effect<void, TaskRunnerError>
}>()("@task/Runner") {
  // Layer declares its dependencies - nothing more
  static readonly layer: Layer<
    TaskRunner,
    never,
    Storage | Alarm | TaskRegistry  // what it needs
  >
}

class TaskRunnerError extends Schema.TaggedErrorClass<TaskRunnerError>()(
  "TaskRunnerError",
  {
    reason: Schema.Union(
      Schema.Struct({ _tag: Schema.Literal("NotFound"), name: Schema.String }),
      Schema.Struct({ _tag: Schema.Literal("Validation"), message: Schema.String }),
      Schema.Struct({ _tag: Schema.Literal("Execution"), cause: Schema.Defect }),
    )
  }
) {}
```

What TaskRunner does internally (not part of the interface, but describing its behavior):

1. Looks up the task definition from TaskRegistry
2. Validates the incoming event against the task's event schema
3. Builds a `TaskContext<S>` from Storage + Alarm, parameterized by the task's state schema
4. Runs the handler effect, providing any user-declared service layers
5. Catches `PurgeSignal` → runs cleanup (deleteAll + cancel alarm)
6. Catches handler errors → routes to `onError` if defined

All of this is internal to the TaskRunner implementation. The caller just calls `handleEvent` or `handleAlarm`.

---

## User-Facing API

### Task.define()

Pure definition. No runtime, no services, no layers. Just schemas and handlers.

```ts
const orderTask = Task.define({
  state: OrderState,
  event: OrderEvent,

  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      yield* ctx.save({
        orderId: event.orderId,
        status: "pending",
        attempts: 0,
      })
      yield* ctx.scheduleIn("5 minutes")
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) return

      if (state.status === "pending" && state.attempts >= 3) {
        yield* ctx.purge()
      } else {
        yield* ctx.update((s) => ({ ...s, attempts: s.attempts + 1 }))
        yield* ctx.scheduleIn("5 minutes")
      }
    }),
})
```

### TaskContext\<S\>

The typed interface that handler code interacts with. This is NOT a service - it's a plain object built per-execution by TaskRunner from the Storage and Alarm services.

```ts
interface TaskContext<S> {
  // State
  recall(): Effect<S | null, TaskError>
  save(state: S): Effect<void, TaskError>
  update(fn: (s: S) => S): Effect<void, TaskError>

  // Scheduling
  scheduleIn(delay: Duration.Input): Effect<void, TaskError>
  scheduleAt(time: Date | number): Effect<void, TaskError>
  cancelSchedule(): Effect<void, TaskError>
  nextAlarm(): Effect<number | null, TaskError>

  // Lifecycle
  purge(): Effect<never, PurgeSignal>

  // Identity
  readonly id: string
  readonly name: string
}
```

`TaskContext` is generic over `S` because it encodes/decodes state using the task's schema. The TaskRunner creates it per-execution by closing over Storage + Alarm + the state schema. It's a typed view on top of raw services.

### TaskDefinition

What `Task.define()` returns. A pure value. Carries the schemas, handlers, and any accumulated service layers.

```ts
interface TaskDefinition<S, E, Err, R> {
  readonly _tag: "TaskDefinition"
  readonly state: Schema<S>
  readonly event: Schema<E>
  readonly onEvent: (ctx: TaskContext<S>, event: E) => Effect<void, Err, R>
  readonly onAlarm: (ctx: TaskContext<S>) => Effect<void, Err, R>
  readonly onError?: (ctx: TaskContext<S>, error: unknown) => Effect<void, Err, R>

  // Accumulate service layers (narrows R)
  provide<ROut>(layer: Layer<ROut>): TaskDefinition<S, E, Err, Exclude<R, ROut>>
}
```

### Tasks with services

When a handler needs external services, the `R` type parameter captures them. The `.provide()` method accumulates layers that the TaskRunner will apply at execution time.

```ts
class EmailService extends ServiceMap.Service<EmailService, {
  send(to: string, body: string): Effect<void, EmailError>
}>()("app/EmailService") {}

const notificationTask = Task.define({
  state: NotificationState,
  event: NotificationEvent,

  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      const email = yield* EmailService
      yield* email.send(event.to, event.body)
      yield* ctx.save({ sentAt: Date.now(), to: event.to })
      yield* ctx.scheduleIn("1 hour")
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const email = yield* EmailService
      const state = yield* ctx.recall()
      if (state) {
        yield* email.send(state.to, "Follow-up")
      }
      yield* ctx.purge()
    }),
})
// Type: TaskDefinition<NotificationState, NotificationEvent, EmailError, EmailService>

// Provide the service layer - narrows R to never
const notificationProvided = notificationTask.provide(EmailService.layer)
// Type: TaskDefinition<NotificationState, NotificationEvent, EmailError, never>
```

---

## Assembly

This is where it all comes together. Standard Effect layer composition. No custom wiring, no factory functions, no magic.

### Building the Layer Stack

```ts
// 1. Define tasks
const orderTask = Task.define({ ... })
const notificationTask = Task.define({ ... }).provide(EmailService.layer)

// 2. Build the registry layer
const RegistryLive = TaskRegistry.from({
  order: orderTask,
  notification: notificationTask,
})

// 3. Build the full runner layer
const RunnerLive = TaskRunner.layer.pipe(
  Layer.provide(RegistryLive),
  // Storage and Alarm still required - provided by the platform
)
```

### Cloudflare DO Integration

The DO shell is as thin as it gets. It provides the platform services and wires the runner.

```ts
export class TaskEngine extends DurableObject {
  private program: Effect<TaskRunner>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    // Platform services from CF DO
    const PlatformLive = Layer.mergeAll(
      CloudflareStorage.layer(ctx),
      CloudflareAlarm.layer(ctx),
    )

    // Full layer: Runner + Registry + Platform
    const FullLive = RunnerLive.pipe(
      Layer.provide(PlatformLive),
    )

    this.program = // ... resolve TaskRunner from FullLive
  }

  async call(request: TaskRequest): Promise<TaskResponse> {
    const runner = yield* this.program
    return Effect.runPromise(
      runner.handleEvent(request.task, request.id, request.event)
    )
  }

  async alarm(): Promise<void> {
    const runner = yield* this.program
    return Effect.runPromise(
      runner.handleAlarm(request.task, request.id)
    )
  }
}
```

### Testing

Same services, different layers.

```ts
// In-memory platform services for testing
const TestPlatformLive = Layer.mergeAll(
  InMemoryStorage.layer(),
  InMemoryAlarm.layer(),
)

const TestRunnerLive = TaskRunner.layer.pipe(
  Layer.provide(TaskRegistry.from({ order: orderTask })),
  Layer.provide(TestPlatformLive),
)

// Use it in a test
const runner = yield* TestRunnerLive
yield* runner.handleEvent("order", "123", { _tag: "place", orderId: "123" })
```

No test harness needed. No special testing utilities. Just swap the platform layer.

---

## Error Model

One unified error per service. Simple tagged hierarchy.

```ts
// Platform errors
class StorageError extends Schema.TaggedErrorClass<StorageError>()(
  "StorageError", { cause: Schema.Defect }
) {}

class AlarmError extends Schema.TaggedErrorClass<AlarmError>()(
  "AlarmError", { cause: Schema.Defect }
) {}

// Framework errors (what TaskRunner surfaces)
class TaskRunnerError extends Schema.TaggedErrorClass<TaskRunnerError>()(
  "TaskRunnerError", {
    reason: Schema.Union(
      Schema.Struct({ _tag: Schema.Literal("NotFound"), name: Schema.String }),
      Schema.Struct({ _tag: Schema.Literal("Validation"), message: Schema.String }),
      Schema.Struct({ _tag: Schema.Literal("Execution"), cause: Schema.Defect }),
    ),
  }
) {}

// Internal signal (not a real error)
class PurgeSignal extends Data.TaggedError("PurgeSignal")<{}> {}

// User-facing error (what TaskContext methods surface)
class TaskError extends Schema.TaggedErrorClass<TaskError>()(
  "TaskError", { message: Schema.String, cause: Schema.optional(Schema.Defect) }
) {}
```

TaskRunner catches `StorageError` and `AlarmError` internally and wraps them into `TaskRunnerError` with `reason._tag: "Execution"`. The user's handler code sees `TaskError` from ctx methods. Clean separation.

---

## What We're NOT Designing Here

- **Client/transport.** How a worker sends events to the DO. That's a separate concern - a thin RPC layer on top of TaskRunner.
- **Live implementations.** CloudflareStorage, CloudflareAlarm, InMemoryStorage, InMemoryAlarm. Those come when we build.
- **The DO request/response protocol.** TaskRequest, TaskResponse types. Simple serialization concern.
- **Storage key namespacing.** Implementation detail of how TaskRunner uses Storage keys internally.

---

## File Structure

```
packages/task/
  src/
    index.ts                  # Public exports

    # Service interfaces (the design)
    services/
      Storage.ts              # Storage service interface + StorageError
      Alarm.ts                # Alarm service interface + AlarmError
      TaskRunner.ts           # TaskRunner service interface + TaskRunnerError
      TaskRegistry.ts         # TaskRegistry service interface

    # User-facing API
    Task.ts                   # Task.define() + TaskDefinition type
    TaskContext.ts             # TaskContext<S> interface + TaskError
    PurgeSignal.ts            # PurgeSignal error class

    # Live implementations (built later, one file per implementation)
    live/
      CloudflareStorage.ts    # Storage backed by CF DO storage
      CloudflareAlarm.ts      # Alarm backed by CF DO alarm
      InMemoryStorage.ts      # Storage backed by a Map (testing)
      InMemoryAlarm.ts        # Alarm backed by a variable (testing)
      TaskRunnerLive.ts       # The real TaskRunner implementation
      TaskRegistryLive.ts     # TaskRegistry.from() implementation
```

---

## Summary

| Concern | Service | Depends On |
|---|---|---|
| Persistence | `Storage` | nothing (platform) |
| Scheduling | `Alarm` | nothing (platform) |
| Definitions | `TaskRegistry` | nothing (built from config) |
| Orchestration | `TaskRunner` | `Storage`, `Alarm`, `TaskRegistry` |

Four services. Two from the platform. Two from the framework. Layer composition wires them. No custom factories, no "adapter layer," no "compute layer." Just services.

The user defines tasks with `Task.define()`. The framework provides `TaskRunner`. The platform provides `Storage` and `Alarm`. Effect's layer system handles the rest.
