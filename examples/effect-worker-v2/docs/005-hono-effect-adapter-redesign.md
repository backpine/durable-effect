# 005 - Hono Effect Adapter Redesign

## The Problem

The current implementation has two pain points:

```typescript
// Current: Must pass type parameter AND use separate middleware
app.use("*", dbMiddleware())

app.get("/:id", effectHandler<AppDependencies>((c) =>
  Effect.gen(function* () {
    const user = yield* query(...)
    return c.json(user)
  })
))
```

1. **Explicit type parameter `<AppDependencies>`** - Feels redundant; the Effect already knows what it needs via `yield*`
2. **Separate middleware for runtime** - Mental overhead of matching middleware to handler dependencies

What we want: Just wrap the handler and have everything work.

---

## Root Cause Analysis

The complexity comes from trying to be "too correct" about types:

1. **Middleware injects runtime** → Handler extracts it → Handler must declare what runtime type it expects
2. **Runtime is typed `ManagedRuntime<R, E>`** → Handler is typed `Effect<A, E, R>` → We need to ensure R matches
3. **Different routes need different services** → Core routes vs DB routes → Two middlewares, two handler types

But here's the insight: **we always have ALL services available**. The runtime provides everything. Whether a specific handler uses Database or not doesn't change what the runtime provides.

---

## Approaches Considered

### Approach 1: Factory Pattern (Lock R at module level)

```typescript
// routes/users.ts
const { routes, handler } = createEffectRoutes<AppDependencies>()

routes.get("/:id", handler((c) =>
  Effect.gen(function* () {
    const user = yield* query(...)
    return c.json(user)
  })
))

export { routes as usersRoutes }
```

**Pros:**
- R declared once per module
- Handler doesn't need type param

**Cons:**
- Still need to think about R
- Extra boilerplate to create routes
- Factory pattern feels over-engineered

### Approach 2: Two Handler Functions

```typescript
// For routes without database
app.get("/health", effect((c) => ...))

// For routes with database
app.get("/users", dbEffect((c) => ...))
```

**Pros:**
- Clear which runtime is used
- No type parameters

**Cons:**
- Still two functions to choose from
- What if you need different service combinations?

### Approach 3: Runtime Variance (Any R, Full Runtime)

```typescript
export const effect = (
  handler: (c) => Effect.Effect<Response, AppError, any>
) => async (c) => {
  const runtime = makeRuntime(c.env, c.executionCtx)
  try {
    return await runtime.runPromise(handler(c).pipe(...))
  } finally {
    await runtime.dispose()
  }
}
```

Use `any` for R. Runtime always provides everything. Type safety is maintained at the `yield*` level - if you try to use a service that doesn't exist, TypeScript errors there.

**Pros:**
- Single function
- No type parameters
- No middleware
- Clean: `effect((c) => ...)`

**Cons:**
- Can't statically verify route uses only certain services
- `any` in the type signature (hidden from user though)

### Approach 4: Infer from Layer (Compile-time checking)

```typescript
// Runtime type is inferred from layer composition
const AppLayer = Layer.mergeAll(Config, Database, KV, Storage)
type AppR = Layer.Layer.Success<typeof AppLayer>

// Handler R must be subset of AppR
export const effect = <R extends AppR>(
  handler: (c) => Effect.Effect<Response, AppError, R>
) => ...
```

**Problem:** TypeScript's `extends` doesn't work the way we need for Effect's R parameter. `Config extends Config | Database` is true, but that's the opposite of what we're checking.

### Approach 5: Branded Types with Middleware

Keep middleware but use branded types so the runtime type flows automatically:

```typescript
// Middleware brands the context
app.use("*", effectMiddleware())

// Handler infers from context
app.get("/users", effectHandler((c) => {
  // c.get("runtime") has the right type
  // No explicit R needed
}))
```

**Problem:** Still need middleware. TypeScript can't guarantee the middleware ran before the handler at compile time.

---

## Recommended Approach: Simple `effect()` Wrapper

After analysis, **Approach 3** wins for pragmatic reasons:

```typescript
// src/api/effect.ts
export const effect = (
  handler: (c: HonoContext<{ Bindings: Env }>) => Effect.Effect<Response, AppError, any>
) => {
  return async (c: HonoContext<{ Bindings: Env }>): Promise<Response> => {
    const runtime = makeRuntime(c.env, c.executionCtx)

    try {
      const program = handler(c).pipe(
        Effect.catchAll((error) => Effect.succeed(errorToResponse(error))),
        Effect.catchAllDefect((defect) => {
          console.error("Unhandled defect:", defect)
          return Effect.succeed(
            Response.json({ error: "InternalError", message: "An unexpected error occurred" }, { status: 500 })
          )
        })
      )

      return await runtime.runPromise(program)
    } finally {
      await runtime.dispose()
    }
  }
}
```

### Usage

