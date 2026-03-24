import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { Task, TaskRegistry, makeInMemoryRuntime } from "../src/index.js"

// ============================================================================
// Tasks
// ============================================================================

const JobState = Schema.Struct({
  status: Schema.String,
  attempts: Schema.Number,
})
const JobEvent = Schema.Struct({
  _tag: Schema.Literal("Start"),
  delayMs: Schema.Number,
})
const Job = Task.make("job", { state: JobState, event: JobEvent })

const registry = TaskRegistry.make(Job)

const jobHandler = registry.handler("job", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      yield* ctx.save({ status: "scheduled", attempts: 0 })
      yield* ctx.scheduleIn(`${event.delayMs} millis`)
    }),
  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) return
      yield* ctx.save({ status: "completed", attempts: state.attempts + 1 })
    }),
})

const config = registry.build({ job: jobHandler })

// ============================================================================
// Tests
// ============================================================================

describe("Alarms", () => {
  it("schedules an alarm that fires on tick", async () => {
    const runtime = makeInMemoryRuntime(config)
    const futureTime = Date.now() + 5000

    await Effect.runPromise(runtime.sendEvent("job", "j1", { _tag: "Start", delayMs: 5000 }))

    // Alarm is scheduled
    const alarms = runtime.getScheduledAlarms()
    expect(alarms).toHaveLength(1)
    expect(alarms[0].name).toBe("job")
    expect(alarms[0].id).toBe("j1")

    // State is "scheduled" — alarm hasn't fired yet
    expect(await Effect.runPromise(runtime.getState("job", "j1"))).toEqual({
      status: "scheduled",
      attempts: 0,
    })

    // Tick past the alarm time — alarm fires
    await Effect.runPromise(runtime.tick(futureTime + 1))

    expect(await Effect.runPromise(runtime.getState("job", "j1"))).toEqual({
      status: "completed",
      attempts: 1,
    })

    // No more alarms
    expect(runtime.getScheduledAlarms()).toHaveLength(0)
  })

  it("tick before alarm time does not fire", async () => {
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.sendEvent("job", "j1", { _tag: "Start", delayMs: 10000 }))

    // Tick at current time — alarm is in the future
    await Effect.runPromise(runtime.tick(Date.now()))

    // State unchanged
    expect(await Effect.runPromise(runtime.getState("job", "j1"))).toEqual({
      status: "scheduled",
      attempts: 0,
    })

    // Alarm still pending
    expect(runtime.getScheduledAlarms()).toHaveLength(1)
  })

  it("fireAlarm directly bypasses scheduling", async () => {
    const runtime = makeInMemoryRuntime(config)

    await Effect.runPromise(runtime.sendEvent("job", "j1", { _tag: "Start", delayMs: 999999 }))
    await Effect.runPromise(runtime.fireAlarm("job", "j1"))

    expect(await Effect.runPromise(runtime.getState("job", "j1"))).toEqual({
      status: "completed",
      attempts: 1,
    })
  })

  it("multiple instances have independent alarms", async () => {
    const runtime = makeInMemoryRuntime(config)
    const now = Date.now()

    await Effect.runPromise(runtime.sendEvent("job", "fast", { _tag: "Start", delayMs: 1000 }))
    await Effect.runPromise(runtime.sendEvent("job", "slow", { _tag: "Start", delayMs: 10000 }))

    expect(runtime.getScheduledAlarms()).toHaveLength(2)

    // Only fast alarm fires
    await Effect.runPromise(runtime.tick(now + 2000))

    expect(await Effect.runPromise(runtime.getState("job", "fast"))).toEqual({
      status: "completed",
      attempts: 1,
    })
    expect(await Effect.runPromise(runtime.getState("job", "slow"))).toEqual({
      status: "scheduled",
      attempts: 0,
    })
  })
})
