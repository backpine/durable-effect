import { describe, it, expect } from "vitest"
import { Data, Effect, Schema } from "effect"
import {
  Task,
  TaskRegistry,
  TaskExecutionError,
  makeInMemoryRuntime,
} from "../src/index.js"

// ============================================================================
// Errors
// ============================================================================

class HandlerBoom extends Data.TaggedError("HandlerBoom")<{
  readonly detail: string
}> {}

class ErrorHandlerBoom extends Data.TaggedError("ErrorHandlerBoom")<{
  readonly inner: string
}> {}

// ============================================================================
// Tasks
// ============================================================================

const TestState = Schema.Struct({ value: Schema.String })
const TestEvent = Schema.Struct({
  _tag: Schema.Literal("Do"),
  shouldFail: Schema.optionalKey(Schema.Boolean),
  shouldFailAlarm: Schema.optionalKey(Schema.Boolean),
  shouldPurgeInError: Schema.optionalKey(Schema.Boolean),
  shouldFailInError: Schema.optionalKey(Schema.Boolean),
})
const Test = Task.make("test", { state: TestState, event: TestEvent })

const registry = TaskRegistry.make(Test)

// ============================================================================
// Tests
// ============================================================================

describe("Error propagation", () => {
  it("handler error without error handler becomes TaskExecutionError", async () => {
    const handler = registry.handler("test", {
      onEvent: (ctx, event) =>
        Effect.gen(function* () {
          if (event.shouldFail) return yield* new HandlerBoom({ detail: "kaboom" })
          yield* ctx.save({ value: "ok" })
        }),
      onAlarm: (ctx) => Effect.void,
    })
    const runtime = makeInMemoryRuntime(registry.build({ test: handler }))

    const exit = await Effect.runPromiseExit(
      runtime.sendEvent("test", "t1", { _tag: "Do", shouldFail: true }),
    )

    expect(exit._tag).toBe("Failure")
  })

  it("successful handler does not trigger error handler", async () => {
    let errorHandlerCalled = false
    const handler = registry.handler("test", {
      onEvent: {
        handler: (ctx, event) => ctx.save({ value: "fine" }),
        onError: (ctx, _error) =>
          Effect.sync(() => { errorHandlerCalled = true }),
      },
      onAlarm: (ctx) => Effect.void,
    })
    const runtime = makeInMemoryRuntime(registry.build({ test: handler }))

    await Effect.runPromise(runtime.sendEvent("test", "t1", { _tag: "Do" }))

    expect(errorHandlerCalled).toBe(false)
    expect(await Effect.runPromise(runtime.getState("test", "t1"))).toEqual({ value: "fine" })
  })

  it("error handler can purge to clean up after failure", async () => {
    const handler = registry.handler("test", {
      onEvent: {
        handler: (ctx, event) =>
          Effect.gen(function* () {
            yield* ctx.save({ value: "before-error" })
            if (event.shouldPurgeInError) return yield* new HandlerBoom({ detail: "will purge" })
          }),
        onError: (ctx, error) =>
          Effect.gen(function* () {
            if (error._tag === "HandlerBoom") {
              yield* ctx.purge()
            }
          }),
      },
      onAlarm: (ctx) => Effect.void,
    })
    const runtime = makeInMemoryRuntime(registry.build({ test: handler }))

    await Effect.runPromise(
      runtime.sendEvent("test", "t1", { _tag: "Do", shouldPurgeInError: true }),
    )

    // Purge in error handler should have cleared state
    expect(await Effect.runPromise(runtime.getState("test", "t1"))).toBeNull()
  })

  it("error handler that throws wraps in TaskExecutionError", async () => {
    const handler = registry.handler("test", {
      onEvent: {
        handler: (ctx, event) =>
          Effect.gen(function* () {
            return yield* new HandlerBoom({ detail: "first" })
          }),
        onError: (_ctx, _error) =>
          Effect.gen(function* () {
            // Error handler itself fails
            return yield* new ErrorHandlerBoom({ inner: "double fault" })
          }),
      },
      onAlarm: (ctx) => Effect.void,
    })
    const runtime = makeInMemoryRuntime(registry.build({ test: handler }))

    const exit = await Effect.runPromiseExit(
      runtime.sendEvent("test", "t1", { _tag: "Do" }),
    )

    expect(exit._tag).toBe("Failure")
  })

  it("alarm error without error handler becomes TaskExecutionError", async () => {
    const handler = registry.handler("test", {
      onEvent: (ctx, event) => ctx.save({ value: "setup" }),
      onAlarm: (ctx) =>
        Effect.gen(function* () {
          return yield* new HandlerBoom({ detail: "alarm boom" })
        }),
    })
    const runtime = makeInMemoryRuntime(registry.build({ test: handler }))

    await Effect.runPromise(runtime.sendEvent("test", "t1", { _tag: "Do" }))
    const exit = await Effect.runPromiseExit(runtime.fireAlarm("test", "t1"))

    expect(exit._tag).toBe("Failure")
    // State should still exist (no purge happened)
    expect(await Effect.runPromise(runtime.getState("test", "t1"))).toEqual({ value: "setup" })
  })

  it("alarm error handler catches and recovers", async () => {
    const handler = registry.handler("test", {
      onEvent: (ctx, event) => ctx.save({ value: "setup" }),
      onAlarm: {
        handler: (ctx) =>
          Effect.gen(function* () {
            return yield* new HandlerBoom({ detail: "alarm fail" })
          }),
        onError: (ctx, error) =>
          Effect.gen(function* () {
            if (error._tag === "HandlerBoom") {
              yield* ctx.save({ value: `recovered: ${error.detail}` })
            }
          }),
      },
    })
    const runtime = makeInMemoryRuntime(registry.build({ test: handler }))

    await Effect.runPromise(runtime.sendEvent("test", "t1", { _tag: "Do" }))
    await Effect.runPromise(runtime.fireAlarm("test", "t1"))

    expect(await Effect.runPromise(runtime.getState("test", "t1"))).toEqual({
      value: "recovered: alarm fail",
    })
  })
})