```typescript
import { Hono } from "hono"
import { Effect } from "effect"
import { effect } from "@/api/effect"
import { query } from "@/services"

const app = new Hono()

app.get("/users/:id", effect((c) =>
  Effect.gen(function* () {
    const id = c.req.param("id")

    const users = yield* query((db) =>
      db.select().from(schema.users).where(eq(schema.users.id, id))
    )

    if (users.length === 0) {
      return yield* Effect.fail(new NotFoundError({ resource: "User", id }))
    }

    return c.json(users[0])
  })
))

export { app as usersRoutes }
```

**That's it.** No middleware. No type parameters. Just `effect((c) => ...)`.

---

## Why This Works

### Type Safety Is Preserved

The `any` in `Effect<Response, AppError, any>` is an implementation detail. Type safety is maintained at two levels:

1. **Service usage** - When you `yield* Database`, TypeScript checks that `Database` service exists
2. **Error handling** - When you `yield* Effect.fail(new NotFoundError(...))`, the error type is tracked

What we "lose" is the ability to say "this handler only needs Config". But that's rarely useful in practice.

### Runtime Is Always Available

The runtime provides all services:
- Config
- Database
- KVStore
- ObjectStorage

Whether a handler uses them or not doesn't matter. They're available. Effect's layer memoization ensures each service is only instantiated once per request.

### No Middleware = Simpler Mental Model

Each `effect()` call:
1. Creates a runtime
2. Runs the Effect
3. Disposes the runtime

No need to think about "did I apply the right middleware?" The handler is self-contained.

---

## Performance Consideration

**Q: Creating a new runtime per request - is that expensive?**

No. The "cost" of `ManagedRuntime.make()` is layer initialization:
- `Layer.sync` → Just a function call
- `Layer.effect` → Run a small Effect

For our services:
- `CloudflareBindings` → Wraps env/ctx (instant)
- `Config` → Wraps env (instant)
- `Database` → Creates postgres client (fast, connection pooled by Hyperdrive)
- `KV` → Wraps KV binding (instant)
- `Storage` → Wraps R2 binding (instant)

Total: Microseconds. The HTTP request latency dwarfs this.

**Q: What about layer memoization?**

Within a single request, memoization still works. If two parts of your handler both `yield* Database`, they get the same instance.

Across requests? In Workers, each request might be a new isolate anyway. Caching at the module level is tricky and can leak state.

---

## Migration Path

### Before

```typescript
// api/index.ts
app.use("*", coreMiddleware())
app.use("/api/users/*", dbMiddleware())

// routes/users.ts
app.get("/:id", effectHandler<AppDependencies>((c) => ...))
```

### After

```typescript
// routes/users.ts
app.get("/:id", effect((c) => ...))
```

1. Delete middleware from `api/index.ts`
2. Replace `effectHandler<R>` with `effect`
3. Remove type imports for `AppDependencies`, `AppCoreDependencies`

---

## Alternative: Cached Runtime (If Needed)

If profiling shows runtime creation is a bottleneck (unlikely), we can cache:

```typescript
let cachedRuntime: ManagedRuntime<AppDependencies, never> | null = null
let cachedEnv: Env | null = null

export const effect = (handler) => async (c) => {
  // Reuse runtime if same env (same isolate)
  if (!cachedRuntime || cachedEnv !== c.env) {
    cachedRuntime?.dispose()
    cachedRuntime = makeRuntime(c.env, c.executionCtx)
    cachedEnv = c.env
  }

  return cachedRuntime.runPromise(handler(c).pipe(...))
  // Note: Don't dispose - cached for next request
}
```

But start simple. Add caching only if you measure a problem.

---

## What About Core-Only Routes?

Some routes don't need Database (health checks, static config endpoints). With this design, they still get a runtime with Database available - they just don't use it.

**Is that wasteful?**

Only if Database initialization is expensive. With Hyperdrive connection pooling, it's not. The postgres client creation is fast.

**If you really want to optimize:**

Create a separate `coreEffect` that uses `makeCoreRuntime`:

```typescript
export const coreEffect = (handler) => async (c) => {
  const runtime = makeCoreRuntime(c.env, c.executionCtx)
  try {
    return await runtime.runPromise(handler(c).pipe(...))
  } finally {
    await runtime.dispose()
  }
}

// Usage
app.get("/health", coreEffect((c) => Effect.succeed(c.json({ status: "ok" }))))
```

But I'd only do this if you measure a real performance difference.

---

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| Type parameter | `effectHandler<AppDependencies>` | `effect` |
| Middleware | Required, matched to routes | None |
| Runtime management | Via middleware + context | Inside wrapper |
| Mental model | "Which middleware? Which R?" | "Just use effect()" |

The key insight: **Don't fight the type system. Work with it.**

Effect already tracks what services you use via `yield*`. The runtime provides everything. Let the Effect type system do its job at the service level, and keep the Hono integration simple.

---

## Implementation Checklist

- [ ] Create new `effect()` function in `src/api/effect.ts`
- [ ] Update `makeRuntime` to not require Hyperdrive param (get from env internally)
- [ ] Delete middleware-related code
- [ ] Update all route files to use `effect()`
- [ ] Remove `AppDependencies` / `AppCoreDependencies` type imports from routes
- [ ] Update `api/index.ts` to remove middleware
- [ ] Test all routes still work
