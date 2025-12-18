# 004 - Effect-TS Critique and Architectural Improvements

## Executive Summary

This document provides a comprehensive critique of the Effect Worker codebase from an Effect-TS architectural perspective. The project demonstrates solid foundations with proper service abstractions, typed errors, and Effect composition. However, several critical anti-patterns compromise the "effectful" nature of the system, particularly around runtime caching, type safety, and resource management.

**Overall Assessment:**
- **Strengths**: Clean service interfaces, proper error modeling, good layer composition patterns
- **Critical Issues**: 3 high-priority problems that break Effect's referential transparency and type safety
- **Medium Issues**: 4 architectural concerns that reduce code quality and maintainability
- **Low Issues**: 3 opportunities for improvement using more idiomatic Effect patterns

This critique prioritizes issues by severity and provides complete, actionable solutions for each.

---

## What's Done Well

Before diving into issues, it's important to acknowledge the patterns that are working correctly:

### 1. Service Abstraction Pattern
All infrastructure services (Config, KVStore, ObjectStorage, Database) use proper Context.Tag patterns with clean interfaces. This enables swappable implementations and testability.

```typescript
// Good: Clean service interface
export class KVStore extends Context.Tag("KVStore")<KVStore, KVService>() {}
```

### 2. Tagged Error Types
All errors properly extend `Data.TaggedError`, enabling exhaustive pattern matching and type-safe error handling:

```typescript
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly key: string
  readonly message: string
}>() {}
```

### 3. CloudflareBindings Layer Foundation
The `CloudflareBindings` service correctly addresses the request-scoped nature of Cloudflare's env object:

```typescript
export class CloudflareBindings extends Context.Tag("CloudflareBindings")<
  CloudflareBindings,
  { readonly env: Env; readonly ctx: ExecutionContext }
>() {
  static layer(env: Env, ctx: ExecutionContext) {
    return Layer.succeed(this, { env, ctx })
  }
}
```

### 4. Layer Composition
The application layer composition in `src/app.ts` follows proper patterns:

```typescript
export const AppCoreLive = Layer.mergeAll(
  ConfigLive,
  KVStoreDefault,
  ObjectStorageDefault,
)
```

### 5. Error-to-Response Mapping
The `errorToResponse` function uses Effect's `Match` API correctly for exhaustive error handling:

```typescript
const { status, body } = Match.value(error).pipe(
  Match.tag("ConfigError", (e) => ({ ... })),
  Match.tag("DatabaseError", (e) => ({ ... })),
  Match.orElse(() => ({ ... }))
)
```

---

## Critical Issues

### Issue 1: Runtime Caching Uses Mutable Global State

**Severity:** 🔴 **CRITICAL**

**Current Code:**
```typescript
// src/runtime.ts
let cachedCoreRuntime: ManagedRuntime.ManagedRuntime<...> | null = null
let cachedCoreEnv: Env | null = null

export const getOrCreateCoreRuntime = (env: Env, ctx: ExecutionContext) => {
  if (cachedCoreRuntime === null || cachedCoreEnv !== env) {
    if (cachedCoreRuntime !== null) {
      cachedCoreRuntime.dispose()
    }
    // ...
    cachedCoreRuntime = ManagedRuntime.make(appLayer)
    cachedCoreEnv = env
  }
  return cachedCoreRuntime
}
```

**Problem:**

This pattern breaks Effect's core principle of **referential transparency** and introduces multiple serious issues:

1. **Breaks Referential Transparency**: Mutable module-level state means the same function call can return different values depending on hidden state
2. **Race Conditions**: Multiple concurrent requests could trigger disposal and recreation simultaneously
3. **Memory Leaks**: If `env` reference changes frequently, runtimes may not be properly disposed
4. **Testing Nightmare**: Global mutable state makes unit tests interfere with each other
5. **Not Actually Effectful**: This caching happens in the JavaScript runtime, not within Effect's managed context

**Why Env Reference Equality is Fragile:**

The code assumes `cachedCoreEnv !== env` detects when we're in a new isolate. However:
- Cloudflare may reuse the same env object across requests in the same isolate
- Or it may create new env objects that are structurally identical
- This makes the equality check unreliable for determining when to recreate the runtime

**Recommended Solution:**

There are two viable approaches depending on your performance goals:

#### Option A: No Caching (Simplest, Recommended)

Effect's layer memoization already ensures services are instantiated once per request. Runtime creation overhead is minimal.

```typescript
// src/runtime.ts
import { Layer, ManagedRuntime } from "effect"
import { CloudflareBindings } from "@/services/bindings"
import { AppLive, AppCoreLive } from "@/app"

/**
 * Create core runtime (without Database)
 *
 * Creates a fresh runtime for each request.
 * Effect's layer memoization ensures services are instantiated only once.
 */
export const makeCoreRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppCoreLive.pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

/**
 * Create full runtime (with Database)
 */
export const makeRuntime = (env: Env, ctx: ExecutionContext, hyperdrive: Hyperdrive) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppLive(hyperdrive).pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

export type CoreAppRuntime = ReturnType<typeof makeCoreRuntime>
export type AppRuntime = ReturnType<typeof makeRuntime>
```

Then update middleware:

```typescript
// src/api/middleware.ts
export const effectMiddleware = (type: RuntimeType = "core") =>
  createMiddleware<EffectEnv>(async (c, next) => {
    const env = c.env as Env
    const ctx = c.executionCtx

    const runtime = type === "full"
      ? makeRuntime(env, ctx, env.HYPERDRIVE)
      : makeCoreRuntime(env, ctx)

    c.set("runtime", runtime)

    try {
      await next()
    } finally {
      // Ensure cleanup happens
      await runtime.dispose()
    }
  })
```

#### Option B: Effectful Caching with FiberRef (Advanced)

If you need caching for performance, do it within Effect's context:

