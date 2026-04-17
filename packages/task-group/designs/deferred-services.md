# Design: Deferred Service Provision (Platform-Aware Layers)

## Problem

The current `withServices(config, layer)` pattern requires Effect layers to be
constructed at **module scope** (JavaScript global scope). On Cloudflare Workers,
global scope is restricted: async I/O (`fetch`, `connect`), timers (`setTimeout`),
and `crypto.getRandomValues()` are all banned. If any layer factory eagerly
performs these operations during construction, deployment fails with error 10021:

```
Uncaught Error: Disallowed operation called within global scope.
Asynchronous I/O (ex: fetch() or connect()), setting a timeout,
and generating random values are not allowed within global scope.
```

The task-group package and Effect itself are clean (no I/O at construction time),
but the **pattern the API encourages** creates a pit of failure: user-space layer
factories like `makePgDrizzleLayer()` or `makeKvServiceLayer()` may eagerly
establish connections or generate IDs during construction. The current API has no
mechanism to defer layer construction to a safe execution scope.

### Why `Layer.lazy` is insufficient

`Layer.lazy(() => makeLayer())` defers construction, but Effect layers are
memoized **per runtime scope**. Each `Effect.runPromise()` call in the current DO
creates a fresh scope, so the factory runs on **every handler invocation** — not
once per DO instance. For lightweight wrappers this is acceptable; for database
connection pools and authenticated API clients it is not.

---

## Goals

1. **Service definitions remain platform-agnostic** — the same `GbpServicesLive`,
   `PgDrizzleLive`, `R2ServiceLayer` work on Cloudflare, Node.js, and in tests.
   What changes is *when* and *how* they are provided, not the layers themselves.

2. **Platform-specific helpers handle lifecycle** — each compute platform has its
   own timing constraints and available context. Cloudflare provides `env` in the
   DO constructor. Lambda provides `context` per invocation. Node.js has no
   restrictions. The design should accommodate all without hacking the core.

3. **Backward compatible** — existing `withServices(config, layer)` continues to
   work for layers that are safe to construct at module scope. No migration is
   required for handlers that don't need deferred services.

4. **Memoized per instance** — deferred layers are built once per DO instance (or
   equivalent), not per handler call. Services like DB connection pools must be
   reused across events and alarms within the same instance.

5. **Type-safe** — the compiler enforces that all service requirements are
   resolved before effects can execute. If a handler requires `GbpClient` and the
   runtime doesn't provide it, that's a type error, not a runtime error.

---

## Design Overview

### Core Concept: Platform Context as an Effect Service

Each platform adapter defines a **context service** — a tagged value the runtime
provides automatically to all handler effects. Handlers don't depend on the
context service directly; instead, a platform-specific helper (`withCloudflareServices`,
etc.) bridges user-defined layer factories to the context service.

```
                    User code                          Platform adapter
                ┌──────────────┐                   ┌───────────────────┐
  Handler       │ onEvent(ctx) │                   │ DO constructor    │
  config        │ yield* Gbp   │ ── R = GbpClient ─▶ env available   │
                │ yield* R2    │                   │ provides CloudflareEnv
                └──────────────┘                   └───────────────────┘
                        │                                   │
              withCloudflareServices                        │
              (config, env => Layer<R>)                     │
                        │                                   │
                        ▼                                   │
                R = CloudflareEnv ◀─── provided by ─────────┘
                (deferred layer bridges
                 GbpClient|R2 ←→ CloudflareEnv)
```

The handler's original requirements (`GbpClient | R2Service`) are replaced by a
single platform requirement (`CloudflareEnv`) that the runtime knows how to
provide. The deferred layer factory `(env) => Layer<R>` is wrapped inside a
`Layer.unwrapEffect` that reads `CloudflareEnv` at execution time.

---

## API Surface

### 1. `withServices` (unchanged)

For layers that are safe to construct at module scope. No changes needed.

```typescript
import { withServices } from "@durable-effect/task-group";

// Pure layer — no I/O during construction
const LoggingLive = Layer.succeed(Logger, consoleLogger);

export const handler = registry.handler("myTask",
  withServices(config, LoggingLive),
);
```

### 2. `withCloudflareServices` (new — Cloudflare adapter)

Defers layer construction to DO instantiation time. Exported from the Cloudflare
subpath.

TypeScript does not support partial type argument inference — you can't write
`fn<Env>(config, makeLayer)` and have TS infer the other 8 generics from `config`.
You must specify all or none. The solution: **a factory that captures `Env` once
per project**, returning a fully-inferring helper function.

