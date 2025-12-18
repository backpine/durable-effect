# 010: Runtime Setup Pattern for Cloudflare Workers

> A focused guide to setting up Effect runtime correctly in Cloudflare Workers fetch handlers.

## The Problem

The current implementation creates a `ManagedRuntime` on every request:

```typescript
// Current: worker.ts - runtime created per-request
export default {
  async fetch(request, env, ctx) {
    const bindingsLayer = CloudflareBindings.layer(env, ctx);
    const appLayer = AppCoreLive.pipe(Layer.provide(bindingsLayer));
    const managedRuntime = ManagedRuntime.make(appLayer);  // Created every request!

    try {
      const rt = await managedRuntime.runtime();
      const handler = HttpApp.toWebHandlerRuntime(rt)(appRouter);
      return await handler(request);
    } finally {
      ctx.waitUntil(managedRuntime.dispose());
    }
  },
};
```

**Issues:**
- Layer construction overhead on every request
- Services reinstantiated unnecessarily
- Runtime object churn creates GC pressure

## The Solution

Based on the `effect-cloudflare` library pattern (created by Cloudflare and Effect-TS contributors):

**Create a singleton `ManagedRuntime` at module level. Provide request-scoped services per-request via `Effect.provide`.**

```typescript
// Recommended: worker.ts

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Module-Level Initialization (runs once per isolate)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const runtime = ManagedRuntime.make(AppLayer);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Worker Export (runs per-request)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default {
  async fetch(request, env, ctx) {
    const effect = handleRequest(request).pipe(
      Effect.provideService(CloudflareEnv, { env }),
      Effect.provideService(CloudflareCtx, { ctx })
    );

    return runtime.runPromise(effect);
  }
};
```

## Why This Works

### Cloudflare Workers Execution Model

