# 001 - Effect Worker System Design

## Overview

**Effect Worker** is a library that bridges the [Effect-TS](https://effect.website) ecosystem with the [Cloudflare Workers](https://workers.cloudflare.com) runtime. It provides an effectful, type-safe, and composable way to build serverless applications while maintaining compatibility with Cloudflare's execution model.

### Core Philosophy

1. **Everything is Effectful**: All operations are expressed as Effect types, enabling powerful composition, error handling, and dependency injection
2. **Request-Scoped Instantiation**: Services are instantiated once per request, not at worker startup
3. **Swappable Implementations**: Abstract service interfaces allow easy testing and future runtime migrations
4. **Zero Framework Lock-in**: Start with raw fetch handlers; add routing frameworks later if needed

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Runtime Constraints & Considerations](#runtime-constraints--considerations)
3. [Dependency Injection Strategy](#dependency-injection-strategy)
4. [Core Service Abstractions](#core-service-abstractions)
5. [Handler Patterns](#handler-patterns)
6. [Error Handling Strategy](#error-handling-strategy)
7. [Testing Strategy](#testing-strategy)
8. [Future Extensions](#future-extensions)

---

## Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker Runtime                        │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │   Fetch     │  │   Queue     │  │   Cron      │   (Export Layer) │
│  │   Handler   │  │   Handler   │  │   Handler   │                  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                  │
│         │                │                │                          │
│         └────────────────┼────────────────┘                          │
│                          ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                    Effect Runtime Layer                          ││
│  │  ┌─────────────────────────────────────────────────────────────┐││
│  │  │              ManagedRuntime (per-request)                   │││
│  │  │  ┌───────────────────────────────────────────────────────┐  │││
│  │  │  │                 Application Layers                     │ │││
│  │  │  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐      │ │││
│  │  │  │  │  Business   │ │  Business   │ │  Business   │      │ │││
│  │  │  │  │  Service A  │ │  Service B  │ │  Service N  │      │ │││
│  │  │  │  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘      │ │││
│  │  │  └─────────┼───────────────┼───────────────┼─────────────┘ │││
│  │  │            └───────────────┼───────────────┘               │││
│  │  │                            ▼                               │││
│  │  │  ┌───────────────────────────────────────────────────────┐ │││
│  │  │  │              Infrastructure Layers                     │ │││
│  │  │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐      │ │││
│  │  │  │  │Database │ │   KV    │ │   R2    │ │ Config  │      │ │││
│  │  │  │  │ Service │ │ Service │ │ Service │ │ Service │      │ │││
│  │  │  │  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘      │ │││
│  │  │  └───────┼───────────┼───────────┼───────────┼───────────┘ │││
│  │  │          └───────────┴───────────┴───────────┘             │││
│  │  │                            ▼                               │││
│  │  │  ┌───────────────────────────────────────────────────────┐ │││
│  │  │  │           Cloudflare Bindings Layer                    │ │││
│  │  │  │           (env: D1, KV, R2, Secrets, Variables)        │ │││
│  │  │  └───────────────────────────────────────────────────────┘ │││
│  │  └─────────────────────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### Layer Hierarchy

```
Application Layer (Business Logic)
        │
        ▼
Infrastructure Layer (Database, KV, R2, etc.)
        │
        ▼
Bindings Layer (Cloudflare Env Access)
        │
        ▼
Config Layer (Environment Variables, Secrets)
```

---

## Runtime Constraints & Considerations

### Cloudflare Workers Execution Model

Understanding the Cloudflare Workers execution model is critical for proper architecture:

| Constraint | Implication |
|------------|-------------|
| **Request-driven** | Workers are invoked per request; no long-running processes |
| **No global state persistence** | Each request may run on different isolate instances |
| **Bindings at request time** | `env` object is only available in handler context |
| **Limited CPU time** | 10ms-30ms CPU time per request (varies by plan) |
| **Memory limits** | 128MB per isolate |
| **No filesystem** | Must use KV, R2, or D1 for persistence |

### Why This Matters for Effect

Traditional Effect applications bootstrap layers at startup and reuse them across requests. **This doesn't work in Cloudflare Workers** because:

1. **No startup phase**: There's no guaranteed "module initialization" that runs before all requests
2. **Env not available globally**: Cloudflare bindings are passed to each handler invocation
3. **Stateless isolates**: Cannot assume previous request's state is available

### Our Solution: Request-Scoped ManagedRuntime

```typescript
// ❌ WRONG: Creating runtime at module level
const runtime = ManagedRuntime.make(AppLive) // env not available here!

// ✅ CORRECT: Creating runtime per-request with env
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const runtime = makeFetchRuntime(env)
    return runtime.runPromise(handleRequest(request))
  }
}
```

---

## Dependency Injection Strategy

### Core Principle: Single Instantiation Per Request

Effect's **Layer Memoization** ensures that within a single request's runtime, each service is instantiated exactly once, regardless of how many times it's referenced in the dependency graph.

```typescript
// Both ServiceA and ServiceB depend on Database
// Database is only instantiated ONCE per request

const AppLive = Layer.mergeAll(
  ServiceA.Default,  // depends on Database
  ServiceB.Default,  // depends on Database
).pipe(
  Layer.provide(Database.Default),  // Database instantiated once
  Layer.provide(Bindings.Default),
)
```

### Layer Memoization Rules

1. **Reference Equality**: Layers are memoized by reference. Always reuse the same layer instance:

```typescript
// ✅ Good: Single layer instance reused
const DbLive = Database.Default

const App = Layer.mergeAll(
  ServiceA.Default.pipe(Layer.provide(DbLive)),
  ServiceB.Default.pipe(Layer.provide(DbLive)),
)

// ❌ Bad: New layer instance each time
const App = Layer.mergeAll(
  ServiceA.Default.pipe(Layer.provide(Database.Default)), // new instance
  ServiceB.Default.pipe(Layer.provide(Database.Default)), // another instance!
)
```

2. **Fresh Layers**: Use `Layer.fresh` only when you explicitly need separate instances

### The Bindings Layer Pattern

Since Cloudflare's `env` object is only available at request time, we create a special **Bindings Layer** that:

1. Accepts the `env` object at construction time
2. Provides type-safe access to all bindings
3. Serves as the foundation for all other services

```typescript
// Definition
export class CloudflareBindings extends Context.Tag("CloudflareBindings")<
  CloudflareBindings,
  {
    readonly env: Env
    readonly ctx: ExecutionContext
  }
>() {
  static layer(env: Env, ctx: ExecutionContext) {
    return Layer.succeed(this, { env, ctx })
  }
}

// Usage in other services
export class KVStore extends Effect.Service<KVStore>()("KVStore", {
  effect: Effect.gen(function* () {
    const { env } = yield* CloudflareBindings
    const kv = env.MY_KV_NAMESPACE

    return {
      get: (key: string) => Effect.tryPromise(() => kv.get(key)),
      set: (key: string, value: string) =>
        Effect.tryPromise(() => kv.put(key, value)),
    }
  }),
  dependencies: [CloudflareBindings.Default],
}) {}
```

---

## Core Service Abstractions

### 1. Configuration Service

Abstracts access to environment variables and secrets.

```typescript
// Types
interface ConfigService {
  readonly get: (key: string) => Effect.Effect<string, ConfigError>
  readonly getSecret: (key: string) => Effect.Effect<string, ConfigError>
  readonly getNumber: (key: string) => Effect.Effect<number, ConfigError>
  readonly getBoolean: (key: string) => Effect.Effect<boolean, ConfigError>
  readonly getJson: <T>(key: string, schema: Schema.Schema<T>) => Effect.Effect<T, ConfigError>
}

// Implementation using Cloudflare env
export class Config extends Effect.Service<Config>()("Config", {
  effect: Effect.gen(function* () {
    const { env } = yield* CloudflareBindings

    return {
      get: (key: string) =>
        Effect.fromNullable(env[key]).pipe(
          Effect.mapError(() => new ConfigError({ key, message: "Not found" }))
        ),

      getSecret: (key: string) =>
        Effect.fromNullable(env[key]).pipe(
          Effect.mapError(() => new ConfigError({ key, message: "Secret not found" }))
        ),

      getNumber: (key: string) =>
        Effect.gen(function* () {
          const value = yield* Config.get(key)
          const num = Number(value)
          if (Number.isNaN(num)) {
            return yield* Effect.fail(new ConfigError({ key, message: "Not a number" }))
          }
          return num
        }),

      getBoolean: (key: string) =>
        Effect.gen(function* () {
          const value = yield* Config.get(key)
          return value === "true" || value === "1"
        }),

      getJson: <T>(key: string, schema: Schema.Schema<T>) =>
        Effect.gen(function* () {
          const value = yield* Config.get(key)
          return yield* Schema.decodeUnknown(schema)(JSON.parse(value))
        }),
    }
  }),
  dependencies: [CloudflareBindings.Default],
}) {}
```

**Future Extensibility**: When migrating to a different runtime, only the implementation changes:

```typescript
// For Node.js/Bun runtime
export class Config extends Effect.Service<Config>()("Config", {
  effect: Effect.gen(function* () {
    return {
      get: (key: string) => Effect.sync(() => process.env[key]),
      // ...
    }
  }),
}) {}
```

### 2. Database Service (Drizzle Abstraction)

Provides a swappable database abstraction using Drizzle ORM.

```typescript
// Abstract interface - what users interact with
interface DatabaseService<TSchema extends Record<string, unknown>> {
  readonly client: DrizzleClient<TSchema>
  readonly transaction: <A, E>(
    effect: (tx: Transaction<TSchema>) => Effect.Effect<A, E>
  ) => Effect.Effect<A, E | DatabaseError>
}

// The tag (interface)
export class Database extends Context.Tag("Database")<
  Database,
  DatabaseService<typeof schema>
>() {}

// D1 Implementation (Cloudflare)
export const DatabaseD1Live = Layer.effect(
  Database,
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings
    const d1 = env.DB // D1Database binding

    const client = drizzle(d1, { schema })

    return {
      client,
      transaction: <A, E>(
        effect: (tx: Transaction<typeof schema>) => Effect.Effect<A, E>
      ) =>
        Effect.tryPromise({
          try: () =>
            client.transaction(async (tx) => {
              // Run effect within transaction context
              const txLayer = Layer.succeed(Database, {
                client: tx as any,
                transaction: effect
              })
              const runtime = ManagedRuntime.make(txLayer)
              return runtime.runPromise(effect(tx))
            }),
          catch: (e) => new DatabaseError({ cause: e }),
        }),
    }
  })
).pipe(Layer.provide(CloudflareBindings.Default))

// PostgreSQL Implementation (for local dev or migration)
export const DatabasePgLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const config = yield* Config
    const connectionString = yield* config.get("DATABASE_URL")

    const pool = new Pool({ connectionString })
    const client = drizzle(pool, { schema })

    return {
      client,
      transaction: <A, E>(
        effect: (tx: Transaction<typeof schema>) => Effect.Effect<A, E>
      ) =>
        Effect.tryPromise({
          try: () => client.transaction(async (tx) => {
            // Similar transaction handling
          }),
          catch: (e) => new DatabaseError({ cause: e }),
        }),
    }
  })
).pipe(Layer.provide(Config.Default))
```

**User Swappability**: Users select their implementation at the application boundary:

```typescript
// Production (Cloudflare D1)
const AppLive = AppLayer.pipe(
  Layer.provide(DatabaseD1Live)
)

// Development (PostgreSQL)
const AppLive = AppLayer.pipe(
  Layer.provide(DatabasePgLive)
)

// Testing (In-memory)
const AppTest = AppLayer.pipe(
  Layer.provide(DatabaseTestLive)
)
```

### 3. Key-Value Store Service

Abstract KV storage that can be backed by Cloudflare KV, Redis, or in-memory stores.

```typescript
// Abstract interface
interface KVService {
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, KVError>
  readonly getWithMetadata: <T>(
    key: string,
    schema: Schema.Schema<T>
  ) => Effect.Effect<Option.Option<{ value: string; metadata: T }>, KVError>
  readonly set: (
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown }
  ) => Effect.Effect<void, KVError>
  readonly delete: (key: string) => Effect.Effect<void, KVError>
  readonly list: (options?: { prefix?: string; limit?: number }) =>
    Effect.Effect<Array<{ key: string }>, KVError>
}

export class KVStore extends Context.Tag("KVStore")<KVStore, KVService>() {}

// Cloudflare KV Implementation
export const KVStoreCloudflare = (namespace: keyof Env) =>
  Layer.effect(
    KVStore,
    Effect.gen(function* () {
      const { env } = yield* CloudflareBindings
      const kv = env[namespace] as KVNamespace

      return {
        get: (key: string) =>
          Effect.tryPromise({
            try: () => kv.get(key),
            catch: (e) => new KVError({ operation: "get", key, cause: e }),
          }).pipe(Effect.map(Option.fromNullable)),

        getWithMetadata: <T>(key: string, schema: Schema.Schema<T>) =>
          Effect.tryPromise({
            try: () => kv.getWithMetadata(key),
            catch: (e) => new KVError({ operation: "getWithMetadata", key, cause: e }),
          }).pipe(
            Effect.flatMap((result) =>
              result.value === null
                ? Effect.succeed(Option.none())
                : Schema.decodeUnknown(schema)(result.metadata).pipe(
                    Effect.map((metadata) =>
                      Option.some({ value: result.value, metadata })
                    )
                  )
            )
          ),

        set: (key: string, value: string, options) =>
          Effect.tryPromise({
            try: () => kv.put(key, value, options),
            catch: (e) => new KVError({ operation: "set", key, cause: e }),
          }),

        delete: (key: string) =>
          Effect.tryPromise({
            try: () => kv.delete(key),
            catch: (e) => new KVError({ operation: "delete", key, cause: e }),
          }),

        list: (options) =>
          Effect.tryPromise({
            try: () => kv.list(options),
            catch: (e) => new KVError({ operation: "list", cause: e }),
          }).pipe(Effect.map((result) => result.keys)),
      }
    })
  ).pipe(Layer.provide(CloudflareBindings.Default))

// Redis Implementation (for future migration)
export const KVStoreRedis = Layer.effect(
  KVStore,
  Effect.gen(function* () {
    const config = yield* Config
    const url = yield* config.get("REDIS_URL")
    // Redis implementation...
  })
)

// In-Memory Implementation (for testing)
export const KVStoreMemory = Layer.sync(KVStore, () => {
  const store = new Map<string, { value: string; metadata?: unknown }>()

  return {
    get: (key: string) =>
      Effect.sync(() => Option.fromNullable(store.get(key)?.value)),
    // ... other methods
  }
})
```

### 4. Object Storage Service (R2 Abstraction)

```typescript
interface ObjectStorageService {
  readonly get: (key: string) => Effect.Effect<Option.Option<R2ObjectBody>, StorageError>
  readonly put: (
    key: string,
    value: ReadableStream | ArrayBuffer | string,
    options?: R2PutOptions
  ) => Effect.Effect<R2Object, StorageError>
  readonly delete: (key: string) => Effect.Effect<void, StorageError>
  readonly list: (options?: R2ListOptions) => Effect.Effect<R2Objects, StorageError>
  readonly head: (key: string) => Effect.Effect<Option.Option<R2Object>, StorageError>
}

export class ObjectStorage extends Context.Tag("ObjectStorage")<
  ObjectStorage,
  ObjectStorageService
>() {}

// Cloudflare R2 Implementation
export const ObjectStorageR2 = (bucket: keyof Env) =>
  Layer.effect(
    ObjectStorage,
    Effect.gen(function* () {
      const { env } = yield* CloudflareBindings
      const r2 = env[bucket] as R2Bucket

      return {
        get: (key: string) =>
          Effect.tryPromise({
            try: () => r2.get(key),
            catch: (e) => new StorageError({ operation: "get", key, cause: e }),
          }).pipe(Effect.map(Option.fromNullable)),

        put: (key, value, options) =>
          Effect.tryPromise({
            try: () => r2.put(key, value, options),
            catch: (e) => new StorageError({ operation: "put", key, cause: e }),
          }),

        delete: (key: string) =>
          Effect.tryPromise({
            try: () => r2.delete(key),
            catch: (e) => new StorageError({ operation: "delete", key, cause: e }),
          }),

        list: (options) =>
          Effect.tryPromise({
            try: () => r2.list(options),
            catch: (e) => new StorageError({ operation: "list", cause: e }),
          }),

        head: (key: string) =>
          Effect.tryPromise({
            try: () => r2.head(key),
            catch: (e) => new StorageError({ operation: "head", key, cause: e }),
          }).pipe(Effect.map(Option.fromNullable)),
      }
    })
  ).pipe(Layer.provide(CloudflareBindings.Default))

// S3-Compatible Implementation (for migration)
export const ObjectStorageS3 = Layer.effect(
  ObjectStorage,
  Effect.gen(function* () {
    const config = yield* Config
    // S3 client setup...
  })
)
```

---

## Handler Patterns

### Fetch Handler

The primary entry point for HTTP requests.

```typescript
// src/worker.ts
import { Effect, Layer, ManagedRuntime, ConfigProvider } from "effect"
import { CloudflareBindings } from "./services/bindings"
import { AppLive } from "./app"

// Type for Cloudflare Worker Env
interface Env {
  DB: D1Database
  MY_KV: KVNamespace
  MY_BUCKET: R2Bucket
  API_KEY: string
  // ... other bindings
}

// Create runtime factory
const makeRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppLive.pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

// Main fetch handler
const handleFetch = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Effect.Effect<Response, never, AppDependencies> =>
  Effect.gen(function* () {
    const url = new URL(request.url)

    // Route handling (basic example)
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 })
    }

    if (url.pathname.startsWith("/api/")) {
      return yield* handleApiRequest(request)
    }

    return new Response("Not Found", { status: 404 })
  }).pipe(
    // Error handling
    Effect.catchAll((error) =>
      Effect.succeed(
        new Response(JSON.stringify({ error: String(error) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      )
    )
  )

// Export for Cloudflare
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const runtime = makeRuntime(env, ctx)

    const program = handleFetch(request, env, ctx).pipe(
      Effect.withConfigProvider(ConfigProvider.fromJson(env))
    )

    try {
      return await runtime.runPromise(program)
    } finally {
      // Cleanup runtime resources
      await runtime.dispose()
    }
  },
}
```

### Optimized Runtime Pattern (Singleton per Isolate)

For better performance, we can cache the runtime at the isolate level:

```typescript
// Runtime cache per isolate (not per request)
let cachedRuntime: ManagedRuntime<AppDependencies> | null = null
let cachedEnv: Env | null = null

const getOrCreateRuntime = (env: Env, ctx: ExecutionContext) => {
  // Only recreate if env reference changes (new isolate)
  if (cachedRuntime === null || cachedEnv !== env) {
    if (cachedRuntime !== null) {
      // Dispose old runtime
      cachedRuntime.dispose()
    }
    cachedEnv = env
    cachedRuntime = makeRuntime(env, ctx)
  }
  return cachedRuntime
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const runtime = getOrCreateRuntime(env, ctx)
    // ... handle request
  },
}
```

### Queue Handler (Future)

```typescript
export default {
  // ... fetch handler

  async queue(
    batch: MessageBatch<QueueMessage>,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const runtime = makeRuntime(env, ctx)

    const program = Effect.forEach(
      batch.messages,
      (message) => handleQueueMessage(message),
      { concurrency: 5 }
    )

    await runtime.runPromise(program)
  },
}
```

### Scheduled Handler (Cron) (Future)

```typescript
export default {
  // ... other handlers

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const runtime = makeRuntime(env, ctx)

    const program = Effect.gen(function* () {
      // Cron job logic
      yield* runScheduledTasks(event.cron)
    })

    ctx.waitUntil(runtime.runPromise(program))
  },
}
```

---

## Error Handling Strategy

### Typed Errors

All errors are explicitly typed and extend a base error class:

```typescript
import { Data } from "effect"

// Base error class
export class WorkerError extends Data.TaggedError("WorkerError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// Specific errors
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly key: string
  readonly message: string
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export class KVError extends Data.TaggedError("KVError")<{
  readonly operation: string
  readonly key?: string
  readonly cause: unknown
}> {}

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: string
  readonly key?: string
  readonly cause: unknown
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string
  readonly errors: ReadonlyArray<unknown>
}> {}
```

### Error Recovery Patterns

```typescript
// Pattern 1: Fallback value
const getConfigWithDefault = (key: string, defaultValue: string) =>
  Config.get(key).pipe(
    Effect.orElseSucceed(() => defaultValue)
  )

// Pattern 2: Retry with backoff
const resilientDbQuery = <A>(query: Effect.Effect<A, DatabaseError>) =>
  query.pipe(
    Effect.retry({
      times: 3,
      schedule: Schedule.exponential("100 millis"),
    })
  )

// Pattern 3: Circuit breaker (future)
const protectedExternalCall = <A>(call: Effect.Effect<A, Error>) =>
  call.pipe(
    // Implement circuit breaker logic
  )
```

### HTTP Error Responses

```typescript
const errorToResponse = (error: WorkerError): Response => {
  const status = Match.value(error).pipe(
    Match.tag("ConfigError", () => 500),
    Match.tag("DatabaseError", () => 503),
    Match.tag("KVError", () => 503),
    Match.tag("ValidationError", () => 400),
    Match.orElse(() => 500)
  )

  return new Response(
    JSON.stringify({
      error: error._tag,
      message: error.message,
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  )
}
```

---

## Testing Strategy

### Unit Testing Services

```typescript
import { Effect, Layer } from "effect"
import { describe, it, expect } from "vitest"

describe("KVStore", () => {
  const testLayer = KVStoreMemory

  it("should get and set values", async () => {
    const program = Effect.gen(function* () {
      const kv = yield* KVStore

      yield* kv.set("test-key", "test-value")
      const result = yield* kv.get("test-key")

      return result
    }).pipe(Effect.provide(testLayer))

    const result = await Effect.runPromise(program)
    expect(result).toEqual(Option.some("test-value"))
  })
})
```

### Integration Testing with Miniflare

```typescript
import { Miniflare } from "miniflare"
import { describe, it, expect, beforeAll, afterAll } from "vitest"

describe("Worker Integration", () => {
  let mf: Miniflare

  beforeAll(async () => {
    mf = new Miniflare({
      script: `export default { fetch: () => new Response("OK") }`,
      kvNamespaces: ["MY_KV"],
      d1Databases: ["DB"],
    })
  })

  afterAll(async () => {
    await mf.dispose()
  })

  it("should handle requests", async () => {
    const response = await mf.dispatchFetch("http://localhost/health")
    expect(response.status).toBe(200)
  })
})
```

### Mocking Services

```typescript
// Create mock implementations for testing
const MockDatabase = Layer.succeed(Database, {
  client: mockDrizzleClient,
  transaction: (effect) => effect(mockTx),
})

const MockConfig = Layer.succeed(Config, {
  get: (key) =>
    key === "API_KEY"
      ? Effect.succeed("test-key")
      : Effect.fail(new ConfigError({ key, message: "Not found" })),
  // ... other methods
})

// Use in tests
const testLayer = AppLive.pipe(
  Layer.provide(MockDatabase),
  Layer.provide(MockConfig),
)
```

---

## Future Extensions

### 1. Routing Framework Integration

While this initial design uses raw fetch handlers, we can add framework support:

```typescript
// Hono integration
import { Hono } from "hono"
import { effectMiddleware } from "./middleware"

const app = new Hono<{ Bindings: Env }>()

app.use("*", effectMiddleware())

app.get("/api/users", (c) => {
  return c.effect(
    Effect.gen(function* () {
      const db = yield* Database
      const users = yield* db.client.select().from(users)
      return c.json(users)
    })
  )
})
```

### 2. Durable Objects Integration

```typescript
export class DurableCounter extends DurableObject {
  private runtime: ManagedRuntime<CounterDeps>

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.runtime = makeRuntime(env)
  }

  async fetch(request: Request): Promise<Response> {
    const program = handleCounterRequest(request)
    return this.runtime.runPromise(program)
  }
}
```

### 3. WebSocket Support

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (request.headers.get("Upgrade") === "websocket") {
      return handleWebSocket(request, env, ctx)
    }
    // ... normal request handling
  },
}
```

### 4. OpenTelemetry Integration

```typescript
import { NodeSdk } from "@effect/opentelemetry"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"

const TracingLive = NodeSdk.layer(() => ({
  resource: {
    serviceName: "effect-worker",
  },
  spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
}))

const AppWithTracing = AppLive.pipe(Layer.provide(TracingLive))
```

---

## Project Structure

```
effect-worker/
├── src/
│   ├── worker.ts              # Main entry point (export default)
│   ├── app.ts                 # Application layer composition
│   ├── services/
│   │   ├── bindings.ts        # CloudflareBindings service
│   │   ├── config.ts          # Config service
│   │   ├── database.ts        # Database service (Drizzle)
│   │   ├── kv.ts              # KV Store service
│   │   ├── storage.ts         # Object Storage (R2) service
│   │   └── index.ts           # Re-exports
│   ├── handlers/
│   │   ├── fetch.ts           # Fetch handler logic
│   │   ├── queue.ts           # Queue handler logic
│   │   └── scheduled.ts       # Cron handler logic
│   ├── errors/
│   │   └── index.ts           # Error definitions
│   └── db/
│       ├── schema.ts          # Drizzle schema
│       └── migrations/        # Database migrations
├── test/
│   ├── unit/
│   └── integration/
├── docs/
│   └── 001-system-design.md   # This document
├── wrangler.toml              # Cloudflare configuration
├── package.json
└── tsconfig.json
```

---

## Summary

This design provides:

1. **Type-safe dependency injection** using Effect's Layer system
2. **Request-scoped instantiation** that respects Cloudflare's execution model
3. **Single service instantiation** per request via Layer memoization
4. **Swappable implementations** for all infrastructure services
5. **Future-proof architecture** that can adapt to new runtimes or frameworks

The key insight is that we build the runtime per-request (or per-isolate with caching), allowing us to inject Cloudflare bindings into Effect's layer system while maintaining all the benefits of Effect's composition and error handling.

---

## References

- [Effect Documentation](https://effect.website/docs/)
- [Layer Memoization](https://effect.website/docs/requirements-management/layer-memoization/)
- [ManagedRuntime](https://effect-ts.github.io/effect/effect/ManagedRuntime.ts.html)
- [Cloudflare Workers Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
- [Why Workers Environment Variables Contain Live Objects](https://blog.cloudflare.com/workers-environment-live-object-bindings/)
- [Running Effect-TS in Cloudflare Workers Without the Pain](https://dev.to/mmmoli/running-effect-ts-in-cloudflare-workers-without-the-pain-40a0)
- [@effect/sql-drizzle Integration](https://effect.website/docs/platform/key-value-store/)
- [Effect-TS GitHub Issue #4636 - Cloudflare Integration](https://github.com/Effect-TS/effect/issues/4636)