```typescript
// ── Setup (once per project) ─────────────────────────────────────────
// services/cloudflare.ts
import { cloudflareServices } from "@durable-effect/task-group/cloudflare";
import type { Env } from "../env";           // wrangler-generated

export const withCloudflareServices = cloudflareServices<Env>();
```

```typescript
// ── Handler (per task) ───────────────────────────────────────────────
// tasks/analytics/handler.ts
import { withCloudflareServices } from "../../services/cloudflare";

export const handler = registry.handler("analyticsCollector",
  withCloudflareServices(
    {
      onEvent: o.onEvent((ctx, event) =>
        Effect.gen(function* () {
          const gbp = yield* GbpClient;
          const r2 = yield* R2Service;
          // ... same handler code as before
        }),
      ),
      onAlarm: o.onAlarm((ctx) =>
        Effect.gen(function* () {
          // ...
        }),
      ),
    },
    // This factory is stored, NOT called at module scope.
    // It runs once in the DO constructor where env is available.
    (env) =>
      //  ^ typed as Env — full autocomplete on env.BUCKET, env.KV, etc.
      Layer.mergeAll(
        GbpServicesLive,
        makeR2ServiceLayer(env.BUCKET),
        makePgDrizzleLayer(env.HYPERDRIVE.connectionString),
      ).pipe(
        Layer.provide(makeGbpConfigLayer(env)),
        Layer.orDie,
      ),
  ),
);
```

The `Env` type is specified **once** in the project setup, not repeated at every
call site. Every handler file imports the same pre-configured helper and gets full
type safety on `env` with zero ceremony.

**Type signatures:**

```typescript
// Factory — user calls this once with their Env type
function cloudflareServices<Env>(): WithCloudflareServices<Env>

// Returned helper — full inference on config, env typed as Env
type WithCloudflareServices<Env> = <S, E, EErr, AErr, Tags, R, OEErr, OAErr>(
  config: HandlerConfig<S, E, EErr, AErr, Tags, R, OEErr, OAErr>,
  makeLayer: (env: Env) => Layer.Layer<R>,
) => HandlerConfig<S, E, EErr, AErr, Tags, CloudflareEnv, OEErr, OAErr>
```

- `cloudflareServices<Env>()` captures the user's wrangler-generated `Env` type
  and returns a helper function. This mirrors how Cloudflare's own
  `ExportedHandler<Env>` works — `Env` is a project-level type, not per-handler.
- The returned helper infers all other generics (`S`, `E`, `R`, etc.) from the
  handler config. The callback `(env) => ...` is automatically typed as
  `(env: Env) => Layer<R>`, giving full autocomplete and type checking on bindings.
- Internally, `CloudflareEnv` stores `unknown`. The cast from `unknown` to `Env`
  happens inside the deferred layer and is safe because `makeTaskGroupDO` always
  provides the real Cloudflare env from the DO constructor.

### 3. Composing eager + deferred services

`withServices` and `withCloudflareServices` compose naturally. Resolve pure
services at module scope, defer platform-dependent services:

```typescript
// Pure services — safe at module scope
const PureServicesLive = Layer.mergeAll(LoggingLive, MetricsLive);

// Step 1: resolve pure services eagerly
const partialConfig = withServices(rawConfig, PureServicesLive);
// partialConfig: R = GbpClient | R2Service | PgDrizzle
//   (Logging and Metrics are resolved, the rest remain)

// Step 2: defer the rest to Cloudflare runtime
export const handler = registry.handler("myTask",
  withCloudflareServices(partialConfig, (env) =>
    Layer.mergeAll(
      makeGbpServicesLayer(env),
      makeR2ServiceLayer(env.BUCKET),
      makePgDrizzleLayer(env.HYPERDRIVE.connectionString),
    ),
  ),
);
// handler: R = CloudflareEnv
```

### 4. `makeTaskGroupDO` changes

No new options needed. The runtime **always** provides `CloudflareEnv` from the
DO constructor's `env` parameter. Handlers with `R = never` are unaffected (the
extra provide is a no-op). Handlers with `R = CloudflareEnv` get their deferred
layers resolved automatically.

```typescript
// Usage is unchanged:
const taskGroup = makeTaskGroupDO(registryConfig);
export const MyDO = taskGroup.DO;
export const myClient = taskGroup.client(env.MY_DO);
```

