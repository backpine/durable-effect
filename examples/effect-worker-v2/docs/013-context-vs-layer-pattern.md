# 013: Context vs Layer - Why Database Still Rebuilds

## The Problem

Despite implementing `Layer.MemoMap`, the database still logs "Connecting to database..." on every request:

```
Connecting to database... 1765938326132
[wrangler:info] GET /health 200 OK (11ms)
Connecting to database... 1765938326282
[wrangler:info] GET /health 200 OK (11ms)
```

## Root Cause Analysis

### Our Current Pattern

```typescript
// worker.ts
const memoMap = Effect.runSync(Layer.makeMemoMap);
const runtime = ManagedRuntime.make(Layer.empty, memoMap);  // ← EMPTY layer

export default {
  async fetch(request, env, ctx) {
    const appLayer = makeAppLayer(env, ctx);  // ← Creates LAYER each request
    const effect = handleRequest(request).pipe(Effect.provide(appLayer));  // ← Provides LAYER
    return runtime.runPromise(effect);
  },
};
```

### effect-cloudflare Pattern

```typescript
// effect-cloudflare/src/internal/worker.ts
export function makeFetchEntryPoint(handler, options) {
  // Runtime built WITH application layer (Database, etc.)
  const runtime = ManagedRuntime.make(options.layer, options.memoMap);

  const fetch = async (req, env, ctx) => {
    // Creates CONTEXT (not Layer!) for request-scoped data
    const context = Context.make(Env, effectEnv).pipe(
      Context.add(ExecutionContext, effectCtx),
    );

    // Provides CONTEXT - O(1) operation, no layer building
    return runtime.runPromise(Effect.provide(effect, context));
  };
}
```

### The Key Distinction

| Operation | Cost | What Happens |
|-----------|------|--------------|
| `Effect.provide(effect, layer)` | **EXPENSIVE** | Builds the layer, runs scoped effects, creates services |
| `Effect.provide(effect, context)` | **CHEAP** | Just adds service instances to the context map |

**Our problem:** We're providing a `Layer` per-request, which triggers layer construction every time.

**The fix:** Build static layers into the runtime once, provide only request-scoped `Context` per-request.

## Why MemoMap Didn't Help

MemoMap caches layer construction by layer identity. But our layers **depend on CloudflareEnv**, which varies per-request:

```typescript
// runtime.ts
export const makeAppLayer = (env: Env, ctx: ExecutionContext) => {
  const requestLayer = makeRequestLayer(env, ctx);  // Different env each request!
  return AppLive(env.DATABASE_URL).pipe(Layer.provide(requestLayer));
};
```

Each request has a different `env` object, so the composed layer is "different" and MemoMap can't cache it.

## The Real Problem: Service Construction vs Runtime Access

Our services access `CloudflareEnv` at **construction time**:

```typescript
// config.ts - CURRENT
export const ConfigLive = Layer.effect(
  Config,
  Effect.gen(function* () {
    const { env } = yield* CloudflareEnv  // ← Accessed at CONSTRUCTION time!

    return {
      get: (key) => Effect.fromNullable(env[key])  // ← env captured in closure
    }
  })
)
```

This means `ConfigLive` MUST be rebuilt each request since it captures `env` during construction.

**effect-cloudflare services** access env at **method call time**:

```typescript
// effect-cloudflare pattern
export const ConfigLive = Layer.succeed(
  Config,
  {
    get: (key) =>
      Effect.gen(function* () {
        const { env } = yield* Env  // ← Accessed at CALL time!
        return env[key]
      })
  }
)
```

The layer is built once (returns a static object), but `env` is accessed each time a method is called.

## Solution: effect-cloudflare Pattern

### Architecture Change

```
BEFORE (Layer per request):
┌─────────────────────────────────────────────────────────────┐
│ Module Level                                                │
│   runtime = ManagedRuntime.make(Layer.empty)                │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│ Per Request                                                 │
│   appLayer = makeAppLayer(env, ctx)   ← Creates layers      │
│   Effect.provide(effect, appLayer)    ← Builds layers       │
│   → Database rebuilds every time!                           │
└─────────────────────────────────────────────────────────────┘

AFTER (Context per request):
┌─────────────────────────────────────────────────────────────┐
│ Module Level                                                │
│   AppLayer = ConfigLive + KVLive + StorageLive + DatabaseLive
│   runtime = ManagedRuntime.make(AppLayer)  ← Built ONCE     │
│   → Database connects once at startup                       │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│ Per Request                                                 │
│   context = Context.make(Env, { env })    ← Just data       │
│   Effect.provide(effect, context)         ← O(1) operation  │
│   → No layer rebuilding!                                    │
└─────────────────────────────────────────────────────────────┘
```

### Implementation

#### Step 1: Update Services to Access Env at Call Time

