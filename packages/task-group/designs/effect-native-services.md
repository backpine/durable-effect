# Design: Effect-Native Service Provision (per-hook, memoized, platform-agnostic)

**Status:** Prototype proven (typecheck-clean, tests green). Awaiting review before
production implementation.

Supersedes the service-provision parts of `deferred-services.md`. Keeps that doc's
goals; changes the mechanism to be per-hook and genuinely memoized.

---

## TL;DR

Today one layer is provided to **both** `onEvent` and `onAlarm`, and it is rebuilt
on **every** invocation. So a lightweight notification `onEvent` builds the full
Postgres + Google + AI graph just to call `ctx.save`, then throws it away.

The new design lets **each hook declare its own services** and builds them **once
per instance** through a shared Effect `MemoMap`. A light event never builds the
heavy graph; a DB pool opened by the first alarm is reused by every later alarm.
The platform env becomes a **typed** service (no more `unknown` + cast). The core
stays platform-agnostic — Cloudflare is just one adapter.

Proven in `test/prototype.test.ts` and `test/integration-prototype.test.ts`
(6/6 green, `tsc --strict` clean, zero type casts).

---

## The problem (today)

```ts
// cloudflareServices<Env>()(config, (env) => layer)
withCloudflareServices(
  { onEvent, onAlarm },
  (env) => Layer.mergeAll(PgLive, GoogleLive, AiLive).pipe(Layer.provide(cfg(env))),
)
```

1. **One layer for both hooks.** `onEvent` and `onAlarm` share a single `R`
   (`HandlerConfig<…, R, …>`), so they share a single provided layer. A logger-only
   `onEvent` still gets handed Postgres + Google + AI. The only current workaround is
   to reach past the public API into `wrapEventDef` / `wrapAlarmDef` by hand.

2. **No memoization.** Both the DO and the in-memory runtime do
   `Effect.runPromise(Effect.provide(effect, layer))` per call. Effect memoizes layers
   *per build scope*, and every `runPromise` is a fresh scope — so the layer (and any
   DB pool inside it) is **rebuilt on every event and every alarm**. `deferred-services.md`
   flagged this and proposed `ManagedRuntime`, but the shipped code never adopted it.

3. **Untyped env + a cast.** `CloudflareEnv` stores `unknown`; every factory does
   `makeLayer(env as Env)`. The type safety is a convention, not enforced.

Root cause: **user services live in the registry-level `R`, and `R` is a single
type shared across hooks.** Fix the shape and all three problems dissolve.

---

## Core idea

> A hook = an **effect** (requirements `R_hook`) **paired with the layer** that
> satisfies it. The registry erases `R_hook` by building that layer through a
> **per-instance `MemoMap`**, leaving only the **platform env** as the residual
> requirement. The adapter provides the env; the `MemoMap` makes builds lazy
> (per hook) and shared (once per instance).

Only the platform env ever appears in the registry-level `R`. User services never
do — they are resolved per hook, on demand, and cached.

Two Effect v4 primitives make this clean and CF-safe (both are **synchronous** —
verified to do no I/O, timers, or RNG, so they are legal in a DO constructor and at
module scope):

- `Layer.makeMemoMapUnsafe()` → a `MemoMap` (`() => new MemoMapImpl()`)
- `Scope.makeUnsafe()` → a long-lived `Closeable` scope

Plus `Layer.buildWithMemoMap(layer, memoMap, scope)` to build a layer once and reuse it.

---

## High-level DX (what you write)

### 1. Declare the platform env once — typed, no cast

```ts
// env.ts
import { Context } from "effect"
import type { Env } from "./worker-configuration" // wrangler-generated

export class AppEnv extends Context.Service<AppEnv, Env>()("@app/Env") {}
```

(We can ship a one-liner helper `defineEnv<Env>("@app/Env")` that returns this class,
but it is just sugar over the line above.)

### 2. Write service layers once — platform-agnostic

Env-dependent layers just `yield* AppEnv`. It is typed as your real `Env`. No cast.

```ts
// services.ts
export const LoggerLive = Layer.succeed(Logger, { info: (m) => Console.log(m) })

export const DbLive = Layer.effect(Database, Effect.gen(function* () {
  const env = yield* AppEnv                       // <- typed Env, no `as`
  return makePool(env.HYPERDRIVE.connectionString)
}))

export const GoogleLive = Layer.effect(Google, Effect.gen(function* () {
  const env = yield* AppEnv
  return makeGoogle(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)
}))
```

