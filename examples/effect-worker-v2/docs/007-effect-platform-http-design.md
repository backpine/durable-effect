# 007 - Effect Platform HTTP Router Design

## Overview

This document explores using `@effect/platform`'s HttpRouter as an alternative to Hono for building HTTP APIs in Cloudflare Workers. The @effect/platform package provides a fully Effect-native approach to HTTP routing with built-in support for:

- Composable routers
- Type-safe path parameters
- Schema-based request/response validation
- Effect-native error handling
- Dependency injection via Context
- Native web handler conversion

## Current Architecture (Hono)

Currently, the project uses Hono as the HTTP router with an `effectHandler` adapter:

```typescript
// src/api/routes/users.ts
import { Hono } from "hono"
import { effectHandler } from "../effect"

const app = new Hono()

app.get("/:id", effectHandler<AppDependencies>((c) =>
  Effect.gen(function* () {
    const id = c.req.param("id")
    const storage = yield* Storage
    // ... business logic
    return c.json({ id })
  })
))
```

**Limitations:**
- Hono context (`c`) mixes with Effect context
- Manual adapter required for Effect integration
- Path parameters accessed via Hono API, not Effect
- Error handling split between Hono and Effect

## @effect/platform HttpRouter API

### Core Concepts

#### 1. HttpRouter

An `HttpRouter` is both an Effect and a composable data structure:

```typescript
import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"

const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", Effect.succeed(HttpServerResponse.text("OK"))),
  HttpRouter.get("/users/:id",
    Effect.gen(function* () {
      const { params } = yield* HttpRouter.RouteContext
      return HttpServerResponse.json({ id: params.id })
    })
  )
)
```

#### 2. Route Context

Path parameters and route info are provided via `RouteContext`:

```typescript
const handler = Effect.gen(function* () {
  const { params } = yield* HttpRouter.RouteContext
  const id = params.id // string | undefined
  // ...
})
```

#### 3. Schema-based Path Params

For type-safe parameters:

```typescript
import { Schema } from "@effect/schema"

const UserIdParams = Schema.Struct({
  id: Schema.UUID
})

const handler = Effect.gen(function* () {
  const { id } = yield* HttpRouter.schemaPathParams(UserIdParams)
  // id is now typed as UUID
})
```

#### 4. Server Request

Access the full request via `HttpServerRequest`:

```typescript
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const body = yield* request.json
  const headers = request.headers
  // ...
})
```

#### 5. Server Response

Construct responses with `HttpServerResponse`:

```typescript
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"

// Text response
HttpServerResponse.text("Hello")

// JSON response
HttpServerResponse.json({ data: "value" })

// With status code
HttpServerResponse.json({ error: "Not Found" }, { status: 404 })

// With headers
HttpServerResponse.json(data).pipe(
  HttpServerResponse.setHeader("X-Custom", "value")
)

// Schema-validated JSON
HttpServerResponse.schemaJson(UserSchema)(user)

// Streaming
HttpServerResponse.stream(myStream)
```

## Cloudflare Workers Integration

### Converting to Web Handler

The key is `HttpApp.toWebHandlerRuntime` which creates a web-standard handler:

```typescript
import * as HttpApp from "@effect/platform/HttpApp"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { Layer } from "effect"
import { CloudflareBindings } from "@/services"
import { AppLive } from "@/app"

// Create runtime with all dependencies
const makeRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppLive(env.HYPERDRIVE).pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

// Create handler from runtime
const makeHandler = <R>(runtime: ManagedRuntime.ManagedRuntime<R, never>) =>
  HttpApp.toWebHandlerRuntime(runtime)(router)

// Usage in fetch handler
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const runtime = makeRuntime(env, ctx)
    const handler = makeHandler(runtime)
    try {
      return await handler(request)
    } finally {
      ctx.waitUntil(runtime.disposeEffect.pipe(Effect.runPromise))
    }
  }
}
```

## Proposed Architecture

### Project Structure

```
src/
├── worker.ts              # Entry point
├── router.ts              # Main router composition
├── app.ts                 # Application layer (unchanged)
├── routes/
│   ├── index.ts           # Route composition
│   ├── health.ts          # Health routes
│   ├── users.ts           # User routes
│   └── schemas.ts         # Shared schemas
├── services/              # Services (unchanged)
└── errors/                # Error definitions (unchanged)
```

### Route Definition Pattern

#### routes/schemas.ts

