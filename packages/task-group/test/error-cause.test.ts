import { describe, it, expect } from "vitest"
import { Cause, Data, Effect, Exit, Schema } from "effect"
import { Task, TaskRegistry, makeInMemoryRuntime } from "../src/index.js"

// ============================================================================
// What a caller can latch onto when a hook fails: ONE TaskExecutionError whose
// `cause` is the failure itself, whichever way the hook got there.
// ============================================================================

class OutOfStock extends Data.TaggedError("OutOfStock")<{ readonly sku: string }> {}
class AuditDown extends Data.TaggedError("AuditDown")<{ readonly reason: string }> {}

const Order = Task.make("order", {
  state: Schema.Struct({ sku: Schema.String }),
  event: Schema.Struct({ _tag: Schema.Literal("Place"), sku: Schema.String }),
})
const registry = TaskRegistry.make(Order)

const failing = (sku: string) => Effect.fail(new OutOfStock({ sku }))

/** The failure a send or alarm ended with. */
const failureOf = async (effect: Effect.Effect<void, unknown>): Promise<unknown> => {
  const exit = await Effect.runPromiseExit(effect)
  return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
}

describe("the cause of a failed hook", () => {
  it("with no error handler, is the hook's own failure", async () => {
    const runtime = makeInMemoryRuntime(registry.build({
      order: registry.handler("order", {
        onEvent: (_ctx, event) => failing(event.sku),
        onAlarm: (ctx) => failing(ctx.id),
      }),
    }))
    expect(await failureOf(runtime.task("order").send("o1", { _tag: "Place", sku: "A-1" }))).toMatchObject({
      _tag: "TaskExecutionError",
      cause: { _tag: "OutOfStock", sku: "A-1" },
    })
    expect(await failureOf(runtime.task("order").fireAlarm("o1"))).toMatchObject({
      _tag: "TaskExecutionError",
      cause: { _tag: "OutOfStock", sku: "o1" },
    })
  })

  it("with an error handler that fails, is the handler's failure, wrapped once", async () => {
    const runtime = makeInMemoryRuntime(registry.build({
      order: registry.handler("order", {
        onEvent: {
          handler: (_ctx, event) => failing(event.sku),
          onError: (_ctx, error) => Effect.fail(new AuditDown({ reason: `could not record ${error._tag}` })),
        },
        onAlarm: {
          handler: (ctx) => failing(ctx.id),
          onError: (_ctx, error) => Effect.fail(error), // hand the hook's failure on
        },
      }),
    }))
    const sent = await failureOf(runtime.task("order").send("o1", { _tag: "Place", sku: "A-1" }))
    expect(sent).toMatchObject({
      _tag: "TaskExecutionError",
      cause: { _tag: "AuditDown", reason: "could not record OutOfStock" },
    })
    const fired = await failureOf(runtime.task("order").fireAlarm("o1"))
    expect(fired).toMatchObject({
      _tag: "TaskExecutionError",
      cause: { _tag: "OutOfStock", sku: "o1" },
    })
  })

  it("with an error handler that recovers, there is no failure", async () => {
    const runtime = makeInMemoryRuntime(registry.build({
      order: registry.handler("order", {
        onEvent: {
          handler: (_ctx, event) => failing(event.sku),
          onError: (ctx, error) => ctx.save({ sku: error.sku }),
        },
        onAlarm: () => Effect.void,
      }),
    }))
    expect(await failureOf(runtime.task("order").send("o1", { _tag: "Place", sku: "A-1" }))).toBeUndefined()
    expect(await Effect.runPromise(runtime.task("order").getState("o1"))).toEqual({ sku: "A-1" })
  })
})