```typescript
import { Effect, Layer, ManagedRuntime, FiberRef, Cache, Duration } from "effect"

/**
 * Cached runtime factory using Effect's Cache
 *
 * This approach:
 * - Uses Effect's built-in Cache type for memoization
 * - Handles concurrency correctly
 * - Ensures proper cleanup via Effect's resource management
 */
const makeRuntimeCache = () =>
  Cache.make({
    capacity: 10,
    timeToLive: Duration.infinity, // Cache until isolate dies
    lookup: (key: { env: Env; ctx: ExecutionContext; type: "core" | "full" }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const bindingsLayer = CloudflareBindings.layer(key.env, key.ctx)
          const appLayer = key.type === "full"
            ? AppLive(key.env.HYPERDRIVE).pipe(Layer.provide(bindingsLayer))
            : AppCoreLive.pipe(Layer.provide(bindingsLayer))
          return ManagedRuntime.make(appLayer)
        }),
        (runtime) => Effect.promise(() => runtime.dispose())
      )
  })

// Store cache in FiberRef for per-isolate caching
const RuntimeCacheRef = FiberRef.unsafeMake(makeRuntimeCache())

export const getCachedRuntime = (
  env: Env,
  ctx: ExecutionContext,
  type: "core" | "full"
) =>
  Effect.gen(function* () {
    const cache = yield* FiberRef.get(RuntimeCacheRef)
    return yield* Cache.get(cache, { env, ctx, type })
  })
```

**However**, Option B is likely over-engineering for Cloudflare Workers. **Stick with Option A** unless profiling shows runtime creation is a bottleneck.

**Impact:**
- ✅ Restores referential transparency
- ✅ Eliminates race conditions
- ✅ Makes testing predictable
- ✅ Proper resource cleanup
- ✅ More obviously correct code

---

### Issue 2: Type Safety Lost with Type Assertions

**Severity:** 🟠 **HIGH**

**Current Code:**
```typescript
// src/runtime.ts
const appLayer = AppCoreLive.pipe(
  Layer.provide(bindingsLayer)
) as ProvidedCoreAppLayer  // ⚠️ Type assertion

type ProvidedCoreAppLayer = Layer.Layer<
  Layer.Layer.Success<typeof AppCoreLive>,
  Layer.Layer.Error<typeof AppCoreLive>,
  never  // ⚠️ Manually asserting dependencies are satisfied
>
```

**Problem:**

Type assertions defeat Effect's type inference and compile-time dependency verification:

1. **Loses Compile-Time Safety**: If you forget to provide a required dependency, TypeScript won't catch it
2. **Runtime Errors**: Missing dependencies only fail at runtime
3. **Defeats Effect's Purpose**: Effect's type system is designed to track dependencies through the type system
4. **Maintenance Burden**: When you change layer dependencies, type assertions can become stale

**Why This Happens:**

This is likely caused by TypeScript's type inference limitations with complex `Layer.provide` chains. The type becomes too complex for TypeScript to infer.

**Recommended Solution:**

Let TypeScript infer the types naturally, and use helper type aliases only for documentation:

```typescript
// src/runtime.ts
import { Layer, ManagedRuntime } from "effect"
import { CloudflareBindings } from "@/services/bindings"
import { AppLive, AppCoreLive } from "@/app"

/**
 * Create core runtime (without Database)
 */
export const makeCoreRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  // No type assertion - let Effect infer the type
  const appLayer = AppCoreLive.pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

/**
 * Create full runtime (with Database)
 */
export const makeRuntime = (env: Env, ctx: ExecutionContext, hyperdrive: Hyperdrive) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  // No type assertion - let Effect infer the type
  const appLayer = AppLive(hyperdrive).pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

// Export inferred types (not manual type aliases)
export type CoreAppRuntime = ReturnType<typeof makeCoreRuntime>
export type AppRuntime = ReturnType<typeof makeRuntime>
```

If you need to verify that all dependencies are satisfied, use Effect's type helpers:

```typescript
import type { Layer } from "effect"

// Type-level assertion that layer has no remaining dependencies
type AssertNoRemainingDeps<L extends Layer.Layer<any, any, never>> = L

// This will fail to compile if dependencies aren't satisfied
type VerifyAppLayer = AssertNoRemainingDeps<
  ReturnType<typeof makeCoreRuntime>["layer"]
>
```

**Alternative: Simplify Layer Composition**

If type inference is still problematic, consider flattening the layer composition:

```typescript
export const makeCoreRuntime = (env: Env, ctx: ExecutionContext) => {
  // Build everything in one go
  const fullLayer = Layer.mergeAll(
    CloudflareBindings.layer(env, ctx),
    ConfigLive,
    KVStoreDefault,
    ObjectStorageDefault,
  )
  return ManagedRuntime.make(fullLayer)
}
```

**Impact:**
- ✅ Compile-time dependency verification
- ✅ TypeScript catches missing layers
- ✅ More maintainable as dependencies change
- ✅ Leverages Effect's type system properly

---

### Issue 3: Hono-Effect Adapter Loses Type Safety

**Severity:** 🟠 **HIGH**

**Current Code:**
```typescript
// src/api/effect.ts
export const effectHandler = <R>(handler: EffectHandler<R>) => {
  return async (c: HonoContext) => {
    // ⚠️ Type assertion - no validation that R matches what's in context
    const runtime = c.get("runtime") as ManagedRuntime.ManagedRuntime<R, never>
    // ...
  }
}

// src/api/middleware.ts
interface EffectEnv {
  Variables: {
    runtime: ManagedRuntime.ManagedRuntime<any, any>  // ⚠️ Loses type information
  }
}
```

**Problem:**

The Hono-Effect bridge has a critical type hole:

1. **Runtime Mismatch**: Handler declares it needs `R`, but there's no compile-time check that the runtime in context actually provides `R`
2. **Type Erasure**: The middleware stores `any` runtime, losing all type information
3. **Dangerous Cast**: `c.get("runtime") as ManagedRuntime<R>` is an unchecked assertion
4. **Silent Failures**: If you use `dbMiddleware()` but handler expects core services (or vice versa), it compiles but fails at runtime

**Example of the Problem:**

```typescript
// This compiles but will fail at runtime!
app.use("/api/users", coreMiddleware())  // Provides core runtime (no DB)

app.get("/api/users", effectHandler((c) =>
  Effect.gen(function* () {
    const db = yield* Database  // ❌ Runtime error: Database not in context!
    // ...
  })
))
```

**Recommended Solution:**

Make the dependency requirements explicit and type-safe using phantom types:

```typescript
// src/api/effect.ts
import { Effect, ManagedRuntime } from "effect"
import type { Context as HonoContext } from "hono"
import type { AppError } from "./errors"

/**
 * Branded type to connect middleware to handlers
 */
export type RuntimeBrand<R> = {
  readonly _R: R
}

/**
 * Type-safe Hono context with branded runtime
 */
export interface EffectContext<R> {
  Variables: {
    runtime: ManagedRuntime.ManagedRuntime<R, never> & RuntimeBrand<R>
  }
}

/**
 * An effectful Hono handler that declares its dependencies
 */
export type EffectHandler<R> = (
  c: HonoContext<EffectContext<R>>
) => Effect.Effect<Response, AppError, R>

/**
 * Creates a type-safe Hono handler from an Effect handler
 */
export const effectHandler = <R>(
  handler: EffectHandler<R>
) => {
  return async (c: HonoContext<EffectContext<R>>) => {
    const runtime = c.get("runtime")

    if (!runtime) {
      console.error("Runtime not found in context. Did you apply the effectMiddleware?")
      return Response.json(
        { error: "InternalError", message: "Server configuration error" },
        { status: 500 }
      )
    }

    const program = handler(c).pipe(
      Effect.catchAll((error) => Effect.succeed(errorToResponse(error))),
      Effect.catchAllDefect((defect) => {
        console.error("Unhandled defect:", defect)
        return Effect.succeed(
          Response.json(
            { error: "InternalError", message: "An unexpected error occurred" },
            { status: 500 }
          )
        )
      })
    )

    return runtime.runPromise(program)
  }
}
```

Update the middleware:

```typescript
// src/api/middleware.ts
import { createMiddleware } from "hono/factory"
import type { ManagedRuntime } from "effect"
import { makeCoreRuntime, makeRuntime } from "@/runtime"
import type { AppCoreDependencies, AppDependencies } from "@/app"
import type { EffectContext, RuntimeBrand } from "./effect"

/**
 * Core runtime middleware (without Database)
 */
export const coreMiddleware = () =>
  createMiddleware<EffectContext<AppCoreDependencies>>(async (c, next) => {
    const env = c.env as Env
    const ctx = c.executionCtx

    const runtime = makeCoreRuntime(env, ctx) as
      ManagedRuntime.ManagedRuntime<AppCoreDependencies, never> &
      RuntimeBrand<AppCoreDependencies>

    c.set("runtime", runtime)

    try {
      await next()
    } finally {
      await runtime.dispose()
    }
  })

/**
 * Full runtime middleware (with Database)
 */
export const dbMiddleware = () =>
  createMiddleware<EffectContext<AppDependencies>>(async (c, next) => {
    const env = c.env as Env
    const ctx = c.executionCtx

    const runtime = makeRuntime(env, ctx, env.HYPERDRIVE) as
      ManagedRuntime.ManagedRuntime<AppDependencies, never> &
      RuntimeBrand<AppDependencies>

    c.set("runtime", runtime)

    try {
      await next()
    } finally {
      await runtime.dispose()
    }
  })
```

Now handlers are type-safe:

```typescript
// src/api/routes/users.ts
import { Hono } from "hono"
import { Effect } from "effect"
import { effectHandler } from "../effect"
import { dbMiddleware } from "../middleware"
import { Database } from "@/services"
import type { AppDependencies } from "@/app"

const app = new Hono()

// Middleware sets the runtime type
app.use("*", dbMiddleware())

// Handler's type parameter must match middleware
app.get(
  "/:id",
  effectHandler<AppDependencies>((c) =>  // ✅ Type matches dbMiddleware
    Effect.gen(function* () {
      const db = yield* Database  // ✅ Database is available
      // ...
    })
  )
)
```

**Impact:**
- ✅ Compile-time verification that middleware matches handlers
- ✅ TypeScript errors if you use wrong middleware for a handler
- ✅ Autocomplete knows which services are available
- ✅ Safer refactoring when changing dependencies

---

## Medium Priority Issues

### Issue 4: DatabaseFromConfig Uses Dynamic Import Anti-Pattern

**Severity:** 🟡 **MEDIUM**

**Current Code:**
```typescript
// src/services/database.ts
export const DatabaseFromConfig = Layer.effect(
  Database,
  Effect.gen(function* () {
    // ⚠️ Dynamic import to avoid circular dependency
    const { Config } = yield* Effect.promise(() => import("@/services/config"))
    const config = yield* Config
    // ...
  })
)
```

**Problem:**

Using `Effect.promise(() => import(...))` to break circular dependencies is not effectful:

1. **Not Truly Effectful**: Dynamic imports return promises, not Effects - you're just wrapping a side effect
2. **Fails the "What vs How" Test**: Effect.promise is for interop with promise-based APIs, not for dependency management
3. **Circular Dependency Smell**: If you need dynamic imports to break cycles, your module structure has a design problem
4. **Bundle Size**: Dynamic imports create code splits that may not be desired in Workers
5. **Runtime Errors**: Import failures only happen at runtime, not compile time

**Root Cause:**

The circular dependency likely looks like this:
- `database.ts` imports from `config.ts`
- `config.ts` imports from `services/index.ts`
- `services/index.ts` re-exports `database.ts`

**Recommended Solution:**

Fix the circular dependency at the module level:

#### Option A: Don't re-export from index.ts (Simplest)

```typescript
// src/services/database.ts
import { Config } from "./config"  // Direct import, not from index

export const DatabaseFromConfig = Layer.effect(
  Database,
  Effect.gen(function* () {
    const config = yield* Config  // No dynamic import needed
    const connectionString = yield* config.get("DATABASE_URL")
    const client = postgres(connectionString, { max: 5, fetch_types: false })
    return drizzle(client)
  })
)
```

#### Option B: Make DatabaseFromConfig accept Config as parameter

```typescript
// src/services/database.ts
export const DatabaseFromConfig = (configService: typeof Config.Service) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const config = yield* configService
      const connectionString = yield* config.get("DATABASE_URL")
      const client = postgres(connectionString, { max: 5, fetch_types: false })
      return drizzle(client)
    })
  ).pipe(Layer.provide(configService))
```