### 5. `makeInMemoryRuntime` changes

For testing handlers that use `withCloudflareServices`, the in-memory runtime
needs a way to provide `CloudflareEnv`. New optional `services` parameter:

```typescript
import { CloudflareEnv } from "@durable-effect/task-group/cloudflare";

const runtime = makeInMemoryRuntime(registryConfig, {
  services: Layer.succeed(CloudflareEnv, {
    BUCKET: mockR2,
    HYPERDRIVE: { connectionString: "postgres://test:5432/test" },
    KV: mockKV,
    GOOGLE_CLIENT_ID: "test-id",
    GOOGLE_CLIENT_SECRET: "test-secret",
    GBP_ENCRYPTION_KEY: "test-key",
  }),
});
```

**Type signature:**

```typescript
function makeInMemoryRuntime<Tags extends AnyTaskTag, R = never>(
  built: BuiltRegistry<Tags, R>,
  ...options: R extends never ? [] : [{ services: Layer.Layer<R> }]
): InMemoryRuntime<Tags>
```

When `R = never`, no options are needed (backward compatible). When `R = CloudflareEnv`
(or any other platform context), the caller must provide the services layer.

---

## Internal Architecture

### CloudflareEnv Service

```typescript
// @durable-effect/task-group/cloudflare

import { Context } from "effect";

export type CloudflareEnvType = Record<string, unknown>;

export class CloudflareEnv extends Context.Tag("@durable-effect/CloudflareEnv")<
  CloudflareEnv,
  CloudflareEnvType
>() {}
```

A simple tagged service. Typed as `Record<string, unknown>` to avoid coupling the
library to specific binding shapes. Users cast or narrow in their factory
functions. A type parameter could be added later for stricter typing:

```typescript
// Future: generic for user-defined Env types
export class CloudflareEnv<E = Record<string, unknown>>
  extends Context.Tag("@durable-effect/CloudflareEnv")<CloudflareEnv<E>, E>() {}
```

### cloudflareServices / withCloudflareServices Implementation

```typescript
export function cloudflareServices<Env>() {
  // Returns a helper function with Env captured. TypeScript infers
  // all remaining generics (S, E, R, etc.) from the config argument.
  return <S, E, EErr, AErr, Tags extends AnyTaskTag, R, OEErr, OAErr>(
    config: HandlerConfig<S, E, EErr, AErr, Tags, R, OEErr, OAErr>,
    makeLayer: (env: Env) => Layer.Layer<R>,
  ): HandlerConfig<S, E, EErr, AErr, Tags, CloudflareEnv, OEErr, OAErr> => {
    // Build a Layer<R, never, CloudflareEnv> that:
    // 1. Reads CloudflareEnv (unknown) from the Effect context
    // 2. Casts to Env (safe — the DO constructor provides real CF env)
    // 3. Calls the user's factory to build the actual service layer
    const deferredLayer: Layer.Layer<R, never, CloudflareEnv> =
      Layer.unwrapEffect(
        Effect.map(CloudflareEnv, (env) => makeLayer(env as Env))
      );

    // Wrap handler functions with Effect.provide using the deferred layer.
    // Same mechanics as withServices, but output R = CloudflareEnv instead of never.
    return {
      onEvent: wrapEventDef(config.onEvent, deferredLayer),
      onAlarm: wrapAlarmDef(config.onAlarm, deferredLayer),
    };
  };
}
```

This reuses the existing `wrapEventDef`/`wrapAlarmDef` functions after
generalizing their layer parameter (see Core Type Changes below).

### Core Type Changes

**RegisteredTask** gains an optional `R` parameter:

```typescript
// Before
export interface RegisteredTask {
  readonly handleEvent: (ctx: HandlerContext, event: unknown) =>
    Effect.Effect<void, TaskValidationError | TaskExecutionError>
  // ...
}

// After
export interface RegisteredTask<R = never> {
  readonly handleEvent: (ctx: HandlerContext, event: unknown) =>
    Effect.Effect<void, TaskValidationError | TaskExecutionError, R>
  // ...
}
```

**TaskRegistryConfig and BuiltRegistry**:

```typescript
export type TaskRegistryConfig<R = never> = Record<string, RegisteredTask<R>>

export interface BuiltRegistry<Tags extends AnyTaskTag, R = never> {
  readonly registryConfig: TaskRegistryConfig<R>
  readonly tags: ReadonlyMap<string, Tags>
}
```

