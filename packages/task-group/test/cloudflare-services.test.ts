import { describe, it, expect } from "vitest"
import { Effect, Layer, Schema, Context } from "effect"
import {
  Task,
  TaskRegistry,
  makeInMemoryRuntime,
  withServices,
} from "../src/index.js"
import { CloudflareEnv, cloudflareServices } from "../src/cloudflare/index.js"

// ============================================================================
// Simulate a wrangler-generated Env type
// ============================================================================

interface Env {
  readonly API_KEY: string
  readonly DB_URL: string
}

// ============================================================================
// External services that would normally need Cloudflare env bindings
// ============================================================================

class ApiClient extends Context.Service<ApiClient, {
  readonly call: (endpoint: string) => Effect.Effect<string>
}>()("@test/ApiClient") {}

class DbClient extends Context.Service<DbClient, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("@test/DbClient") {}

// ============================================================================
// Service layer factory — takes env, returns a layer.
// In production, this would call connect() or similar (I/O that's banned
// in Cloudflare global scope).
// ============================================================================

const calls: string[] = []

function makeServicesLayer(env: Env): Layer.Layer<ApiClient | DbClient> {
  // Track that construction happened (to verify it's deferred)
  calls.push(`layer-built:${env.API_KEY}`)
  return Layer.mergeAll(
    Layer.succeed(ApiClient)({
      call: (endpoint) => Effect.succeed(`api[${env.API_KEY}]:${endpoint}`),
    }),
    Layer.succeed(DbClient)({
      query: (sql) => Effect.succeed(`db[${env.DB_URL}]:${sql}`),
    }),
  )
}

// ============================================================================
// Tasks
// ============================================================================

const WorkerState = Schema.Struct({
  result: Schema.String,
})
const FetchEvent = Schema.Struct({ _tag: Schema.Literal("FetchData"), endpoint: Schema.String })
const QueryEvent = Schema.Struct({ _tag: Schema.Literal("QueryDb"), sql: Schema.String })
const WorkerEvent = Schema.Union([FetchEvent, QueryEvent])
const Worker = Task.make("worker", { state: WorkerState, event: WorkerEvent })

const LogState = Schema.Struct({ entries: Schema.Array(Schema.String) })
const LogEvent = Schema.Struct({ _tag: Schema.Literal("Append"), text: Schema.String })
const Log = Task.make("log", { state: LogState, event: LogEvent })

const registry = TaskRegistry.make(Worker, Log)

// ============================================================================
// cloudflareServices<Env>() — set up once per project
// ============================================================================

const withCloudflareServices = cloudflareServices<Env>()

// ============================================================================
// Handler using deferred services
// ============================================================================

const workerHandler = registry.handler("worker",
  withCloudflareServices(
    {
      onEvent: (ctx, event) =>
        Effect.gen(function* () {
          if (event._tag === "FetchData") {
            const api = yield* ApiClient
            const result = yield* api.call(event.endpoint)
            yield* ctx.save({ result })
          } else {
            const db = yield* DbClient
            const result = yield* db.query(event.sql)
            yield* ctx.save({ result })
          }
        }),
      onAlarm: (ctx) => Effect.void,
    },
    (env) => makeServicesLayer(env),
  ),
)

// ============================================================================
// Handler WITHOUT deferred services (plain, no R)
// ============================================================================

const logHandler = registry.handler("log", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      const entries = state?.entries ?? []
      yield* ctx.save({ entries: [...entries, event.text] })
    }),
  onAlarm: (ctx) => Effect.void,
})

// ============================================================================
// Tests
// ============================================================================