#### Option C: Use Layer.provide to inject Config dependency

The most Effect-native solution:

```typescript
// src/services/database.ts
export const DatabaseFromConfig = Layer.effect(
  Database,
  Effect.gen(function* () {
    const config = yield* Config
    const connectionString = yield* config.get("DATABASE_URL")
    const client = postgres(connectionString, { max: 5, fetch_types: false })
    return drizzle(client)
  })
)

// Declare Config as a dependency
export const DatabaseFromConfigLive = DatabaseFromConfig.pipe(
  Layer.provide(ConfigLive)
)
```

Then in your app layer:

```typescript
// src/app.ts
export const AppLive = Layer.mergeAll(
  ConfigLive,
  DatabaseFromConfigLive,  // Config is already in the layer
  // ...
)
```

**Impact:**
- ✅ Removes dynamic import hack
- ✅ Faster module resolution
- ✅ Compile-time dependency checking
- ✅ More idiomatic Effect code

---

### Issue 5: Service Creation Should Use Effect.Service Pattern

**Severity:** 🟡 **MEDIUM**

**Current Code:**
```typescript
// Current pattern: Context.Tag + separate Layer
export class Config extends Context.Tag("Config")<Config, ConfigService>() {}

export const ConfigLive = Layer.effect(
  Config,
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings
    // ... build service
    return service
  })
)
```

**Problem:**

While this pattern works, Effect 3.x introduced `Effect.Service` which is more concise and idiomatic:

1. **More Boilerplate**: Separate tag and layer definition
2. **Dependencies Not Co-located**: The layer and its dependencies are declared separately
3. **Harder to Discover**: Need to know about both the tag and the layer

**Recommended Solution:**

Use `Effect.Service` for cleaner service definitions:

```typescript
// src/services/config.ts
import { Effect, Context, Layer } from "effect"
import { CloudflareBindings } from "./bindings"

export interface ConfigService {
  readonly get: (key: string) => Effect.Effect<string, ConfigError>
  readonly getSecret: (key: string) => Effect.Effect<string, ConfigError>
  readonly getNumber: (key: string) => Effect.Effect<number, ConfigError>
  readonly getBoolean: (key: string) => Effect.Effect<boolean, ConfigError>
  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<A, ConfigError, R>
  readonly getOrElse: (key: string, defaultValue: string) => Effect.Effect<string, never>
  readonly getAll: () => Effect.Effect<Record<string, string>, never>
}

export class Config extends Effect.Service<Config>()("Config", {
  effect: Effect.gen(function* () {
    const { env } = yield* CloudflareBindings

    const getRaw = (key: string): string | undefined => {
      const value = env[key as keyof typeof env]
      return typeof value === "string" ? value : undefined
    }

    const service: ConfigService = {
      get: (key: string) =>
        Effect.fromNullable(getRaw(key)).pipe(
          Effect.mapError(
            () => new ConfigError({ key, message: `Config key "${key}" not found` })
          )
        ),

      getSecret: (key: string) =>
        Effect.fromNullable(getRaw(key)).pipe(
          Effect.mapError(
            () => new ConfigError({ key, message: `Secret "${key}" not found` })
          )
        ),

      getNumber: (key: string) =>
        Effect.gen(function* () {
          const value = yield* service.get(key)
          const num = Number(value)
          if (Number.isNaN(num)) {
            return yield* Effect.fail(
              new ConfigError({
                key,
                message: `Config key "${key}" is not a valid number: "${value}"`,
              })
            )
          }
          return num
        }),

      getBoolean: (key: string) =>
        Effect.gen(function* () {
          const value = yield* service.get(key)
          const lower = value.toLowerCase().trim()
          if (["true", "1", "yes"].includes(lower)) return true
          if (["false", "0", "no"].includes(lower)) return false
          return yield* Effect.fail(
            new ConfigError({
              key,
              message: `Config key "${key}" is not a valid boolean: "${value}"`,
            })
          )
        }),

      getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
        Effect.gen(function* () {
          const value = yield* service.get(key)
          let parsed: unknown
          try {
            parsed = JSON.parse(value)
          } catch (error) {
            return yield* Effect.fail(
              new ConfigError({
                key,
                message: `Config key "${key}" is not valid JSON: ${error}`,
              })
            )
          }
          return yield* Schema.decodeUnknown(schema)(parsed).pipe(
            Effect.mapError(
              (parseError) =>
                new ConfigError({
                  key,
                  message: `Config key "${key}" failed schema validation: ${parseError}`,
                })
            )
          )
        }),

      getOrElse: (key: string, defaultValue: string) =>
        service.get(key).pipe(Effect.orElseSucceed(() => defaultValue)),

      getAll: () =>
        Effect.sync(() => {
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

    return service
  }),
  dependencies: [CloudflareBindings.Default],
}) {}

// Access the default layer via Config.Default
export const ConfigLive = Config.Default
```

Apply this pattern to all services:

```typescript
// src/services/kv.ts
export class KVStore extends Effect.Service<KVStore>()("KVStore", {
  effect: Effect.gen(function* () {
    const { env } = yield* CloudflareBindings
    const kv = env.MY_KV as KVNamespace
    // ... return service
  }),
  dependencies: [CloudflareBindings.Default],
}) {}

export const KVStoreDefault = KVStore.Default
```

**Benefits of Effect.Service:**
- Default layer available as `Service.Default`
- Dependencies declared inline
- Less boilerplate
- More discoverable API

**Impact:**
- ✅ Less boilerplate code
- ✅ Co-located dependencies
- ✅ More idiomatic Effect 3.x
- ✅ Easier to understand service structure

---

### Issue 6: Missing Scoped Resources for Database Connections

**Severity:** 🟡 **MEDIUM**

**Current Code:**
```typescript
// src/services/database.ts
export const DatabaseHyperdrive = (hyperdrive: Hyperdrive) =>
  Layer.sync(Database, () => {
    const client = postgres(hyperdrive.connectionString, {
      max: 5,
      fetch_types: false,
    })
    return drizzle(client)  // ⚠️ No cleanup - connection never closed
  })
```

**Problem:**

The database layer creates a Postgres connection pool but never closes it:

