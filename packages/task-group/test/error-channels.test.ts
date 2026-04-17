import { describe, it, expect } from "vitest"
import { Data, Effect, Schema } from "effect"
import {
  Task,
  TaskRegistry,
  makeInMemoryRuntime,
} from "../src/index.js"

// ============================================================================
// Custom typed errors
// ============================================================================

class EventFailed extends Data.TaggedError("EventFailed")<{
  readonly reason: string
}> {}

class AlarmFailed extends Data.TaggedError("AlarmFailed")<{
  readonly code: number
}> {}

// ============================================================================
// Tasks
// ============================================================================

const WorkerState = Schema.Struct({
  value: Schema.String,
  recovered: Schema.optionalKey(Schema.String),
})
const WorkerEvent = Schema.Struct({
  _tag: Schema.Literal("Do"),
  fail: Schema.optionalKey(Schema.Boolean),
  failAlarm: Schema.optionalKey(Schema.Boolean),
})
const Worker = Task.make("worker", { state: WorkerState, event: WorkerEvent })

const registry = TaskRegistry.make(Worker)

// ============================================================================
// Handler using nested { handler, onError } form
// ============================================================================

const workerHandler = registry.handler("worker", {
  onEvent: {
    handler: (ctx, event) =>
      Effect.gen(function* () {
        if (event.fail) {
          return yield* new EventFailed({ reason: "bad input" })
        }
        yield* ctx.save({ value: "ok", ...(event.failAlarm ? { value: "will-fail-alarm" } : {}) })
      }),
    onError: (ctx, error) =>
      // error is TaskError | EventFailed — narrow to handle each
      Effect.gen(function* () {
        if (error._tag === "EventFailed") {
          yield* ctx.save({ value: "error", recovered: `event: ${error.reason}` })
        }
        // TaskError from ctx ops would propagate as TaskExecutionError
      }),
  },

  onAlarm: {
    handler: (ctx) =>
      Effect.gen(function* () {
        const state = yield* ctx.recall()
        if (state?.value === "will-fail-alarm") {
          return yield* new AlarmFailed({ code: 503 })
        }
        if (state) yield* ctx.save({ ...state, value: "alarm-ok" })
      }),
    onError: (ctx, error) =>
      // error is TaskError | AlarmFailed — narrow to handle each
      Effect.gen(function* () {
        if (error._tag === "AlarmFailed") {
          const state = yield* ctx.recall()
          if (state) yield* ctx.save({ ...state, value: "alarm-error", recovered: `alarm: ${error.code}` })
        }
      }),
  },
})

const config = registry.build({ worker: workerHandler })

// ============================================================================
// Tests
// ============================================================================

describe("Error channels", () => {
  it("onEvent.onError catches event errors with correct type", async () => {
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.task("worker").send("w1", { _tag: "Do", fail: true }))
    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))

    expect(state).toEqual({ value: "error", recovered: "event: bad input" })
  })

  it("successful event skips error handler", async () => {
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.task("worker").send("w1", { _tag: "Do" }))
    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))

    expect(state).toEqual({ value: "ok" })
  })

  it("onAlarm.onError catches alarm errors with correct type", async () => {
    const runtime = makeInMemoryRuntime(config)

    // Set up state that will trigger alarm failure
    await Effect.runPromise(runtime.task("worker").send("w1", { _tag: "Do", failAlarm: true }))
    // Fire alarm — handler sees value "will-fail-alarm" and throws AlarmFailed
    await Effect.runPromise(runtime.task("worker").fireAlarm("w1"))
    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))

    expect(state).toEqual({ value: "alarm-error", recovered: "alarm: 503" })
  })

  it("plain function form still works (no error handler)", async () => {
    const simpleHandler = registry.handler("worker", {
      onEvent: (ctx, event) => ctx.save({ value: "simple" }),
      onAlarm: (ctx) => Effect.void,
    })

    const simpleConfig = registry.build({ worker: simpleHandler })
    const runtime = makeInMemoryRuntime(simpleConfig)

    await Effect.runPromise(runtime.task("worker").send("w1", { _tag: "Do" }))
    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))

    expect(state).toEqual({ value: "simple" })
  })

  it("can mix function and object forms", async () => {
    const mixedHandler = registry.handler("worker", {
      onEvent: {
        handler: (ctx, event) =>
          Effect.gen(function* () {
            if (event.fail) return yield* new EventFailed({ reason: "nope" })
            yield* ctx.save({ value: "mixed" })
          }),
        onError: (ctx, error) =>
          Effect.gen(function* () {
            if (error._tag === "EventFailed") {
              yield* ctx.save({ value: "caught", recovered: error.reason })
            }
          }),
      },
      // Plain function form — no error handler for alarm
      onAlarm: (ctx) => Effect.void,
    })

    const mixedConfig = registry.build({ worker: mixedHandler })
    const runtime = makeInMemoryRuntime(mixedConfig)

    await Effect.runPromise(runtime.task("worker").send("w1", { _tag: "Do", fail: true }))
    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))

    expect(state).toEqual({ value: "caught", recovered: "nope" })
  })
})
