/**
 * This file verifies compile-time type safety via @ts-expect-error directives.
 * If this file compiles, all type assertions hold.
 */
import { describe, it, expectTypeOf } from "vitest"
describe("Type safety", () => { it("compiles", () => {}) })
import { Effect, Layer, Schema, Context } from "effect"
import { Task, TaskRegistry, withServices, makeInMemoryRuntime, makeTaskGroupDO, type TaskExecutionError } from "../src/index.js"

// ── Setup ────────────────────────────────────────────────

class MyService extends Context.Service<MyService, {
  readonly doWork: () => Effect.Effect<string>
}>()("@test/MyService") {}

const Foo = Task.make("foo", {
  state: Schema.Struct({ value: Schema.String }),
  event: Schema.Struct({ _tag: Schema.Literal("Go") }),
})

const Bar = Task.make("bar", {
  state: Schema.Struct({ count: Schema.Number }),
  event: Schema.Struct({ _tag: Schema.Literal("Inc"), n: Schema.Number }),
})

const registry = TaskRegistry.make(Foo, Bar)

// ── 1. Handler WITHOUT services — R = never — compiles fine ──

registry.handler("foo", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      // ctx.recall() returns { value: string } | null — correctly typed
      const state = yield* ctx.recall()
      yield* ctx.save({ value: "ok" })
    }),
  onAlarm: (ctx) => Effect.void,
})

// ── 2. Handler WITH services via withServices — compiles fine ──

// registry.handler("foo",
//   withServices({
//     onEvent: (ctx, event) =>
//       Effect.gen(function* () {
//         const svc = yield* MyService  // R = MyService
//         yield* ctx.save({ value: yield* svc.doWork() })
//       }),
//     onAlarm: (ctx) => Effect.void,
//   }, Layer.succeed(MyService, { doWork: () => Effect.succeed("done") })),
// )

// ── 3. Sibling access is typed ──

registry.handler("foo", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      // ✅ ctx.task(Bar) returns SiblingHandle<{ _tag: "Inc", n: number }>
      yield* ctx.task(Bar).send("b1", { _tag: "Inc", n: 5 })

      // @ts-expect-error — wrong event shape for Bar
      yield* ctx.task(Bar).send("b1", { _tag: "Wrong" })
    }),
  onAlarm: (ctx) => Effect.void,
})

// ── 4. Handler that uses a service WITHOUT provide — now allowed ──
// R flows through the handler and must be resolved at the runtime level
// (makeInMemoryRuntime's `services` or makeTaskGroupDO's `env`), or by
// attaching a per-hook `provide` layer.

registry.handler("foo", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      const svc = yield* MyService
      yield* ctx.save({ value: yield* svc.doWork() })
    }),
  onAlarm: (ctx) => Effect.void,
})

// ── 5. build() requires ALL tasks ──

const fooHandler = registry.handler("foo", {
  onEvent: (ctx, event) => Effect.void,
  onAlarm: (ctx) => Effect.void,
})

const barHandler = registry.handler("bar", {
  onEvent: (ctx, event) => Effect.void,
  onAlarm: (ctx) => Effect.void,
})

// ✅ compiles — all tasks provided
registry.build({ foo: fooHandler, bar: barHandler })

// These assertions would crash at runtime, so guard them behind a type-only check.
// The @ts-expect-error proves TypeScript rejects them.
function _buildAssertions(_fh: typeof fooHandler, _bh: typeof barHandler) {
  // @ts-expect-error — missing "bar"
  registry.build({ foo: _fh })

  // @ts-expect-error — fooHandler has _name: "foo", not "bar"
  registry.build({ foo: _bh, bar: _fh })
}

// ── 7. Wrong state shape in save ──

registry.handler("foo", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      // @ts-expect-error — state must be { value: string }, not { value: number }
      yield* ctx.save({ value: 123 })
    }),
  onAlarm: (ctx) => Effect.void,
})

// Runtime factories must resolve every remaining service requirement.
function _runtimeAssertions() {
  const needsService = registry.handler("foo", {
    onEvent: () => Effect.asVoid(MyService),
    onAlarm: () => Effect.void,
  })
  const built = registry.build({ foo: needsService, bar: barHandler })

  // @ts-expect-error — missing residual service
  makeInMemoryRuntime(built)
  // @ts-expect-error — an empty layer cannot provide MyService
  makeInMemoryRuntime(built, { services: Layer.empty })
  // @ts-expect-error — an env-dependent DO needs its env service key
  makeTaskGroupDO(built)

  class WrongEnv extends Context.Service<WrongEnv, { readonly token: string }>()("@test/WrongEnv") {}
  // @ts-expect-error — a different env key cannot satisfy MyService
  makeTaskGroupDO(built, { env: WrongEnv })

  const pure = registry.build({ foo: fooHandler, bar: barHandler })
  const runtime = makeInMemoryRuntime(pure)
  // @ts-expect-error — unknown task name
  runtime.task("missing")
  // @ts-expect-error — wrong event for the selected task
  runtime.task("bar").send("b1", { _tag: "Go" })
  expectTypeOf(runtime.task("foo").getState("f1")).toEqualTypeOf<
    Effect.Effect<{ readonly value: string } | null, TaskExecutionError>
  >()

  registry.handler("foo", {
    onEvent: (ctx) => Effect.gen(function* () {
      expectTypeOf(yield* ctx.task("bar").getState("b1"))
        .toEqualTypeOf<{ readonly count: number } | null>()
      expectTypeOf(yield* ctx.task(Bar).getState("b1"))
        .toEqualTypeOf<{ readonly count: number } | null>()
      // @ts-expect-error — a sibling's state remains typed
      const wrong: string = (yield* ctx.task("bar").getState("b1"))?.count
    }),
    onAlarm: () => Effect.void,
  })
}