```typescript
import { Schema } from "@effect/schema"

// ---------------------------------------------------------------------------
// Path Parameters
// ---------------------------------------------------------------------------

export const UserIdParams = Schema.Struct({
  id: Schema.String
})

// ---------------------------------------------------------------------------
// Request Bodies
// ---------------------------------------------------------------------------

export const CreateUserBody = Schema.Struct({
  email: Schema.String.pipe(
    Schema.pattern(/@/, { message: () => "Invalid email format" })
  ),
  name: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Name is required" })
  ),
  age: Schema.optional(
    Schema.Number.pipe(Schema.positive())
  )
})

export const UpdateUserBody = Schema.Struct({
  email: Schema.optional(Schema.String.pipe(Schema.pattern(/@/))),
  name: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  age: Schema.optional(Schema.Number.pipe(Schema.positive()))
})

export const CreatePostBody = Schema.Struct({
  title: Schema.String.pipe(Schema.minLength(1)),
  content: Schema.String,
  tags: Schema.optional(Schema.Array(Schema.String))
})

// ---------------------------------------------------------------------------
// Response Schemas
// ---------------------------------------------------------------------------

export const UserResponse = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  createdAt: Schema.String
})

export const UsersListResponse = Schema.Struct({
  users: Schema.Array(UserResponse),
  total: Schema.Number
})
```

#### routes/health.ts

```typescript
import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import { Effect } from "effect"
import { Config } from "@/services"

export const healthRoutes = HttpRouter.empty.pipe(
  HttpRouter.get("/",
    Effect.gen(function* () {
      return HttpServerResponse.json({
        status: "healthy",
        timestamp: new Date().toISOString()
      })
    })
  ),

  HttpRouter.get("/config",
    Effect.gen(function* () {
      const config = yield* Config
      const env = yield* config.getOrElse("ENVIRONMENT", "unknown")
      return HttpServerResponse.json({ environment: env })
    })
  )
)
```

#### routes/users.ts

```typescript
import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import { Effect, Option } from "effect"
import { Storage, KV, Database } from "@/services"
import { NotFoundError } from "@/errors"
import { UserIdParams, CreateUserBody, UpdateUserBody, UserResponse } from "./schemas"

export const usersRoutes = HttpRouter.empty.pipe(
  // ---------------------------------------------------------------------------
  // GET /users - List all users
  // ---------------------------------------------------------------------------
  HttpRouter.get("/",
    Effect.gen(function* () {
      const db = yield* Database
      // const users = yield* db.query(...)
      return HttpServerResponse.json({ users: [], total: 0 })
    })
  ),

  // ---------------------------------------------------------------------------
  // GET /users/:id - Get user by ID
  // ---------------------------------------------------------------------------
  HttpRouter.get("/:id",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.schemaPathParams(UserIdParams)
      const db = yield* Database

      // const user = yield* db.query(...)
      // if (!user) return yield* Effect.fail(new NotFoundError({ resource: "User", id }))

      return yield* Effect.fail(new NotFoundError({ resource: "User", id }))
    })
  ),

  // ---------------------------------------------------------------------------
  // POST /users - Create new user
  // ---------------------------------------------------------------------------
  HttpRouter.post("/",
    Effect.gen(function* () {
      // Schema validates and parses the body automatically
      // Returns ParseError if validation fails
      const body = yield* HttpServerRequest.schemaBodyJson(CreateUserBody)
      const db = yield* Database

      // body is now typed: { email: string, name: string, age?: number }
      const user = {
        id: crypto.randomUUID(),
        email: body.email,
        name: body.name,
        createdAt: new Date().toISOString()
      }

      // const inserted = yield* db.insert(...)

      // Validate response matches schema (optional but recommended)
      return yield* HttpServerResponse.schemaJson(UserResponse)(user)
    })
  ),

  // ---------------------------------------------------------------------------
  // PUT /users/:id - Update user
  // ---------------------------------------------------------------------------
  HttpRouter.put("/:id",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.schemaPathParams(UserIdParams)
      const body = yield* HttpServerRequest.schemaBodyJson(UpdateUserBody)
      const db = yield* Database

      // body is typed: { email?: string, name?: string, age?: number }

      // const user = yield* db.update(...)
      // if (!user) return yield* Effect.fail(new NotFoundError({ resource: "User", id }))

      return HttpServerResponse.json({ id, ...body, updated: true })
    })
  ),

  // ---------------------------------------------------------------------------
  // DELETE /users/:id - Delete user
  // ---------------------------------------------------------------------------
  HttpRouter.del("/:id",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.schemaPathParams(UserIdParams)
      const db = yield* Database

      // const deleted = yield* db.delete(...)
      // if (!deleted) return yield* Effect.fail(new NotFoundError({ resource: "User", id }))

      return HttpServerResponse.json({ deleted: true, id })
    })
  ),

  // ---------------------------------------------------------------------------
  // GET /users/:id/avatar - Get user avatar from Object Storage
  // ---------------------------------------------------------------------------
  HttpRouter.get("/:id/avatar",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.schemaPathParams(UserIdParams)
      const storage = yield* Storage

      const key = `users/${id}/avatar`
      const file = yield* storage.from("MY_BUCKET").get(key)

      return yield* Option.match(file, {
        onNone: () => Effect.fail(new NotFoundError({ resource: "Avatar", id })),
        onSome: (body) => Effect.succeed(
          HttpServerResponse.raw(body.body, {
            headers: {
              "Content-Type": body.httpMetadata?.contentType ?? "image/png",
              "ETag": body.httpEtag,
              "Cache-Control": "public, max-age=3600"
            }
          })
        )
      })
    })
  ),

  // ---------------------------------------------------------------------------
  // GET /users/:id/preferences - Get user preferences from KV
  // ---------------------------------------------------------------------------
  HttpRouter.get("/:id/preferences",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.schemaPathParams(UserIdParams)
      const kv = yield* KV

      const key = `user:${id}:preferences`
      const value = yield* kv.from("MY_KV").get(key)

      return yield* Option.match(value, {
        onNone: () => Effect.succeed(
          HttpServerResponse.json({
            userId: id,
            preferences: { theme: "light", notifications: true, language: "en" },
            isDefault: true
          })
        ),
        onSome: (v) => Effect.succeed(
          HttpServerResponse.json({
            userId: id,
            preferences: JSON.parse(v),
            isDefault: false
          })
        )
      })
    })
  )
)
```