```typescript
// src/services/cloudflare.ts
import { Context, Effect } from "effect"

/**
 * Request-scoped Cloudflare environment.
 * Provided as Context per-request, NOT built as a layer.
 */
export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
  CloudflareEnv,
  { readonly env: Env }
>() {}

export class CloudflareCtx extends Context.Tag("CloudflareCtx")<
  CloudflareCtx,
  { readonly ctx: ExecutionContext }
>() {}
```

```typescript
// src/services/config.ts - REFACTORED
export const ConfigLive = Layer.succeed(
  Config,
  {
    // env accessed at CALL time, not construction time
    get: (key: string) =>
      Effect.gen(function* () {
        const { env } = yield* CloudflareEnv
        const value = env[key as keyof typeof env]
        if (typeof value !== "string") {
          return yield* Effect.fail(new ConfigError({ key, message: `Config key "${key}" not found` }))
        }
        return value
      }),

    getSecret: (key: string) =>
      Effect.gen(function* () {
        const { env } = yield* CloudflareEnv
        const value = env[key as keyof typeof env]
        if (typeof value !== "string") {
          return yield* Effect.fail(new ConfigError({ key, message: `Secret "${key}" not found` }))
        }
        return value
      }),

    getNumber: (key: string) =>
      Effect.gen(function* () {
        const config = yield* Config
        const value = yield* config.get(key)
        const num = Number(value)
        if (Number.isNaN(num)) {
          return yield* Effect.fail(new ConfigError({ key, message: `Not a valid number: "${value}"` }))
        }
        return num
      }),

    getBoolean: (key: string) =>
      Effect.gen(function* () {
        const config = yield* Config
        const value = yield* config.get(key)
        const lower = value.toLowerCase().trim()
        if (["true", "1", "yes"].includes(lower)) return true
        if (["false", "0", "no"].includes(lower)) return false
        return yield* Effect.fail(new ConfigError({ key, message: `Not a valid boolean: "${value}"` }))
      }),

    getJson: (key, schema) =>
      Effect.gen(function* () {
        const config = yield* Config
        const value = yield* config.get(key)
        const parsed = yield* Effect.try({
          try: () => JSON.parse(value),
          catch: (e) => new ConfigError({ key, message: `Invalid JSON: ${e}` }),
        })
        return yield* Schema.decodeUnknown(schema)(parsed).pipe(
          Effect.mapError((e) => new ConfigError({ key, message: `Schema validation failed: ${e}` }))
        )
      }),

    getOrElse: (key, defaultValue) =>
      Effect.gen(function* () {
        const config = yield* Config
        return yield* config.get(key).pipe(Effect.orElseSucceed(() => defaultValue))
      }),

    getAll: () =>
      Effect.gen(function* () {
        const { env } = yield* CloudflareEnv
        const result: Record<string, string> = {}
        for (const key in env) {
          const value = env[key as keyof typeof env]
          if (typeof value === "string") {
            result[key] = value
          }
        }
        return result
      }),
  }
)
```

```typescript
// src/services/kv.ts - REFACTORED
export const KVLive = Layer.succeed(
  KV,
  {
    from: (binding: KVBindingName) =>
      Effect.gen(function* () {
        const { env } = yield* CloudflareEnv  // Accessed at CALL time
        const kv = env[binding] as globalThis.KVNamespace

        return {
          get: (key) =>
            Effect.tryPromise({
              try: () => kv.get(key),
              catch: (error) => new KVError({ operation: "get", key, message: `Failed`, cause: error }),
            }).pipe(Effect.map(Option.fromNullable)),
          // ... other methods
        }
      }),
  }
)
```

#### Step 2: Database Uses Module-Level Env

