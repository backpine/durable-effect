import { describe, it, expect } from "vitest"
import { Effect, Layer, Schema, Context } from "effect"
import {
  Task,
  TaskRegistry,
  makeInMemoryRuntime,
  withServices,
} from "../src/index.js"

// ============================================================================
// External service
// ============================================================================

class Notifier extends Context.Service<Notifier, {
  readonly notify: (message: string) => Effect.Effect<void>
}>()("@test/Notifier") {}

// ============================================================================
// Tasks
// ============================================================================

const OrderState = Schema.Struct({ total: Schema.Number, notified: Schema.Boolean })
const OrderEvent = Schema.Struct({ _tag: Schema.Literal("Place"), amount: Schema.Number })
const Order = Task.make("order", { state: OrderState, event: OrderEvent })

const Inbox = Task.make("inbox", {
  state: Schema.Struct({ messages: Schema.Array(Schema.String) }),
  event: Schema.Struct({ _tag: Schema.Literal("Receive"), text: Schema.String }),
})

const registry = TaskRegistry.make(Order, Inbox)

// ============================================================================
// Handlers
// ============================================================================

const notifierCalls: string[] = []

const NotifierLive = Layer.succeed(Notifier, {
  notify: (message) => Effect.sync(() => { notifierCalls.push(message) }),
})

const orderHandler = registry.handler("order",
  withServices({
    onEvent: (ctx, event) =>
      Effect.gen(function* () {
        const notifier = yield* Notifier
        yield* ctx.save({ total: event.amount, notified: false })
        yield* notifier.notify(`Order placed: $${event.amount}`)
        yield* ctx.update((s) => ({ ...s, notified: true }))
      }),
    onAlarm: (ctx) => Effect.void,
  }, NotifierLive),
)

const inboxHandler = registry.handler("inbox", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      const messages = state?.messages ?? []
      yield* ctx.save({ messages: [...messages, event.text] })
    }),
  onAlarm: (ctx) => Effect.void,
})

const config = registry.build({ order: orderHandler, inbox: inboxHandler })

// ============================================================================
// Tests
// ============================================================================

describe("Services", () => {
  it("handler can use external services via withServices", async () => {
    notifierCalls.length = 0
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.task("order").send("o1", { _tag: "Place", amount: 99 }))
    const state = await Effect.runPromise(runtime.task("order").getState("o1"))

    expect(state).toEqual({ total: 99, notified: true })
    expect(notifierCalls).toEqual(["Order placed: $99"])
  })

  it("handlers with and without services coexist", async () => {
    notifierCalls.length = 0
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.task("order").send("o1", { _tag: "Place", amount: 50 }))
    await Effect.runPromise(runtime.task("inbox").send("i1", { _tag: "Receive", text: "hello" }))

    expect(await Effect.runPromise(runtime.task("order").getState("o1"))).toEqual({ total: 50, notified: true })
    expect(await Effect.runPromise(runtime.task("inbox").getState("i1"))).toEqual({ messages: ["hello"] })
    expect(notifierCalls).toEqual(["Order placed: $50"])
  })
})
