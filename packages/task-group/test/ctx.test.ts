import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { Task, TaskRegistry, makeInMemoryRuntime } from "../src/index.js"

// ============================================================================
// Tasks
// ============================================================================

const TimerState = Schema.Struct({
  count: Schema.Number,
  lastUpdated: Schema.optionalKey(Schema.Number),
})
const TimerEvent = Schema.Struct({
  _tag: Schema.Literal("Init"),
  count: Schema.Number,
})
const Timer = Task.make("timer", { state: TimerState, event: TimerEvent })

const registry = TaskRegistry.make(Timer)

// ============================================================================
// Tests
// ============================================================================

describe("TaskCtx methods", () => {
  it("ctx.update() applies a transformation to existing state", async () => {
    const handler = registry.handler("timer", {
      onEvent: (ctx, event) =>
        Effect.gen(function* () {
          yield* ctx.save({ count: event.count })
          yield* ctx.update((s) => ({ ...s, count: s.count * 2 }))
        }),
      onAlarm: (ctx) => Effect.void,
    })
    const runtime = makeInMemoryRuntime(registry.build({ timer: handler }))

    await Effect.runPromise(runtime.task("timer").send("t1", { _tag: "Init", count: 5 }))

    expect(await Effect.runPromise(runtime.task("timer").getState("t1"))).toEqual({ count: 10 })
  })

  it("ctx.update() is a no-op when state is null", async () => {
    const handler = registry.handler("timer", {
      onEvent: (ctx, _event) =>
        Effect.gen(function* () {
          // Don't save anything first — state is null
          yield* ctx.update((s) => ({ ...s, count: 999 }))
        }),
      onAlarm: (ctx) => Effect.void,
    })
    const runtime = makeInMemoryRuntime(registry.build({ timer: handler }))

    await Effect.runPromise(runtime.task("timer").send("t1", { _tag: "Init", count: 0 }))

    // State should still be null — update was a no-op
    expect(await Effect.runPromise(runtime.task("timer").getState("t1"))).toBeNull()
  })

  it("ctx.scheduleAt() sets an absolute alarm time", async () => {
    const targetTime = Date.now() + 60_000
    const handler = registry.handler("timer", {
      onEvent: (ctx, event) =>
        Effect.gen(function* () {
          yield* ctx.save({ count: event.count })
          yield* ctx.scheduleAt(targetTime)
        }),
      onAlarm: (ctx) =>
        Effect.gen(function* () {
          yield* ctx.update((s) => ({ ...s, count: s.count + 1 }))
        }),
    })
    const runtime = makeInMemoryRuntime(registry.build({ timer: handler }))

    await Effect.runPromise(runtime.task("timer").send("t1", { _tag: "Init", count: 0 }))

    const alarms = runtime.getScheduledAlarms()
    expect(alarms).toHaveLength(1)
    expect(alarms[0].timestamp).toBe(targetTime)

    // Tick past the alarm
    await Effect.runPromise(runtime.tick(targetTime + 1))
    expect(await Effect.runPromise(runtime.task("timer").getState("t1"))).toEqual({ count: 1 })
  })

  it("ctx.cancelSchedule() removes a pending alarm", async () => {
    const handler = registry.handler("timer", {
      onEvent: (ctx, event) =>
        Effect.gen(function* () {
          yield* ctx.save({ count: event.count })
          yield* ctx.scheduleIn("10 seconds")
          // Immediately cancel
          yield* ctx.cancelSchedule()
        }),
      onAlarm: (ctx) =>
        Effect.gen(function* () {
          yield* ctx.update((s) => ({ ...s, count: s.count + 100 }))
        }),
    })
    const runtime = makeInMemoryRuntime(registry.build({ timer: handler }))

    await Effect.runPromise(runtime.task("timer").send("t1", { _tag: "Init", count: 1 }))

    // No alarms scheduled
    expect(runtime.getScheduledAlarms()).toHaveLength(0)

    // Tick far into the future — nothing fires
    await Effect.runPromise(runtime.tick(Date.now() + 999_999))
    expect(await Effect.runPromise(runtime.task("timer").getState("t1"))).toEqual({ count: 1 })
  })

  it("ctx.nextAlarm() returns the scheduled time", async () => {
    let capturedNext: number | null = null
    const handler = registry.handler("timer", {
      onEvent: (ctx, event) =>
        Effect.gen(function* () {
          yield* ctx.save({ count: event.count })
          yield* ctx.scheduleIn("5 seconds")
          capturedNext = yield* ctx.nextAlarm()
        }),
      onAlarm: (ctx) => Effect.void,
    })
    const runtime = makeInMemoryRuntime(registry.build({ timer: handler }))

    const before = Date.now()
    await Effect.runPromise(runtime.task("timer").send("t1", { _tag: "Init", count: 0 }))

    expect(capturedNext).not.toBeNull()
    // Should be approximately 5 seconds from now
    expect(capturedNext!).toBeGreaterThanOrEqual(before + 4000)
    expect(capturedNext!).toBeLessThanOrEqual(before + 6000)
  })

  it("alarm reschedule loop — fires, reschedules, fires again", async () => {
    const handler = registry.handler("timer", {
      onEvent: (ctx, event) =>
        Effect.gen(function* () {
          yield* ctx.save({ count: event.count })
          yield* ctx.scheduleIn("1 second")
        }),
      onAlarm: (ctx) =>
        Effect.gen(function* () {
          const state = yield* ctx.recall()
          if (!state) return
          const next = state.count + 1
          yield* ctx.save({ count: next })
          // Reschedule if under 3
          if (next < 3) {
            yield* ctx.scheduleIn("1 second")
          }
        }),
    })
    const runtime = makeInMemoryRuntime(registry.build({ timer: handler }))
    const now = Date.now()

    await Effect.runPromise(runtime.task("timer").send("t1", { _tag: "Init", count: 0 }))

    // Tick 3 times — alarm fires, increments, reschedules
    await Effect.runPromise(runtime.tick(now + 2000))
    expect(await Effect.runPromise(runtime.task("timer").getState("t1"))).toEqual({ count: 1 })

    await Effect.runPromise(runtime.tick(now + 4000))
    expect(await Effect.runPromise(runtime.task("timer").getState("t1"))).toEqual({ count: 2 })

    await Effect.runPromise(runtime.tick(now + 6000))
    expect(await Effect.runPromise(runtime.task("timer").getState("t1"))).toEqual({ count: 3 })

    // No more alarms — it stopped at 3
    expect(runtime.getScheduledAlarms()).toHaveLength(0)
  })
})
