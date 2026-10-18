import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { Task, TaskRegistry, makeInMemoryRuntime } from "../src/index.js"

const Snapshot = Task.make("snapshot", {
  state: Schema.Struct({ value: Schema.NumberFromString, at: Schema.DateFromString }),
  event: Schema.Struct({ _tag: Schema.Literal("Save"), value: Schema.Number }),
})
const Reader = Task.make("reader", {
  state: Schema.Struct({ value: Schema.Number, timestamp: Schema.Number }),
  event: Schema.Struct({ _tag: Schema.Literal("Read"), source: Schema.String }),
})
const registry = TaskRegistry.make(Snapshot, Reader)
const at = new Date("2026-10-17T12:00:00.000Z")
const built = registry.build({
  snapshot: registry.handler("snapshot", {
    onEvent: (ctx, event) => ctx.save({ value: event.value, at }),
    onAlarm: (ctx) => ctx.update((state) => ({ ...state, value: state.value + 1 })),
  }),
  reader: registry.handler("reader", {
    onEvent: (ctx, event) => Effect.gen(function* () {
      const byName = yield* ctx.task("snapshot").getState(event.source)
      const byTag = yield* ctx.task(Snapshot).getState(event.source)
      if (byName && byTag) {
        yield* ctx.save({ value: byName.value, timestamp: byTag.at.getTime() })
      }
    }),
    onAlarm: () => Effect.void,
  }),
})

describe("schema transformations", () => {
  it("encodes stored state and decodes it for reads and updates", async () => {
    const runtime = makeInMemoryRuntime(built)
    await Effect.runPromise(runtime.task("snapshot").send("s1", { _tag: "Save", value: 42 }))
    expect(runtime.getInstanceStorage("snapshot", "s1")?.get("t:state"))
      .toEqual({ value: "42", at: at.toISOString() })
    expect(await Effect.runPromise(runtime.task("snapshot").getState("s1")))
      .toEqual({ value: 42, at })
    await Effect.runPromise(runtime.task("snapshot").fireAlarm("s1"))
    expect(await Effect.runPromise(runtime.task("snapshot").getState("s1")))
      .toEqual({ value: 43, at })
  })

  it("decodes sibling state through both names and tags", async () => {
    const runtime = makeInMemoryRuntime(built)
    await Effect.runPromise(runtime.task("snapshot").send("s1", { _tag: "Save", value: 42 }))
    await Effect.runPromise(runtime.task("reader").send("r1", { _tag: "Read", source: "s1" }))
    expect(await Effect.runPromise(runtime.task("reader").getState("r1")))
      .toEqual({ value: 42, timestamp: at.getTime() })
  })
})
