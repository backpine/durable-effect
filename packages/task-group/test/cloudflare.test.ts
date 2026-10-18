import { describe, it, expect } from "vitest"
import { Context, Effect, Layer, Schema } from "effect"
import {
  Task,
  TaskRegistry,
} from "../src/index.js"
import { makeTaskGroupDO } from "../src/cloudflare/index.js"
import type { DurableObjectNamespaceLike, DurableObjectStateLike, TaskGroupStubLike } from "../src/cloudflare/types.js"

// ============================================================================
// Task declarations
// ============================================================================

const Counter = Task.make("counter", {
  state: Schema.Struct({ count: Schema.Number }),
  event: Schema.Struct({ _tag: Schema.Literal("Inc"), amount: Schema.Number }),
})

const Logger = Task.make("logger", {
  state: Schema.Struct({ entries: Schema.Array(Schema.String) }),
  event: Schema.Struct({ _tag: Schema.Literal("Log"), message: Schema.String }),
})

const registry = TaskRegistry.make(Counter, Logger)

const counterHandler = registry.handler("counter", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      const count = (state?.count ?? 0) + event.amount
      yield* ctx.save({ count })
      yield* Effect.log(`[counter] count=${count}`)

      // Sibling dispatch
      yield* ctx.task("logger").send(ctx.id, {
        _tag: "Log",
        message: `incremented to ${count}`,
      })
    }),
  onAlarm: (ctx) =>
    Effect.gen(function* () {
      yield* Effect.log("[counter] alarm fired")
      yield* ctx.purge()
    }),
})

const loggerHandler = registry.handler("logger", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      const entries = state?.entries ?? []
      yield* ctx.save({ entries: [...entries, event.message] })
      yield* Effect.log(`[logger] logged: ${event.message}`)
    }),
  onAlarm: (ctx) => Effect.void,
})

const registryConfig = registry.build({
  counter: counterHandler,
  logger: loggerHandler,
})

// ============================================================================
// Mock CF infrastructure
// ============================================================================

/** Creates a mock DurableObjectState backed by a plain Map */
function mockDOState(): DurableObjectStateLike {
  const data = new Map<string, unknown>()
  let alarm: number | null = null
  function get(key: string): Promise<unknown>
  function get(keys: string[]): Promise<Map<string, unknown>>
  function get(keyOrKeys: string | string[]): Promise<unknown> {
    if (typeof keyOrKeys === "string") return Promise.resolve(data.get(keyOrKeys))
    const entries = new Map<string, unknown>()
    for (const key of keyOrKeys) {
      if (data.has(key)) entries.set(key, data.get(key))
    }
    return Promise.resolve(entries)
  }
  return {
    id: { toString: () => "mock-do-id" },
    storage: {
      get,
      put: (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
        if (typeof keyOrEntries === "string") data.set(keyOrEntries, value)
        else for (const [key, entry] of Object.entries(keyOrEntries)) data.set(key, entry)
        return Promise.resolve()
      },
      delete: (key: string) => {
        const existed = data.has(key)
        data.delete(key)
        return Promise.resolve(existed)
      },
      deleteAll: () => {
        data.clear()
        return Promise.resolve()
      },
      setAlarm: (ts: number | Date) => {
        alarm = typeof ts === "number" ? ts : ts.getTime()
        return Promise.resolve()
      },
      deleteAlarm: () => {
        alarm = null
        return Promise.resolve()
      },
      getAlarm: () => Promise.resolve(alarm),
    },
  }
}

/**
 * Creates a mock DO namespace. Each name:id pair gets its own DO instance
 * (mock state + instantiated DO class). This simulates CF's per-instance
 * isolation at the test level.
 */
