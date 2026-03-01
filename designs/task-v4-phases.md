# Task v4 - Implementation Phases

---

## Phase 1: Types, Errors, and Service Provision Patterns

### What We're Building

The foundational types and the `Task.define()` factory. But the real goal of this phase is to **nail the service provision pattern** before building any runtime machinery. We need to write real code that compiles, explore multiple approaches, and pick the one that gives the cleanest user experience.

Files:
- `src/types.ts` - `TaskContext<S>`, `TaskDefinition`, type helpers
- `src/errors.ts` - `StoreError`, `SchedulerError`, `ValidationError`, `PurgeSignal`
- `src/define.ts` - `Task.define()` factory function

But more importantly, a set of throwaway spike files that prototype service provision:

- Can the user define a task that requires `EmailService`, and does TypeScript correctly infer `R`?
- When they register it with a `Layer<EmailService>`, does the type checker confirm the layer satisfies the requirement?
- What happens with multiple services? With nested dependencies (service A depends on service B)?
- Does the pattern work cleanly when a task has zero service requirements?

### What We Have to Consider

**The core tension:** A task's `onEvent` and `onAlarm` handlers return `Effect<void, Err, Services>`. The framework needs to eliminate that `Services` requirement by providing a layer. But the framework doesn't know what services the user needs - it only knows at registration time. So we need a type-level contract that connects:

1. The task definition's `R` type parameter (what services the handlers need)
2. The layer provided at registration (what services are supplied)
3. The adapter's own services (Store, Scheduler, etc. - provided by the framework, invisible to the user)

Specific patterns to prototype:

**Pattern A - Layer at registration:**
```ts
const { Tasks } = createTasks({
  order: {
    task: orderTask,
    services: Layer.mergeAll(EmailServiceLive, LoggerServiceLive),
  },
})
```
Question: Can we type `services` so it must be `Layer<R>` where `R` matches what `orderTask` requires? What if `orderTask` needs no services - is `services` optional or `Layer<never>`?

