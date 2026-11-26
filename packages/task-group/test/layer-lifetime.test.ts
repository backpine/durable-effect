import { describe, it, expect } from "vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { Task, TaskRegistry, makeInMemoryRuntime, withServices } from "../src/index.js"
import { makeTaskGroupDO } from "../src/cloudflare/index.js"
import type { DurableObjectStateLike } from "../src/cloudflare/types.js"

// ============================================================================
// A resource that records its own life: `open` connections right now, and how
// many were ever acquired / released. It stands in for a database pool.
// ============================================================================

const life = { acquired: 0, released: 0, open: 0, log: new Array<string>() }
const reset = () => {
  life.acquired = 0
  life.released = 0
  life.open = 0
  life.log.length = 0
}

class Pool extends Context.Service<Pool, {
  readonly query: (sql: string) => Effect.Effect<void>
}>()("@test/Pool") {}

const PoolLive = Layer.effect(
  Pool,
  Effect.acquireRelease(
    Effect.sync(() => {
      life.acquired++
      life.open++
      life.log.push("acquire")
      return { query: (sql: string) => Effect.sync(() => { life.log.push(`query ${sql}`) }) }
    }),
    () => Effect.sync(() => {
      life.released++
      life.open--
      life.log.push("release")
    }),
  ),
)

/** A second service built on the pool, so one hook's graph names the pool twice. */
class Reports extends Context.Service<Reports, {
  readonly write: (line: string) => Effect.Effect<void>
}>()("@test/Reports") {}

const ReportsLive = Layer.effect(Reports, Effect.gen(function* () {
  const pool = yield* Pool
  return { write: (line: string) => pool.query(`insert ${line}`) }
})).pipe(Layer.provide(PoolLive))

const Job = Task.make("job", {
  state: Schema.Struct({ runs: Schema.Number }),
  event: Schema.Struct({ _tag: Schema.Literals(["Run", "Fail", "Purge"]) }),
})
const registry = TaskRegistry.make(Job)

/** One query per run; `Fail` fails after it, `Purge` purges after it. */
const work = registry.for("job").onEvent((ctx, event) =>
  Effect.gen(function* () {
    const pool = yield* Pool
    yield* pool.query(event._tag)
    if (event._tag === "Fail") return yield* Effect.fail("boom")
    if (event._tag === "Purge") return yield* ctx.purge()
    const state = yield* ctx.recall()
    yield* ctx.save({ runs: (state?.runs ?? 0) + 1 })
  }),
)

const alarmWork = registry.for("job").onAlarm(() =>
  Effect.gen(function* () {
    const pool = yield* Pool
    yield* pool.query("alarm")
  }),
)

// ============================================================================
// Tests
// ============================================================================

describe("layer lifetime: instance (the default)", () => {
  it("builds once per instance, reuses it, and never releases it", async () => {
    reset()
    const runtime = makeInMemoryRuntime(registry.build({
      job: registry.handler("job", {
        onEvent: { handler: work, provide: PoolLive },
        onAlarm: { handler: alarmWork, provide: PoolLive },
      }),
    }))
    await Effect.runPromise(runtime.task("job").send("a", { _tag: "Run" }))
    await Effect.runPromise(runtime.task("job").send("a", { _tag: "Run" }))
    await Effect.runPromise(runtime.task("job").fireAlarm("a"))
    expect(life).toMatchObject({ acquired: 1, released: 0, open: 1 })
  })
})