function mockNamespace(
  DOClass: { new (ctx: DurableObjectStateLike, env: unknown): TaskGroupStubLike },
): DurableObjectNamespaceLike {
  const instances = new Map<string, InstanceType<typeof DOClass>>()

  function getInstance(instanceId: string) {
    let instance = instances.get(instanceId)
    if (!instance) {
      const state = mockDOState()
      instance = new DOClass(state, {})
      instances.set(instanceId, instance)
    }
    return instance
  }

  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id) => {
      const instance = getInstance(id.toString())
      return {
        handleEvent: (name: string, id: string, event: unknown) =>
          instance.handleEvent(name, id, event),
        handleAlarm: (name: string, id: string) =>
          instance.handleAlarm(name, id),
        handleGetState: (name: string, id: string) =>
          instance.handleGetState(name, id),
      }
    },
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("Cloudflare adapter", () => {
  it("DO handles event and persists state", async () => {
    const taskGroup = makeTaskGroupDO(registryConfig)
    const namespace = mockNamespace(taskGroup.DO)
    const runtime = taskGroup.client(namespace)

    await Effect.runPromise(runtime.task("counter").send("c1", { _tag: "Inc", amount: 5 }))
    const state = await Effect.runPromise(runtime.task("counter").getState("c1"))

    expect(state).toEqual({ count: 5 })
  })

  it("DO handles sibling dispatch", async () => {
    const taskGroup = makeTaskGroupDO(registryConfig)
    const namespace = mockNamespace(taskGroup.DO)
    const runtime = taskGroup.client(namespace)

    await Effect.runPromise(runtime.task("counter").send("shared", { _tag: "Inc", amount: 10 }))

    // Counter dispatched to Logger
    const logState = await Effect.runPromise(runtime.task("logger").getState("shared"))
    expect(logState).toEqual({ entries: ["incremented to 10"] })
  })

  it("DO accumulates state across events", async () => {
    const taskGroup = makeTaskGroupDO(registryConfig)
    const namespace = mockNamespace(taskGroup.DO)
    const runtime = taskGroup.client(namespace)

    await Effect.runPromise(runtime.task("counter").send("c1", { _tag: "Inc", amount: 3 }))
    await Effect.runPromise(runtime.task("counter").send("c1", { _tag: "Inc", amount: 7 }))
    const state = await Effect.runPromise(runtime.task("counter").getState("c1"))

    expect(state).toEqual({ count: 10 })
  })

  it("DO isolates instances", async () => {
    const taskGroup = makeTaskGroupDO(registryConfig)
    const namespace = mockNamespace(taskGroup.DO)
    const runtime = taskGroup.client(namespace)

    await Effect.runPromise(runtime.task("counter").send("a", { _tag: "Inc", amount: 1 }))
    await Effect.runPromise(runtime.task("counter").send("b", { _tag: "Inc", amount: 100 }))

    expect(await Effect.runPromise(runtime.task("counter").getState("a"))).toEqual({ count: 1 })
    expect(await Effect.runPromise(runtime.task("counter").getState("b"))).toEqual({ count: 100 })
  })

  it("fireAlarm triggers alarm handler", async () => {
    const taskGroup = makeTaskGroupDO(registryConfig)
    const namespace = mockNamespace(taskGroup.DO)
    const runtime = taskGroup.client(namespace)

    await Effect.runPromise(runtime.task("counter").send("c1", { _tag: "Inc", amount: 1 }))
    await Effect.runPromise(runtime.task("counter").fireAlarm("c1"))

    // Alarm purges state
    const state = await Effect.runPromise(runtime.task("counter").getState("c1"))
    expect(state).toBeNull()
  })

  it("rejects invalid events at compile time", () => {
    const taskGroup = makeTaskGroupDO(registryConfig)
    const namespace = mockNamespace(taskGroup.DO)
    const runtime = taskGroup.client(namespace)

    // @ts-expect-error — "Bad" is not a valid _tag for counter events
    runtime.task("counter").send("c1", { _tag: "Bad" })
  })

  it("alarm() lifecycle reads routing keys", async () => {
    const taskGroup = makeTaskGroupDO(registryConfig)
    const state = mockDOState()
    const namespace = mockNamespace(taskGroup.DO)
    taskGroup.client(namespace) // wire the namespace

    // Create a DO instance directly to test alarm() lifecycle
    const doInstance = new taskGroup.DO(state, {})

    // Simulate: send event (stores routing keys), then alarm fires
    await doInstance.handleEvent("counter", "c1", { _tag: "Inc", amount: 42 })
    await doInstance.alarm()

    // After alarm, counter should be purged (alarm handler calls purge)
    const result = await doInstance.handleGetState("counter", "c1")
    expect(result).toBeNull()
  })

  it("alarm() with retry info sets systemFailure", async () => {
    // Create a task that exposes system failure status
    const Checker = Task.make("checker", {
      state: Schema.Struct({ status: Schema.String, failure: Schema.optionalKey(Schema.String) }),
      event: Schema.Struct({ _tag: Schema.Literal("Setup") }),
    })

    const checkerRegistry = TaskRegistry.make(Checker)
    const checkerHandler = checkerRegistry.handler("checker", {
      onEvent: (ctx, _event) => ctx.save({ status: "ready" }),
      onAlarm: (ctx) =>
        Effect.gen(function* () {
          const state = yield* ctx.recall()
          if (!state) return
          if (ctx.systemFailure) {
            yield* ctx.save({ ...state, status: "recovered", failure: ctx.systemFailure.message })
          } else {
            yield* ctx.save({ ...state, status: "alarm-ok" })
          }
        }),
    })

    const checkerConfig = checkerRegistry.build({ checker: checkerHandler })
    const taskGroup = makeTaskGroupDO(checkerConfig)
    const namespace = mockNamespace(taskGroup.DO)
    taskGroup.client(namespace)

    const doInstance = new taskGroup.DO(mockDOState(), {})
    await doInstance.handleEvent("checker", "c1", { _tag: "Setup" })

    // Fire alarm with retry info (simulates CF restart)
    await doInstance.alarm({ isRetry: true, retryCount: 2 })

    const state = await doInstance.handleGetState("checker", "c1")
    expect(state).toEqual({
      status: "recovered",
      failure: "Alarm retry #2 — previous attempt failed",
    })
  })
})