**TaskHandler**:

```typescript
export interface TaskHandler<K extends string, R = never> {
  readonly _name: K
  readonly registered: RegisteredTask<R>
}
```

**registry.handler() accepts R != never**:

```typescript
handler<K extends Tags["name"], EErr, AErr, R = never, OEErr = never, OAErr = never>(
  name: K,
  config: HandlerConfig<StateFor<Tags, K>, EventFor<Tags, K>, EErr, AErr, Tags, R, OEErr, OAErr>,
): TaskHandler<K, R>
```

**registry.build() infers R from handlers**:

```typescript
build<R = never>(
  handlers: { readonly [K in Tags["name"]]: TaskHandler<K, R> },
): BuiltRegistry<Tags, R>
```

> **Backward compatibility**: All `R` parameters default to `never`. Existing code
> that uses `withServices(config, layer)` produces `R = never`, so all downstream
> types resolve to their current shapes. No migration needed.

**wrapEventDef / wrapAlarmDef generalization**:

```typescript
// Before: layer: Layer.Layer<R> (R_in = never)
// After:  layer: Layer.Layer<R, never, RIn>

function wrapEventDef<S, E, EErr, Tags, R, RIn, OEErr>(
  def: EventDef<S, E, EErr, Tags, R, OEErr>,
  layer: Layer.Layer<R, never, RIn>,
): EventDef<S, E, EErr, Tags, RIn, OEErr> {
  if (isHandlerObject(def)) {
    return {
      handler: (ctx, event) => Effect.provide(def.handler(ctx, event), layer),
      onError: (ctx, error) => Effect.provide(def.onError(ctx, error), layer),
    };
  }
  return (ctx, event) => Effect.provide(def(ctx, event), layer);
}
```

`withServices` becomes a special case where `RIn = never`.

### makeTaskGroupDO Changes

The DO constructor provides `CloudflareEnv` from its `env` parameter. Uses
`ManagedRuntime` to build deferred layers once per instance and reuse them
across handler calls.

```typescript
export function makeTaskGroupDO<Tags extends AnyTaskTag, R = never>(
  built: BuiltRegistry<Tags, R>,
): { DO: ...; client: ... } {
  const registryConfig = built.registryConfig;

  class TaskGroupDOImpl extends DurableObject {
    private doStorage: DurableObjectStorageLike;
    private storageService: ReturnType<typeof makeCloudflareStorage>;
    private alarmService: ReturnType<typeof makeCloudflareAlarm>;
    private dispatchFn: DispatchFn;

    // ManagedRuntime built from CloudflareEnv layer.
    // Services are constructed lazily on first handler call,
    // then cached for the lifetime of this DO instance.
    private managedRuntime: ManagedRuntime.ManagedRuntime<R> | null;

    constructor(ctx: DurableObjectStateLike, env: unknown) {
      super(ctx, env);
      this.doStorage = ctx.storage;
      this.storageService = makeCloudflareStorage(this.doStorage);
      this.alarmService = makeCloudflareAlarm(this.doStorage);

      // Build a ManagedRuntime that provides CloudflareEnv.
      // When handlers have R = CloudflareEnv, the deferred layers
      // read env from this context and build their services.
      // When R = never, managedRuntime is null (no-op path).
      this.managedRuntime = this.buildManagedRuntime(env);

      // ... dispatch setup (unchanged) ...
    }

    private buildManagedRuntime(env: unknown): ManagedRuntime.ManagedRuntime<R> | null {
      // If R = never, no runtime needed.
      // We detect this at runtime by checking if any handler
      // in the registry has deferred requirements.
      // (In practice, the type system ensures correctness —
      // this runtime check is a safety net.)
      const envLayer = Layer.succeed(CloudflareEnv, env as CloudflareEnvType);
      return ManagedRuntime.make(envLayer as Layer.Layer<R>);
    }

    async handleEvent(name: string, id: string, event: unknown): Promise<void> {
      const task = registryConfig[name];
      if (!task) throw new Error(`Task "${name}" not found`);

      await this.doStorage.put(ROUTING_NAME_KEY, name);
      await this.doStorage.put(ROUTING_ID_KEY, id);

      const hctx = this.makeHandlerContext(name, id);

      if (this.managedRuntime) {
        // Deferred services: run within the managed runtime
        // which provides CloudflareEnv (and thus all deferred layers)
        await this.managedRuntime.runPromise(task.handleEvent(hctx, event));
      } else {
        // No deferred services: direct execution (current behavior)
        await Effect.runPromise(task.handleEvent(hctx, event));
      }
    }

    // handleAlarm, handleGetState follow same pattern...
  }

  // client() unchanged...
  return { DO: TaskGroupDOImpl, client };
}
```