For Database, the connection string is static (doesn't change per-request). Use Cloudflare's module-level env:

```typescript
// src/services/database.ts - REFACTORED
import { env } from "cloudflare:workers"  // Module-level env access!

export const DatabaseLive = Layer.scoped(
  Database,
  Effect.gen(function* () {
    console.log("Connecting to database...", Date.now())

    // Connection string from module-level env (available at isolate start)
    const client = postgres(env.DATABASE_URL, {
      max: 5,
      fetch_types: false,
    })

    const db = drizzle(client)

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await client.end({ timeout: 5 })
      }).pipe(Effect.catchAll(() => Effect.void))
    )

    return db
  })
)
```

#### Step 3: Build Static Layers at Module Level

```typescript
// src/app.ts - REFACTORED
import { Layer } from "effect"
import { ConfigLive, KVLive, StorageLive, DatabaseLive } from "@/services"

/**
 * Application Layer
 *
 * Built ONCE at module level. Services access CloudflareEnv
 * at call time, not construction time.
 */
export const AppLayer = Layer.mergeAll(
  ConfigLive,
  KVLive,
  StorageLive,
  DatabaseLive,
)
```

#### Step 4: Worker Uses Context for Request-Scoped Data

```typescript
// src/worker.ts - REFACTORED
import { Context, Effect, ManagedRuntime } from "effect"
import { handleRequest } from "./handler"
import { AppLayer } from "./app"
import { CloudflareEnv, CloudflareCtx } from "./services"

// Runtime built ONCE with application layer
const runtime = ManagedRuntime.make(AppLayer)

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Create CONTEXT (not Layer!) for request-scoped data
    const context = Context.make(CloudflareEnv, { env }).pipe(
      Context.add(CloudflareCtx, { ctx }),
    )

    const effect = handleRequest(request).pipe(
      Effect.provide(context),  // Provides CONTEXT - O(1)!
    )

    return runtime.runPromise(effect)
  },
}
```

## Service Refactoring Patterns

### Pattern 1: Static Service (Database)

Connection established once, reused across requests:

```typescript
// Uses module-level env for connection string
import { env } from "cloudflare:workers"

export const DatabaseLive = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const client = postgres(env.DATABASE_URL, { max: 5 })
    const db = drizzle(client)
    yield* Effect.addFinalizer(() => Effect.promise(() => client.end()))
    return db
  })
)
```

### Pattern 2: Accessor Service (Config, KV, Storage)

Service object created once, env accessed at method call time:

```typescript
export const ConfigLive = Layer.succeed(
  Config,
  {
    get: (key) =>
      Effect.gen(function* () {
        const { env } = yield* CloudflareEnv  // Per-call access
        return env[key]
      }),
  }
)
```

### Pattern 3: Factory Service (KV with multiple bindings)

Returns operations object that accesses env when used:

```typescript
export const KVLive = Layer.succeed(
  KV,
  {
    from: (binding) =>
      Effect.gen(function* () {
        const { env } = yield* CloudflareEnv
        const kv = env[binding] as globalThis.KVNamespace
        return makeKVOperations(kv)
      }),
  }
)
```

## Complete File Changes

### src/worker.ts

```typescript
import { Context, Effect, ManagedRuntime } from "effect"
import { handleRequest } from "./handler"
import { AppLayer } from "./app"
import { CloudflareEnv, CloudflareCtx } from "./services"

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Module-Level Runtime (built ONCE)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Singleton managed runtime.
 *
 * Built once when the worker isolate initializes.
 * Contains all application services (Database, Config, KV, Storage).
 * Database connection is established at this point.
 */
const runtime = ManagedRuntime.make(AppLayer)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Worker Export
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Create Context (NOT Layer!) for request-scoped data
    // This is O(1) - just adds to the context map
    const requestContext = Context.make(CloudflareEnv, { env }).pipe(
      Context.add(CloudflareCtx, { ctx }),
    )

    const effect = handleRequest(request).pipe(
      Effect.provide(requestContext),
    )

    return runtime.runPromise(effect)
  },
}
```

### src/app.ts

```typescript
import { Layer } from "effect"
import { ConfigLive, KVLive, StorageLive, DatabaseLive } from "@/services"

/**
 * Application Layer
 *
 * Built ONCE at module level into ManagedRuntime.
 *
 * Important: Services must access CloudflareEnv at CALL time,
 * not construction time. This allows the layer to be built
 * once while still accessing request-specific env.
 */
export const AppLayer = Layer.mergeAll(
  ConfigLive,
  KVLive,
  StorageLive,
  DatabaseLive,
)

/**
 * Application Layer without Database
 *
 * For routes that don't need database access.
 */
export const AppCoreLayer = Layer.mergeAll(
  ConfigLive,
  KVLive,
  StorageLive,
)
```

### src/runtime.ts

```typescript
// This file can be deleted or simplified - most logic moves to worker.ts
// Keep only if you need helper exports

export { AppLayer, AppCoreLayer } from "./app"
```

## Verification

After refactoring, you should see:

```
// First request (or isolate cold start):
Connecting to database... 1765938326132
[wrangler:info] GET /health 200 OK (50ms)

// Subsequent requests:
[wrangler:info] GET /health 200 OK (5ms)
[wrangler:info] GET /health 200 OK (3ms)
[wrangler:info] GET /health 200 OK (4ms)
// No "Connecting to database..." logs!
```

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| Runtime layer | `Layer.empty` | `AppLayer` (with all services) |
| Per-request provision | `Layer` (triggers construction) | `Context` (O(1) add) |
| Service env access | At construction time | At method call time |
| Database connection | Every request | Once per isolate |
| Database connection string | From per-request `env.DATABASE_URL` | From module-level `import { env }` |

## Key Takeaways

1. **Layer vs Context**: Providing a `Layer` builds it. Providing a `Context` just adds services.
2. **Construction vs Runtime**: Services should access `env` at method call time, not layer construction time.
3. **Static vs Dynamic**: Database connection string is static - use module-level env. Other services need per-request env access.
4. **effect-cloudflare pattern**: Build application layer into runtime, provide request-scoped data as Context.