**Pattern B - Layer baked into the definition:**
```ts
const orderTask = Task.define({
  state: OrderState,
  event: OrderEvent,
  services: Layer.mergeAll(EmailServiceLive, LoggerServiceLive),
  onEvent: (event, ctx) => ...,
  onAlarm: (ctx) => ...,
})
```
Question: This couples the definition to a specific implementation. Good for simple cases, bad for testing (can't swap the layer). Maybe this is a convenience shorthand?

**Pattern C - Service provision via a builder:**
```ts
const orderTask = Task.define({ ... })
  .provide(EmailServiceLive)
  .provide(LoggerServiceLive)
```
Question: Does this compose well? Can you partially provide? Does the type narrow correctly as you provide each service?

**Pattern D - Hybrid (define clean, provide at registration):**
```ts
// Definition is pure - just declares what it needs via R
const orderTask = Task.define({ ... })
// Type: TaskDefinition<OrderState, OrderEvent, OrderError, EmailService | Logger>

// Registration provides the layer
createTasks({
  order: orderTask.provide(EmailServiceLive, LoggerServiceLive),
  // or
  order: orderTask.withServices(fullLayer),
})
```

We also need to consider how the adapter's own services interact. The user's `onEvent` runs in a context where `Store`, `Scheduler`, etc. are available internally but should NOT appear in the user's `R` type. The user should never `yield* Store` - they use `ctx.save()`. So the adapter services and user services live in separate layers that get merged by the framework.

**Effect v4 specifics to validate:**
- `ServiceMap.Service` class syntax actually works for our service definitions
- `Layer.provide` correctly narrows the `R` type
- `Effect.provide` with an array of layers composes correctly
- Schema v4 API (`Schema.Struct`, `Schema.Union`) works as expected for our state/event schemas

### How We're Going to Test It

This phase is primarily about **type-level correctness**. The tests are compilation tests and lightweight runtime checks.

### Types of Tests

**Type-level tests (compile-time):**
- `Task.define()` correctly infers `S`, `E`, `Err`, and `R` from the config
- A task requiring `EmailService` produces `TaskDefinition<..., EmailService>`
- A task requiring no services produces `TaskDefinition<..., never>`
- Providing the wrong layer type is a compile error
- Providing a partial layer is a compile error (missing services)
- `TaskContext<S>` methods return the correct effect types
- The `onError` handler's error type matches the error type from `onEvent`/`onAlarm`

**Unit tests (runtime):**
- `Task.define()` returns a definition object with the correct `_tag`, schemas, handlers
- Error classes construct correctly with `_tag` discrimination
- `PurgeSignal` is catchable by tag
- Schema encode/decode roundtrips for sample state and event types

---

## Phase 2: Adapter Layer (Store, Scheduler, Executor)

### What We're Building

The core adapter services and the `TaskExecutor` that orchestrates the full lifecycle. This is where the framework's internal logic lives. By the end of this phase, we can run a task's full lifecycle against in-memory implementations.

Files:
- `src/adapter/store.ts` - `Store` service definition
- `src/adapter/scheduler.ts` - `Scheduler` service definition
- `src/adapter/instance.ts` - `Instance` service definition
- `src/adapter/keys.ts` - Storage key constants
- `src/adapter/context.ts` - `createTaskContext()` implementation
- `src/adapter/registry.ts` - `TaskRegistry` service (holds registered definitions)
- `src/adapter/executor.ts` - `TaskExecutor` orchestration
- `src/compute/testing/store.ts` - In-memory `Store` for tests
- `src/compute/testing/scheduler.ts` - In-memory `Scheduler` for tests

### What We Have to Consider

**State lifecycle:** When `onEvent` calls `ctx.save()`, the state needs to be persisted. When `onAlarm` calls `ctx.recall()`, it needs to come back. The Store service handles schema validation (encode on save, decode on recall). We need to decide: does the Store do the schema work, or does the context? The design doc puts schema work in the Store, but that means Store needs to be generic per-call. Alternative: Store is a raw key-value store and the context handles encode/decode. This is simpler for the Store interface and keeps schema concerns in the adapter.

**Scheduling semantics:** `scheduleIn("5 minutes")` needs to convert a duration to an absolute timestamp and persist it. The Scheduler service owns this. But we also need to track the scheduled time in storage (so we know on alarm what was scheduled). The current system uses a separate `SCHEDULED_AT` storage key for this. We should do the same - the Scheduler writes both the alarm and the tracking key.

**PurgeSignal flow:** When user code calls `ctx.purge()`, it fails the effect with `PurgeSignal`. The executor catches this and runs cleanup (delete all storage + cancel alarm). This is a control flow mechanism, not a real error. The executor must distinguish it from actual errors.

**Error routing:** If `onEvent` or `onAlarm` throws a real error (not PurgeSignal), and the task has an `onError` handler, the executor calls it. The `onError` handler gets the same `TaskContext` so it can save state, schedule retries, etc. If `onError` itself throws, that's a fatal error.

**Service provision wiring:** This is where the pattern chosen in Phase 1 gets implemented for real. The executor needs to:
1. Build a `TaskContext` backed by Store + Scheduler
2. Run the user's handler effect
3. Provide the user's services layer (from registration)
4. Provide any framework-level services the user shouldn't see

The layer composition order matters. User services should be provided first (outermost), then framework services.

**In-memory test implementations:** We need an in-memory Store and Scheduler that faithfully simulate persistence and alarm behavior. The in-memory Scheduler needs a way to "fire" alarms in tests (advance time, trigger the callback).

### How We're Going to Test It

This phase is about verifying the adapter logic works correctly against in-memory backends. Every test uses `TestStore` and `TestScheduler` - no Cloudflare types anywhere.

### Types of Tests

**Unit tests - Store service (in-memory):**
- `get` returns `null` for missing keys
- `set` then `get` roundtrips through schema encode/decode
- `set` overwrites previous value
- `delete` removes the key, subsequent `get` returns `null`
- `deleteAll` clears everything
- Schema validation errors surface as `StoreError`

**Unit tests - Scheduler service (in-memory):**
- `scheduleIn` converts duration and records the alarm
- `scheduleAt` with Date and number timestamp
- `cancel` clears the scheduled alarm
- `getNext` returns `null` when nothing scheduled
- Scheduling overwrites previous alarm (only one active at a time)

**Unit tests - TaskContext:**
- `save` + `recall` roundtrip
- `update` modifies existing state
- `update` is a no-op when state is null
- `scheduleIn` / `scheduleAt` / `cancelSchedule` / `nextAlarm` delegate correctly
- `purge` fails the effect with `PurgeSignal`

**Integration tests - TaskExecutor:**
- `handleEvent` validates the event against the schema, rejects invalid
- `handleEvent` calls `onEvent` with the validated event and a working context
- `handleEvent` persists state changes made via `ctx.save()`
- `handleAlarm` calls `onAlarm` with a working context
- `handleAlarm` reads state saved by a previous `handleEvent`
- PurgeSignal in `onEvent` cleans up all state and cancels alarm
- PurgeSignal in `onAlarm` cleans up all state and cancels alarm
- Error in `onEvent` routes to `onError` when defined
- Error in `onEvent` propagates when `onError` is not defined
- `onError` can save state and schedule a retry
- Full lifecycle: event -> save state -> schedule alarm -> alarm fires -> recall state -> purge

**Integration tests - Service provision:**
- Task with zero service requirements runs without a services layer
- Task requiring `EmailService` runs when `EmailServiceLive` is provided
- Task requiring multiple services runs when all are provided
- User service is accessible via `yield*` inside handlers
- Framework services (Store, Scheduler) don't leak into user's `R` type

---

## Phase 3: Compute Layer (Cloudflare DO + Test Harness)

### What We're Building

The Cloudflare Durable Object implementation of Store and Scheduler, the thin DO engine shell, and a proper test harness that lets users write integration tests for their tasks without deploying.

Files:
- `src/compute/cloudflare/store.ts` - DO-backed Store
- `src/compute/cloudflare/scheduler.ts` - DO-backed Scheduler
- `src/compute/cloudflare/engine.ts` - `TaskEngine` DO class
- `src/compute/testing/harness.ts` - `TaskTestHarness` for user-land testing

### What We Have to Consider

**Cloudflare DO storage semantics:** DO storage is a sorted key-value store. `storage.get()` returns `undefined` for missing keys. `storage.put()` accepts structured cloneable values. `storage.deleteAll()` deletes everything. `storage.setAlarm()` accepts a timestamp and only one alarm can be active. These map cleanly to our Store/Scheduler interfaces, but we need to handle the `Effect.tryPromise` wrapping and error mapping consistently.

**Engine lifecycle:** The DO constructor receives `DurableObjectState` and `env`. We need to inject the task registry into env (same pattern as the current `__JOB_REGISTRY__`). The engine builds its layer stack once in the constructor and reuses it across calls. The `call()` method handles event routing and the `alarm()` method handles alarm dispatch.

**Request/response protocol:** The engine receives a `TaskRequest` (which action, which task name, which instance, what event) and returns a `TaskResponse`. We need to define this protocol. It should be simple: the request type tells the engine what to do, and the response type tells the caller what happened.

**Test harness design:** Users need a way to test their tasks without Cloudflare. The harness should:
- Accept a task definition (and optional services layer)
- Provide in-memory Store + Scheduler
- Expose methods: `send(event)`, `fireAlarm()`, `getState()`, `getScheduledTime()`
- Let users assert on state, scheduling, and side effects
- Support time manipulation (advance clock, check what alarm is set)

**Layer composition in the engine:** The engine needs to compose:
1. Compute layer (DO Store + DO Scheduler + Instance)
2. Adapter layer (TaskExecutor + TaskRegistry)
3. Per-task user services layer

The tricky part: user services vary per task. So the executor needs to provide the right services layer based on which task is being executed. This means the services layer can't be baked into the engine's layer stack - it needs to be applied per-execution.

### How We're Going to Test It

The Cloudflare-specific code is tested via the test harness (which swaps in-memory backends) and via miniflare for the DO shell integration. The test harness itself is tested to make sure it faithfully simulates the real behavior.

### Types of Tests

**Unit tests - Cloudflare Store/Scheduler:**
- These are thin wrappers, so tests focus on error mapping
- `tryPromise` catches storage errors and wraps them as `StoreError`/`SchedulerError`
- Schema encode/decode happens correctly through the DO storage roundtrip

**Unit tests - Test harness:**
- `send(event)` triggers `onEvent` and persists state
- `fireAlarm()` triggers `onAlarm`
- `getState()` returns current state (schema-decoded)
- `getScheduledTime()` returns the pending alarm timestamp or null
- Time advancement works correctly (alarm becomes fireable after advancing past scheduled time)
- Harness correctly provides user services

**Integration tests - Engine (via miniflare or similar):**
- Engine constructs without error
- `call()` with a send request processes the event
- `alarm()` dispatches to the correct task's `onAlarm`
- Multiple task types registered on the same engine route correctly
- Unknown task name returns appropriate error
- State survives across separate `call()` invocations (durability)

**Integration tests - Full lifecycle via harness:**
- Multi-step scenario: send event -> state saved -> alarm scheduled -> fire alarm -> state updated -> purge
- Error scenario: handler throws -> onError called -> state updated with error info -> retry scheduled
- Purge scenario: handler calls purge -> all state deleted -> no alarm scheduled

---

## Phase 4: Registration Factory + Client

### What We're Building

The top-level `createTasks()` factory that wires everything together, and the typed client for sending events and querying tasks from worker code.

Files:
- `src/factory.ts` - `createTasks()` function
- `src/client/types.ts` - Request/response types, `TaskClient`, `TasksClient`
- `src/client/client.ts` - Client implementation
- `src/index.ts` - Public API exports

### What We Have to Consider

**Type-safe registry:** `createTasks()` takes an object where keys become task names. The return type must preserve these literal keys so the client can offer autocomplete. This is the same `const T extends Record<string, ...>` pattern from the current factory, but adapted for v4.

**Registration shape:** Each entry in the registry can be either:
- Just a task definition (no services needed): `{ order: orderTask }`
- A task definition + services layer: `{ order: { task: orderTask, services: EmailServiceLive } }`

We need to support both forms ergonomically. A union type or overloaded signatures might work. The type system needs to enforce that when a task requires services, the `services` field must be present and satisfy the requirement.

**Client transport:** The client talks to the DO via the Cloudflare binding (`env.TASKS`). It creates a DO instance ID from `taskName:instanceId`, gets a stub, and calls `stub.call(request)`. The response is typed based on the action. This is very similar to the current `JobsClient` pattern.

**Client ergonomics:** The client should feel natural:
```ts
const client = TasksClient.fromBinding(env.TASKS)
const result = yield* client.task("order").send({ id: "order-123", event: { ... } })
```

The `task("order")` call should be type-checked - `"order"` must be a registered task name, and the event type must match the task's event schema.

**Public API surface:** What do we export from `@backpine/task`?
- `Task.define()` - for defining tasks
- `createTasks()` - for registration
- `TaskContext` type - for typing handler parameters
- Error types - `StoreError`, `SchedulerError`, etc.
- Test harness - `TaskTestHarness` for user testing
- Potentially: `Store`, `Scheduler` service tags (for advanced users building custom compute layers)

### How We're Going to Test It

This phase ties everything together. Tests focus on the factory's type-level correctness and the client's request/response handling.

### Types of Tests

**Type-level tests - Factory:**
- `createTasks({ order: orderTask })` infers registry with key `"order"`
- Client's `task("order")` is valid, `task("nonexistent")` is a compile error
- `send()` event type matches the task's event schema
- `getState()` return type matches the task's state schema
- Task requiring services without providing them is a compile error
- Task with no service requirements doesn't require `services` field

**Unit tests - Client:**
- Client constructs from a DO binding
- `send()` builds the correct request shape
- `trigger()`, `terminate()`, `status()`, `getState()` build correct requests
- Response parsing handles each response type
- Client error wrapping for network/DO failures

**Unit tests - Factory:**
- `createTasks()` returns `Tasks` (DO class) and `TasksClient` (factory)
- Registry correctly maps task names to definitions
- Services layers are associated with the correct tasks

**End-to-end tests (via test harness):**
- Define a task with schemas, handlers, and services
- Register it via `createTasks()`
- Use the test harness to run the full lifecycle
- Verify state transitions, alarm scheduling, service calls, and purge behavior
- Test with multiple tasks registered, each with different service requirements
