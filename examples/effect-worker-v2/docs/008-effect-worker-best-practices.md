# 008: Effect Worker Best Practices & Recommendations

> A comprehensive guide for building safe, standard, and maintainable Effect-TS applications on Cloudflare Workers.

## Executive Summary

This document provides expert recommendations for structuring Effect-TS applications in the Cloudflare Workers runtime. It addresses the unique constraints of the Workers environment while maximizing the benefits of Effect's type-safe, composable patterns.

---

## Table of Contents

1. [Fundamental Constraints](#1-fundamental-constraints)
2. [Runtime Architecture](#2-runtime-architecture)
3. [Service Design Patterns](#3-service-design-patterns)
4. [Layer Composition Strategies](#4-layer-composition-strategies)
5. [Error Handling Philosophy](#5-error-handling-philosophy)
6. [HTTP Handler Patterns](#6-http-handler-patterns)
7. [Resource Management](#7-resource-management)
8. [Testing Strategies](#8-testing-strategies)
9. [Performance Considerations](#9-performance-considerations)
10. [Anti-Patterns to Avoid](#10-anti-patterns-to-avoid)
11. [Recommended File Structure](#11-recommended-file-structure)
12. [Migration Checklist](#12-migration-checklist)

---

## 1. Fundamental Constraints

### 1.1 Cloudflare Workers Runtime Model

Understanding the Workers execution model is critical for correct Effect usage:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Edge Network                      │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   Isolate    │    │   Isolate    │    │   Isolate    │       │
│  │  (Request 1) │    │  (Request 2) │    │  (Request 3) │       │
│  │              │    │              │    │              │       │
│  │  - Fresh env │    │  - Fresh env │    │  - Fresh env │       │
│  │  - 128MB RAM │    │  - 128MB RAM │    │  - 128MB RAM │       │
│  │  - 30s CPU   │    │  - 30s CPU   │    │  - 30s CPU   │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

**Key constraints:**
- **No persistent global state**: Each request may run in a fresh isolate
- **Bindings available only at request time**: `env` object passed to `fetch()`
- **Limited CPU time**: 10-50ms typical, 30s maximum
- **Memory limit**: 128MB per isolate
- **No filesystem**: Use KV, R2, D1, or Durable Objects for persistence

### 1.2 Why Request-Scoped Runtime?

Effect's `ManagedRuntime` typically lives for the application lifetime. In Workers, this model breaks:

```typescript
// WRONG: Global runtime with cached bindings
let cachedRuntime: ManagedRuntime<AppLive> | null = null

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // env might be different between requests!
    if (!cachedRuntime) {
      cachedRuntime = ManagedRuntime.make(AppLive(env))
    }
    return cachedRuntime.runPromise(handleRequest(request))
  }
}
```

**Problems with caching:**
1. `env` bindings may change between deployments
2. Secrets could be stale
3. Cloudflare may recycle the isolate at any time
4. Memory leaks from accumulated state

**Correct approach: Fresh runtime per request**

```typescript
// CORRECT: Fresh runtime per request
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const bindingsLayer = CloudflareBindings.layer(env, ctx)
    const appLayer = AppCoreLive.pipe(Layer.provide(bindingsLayer))
    const managedRuntime = ManagedRuntime.make(appLayer)

    try {
      const rt = await managedRuntime.runtime()
      const handler = HttpApp.toWebHandlerRuntime(rt)(appRouter)
      return await handler(request)
    } finally {
      ctx.waitUntil(managedRuntime.dispose())
    }
  }
}
```

---

## 2. Runtime Architecture

### 2.1 The Bindings Layer Pattern

The `CloudflareBindings` service is the foundation of all other services:

```typescript
// src/services/bindings.ts
import { Context, Layer } from "effect"

export class CloudflareBindings extends Context.Tag("CloudflareBindings")<
  CloudflareBindings,
  {
    readonly env: Env
    readonly ctx: ExecutionContext
  }
>() {
  static layer(env: Env, ctx: ExecutionContext): Layer.Layer<CloudflareBindings> {
    return Layer.succeed(this, { env, ctx })
  }
}
```

**Why this pattern?**
- Single source of truth for Cloudflare bindings
- Type-safe access to `env` throughout the application
- Easy to mock for testing
- `ctx.waitUntil()` available for background tasks

### 2.2 Runtime Factory Functions

Create dedicated factory functions for different runtime configurations:

```typescript
// src/runtime.ts
import { ManagedRuntime, Layer } from "effect"
import { CloudflareBindings } from "./services/bindings"
import { AppCoreLive, AppLive } from "./app"

// Core runtime without database (lighter, faster)
export const makeCoreRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppCoreLive.pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

// Full runtime with database connection
export const makeRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppLive(env.HYPERDRIVE).pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}
```

### 2.3 Worker Entry Point Structure

```typescript
// src/worker.ts
import { ManagedRuntime } from "effect"
import { HttpApp } from "@effect/platform"
import { makeCoreRuntime } from "./runtime"
import { appRouter } from "./router"

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const managedRuntime = makeCoreRuntime(env, ctx)

    try {
      const rt = await managedRuntime.runtime()
      const handler = HttpApp.toWebHandlerRuntime(rt)(appRouter)
      return await handler(request)
    } finally {
      // CRITICAL: Dispose runtime after request completes
      ctx.waitUntil(managedRuntime.dispose())
    }
  }
}
```

---

## 3. Service Design Patterns

### 3.1 Standard Service Pattern

Use `Context.Tag` + `Layer.effect` for services that need dependencies:

```typescript
// src/services/config.ts
import { Context, Effect, Layer } from "effect"
import { CloudflareBindings } from "./bindings"
import { ConfigError } from "../errors"

// 1. Define the service interface
interface ConfigService {
  readonly get: (key: string) => Effect.Effect<string, ConfigError>
  readonly getNumber: (key: string) => Effect.Effect<number, ConfigError>
  readonly getBoolean: (key: string) => Effect.Effect<boolean, ConfigError>
}

// 2. Create the Context.Tag
export class Config extends Context.Tag("Config")<Config, ConfigService>() {}

// 3. Implement the live layer
export const ConfigLive = Layer.effect(
  Config,
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings

    return {
      get: (key: string) =>
        Effect.gen(function* () {
          const value = (env as Record<string, unknown>)[key]
          if (typeof value !== "string") {
            return yield* Effect.fail(
              new ConfigError({ key, message: `Missing or invalid config: ${key}` })
            )
          }
          return value
        }),

      getNumber: (key: string) =>
        Effect.gen(function* () {
          const str = yield* Config.get(key)
          const num = Number(str)
          if (Number.isNaN(num)) {
            return yield* Effect.fail(
              new ConfigError({ key, message: `Not a valid number: ${key}` })
            )
          }
          return num
        }),

      getBoolean: (key: string) =>
        Effect.gen(function* () {
          const str = yield* Config.get(key)
          return str === "true" || str === "1"
        }),
    }
  })
)
```

### 3.2 Multi-Binding Service Pattern

For services that access multiple Cloudflare bindings (KV namespaces, R2 buckets):

```typescript
// src/services/kv.ts
import { Context, Effect, Layer, HashMap } from "effect"
import { CloudflareBindings } from "./bindings"
import { KVError } from "../errors"

// Type-level extraction of KV binding names
type KVBindingName = {
  [K in keyof Env]: Env[K] extends KVNamespace ? K : never
}[keyof Env]

// Operations for a single KV namespace
interface KVOperations {
  readonly get: (key: string) => Effect.Effect<string | null, KVError>
  readonly set: (key: string, value: string, ttl?: number) => Effect.Effect<void, KVError>
  readonly delete: (key: string) => Effect.Effect<void, KVError>
}

// The KV service provides access to multiple namespaces
interface KVService {
  readonly from: (binding: KVBindingName) => KVOperations
}

export class KV extends Context.Tag("KV")<KV, KVService>() {}

export const KVLive = Layer.effect(
  KV,
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings

    // Cache operations per binding to avoid recreation
    const cache = new Map<string, KVOperations>()

    const makeOperations = (binding: KVBindingName): KVOperations => {
      const namespace = env[binding] as KVNamespace

      return {
        get: (key: string) =>
          Effect.tryPromise({
            try: () => namespace.get(key),
            catch: (error) =>
              new KVError({
                operation: "get",
                key,
                binding,
                cause: error instanceof Error ? error.message : String(error),
              }),
          }),

        set: (key: string, value: string, ttl?: number) =>
          Effect.tryPromise({
            try: () =>
              namespace.put(key, value, ttl ? { expirationTtl: ttl } : undefined),
            catch: (error) =>
              new KVError({
                operation: "set",
                key,
                binding,
                cause: error instanceof Error ? error.message : String(error),
              }),
          }),

        delete: (key: string) =>
          Effect.tryPromise({
            try: () => namespace.delete(key),
            catch: (error) =>
              new KVError({
                operation: "delete",
                key,
                binding,
                cause: error instanceof Error ? error.message : String(error),
              }),
          }),
      }
    }

    return {
      from: (binding: KVBindingName) => {
        if (!cache.has(binding)) {
          cache.set(binding, makeOperations(binding))
        }
        return cache.get(binding)!
      },
    }
  })
)
```

### 3.3 Database Service Pattern

For external resources like databases, use proper lifecycle management:

```typescript
// src/services/database.ts
import { Context, Effect, Layer, Scope } from "effect"
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { DatabaseError } from "../errors"

export type DrizzleClient = PostgresJsDatabase

interface DatabaseService {
  readonly client: DrizzleClient
  readonly query: <A>(
    fn: (client: DrizzleClient) => Promise<A>
  ) => Effect.Effect<A, DatabaseError>
}

export class Database extends Context.Tag("Database")<Database, DatabaseService>() {}

// Factory for different connection sources
export const DatabaseLive = (connectionString: string) =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      // Create connection with resource cleanup
      const sql = postgres(connectionString, {
        max: 5,
        idle_timeout: 20,
        connect_timeout: 10,
      })

      // Register cleanup on scope finalization
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => sql.end())
          .pipe(Effect.orDie)
      )

      const client = drizzle(sql)

      return {
        client,
        query: <A>(fn: (client: DrizzleClient) => Promise<A>) =>
          Effect.tryPromise({
            try: () => fn(client),
            catch: (error) =>
              new DatabaseError({
                operation: "query",
                cause: error instanceof Error ? error.message : String(error),
              }),
          }).pipe(Effect.withSpan("database.query")),
      }
    })
  )

// Hyperdrive variant for Cloudflare
export const DatabaseHyperdrive = (hyperdrive: Hyperdrive) =>
  DatabaseLive(hyperdrive.connectionString)
```

---

## 4. Layer Composition Strategies

### 4.1 Correct Layer Composition

Layers must be composed to share dependencies:

```typescript
// src/app.ts
import { Layer } from "effect"
import { CloudflareBindings } from "./services/bindings"
import { Config, ConfigLive } from "./services/config"
import { KV, KVLive } from "./services/kv"
import { Storage, StorageLive } from "./services/storage"
import { Database, DatabaseHyperdrive } from "./services/database"

// Core services without database
export const AppCoreLive = Layer.mergeAll(
  ConfigLive,
  KVLive,
  StorageLive
)

// Full app with database (takes Hyperdrive binding)
export const AppLive = (hyperdrive: Hyperdrive) =>
  Layer.mergeAll(
    AppCoreLive,
    DatabaseHyperdrive(hyperdrive)
  )

// Type exports for consumers
export type AppCore = Layer.Layer.Success<typeof AppCoreLive>
export type App = AppCore | Database
```

### 4.2 Layer Memoization Rules

**Critical**: Layers are memoized by reference. Reuse the same layer instance:

```typescript
// CORRECT: Single layer instance shared
const DbLayer = DatabaseLive(connectionString)
const App = Layer.mergeAll(ServiceA, ServiceB).pipe(
  Layer.provide(DbLayer)  // Same instance
)

// WRONG: Multiple instances created
const App = Layer.mergeAll(
  ServiceA.pipe(Layer.provide(DatabaseLive(connectionString))),  // Instance 1
  ServiceB.pipe(Layer.provide(DatabaseLive(connectionString)))   // Instance 2
)
```

### 4.3 Conditional Layer Composition

For optional features or environment-specific configurations:

```typescript
// src/app.ts
export const makeAppLayer = (env: Env, ctx: ExecutionContext) => {
  const bindings = CloudflareBindings.layer(env, ctx)

  // Base services always included
  let appLayer = Layer.mergeAll(ConfigLive, KVLive)

  // Conditionally add database if Hyperdrive is configured
  if (env.HYPERDRIVE) {
    appLayer = Layer.merge(appLayer, DatabaseHyperdrive(env.HYPERDRIVE))
  }

  // Conditionally add storage if R2 is configured
  if (env.ASSETS_BUCKET) {
    appLayer = Layer.merge(appLayer, StorageLive)
  }

  return appLayer.pipe(Layer.provide(bindings))
}
```

---

## 5. Error Handling Philosophy

### 5.1 Tagged Error Design

All errors should extend `Data.TaggedError` for exhaustive pattern matching:

```typescript
// src/errors/index.ts
import { Data } from "effect"

// Base context for all errors
interface ErrorContext {
  readonly message: string
  readonly cause?: string
}

export class ConfigError extends Data.TaggedError("ConfigError")<
  ErrorContext & { readonly key: string }
> {}

export class KVError extends Data.TaggedError("KVError")<
  ErrorContext & {
    readonly operation: "get" | "set" | "delete" | "list"
    readonly key: string
    readonly binding: string
  }
> {}

export class StorageError extends Data.TaggedError("StorageError")<
  ErrorContext & {
    readonly operation: "get" | "put" | "delete" | "list"
    readonly key: string
    readonly bucket: string
  }
> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<
  ErrorContext & { readonly operation: string }
> {}

export class ValidationError extends Data.TaggedError("ValidationError")<
  ErrorContext & { readonly field?: string }
> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<
  ErrorContext & { readonly resource: string; readonly id: string }
> {}

export class AuthorizationError extends Data.TaggedError("AuthorizationError")<
  ErrorContext & { readonly action: string; readonly resource: string }
> {}

// Union type for exhaustive matching
export type AppError =
  | ConfigError
  | KVError
  | StorageError
  | DatabaseError
  | ValidationError
  | NotFoundError
  | AuthorizationError
```

### 5.2 Error Handling in Routes

Use exhaustive pattern matching in error handlers:

```typescript
// src/router.ts
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import * as Errors from "./errors"

const errorToResponse = (error: Errors.AppError): HttpServerResponse.HttpServerResponse => {
  const statusMap: Record<Errors.AppError["_tag"], number> = {
    ConfigError: 500,
    KVError: 500,
    StorageError: 500,
    DatabaseError: 500,
    ValidationError: 400,
    NotFoundError: 404,
    AuthorizationError: 403,
  }

  return HttpServerResponse.json(
    {
      error: error._tag,
      message: error.message,
      ...(error._tag === "ValidationError" && error.field
        ? { field: error.field }
        : {}),
      ...(error._tag === "NotFoundError"
        ? { resource: error.resource, id: error.id }
        : {}),
    },
    { status: statusMap[error._tag] }
  )
}

export const appRouter = HttpRouter.empty.pipe(
  HttpRouter.mount("/health", healthRoutes),
  HttpRouter.mount("/users", userRoutes),
  HttpRouter.catchAll((error) => {
    // Type guard for known errors
    if (typeof error === "object" && error !== null && "_tag" in error) {
      const appError = error as Errors.AppError
      return Effect.succeed(errorToResponse(appError))
    }

    // Unknown errors
    console.error("Unhandled error:", error)
    return Effect.succeed(
      HttpServerResponse.json(
        { error: "InternalError", message: "An unexpected error occurred" },
        { status: 500 }
      )
    )
  })
)
```

### 5.3 Error Recovery Patterns

```typescript
// Specific error recovery
const getConfigWithDefault = (key: string, defaultValue: string) =>
  Config.get(key).pipe(
    Effect.catchTag("ConfigError", () => Effect.succeed(defaultValue))
  )

// Multiple error types
const handleUserRequest = (id: string) =>
  getUserById(id).pipe(
    Effect.catchTags({
      NotFoundError: () => Effect.succeed(null),
      DatabaseError: (e) => Effect.fail(new ServiceUnavailableError({ cause: e.message })),
    })
  )

// Retry with backoff for transient errors
const resilientKVGet = (binding: KVBindingName, key: string) =>
  kv.from(binding).get(key).pipe(
    Effect.retry({
      times: 3,
      schedule: Schedule.exponential("100 millis"),
    }),
    Effect.catchTag("KVError", () => Effect.succeed(null))
  )
```

---

## 6. HTTP Handler Patterns

### 6.1 Route Definition with Schema Validation

```typescript
// src/routes/users.ts
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import { Schema } from "effect"

// Define schemas
const UserIdParams = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(/^[a-z0-9-]+$/)),
})

const CreateUserBody = Schema.Struct({
  email: Schema.String.pipe(Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
})

const UserResponse = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
})

// Route handlers
export const userRoutes = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/:id",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.schemaPathParams(UserIdParams)
      const db = yield* Database

      const user = yield* db.query((client) =>
        client.select().from(users).where(eq(users.id, id)).limit(1)
      )

      if (user.length === 0) {
        return yield* Effect.fail(
          new NotFoundError({ resource: "user", id, message: `User ${id} not found` })
        )
      }

      return HttpServerResponse.schemaJson(UserResponse)(user[0])
    })
  ),

  HttpRouter.post(
    "/",
    Effect.gen(function* () {
      const body = yield* HttpServerRequest.schemaBodyJson(CreateUserBody)
      const db = yield* Database

      const [user] = yield* db.query((client) =>
        client.insert(users).values({
          id: crypto.randomUUID(),
          email: body.email,
          name: body.name,
          createdAt: new Date().toISOString(),
        }).returning()
      )

      return HttpServerResponse.schemaJson(UserResponse)(user).pipe(
        HttpServerResponse.setStatus(201)
      )
    })
  )
)
```

### 6.2 Middleware Patterns

```typescript
// src/middleware/auth.ts
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"

export const authMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const authHeader = request.headers.authorization

    if (!authHeader?.startsWith("Bearer ")) {
      return HttpServerResponse.json(
        { error: "Unauthorized", message: "Missing or invalid authorization header" },
        { status: 401 }
      )
    }

    const token = authHeader.slice(7)
    const config = yield* Config
    const apiKey = yield* config.getSecret("API_KEY")

    if (token !== apiKey) {
      return HttpServerResponse.json(
        { error: "Forbidden", message: "Invalid API key" },
        { status: 403 }
      )
    }

    return yield* app
  })
)

// Apply middleware to routes
const protectedRoutes = userRoutes.pipe(authMiddleware)
```

### 6.3 Response Helpers

```typescript
// src/utils/responses.ts
import { HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"

export const json = <A>(data: A, status = 200) =>
  Effect.succeed(HttpServerResponse.json(data, { status }))

export const created = <A>(data: A) => json(data, 201)

export const noContent = () =>
  Effect.succeed(HttpServerResponse.empty({ status: 204 }))

export const notFound = (resource: string, id: string) =>
  Effect.fail(new NotFoundError({ resource, id, message: `${resource} not found` }))
```

---

## 7. Resource Management

### 7.1 Proper Cleanup with Finalizers

```typescript
// Always register cleanup for external resources
export const DatabaseLive = (connectionString: string) =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      const sql = postgres(connectionString, { max: 5 })

      // This runs when the scope is closed
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => sql.end()).pipe(
          Effect.tap(() => Effect.logDebug("Database connection closed")),
          Effect.orDie
        )
      )

      return { client: drizzle(sql), /* ... */ }
    })
  )
```

### 7.2 Background Tasks with waitUntil

```typescript
// src/worker.ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const managedRuntime = makeCoreRuntime(env, ctx)

    try {
      const rt = await managedRuntime.runtime()
      const handler = HttpApp.toWebHandlerRuntime(rt)(appRouter)
      return await handler(request)
    } finally {
      // Cleanup happens after response is sent
      ctx.waitUntil(managedRuntime.dispose())
    }
  }
}
```

### 7.3 Scoped Resources in Effects

```typescript
// Acquire resources within a scope
const processWithTempFile = Effect.scoped(
  Effect.gen(function* () {
    const storage = yield* Storage
    const ops = storage.from("TEMP_BUCKET")

    // Create temp file
    const tempKey = `temp/${crypto.randomUUID()}`
    yield* ops.put(tempKey, "processing...")

    // Ensure cleanup even on failure
    yield* Effect.addFinalizer(() =>
      ops.delete(tempKey).pipe(Effect.orDie)
    )

    // Do work...
    return yield* doProcessing(tempKey)
  })
)
```

---

## 8. Testing Strategies

### 8.1 Mock Service Implementations

```typescript
// test/fixtures/mock-services.ts
import { Layer, Effect, HashMap, Ref } from "effect"
import { Config, KV, Storage, Database } from "../src/services"

// In-memory KV mock
export const MockKV = Layer.effect(
  KV,
  Effect.gen(function* () {
    const stores = yield* Ref.make(HashMap.empty<string, HashMap.HashMap<string, string>>())

    return {
      from: (binding: string) => ({
        get: (key: string) =>
          Ref.get(stores).pipe(
            Effect.map((s) =>
              HashMap.get(s, binding).pipe(
                Option.flatMap((store) => HashMap.get(store, key)),
                Option.getOrNull
              )
            )
          ),

        set: (key: string, value: string) =>
          Ref.update(stores, (s) => {
            const store = HashMap.get(s, binding).pipe(
              Option.getOrElse(() => HashMap.empty())
            )
            return HashMap.set(s, binding, HashMap.set(store, key, value))
          }),

        delete: (key: string) =>
          Ref.update(stores, (s) => {
            const store = HashMap.get(s, binding).pipe(
              Option.getOrElse(() => HashMap.empty())
            )
            return HashMap.set(s, binding, HashMap.remove(store, key))
          }),
      }),
    }
  })
)

// Static config mock
export const MockConfig = Layer.succeed(Config, {
  get: (key: string) => {
    const values: Record<string, string> = {
      ENVIRONMENT: "test",
      LOG_LEVEL: "debug",
      API_KEY: "test-key",
    }
    return values[key]
      ? Effect.succeed(values[key])
      : Effect.fail(new ConfigError({ key, message: "Not found" }))
  },
  getNumber: () => Effect.succeed(0),
  getBoolean: () => Effect.succeed(false),
})

// Combine mocks for testing
export const TestLayer = Layer.mergeAll(MockConfig, MockKV, MockStorage)
```

### 8.2 Route Testing Pattern

```typescript
// test/unit/routes/users.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { ManagedRuntime, Layer } from "effect"
import { HttpApp } from "@effect/platform"
import { userRoutes } from "../../../src/routes/users"
import { TestLayer } from "../../fixtures/mock-services"

describe("User Routes", () => {
  let runtime: ManagedRuntime.ManagedRuntime<any, never>
  let handler: (request: Request) => Promise<Response>

  beforeEach(async () => {
    runtime = ManagedRuntime.make(TestLayer)
    const rt = await runtime.runtime()
    handler = HttpApp.toWebHandlerRuntime(rt)(userRoutes)
  })

  afterEach(async () => {
    await runtime.dispose()
  })

  it("should return 404 for non-existent user", async () => {
    const response = await handler(
      new Request("http://test/users/non-existent")
    )

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error).toBe("NotFoundError")
  })

  it("should create user with valid data", async () => {
    const response = await handler(
      new Request("http://test/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com", name: "Test User" }),
      })
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.email).toBe("test@example.com")
  })

  it("should return 400 for invalid email", async () => {
    const response = await handler(
      new Request("http://test/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "invalid", name: "Test" }),
      })
    )

    expect(response.status).toBe(400)
  })
})
```

### 8.3 Integration Testing with Miniflare

```typescript
// test/integration/worker.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Miniflare } from "miniflare"

describe("Worker Integration", () => {
  let mf: Miniflare

  beforeAll(async () => {
    mf = new Miniflare({
      scriptPath: "./dist/worker.js",
      modules: true,
      kvNamespaces: ["CACHE_KV"],
      r2Buckets: ["ASSETS_BUCKET"],
    })
  })

  afterAll(async () => {
    await mf.dispose()
  })

  it("should respond to health check", async () => {
    const response = await mf.dispatchFetch("http://localhost/health")
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.status).toBe("healthy")
  })
})
```

---

## 9. Performance Considerations

### 9.1 Layer Evaluation Cost

Layers are evaluated once per request. Keep layer construction lightweight:

```typescript
// GOOD: Lightweight layer construction
export const ConfigLive = Layer.effect(
  Config,
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings
    return { /* service methods that use env */ }
  })
)

// AVOID: Heavy work during layer construction
export const HeavyServiceLive = Layer.effect(
  HeavyService,
  Effect.gen(function* () {
    // This runs on EVERY request
    const data = yield* Effect.promise(() => fetchLargeDataset())  // BAD
    return { data }
  })
)
```

### 9.2 Lazy Resource Acquisition

Defer expensive operations until actually needed:

```typescript
// Database connection created lazily
export const DatabaseLive = Layer.scoped(
  Database,
  Effect.gen(function* () {
    // Connection pool created here, but connections acquired lazily
    const pool = yield* makeConnectionPool()

    return {
      query: (fn) =>
        Effect.gen(function* () {
          // Connection acquired only when query is executed
          const conn = yield* pool.acquire()
          return yield* Effect.ensuring(
            Effect.tryPromise(() => fn(conn)),
            pool.release(conn)
          )
        }),
    }
  })
)
```

### 9.3 Caching Strategies

Use KV for caching expensive computations:

```typescript
const getCachedOrCompute = <A>(
  cacheKey: string,
  compute: Effect.Effect<A, AppError, AppDeps>,
  ttl: number = 300
) =>
  Effect.gen(function* () {
    const kv = yield* KV
    const ops = kv.from("CACHE_KV")

    // Try cache first
    const cached = yield* ops.get(cacheKey)
    if (cached) {
      return JSON.parse(cached) as A
    }

    // Compute and cache
    const result = yield* compute
    yield* ops.set(cacheKey, JSON.stringify(result), ttl)

    return result
  })
```

---

## 10. Anti-Patterns to Avoid

### 10.1 Global Mutable State

```typescript
// NEVER: Global mutable state
let globalRuntime: ManagedRuntime<AppLive> | null = null
let requestCount = 0

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    requestCount++  // BAD: May not persist
    if (!globalRuntime) {
      globalRuntime = ManagedRuntime.make(AppLive(env))  // BAD: Stale env
    }
    // ...
  }
}
```

### 10.2 Synchronous Blocking

```typescript
// NEVER: Blocking operations
const HeavyService = Layer.effect(
  Heavy,
  Effect.sync(() => {
    const data = heavyComputationSync()  // BAD: Blocks the event loop
    return { data }
  })
)

// CORRECT: Use async operations
const HeavyService = Layer.effect(
  Heavy,
  Effect.gen(function* () {
    const data = yield* Effect.promise(() => heavyComputationAsync())
    return { data }
  })
)
```

### 10.3 Untyped Error Handling

```typescript
// AVOID: Losing error type information
const handler = Effect.gen(function* () {
  const result = yield* someOperation().pipe(
    Effect.catchAll(() => Effect.succeed(null))  // BAD: All errors become null
  )
})

// CORRECT: Preserve error types
const handler = Effect.gen(function* () {
  const result = yield* someOperation().pipe(
    Effect.catchTag("NotFoundError", () => Effect.succeed(null)),
    // Other errors propagate with their types
  )
})
```

### 10.4 Layer Duplication

```typescript
// WRONG: Creates multiple database connections
const App = Layer.mergeAll(
  UserService.pipe(Layer.provide(DatabaseLive("..."))),
  OrderService.pipe(Layer.provide(DatabaseLive("...")))
)

// CORRECT: Share the layer instance
const DbLayer = DatabaseLive("...")
const App = Layer.mergeAll(UserService, OrderService).pipe(
  Layer.provide(DbLayer)
)
```

### 10.5 Ignoring Resource Cleanup

```typescript
// WRONG: No cleanup
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const runtime = makeRuntime(env, ctx)
    return runtime.runPromise(handleRequest(request))
    // Runtime never disposed - potential memory leak
  }
}

// CORRECT: Proper cleanup
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const runtime = makeRuntime(env, ctx)
    try {
      return await runtime.runPromise(handleRequest(request))
    } finally {
      ctx.waitUntil(runtime.dispose())  // Cleanup after response
    }
  }
}
```

---

## 11. Recommended File Structure

```
src/
├── worker.ts              # Entry point - minimal, delegates to runtime
├── runtime.ts             # ManagedRuntime factory functions
├── app.ts                 # Layer composition (AppCoreLive, AppLive)
├── router.ts              # Root HttpRouter with error handling
│
├── services/              # Service definitions
│   ├── index.ts           # Barrel exports
│   ├── types.ts           # Shared type utilities (BindingsOfType, etc.)
│   ├── bindings.ts        # CloudflareBindings service
│   ├── config.ts          # Config service
│   ├── kv.ts              # Multi-binding KV service
│   ├── storage.ts         # Multi-binding R2 service
│   └── database.ts        # Database service with Drizzle
│
├── routes/                # HTTP route handlers
│   ├── index.ts           # Route composition
│   ├── health.ts          # Health check routes
│   └── users.ts           # Domain routes
│
├── schemas/               # Effect Schema definitions
│   ├── index.ts
│   ├── user.ts
│   └── common.ts
│
├── errors/                # Tagged error definitions
│   └── index.ts
│
├── db/                    # Database schema (Drizzle)
│   ├── schema.ts
│   └── migrations/
│
└── utils/                 # Shared utilities
    ├── responses.ts       # HTTP response helpers
    └── validation.ts      # Validation utilities

test/
├── fixtures/
│   └── mock-services.ts   # Test mocks
├── unit/
│   └── routes/
│       └── users.test.ts
└── integration/
    └── worker.test.ts
```

---

## 12. Migration Checklist

When setting up a new Effect Worker project or migrating existing code:

### Phase 1: Foundation
- [ ] Create `CloudflareBindings` service
- [ ] Create runtime factory (`makeCoreRuntime`)
- [ ] Set up worker entry point with proper disposal
- [ ] Define error types in `errors/index.ts`

### Phase 2: Core Services
- [ ] Implement `Config` service
- [ ] Implement `KV` service (multi-binding pattern)
- [ ] Implement `Storage` service (multi-binding pattern)
- [ ] Create `AppCoreLive` layer composition

### Phase 3: HTTP Layer
- [ ] Set up `HttpRouter` with error handling
- [ ] Create health check routes
- [ ] Define request/response schemas
- [ ] Add domain routes

### Phase 4: Data Layer (if needed)
- [ ] Define Drizzle schema
- [ ] Implement `Database` service with proper cleanup
- [ ] Create `AppLive` with database layer
- [ ] Add database migrations

### Phase 5: Testing
- [ ] Create mock service implementations
- [ ] Write unit tests for routes
- [ ] Set up integration tests with Miniflare
- [ ] Add type tests for service interfaces

### Phase 6: Production Readiness
- [ ] Configure `wrangler.toml` with bindings
- [ ] Set up CI/CD pipeline
- [ ] Add observability (OpenTelemetry)
- [ ] Document API endpoints

---

## Conclusion

Building Effect-TS applications on Cloudflare Workers requires understanding both the Effect programming model and the Workers runtime constraints. By following these patterns:

1. **Request-scoped runtime** - Fresh `ManagedRuntime` per request
2. **Bindings as foundation** - `CloudflareBindings` service for all env access
3. **Multi-binding services** - Type-safe access to multiple KV/R2 bindings
4. **Tagged errors** - Exhaustive pattern matching for error handling
5. **Proper cleanup** - `ctx.waitUntil(runtime.dispose())` for resource cleanup
6. **Layer memoization** - Share layer instances to avoid duplication

You can build robust, type-safe, and maintainable serverless applications that fully leverage Effect's power while respecting Cloudflare's constraints.
