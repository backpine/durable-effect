import { describe, it, expect } from "vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { Task, TaskRegistry, makeInMemoryRuntime } from "../src/index.js"

// ============================================================================
// New pattern: a TYPED platform env service (no `unknown`, no cast at use).
// ============================================================================

interface Env {
  readonly DB_URL: string
  readonly SLACK_TOKEN: string
}
class AppEnv extends Context.Service<AppEnv, Env>()("@test/AppEnv") {}

// ============================================================================
// Domain services + platform-agnostic layers. Build counters prove WHEN each
// layer's construction actually runs.
// ============================================================================

class Logger extends Context.Service<Logger, {
  readonly info: (m: string) => Effect.Effect<void>
}>()("@test/Logger") {}

class Database extends Context.Service<Database, {
  readonly insert: (row: string) => Effect.Effect<void>
}>()("@test/Database") {}

class Slack extends Context.Service<Slack, {
  readonly post: (m: string) => Effect.Effect<void>
}>()("@test/Slack") {}

const builds = { logger: 0, db: 0, slack: 0 }
const events: string[] = []

const LoggerLive = Layer.effect(Logger, Effect.sync(() => {
  builds.logger++
  return { info: (m) => Effect.sync(() => { events.push(`log:${m}`) }) }
}))
const DatabaseLive = Layer.effect(Database, Effect.gen(function* () {
  const env = yield* AppEnv // typed, no cast
  builds.db++
  return { insert: (row) => Effect.sync(() => { events.push(`db[${env.DB_URL}]:${row}`) }) }
}))
const SlackLive = Layer.effect(Slack, Effect.gen(function* () {
  const env = yield* AppEnv
  builds.slack++
  return { post: (m) => Effect.sync(() => { events.push(`slack[${env.SLACK_TOKEN}]:${m}`) }) }
}))

// ============================================================================
// A task whose onEvent is light (Logger only) and onAlarm is heavy
// (Database + Slack, both env-dependent). Services are provided PER HOOK.
// ============================================================================

const Notify = Task.make("notify", {
  state: Schema.Struct({ count: Schema.Number }),
  event: Schema.Struct({ _tag: Schema.Literal("Ping") }),
})
const registry = TaskRegistry.make(Notify)

const notifyHandler = registry.handler("notify", {
  onEvent: {
    handler: (ctx, _event) =>
      Effect.gen(function* () {
        const logger = yield* Logger
        yield* logger.info("ping")
        const state = yield* ctx.recall()
        yield* ctx.save({ count: (state?.count ?? 0) + 1 })
      }),
    provide: LoggerLive, // events only ever build the logger
  },
  onAlarm: {
    handler: (ctx) =>
      Effect.gen(function* () {
        const db = yield* Database
        const slack = yield* Slack
        yield* db.insert(`report ${ctx.id}`)
        yield* slack.post(`done ${ctx.id}`)
      }),
    provide: Layer.mergeAll(DatabaseLive, SlackLive), // merge several services
  },
})

// The registry's residual R is inferred as AppEnv (the layers' only requirement).
const built = registry.build({ notify: notifyHandler })

function makeRuntime() {
  return makeInMemoryRuntime(built, {
    services: Layer.succeed(AppEnv, { DB_URL: "pg://prod", SLACK_TOKEN: "xoxb" }),
  })
}

// ============================================================================
// Tests
// ============================================================================

describe("per-hook service provision", () => {
  it("light events never build the heavy graph; alarm builds it lazily", async () => {
    builds.logger = 0; builds.db = 0; builds.slack = 0
    events.length = 0
    const runtime = makeRuntime()

    // 3 events — only the logger is ever built (once, memoized).
    for (let i = 0; i < 3; i++) {
      await Effect.runPromise(runtime.task("notify").send("n1", { _tag: "Ping" }))
    }
    expect(builds).toEqual({ logger: 1, db: 0, slack: 0 })
    expect(await Effect.runPromise(runtime.task("notify").getState("n1"))).toEqual({ count: 3 })

    // 2 alarms — the heavy graph builds once each, memoized across both.
    for (let i = 0; i < 2; i++) {
      await Effect.runPromise(runtime.task("notify").fireAlarm("n1"))
    }
    expect(builds).toEqual({ logger: 1, db: 1, slack: 1 })
    expect(events).toContain("db[pg://prod]:report n1")
    expect(events).toContain("slack[xoxb]:done n1")
  })

  it("memoizes per instance — separate instances build their own layers", async () => {
    builds.db = 0; builds.slack = 0
    const runtime = makeRuntime()

    await Effect.runPromise(runtime.task("notify").fireAlarm("a"))
    await Effect.runPromise(runtime.task("notify").fireAlarm("a")) // same instance
    await Effect.runPromise(runtime.task("notify").fireAlarm("b")) // new instance

    // Instance "a": built once (reused on the 2nd alarm). Instance "b": once.
    expect(builds.db).toBe(2)
    expect(builds.slack).toBe(2)
  })
})