These same layers run unchanged on Cloudflare, Node, and in tests. Only *who
provides `AppEnv`* differs.

### 3. Provide services **per hook**

```ts
export const notification = registry.handler("notification", {
  onEvent: {
    handler: (ctx, event) =>
      Effect.gen(function* () {
        const logger = yield* Logger
        yield* logger.info(`notify ${event.id}`)
        yield* ctx.save(event)
      }),
    provide: LoggerLive,               // events only ever build the logger
  },
  onAlarm: {
    handler: (ctx) =>
      Effect.gen(function* () {
        const db = yield* Database
        const google = yield* Google
        // …heavy work…
      }),
    provide: [DbLive, GoogleLive],     // heavy graph builds only when an alarm runs
  },
})
```

- `provide` accepts a `Layer` or an array (auto-merged).
- The remaining `onError` co-location is unchanged — `onError` shares its hook's
  `provide`.
- If a handler uses a service its `provide` doesn't cover, **it fails to compile**
  (the residual leaks that service, and the runtime boundary only satisfies `AppEnv`).
  This is the "typecheck is the proof" property, now a first-class API instead of a
  hand-wired `wrapEventDef`.

**Still want to wrap the whole task?** Keep `withServices(config, layer)` — it stays
as sugar that attaches `layer` to every hook. Coarse when you want it, fine-grained
when you don't.

### 4. Wire it once — the adapter provides `AppEnv`

```ts
// The env→service bridge is specified ONCE here, not per handler.
const group = makeTaskGroupDO(registry.build({ notification }), { env: AppEnv })
export const NotificationDO = group.DO
export const notifications = group.client(env.NOTIFICATION_DO)
```

`{ env: AppEnv }` tells the adapter which service to populate from the DO's `env`.
The single unavoidable `unknown → Env` coercion (Cloudflare hands `env` untyped)
lives **inside the adapter**, localized and documented — never in your code.

### 5. Test — provide a mock env, exercise the real layers

```ts
const runtime = makeInMemoryRuntime(registry.build({ notification }), {
  env: Context.make(AppEnv, { HYPERDRIVE: { connectionString: "pg://test" }, /* … */ }),
})
```

Same per-hook layers run; they read the mock env. No Cloudflare mocks required.

### Before / after

| | Before | After |
|---|---|---|
| Services per hook | one layer for both | `provide:` per hook |
| Light `onEvent` | builds full heavy graph | builds only what it uses |
| DB pool lifetime | rebuilt every call | built once per instance |
| Env typing | `unknown` + `env as Env` | typed `AppEnv`, no cast |
| Env→service wiring | per handler | once, at the adapter |

---

## Lower-level mechanics (what the library does)

### Per-instance runtime

Each task instance (one DO, or one in-memory instance) holds, created **synchronously**:

```ts
const memoMap = Layer.makeMemoMapUnsafe()   // shared build cache
const scope   = Scope.makeUnsafe()          // long-lived; resources persist
const envContext = Context.make(AppEnv, env as Env)  // the one boundary coercion
```

### Binding a hook (the crux)

```ts
function provideHook<A, E, RHook, RProvided, RLayerIn>(
  effect: Effect.Effect<A, E, RHook>,
  layer: Layer.Layer<RProvided, never, RLayerIn>,
  rt: { memoMap: Layer.MemoMap; scope: Scope.Scope },
): Effect.Effect<A, E, Exclude<RHook, RProvided> | RLayerIn> {
  return Layer.buildWithMemoMap(layer, rt.memoMap, rt.scope).pipe(
    Effect.flatMap((ctx) => Effect.provide(effect, ctx)),
  )
}
```

- `buildWithMemoMap` builds `layer` the first time and returns the cached `Context`
  on every later call for the same instance → **memoized**, and only when the hook
  actually runs → **lazy**.
- `Effect.provide(effect, ctx)` computes the residual as `Exclude<RHook, RProvided>`.
  When the layer fully covers the hook that collapses to `RLayerIn` (the env). When
  it doesn't, the missing service **leaks into the residual** and the typed runtime
  boundary rejects it. This is the compile-time guarantee, and it is real: Effect v4
  types `Effect<out A, out E, out R>` — `R` is covariant, so a residual the runtime
  can't satisfy is a hard error (verified).

### Type changes to the package (non-breaking)

