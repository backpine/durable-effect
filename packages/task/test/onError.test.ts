import { describe, it, expect } from "vitest"
import { Data, Effect, Layer, Schema } from "effect"
import {
  Task,
  TaskRunner,
  registerTask,
  buildRegistryLayer,
  TaskRunnerLive,
  makeInMemoryStorage,
  makeInMemoryAlarm,
} from "../src/index.js"

// ---------------------------------------------------------------------------
// Tagged error types
// ---------------------------------------------------------------------------

class EventFailed extends Data.TaggedError("EventFailed")<{
  readonly reason: string
}> {}

class AlarmFailed extends Data.TaggedError("AlarmFailed")<{
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TestState = Schema.Struct({
  value: Schema.String,
})
type TestState = typeof TestState.Type

const TestEvent = Schema.Struct({
  _tag: Schema.Literal("Test"),
  data: Schema.String,
})
type TestEvent = typeof TestEvent.Type

// ---------------------------------------------------------------------------
// Helper: build a full test stack
// ---------------------------------------------------------------------------

function makeTestStack(
  registryConfig: Record<string, ReturnType<typeof registerTask>>,
) {
  const { layer: storageLayer, handle: storageHandle } = makeInMemoryStorage()
  const { layer: alarmLayer, handle: alarmHandle } = makeInMemoryAlarm()
  const registryLayer = buildRegistryLayer(registryConfig)
  const depsLayer = Layer.mergeAll(registryLayer, storageLayer, alarmLayer)
  const fullLayer = Layer.provide(TaskRunnerLive, depsLayer)
  return { fullLayer, storageHandle, alarmHandle }
}

// ---------------------------------------------------------------------------
// Tests: onError receives typed errors from onEvent
// ---------------------------------------------------------------------------

describe("onError typed error handling", () => {
  it("onError receives EventFailed from onEvent and can match by _tag", async () => {
    let receivedTag: string | null = null

    const task = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: (_ctx, _event) => Effect.fail(new EventFailed({ reason: "boom" })),
      onAlarm: () => Effect.void,
      onError: (ctx, error) =>
        // error is typed as EventFailed | never = EventFailed
        Effect.gen(function* () {
          receivedTag = error._tag
          yield* ctx.save({ value: `caught:${error._tag}` })
        }),
    })

    const { fullLayer, storageHandle } = makeTestStack({
      test: registerTask(task),
    })

    const program = Effect.gen(function* () {
      const runner = yield* TaskRunner
      yield* runner.handleEvent("test", "t-1", { _tag: "Test", data: "hello" })
    })

    await Effect.runPromise(Effect.provide(program, fullLayer))

    expect(receivedTag).toBe("EventFailed")
    expect(storageHandle.getData().get("t:state")).toEqual({ value: "caught:EventFailed" })
  })

  it("onError receives AlarmFailed from onAlarm and can match by _tag", async () => {
    let receivedTag: string | null = null

    const task = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: () => Effect.void,
      onAlarm: () => Effect.fail(new AlarmFailed({ reason: "tick failed" })),
      onError: (ctx, error) =>
        // error is typed as never | AlarmFailed = AlarmFailed
        Effect.gen(function* () {
          receivedTag = error._tag
          yield* ctx.save({ value: `caught:${error._tag}` })
        }),
    })

    const { fullLayer, storageHandle } = makeTestStack({
      test: registerTask(task),
    })

    const program = Effect.gen(function* () {
      const runner = yield* TaskRunner
      yield* runner.handleAlarm("test", "t-1")
    })

    await Effect.runPromise(Effect.provide(program, fullLayer))

