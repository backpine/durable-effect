# @durable-effect/task

Type-safe durable tasks with sibling awareness, built on [Effect](https://effect.website).

Define tasks as schemas. Group them in a registry. Each task can invoke any sibling by name with full type safety. Run locally with the in-memory runtime for development and testing, then swap one line for Cloudflare Durable Objects in production.

## Install

```bash
pnpm add @durable-effect/task effect
```

## Quick Start

### 1. Declare Tasks

A task is a name + a state schema + an event schema. No handler code — just the contract.

```typescript
// tasks/registry.ts
import { Schema } from "effect"
import { Task, TaskRegistry } from "@durable-effect/task"

export const Order = Task.make("order", {
  state: Schema.Struct({
    userId: Schema.String,
    total: Schema.Number,
    status: Schema.String,
  }),
  event: Schema.Struct({
    _tag: Schema.Literal("Place"),
    userId: Schema.String,
    total: Schema.Number,
  }),
})

export const Notification = Task.make("notification", {
  state: Schema.Struct({
    to: Schema.String,
    message: Schema.String,
    sentAt: Schema.Number,
  }),
  event: Schema.Struct({
    _tag: Schema.Literal("Send"),
    to: Schema.String,
    message: Schema.String,
  }),
})

export const registry = TaskRegistry.make(Order, Notification)
```

### 2. Implement Handlers

Each handler lives in its own file. Import the registry to get typed `ctx` and `event`.

```typescript
// tasks/handlers/order.ts
import { Effect } from "effect"
import { registry } from "../registry"

const o = registry.for("order")

const onEvent = o.onEvent((ctx, event) =>
  Effect.gen(function* () {
    yield* ctx.save({
      userId: event.userId,
      total: event.total,
      status: "placed",
    })

    // Dispatch to sibling — fully typed by name
    yield* ctx.task("notification").send(ctx.id, {
      _tag: "Send",
      to: event.userId,
      message: `Order confirmed: $${event.total}`,
    })

    // Schedule a follow-up
    yield* ctx.scheduleIn("30 seconds")
  }),
)

const onAlarm = o.onAlarm((ctx) =>
  Effect.gen(function* () {
    yield* ctx.update((s) => ({ ...s, status: "fulfilled" }))
  }),
)

export const orderHandler = registry.handler("order", {
  onEvent: onEvent,
  onAlarm: onAlarm,
})
```

```typescript
// tasks/handlers/notification.ts
import { Effect } from "effect"
import { registry } from "../registry"

const o = registry.for("notification")

export const notificationHandler = registry.handler("notification", {
  onEvent: o.onEvent((ctx, event) =>
    Effect.gen(function* () {
      yield* ctx.save({
        to: event.to,
        message: event.message,
        sentAt: Date.now(),
      })
    }),
  ),
  onAlarm: (ctx) => Effect.void,
})
```

### 3. Build and Use

```typescript
// tasks/index.ts
import { makeInMemoryRuntime } from "@durable-effect/task"
import { registry } from "./registry"
import { orderHandler } from "./handlers/order"
import { notificationHandler } from "./handlers/notification"

const config = registry.build({
  order: orderHandler,
  notification: notificationHandler,
})

export const tasks = makeInMemoryRuntime(config)
```

```typescript
// In your route handler
import { tasks } from "./tasks"

yield* tasks.sendEvent("order", "order-123", {
  _tag: "Place",
  userId: "user-42",
  total: 99.99,
})

const state = yield* tasks.getState("order", "order-123")
```

---

## Sibling Access

Any task can send events to or read state from any other task in the same registry.

```typescript
// By name (string) — no imports needed
yield* ctx.task("notification").send(id, { _tag: "Send", ... })
yield* ctx.task("notification").getState(id)

// By tag (import) — also works
import { Notification } from "../registry"
yield* ctx.task(Notification).send(id, { _tag: "Send", ... })
```

Both forms are fully typed. The string form autocompletes from the registry.

---

## Error Handling

Handlers can fail with typed errors. Attach an error handler using the object form:

```typescript
import { Data, Effect } from "effect"

class PaymentFailed extends Data.TaggedError("PaymentFailed")<{
  readonly reason: string
}> {}

registry.handler("order", {
  onEvent: {
    handler: (ctx, event) =>
      Effect.gen(function* () {
        const ok = yield* processPayment(event)
        if (!ok) return yield* new PaymentFailed({ reason: "declined" })
        yield* ctx.save({ ... })
      }),
    onError: (ctx, error) =>
      // error is PaymentFailed | TaskError — narrow with _tag
      Effect.gen(function* () {
        if (error._tag === "PaymentFailed") {
          yield* ctx.save({ ...state, status: "payment_failed" })
        }
      }),
  },
  onAlarm: (ctx) => ...,
})
```

For the simple case (no error handler), use a plain function:

```typescript
registry.handler("order", {
  onEvent: (ctx, event) => ...,
  onAlarm: (ctx) => ...,
})
```

---

## External Services

If a handler needs external services (database, API client, etc.), use `withServices`:

```typescript
import { Effect, Layer, ServiceMap } from "effect"
import { withServices } from "@durable-effect/task"

class PaymentService extends ServiceMap.Service<PaymentService, {
  readonly charge: (userId: string, amount: number) => Effect.Effect<void>
}>()("PaymentService") {}

const PaymentServiceLive = Layer.succeed(PaymentService, {
  charge: (userId, amount) => Effect.log(`Charged ${userId} $${amount}`),
})

const orderHandler = registry.handler("order",
  withServices({
    onEvent: (ctx, event) =>
      Effect.gen(function* () {
        const payment = yield* PaymentService
        yield* payment.charge(event.userId, event.total)
        yield* ctx.save({ ... })
      }),
    onAlarm: (ctx) => ...,
  }, PaymentServiceLive),
)
```

If you forget to provide the layer, TypeScript errors at compile time.

---

## Cloudflare Durable Objects

Swap the in-memory runtime for Cloudflare DOs — handler code doesn't change.

### Setup

```typescript
// tasks/index.ts
import { makeTaskGroupDO } from "@durable-effect/task/cloudflare"
import { registry } from "./registry"
import { orderHandler } from "./handlers/order"
import { notificationHandler } from "./handlers/notification"
import { env } from "cloudflare:workers"

const config = registry.build({
  order: orderHandler,
  notification: notificationHandler,
})

const taskGroup = makeTaskGroupDO(config)

// 1. Export the DO class for wrangler
export const OrdersDO = taskGroup.DO

// 2. Create the client — pass the namespace binding
export const tasks = taskGroup.client(env.ORDERS_DO)
```

### Wire into wrangler

Export the DO class from your worker's entry point:

```typescript
// src/index.ts
export { OrdersDO } from "./tasks"
```

Add the binding to `wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "ORDERS_DO", "class_name": "OrdersDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_classes": ["OrdersDO"] }
  ]
}
```

### Use in route handlers

Identical to the in-memory version:

```typescript
import { tasks } from "./tasks"

yield* tasks.sendEvent("order", "order-123", {
  _tag: "Place",
  userId: "user-42",
  total: 99.99,
})
```

Each `name:id` pair maps to an isolated DO instance with its own persistent storage and alarm. Sibling dispatch goes through DO RPC — no HTTP, no JSON serialization.

### Multiple Task Groups

Each group gets its own DO class and namespace:

```typescript
const orderGroup = makeTaskGroupDO(orderConfig)
export const OrdersDO = orderGroup.DO
export const orders = orderGroup.client(env.ORDERS_DO)

const analyticsGroup = makeTaskGroupDO(analyticsConfig)
export const AnalyticsDO = analyticsGroup.DO
export const analytics = analyticsGroup.client(env.ANALYTICS_DO)
```

### System Failure Recovery

When a Durable Object crashes and restarts, handlers can detect it via `ctx.systemFailure`:

```typescript
onAlarm: (ctx) =>
  Effect.gen(function* () {
    if (ctx.systemFailure) {
      yield* Effect.log(`Recovering from: ${ctx.systemFailure.message}`)
      // Compensate, retry, or alert
    }
    // Normal alarm logic
  }),
```

The in-memory runtime supports failure injection for testing:

```typescript
import { SystemFailure, makeInMemoryRuntime } from "@durable-effect/task"

const runtime = makeInMemoryRuntime(config)

runtime.injectSystemFailure("order", "order-123",
  new SystemFailure({ message: "DO crashed" }),
)

// Next handler invocation sees ctx.systemFailure
await Effect.runPromise(runtime.fireAlarm("order", "order-123"))
```

---

## Alarm Scheduling

Tasks can schedule alarms that fire the `onAlarm` handler:

```typescript
// Schedule relative
yield* ctx.scheduleIn("30 seconds")
yield* ctx.scheduleIn("5 minutes")

// Schedule absolute
yield* ctx.scheduleAt(Date.now() + 60_000)
yield* ctx.scheduleAt(new Date("2025-01-01"))

// Cancel
yield* ctx.cancelSchedule()

// Check
const next = yield* ctx.nextAlarm() // timestamp or null
```

In the in-memory runtime, alarms fire via `tick()`:

```typescript
const runtime = makeInMemoryRuntime(config)
await Effect.runPromise(runtime.sendEvent("order", "o1", { ... }))

// Advance time to fire alarms
await Effect.runPromise(runtime.tick(Date.now() + 60_000))
```

On Cloudflare, alarms fire automatically via the DO `alarm()` lifecycle.

---

## Context API

Every handler receives `ctx` with these methods:

| Method | Description |
|--------|-------------|
| `ctx.recall()` | Read current state (`S \| null`) |
| `ctx.save(state)` | Write state |
| `ctx.update(fn)` | Transform state (no-op if null) |
| `ctx.scheduleIn(delay)` | Schedule alarm relative to now |
| `ctx.scheduleAt(time)` | Schedule alarm at absolute time |
| `ctx.cancelSchedule()` | Cancel pending alarm |
| `ctx.nextAlarm()` | Get scheduled alarm timestamp |
| `ctx.purge()` | Delete all state and cancel alarm |
| `ctx.task(name)` | Get handle to sibling task |
| `ctx.task(tag)` | Get handle to sibling task (tag form) |
| `ctx.id` | Instance ID |
| `ctx.name` | Task name |
| `ctx.systemFailure` | Infrastructure failure info (or null) |

---

## File Structure

Recommended layout for a task group:

```
tasks/
  registry.ts                  <- schemas + registry
  handlers/
    order.ts                   <- one file per handler
    notification.ts
  index.ts                     <- build + export runtime
```

The registry file has no handler code. Handler files import from it. No circular dependencies.
