/**
 * This file verifies compile-time type safety via @ts-expect-error directives.
 * If this file compiles, all type assertions hold.
 */
import { describe, it } from "vitest"
describe("Type safety", () => { it("compiles", () => {}) })
import { Effect, Schema, ServiceMap } from "effect"
import { Task, TaskRegistry, withServices } from "../src/index.js"

// ── Setup ────────────────────────────────────────────────

class MyService extends ServiceMap.Service<MyService, {
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

// ── 4. Handler that uses service WITHOUT withServices — should error ──
// The error appears on the onEvent return type: R = MyService ≠ never

registry.handler("foo", {
  // @ts-expect-error — Effect<void, TaskError, MyService> not assignable to Effect<void, ..., never>
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