describe("Cloudflare environment provision", () => {
  it("resolves hook services and sibling RPC on a cold alarm without a client call", async () => {
    interface Env {
      readonly prefix: string
      readonly namespace: DurableObjectNamespaceLike
    }
    class AppEnv extends Context.Service<AppEnv, Env>()("@test/ColdEnv") {}
    class Prefix extends Context.Service<Prefix, string>()("@test/Prefix") {}
    let builds = 0
    const PrefixLive = Layer.effect(Prefix, Effect.gen(function* () {
      const env = yield* AppEnv
      builds++
      return env.prefix
    }))
    const coldRegistry = TaskRegistry.make(Counter, Logger)
    const built = coldRegistry.build({
      counter: coldRegistry.handler("counter", {
        onEvent: (ctx, event) => ctx.save({ count: event.amount }),
        onAlarm: {
          handler: (ctx) => Effect.gen(function* () {
            const prefix = yield* Prefix
            yield* ctx.task(Logger).send(ctx.id, { _tag: "Log", message: prefix })
            const sibling = yield* ctx.task("logger").getState(ctx.id)
            yield* ctx.save({ count: sibling?.entries.length ?? 0 })
          }),
          provide: PrefixLive,
        },
      }),
      logger: loggerHandler,
    })
    const group = makeTaskGroupDO(built, { env: AppEnv, namespace: (env) => env.namespace })
    const instances = new Map<string, TaskGroupStubLike>()
    const namespace: DurableObjectNamespaceLike = {
      idFromName: (name) => ({ toString: () => name }),
      get: (id) => {
        const key = id.toString()
        const cached = instances.get(key)
        if (cached) return cached
        const instance = new group.DO(mockDOState(), { prefix: "cold", namespace })
        instances.set(key, instance)
        return instance
      },
    }
    const storage = mockDOState()
    const env: Env = { prefix: "cold", namespace }
    await new group.DO(storage, env).handleEvent("counter", "c1", { _tag: "Inc", amount: 5 })
    // Reconstruct the object as Cloudflare does when waking a persisted alarm.
    const restarted = new group.DO(storage, env)
    await restarted.alarm()
    await restarted.handleAlarm("counter", "c1")
    expect(await restarted.handleGetState("counter", "c1")).toEqual({ count: 2 })
    expect(await namespace.get(namespace.idFromName("logger:c1")).handleGetState("logger", "c1"))
      .toEqual({ entries: ["cold", "cold"] })
    expect(builds).toBe(1)
  })
})
