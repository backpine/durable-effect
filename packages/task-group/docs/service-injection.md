# Service injection: the old Cloudflare model vs. the new model

`@durable-effect/task` handlers are Effect programs, so they get their
dependencies (databases, API clients, config) as Effect **services** provided by
**layers**. This doc explains the original Cloudflare-specific injection helper,
why it fell short, and the new model that replaced it.

> **Removed in 0.0.18.** `cloudflareServices` / `withCloudflareServices` and the
> `CloudflareEnv` service no longer exist — use the new model below. `withServices`
> (attach one layer to both channels) is **not** removed; it's still the concise
> choice when both hooks need the same layer. The migration is small and mechanical.

---

## The old model — `cloudflareServices` / `withCloudflareServices` (removed)

Cloudflare Workers forbid async I/O (`fetch`, `connect`), timers, and RNG in
global (module) scope. A layer that opens a DB pool at module scope crashes the
deploy. The old helper worked around this by **deferring** layer construction to
the Durable Object constructor, where `env` is available:

```typescript
// services/cloudflare.ts — capture the Env type once
import { cloudflareServices } from "@durable-effect/task/cloudflare"
export const withCloudflareServices = cloudflareServices<Env>()

// tasks/handlers/order.ts
export const orderHandler = registry.handler("order",
  withCloudflareServices(
    {
      onEvent: (ctx, event) => Effect.gen(function* () {
        const db = yield* Database
        // ...
      }),
      onAlarm: (ctx) => Effect.gen(function* () {
        const db = yield* Database
        // ...
      }),
    },
    // stored, not called at module scope — runs in the DO constructor
    (env) => makeDbLayer(env.HYPERDRIVE.connectionString),
  ),
)
```

The runtime provides a `CloudflareEnv` service (typed `unknown`), and the factory
`(env) => Layer` reads it.

### Where it fell short

1. **One layer for both hooks.** `withCloudflareServices` hands the *same* layer
   to `onEvent` and `onAlarm`. If `onEvent` is a lightweight notification that only
   logs, but `onAlarm` needs Postgres + an API client, then **every event still
   builds the full Postgres + API graph** just to run `ctx.save`, then throws it
   away. The only escape was reaching past the public API into `wrapEventDef` /
   `wrapAlarmDef` by hand.

2. **No memoization.** The deferred layer was provided with `Effect.provide` on
   every invocation, and Effect memoizes layers per build scope — so the layer
   (and any pool inside it) was **rebuilt on every event and every alarm**.

3. **Untyped env + a cast.** `CloudflareEnv` stores `unknown`; the factory did
   `makeLayer(env as Env)`. Type safety was a convention, not enforced.

Root cause: user services lived in a single registry-level requirement shared
across both hooks, provided eagerly per call.

---

## The new model — typed env + per-hook `provide`

Two changes fix all three problems:

- **A typed platform-env service.** You declare it once; layers read it with
  `yield* AppEnv` (fully typed — no cast).
- **Per-hook `provide`.** Each hook attaches its own service layer. Layers build
  **once per instance** through a shared `MemoMap` + long-lived `Scope` (both
  created synchronously in the DO constructor — legal under CF's global-scope
  rules). A hook only builds the services it actually uses, when it first runs.

```typescript
// env.ts — declared once; Env is your wrangler-generated type
import { Context } from "effect"
export class AppEnv extends Context.Service<AppEnv, Env>()("@app/Env") {}

// services.ts — platform-agnostic; env-dependent layers read the TYPED env
export const DbLive = Layer.effect(Database, Effect.gen(function* () {
  const env = yield* AppEnv            // typed as Env, no cast
  return makePool(env.HYPERDRIVE.connectionString)
}))

// tasks/handlers/order.ts — provide per hook
export const orderHandler = registry.handler("order", {
  onEvent: {
    handler: (ctx, event) => Effect.gen(function* () {
      const db = yield* Database
      // ...
    }),
    provide: DbLive,                   // events build the pool (once per instance)
  },
  onAlarm: (ctx) => Effect.void,       // needs nothing → never builds the pool
})

// tasks/index.ts — bridge the env ONCE, at the runtime
const config = registry.build({ order: orderHandler /* , ... */ })
const taskGroup = makeTaskGroupDO(config, { env: AppEnv })
export const OrdersDO = taskGroup.DO
export const orders = taskGroup.client(env.ORDERS_DO)
```

For local dev / tests, provide a mock env to the in-memory runtime:

```typescript
export const orders = makeInMemoryRuntime(config, {
  services: Layer.succeed(AppEnv, { HYPERDRIVE: { connectionString: "postgres://test" } } as Env),
})
```

To provide several services to one hook, merge them:
`provide: Layer.mergeAll(DbLive, ApiLive)`.

---

## Side by side

| Concern | Old (`cloudflareServices`) | New (typed env + `provide`) |
|---|---|---|
| Services per hook | one layer for **both** hooks | each hook `provide`s its own |
| Light `onEvent` next to heavy `onAlarm` | event builds the heavy graph too | event builds only what it uses |
| Layer/pool lifetime | rebuilt every invocation | built **once per instance** (MemoMap) |
| Env typing | `CloudflareEnv` = `unknown` + `env as Env` | typed `AppEnv`, no cast in your code |
| Env → service wiring | per handler (`(env) => layer`) | once, at `makeTaskGroupDO(config, { env })` |
| Platform coupling | Cloudflare-specific helper | plain layers + one context service |
| Compile-time safety | layer must cover the shared `R` | residual `R` = env; unmet service is a type error |

The single unavoidable coercion (Cloudflare hands `env` untyped) now lives inside
the adapter, not your code.

---

## Migration steps

1. **Declare the env service.** Replace the `cloudflareServices<Env>()` helper file
   with:
   ```typescript
   export class AppEnv extends Context.Service<AppEnv, Env>()("@app/Env") {}
   ```

2. **Make env-dependent layers read `AppEnv`.** Change
   `const makeDbLayer = (env: Env) => Layer.succeed(Db, ...)` into a layer that
   `yield* AppEnv`:
   ```typescript
   export const DbLive = Layer.effect(Db, Effect.gen(function* () {
     const env = yield* AppEnv
     return /* ...build from env... */
   }))
   ```

3. **Replace `withCloudflareServices(config, (env) => layer)` with per-hook
   `provide`.** Move each service onto the hook that uses it. If `onAlarm` didn't
   actually use the service, drop it there — that's the point.
   ```typescript
   registry.handler("order", {
     onEvent: { handler: onEvent, onError, provide: DbLive },
     onAlarm: { handler: onAlarm, onError },   // no provide
   })
   ```

4. **Pass the env at the runtime.** Add `{ env: AppEnv }` to `makeTaskGroupDO`, and
   change the dev/test runtime from
   `makeInMemoryRuntime(config, { services: Layer.succeed(CloudflareEnv)(mock) })`
   to `makeInMemoryRuntime(config, { services: Layer.succeed(AppEnv, mock as Env) })`.

5. **Delete the `cloudflareServices` helper import.** Done.

If both channels genuinely need the same layer, `withServices(config, layer)`
remains the concise choice — and it now benefits from per-instance memoization too.

See `examples/effect-worker-api` for a worked migration (`tasks/billing/handlers/invoice.ts`
went from `withCloudflareServices` to per-hook `provide`), and
`designs/effect-native-services.md` for the full design and mechanics.