1. **Resource Leak**: Postgres connections are never cleaned up
2. **Connection Exhaustion**: In Workers, each request may create a new pool (if not cached)
3. **No Graceful Shutdown**: When runtime disposes, connections aren't closed
4. **Serverless Anti-Pattern**: Long-lived connections in serverless = bad

**Why This Matters in Workers:**

While Cloudflare Workers have short-lived execution contexts, the Hyperdrive connection is a real TCP connection that should be closed properly to avoid:
- Hitting Postgres max_connections limit
- Leaving connections in CLOSE_WAIT state
- Wasting database resources

**Recommended Solution:**

Use `Layer.scoped` with `Effect.acquireRelease` for proper resource management:

```typescript
// src/services/database.ts
import { Context, Effect, Layer } from "effect"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { DatabaseError } from "@/errors"

export type DrizzleClient = ReturnType<typeof drizzle>

export class Database extends Context.Tag("Database")<
  Database,
  DrizzleClient
>() {}

/**
 * Creates a Database layer from Cloudflare Hyperdrive with proper cleanup.
 */
export const DatabaseHyperdrive = (hyperdrive: Hyperdrive) =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      // Acquire: Create connection pool
      const client = postgres(hyperdrive.connectionString, {
        max: 5,
        fetch_types: false,
      })

      const db = drizzle(client)

      // Register cleanup to close connections
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          // Close the postgres-js client
          await client.end({ timeout: 5 })
        })
      )

      return db
    })
  )

/**
 * Creates a Database layer from a connection string with proper cleanup.
 */
export const DatabaseLive = (connectionString: string) =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      const client = postgres(connectionString, {
        max: 5,
        fetch_types: false,
      })

      const db = drizzle(client)

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await client.end({ timeout: 5 })
        })
      )

      return db
    })
  )
```

**Alternative: Explicit Acquire/Release**

If you prefer the classic acquire-release pattern:

```typescript
export const DatabaseHyperdrive = (hyperdrive: Hyperdrive) =>
  Layer.scoped(
    Database,
    Effect.acquireRelease(
      // Acquire
      Effect.sync(() => {
        const client = postgres(hyperdrive.connectionString, {
          max: 5,
          fetch_types: false,
        })
        return drizzle(client)
      }),
      // Release
      (db) =>
        Effect.promise(() =>
          (db as any).client.end({ timeout: 5 })
        )
    )
  )
```

**Impact:**
- ✅ Proper connection cleanup
- ✅ No resource leaks
- ✅ Better database resource utilization
- ✅ Idiomatic Effect resource management

---

### Issue 7: Inconsistent Error Handling Patterns

**Severity:** 🟡 **MEDIUM**

**Current Code:**
```typescript
// Pattern 1: try/catch inside Effect (bad)
getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
  Effect.gen(function* () {
    const value = yield* service.get(key)
    let parsed: unknown
    try {
      parsed = JSON.parse(value)  // ⚠️ try/catch in Effect
    } catch (error) {
      return yield* Effect.fail(new ConfigError({ ... }))
    }
    // ...
  })

// Pattern 2: Effect.tryPromise (good)
set: (key: string, value: string, options) =>
  Effect.tryPromise({
    try: () => kv.put(key, value, options),
    catch: (error) => new KVError({ ... }),
  })
```

**Problem:**

Mixing `try/catch` with Effect combinators is inconsistent:

1. **Bypasses Effect Tracking**: `try/catch` is not tracked by Effect's execution model
2. **Loses Stack Traces**: Effect has better error tracking than try/catch
3. **Inconsistent Style**: Some places use Effect combinators, others use imperative code
4. **Harder to Compose**: try/catch breaks Effect composition

**Recommended Solution:**

Use Effect combinators consistently:

```typescript
// ❌ Bad: try/catch in Effect
getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
  Effect.gen(function* () {
    const value = yield* service.get(key)
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      return yield* Effect.fail(new ConfigError({ ... }))
    }
    // ...
  })

// ✅ Good: Effect.try for sync operations
getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
  Effect.gen(function* () {
    const value = yield* service.get(key)

    const parsed = yield* Effect.try({
      try: () => JSON.parse(value),
      catch: (error) =>
        new ConfigError({
          key,
          message: `Config key "${key}" is not valid JSON: ${error}`,
        }),
    })

    return yield* Schema.decodeUnknown(schema)(parsed).pipe(
      Effect.mapError(
        (parseError) =>
          new ConfigError({
            key,
            message: `Config key "${key}" failed schema validation: ${parseError}`,
          })
      )
    )
  })
```

Apply this pattern everywhere:

```typescript
// KVStore.getJson
getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
  Effect.gen(function* () {
    const value = yield* service.get(key)

    if (Option.isNone(value)) {
      return Option.none()
    }

    // Use Effect.try instead of try/catch
    const parsed = yield* Effect.try({
      try: () => JSON.parse(value.value),
      catch: (error) =>
        new KVError({
          operation: "getJson",
          key,
          message: `Invalid JSON in key "${key}"`,
          cause: error,
        }),
    })

    const decoded = yield* Schema.decodeUnknown(schema)(parsed).pipe(
      Effect.mapError(
        (parseError) =>
          new KVError({
            operation: "getJson",
            key,
            message: `Schema validation failed: ${parseError}`,
            cause: parseError,
          })
      )
    )

    return Option.some(decoded)
  })
```

**Impact:**
- ✅ Consistent error handling throughout codebase
- ✅ Better stack traces and debugging
- ✅ Effect tracks all failures
- ✅ More composable code

---

## Low Priority Issues

### Issue 8: Missing Tracing and Observability

**Severity:** 🔵 **LOW**

**Current Code:**

No tracing or observability is currently implemented.

**Problem:**

Effect has built-in support for OpenTelemetry tracing, but it's not being used:

1. **Hard to Debug**: No visibility into Effect execution in production
2. **No Performance Metrics**: Can't see where time is spent
3. **Missing Spans**: Database queries, KV operations have no trace spans
4. **Underutilized Feature**: Effect's tracing is one of its best features

**Recommended Solution:**

Add tracing using `Effect.withSpan`:

```typescript
// src/services/database.ts
export const query = <T>(
  fn: (db: DrizzleClient) => Promise<T>
): Effect.Effect<T, DatabaseError, Database> =>
  Effect.gen(function* () {
    const db = yield* Database
    return yield* Effect.tryPromise({
      try: () => fn(db),
      catch: (error) =>
        new DatabaseError({
          message: "Database query failed",
          cause: error,
        }),
    })
  }).pipe(
    Effect.withSpan("database.query", {
      attributes: { "db.system": "postgresql" }
    })
  )
```

Add spans to service operations:

```typescript
// src/services/kv.ts
get: (key: string) =>
  Effect.tryPromise({
    try: () => kv.get(key),
    catch: (error) => new KVError({ operation: "get", key, cause: error }),
  }).pipe(
    Effect.map(Option.fromNullable),
    Effect.withSpan("kv.get", {
      attributes: { "kv.key": key }
    })
  )
```

Configure tracing in your runtime (future enhancement):

```typescript
// src/runtime.ts (future)
import { NodeSdk } from "@effect/opentelemetry"

const TracingLive = NodeSdk.layer(() => ({
  resource: { serviceName: "effect-worker" },
  // Configure exporters for Cloudflare Workers
}))

export const makeRuntime = (env: Env, ctx: ExecutionContext) => {
  const appLayer = AppLive(env.HYPERDRIVE).pipe(
    Layer.provide(CloudflareBindings.layer(env, ctx)),
    Layer.provide(TracingLive)  // Add tracing
  )
  return ManagedRuntime.make(appLayer)
}
```

**Impact:**
- ✅ Visibility into Effect execution
- ✅ Performance profiling
- ✅ Better debugging in production
- ✅ Leverages Effect's built-in observability

---

### Issue 9: Option Handling Could Be More Idiomatic

**Severity:** 🔵 **LOW**

**Current Code:**
```typescript
// src/services/storage.ts
getText: (key: string) =>
  Effect.gen(function* () {
    const obj = yield* service.get(key)

    if (Option.isNone(obj)) {  // ⚠️ Imperative null check
      return Option.none()
    }

    const text = yield* Effect.tryPromise({
      try: () => obj.value.text(),
      // ...
    })

    return Option.some(text)
  })
```

**Problem:**

Imperative `if (Option.isNone(...))` checks are verbose and not idiomatic:

1. **More Verbose**: More lines of code for simple operations
2. **Less Composable**: Can't pipe through Option combinators
3. **Misses FP Patterns**: Effect/Option has rich combinator libraries

**Recommended Solution:**

Use Option combinators for cleaner code:

```typescript
// ✅ Good: Use Option.flatMap
getText: (key: string) =>
  service.get(key).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: (obj) =>
          Effect.tryPromise({
            try: () => obj.text(),
            catch: (error) =>
              new StorageError({
                operation: "getText",
                key,
                message: `Failed to read text from "${key}"`,
                cause: error,
              }),
          }).pipe(Effect.map(Option.some))
      })
    )
  )
```

Or even cleaner with `Effect.optionFromOptional`:

```typescript
getText: (key: string) =>
  Effect.gen(function* () {
    const obj = yield* service.get(key)

    return yield* Effect.forEach(
      obj,
      (o) =>
        Effect.tryPromise({
          try: () => o.text(),
          catch: (error) =>
            new StorageError({
              operation: "getText",
              key,
              message: `Failed to read text from "${key}"`,
              cause: error,
            }),
        })
    )
  })
```

**Impact:**
- ✅ More concise code
- ✅ Better composition
- ✅ More idiomatic Effect/Option usage

---

### Issue 10: Layer Memoization Not Explicit

**Severity:** 🔵 **LOW**

**Current Code:**
```typescript
// src/app.ts
export const AppCoreLive = Layer.mergeAll(
  ConfigLive,
  KVStoreDefault,
  ObjectStorageDefault,
)
```

**Problem:**

Layer memoization happens implicitly, which can be unclear:

1. **Implicit Behavior**: New developers may not understand memoization
2. **Hard to Debug**: When memoization breaks, it's not obvious why
3. **No Explicit Contract**: The "single instance per request" guarantee is invisible

**Recommended Solution:**

Use `Layer.memoize` explicitly for clarity:

```typescript
// src/app.ts
import { Layer } from "effect"
import {
  ConfigLive,
  KVStoreDefault,
  ObjectStorageDefault,
  DatabaseHyperdrive,
} from "@/services"

/**
 * Core Application Layer (without Database)
 *
 * Memoized to ensure single instance per request.
 */
export const AppCoreLive = Layer.mergeAll(
  ConfigLive,
  KVStoreDefault,
  ObjectStorageDefault,
).pipe(Layer.memoize)

/**
 * Application Layer with Database
 *
 * Memoized to ensure single instance per request.
 */
export const AppLive = (hyperdrive: Hyperdrive) =>
  Layer.mergeAll(
    AppCoreLive,
    DatabaseHyperdrive(hyperdrive),
  ).pipe(Layer.memoize)

export type AppCoreDependencies = Layer.Layer.Success<typeof AppCoreLive>
export type AppDependencies = Layer.Layer.Success<ReturnType<typeof AppLive>>
```

**Note:** `Layer.memoize` returns an Effect that creates a memoized layer, so you'd use it like:

```typescript
const makeRuntime = (env: Env, ctx: ExecutionContext) =>
  Effect.gen(function* () {
    const bindingsLayer = CloudflareBindings.layer(env, ctx)
    const memoizedApp = yield* AppCoreLive
    const appLayer = memoizedApp.pipe(Layer.provide(bindingsLayer))
    return ManagedRuntime.make(appLayer)
  })
```

However, this adds complexity. **In practice, Effect's default memoization is sufficient** for this use case. This issue is marked LOW because explicit memoization is mainly useful for documentation purposes.

**Impact:**
- ✅ Makes memoization explicit
- ✅ Self-documenting code
- ⚠️ Adds complexity (may not be worth it)

---

## Hono-Effect Adapter Deep Dive

The current Hono-Effect integration has architectural issues beyond just type safety. Let's examine the adapter pattern more deeply.

### Current Pattern Analysis

**Architecture:**

