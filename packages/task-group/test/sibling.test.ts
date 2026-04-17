import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { Task, TaskRegistry, makeInMemoryRuntime } from "../src/index.js"

// ============================================================================
// Tasks for sibling tests
// ============================================================================

const TaskA = Task.make("taskA", {
  state: Schema.Struct({ value: Schema.String, siblingState: Schema.optionalKey(Schema.Unknown) }),
  event: Schema.Struct({ _tag: Schema.Literal("Go"), data: Schema.String }),
})

const TaskB = Task.make("taskB", {
  state: Schema.Struct({ received: Schema.String, forwarded: Schema.Boolean }),
  event: Schema.Struct({ _tag: Schema.Literal("Receive"), from: Schema.String }),
})

const TaskC = Task.make("taskC", {
  state: Schema.Struct({ chain: Schema.Array(Schema.String) }),
  event: Schema.Struct({ _tag: Schema.Literal("Append"), value: Schema.String }),
})

const registry = TaskRegistry.make(TaskA, TaskB, TaskC)

const taskAHandler = registry.handler("taskA", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      yield* ctx.save({ value: event.data })

      // Dispatch to taskB
      yield* ctx.task("taskB").send(ctx.id, { _tag: "Receive", from: event.data })

      // Read taskB's state after dispatch
      const bState = yield* ctx.task("taskB").getState(ctx.id)
      yield* ctx.save({ value: event.data, siblingState: bState })
    }),
  onAlarm: (ctx) => Effect.void,
})

const taskBHandler = registry.handler("taskB", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      yield* ctx.save({ received: event.from, forwarded: false })

      // Chained dispatch: B → C
      yield* ctx.task("taskC").send(ctx.id, { _tag: "Append", value: `via-b:${event.from}` })
      yield* ctx.save({ received: event.from, forwarded: true })
    }),
  onAlarm: (ctx) => Effect.void,
})

const taskCHandler = registry.handler("taskC", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      const chain = state?.chain ?? []
      yield* ctx.save({ chain: [...chain, event.value] })
    }),
  onAlarm: (ctx) => Effect.void,
})

const config = registry.build({
  taskA: taskAHandler,
  taskB: taskBHandler,
  taskC: taskCHandler,
})

// ============================================================================
// Tests
// ============================================================================

describe("Sibling dispatch", () => {
  it("reads sibling state via ctx.task().getState() from within a handler", async () => {
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.task("taskA").send("x", { _tag: "Go", data: "hello" }))

    const aState = await Effect.runPromise(runtime.task("taskA").getState("x"))
    // taskA should have read taskB's state after dispatching to it
    expect(aState).toEqual({
      value: "hello",
      siblingState: { received: "hello", forwarded: true },
    })
  })

  it("chains dispatch A → B → C", async () => {
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.task("taskA").send("chain", { _tag: "Go", data: "start" }))

    // C should have received the forwarded event from B
    const cState = await Effect.runPromise(runtime.task("taskC").getState("chain"))
    expect(cState).toEqual({ chain: ["via-b:start"] })
  })

  it("tag-based sibling access works alongside string-based", async () => {
    // Define a handler that uses the tag object instead of string
    const tagBasedHandler = registry.handler("taskA", {
      onEvent: (ctx, event) =>
        Effect.gen(function* () {
          yield* ctx.save({ value: event.data })
          // Use tag object instead of string
          yield* ctx.task(TaskB).send(ctx.id, { _tag: "Receive", from: "tag-based" })
        }),
      onAlarm: (ctx) => Effect.void,
    })

    const tagConfig = registry.build({
      taskA: tagBasedHandler,
      taskB: taskBHandler,
      taskC: taskCHandler,
    })
    const runtime = makeInMemoryRuntime(tagConfig)

    await Effect.runPromise(runtime.task("taskA").send("t1", { _tag: "Go", data: "test" }))

    const bState = await Effect.runPromise(runtime.task("taskB").getState("t1"))
    expect(bState).toEqual({ received: "tag-based", forwarded: true })
  })

  it("self-dispatch to a different instance id", async () => {
    // taskC dispatching to itself with a different id
    const selfDispatchHandler = registry.handler("taskC", {
      onEvent: (ctx, event) =>
        Effect.gen(function* () {
          const state = yield* ctx.recall()
          const chain = state?.chain ?? []
          yield* ctx.save({ chain: [...chain, event.value] })

          // Dispatch to self with different id (only if this is the trigger)
          if (event.value === "origin") {
            yield* ctx.task("taskC").send("other-instance", { _tag: "Append", value: "from-origin" })
          }
        }),
      onAlarm: (ctx) => Effect.void,
    })

    const selfConfig = registry.build({
      taskA: taskAHandler,
      taskB: taskBHandler,
      taskC: selfDispatchHandler,
    })
    const runtime = makeInMemoryRuntime(selfConfig)

    await Effect.runPromise(runtime.task("taskC").send("main", { _tag: "Append", value: "origin" }))

    // Main instance has its own state
    expect(await Effect.runPromise(runtime.task("taskC").getState("main"))).toEqual({
      chain: ["origin"],
    })

    // Other instance got the dispatched event
    expect(await Effect.runPromise(runtime.task("taskC").getState("other-instance"))).toEqual({
      chain: ["from-origin"],
    })
  })

  it("getState on non-existent instance returns null", async () => {
    const runtime = makeInMemoryRuntime(config)

    const state = await Effect.runPromise(runtime.task("taskA").getState("does-not-exist"))
    expect(state).toBeNull()
  })
})