describe("cloudflareServices", () => {
  it("defers layer construction until runtime provides CloudflareEnv", async () => {
    calls.length = 0

    const built = registry.build({ worker: workerHandler, log: logHandler })

    // Layer not built yet — it's deferred
    expect(calls).toEqual([])

    const mockEnv: Env = { API_KEY: "test-key", DB_URL: "postgres://test" }
    const runtime = makeInMemoryRuntime(built, {
      services: Layer.succeed(CloudflareEnv)(mockEnv),
    })

    // Layer still not built — deferred until first Effect.runPromise
    expect(calls).toEqual([])

    await Effect.runPromise(
      runtime.task("worker").send("w1", { _tag: "FetchData", endpoint: "/users" }),
    )

    // NOW the layer was built
    expect(calls).toEqual(["layer-built:test-key"])

    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))
    expect(state).toEqual({ result: "api[test-key]:/users" })
  })

  it("deferred services work with DB queries", async () => {
    calls.length = 0
    const mockEnv: Env = { API_KEY: "k", DB_URL: "pg://db" }
    const built = registry.build({ worker: workerHandler, log: logHandler })
    const runtime = makeInMemoryRuntime(built, {
      services: Layer.succeed(CloudflareEnv)(mockEnv),
    })

    await Effect.runPromise(
      runtime.task("worker").send("w1", { _tag: "QueryDb", sql: "SELECT 1" }),
    )

    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))
    expect(state).toEqual({ result: "db[pg://db]:SELECT 1" })
  })

  it("handlers with and without deferred services coexist in one registry", async () => {
    calls.length = 0
    const mockEnv: Env = { API_KEY: "k", DB_URL: "pg://db" }
    const built = registry.build({ worker: workerHandler, log: logHandler })
    const runtime = makeInMemoryRuntime(built, {
      services: Layer.succeed(CloudflareEnv)(mockEnv),
    })

    // Use both task types in the same runtime
    await Effect.runPromise(
      runtime.task("worker").send("w1", { _tag: "FetchData", endpoint: "/health" }),
    )
    await Effect.runPromise(
      runtime.task("log").send("l1", { _tag: "Append", text: "hello" }),
    )

    const workerState = await Effect.runPromise(runtime.task("worker").getState("w1"))
    const logState = await Effect.runPromise(runtime.task("log").getState("l1"))

    expect(workerState).toEqual({ result: "api[k]:/health" })
    expect(logState).toEqual({ entries: ["hello"] })
  })

  it("different mock envs produce different service behavior", async () => {
    const builtA = registry.build({ worker: workerHandler, log: logHandler })
    const builtB = registry.build({ worker: workerHandler, log: logHandler })

    const runtimeA = makeInMemoryRuntime(builtA, {
      services: Layer.succeed(CloudflareEnv)({ API_KEY: "alpha", DB_URL: "a" } satisfies Env),
    })
    const runtimeB = makeInMemoryRuntime(builtB, {
      services: Layer.succeed(CloudflareEnv)({ API_KEY: "beta", DB_URL: "b" } satisfies Env),
    })

    await Effect.runPromise(
      runtimeA.task("worker").send("w1", { _tag: "FetchData", endpoint: "/x" }),
    )
    await Effect.runPromise(
      runtimeB.task("worker").send("w1", { _tag: "FetchData", endpoint: "/x" }),
    )

    const stateA = await Effect.runPromise(runtimeA.task("worker").getState("w1"))
    const stateB = await Effect.runPromise(runtimeB.task("worker").getState("w1"))

    expect(stateA).toEqual({ result: "api[alpha]:/x" })
    expect(stateB).toEqual({ result: "api[beta]:/x" })
  })

  it("composing pure + env-dependent services in one deferred factory", async () => {
    // A pure service — safe at module scope, but included in the deferred
    // factory so all services are co-located
    class Logger extends Context.Service<Logger, {
      readonly log: (msg: string) => Effect.Effect<void>
    }>()("@test/Logger") {}

    const logs: string[] = []
    const LoggerLive = Layer.succeed(Logger)({
      log: (msg) => Effect.sync(() => { logs.push(msg) }),
    })

    // Handler needs Logger (pure) + ApiClient (needs env) + DbClient (needs env)
    // All provided together in the deferred factory
    const composedHandler = registry.handler("worker",
      withCloudflareServices(
        {
          onEvent: (ctx, event) =>
            Effect.gen(function* () {
              const logger = yield* Logger
              const api = yield* ApiClient
              if (event._tag === "FetchData") {
                const result = yield* api.call(event.endpoint)
                yield* logger.log(`fetched: ${result}`)
                yield* ctx.save({ result })
              }
            }),
          onAlarm: (ctx) => Effect.void,
        },
        (env) => Layer.mergeAll(
          LoggerLive,            // pure — doesn't need env, but lives here too
          makeServicesLayer(env), // env-dependent
        ),
      ),
    )

    const built = registry.build({ worker: composedHandler, log: logHandler })
    const runtime = makeInMemoryRuntime(built, {
      services: Layer.succeed(CloudflareEnv)({ API_KEY: "comp", DB_URL: "d" } satisfies Env),
    })

    await Effect.runPromise(
      runtime.task("worker").send("w1", { _tag: "FetchData", endpoint: "/composed" }),
    )

    const state = await Effect.runPromise(runtime.task("worker").getState("w1"))
    expect(state).toEqual({ result: "api[comp]:/composed" })
    expect(logs).toEqual(["fetched: api[comp]:/composed"])
  })
})