describe("layer lifetime: invocation", () => {
  const perInvocation = () => makeInMemoryRuntime(registry.build({
    job: registry.handler("job", {
      onEvent: { handler: work, provide: PoolLive, lifetime: "invocation" },
      onAlarm: { handler: alarmWork, provide: PoolLive, lifetime: "invocation" },
    }),
  }))

  it("builds for each run of the hook and releases when it ends", async () => {
    reset()
    const runtime = perInvocation()
    await Effect.runPromise(runtime.task("job").send("a", { _tag: "Run" }))
    // Released by the time the send resolves: nothing is left open.
    expect(life).toMatchObject({ acquired: 1, released: 1, open: 0 })
    await Effect.runPromise(runtime.task("job").send("a", { _tag: "Run" }))
    await Effect.runPromise(runtime.task("job").fireAlarm("a"))
    expect(life).toMatchObject({ acquired: 3, released: 3, open: 0 })
    expect(life.log).toEqual([
      "acquire", "query Run", "release",
      "acquire", "query Run", "release",
      "acquire", "query alarm", "release",
    ])
    // The task's own state is untouched by the layer's lifetime.
    expect(await Effect.runPromise(runtime.task("job").getState("a"))).toEqual({ runs: 2 })
  })

  it("releases when the handler fails", async () => {
    reset()
    const runtime = perInvocation()
    const exit = await Effect.runPromiseExit(runtime.task("job").send("a", { _tag: "Fail" }))
    expect(exit._tag).toBe("Failure")
    expect(life).toMatchObject({ acquired: 1, released: 1, open: 0 })
  })

  it("releases when the handler purges, after the purge's cleanup", async () => {
    reset()
    const runtime = perInvocation()
    await Effect.runPromise(runtime.task("job").send("a", { _tag: "Run" }))
    await Effect.runPromise(runtime.task("job").send("a", { _tag: "Purge" }))
    expect(life).toMatchObject({ acquired: 2, released: 2, open: 0 })
    expect(await Effect.runPromise(runtime.task("job").getState("a"))).toBeNull()
  })

  it("releases when the hook is interrupted", async () => {
    reset()
    const runtime = makeInMemoryRuntime(registry.build({
      job: registry.handler("job", {
        onEvent: {
          handler: () => Effect.gen(function* () {
            yield* Pool
            return yield* Effect.never
          }),
          provide: PoolLive,
          lifetime: "invocation",
        },
        onAlarm: () => Effect.void,
      }),
    }))
    const exit = await Effect.runPromiseExit(
      runtime.task("job").send("a", { _tag: "Run" }).pipe(Effect.timeout("20 millis")),
    )
    expect(exit._tag).toBe("Failure")
    expect(life).toMatchObject({ acquired: 1, released: 1, open: 0 })
  })

  it("builds a layer named twice in one hook's graph once per invocation", async () => {
    reset()
    const runtime = makeInMemoryRuntime(registry.build({
      job: registry.handler("job", {
        onEvent: {
          handler: () => Effect.gen(function* () {
            const pool = yield* Pool
            const reports = yield* Reports
            yield* pool.query("direct")
            yield* reports.write("row")
          }),
          provide: Layer.mergeAll(PoolLive, ReportsLive),
          lifetime: "invocation",
        },
        onAlarm: () => Effect.void,
      }),
    }))
    await Effect.runPromise(runtime.task("job").send("a", { _tag: "Run" }))
    expect(life.log).toEqual(["acquire", "query direct", "query insert row", "release"])
  })

  it("never shares with an instance-lifetime hook of the same task", async () => {
    reset()
    const runtime = makeInMemoryRuntime(registry.build({
      job: registry.handler("job", {
        onEvent: { handler: work, provide: PoolLive }, // instance
        onAlarm: { handler: alarmWork, provide: PoolLive, lifetime: "invocation" },
      }),
    }))
    await Effect.runPromise(runtime.task("job").send("a", { _tag: "Run" }))
    expect(life).toMatchObject({ acquired: 1, released: 0, open: 1 })
    // The alarm gets a pool of its own and closes only that one.
    await Effect.runPromise(runtime.task("job").fireAlarm("a"))
    expect(life).toMatchObject({ acquired: 2, released: 1, open: 1 })
    // The event hook's pool is still the one it built first.
    await Effect.runPromise(runtime.task("job").send("a", { _tag: "Run" }))
    expect(life).toMatchObject({ acquired: 2, released: 1, open: 1 })
  })
})