### Router Composition

#### routes/index.ts

```typescript
import * as HttpRouter from "@effect/platform/HttpRouter"
import { healthRoutes } from "./health"
import { usersRoutes } from "./users"

export const routes = HttpRouter.empty.pipe(
  // Mount health routes at /health
  HttpRouter.mount("/health", healthRoutes),

  // Mount user routes at /api/users
  HttpRouter.mount("/api/users", usersRoutes),

  // Add more route modules...
  // HttpRouter.mount("/api/posts", postsRoutes),
)
```

### Main Router with Error Handling

#### router.ts

```typescript
import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import { Effect } from "effect"
import * as ParseResult from "effect/ParseResult"
import { routes } from "./routes"
import { NotFoundError, ValidationError, DatabaseError, StorageError, ConfigError, KVError } from "@/errors"

// Error response helper
const errorResponse = (status: number, error: string, message: string) =>
  HttpServerResponse.json({ error, message }, { status })

// Main application router with error handling
export const appRouter = routes.pipe(
  // Handle schema validation errors (ParseError from schemaBodyJson)
  HttpRouter.catchTag("ParseError", (e) =>
    Effect.succeed(errorResponse(400, "ValidationError", ParseResult.TreeFormatter.formatErrorSync(e)))
  ),

  // Handle domain errors
  HttpRouter.catchTags({
    NotFoundError: (e) =>
      Effect.succeed(errorResponse(404, "NotFoundError", e.message)),

    ValidationError: (e) =>
      Effect.succeed(errorResponse(400, "ValidationError", e.message)),

    DatabaseError: (e) =>
      Effect.succeed(errorResponse(500, "DatabaseError", "Database operation failed")),

    StorageError: (e) =>
      Effect.succeed(errorResponse(500, "StorageError", "Storage operation failed")),

    ConfigError: (e) =>
      Effect.succeed(errorResponse(500, "ConfigError", `Configuration error: ${e.key}`)),

    KVError: (e) =>
      Effect.succeed(errorResponse(500, "KVError", "KV operation failed")),
  }),

  // Handle RouteNotFound (404)
  HttpRouter.catchTag("RouteNotFound", () =>
    Effect.succeed(errorResponse(404, "NotFound", "Route not found"))
  )
)
```

### Worker Entry Point

#### worker.ts

