# 009: Singleton Runtime with Request-Scoped Context

## Executive Summary

This document addresses a core design problem: the current implementation creates a new `ManagedRuntime` for every HTTP request, which incurs layer initialization overhead. This report explores patterns for creating a **singleton runtime** at module initialization while still providing **request-scoped access** to `ExecutionContext`.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Key Insight: Module-Level Env Import](#2-key-insight-module-level-env-import)
3. [Design Options](#3-design-options)
4. [Recommended Solution: FiberRef Pattern](#4-recommended-solution-fiberref-pattern)
5. [Alternative: HttpApp.toWebHandler with Runtime](#5-alternative-httpapptowebhandler-with-runtime)
6. [Implementation Guide](#6-implementation-guide)
7. [Service Migration Patterns](#7-service-migration-patterns)
8. [Testing Considerations](#8-testing-considerations)
9. [Trade-offs and Caveats](#9-trade-offs-and-caveats)
10. [Appendix: Complete Implementation](#10-appendix-complete-implementation)

---

## 1. Problem Statement

### 1.1 Current Implementation

```typescript
// src/worker.ts - Current problematic approach
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Problem: These lines run on EVERY request
    const bindingsLayer = CloudflareBindings.layer(env, ctx);
    const appLayer = AppCoreLive.pipe(Layer.provide(bindingsLayer));
    const managedRuntime = ManagedRuntime.make(appLayer);

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

### 1.2 Issues with Per-Request Runtime

1. **Layer Initialization Overhead**: Every service layer (`ConfigLive`, `KVLive`, `StorageLive`, etc.) is evaluated on every request
2. **Database Connection Churn**: For `DatabaseLive`, this means opening/closing connections per request
3. **Memory Pressure**: Creating and disposing runtimes creates GC pressure
4. **Latency**: P99 latency increases due to layer evaluation time
5. **Unnecessary Work**: Most of the `env` object doesn't change between requests

### 1.3 Constraints

- `ctx` (ExecutionContext) is genuinely request-scoped - it changes per request
- `ctx.waitUntil()` is needed for background tasks and cleanup
- Services that schedule background work need access to `ctx`
- The router (`appRouter`) needs the runtime's context for dependency injection

---

## 2. Key Insight: Module-Level Env Import

Cloudflare Workers provides a way to access `env` at module level:

```typescript
import { env } from "cloudflare:workers";
```

This import is available **at module initialization time**, not just inside `fetch()`. This is critical because:

1. **`env` is stable**: For the lifetime of a worker isolate, `env` bindings don't change
2. **Module-level initialization**: We can create services that depend on `env` once
3. **Runtime singleton**: The `ManagedRuntime` can be created once at module load

However, `ctx` is NOT available at module level - it's passed to each `fetch()` invocation.

---

## 3. Design Options

### Option A: FiberRef for Request Context (Recommended)

Store `ExecutionContext` in a `FiberRef` that's set per-request:

```typescript
// Create a FiberRef to hold the request-scoped context
const CurrentExecutionContext = FiberRef.unsafeMake<ExecutionContext | null>(null);

// In fetch handler, run effect with FiberRef set
Effect.runPromise(
  handler.pipe(
    Effect.locally(CurrentExecutionContext, ctx)
  )
)
```

**Pros:**
- Clean separation of concerns
- Type-safe access to `ctx`
- Works with singleton runtime

**Cons:**
- Services must use `FiberRef.get` instead of direct injection
- Requires null handling when outside request context

### Option B: Dual-Layer Architecture

Split layers into "static" (env-only) and "dynamic" (ctx-dependent):

```typescript
// Static layer - created once at module level
const StaticLive = Layer.mergeAll(ConfigLive, KVLive, StorageLive);
const staticRuntime = ManagedRuntime.make(StaticLive);

// Dynamic layer - provided per request
const makeDynamicLayer = (ctx: ExecutionContext) =>
  Layer.succeed(ExecutionContextService, ctx);

// Per request: combine runtimes
const handler = HttpApp.toWebHandlerRuntime(staticRuntime)(appRouter);
```

**Pros:**
- Clean architectural separation
- Traditional layer pattern

**Cons:**
- Requires restructuring all services
- Complex to reason about which services are static vs dynamic
- Awkward composition

### Option C: HttpApp Context Provision

Use `@effect/platform`'s built-in mechanisms:

```typescript
// Use the HttpApp's ability to access request
HttpApp.toWebHandlerRuntime(runtime)(
  appRouter.pipe(
    HttpRouter.use((app) =>
      Effect.gen(function* () {
        // Access native request for ctx
        const request = yield* HttpServerRequest.HttpServerRequest;
        // ... but this doesn't give us ExecutionContext!
      })
    )
  )
)
```

**Cons:**
- `@effect/platform` doesn't expose `ExecutionContext` natively
- Would require patching or extending the platform

### Option D: Global Mutable State (Anti-Pattern)

```typescript
let currentCtx: ExecutionContext | null = null;

export default {
  fetch(request, env, ctx) {
    currentCtx = ctx;  // Race conditions!
    // ...
  }
}
```

**Cons:**
- Race conditions with concurrent requests
- Not Effect-idiomatic
- Breaks referential transparency

---

## 4. Recommended Solution: FiberRef Pattern

### 4.1 Overview

The FiberRef pattern provides the cleanest solution:

```
┌─────────────────────────────────────────────────────────────┐
│                    Module Initialization                     │
├─────────────────────────────────────────────────────────────┤
│  1. Import env from cloudflare:workers                      │
│  2. Create static layers (Config, KV, Storage)              │
│  3. Create singleton ManagedRuntime                         │
│  4. Create web handler from runtime                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Per-Request Flow                          │
├─────────────────────────────────────────────────────────────┤
│  1. fetch(request, env, ctx) called                         │
│  2. Set ExecutionContext FiberRef for this fiber            │
│  3. Run handler with FiberRef.locally                       │
│  4. Services access ctx via FiberRef.get                    │
│  5. Response returned, ctx.waitUntil for cleanup            │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Core Components

#### ExecutionContext FiberRef

```typescript
// src/services/execution-context.ts
import { FiberRef, Effect, Context, Layer } from "effect";

/**
 * FiberRef holding the current request's ExecutionContext.
 *
 * This is set per-request via FiberRef.locally and allows services
 * to access the current ctx without it being in the Layer dependency graph.
 */
export const CurrentExecutionContext = FiberRef.unsafeMake<ExecutionContext | null>(null);

/**
 * Get the current ExecutionContext.
 * Fails if called outside of a request context.
 */
export const getExecutionContext: Effect.Effect<ExecutionContext, ExecutionContextError> =
  FiberRef.get(CurrentExecutionContext).pipe(
    Effect.flatMap((ctx) =>
      ctx === null
        ? Effect.fail(new ExecutionContextError({ message: "No ExecutionContext available - are you inside a request?" }))
        : Effect.succeed(ctx)
    )
  );

/**
 * Run an effect with the given ExecutionContext.
 * This should wrap the entire request handler.
 */
export const withExecutionContext = <A, E, R>(
  ctx: ExecutionContext,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.locally(effect, CurrentExecutionContext, ctx);

/**
 * Schedule a background task on the current ExecutionContext.
 *
 * This is the effectful way to use ctx.waitUntil().
 */
export const waitUntil = <A, E>(
  effect: Effect.Effect<A, E>
): Effect.Effect<void, ExecutionContextError> =>
  Effect.gen(function* () {
    const ctx = yield* getExecutionContext;
    ctx.waitUntil(
      Effect.runPromise(
        effect.pipe(
          Effect.tapErrorCause(Effect.logError),
          Effect.asVoid,
          Effect.catchAll(() => Effect.void)
        )
      )
    );
  });
```

#### Singleton Runtime Module

```typescript
// src/singleton-runtime.ts
import { env } from "cloudflare:workers";
import { Layer, ManagedRuntime, Effect } from "effect";
import * as HttpApp from "@effect/platform/HttpApp";
import { ConfigLive, KVLive, StorageLive } from "@/services";
import { withExecutionContext } from "@/services/execution-context";
import { appRouter } from "./router";

/**
 * Static application layer.
 *
 * These services only depend on `env`, not `ctx`, so they can be
 * initialized once at module load.
 *
 * Note: CloudflareBindings is NOT included here since ctx is request-scoped.
 * Services access env directly or through the module-level import.
 */
const StaticAppLayer = Layer.mergeAll(
  ConfigLive,
  KVLive,
  StorageLive
);

/**
 * Singleton runtime created at module initialization.
 *
 * This is evaluated once when the module is loaded, not per-request.
 */
const runtime = ManagedRuntime.make(StaticAppLayer);

/**
 * Web handler created from the singleton runtime.
 *
 * This is the function that converts our Effect router into a
 * web-standard handler.
 */
let handlerPromise: Promise<(request: Request) => Promise<Response>> | null = null;

const getHandler = async () => {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const rt = await runtime.runtime();
      return HttpApp.toWebHandlerRuntime(rt)(appRouter);
    })();
  }
  return handlerPromise;
};

/**
 * Cloudflare Worker fetch handler using singleton runtime.
 */
export default {
  async fetch(
    request: Request,
    _env: Env,           // Ignored - using module-level import
    ctx: ExecutionContext
  ): Promise<Response> {
    const handler = await getHandler();

    // The handler runs effects in our runtime.
    // We need to ensure the ExecutionContext FiberRef is set.
    //
    // Note: toWebHandlerRuntime already wraps the effect execution,
    // so we need to use a different approach here.
    return handler(request);
  }
};
```

### 4.3 The Challenge with HttpApp.toWebHandlerRuntime

There's a problem: `toWebHandlerRuntime` handles effect execution internally, so we can't easily wrap it with `FiberRef.locally`. We need a different approach.

**Solution: Custom Web Handler**

Instead of using `toWebHandlerRuntime` directly, we create our own handler that properly sets up the FiberRef:

```typescript
// src/singleton-runtime.ts
import { env } from "cloudflare:workers";
import { Layer, ManagedRuntime, Effect, Runtime, Exit } from "effect";
import * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { ConfigLive, KVLive, StorageLive } from "@/services";
import { CurrentExecutionContext } from "@/services/execution-context";
import { appRouter } from "./router";

const StaticAppLayer = Layer.mergeAll(
  ConfigLive,
  KVLive,
  StorageLive
);

const managedRuntime = ManagedRuntime.make(StaticAppLayer);

/**
 * Create a custom web handler that sets ExecutionContext per-request.
 *
 * This is based on HttpApp.toWebHandlerRuntime but adds FiberRef setup.
 */
const makeHandler = async () => {
  const rt = await managedRuntime.runtime();

  return async (request: Request, ctx: ExecutionContext): Promise<Response> => {
    // Create the HttpServerRequest from the web request
    const serverRequest = HttpServerRequest.fromWeb(request);

    // Run the router effect with:
    // 1. The HttpServerRequest provided
    // 2. The ExecutionContext FiberRef set
    const effect = appRouter.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
      Effect.locally(CurrentExecutionContext, ctx),
      Effect.map((response) => HttpServerResponse.toWeb(response))
    );

    const exit = await Runtime.runPromiseExit(rt)(effect);

    if (Exit.isSuccess(exit)) {
      return exit.value;
    } else {
      // Convert failure to error response
      console.error("Request failed:", exit.cause);
      return new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  };
};

let handler: ((request: Request, ctx: ExecutionContext) => Promise<Response>) | null = null;

export default {
  async fetch(
    request: Request,
    _env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    if (!handler) {
      handler = await makeHandler();
    }
    return handler(request, ctx);
  }
};
```

Wait - this approach has issues with `@effect/platform`'s internal request handling. Let's explore a cleaner solution.

---

## 5. Alternative: HttpApp.toWebHandler with Runtime

Looking more deeply at `@effect/platform`, there's a better pattern using `HttpApp.toWebHandler`:

### 5.1 Understanding the Platform API

```typescript
// HttpApp provides several conversion functions:

// 1. toWebHandlerRuntime - takes a ManagedRuntime
HttpApp.toWebHandlerRuntime(runtime)(app)

// 2. toWebHandler - takes a Layer
HttpApp.toWebHandler(app, Layer.empty)

// 3. toWebHandlerLayer - creates handler from layer
HttpApp.toWebHandlerLayer(layer)(app)
```

The key insight: `toWebHandlerRuntime` uses the runtime's context, but we can **extend the effect** before it runs.

### 5.2 Middleware-Based Solution

Use HttpRouter middleware to inject the execution context:

```typescript
// src/middleware/execution-context.ts
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { Effect, FiberRef } from "effect";
import { CurrentExecutionContext } from "@/services/execution-context";

/**
 * Middleware that extracts ExecutionContext from the request and sets the FiberRef.
 *
 * This requires the ExecutionContext to be attached to the request somehow.
 */
export const withExecutionContextMiddleware = <E, R>(
  router: HttpRouter.HttpRouter<E, R>,
  getCtx: () => ExecutionContext
) =>
  HttpRouter.use(router, (handler) =>
    Effect.locally(handler, CurrentExecutionContext, getCtx())
  );
```

**Problem**: How do we pass `ctx` into the middleware? The middleware runs *inside* the runtime.

### 5.3 Extended Request Pattern

We can attach `ctx` to the request object before passing it to the handler:

```typescript
// src/worker.ts
interface ExtendedRequest extends Request {
  __executionContext?: ExecutionContext;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const extendedRequest = request as ExtendedRequest;
    extendedRequest.__executionContext = ctx;
    return handler(extendedRequest);
  }
};

// In middleware, retrieve it:
const ctx = (request as ExtendedRequest).__executionContext!;
```

This is somewhat hacky but works. Let's formalize it better.

---

## 6. Implementation Guide

### 6.1 Clean Implementation Using Request Extension

```typescript
// src/services/execution-context.ts
import { Context, Effect, Layer, FiberRef } from "effect";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Extended request interface that carries ExecutionContext.
 * This is set by the worker entry point.
 */
interface RequestWithContext extends Request {
  readonly __ctx: ExecutionContext;
}

// ---------------------------------------------------------------------------
// FiberRef for ExecutionContext
// ---------------------------------------------------------------------------

/**
 * FiberRef holding the current ExecutionContext.
 */
export const CurrentExecutionContext = FiberRef.unsafeMake<ExecutionContext | null>(null);

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Get ExecutionContext from the current fiber.
 * Fails if not in a request context.
 */
export const getExecutionContext: Effect.Effect<ExecutionContext, Error> =
  FiberRef.get(CurrentExecutionContext).pipe(
    Effect.flatMap((ctx) =>
      ctx === null
        ? Effect.fail(new Error("ExecutionContext not available"))
        : Effect.succeed(ctx)
    )
  );

/**
 * Schedule a background task using waitUntil.
 */
export const waitUntil = <A, E>(
  effect: Effect.Effect<A, E>
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const ctx = yield* getExecutionContext;
    ctx.waitUntil(
      Effect.runPromise(
        effect.pipe(
          Effect.tapErrorCause(Effect.logError),
          Effect.catchAll(() => Effect.void)
        )
      )
    );
  });

/**
 * Attach ExecutionContext to a Request.
 */
export const attachContext = (
  request: Request,
  ctx: ExecutionContext
): RequestWithContext => {
  return Object.assign(request, { __ctx: ctx }) as RequestWithContext;
};

/**
 * Extract ExecutionContext from a Request.
 */
export const extractContext = (request: Request): ExecutionContext | null => {
  return (request as Partial<RequestWithContext>).__ctx ?? null;
};
```

### 6.2 Router Middleware

```typescript
// src/router.ts
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { Effect } from "effect";
import { CurrentExecutionContext, extractContext } from "@/services/execution-context";
import { routes } from "./routes";

/**
 * Middleware that extracts ExecutionContext from the request
 * and sets the FiberRef for downstream handlers.
 */
const withExecutionContext = <E, R>(
  router: HttpRouter.HttpRouter<E, R>
): HttpRouter.HttpRouter<E, R> =>
  HttpRouter.use(router, (handler) =>
    Effect.gen(function* () {
      const serverRequest = yield* HttpServerRequest.HttpServerRequest;
      const nativeRequest = serverRequest.source as Request;
      const ctx = extractContext(nativeRequest);

      if (ctx) {
        return yield* Effect.locally(handler, CurrentExecutionContext, ctx);
      } else {
        // No context available - likely in testing
        return yield* handler;
      }
    })
  );

/**
 * Main router with ExecutionContext injection.
 */
export const appRouter = routes.pipe(
  withExecutionContext,
  HttpRouter.catchAll((error) => {
    // Error handling...
  })
);
```

### 6.3 Worker Entry Point

```typescript
// src/worker.ts
import { env } from "cloudflare:workers";
import { Layer, ManagedRuntime } from "effect";
import * as HttpApp from "@effect/platform/HttpApp";
import { ConfigLive, KVLive, StorageLive } from "@/services";
import { attachContext } from "@/services/execution-context";
import { appRouter } from "./router";

// ---------------------------------------------------------------------------
// Module-Level Initialization
// ---------------------------------------------------------------------------

/**
 * Static application layer - services that only need `env`.
 *
 * These are initialized once at module load, not per-request.
 * The `env` is available via the cloudflare:workers import.
 */
const StaticAppLayer = Layer.mergeAll(
  ConfigLive,
  KVLive,
  StorageLive,
);

/**
 * Singleton managed runtime.
 * Created once when the module loads.
 */
const managedRuntime = ManagedRuntime.make(StaticAppLayer);

/**
 * Promise for the web handler.
 * Resolved once when first request arrives.
 */
const handlerPromise = (async () => {
  const rt = await managedRuntime.runtime();
  return HttpApp.toWebHandlerRuntime(rt)(appRouter);
})();

// ---------------------------------------------------------------------------
// Worker Export
// ---------------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    _env: Env,  // Using module-level import instead
    ctx: ExecutionContext
  ): Promise<Response> {
    const handler = await handlerPromise;

    // Attach ExecutionContext to request for middleware extraction
    const requestWithCtx = attachContext(request, ctx);

    return handler(requestWithCtx);
  }
};
```

### 6.4 Updated Services (No CloudflareBindings Dependency)

Services now access `env` directly instead of through `CloudflareBindings`:

```typescript
// src/services/config.ts
import { env } from "cloudflare:workers";
import { Context, Effect, Layer } from "effect";
import { ConfigError } from "@/errors";

interface ConfigService {
  readonly get: (key: string) => Effect.Effect<string, ConfigError>;
  // ... other methods
}

export class Config extends Context.Tag("Config")<Config, ConfigService>() {}

/**
 * Config implementation using module-level env import.
 * No CloudflareBindings dependency needed.
 */
export const ConfigLive = Layer.succeed(Config, {
  get: (key: string) =>
    Effect.gen(function* () {
      const value = (env as Record<string, unknown>)[key];
      if (typeof value !== "string") {
        return yield* Effect.fail(
          new ConfigError({ key, message: `Config key "${key}" not found` })
        );
      }
      return value;
    }),
  // ... other methods
});
```

```typescript
// src/services/kv.ts
import { env } from "cloudflare:workers";
import { Context, Effect, Layer, Option } from "effect";
import { KVError } from "@/errors";
import type { KVBindingName } from "./types";

// ... interface definitions ...

export class KV extends Context.Tag("KV")<KV, KVService>() {}

/**
 * KV implementation using module-level env import.
 */
export const KVLive = Layer.sync(KV, () => {
  const operationsCache = new Map<KVBindingName, KVOperations>();

  const makeOperations = (binding: KVBindingName): KVOperations => {
    const namespace = (env as Record<string, KVNamespace>)[binding];
    // ... implementation using namespace
  };

  return {
    from: (binding: KVBindingName) => {
      let ops = operationsCache.get(binding);
      if (!ops) {
        ops = makeOperations(binding);
        operationsCache.set(binding, ops);
      }
      return ops;
    }
  };
});
```

---

## 7. Service Migration Patterns

### 7.1 Services That Need ExecutionContext

Some services need `ctx`, particularly for background tasks:

```typescript
// src/services/background-tasks.ts
import { Context, Effect, Layer } from "effect";
import { getExecutionContext, waitUntil } from "./execution-context";

interface BackgroundTaskService {
  readonly schedule: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<void>;
}

export class BackgroundTasks extends Context.Tag("BackgroundTasks")<
  BackgroundTasks,
  BackgroundTaskService
>() {}

/**
 * Service for scheduling background tasks via ctx.waitUntil.
 *
 * Uses the FiberRef to access the current ExecutionContext.
 */
export const BackgroundTasksLive = Layer.succeed(BackgroundTasks, {
  schedule: <A, E>(effect: Effect.Effect<A, E>) =>
    waitUntil(effect).pipe(
      Effect.catchAll((error) => {
        // Log but don't fail the request
        Effect.logWarning(`Failed to schedule background task: ${error}`);
        return Effect.void;
      })
    )
});
```

### 7.2 Services That Only Need Env

These services are straightforward - just use the module-level import:

```typescript
// src/services/storage.ts
import { env } from "cloudflare:workers";
import { Context, Effect, Layer, Option } from "effect";
import { StorageError } from "@/errors";
import type { R2BindingName } from "./types";

export class Storage extends Context.Tag("Storage")<Storage, StorageService>() {}

export const StorageLive = Layer.sync(Storage, () => {
  const operationsCache = new Map<R2BindingName, StorageOperations>();

  return {
    from: (binding: R2BindingName) => {
      let ops = operationsCache.get(binding);
      if (!ops) {
        const bucket = (env as Record<string, R2Bucket>)[binding];
        ops = makeStorageOperations(bucket, binding);
        operationsCache.set(binding, ops);
      }
      return ops;
    }
  };
});
```

### 7.3 Database Service

Database service can remain largely unchanged since it uses connection strings from env:

```typescript
// src/services/database.ts
import { env } from "cloudflare:workers";
import { Context, Effect, Layer } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const DatabaseHyperdrive = () =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      // Access Hyperdrive from module-level env
      const hyperdrive = (env as { HYPERDRIVE?: Hyperdrive }).HYPERDRIVE;

      if (!hyperdrive) {
        return yield* Effect.die(new Error("HYPERDRIVE binding not configured"));
      }

      const client = postgres(hyperdrive.connectionString, {
        max: 5,
        fetch_types: false,
      });

      const db = drizzle(client);

      yield* Effect.addFinalizer(() =>
        Effect.promise(() => client.end({ timeout: 5 }))
          .pipe(Effect.catchAll(() => Effect.void))
      );

      return db;
    })
  );
```

---

## 8. Testing Considerations

### 8.1 Unit Testing Without ExecutionContext

For unit tests, the FiberRef will be `null` - tests need to handle this:

```typescript
// test/unit/services.test.ts
import { describe, it, expect } from "vitest";
import { Effect, Layer, Runtime } from "effect";
import { KVLive, KV } from "../src/services/kv";
import { KVMemory } from "../src/services/kv"; // In-memory mock

describe("KV Service", () => {
  const testLayer = KVMemory; // Use in-memory implementation

  it("should get and set values", async () => {
    const program = Effect.gen(function* () {
      const kv = yield* KV;
      const ops = kv.from("CACHE_KV");

      yield* ops.set("test-key", "test-value");
      const value = yield* ops.get("test-key");

      return value;
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(testLayer))
    );

    expect(Option.getOrNull(result)).toBe("test-value");
  });
});
```

### 8.2 Testing with Mock ExecutionContext

```typescript
// test/fixtures/mock-execution-context.ts
import { Effect } from "effect";
import { CurrentExecutionContext } from "../../src/services/execution-context";

/**
 * Create a mock ExecutionContext for testing.
 */
export const createMockExecutionContext = (): ExecutionContext => {
  const waitUntilPromises: Promise<unknown>[] = [];

  return {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    },
    passThroughOnException: () => {},
    // For test assertions
    _getWaitUntilPromises: () => waitUntilPromises,
  } as ExecutionContext & { _getWaitUntilPromises: () => Promise<unknown>[] };
};

/**
 * Run an effect with a mock ExecutionContext.
 */
export const withMockContext = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => {
  const mockCtx = createMockExecutionContext();
  return Effect.locally(effect, CurrentExecutionContext, mockCtx);
};
```

### 8.3 Integration Testing

```typescript
// test/integration/worker.test.ts
import { describe, it, expect } from "vitest";
import { Miniflare } from "miniflare";

describe("Worker Integration", () => {
  let mf: Miniflare;

  beforeAll(async () => {
    mf = new Miniflare({
      scriptPath: "./dist/worker.js",
      modules: true,
      kvNamespaces: ["CACHE_KV"],
      r2Buckets: ["ASSETS_BUCKET"],
    });
  });

  afterAll(async () => {
    await mf.dispose();
  });

  it("should handle requests with ExecutionContext", async () => {
    const response = await mf.dispatchFetch("http://localhost/health");
    expect(response.status).toBe(200);
  });
});
```

---

## 9. Trade-offs and Caveats

### 9.1 Benefits of Singleton Runtime

1. **Reduced Latency**: Layer initialization happens once, not per-request
2. **Resource Efficiency**: Database connections pooled across requests
3. **Predictable Memory**: No per-request GC pressure from runtime objects
4. **Simpler Mental Model**: Services are singletons (as expected in most frameworks)

### 9.2 Caveats

1. **Module Import Timing**: `env` from `cloudflare:workers` must be available at import time
2. **FiberRef Overhead**: Small overhead from FiberRef lookups (negligible in practice)
3. **Request Isolation**: Must be careful not to leak state between requests
4. **Testing Complexity**: Need to mock ExecutionContext for certain tests

### 9.3 When to Still Use Per-Request Runtime

Some scenarios may still warrant per-request runtime:

1. **Multi-tenant with different configs**: If `env` contains tenant-specific config that changes
2. **Hot module reload in dev**: May need fresh runtime after code changes
3. **Isolation requirements**: Security-critical apps needing strict request isolation

### 9.4 CloudflareBindings Migration

The existing `CloudflareBindings` service becomes **deprecated** in favor of:

1. Module-level `env` import for `env` access
2. `CurrentExecutionContext` FiberRef for `ctx` access

Services should migrate to these patterns instead of depending on `CloudflareBindings`.

---

## 10. Appendix: Complete Implementation

### 10.1 File Structure

```
src/
├── worker.ts                    # Entry point with singleton runtime
├── router.ts                    # Router with ctx middleware
├── app.ts                       # Layer composition
├── services/
│   ├── index.ts                 # Barrel exports
│   ├── execution-context.ts     # FiberRef and helpers
│   ├── config.ts                # Using module-level env
│   ├── kv.ts                    # Using module-level env
│   ├── storage.ts               # Using module-level env
│   ├── database.ts              # Using module-level env
│   └── background-tasks.ts      # Using FiberRef for ctx
└── routes/
    └── ...
```

### 10.2 Complete execution-context.ts

```typescript
// src/services/execution-context.ts
import { FiberRef, Effect, Data } from "effect";

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export class ExecutionContextError extends Data.TaggedError("ExecutionContextError")<{
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Request Extension
// ---------------------------------------------------------------------------

interface RequestWithContext extends Request {
  readonly __ctx: ExecutionContext;
}

// ---------------------------------------------------------------------------
// FiberRef
// ---------------------------------------------------------------------------

/**
 * FiberRef holding the current request's ExecutionContext.
 */
export const CurrentExecutionContext = FiberRef.unsafeMake<ExecutionContext | null>(null);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the current ExecutionContext.
 * Fails with ExecutionContextError if called outside a request.
 */
export const getExecutionContext: Effect.Effect<ExecutionContext, ExecutionContextError> =
  FiberRef.get(CurrentExecutionContext).pipe(
    Effect.flatMap((ctx) =>
      ctx === null
        ? Effect.fail(new ExecutionContextError({
            message: "ExecutionContext not available - ensure you're inside a request handler"
          }))
        : Effect.succeed(ctx)
    )
  );

/**
 * Schedule a background task via ctx.waitUntil().
 *
 * The effect will be run asynchronously and errors will be logged
 * but won't affect the request response.
 */
export const waitUntil = <A, E>(
  effect: Effect.Effect<A, E>,
  options?: { logErrors?: boolean }
): Effect.Effect<void, ExecutionContextError> =>
  Effect.gen(function* () {
    const ctx = yield* getExecutionContext;
    ctx.waitUntil(
      Effect.runPromise(
        effect.pipe(
          options?.logErrors !== false
            ? Effect.tapErrorCause(Effect.logError)
            : (e) => e,
          Effect.asVoid,
          Effect.catchAll(() => Effect.void)
        )
      )
    );
  });

/**
 * Run an effect with the given ExecutionContext set in FiberRef.
 */
export const withExecutionContext = <A, E, R>(
  ctx: ExecutionContext,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.locally(effect, CurrentExecutionContext, ctx);

/**
 * Attach ExecutionContext to a Request object.
 */
export const attachContext = (
  request: Request,
  ctx: ExecutionContext
): Request => Object.assign(request, { __ctx: ctx });

/**
 * Extract ExecutionContext from a Request object.
 */
export const extractContext = (request: Request): ExecutionContext | null =>
  (request as Partial<RequestWithContext>).__ctx ?? null;
```

### 10.3 Complete worker.ts

```typescript
// src/worker.ts
import { env } from "cloudflare:workers";
import { Layer, ManagedRuntime } from "effect";
import * as HttpApp from "@effect/platform/HttpApp";
import { appRouter } from "./router";
import { StaticAppLive } from "./app";
import { attachContext } from "./services/execution-context";

// ---------------------------------------------------------------------------
// Module-Level Initialization (runs once when isolate starts)
// ---------------------------------------------------------------------------

/**
 * Singleton managed runtime.
 *
 * The runtime and all its layers are created once when the module loads.
 * This avoids the overhead of layer initialization on every request.
 */
const managedRuntime = ManagedRuntime.make(StaticAppLive);

/**
 * Web handler promise.
 *
 * We create the handler once and reuse it for all requests.
 * The promise ensures we wait for runtime initialization.
 */
const handlerPromise = (async () => {
  const rt = await managedRuntime.runtime();
  return HttpApp.toWebHandlerRuntime(rt)(appRouter);
})();

// ---------------------------------------------------------------------------
// Worker Export
// ---------------------------------------------------------------------------

/**
 * Cloudflare Worker entry point.
 *
 * This is called for every incoming request. The handler is already
 * initialized, so we just need to:
 * 1. Attach ExecutionContext to the request
 * 2. Pass the request to the handler
 */
export default {
  async fetch(
    request: Request,
    _env: Env,           // Using cloudflare:workers import instead
    ctx: ExecutionContext
  ): Promise<Response> {
    const handler = await handlerPromise;

    // Attach ctx to request so middleware can extract it
    const requestWithCtx = attachContext(request, ctx);

    return handler(requestWithCtx);
  }
};
```

### 10.4 Complete router.ts with Middleware

```typescript
// src/router.ts
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Effect, ParseResult } from "effect";
import { routes } from "./routes";
import { CurrentExecutionContext, extractContext } from "./services/execution-context";

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Middleware that extracts ExecutionContext from the request
 * and sets it in the FiberRef for downstream handlers.
 */
const withExecutionContext = <E, R>(
  router: HttpRouter.HttpRouter<E, R>
): HttpRouter.HttpRouter<E, R> =>
  HttpRouter.use(router, (handler) =>
    Effect.gen(function* () {
      const serverRequest = yield* HttpServerRequest.HttpServerRequest;

      // Extract ctx from the native request object
      // (attached by the worker entry point)
      const nativeRequest = serverRequest.source as Request;
      const ctx = extractContext(nativeRequest);

      if (ctx) {
        // Run handler with FiberRef set to this ctx
        return yield* Effect.locally(handler, CurrentExecutionContext, ctx);
      } else {
        // No ctx (testing scenario) - run without it
        return yield* handler;
      }
    })
  );

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

const errorResponse = (status: number, error: string, message: string) =>
  HttpServerResponse.unsafeJson({ error, message }, { status });

// ---------------------------------------------------------------------------
// Main Router
// ---------------------------------------------------------------------------

export const appRouter = routes.pipe(
  // Apply ExecutionContext middleware first
  withExecutionContext,

  // Then apply error handling
  HttpRouter.catchAll((error: unknown) => {
    if (typeof error === "object" && error !== null && "_tag" in error) {
      const tag = (error as { _tag: string })._tag;

      switch (tag) {
        case "ParseError":
          return Effect.succeed(
            errorResponse(
              400,
              "ValidationError",
              ParseResult.TreeFormatter.formatErrorSync(
                error as unknown as ParseResult.ParseError
              )
            )
          );

        case "NotFoundError": {
          const e = error as { resource: string; id: string };
          return Effect.succeed(
            errorResponse(404, "NotFoundError", `${e.resource} with id ${e.id} not found`)
          );
        }

        case "ExecutionContextError":
          return Effect.succeed(
            errorResponse(500, "InternalError", "Request context unavailable")
          );

        // ... other error cases

        default:
          return Effect.succeed(
            errorResponse(500, "InternalError", "An unexpected error occurred")
          );
      }
    }

    console.error("Unhandled error:", error);
    return Effect.succeed(
      errorResponse(500, "InternalError", "An unexpected error occurred")
    );
  })
);
```

### 10.5 Updated app.ts

```typescript
// src/app.ts
import { Layer } from "effect";
import { ConfigLive, KVLive, StorageLive, DatabaseHyperdrive, BackgroundTasksLive } from "@/services";

/**
 * Static Application Layer
 *
 * These services are initialized once at module load and shared across
 * all requests. They only depend on `env` (via cloudflare:workers import),
 * not on ExecutionContext.
 */
export const StaticAppLive = Layer.mergeAll(
  ConfigLive,
  KVLive,
  StorageLive,
  BackgroundTasksLive,
);

/**
 * Full Application Layer with Database
 *
 * Includes database connection pooling. The pool is maintained across
 * requests for efficiency.
 */
export const AppWithDatabaseLive = Layer.merge(
  StaticAppLive,
  DatabaseHyperdrive()
);

// Type exports
export type StaticApp = Layer.Layer.Success<typeof StaticAppLive>;
export type AppWithDatabase = Layer.Layer.Success<typeof AppWithDatabaseLive>;
```

---

## Summary

This design achieves the goal of **singleton runtime initialization** while maintaining **request-scoped ExecutionContext access** through:

1. **Module-level env import** from `cloudflare:workers` for static configuration
2. **FiberRef pattern** for request-scoped `ExecutionContext`
3. **Request attachment pattern** to pass `ctx` through the platform's handler
4. **Middleware extraction** to set the FiberRef before handlers execute

The result is:
- **One-time layer initialization** when the worker isolate starts
- **Per-request ctx access** via `getExecutionContext` and `waitUntil` helpers
- **Type-safe API** with proper error handling
- **Testable design** with mock context support

This pattern significantly reduces per-request overhead while maintaining the ergonomics and type safety of Effect-based service composition.
