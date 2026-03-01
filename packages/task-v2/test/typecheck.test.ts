import { describe, it, expect } from "vitest"
import { Data, Effect, Layer, Schema, ServiceMap } from "effect"
import {
  Task,
  Storage,
  Alarm,
  TaskRunner,
  TaskRegistry,
  registerTask,
  buildRegistryLayer,
  TaskError,
  PurgeSignal,
  TaskNotFoundError,
  TaskValidationError,
  TaskExecutionError,
} from "../src/index.js"
import type { TaskContext, TaskDefinition } from "../src/index.js"

// ---------------------------------------------------------------------------
// Test schemas
// ---------------------------------------------------------------------------

const OrderState = Schema.Struct({
  orderId: Schema.String,
  status: Schema.String,
  attempts: Schema.Number,
})
type OrderState = typeof OrderState.Type

const OrderEvent = Schema.Struct({
  _tag: Schema.String,
  orderId: Schema.String,
})
type OrderEvent = typeof OrderEvent.Type

// ---------------------------------------------------------------------------
// Test service
// ---------------------------------------------------------------------------

class EmailService extends ServiceMap.Service<EmailService, {
  readonly send: (to: string, body: string) => Effect.Effect<void>
}>()("test/EmailService") {}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Task.define()", () => {
  it("creates a TaskDefinition with correct _tag", () => {
    const def = Task.define({
      state: OrderState,
      event: OrderEvent,
      onEvent: (_ctx: TaskContext<OrderState>, _event: OrderEvent) =>
        Effect.void,
      onAlarm: (_ctx: TaskContext<OrderState>) => Effect.void,
    })

    expect(def._tag).toBe("TaskDefinition")
    expect(def.state).toBe(OrderState)
    expect(def.event).toBe(OrderEvent)
  })

  it("stores handlers", () => {
    const onEvent = (_ctx: TaskContext<OrderState>, _event: OrderEvent) =>
      Effect.void
    const onAlarm = (_ctx: TaskContext<OrderState>) => Effect.void

    const def = Task.define({
      state: OrderState,
      event: OrderEvent,
      onEvent,
      onAlarm,
    })

    expect(def.onEvent).toBe(onEvent)
    expect(def.onAlarm).toBe(onAlarm)
    expect(def.onError).toBeUndefined()
  })

  it("supports onError handler", () => {
    const onError = (_ctx: TaskContext<OrderState>, _err: unknown) =>
      Effect.void

    const def = Task.define({
      state: OrderState,
      event: OrderEvent,
      onEvent: (_ctx: TaskContext<OrderState>, _event: OrderEvent) =>
        Effect.void,
      onAlarm: (_ctx: TaskContext<OrderState>) => Effect.void,
      onError,
    })

    expect(def.onError).toBe(onError)
  })
})

describe("registerTask()", () => {
  it("registers a task with no services", () => {
    const def = Task.define({
      state: OrderState,
      event: OrderEvent,
      onEvent: (_ctx: TaskContext<OrderState>, _event: OrderEvent) =>
        Effect.void,
      onAlarm: (_ctx: TaskContext<OrderState>) => Effect.void,
    })

    const entry = registerTask(def)
    expect(entry.definition).toBe(def)
    expect(entry.layer).toBeUndefined()
  })

  it("registers a task with services", () => {
    const def = Task.define({
      state: OrderState,
      event: OrderEvent,
      onEvent: (_ctx: TaskContext<OrderState>, _event: OrderEvent) =>
        Effect.gen(function* () {
          const email = yield* EmailService
          yield* email.send("test@test.com", "placed")
        }),
      onAlarm: (_ctx: TaskContext<OrderState>) => Effect.void,
    })

    const emailLayer = Layer.succeed(EmailService, {
      send: (_to, _body) => Effect.void,
    })

    const entry = registerTask(def, emailLayer)
    expect(entry.definition).toBe(def)
    expect(entry.layer).toBe(emailLayer)
  })
})

describe("buildRegistryLayer()", () => {
  it("creates a TaskRegistry layer from config", async () => {
    const orderDef = Task.define({
      state: OrderState,
      event: OrderEvent,
      onEvent: (_ctx: TaskContext<OrderState>, _event: OrderEvent) =>
        Effect.void,
      onAlarm: (_ctx: TaskContext<OrderState>) => Effect.void,
    })

    const layer = buildRegistryLayer({
      order: registerTask(orderDef),
    })

    const program = Effect.gen(function* () {
      const registry = yield* TaskRegistry
      const entry = registry.get("order")
      const names = registry.names()
      return { found: entry !== undefined, names }
    })

    const result = await Effect.runPromise(Effect.provide(program, layer))
    expect(result.found).toBe(true)
    expect(result.names).toEqual(["order"])
  })

  it("returns undefined for unknown task name", async () => {
    const layer = buildRegistryLayer({})

    const program = Effect.gen(function* () {
      const registry = yield* TaskRegistry
      return registry.get("nonexistent")
    })

    const result = await Effect.runPromise(Effect.provide(program, layer))
    expect(result).toBeUndefined()
  })
})