```typescript
import * as HttpApp from "@effect/platform/HttpApp"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { Layer, Effect } from "effect"
import { appRouter } from "./router"
import { AppLive } from "./app"
import { CloudflareBindings } from "@/services"

/**
 * Create runtime with all dependencies
 */
const makeRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppLive(env.HYPERDRIVE).pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

/**
 * Convert router to web handler
 */
const makeHandler = <R>(runtime: ManagedRuntime.ManagedRuntime<R, never>) =>
  HttpApp.toWebHandlerRuntime(runtime)(appRouter)

/**
 * Cloudflare Worker Entry Point
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const runtime = makeRuntime(env, ctx)
    const handler = makeHandler(runtime)

    try {
      return await handler(request)
    } finally {
      // Cleanup runtime after request
      ctx.waitUntil(runtime.disposeEffect.pipe(Effect.runPromise))
    }
  }
}
```

## Schema-based Request Validation Examples

### POST with Body Validation

```typescript
import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import { Schema } from "@effect/schema"
import { Effect } from "effect"

// Define request body schema with validations
const CreatePostBody = Schema.Struct({
  title: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Title is required" }),
    Schema.maxLength(200, { message: () => "Title must be 200 characters or less" })
  ),
  content: Schema.String.pipe(
    Schema.minLength(10, { message: () => "Content must be at least 10 characters" })
  ),
  authorId: Schema.String.pipe(Schema.UUID),
  tags: Schema.optional(
    Schema.Array(Schema.String).pipe(Schema.maxItems(5))
  ),
  published: Schema.optional(Schema.Boolean)
})

// Define response schema
const PostResponse = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Schema.String,
  authorId: Schema.String,
  tags: Schema.Array(Schema.String),
  published: Schema.Boolean,
  createdAt: Schema.String
})

// Route handler
HttpRouter.post("/posts",
  Effect.gen(function* () {
    // Automatically validates request body
    // If validation fails, throws ParseError which is caught by router
    const body = yield* HttpServerRequest.schemaBodyJson(CreatePostBody)

    // body is now fully typed:
    // {
    //   title: string
    //   content: string
    //   authorId: string (UUID)
    //   tags?: string[]
    //   published?: boolean
    // }

    const post = {
      id: crypto.randomUUID(),
      title: body.title,
      content: body.content,
      authorId: body.authorId,
      tags: body.tags ?? [],
      published: body.published ?? false,
      createdAt: new Date().toISOString()
    }

    // Optionally validate response matches schema
    return yield* HttpServerResponse.schemaJson(PostResponse)(post)
  })
)
```

### PUT with Partial Update

```typescript
const UpdatePostBody = Schema.Struct({
  title: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  content: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  published: Schema.optional(Schema.Boolean)
})

const PostIdParams = Schema.Struct({
  id: Schema.String.pipe(Schema.UUID)
})

HttpRouter.put("/posts/:id",
  Effect.gen(function* () {
    const { id } = yield* HttpRouter.schemaPathParams(PostIdParams)
    const updates = yield* HttpServerRequest.schemaBodyJson(UpdatePostBody)

    // updates is typed: { title?: string, content?: string, tags?: string[], published?: boolean }

    // Only update fields that were provided
    const post = yield* updatePost(id, updates)

    return HttpServerResponse.json(post)
  })
)
```

### Complex Nested Schema

```typescript
const AddressSchema = Schema.Struct({
  street: Schema.String,
  city: Schema.String,
  country: Schema.String,
  zipCode: Schema.String.pipe(Schema.pattern(/^\d{5}(-\d{4})?$/))
})

const CreateOrderBody = Schema.Struct({
  customerId: Schema.String.pipe(Schema.UUID),
  items: Schema.Array(
    Schema.Struct({
      productId: Schema.String,
      quantity: Schema.Number.pipe(Schema.positive(), Schema.int()),
      price: Schema.Number.pipe(Schema.positive())
    })
  ).pipe(Schema.minItems(1, { message: () => "Order must have at least one item" })),
  shippingAddress: AddressSchema,
  billingAddress: Schema.optional(AddressSchema),
  notes: Schema.optional(Schema.String)
})

HttpRouter.post("/orders",
  Effect.gen(function* () {
    const order = yield* HttpServerRequest.schemaBodyJson(CreateOrderBody)

    // order.items is typed as Array<{ productId: string, quantity: number, price: number }>
    // order.shippingAddress is typed as { street: string, city: string, ... }

    const total = order.items.reduce((sum, item) => sum + item.quantity * item.price, 0)

    return HttpServerResponse.json({
      id: crypto.randomUUID(),
      ...order,
      total,
      status: "pending",
      createdAt: new Date().toISOString()
    }, { status: 201 })
  })
)
```

## Advanced Patterns

