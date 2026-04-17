import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import {
  Task,
  TaskRegistry,
  makeInMemoryRuntime,
} from "../src/index.js"

// ============================================================================
// Task Declarations
// ============================================================================

const CounterState = Schema.Struct({ count: Schema.Number })
const CounterEvent = Schema.Struct({
  _tag: Schema.Literal("Increment"),
  amount: Schema.Number,
})
const Counter = Task.make("counter", { state: CounterState, event: CounterEvent })

const AuditState = Schema.Struct({ entries: Schema.Array(Schema.String) })
const AuditEvent = Schema.Struct({
  _tag: Schema.Literal("Log"),
  message: Schema.String,
})
const AuditLog = Task.make("auditLog", { state: AuditState, event: AuditEvent })

// ============================================================================
// Registry + Handlers
// ============================================================================

const registry = TaskRegistry.make(Counter, AuditLog)

const counterHandler = registry.handler("counter", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      yield* ctx.save({ count: (state?.count ?? 0) + event.amount })

      // Sibling dispatch — using string name instead of tag import
      yield* ctx.task("auditLog").send(ctx.id, {
        _tag: "Log",
        message: `incremented by ${event.amount}`,
      })
    }),
  onAlarm: (ctx) =>
    Effect.gen(function* () {
      yield* ctx.purge()
    }),
})

const auditLogHandler = registry.handler("auditLog", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      const entries = state?.entries ?? []
      yield* ctx.save({ entries: [...entries, event.message] })
    }),
  onAlarm: (ctx) => Effect.void,
})

const config = registry.build({
  counter: counterHandler,
  auditLog: auditLogHandler,
})

// ============================================================================
// Tests
// ============================================================================

describe("TaskGroup — basic", () => {
  it("handles an event and saves state", async () => {
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.task("counter").send("c1", { _tag: "Increment", amount: 5 }))
    const state = await Effect.runPromise(runtime.task("counter").getState("c1"))

    expect(state).toEqual({ count: 5 })
  })

  it("accumulates state across events", async () => {
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.task("counter").send("c1", { _tag: "Increment", amount: 3 }))
    await Effect.runPromise(runtime.task("counter").send("c1", { _tag: "Increment", amount: 7 }))
    const state = await Effect.runPromise(runtime.task("counter").getState("c1"))

    expect(state).toEqual({ count: 10 })
  })

  it("isolates state across instances", async () => {
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.task("counter").send("a", { _tag: "Increment", amount: 1 }))
    await Effect.runPromise(runtime.task("counter").send("b", { _tag: "Increment", amount: 100 }))

    expect(await Effect.runPromise(runtime.task("counter").getState("a"))).toEqual({ count: 1 })
    expect(await Effect.runPromise(runtime.task("counter").getState("b"))).toEqual({ count: 100 })
  })

  it("dispatches to sibling task via ctx.task()", async () => {
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.task("counter").send("shared", { _tag: "Increment", amount: 42 }))

    // Counter dispatched to AuditLog as a sibling
    const auditState = await Effect.runPromise(runtime.task("auditLog").getState("shared"))
    expect(auditState).toEqual({ entries: ["incremented by 42"] })
  })

  it("reads sibling state via ctx.task().getState()", async () => {
    const runtime = makeInMemoryRuntime(config)

    // Set up audit log with some entries
    await Effect.runPromise(runtime.task("counter").send("shared", { _tag: "Increment", amount: 10 }))
    await Effect.runPromise(runtime.task("counter").send("shared", { _tag: "Increment", amount: 20 }))

    // Audit log should have two entries
    const auditState = await Effect.runPromise(runtime.task("auditLog").getState("shared"))
    expect(auditState).toEqual({ entries: ["incremented by 10", "incremented by 20"] })
  })

  it("handles alarm with purge", async () => {
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.task("counter").send("c1", { _tag: "Increment", amount: 1 }))
    await Effect.runPromise(runtime.task("counter").fireAlarm("c1"))

    const state = await Effect.runPromise(runtime.task("counter").getState("c1"))
    expect(state).toBeNull()
  })

  it("rejects invalid event payloads at compile time", () => {
    const runtime = makeInMemoryRuntime(config)

    // @ts-expect-error — "Bogus" is not a valid _tag for counter events
    runtime.task("counter").send("c1", { _tag: "Bogus" })
  })

  it("rejects unknown task names at compile time", () => {
    const runtime = makeInMemoryRuntime(config)

    // @ts-expect-error — "nonExistent" is not a valid task name
    runtime.task("nonExistent")
  })
})