describe("layer lifetime: the runtime's default", () => {
  it("applies to every hook that names none, and a hook's own lifetime wins", async () => {
    reset()
    const runtime = makeInMemoryRuntime(
      registry.build({
        job: registry.handler("job", {
          onEvent: { handler: work, provide: PoolLive }, // takes the runtime's
          onAlarm: { handler: alarmWork, provide: PoolLive, lifetime: "instance" },
        }),
      }),
      { layerLifetime: "invocation" },
    )
    await Effect.runPromise(runtime.task("job").send("a", { _tag: "Run" }))
    await Effect.runPromise(runtime.task("job").send("a", { _tag: "Run" }))
    expect(life).toMatchObject({ acquired: 2, released: 2, open: 0 })
    await Effect.runPromise(runtime.task("job").fireAlarm("a"))
    await Effect.runPromise(runtime.task("job").fireAlarm("a"))
    expect(life).toMatchObject({ acquired: 3, released: 2, open: 1 })
  })

  it("reaches hooks wrapped by withServices", async () => {
    reset()
    const runtime = makeInMemoryRuntime(
      registry.build({
        job: registry.handler("job", withServices({ onEvent: work, onAlarm: alarmWork }, PoolLive)),
      }),
      { layerLifetime: "invocation" },
    )
    await Effect.runPromise(runtime.task("job").send("a", { _tag: "Run" }))
    await Effect.runPromise(runtime.task("job").fireAlarm("a"))
    expect(life).toMatchObject({ acquired: 2, released: 2, open: 0 })
  })
})

describe("layer lifetime: the Cloudflare adapter", () => {
  function mockDOState(): DurableObjectStateLike {
    const data = new Map<string, unknown>()
    let alarm: number | null = null
    function get(key: string): Promise<unknown>
    function get(keys: string[]): Promise<Map<string, unknown>>
    function get(keyOrKeys: string | string[]): Promise<unknown> | Promise<Map<string, unknown>> {
      if (typeof keyOrKeys === "string") return Promise.resolve(data.get(keyOrKeys))
      return Promise.resolve(new Map(keyOrKeys.map((key) => [key, data.get(key)])))
    }
    function put(key: string, value: unknown): Promise<void>
    function put(entries: Record<string, unknown>): Promise<void>
    function put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
      if (typeof keyOrEntries === "string") data.set(keyOrEntries, value)
      else for (const [key, entry] of Object.entries(keyOrEntries)) data.set(key, entry)
      return Promise.resolve()
    }
    return {
      id: { toString: () => "mock" },
      storage: {
        get,
        put,
        delete: (key) => Promise.resolve(data.delete(key)),
        deleteAll: () => { data.clear(); return Promise.resolve() },
        setAlarm: (ts) => { alarm = typeof ts === "number" ? ts : ts.getTime(); return Promise.resolve() },
        deleteAlarm: () => { alarm = null; return Promise.resolve() },
        getAlarm: () => Promise.resolve(alarm),
      },
    }
  }

  const built = registry.build({
    job: registry.handler("job", {
      onEvent: { handler: work, provide: PoolLive },
      onAlarm: { handler: alarmWork, provide: PoolLive },
    }),
  })

  it("keeps the pool open across invocations by default", async () => {
    reset()
    const group = makeTaskGroupDO(built)
    const instance = new group.DO(mockDOState(), {})
    await instance.handleEvent("job", "a", { _tag: "Run" })
    await instance.alarm()
    expect(life).toMatchObject({ acquired: 1, released: 0, open: 1 })
  })

  it("with layerLifetime invocation, nothing is open once an event or alarm returns", async () => {
    reset()
    const group = makeTaskGroupDO(built, { layerLifetime: "invocation" })
    const instance = new group.DO(mockDOState(), {})
    await instance.handleEvent("job", "a", { _tag: "Run" })
    expect(life).toMatchObject({ acquired: 1, released: 1, open: 0 })
    await instance.alarm()
    expect(life).toMatchObject({ acquired: 2, released: 2, open: 0 })
  })
})

// ── Compile-time: a lifetime is one of the two names ─────────────────────────

registry.handler("job", {
  // @ts-expect-error — "request" is not a LayerLifetime
  onEvent: { handler: work, provide: PoolLive, lifetime: "request" },
  onAlarm: { handler: alarmWork, provide: PoolLive },
})

// @ts-expect-error — nor is it one at the runtime
makeInMemoryRuntime(registry.build({ job: registry.handler("job", { onEvent: () => Effect.void, onAlarm: () => Effect.void }) }), { layerLifetime: "request" })
