import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import {
  Task,
  TaskRegistry,
  SystemFailure,
  makeInMemoryRuntime,
} from "../src/index.js"

// ============================================================================
// Tasks
// ============================================================================

const WorkerState = Schema.Struct({
  value: Schema.String,
  recoveredFrom: Schema.optionalKey(Schema.String),
})
const WorkerEvent = Schema.Struct({
  _tag: Schema.Literal("Process"),
  data: Schema.String,
})
const Worker = Task.make("worker", { state: WorkerState, event: WorkerEvent })

const registry = TaskRegistry.make(Worker)

const workerHandler = registry.handler("worker", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      // Check if we're recovering from a system failure
      if (ctx.systemFailure) {
        yield* ctx.save({
          value: event.data,
          recoveredFrom: ctx.systemFailure.message,
        })
      } else {
        yield* ctx.save({ value: event.data })
      }
      yield* ctx.scheduleIn("5 seconds")
    }),
  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) return

      // Alarm handler also sees system failure
      if (ctx.systemFailure) {
        yield* ctx.save({
          ...state,
          recoveredFrom: `alarm: ${ctx.systemFailure.message}`,
        })
      } else {
        yield* ctx.save({ ...state, value: `${state.value}-done` })
      }
    }),
})

const config = registry.build({ worker: workerHandler })

// ============================================================================
// Tests
// ============================================================================

describe("System Failure", () => {
  it("ctx.systemFailure is null under normal operation", async () => {
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.task("worker").send("w1", { _tag: "Process", data: "hello" }))
    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))

    expect(state).toEqual({ value: "hello" })
  })

  it("injected failure is visible in event handler", async () => {
    const runtime = makeInMemoryRuntime(config)

    runtime.injectSystemFailure("worker", "w1", new SystemFailure({ message: "DO crashed" }))

    await Effect.runPromise(runtime.task("worker").send("w1", { _tag: "Process", data: "retry" }))
    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))

    expect(state).toEqual({ value: "retry", recoveredFrom: "DO crashed" })
  })

  it("system failure is cleared after successful handling", async () => {
    const runtime = makeInMemoryRuntime(config)

    // Inject failure and handle it
    runtime.injectSystemFailure("worker", "w1", new SystemFailure({ message: "crash" }))
    await Effect.runPromise(runtime.task("worker").send("w1", { _tag: "Process", data: "first" }))

    // Second event should NOT see the failure
    await Effect.runPromise(runtime.task("worker").send("w1", { _tag: "Process", data: "second" }))
    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))

    expect(state).toEqual({ value: "second" })
  })

  it("injected failure is visible in alarm handler", async () => {
    const runtime = makeInMemoryRuntime(config)

    // Normal event to set up state
    await Effect.runPromise(runtime.task("worker").send("w1", { _tag: "Process", data: "setup" }))

    // Inject failure before alarm fires
    runtime.injectSystemFailure("worker", "w1", new SystemFailure({ message: "infra reboot" }))

    // Fire alarm — handler sees the system failure
    await Effect.runPromise(runtime.task("worker").fireAlarm("w1"))
    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))

    expect(state).toEqual({ value: "setup", recoveredFrom: "alarm: infra reboot" })
  })

  it("system failure persists until handled", async () => {
    const runtime = makeInMemoryRuntime(config)

    // Inject failure without handling
    runtime.injectSystemFailure("worker", "w1", new SystemFailure({ message: "persistent" }))

    // The failure stays until a handler runs
    expect(runtime.hasInstance("worker", "w1")).toBe(true)

    // Now handle it
    await Effect.runPromise(runtime.task("worker").send("w1", { _tag: "Process", data: "fix" }))

    // Failure should be cleared
    await Effect.runPromise(runtime.task("worker").send("w1", { _tag: "Process", data: "clean" }))
    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))

    expect(state).toEqual({ value: "clean" })
  })
})