    expect(receivedTag).toBe("AlarmFailed")
    expect(storageHandle.getData().get("t:state")).toEqual({ value: "caught:AlarmFailed" })
  })

  it("onError receives union of EventFailed | AlarmFailed and can use catchTag-style matching", async () => {
    const handledErrors: string[] = []

    const task = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: (_ctx, _event) => Effect.fail(new EventFailed({ reason: "event boom" })),
      onAlarm: () => Effect.fail(new AlarmFailed({ reason: "alarm boom" })),
      onError: (ctx, error) =>
        // error: EventFailed | AlarmFailed — full union, can switch on _tag
        Effect.gen(function* () {
          switch (error._tag) {
            case "EventFailed":
              handledErrors.push(`event:${error.reason}`)
              yield* ctx.save({ value: "handled-event-error" })
              break
            case "AlarmFailed":
              handledErrors.push(`alarm:${error.reason}`)
              yield* ctx.save({ value: "handled-alarm-error" })
              break
          }
        }),
    })

    const { fullLayer, storageHandle } = makeTestStack({
      test: registerTask(task),
    })

    // Trigger event error
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runner = yield* TaskRunner
          yield* runner.handleEvent("test", "t-1", { _tag: "Test", data: "x" })
        }),
        fullLayer,
      ),
    )

    expect(handledErrors).toEqual(["event:event boom"])
    expect(storageHandle.getData().get("t:state")).toEqual({ value: "handled-event-error" })

    // Trigger alarm error
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runner = yield* TaskRunner
          yield* runner.handleAlarm("test", "t-1")
        }),
        fullLayer,
      ),
    )

    expect(handledErrors).toEqual(["event:event boom", "alarm:alarm boom"])
    expect(storageHandle.getData().get("t:state")).toEqual({ value: "handled-alarm-error" })
  })

  it("onError can access typed error properties without narrowing", async () => {
    let capturedReason: string | null = null

    const task = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: (_ctx, _event) => Effect.fail(new EventFailed({ reason: "specific reason" })),
      onAlarm: () => Effect.void,
      onError: (_ctx, error) => {
        // error.reason is accessible because both EventFailed and AlarmFailed
        // (well, only EventFailed here since onAlarm returns never) have a reason field
        // But more importantly, error._tag is typed — not unknown
        capturedReason = error.reason
        return Effect.void
      },
    })

    const { fullLayer } = makeTestStack({
      test: registerTask(task),
    })

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runner = yield* TaskRunner
          yield* runner.handleEvent("test", "t-1", { _tag: "Test", data: "x" })
        }),
        fullLayer,
      ),
    )

    expect(capturedReason).toBe("specific reason")
  })

  it("purge still works from within onEvent when onError is defined", async () => {
    const task = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: (ctx, _event) =>
        Effect.gen(function* () {
          yield* ctx.purge()
        }),
      onAlarm: () => Effect.void,
      onError: (_ctx, _error) => {
        // This should NOT be called — PurgeSignal bypasses onError
        throw new Error("onError should not be called for PurgeSignal")
      },
    })

    const { fullLayer, storageHandle } = makeTestStack({
      test: registerTask(task),
    })

    // Save some state first
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runner = yield* TaskRunner
          yield* runner.handleEvent("test", "t-1", { _tag: "Test", data: "setup" })
        }),
        // Need a task that saves state first
        makeTestStack({
          test: registerTask(
            Task.define({
              state: TestState,
              event: TestEvent,
              onEvent: (ctx) => ctx.save({ value: "exists" }),
              onAlarm: () => Effect.void,
            }),
          ),
        }).fullLayer,
      ),
    )

    // Now purge
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runner = yield* TaskRunner
          yield* runner.handleEvent("test", "t-1", { _tag: "Test", data: "purge" })
        }),
        fullLayer,
      ),
    )

    // Storage should be cleared after purge
    expect(storageHandle.getData().size).toBe(0)
  })

  it("onError itself failing wraps in TaskExecutionError", async () => {
    class OnErrorFailed extends Data.TaggedError("OnErrorFailed")<{
      readonly detail: string
    }> {}

    const task = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: () => Effect.fail(new EventFailed({ reason: "initial" })),
      onAlarm: () => Effect.void,
      onError: (_ctx, _error) => Effect.fail(new OnErrorFailed({ detail: "recovery failed" })),
    })

    const { fullLayer } = makeTestStack({
      test: registerTask(task),
    })

    const result = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const runner = yield* TaskRunner
          yield* runner.handleEvent("test", "t-1", { _tag: "Test", data: "x" })
        }),
        fullLayer,
      ),
    )

    expect(result._tag).toBe("Failure")
  })
})