From the [Cloudflare documentation](https://developers.cloudflare.com/workers/reference/how-workers-works/):

- A single worker instance can handle multiple concurrent requests
- Isolates are lightweight V8 sandboxes that start ~100x faster than Node processes
- Module-level code runs once when the isolate initializes
- Isolates may be evicted, but state is not shared between requests anyway

**Module-level initialization is safe** because:
1. Effect's `ManagedRuntime` manages its own lifecycle
2. Services in the layer are memoized by Effect's layer system
3. Per-request data (`env`, `ctx`) is provided via `Effect.provide`, not the layer

### Effect-TS Pattern

The `effect-cloudflare` library uses this exact pattern:

```typescript
// From effect-cloudflare/src/internal/worker.ts
export function makeFetchEntryPoint<R, E>(
  handler: (req, env, ctx) => Effect.Effect<Response, E, R>,
  options: { layer: Layer.Layer<R, E>; memoMap?: Layer.MemoMap }
): ExportedHandler<Cloudflare.Env> {
  // Singleton runtime at module level
  const runtime = ManagedRuntime.make(options.layer, options.memoMap);

  const fetch = async (req, env, ctx) => {
    // Build request-scoped context
    const context = Context.make(Env, effectEnv).pipe(
      Context.add(ExecutionContext, effectCtx)
    );

    // Provide context per-request
    return runtime.runPromise(Effect.provide(handler(...), context));
  };

  return { fetch };
}
```

**Key insight:** The runtime is a singleton. Request-scoped data is added via `Effect.provide`, not by recreating the runtime.

## Implementation

### Step 1: Define Request-Scoped Services

```typescript
// src/services/cloudflare.ts
import { Context } from "effect";

/**
 * Cloudflare environment bindings (request-scoped).
 */
export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
  CloudflareEnv,
  { readonly env: Env }
>() {}

/**
 * Cloudflare execution context (request-scoped).
 */
export class CloudflareCtx extends Context.Tag("CloudflareCtx")<
  CloudflareCtx,
  { readonly ctx: ExecutionContext }
>() {}
```

### Step 2: Define Static Application Layer

Services that don't need per-request `env`/`ctx` go in the static layer:

```typescript
// src/app.ts
import { Layer } from "effect";

/**
 * Static application layer.
 *
 * Services in this layer are initialized once at module load.
 * They should NOT depend on CloudflareEnv or CloudflareCtx.
 */
export const AppLayer = Layer.mergeAll(
  // Static services go here
  // e.g., LoggerLive, TracerLive
);
```

### Step 3: Define the Request Handler

```typescript
// src/handler.ts
import { Effect } from "effect";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { appRouter } from "./router";
import { CloudflareEnv, CloudflareCtx } from "./services/cloudflare";

/**
 * Handle a single HTTP request.
 *
 * This is an Effect that:
 * 1. Runs the HttpRouter
 * 2. Converts the result to a web Response
 * 3. Requires CloudflareEnv and CloudflareCtx to be provided
 */
export const handleRequest = (request: Request) =>
  Effect.gen(function* () {
    // Create platform request from web request
    const serverRequest = HttpServerRequest.fromWeb(request);

    // Run the router
    const response = yield* appRouter.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest)
    );

    // Convert to web response
    return HttpServerResponse.toWeb(response);
  });

// Type: Effect<Response, E, CloudflareEnv | CloudflareCtx | AppDependencies>
```

### Step 4: Worker Entry Point

```typescript
// src/worker.ts
import { ManagedRuntime, Effect } from "effect";
import { AppLayer, CloudflareEnv, CloudflareCtx } from "./app";
import { handleRequest } from "./handler";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Module-Level: Singleton Runtime
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Singleton managed runtime.
 *
 * Created once when the worker isolate initializes.
 * Services in AppLayer are memoized and shared across requests.
 */
const runtime = ManagedRuntime.make(AppLayer);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Worker Export
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Build the effect with request-scoped services
    const effect = handleRequest(request).pipe(
      Effect.provideService(CloudflareEnv, { env }),
      Effect.provideService(CloudflareCtx, { ctx })
    );

    // Run using the singleton runtime
    return runtime.runPromise(effect);
  }
};
```

## Services That Need `env` or `ctx`

Services that need `env` (for bindings) or `ctx` (for `waitUntil`) should:

1. **Depend on `CloudflareEnv`/`CloudflareCtx`** via `yield*` in their implementation
2. **NOT be in the static `AppLayer`** - they'll be provided per-request

```typescript
// src/services/kv.ts
import { Effect, Context, Layer } from "effect";
import { CloudflareEnv } from "./cloudflare";
import { KVError } from "../errors";

export class KV extends Context.Tag("KV")<KV, KVService>() {}

/**
 * KV service that accesses env per-request.
 *
 * This service yields CloudflareEnv to access bindings.
 * It cannot be in the static AppLayer.
 */
export const KVLive = Layer.effect(
  KV,
  Effect.gen(function* () {
    const { env } = yield* CloudflareEnv;

    return {
      from: (binding: KVBindingName) => {
        const namespace = env[binding] as KVNamespace;
        return makeKVOperations(namespace, binding);
      }
    };
  })
);
```

For these services, you have two options:

### Option A: Provide the layer per-request

```typescript
// worker.ts
export default {
  async fetch(request, env, ctx) {
    const requestLayer = Layer.mergeAll(
      Layer.succeed(CloudflareEnv, { env }),
      Layer.succeed(CloudflareCtx, { ctx }),
      KVLive,
      StorageLive
    );

    const effect = handleRequest(request).pipe(
      Effect.provide(requestLayer)
    );

    return runtime.runPromise(effect);
  }
};
```

### Option B: Access bindings directly in the handler (recommended)

Keep services stateless and pass bindings explicitly:

```typescript
// src/services/kv.ts
export const makeKVOperations = (namespace: KVNamespace): KVOperations => ({
  get: (key) => Effect.tryPromise({
    try: () => namespace.get(key),
    catch: (e) => new KVError({ operation: "get", key, cause: e })
  }),
  // ...
});

// In route handler:
const handler = Effect.gen(function* () {
  const { env } = yield* CloudflareEnv;
  const kv = makeKVOperations(env.MY_KV);
  const value = yield* kv.get("key");
  // ...
});
```

## Using `waitUntil` for Background Tasks

Access `ctx.waitUntil` through the `CloudflareCtx` service:

```typescript
// src/services/background.ts
import { Effect } from "effect";
import { CloudflareCtx } from "./cloudflare";

/**
 * Schedule a background task that runs after the response is sent.
 */
export const scheduleBackgroundTask = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const { ctx } = yield* CloudflareCtx;

    ctx.waitUntil(
      Effect.runPromise(
        effect.pipe(
          Effect.tapErrorCause(Effect.logError),
          Effect.catchAll(() => Effect.void)
        )
      )
    );
  });

// Usage in a route:
const handler = Effect.gen(function* () {
  yield* scheduleBackgroundTask(
    Effect.log("This runs after response is sent")
  );

  return HttpServerResponse.text("OK");
});
```

## Comparison: Before vs After

### Before (per-request runtime)

```typescript
export default {
  async fetch(request, env, ctx) {
    // ❌ Creates layer every request
    const bindingsLayer = CloudflareBindings.layer(env, ctx);
    const appLayer = AppCoreLive.pipe(Layer.provide(bindingsLayer));

    // ❌ Creates runtime every request
    const managedRuntime = ManagedRuntime.make(appLayer);

    try {
      // ❌ Resolves runtime every request
      const rt = await managedRuntime.runtime();
      const handler = HttpApp.toWebHandlerRuntime(rt)(appRouter);
      return await handler(request);
    } finally {
      // ❌ Disposes runtime every request
      ctx.waitUntil(managedRuntime.dispose());
    }
  },
};
```

### After (singleton runtime)

```typescript
// ✅ Created once at module load
const runtime = ManagedRuntime.make(AppLayer);

export default {
  async fetch(request, env, ctx) {
    // ✅ Just provide request-scoped data
    const effect = handleRequest(request).pipe(
      Effect.provideService(CloudflareEnv, { env }),
      Effect.provideService(CloudflareCtx, { ctx })
    );

    // ✅ Reuse singleton runtime
    return runtime.runPromise(effect);
  }
};
```

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| Runtime creation | Per-request | Once (module level) |
| Layer construction | Per-request | Once (memoized) |
| Request-scoped data | Via Layer | Via `Effect.provide` |
| GC pressure | High | Low |
| Cold start | Slower | Faster |

The key insight is separating **static services** (in the layer) from **request-scoped data** (provided per-request via `Effect.provide`). This matches the `effect-cloudflare` library pattern and aligns with Cloudflare's execution model.

## References

- [effect-cloudflare source](https://github.com/cloudflare/effect-cloudflare)
- [Cloudflare Workers: How Workers Works](https://developers.cloudflare.com/workers/reference/how-workers-works/)
- [Effect-TS: ManagedRuntime](https://effect-ts.github.io/effect/effect/ManagedRuntime.ts.html)
- [Effect-TS: Runtime Introduction](https://effect.website/docs/runtime/)