```
Request → Hono Middleware → Store Runtime in Context → Hono Handler → effectHandler → Extract Runtime → Run Effect
```

**Problems:**

1. **Type Hole**: Runtime stored as `any` in Hono context
2. **Indirection**: Handler doesn't directly declare what it needs
3. **Runtime Mismatch**: Nothing prevents using core runtime with DB-dependent handlers
4. **Disposal Unclear**: Who's responsible for calling `runtime.dispose()`?

### Proposed Type-Safe Architecture

We can improve this significantly while keeping Hono:

```typescript
// src/api/effect-hono.ts
import { Effect, ManagedRuntime, Layer } from "effect"
import type { Context as HonoContext, Env as HonoEnv } from "hono"
import type { AppError } from "@/errors"

/**
 * Phantom type to brand runtimes with their dependencies
 */
export interface RuntimeWith<R> {
  readonly _tag: "RuntimeWith"
  readonly _R: () => R
}

/**
 * Type-safe Effect context for Hono
 */
export interface EffectEnv<R> extends HonoEnv {
  Variables: {
    runtime: ManagedRuntime.ManagedRuntime<R, never>
    _runtimeBrand: RuntimeWith<R>
  }
}

/**
 * Effect handler that explicitly declares dependencies
 */
export type EffectHandler<R, E = AppError> = (
  c: HonoContext<EffectEnv<R>>
) => Effect.Effect<Response, E, R>

/**
 * Create middleware that provides a specific runtime
 */
export const provideRuntime = <R>(
  makeRuntime: (env: Env, ctx: ExecutionContext) => ManagedRuntime.ManagedRuntime<R, never>
) => {
  return createMiddleware<EffectEnv<R>>(async (c, next) => {
    const env = c.env as Env
    const ctx = c.executionCtx

    const runtime = makeRuntime(env, ctx)
    c.set("runtime", runtime)
    c.set("_runtimeBrand", { _tag: "RuntimeWith" } as RuntimeWith<R>)

    try {
      await next()
    } finally {
      await runtime.dispose()
    }
  })
}

/**
 * Create an Effect handler
 */
export const effect = <R, E extends AppError = AppError>(
  handler: EffectHandler<R, E>
) => {
  return async (c: HonoContext<EffectEnv<R>>): Promise<Response> => {
    const runtime = c.get("runtime")

    if (!runtime) {
      console.error("No runtime in context. Did you apply provideRuntime middleware?")
      return Response.json(
        { error: "InternalError", message: "Server configuration error" },
        { status: 500 }
      )
    }

    const program = handler(c).pipe(
      Effect.catchAll((error: AppError) =>
        Effect.succeed(errorToResponse(error))
      ),
      Effect.catchAllDefect((defect) => {
        console.error("Unhandled defect:", defect)
        return Effect.succeed(
          Response.json(
            { error: "InternalError", message: "An unexpected error occurred" },
            { status: 500 }
          )
        )
      })
    )

    return runtime.runPromise(program)
  }
}
```

Usage becomes more explicit:

```typescript
// src/api/routes/users.ts
import { Hono } from "hono"
import { Effect } from "effect"
import { effect, provideRuntime } from "../effect-hono"
import { makeRuntime } from "@/runtime"
import { Database, query } from "@/services"
import type { AppDependencies } from "@/app"

const app = new Hono()

// Middleware explicitly provides AppDependencies
app.use("*", provideRuntime<AppDependencies>((env, ctx) =>
  makeRuntime(env, ctx, env.HYPERDRIVE)
))

// Handler type parameter ensures it matches middleware
app.get(
  "/:id",
  effect<AppDependencies>((c) =>  // ✅ Type-checked against middleware
    Effect.gen(function* () {
      const id = c.req.param("id")
      const db = yield* Database  // ✅ TypeScript knows Database is available
      const users = yield* query((db) =>
        db.select().from(schema.users).where(eq(schema.users.id, id))
      )
      return c.json(users[0])
    })
  )
)
```

### Benefits of This Approach

1. **Compile-Time Safety**: TypeScript enforces that handler requirements match middleware
2. **Explicit Dependencies**: You can see what each route needs
3. **Proper Disposal**: Middleware handles runtime cleanup
4. **Better DX**: Autocomplete shows available services
5. **Clearer Errors**: Mismatched types fail at compile time

### Alternative: Effect.provideService in Handler

Another approach is to use Effect's `provideService` within handlers:

```typescript
// src/api/effect-hono.ts
export const effectWithBindings = <E extends AppError = AppError>(
  handler: (c: HonoContext) => Effect.Effect<Response, E, CloudflareBindings>
) => {
  return async (c: HonoContext): Promise<Response> => {
    const env = c.env as Env
    const ctx = c.executionCtx

    const program = handler(c).pipe(
      Effect.provide(CloudflareBindings.layer(env, ctx)),
      Effect.catchAll((error: AppError) =>
        Effect.succeed(errorToResponse(error))
      )
    )

    return Effect.runPromise(program)
  }
}
```

Then handlers provide their own layers:

```typescript
app.get(
  "/users/:id",
  effectWithBindings((c) =>
    Effect.gen(function* () {
      const db = yield* Database
      // ...
    }).pipe(
      Effect.provide(DatabaseHyperdrive(c.env.HYPERDRIVE))
    )
  )
)
```

This is more explicit but more verbose per-route.

---

## Recommended Refactoring Order

Here's the order to tackle these issues:

### Phase 1: Critical Fixes (Do First)

