# 012: Layer Memoization - Why Database Rebuilds Every Request

## The Problem

The database layer logs "Connecting to database..." on **every request**, indicating the layer is being rebuilt each time:

```typescript
// src/services/database.ts
export const DatabaseLive = (connectionString: string) =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      console.log("Connecting to database...", Date.now());  // Logs every request!
      // ...
    })
  );
```

This defeats the purpose of having a singleton runtime.

## Root Cause Analysis

### How Effect Layer Memoization Works

Effect memoizes layers by **reference equality**, not by content:

```typescript
const layer1 = DatabaseLive("postgres://...");
const layer2 = DatabaseLive("postgres://...");

layer1 === layer2  // FALSE! Different objects, same content
```

Each call to `DatabaseLive(connectionString)` creates a **new Layer object**. Even though they're functionally identical, Effect treats them as different layers and rebuilds them.

### Current Code Flow

```typescript
// worker.ts - PER REQUEST:
export default {
  async fetch(request, env, ctx) {
    const appLayer = makeAppLayer(env, ctx);  // Creates NEW layer objects
    const effect = handleRequest(request).pipe(Effect.provide(appLayer));
    return runtime.runPromise(effect);
  }
};

// runtime.ts
export const makeAppLayer = (env, ctx) => {
  const requestLayer = makeRequestLayer(env, ctx);
  return AppLive(env.DATABASE_URL).pipe(Layer.provide(requestLayer));
  //     ^^^^^^^^^^^^^^^^^^^^^^^^ NEW layer object each call!
};

// app.ts
export const AppLive = (connectionString: string) =>
  Layer.mergeAll(AppCoreLive, DatabaseLive(connectionString));
  //                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ NEW layer object each call!
```

**Every request:**
1. `makeAppLayer()` is called
2. `AppLive(env.DATABASE_URL)` creates a NEW `Layer` object
3. `DatabaseLive(connectionString)` creates a NEW `Layer.scoped(...)` object
4. `Effect.provide(effect, appLayer)` builds the layer from scratch
5. Database connection is established again

### The Key Distinction

```typescript
// EXPENSIVE: Providing a Layer (builds it)
Effect.provide(effect, layer)

// CHEAP: Providing a Context (pre-built services)
Effect.provide(effect, context)
```

The `effect-cloudflare` library uses `Context.make()` for request-scoped data:

```typescript
// effect-cloudflare pattern
const runtime = ManagedRuntime.make(options.layer);  // Layer built ONCE

const fetch = async (req, env, ctx) => {
  // Context.make creates service instances, doesn't build layers
  const context = Context.make(Env, effectEnv).pipe(
    Context.add(ExecutionContext, effectCtx)
  );

  // Providing a Context is cheap
  return runtime.runPromise(Effect.provide(effect, context));
};
```

## Solution: Layer.MemoMap

Effect provides `Layer.MemoMap` to share layer construction across multiple builds. When you use a memoMap, Effect will only build each layer once, even if you create new layer objects.

### How MemoMap Works

```typescript
// Create memoMap at module level
const memoMap = Layer.makeMemoMap();

// Later, when building layers:
Layer.buildWithMemoMap(layer, memoMap);

// Or with ManagedRuntime:
const runtime = ManagedRuntime.make(layer, memoMap);
```

With a memoMap:
1. First request: Layer is built, cached in memoMap
2. Subsequent requests: Layer is retrieved from memoMap cache

### Implementation

```typescript
// src/worker.ts
import { Effect, Layer, ManagedRuntime } from "effect";
import { handleRequest } from "./handler";
import { makeAppLayer } from "./runtime";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Module-Level Initialization
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Shared MemoMap for layer construction.
 *
 * This ensures layers are only built ONCE, even if we create
 * new layer objects per request.
 */
const memoMap = Effect.runSync(Layer.makeMemoMap);

/**
 * Singleton runtime with memoMap.
 */
const runtime = ManagedRuntime.make(Layer.empty, memoMap);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Worker Export
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Creates new layer objects, but memoMap ensures they're only built once
    const appLayer = makeAppLayer(env, ctx);

    const effect = handleRequest(request).pipe(Effect.provide(appLayer));

    return runtime.runPromise(effect);
  },
};
```

### How It Works Now

```
Request 1:
  └── makeAppLayer(env, ctx)
  └── DatabaseLive("postgres://...") creates Layer object A
  └── memoMap: Layer A not cached → BUILD IT → cache it
  └── "Connecting to database..." logs

Request 2:
  └── makeAppLayer(env, ctx)
  └── DatabaseLive("postgres://...") creates Layer object B (different object!)
  └── memoMap: Equivalent layer cached → REUSE IT
  └── No log! Connection reused.
```

## Alternative: Module-Level Static Layer

If your connection string doesn't change between requests (which is true for `env.DATABASE_URL` in Cloudflare Workers), you can create the layer at module level:

```typescript
// src/worker.ts
import { env } from "cloudflare:workers";  // Module-level env access
import { Effect, Layer, ManagedRuntime } from "effect";

// Create database layer ONCE at module level
const AppLayer = Layer.mergeAll(
  ConfigLive,
  KVLive,
  StorageLive,
  DatabaseLive(env.DATABASE_URL)  // Same layer object reused
);

const runtime = ManagedRuntime.make(AppLayer);

export default {
  async fetch(request, env, ctx) {
    // Only provide request-scoped context
    const requestContext = Context.make(CloudflareEnv, { env }).pipe(
      Context.add(CloudflareCtx, { ctx })
    );

    const effect = handleRequest(request).pipe(
      Effect.provide(requestContext)  // Providing Context, not Layer!
    );

    return runtime.runPromise(effect);
  }
};
```

### Trade-offs

| Approach | Pros | Cons |
|----------|------|------|
| **MemoMap** | Works with dynamic connection strings, minimal code change | Slightly more complex |
| **Module-level layer** | Simplest, most explicit | Requires `cloudflare:workers` import, services can't depend on request-scoped env |

## Recommendation

**Use MemoMap.** It's the most flexible solution that:
1. Works with any connection string source
2. Handles dynamic configuration
3. Requires minimal changes to existing code
4. Is the pattern used by `effect-cloudflare`

## Full Implementation

### worker.ts

```typescript
import { Effect, Layer, ManagedRuntime } from "effect";
import { handleRequest } from "./handler";
import { makeAppLayer } from "./runtime";

// Module-level memoMap ensures layers are built once
const memoMap = Effect.runSync(Layer.makeMemoMap);

// Runtime with memoMap
const runtime = ManagedRuntime.make(Layer.empty, memoMap);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const appLayer = makeAppLayer(env, ctx);
    const effect = handleRequest(request).pipe(Effect.provide(appLayer));
    return runtime.runPromise(effect);
  },
};
```

### That's it!

The only change is:
1. Create `memoMap` at module level
2. Pass it to `ManagedRuntime.make(layer, memoMap)`

The memoMap handles caching internally. Layers with the same structure will be built once and reused.

## Understanding Layer Identity

MemoMap uses structural identity based on the layer's construction. Two layers are considered "the same" if they:
1. Use the same layer constructor (e.g., `Layer.scoped`)
2. Have the same tag (e.g., `Database`)
3. Have the same effect identity

This means `DatabaseLive("postgres://...")` called twice with the same connection string will be recognized as equivalent and cached.

## Verification

After implementing, you should see:
- First request: "Connecting to database..." logs
- Subsequent requests: No log (connection reused)

If you still see logs on every request, the memoMap isn't being shared correctly. Ensure it's created at module level and passed to `ManagedRuntime.make`.