### makeInMemoryRuntime Changes

```typescript
export function makeInMemoryRuntime<Tags extends AnyTaskTag, R = never>(
  built: BuiltRegistry<Tags, R>,
  ...options: R extends never ? [] : [{ services: Layer.Layer<R> }]
): InMemoryRuntime<Tags> {
  const servicesLayer = options[0]?.services ?? null;
  let managedRuntime: ManagedRuntime.ManagedRuntime<R> | null = null;

  if (servicesLayer) {
    managedRuntime = ManagedRuntime.make(servicesLayer);
  }

  // ... rest of implementation uses managedRuntime.runPromise()
  // when R != never, Effect.runPromise() when R = never ...
}
```

---

## Platform Extensibility

The design is structured so that new platforms follow the same pattern:

### 1. Define a platform context service

```typescript
// @durable-effect/task-group/lambda (hypothetical)
export class LambdaContext extends Context.Tag("@durable-effect/LambdaContext")<
  LambdaContext,
  { functionName: string; memoryLimit: number; /* ... */ }
>() {}
```

### 2. Create a platform-specific service helper (same curried factory pattern)

```typescript
export function lambdaServices<Ctx>() {
  return <S, E, EErr, AErr, Tags extends AnyTaskTag, R, OEErr, OAErr>(
    config: HandlerConfig<S, E, EErr, AErr, Tags, R, OEErr, OAErr>,
    makeLayer: (ctx: Ctx) => Layer.Layer<R>,
  ): HandlerConfig<S, E, EErr, AErr, Tags, LambdaContext, OEErr, OAErr> => {
    const deferredLayer = Layer.unwrapEffect(
      Effect.map(LambdaContext, (ctx) => makeLayer(ctx as Ctx))
    );
    return {
      onEvent: wrapEventDef(config.onEvent, deferredLayer),
      onAlarm: wrapAlarmDef(config.onAlarm, deferredLayer),
    };
  };
}

// User setup:
// export const withLambdaServices = lambdaServices<MyLambdaCtx>();
```

### 3. Create a platform adapter that provides the context

```typescript
export function makeLambdaTaskEngine<Tags, R>(
  built: BuiltRegistry<Tags, R>,
) {
  return {
    async handleEvent(context: LambdaContextType, name: string, id: string, event: unknown) {
      const envLayer = Layer.succeed(LambdaContext, context);
      const managedRuntime = ManagedRuntime.make(envLayer);
      await managedRuntime.runPromise(task.handleEvent(hctx, event));
    }
  };
}
```

### Pattern Summary

| Platform   | Context Service  | Helper                   | Where context is available |
|------------|-----------------|--------------------------|---------------------------|
| Cloudflare | `CloudflareEnv` | `cloudflareServices<Env>()` | DO constructor (`env`)    |
| Node.js    | *(none)*        | `withServices`              | Module scope (no restrictions) |
| Lambda     | `LambdaContext` | `lambdaServices<Ctx>()`     | Per invocation (`context`) |
| Tests      | Depends on prod | `withServices` or mock      | Test setup                |

Services are always the same `Layer<R>`. The only thing that changes is the
`with*Services` wrapper and the runtime adapter.

---

## Testing Strategy

### Option A: Mock the platform context

Use the same `withCloudflareServices` wrapper and provide a mock
`CloudflareEnv` to the in-memory runtime:

```typescript
const runtime = makeInMemoryRuntime(registryConfig, {
  services: Layer.succeed(CloudflareEnv, {
    BUCKET: createMockR2(),
    KV: createMockKV(),
    HYPERDRIVE: { connectionString: "postgres://localhost:5432/test" },
  }),
});

// Handler code is unchanged — same deferred layer factory runs,
// but reads from the mock env instead of real Cloudflare bindings.
```

**Pros**: Tests exercise the same code path as production (including the
layer factory). If the factory has a bug, tests catch it.

**Cons**: Requires maintaining mock bindings that match the Cloudflare API
surface.

### Option B: Separate handler registration for tests

Define the handler config once, wrap it differently for prod vs test:

```typescript
// shared/handler-config.ts — the handler logic (has R = GbpClient | R2Service | ...)
export const analyticsConfig = {
  onEvent: o.onEvent((ctx, event) => Effect.gen(function* () { /* ... */ })),
  onAlarm: o.onAlarm((ctx) => Effect.gen(function* () { /* ... */ })),
};

// prod/registry.ts — deferred services
import { withCloudflareServices } from "../services/cloudflare";
const handler = registry.handler("analytics",
  withCloudflareServices(analyticsConfig, (env) => makeProdLayer(env))
);

// test/registry.ts — eager mock services
import { withServices } from "@durable-effect/task-group";
const handler = registry.handler("analytics",
  withServices(analyticsConfig, TestServicesLive)
);
const runtime = makeInMemoryRuntime(registry.build({ analytics: handler }));
```

**Pros**: Tests don't need mock Cloudflare bindings. Faster, simpler test setup.

**Cons**: Tests use a different code path for service construction. Doesn't
catch bugs in the layer factory.

### Recommended approach

Use **Option A** for integration tests (validates the full path) and
**Option B** for unit tests (fast, isolated).

---

## Migration Path

### Phase 1: Core type generalization (non-breaking)

Add the `R` type parameter to `RegisteredTask`, `TaskHandler`,
`TaskRegistryConfig`, `BuiltRegistry`, and `registry.handler()`. All default to
`never`, so no existing code changes.

Generalize `wrapEventDef`/`wrapAlarmDef` to accept `Layer<R, never, RIn>`
instead of `Layer<R>`. `withServices` continues to work (passes `RIn = never`).

### Phase 2: CloudflareEnv + withCloudflareServices

Add `CloudflareEnv` service and `withCloudflareServices` helper to the
`/cloudflare` subpath. Update `makeTaskGroupDO` to provide `CloudflareEnv`
and use `ManagedRuntime` when `R != never`.

### Phase 3: InMemoryRuntime support

Update `makeInMemoryRuntime` to accept the optional `services` parameter for
testing deferred-service handlers.

### Phase 4: Future platform adapters

Add Lambda, Deno Deploy, or other adapters following the same pattern.
Each adapter defines its context service and `with*Services` helper.

---

## Open Questions

1. **Typed env**: Resolved. `cloudflareServices<Env>()` captures the user's
   wrangler-generated `Env` type once per project. The returned helper provides
   full autocomplete and type checking on `env.BUCKET`, `env.KV`, etc. in every
   handler — no per-call annotation needed. `CloudflareEnv` stores `unknown`
   internally; the cast is safe because the DO constructor provides the real env.

2. **ManagedRuntime lifecycle**: Cloudflare DOs have no explicit shutdown hook.
   `ManagedRuntime.dispose()` would clean up resources (close DB connections,
   etc.), but there's no guaranteed place to call it. Options:
   - Accept that resources are cleaned up when the isolate is evicted (~30s idle)
   - Use `ctx.blockConcurrencyWhile` in the constructor for eager initialization
     with a known lifecycle
   - Investigate Cloudflare's `webSocketClose` or hibernation callbacks as cleanup points

3. **Per-task vs per-group services**: The current design provides the same
   `CloudflareEnv` to all tasks in a group (since they share a DO class). If
   different tasks in a group need fundamentally different service layers, they'd
   each wrap with their own `withCloudflareServices` call. The `R` on the built
   registry would be `CloudflareEnv` (the union simplifies since it's the same
   service). This works naturally.

4. **ManagedRuntime detection**: The runtime needs to know whether to use
   `ManagedRuntime` or plain `Effect.runPromise`. Options:
   - Always use `ManagedRuntime` (overhead is negligible when `R = never`)
   - Check a flag on `BuiltRegistry` set during build
   - Use conditional typing to select the code path at compile time

---

## Summary

| Concern | Before | After |
|---------|--------|-------|
| Layer construction timing | Module scope (global) | DO constructor scope (deferred) |
| Service definitions | Platform-agnostic | Platform-agnostic (unchanged) |
| Binding mechanism | `withServices(config, layer)` | + `cloudflareServices<Env>()(config, env => layer)` |
| Type safety | R must be never | R flows through, resolved by runtime |
| Layer memoization | Per `Effect.runPromise` call | Per DO instance (via `ManagedRuntime`) |
| Test compatibility | `withServices` + mock layers | + `services` option on `makeInMemoryRuntime` |
| Platform extensibility | Cloudflare only | Pattern for any platform context |