- `HandlerConfig` hook object gains `provide?: Layer | Layer[]`, with **independent**
  per-hook requirement type params (today they are forced equal).
- `RegisteredTask<Renv>` where `Renv` is the **platform env**, not the user-service
  union. Its methods take the per-instance `{ memoMap, scope }` (or receive it via an
  internal service — implementation choice; the prototype threads it as a param).
- `registry.build()` unifies every hook's residual into one `Renv` — exactly the
  existing `build<R>({ [K]: TaskHandler<K, R> })` shape, so inference is unchanged.
- `makeTaskGroupDO` / `makeInMemoryRuntime` gain `{ env }` and own the per-instance
  `memoMap` + `scope`.
- **Backward compat:** every new type param defaults such that existing
  `withServices` handlers resolve to `Renv = never` and compile untouched.
  `cloudflareServices` / `CloudflareEnv` remain (deprecated) as thin shims.

### Sibling dispatch

Sibling dispatch runs the sibling's `handleEvent` with the **sibling instance's own**
`memoMap` + `scope`, so a sibling's services build and memoize under its own instance
— proven in `integration-prototype.test.ts` (a light `notification` event dispatches
to a heavy `report` sibling; the notification builds only the logger, the report
builds db+slack once).

### Platform-agnostic story

The core deals only in `Storage`/`Alarm` services (already abstracted), user `Layer`s,
and one env context service. A new platform adapter supplies (a) `Storage`/`Alarm`
impls, (b) the env value, (c) a per-instance `memoMap`+`scope` and a run loop. Nothing
in the core is Cloudflare-specific. Node / Lambda / Deno follow the same three steps.

---

## What the prototype proves

`packages/task-group/test/prototype.test.ts` (mechanism) and
`test/integration-prototype.test.ts` (registry + sibling dispatch + onError):

- ✅ Per-hook laziness — 3 events build only the logger; db/google stay at 0.
- ✅ Per-instance memoization — 2 alarms build db+google **once each**.
- ✅ Instance isolation — 2 instances → pool builds once per instance.
- ✅ Sibling dispatch builds/memoizes the sibling's services.
- ✅ Typed env, **zero casts** in user code.
- ✅ Compile-time rejection of an under-providing hook (`@ts-expect-error` fires).
- ✅ `tsc --strict` clean; 6/6 tests green against real `effect@4.0.0-beta.94`.

---

## Path forward (phased, each independently shippable)

1. **Core types (non-breaking).** Add independent per-hook requirement params +
   `provide?` to `HandlerConfig`; add the `provideHook` builder; re-parameterize
   `RegisteredTask` to residual-env. Existing `withServices` handlers keep compiling
   (`Renv = never`).
2. **Runtimes.** Give `makeInMemoryRuntime` and `makeTaskGroupDO` a per-instance
   `memoMap` + `scope` and an `{ env }` option. Migrate the existing per-call
   `Effect.provide` path onto it (this alone fixes the no-memoization bug for
   `withServices` too).
3. **Typed env.** Ship `AppEnv`/`defineEnv<Env>()`; deprecate the `unknown`-typed
   `CloudflareEnv` + `cloudflareServices` (keep as shims for one release).
4. **Docs + codemod note.** Update README; show the `withCloudflareServices(cfg, env=>layer)`
   → per-hook `provide` migration (the `googleReviewBatch`-style handler is the
   canonical example).

---

## Open questions / risks

- **Scope disposal on Cloudflare.** DOs have no shutdown hook, so the per-instance
  scope's finalizers (e.g. closing a pool) run only on isolate eviction. Same
  trade-off `deferred-services.md` accepted. In-memory/tests can `dispose()` cleanly.
- **Threading `{memoMap,scope}`.** The prototype passes it as a param to
  `RegisteredTask` methods. Alternative: expose it via internal Effect services so the
  method signatures don't change. Param-threading is simpler; decide during impl.
- **`provide` ergonomics for the "wrap everything" case.** `withServices` covers it;
  we may also allow a handler-level `provide` merged into every hook. Minor.

## Unrelated pre-existing issue (flagging, not in scope)

`test/alarm.test.ts > schedules an alarm that fires on tick` **fails on `main`**
(deterministic, 3/3) — after an event schedules via `ctx.scheduleIn("5000 millis")`,
`tick()` doesn't fire it. Looks like fallout from the effect-v4 beta upgrade
(`Duration` string parsing or the in-memory `tick` compare), independent of this
redesign. Worth a separate look.