describe("Error types", () => {
  it("TaskError is tagged", () => {
    const err = new TaskError({ message: "failed" })
    expect(err._tag).toBe("TaskError")
    expect(err.message).toBe("failed")
  })

  it("PurgeSignal is tagged", () => {
    const sig = new PurgeSignal()
    expect(sig._tag).toBe("PurgeSignal")
  })

  it("TaskNotFoundError is tagged", () => {
    const err = new TaskNotFoundError({ name: "unknown" })
    expect(err._tag).toBe("TaskNotFoundError")
    expect(err.name).toBe("unknown")
  })

  it("TaskValidationError is tagged", () => {
    const err = new TaskValidationError({ message: "bad event" })
    expect(err._tag).toBe("TaskValidationError")
  })

  it("TaskExecutionError is tagged", () => {
    const err = new TaskExecutionError({ cause: new Error("boom") })
    expect(err._tag).toBe("TaskExecutionError")
  })

  it("errors are catchable by tag in effects", async () => {
    const program = Effect.gen(function* () {
      yield* Effect.fail(new TaskNotFoundError({ name: "test" }))
    }).pipe(
      Effect.catchTag("TaskNotFoundError", (e) =>
        Effect.succeed(e.name),
      ),
    )

    const result = await Effect.runPromise(program)
    expect(result).toBe("test")
  })
})

describe("Service interfaces", () => {
  it("Storage service can be provided and consumed", async () => {
    const storageLayer = Layer.succeed(Storage, {
      get: (_key) => Effect.succeed(null),
      set: (_key, _value) => Effect.void,
      delete: (_key) => Effect.void,
      deleteAll: () => Effect.void,
    })

    const program = Effect.gen(function* () {
      const storage = yield* Storage
      const result = yield* storage.get("test-key")
      return result
    })

    const result = await Effect.runPromise(Effect.provide(program, storageLayer))
    expect(result).toBeNull()
  })

  it("Alarm service can be provided and consumed", async () => {
    const alarmLayer = Layer.succeed(Alarm, {
      set: (_ts) => Effect.void,
      cancel: () => Effect.void,
      next: () => Effect.succeed(null),
    })

    const program = Effect.gen(function* () {
      const alarm = yield* Alarm
      const nextAlarm = yield* alarm.next()
      return nextAlarm
    })

    const result = await Effect.runPromise(Effect.provide(program, alarmLayer))
    expect(result).toBeNull()
  })

  it("TaskRunner service can be yielded when provided", async () => {
    const runnerLayer = Layer.succeed(TaskRunner, {
      handleEvent: (_name, _id, _event) =>
        Effect.fail(new TaskNotFoundError({ name: _name })),
      handleAlarm: (_name, _id) =>
        Effect.fail(new TaskNotFoundError({ name: _name })),
    })

    const program = Effect.gen(function* () {
      const runner = yield* TaskRunner
      return yield* runner.handleEvent("test", "id-1", {}).pipe(
        Effect.catchTag("TaskNotFoundError", (e) =>
          Effect.succeed(e.name),
        ),
      )
    })

    const result = await Effect.runPromise(Effect.provide(program, runnerLayer))
    expect(result).toBe("test")
  })
})

describe("End-to-end service composition", () => {
  it("all services compose via layers", async () => {
    // Define a task
    const counterState = Schema.Struct({ count: Schema.Number })
    const counterEvent = Schema.Struct({ amount: Schema.Number })

    const counterTask = Task.define({
      state: counterState,
      event: counterEvent,
      onEvent: (ctx: TaskContext<typeof counterState.Type>, event: typeof counterEvent.Type) =>
        ctx.save({ count: event.amount }),
      onAlarm: (_ctx: TaskContext<typeof counterState.Type>) => Effect.void,
    })

    // Register it
    const registryLayer = buildRegistryLayer({
      counter: registerTask(counterTask),
    })

    // Provide platform services (mock implementations)
    const storageLayer = Layer.succeed(Storage, {
      get: (_key) => Effect.succeed(null),
      set: (_key, _value) => Effect.void,
      delete: (_key) => Effect.void,
      deleteAll: () => Effect.void,
    })

    const alarmLayer = Layer.succeed(Alarm, {
      set: (_ts) => Effect.void,
      cancel: () => Effect.void,
      next: () => Effect.succeed(null),
    })

    // Stub TaskRunner (since we haven't built the live implementation)
    const runnerLayer = Layer.succeed(TaskRunner, {
      handleEvent: (_name, _id, _event) => Effect.void,
      handleAlarm: (_name, _id) => Effect.void,
    })

    // Compose all layers
    const fullLayer = Layer.mergeAll(
      registryLayer,
      storageLayer,
      alarmLayer,
      runnerLayer,
    )

    // Use all services together
    const program = Effect.gen(function* () {
      const registry = yield* TaskRegistry
      const storage = yield* Storage
      const alarm = yield* Alarm
      const runner = yield* TaskRunner

      // Verify registry has our task
      const entry = registry.get("counter")
      if (!entry) return { found: false, stored: null, alarm: null }

      // Use storage and alarm directly
      yield* storage.set("test", "value")
      const stored = yield* storage.get("test")
      const nextAlarm = yield* alarm.next()

      // Use runner
      yield* runner.handleEvent("counter", "instance-1", { amount: 42 })

      return { found: true, stored, alarm: nextAlarm }
    })

    const result = await Effect.runPromise(Effect.provide(program, fullLayer))
    expect(result.found).toBe(true)
  })
})