### 1. Route Groups with Middleware

```typescript
import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"

// Auth middleware
const withAuth = <E, R>(router: HttpRouter.HttpRouter<E, R>) =>
  HttpRouter.use(router, (handler) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const authHeader = request.headers["authorization"]

      if (!authHeader?.startsWith("Bearer ")) {
        return HttpServerResponse.json(
          { error: "Unauthorized" },
          { status: 401 }
        )
      }

      // Validate token and provide user context
      const token = authHeader.slice(7)
      // const user = yield* validateToken(token)

      return yield* handler
    })
  )

// Apply to routes
const protectedRoutes = HttpRouter.empty.pipe(
  HttpRouter.get("/me", getUserProfile),
  HttpRouter.put("/me", updateUserProfile),
  withAuth
)

const routes = HttpRouter.empty.pipe(
  HttpRouter.mount("/public", publicRoutes),
  HttpRouter.mount("/api", protectedRoutes)
)
```

### 2. Database Middleware Pattern

```typescript
// Provide database to specific route groups
const withDatabase = <E, R>(router: HttpRouter.HttpRouter<E, R>) =>
  HttpRouter.provideServiceEffect(
    router,
    Database,
    Effect.gen(function* () {
      const { env } = yield* CloudflareBindings
      return yield* makeDatabaseService(env.HYPERDRIVE)
    })
  )

const dbRoutes = HttpRouter.empty.pipe(
  HttpRouter.get("/users", listUsers),
  HttpRouter.post("/users", createUser),
  withDatabase
)
```

## Comparison: Hono vs @effect/platform HttpRouter

| Feature | Hono | @effect/platform |
|---------|------|------------------|
| Effect Integration | Via adapter | Native |
| Path Params | `c.req.param()` | `HttpRouter.schemaPathParams()` |
| Request Body | `c.req.json()` | `HttpServerRequest.schemaBodyJson()` |
| Response | `c.json()` | `HttpServerResponse.json()` |
| Validation | Manual or zod | Built-in with @effect/schema |
| Middleware | Hono middleware | Effect composition |
| Error Handling | try/catch + Hono | Effect error channel + `catchTags` |
| Type Safety | Good | Excellent (with schemas) |
| Bundle Size | ~14kb | Included in Effect (~50kb total) |
| Learning Curve | Low | Medium (requires Effect knowledge) |

## Migration Strategy

1. **Phase 1**: Keep Hono for existing routes, add new routes with HttpRouter
2. **Phase 2**: Migrate routes one module at a time
3. **Phase 3**: Remove Hono dependency entirely

### Hybrid Approach (During Migration)

```typescript
// Mount Effect router inside Hono
import { Hono } from "hono"
import * as HttpApp from "@effect/platform/HttpApp"

const honoApp = new Hono()

// Legacy Hono routes
honoApp.get("/legacy", (c) => c.json({ legacy: true }))

// Effect routes via HttpApp
const effectHandler = HttpApp.toWebHandlerRuntime(runtime)(effectRouter)

honoApp.all("/api/*", async (c) => {
  return effectHandler(c.req.raw)
})
```

## Recommendations

1. **Use @effect/platform HttpRouter when**:
   - Building new Effect-first applications
   - You want fully type-safe request/response handling
   - You want unified error handling via Effect
   - You're comfortable with Effect patterns

2. **Keep Hono when**:
   - Migrating existing Hono applications
   - Team is less familiar with Effect
   - You need Hono-specific middleware ecosystem
   - Bundle size is critical (though Effect is tree-shakeable)

## Implementation Checklist

- [ ] Create `src/routes/` directory structure
- [ ] Create shared schemas in `src/routes/schemas.ts`
- [ ] Implement health routes with HttpRouter
- [ ] Implement user routes with HttpRouter
- [ ] Create main router composition in `src/router.ts`
- [ ] Add error handling for ParseError and domain errors
- [ ] Update worker.ts to use HttpApp.toWebHandlerRuntime
- [ ] Test with Miniflare/wrangler dev
- [ ] Remove Hono dependency

## References

- [@effect/platform HttpRouter source](https://github.com/Effect-TS/effect/tree/main/packages/platform/src/HttpRouter.ts)
- [@effect/platform HttpApp source](https://github.com/Effect-TS/effect/tree/main/packages/platform/src/HttpApp.ts)
- [@effect/platform README](https://github.com/Effect-TS/effect/tree/main/packages/platform/README.md)
- [Effect-TS Documentation](https://effect.website/)