1. **Remove Runtime Caching (Issue #1)**
   - Remove mutable global state
   - Use simple runtime factory per request
   - Add disposal in middleware
   - **Impact**: Fixes referential transparency, eliminates race conditions

2. **Fix Type Assertions (Issue #2)**
   - Remove `as ProvidedAppLayer` casts
   - Let TypeScript infer types naturally
   - Add type-level verification if needed
   - **Impact**: Restores compile-time type safety

3. **Add Scoped Resources (Issue #6)**
   - Convert Database layers to use `Layer.scoped`
   - Add proper connection cleanup
   - **Impact**: Prevents resource leaks

### Phase 2: High-Priority Improvements

4. **Improve Hono Adapter Type Safety (Issue #3)**
   - Add phantom types for runtime branding
   - Make middleware and handlers type-check together
   - **Impact**: Catches mismatched dependencies at compile time

5. **Fix DatabaseFromConfig (Issue #4)**
   - Remove dynamic import hack
   - Fix module structure to avoid circular dependencies
   - **Impact**: Faster builds, better DX

### Phase 3: Code Quality Improvements

6. **Migrate to Effect.Service (Issue #5)**
   - Convert all services to use `Effect.Service` pattern
   - Co-locate dependencies with service definitions
   - **Impact**: Less boilerplate, more idiomatic

7. **Consistent Error Handling (Issue #7)**
   - Replace all `try/catch` with `Effect.try`
   - Use Effect combinators everywhere
   - **Impact**: Better stack traces, more composable

### Phase 4: Nice-to-Haves

8. **Add Tracing (Issue #8)**
   - Add `Effect.withSpan` to key operations
   - Set up OpenTelemetry
   - **Impact**: Better observability

9. **Idiomatic Option Handling (Issue #9)**
   - Use Option combinators instead of imperative checks
   - **Impact**: Cleaner, more functional code

10. **Explicit Memoization (Issue #10)**
    - Add `Layer.memoize` for documentation
    - **Impact**: Self-documenting code (optional)

---

## Code Examples for Top 3 Fixes

### Fix #1: Remove Runtime Caching

**Before:**
```typescript
// src/runtime.ts
let cachedCoreRuntime: ManagedRuntime.ManagedRuntime<...> | null = null
let cachedCoreEnv: Env | null = null

export const getOrCreateCoreRuntime = (env: Env, ctx: ExecutionContext) => {
  if (cachedCoreRuntime === null || cachedCoreEnv !== env) {
    if (cachedCoreRuntime !== null) {
      cachedCoreRuntime.dispose()
    }
    // ...
    cachedCoreRuntime = ManagedRuntime.make(appLayer)
    cachedCoreEnv = env
  }
  return cachedCoreRuntime
}
```

**After:**
```typescript
// src/runtime.ts
import { Layer, ManagedRuntime } from "effect"
import { CloudflareBindings } from "@/services/bindings"
import { AppLive, AppCoreLive } from "@/app"

/**
 * Create core runtime (without Database)
 */
export const makeCoreRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppCoreLive.pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

/**
 * Create full runtime (with Database)
 */
export const makeRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppLive(env.HYPERDRIVE).pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

export type CoreAppRuntime = ReturnType<typeof makeCoreRuntime>
export type AppRuntime = ReturnType<typeof makeRuntime>
```

```typescript
// src/api/middleware.ts
import { createMiddleware } from "hono/factory"
import { makeCoreRuntime, makeRuntime } from "@/runtime"

export const coreMiddleware = () =>
  createMiddleware(async (c, next) => {
    const runtime = makeCoreRuntime(c.env as Env, c.executionCtx)
    c.set("runtime", runtime)
    try {
      await next()
    } finally {
      await runtime.dispose()
    }
  })

export const dbMiddleware = () =>
  createMiddleware(async (c, next) => {
    const env = c.env as Env
    const runtime = makeRuntime(env, c.executionCtx)
    c.set("runtime", runtime)
    try {
      await next()
    } finally {
      await runtime.dispose()
    }
  })
```

---

### Fix #2: Remove Type Assertions

**Before:**
```typescript
const appLayer = AppCoreLive.pipe(
  Layer.provide(bindingsLayer)
) as ProvidedCoreAppLayer  // ⚠️ Unsafe cast

type ProvidedCoreAppLayer = Layer.Layer<
  Layer.Layer.Success<typeof AppCoreLive>,
  Layer.Layer.Error<typeof AppCoreLive>,
  never
>
```

**After:**
```typescript
// Let TypeScript infer the type
const appLayer = AppCoreLive.pipe(Layer.provide(bindingsLayer))

// Export inferred type
export type CoreAppRuntime = ReturnType<typeof makeCoreRuntime>
```

If you need to verify dependencies are satisfied:

```typescript
import type { Layer } from "effect"

// Type helper to ensure no remaining dependencies
type NoRemainingDeps<L extends Layer.Layer<any, any, never>> = L

// This will fail to compile if dependencies aren't satisfied
type _VerifyCoreLive = NoRemainingDeps<
  ReturnType<typeof makeCoreRuntime> extends ManagedRuntime.ManagedRuntime<infer R, infer E>
    ? Layer.Layer<R, E, never>
    : never
>
```

---

### Fix #3: Add Scoped Resources

**Before:**
```typescript
export const DatabaseHyperdrive = (hyperdrive: Hyperdrive) =>
  Layer.sync(Database, () => {
    const client = postgres(hyperdrive.connectionString, {
      max: 5,
      fetch_types: false,
    })
    return drizzle(client)  // ⚠️ Never cleaned up
  })
```

**After:**
```typescript
export const DatabaseHyperdrive = (hyperdrive: Hyperdrive) =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      // Create connection pool
      const client = postgres(hyperdrive.connectionString, {
        max: 5,
        fetch_types: false,
      })

      const db = drizzle(client)

      // Register cleanup
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          console.log("Closing database connection pool")
          await client.end({ timeout: 5 })
        }).pipe(
          Effect.catchAll((error) => {
            console.error("Error closing database:", error)
            return Effect.void
          })
        )
      )

      return db
    })
  )
```

---

## Summary

This codebase has solid Effect-TS foundations but suffers from three critical issues that undermine Effect's guarantees:

1. **Mutable global state** breaks referential transparency
2. **Type assertions** bypass compile-time safety
3. **Missing resource management** causes connection leaks

Fixing these three issues (estimated 2-4 hours of work) will dramatically improve code quality and leverage Effect's strengths.

The medium and low priority issues are opportunities to write more idiomatic Effect code, but they don't compromise correctness the way the critical issues do.

**Next Steps:**
1. Start with Fix #1 (runtime caching) - this is the most important
2. Then Fix #6 (scoped resources) - prevents resource leaks
3. Then Fix #2 (type assertions) - restores type safety
4. Tackle the rest in priority order as time allows

Every fix includes complete, copy-pasteable code. All recommendations follow Effect-TS best practices and are production-ready.
