# 008: GlobalThis Pattern for Type Disambiguation

## Overview

This document explores the `globalThis` pattern used in `effect-cloudflare` and how it can improve type safety, clarity, and API design in the Effect Worker codebase.

## Background

### What is `globalThis`?

`globalThis` is a standard JavaScript global object that provides consistent access to the global scope across all environments (browsers, Node.js, Cloudflare Workers, Deno, etc.). In TypeScript, it serves an additional purpose: **namespace qualification for ambient types**.

```typescript
// These are equivalent when KVNamespace is an ambient global type:
const kv1: KVNamespace = env.MY_KV
const kv2: globalThis.KVNamespace = env.MY_KV

// But globalThis becomes essential when you have local types with the same name
```

### The Problem: Type Name Collisions

When building Effect wrappers around Cloudflare APIs, you often want to:

1. Accept native Cloudflare types as input (what the runtime provides)
2. Return Effect-wrapped types with typed errors and composable methods
3. Use intuitive names that match the Cloudflare API

This creates a naming conflict:

```typescript
// Native Cloudflare type (from @cloudflare/workers-types)
interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  // ... untyped errors, no Effect integration
}

// Your Effect wrapper (what you want to expose)
interface KVNamespace {
  get(key: string): Effect<Option<string>, KVError>
  put(key: string, value: string): Effect<void, KVError>
  // ... typed errors, Effect composition
}
```

Without disambiguation, TypeScript can't distinguish between these.

## The `globalThis` Pattern

### Core Concept

Use `globalThis.X` to reference the native platform type, and `X` (unqualified) for your Effect-wrapped version:

```typescript
// effect-cloudflare/src/KVNamespace.ts
export const make: <Key extends string = string>(
  kv: globalThis.KVNamespace<Key>  // Native input
) => KVNamespace<Key>              // Effect-wrapped output
```

### Pattern Components

#### 1. Type Disambiguation

```typescript
// Constructor accepts native type, returns wrapped type
export const make = (bucket: globalThis.R2Bucket): R2Bucket => {
  return {
    head: (key) => Effect.tryPromise({
      try: () => bucket.head(key),
      catch: (error) => new R2HeadError({ key, cause: error })
    }).pipe(Effect.map(Option.fromNullable)),
    // ... other wrapped methods
  }
}
```

#### 2. The `~raw` Escape Hatch

Provide access to the original native object for advanced use cases:

```typescript
export interface R2Bucket {
  readonly head: (key: string) => Effect<Option<R2Object>, R2HeadError>
  readonly get: (key: string) => Effect<Option<R2ObjectBody>, R2GetError>
  readonly put: (key: string, value: R2Value) => Effect<R2Object, R2PutError>

  // Escape hatch - access native API directly
  readonly ["~raw"]: globalThis.R2Bucket
}
```

The `~raw` property uses a tilde prefix convention to:
- Indicate it's a "special" property, not a normal method
- Avoid collision with any actual API methods
- Signal to users this breaks the Effect abstraction

#### 3. Layer Factories

Create layers that accept native types:

```typescript
export const layer = (kv: globalThis.KVNamespace): Layer.Layer<KVNamespace> =>
  Layer.succeed(KVNamespace, make(kv))

export const withKVNamespace: {
  (kv: globalThis.KVNamespace): <A, E, R>(
    effect: Effect<A, E, R>
  ) => Effect<A, E, R>
  <A, E, R>(
    effect: Effect<A, E, R>,
    kv: globalThis.KVNamespace
  ): Effect<A, E, R>
} = dual(2, (effect, kv) =>
  Effect.provideService(effect, KVNamespace, make(kv))
)
```

## Current State in `src/`

### How Types Are Currently Used

```typescript
// src/services/kv.ts - Current implementation
const makeKVOperations = (
  kv: KVNamespace,      // Implicitly globalThis.KVNamespace
  bindingName: string
): KVOperations => { ... }

// src/services/storage.ts - Current implementation
const makeStorageOperations = (
  r2: R2Bucket,         // Implicitly globalThis.R2Bucket
  bindingName: string
): StorageOperations => { ... }

// src/services/bindings.ts - Current implementation
export class CloudflareBindings extends Context.Tag("CloudflareBindings")<
  CloudflareBindings,
  {
    readonly env: Env
    readonly ctx: ExecutionContext  // Native type
  }
>() {}
```

### Current Limitations

1. **Implicit type references**: It's unclear whether `KVNamespace` refers to the native or a local type
2. **No escape hatches**: Users can't access native APIs if needed
3. **ExecutionContext is raw**: The `ctx` property exposes native `ExecutionContext` without Effect wrapping

## Proposed Improvements

### 1. Explicit Type References

Update internal implementations to use explicit `globalThis` references:

```typescript
// src/services/kv.ts - Improved
const makeKVOperations = (
  kv: globalThis.KVNamespace,  // Explicitly native type
  bindingName: string
): KVOperations => {
  return {
    get: (key) => Effect.tryPromise({
      try: () => kv.get(key),
      catch: (error) => new KVError({ operation: "get", key, cause: error })
    }).pipe(Effect.map(Option.fromNullable)),
    // ...
    ["~raw"]: kv  // Expose escape hatch
  }
}
```

### 2. Enhanced KVOperations Interface

```typescript
// src/services/kv.ts - Enhanced interface
export interface KVOperations {
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, KVError>
  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<Option.Option<A>, KVError, R>
  readonly set: (
    key: string,
    value: string,
    options?: KVPutOptions
  ) => Effect.Effect<void, KVError>
  readonly delete: (key: string) => Effect.Effect<void, KVError>
  readonly list: (options?: KVListOptions) => Effect.Effect<KVListResult, KVError>

  /**
   * Access the raw KVNamespace for operations not covered by this wrapper.
   *
   * @example
   * ```typescript
   * const kv = yield* KV
   * const cache = kv.from("CACHE_KV")
   * // Use native API for getWithMetadata with custom type handling
   * const result = await cache["~raw"].getWithMetadata(key, { type: "arrayBuffer" })
   * ```
   */
  readonly ["~raw"]: globalThis.KVNamespace
}
```

### 3. Effect-Wrapped ExecutionContext

Create a proper Effect wrapper for `ExecutionContext`:

```typescript
// src/services/execution-context.ts - New file
import { Context, Effect, Layer } from "effect"

/**
 * Effect-wrapped Cloudflare ExecutionContext
 */
export interface CloudflareExecutionContext {
  /**
   * Schedule a background task that continues after response is sent.
   * The effect will be run with error logging but won't affect the response.
   */
  readonly waitUntil: <A, E>(effect: Effect.Effect<A, E>) => void

  /**
   * Allow the worker to fail open and pass through to origin on unhandled error.
   */
  readonly passThroughOnException: Effect.Effect<void>

  /**
   * Access the raw ExecutionContext for advanced use cases.
   */
  readonly ["~raw"]: globalThis.ExecutionContext
}

/**
 * ExecutionContext service tag
 */
export class ExecutionContext extends Context.Tag("ExecutionContext")<
  ExecutionContext,
  CloudflareExecutionContext
>() {}

/**
 * Create an Effect-wrapped ExecutionContext from the native one
 */
export const make = (
  ctx: globalThis.ExecutionContext
): CloudflareExecutionContext => ({
  waitUntil: <A, E>(effect: Effect.Effect<A, E>) => {
    ctx.waitUntil(
      Effect.runPromise(
        effect.pipe(
          Effect.tapErrorCause(Effect.logError),
          Effect.asVoid,
          Effect.catchAll(() => Effect.void)
        )
      )
    )
  },
  passThroughOnException: Effect.sync(() => ctx.passThroughOnException?.()),
  ["~raw"]: ctx
})

/**
 * Create a layer providing ExecutionContext
 */
export const layer = (
  ctx: globalThis.ExecutionContext
): Layer.Layer<ExecutionContext> =>
  Layer.succeed(ExecutionContext, make(ctx))
```

### 4. Updated CloudflareBindings Service

Split the monolithic bindings into focused services:

```typescript
// src/services/bindings.ts - Refactored
import { Context, Layer } from "effect"
import { ExecutionContext, make as makeExecutionContext } from "./execution-context"

/**
 * CloudflareEnv provides access to the raw Cloudflare env object.
 *
 * Most code should use higher-level services (KV, Storage, Config) instead.
 * This is primarily for accessing bindings not yet wrapped by services.
 */
export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
  CloudflareEnv,
  {
    readonly env: Env
    readonly ["~raw"]: Env  // Same as env, for pattern consistency
  }
>() {
  static layer(env: Env) {
    return Layer.succeed(this, { env, ["~raw"]: env })
  }
}

/**
 * Create the complete bindings layer from native env and ctx.
 *
 * This layer provides both CloudflareEnv and ExecutionContext services.
 */
export const makeBindingsLayer = (
  env: Env,
  ctx: globalThis.ExecutionContext
) => Layer.mergeAll(
  CloudflareEnv.layer(env),
  ExecutionContext.layer(ctx)
)
```

### 5. Enhanced StorageOperations Interface

```typescript
// src/services/storage.ts - Enhanced interface
export interface StorageOperations {
  readonly get: (key: string) => Effect.Effect<Option.Option<R2ObjectBody>, StorageError>
  readonly head: (key: string) => Effect.Effect<Option.Option<R2Object>, StorageError>
  readonly put: (
    key: string,
    value: R2Value,
    options?: R2PutOptions
  ) => Effect.Effect<R2Object, StorageError>
  readonly delete: (key: string) => Effect.Effect<void, StorageError>
  readonly list: (options?: R2ListOptions) => Effect.Effect<R2ListResult, StorageError>

  // Convenience methods
  readonly exists: (key: string) => Effect.Effect<boolean, StorageError>
  readonly getText: (key: string) => Effect.Effect<Option.Option<string>, StorageError>
  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<Option.Option<A>, StorageError, R>
  readonly putJson: <A>(
    key: string,
    value: A,
    options?: R2PutOptions
  ) => Effect.Effect<R2Object, StorageError>

  /**
   * Access the raw R2Bucket for operations not covered by this wrapper.
   *
   * @example
   * ```typescript
   * const storage = yield* Storage
   * const bucket = storage.from("UPLOADS_BUCKET")
   * // Use native API for multipart uploads
   * const upload = await bucket["~raw"].createMultipartUpload(key)
   * ```
   */
  readonly ["~raw"]: globalThis.R2Bucket
}
```

## Implementation Strategy

### Phase 1: Add Explicit Type References

Update existing code to use `globalThis` prefix for clarity:

```typescript
// Before
const makeKVOperations = (kv: KVNamespace, bindingName: string): KVOperations

// After
const makeKVOperations = (kv: globalThis.KVNamespace, bindingName: string): KVOperations
```

**Files to update:**
- `src/services/kv.ts`
- `src/services/storage.ts`
- `src/services/bindings.ts`

### Phase 2: Add Escape Hatches

Add `~raw` properties to operation interfaces:

```typescript
// In makeKVOperations return object
return {
  get: (key) => /* ... */,
  set: (key, value, options) => /* ... */,
  // Add escape hatch
  ["~raw"]: kv
}
```

**Update interfaces in:**
- `KVOperations`
- `StorageOperations`

### Phase 3: Create ExecutionContext Service

Create a new dedicated service for ExecutionContext with Effect-based `waitUntil`:

1. Create `src/services/execution-context.ts`
2. Update `src/services/bindings.ts` to use it
3. Update `src/services/index.ts` exports
4. Update consumers to use the new service

### Phase 4: Documentation Updates

Update CLAUDE.md and JSDoc comments to explain:
- When to use `globalThis.X` vs `X`
- How to use `~raw` escape hatches
- The layered service architecture

## Benefits

### 1. Type Safety

Explicit `globalThis` references make it clear what type you're working with:

```typescript
// Clear: accepts native, returns wrapped
export const make = (kv: globalThis.KVNamespace): KVNamespace

// Ambiguous: which KVNamespace?
export const make = (kv: KVNamespace): KVNamespace
```

### 2. Future-Proofing

If you later create local type definitions that shadow global names, the code continues to work:

```typescript
// This will still work even if you define a local KVNamespace type
const makeKVOperations = (kv: globalThis.KVNamespace): KVOperations
```

### 3. Escape Hatch Flexibility

Users can access native APIs when needed without abandoning the Effect wrapper:

```typescript
const kv = yield* KV
const cache = kv.from("CACHE_KV")

// Normal usage - typed errors, Effect composition
const value = yield* cache.get("key")

// Escape hatch - when you need native API
const stream = await cache["~raw"].get("large-file", { type: "stream" })
```

### 4. Consistent API Design

Following the same pattern as `effect-cloudflare` creates consistency:

```typescript
// effect-cloudflare
import { KVNamespace } from "@effect-cloudflare/KVNamespace"
const kv = KVNamespace.make(env.MY_KV)

// effect-worker (consistent pattern)
import { KV } from "@/services"
const kv = yield* KV
const ops = kv.from("MY_KV")
```

### 5. Better IDE Experience

Explicit type references improve autocomplete and hover documentation:

```typescript
// Hover shows: (parameter) kv: globalThis.KVNamespace
// Clear that this is the Cloudflare Workers runtime type
const makeKVOperations = (kv: globalThis.KVNamespace)
```

## Trade-offs

### Verbosity

Using `globalThis.` adds characters to type annotations. Mitigate with:
- Only use in public API boundaries and constructors
- Internal implementation can use unqualified names if no local shadow exists

### Learning Curve

Developers unfamiliar with the pattern may be confused. Mitigate with:
- Clear documentation (this document)
- Consistent usage across the codebase
- JSDoc comments explaining the distinction

### Maintenance

Must remember to use `globalThis` when appropriate. Mitigate with:
- ESLint rules could enforce this in specific files
- Code review checklist item
- Consistent patterns in existing code

## References

- [MDN: globalThis](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/globalThis)
- [TypeScript: Global Types](https://www.typescriptlang.org/docs/handbook/declaration-files/templates/global-d-ts.html)
- [Cloudflare Workers Types](https://github.com/cloudflare/workers-types)
- [Effect-TS Context and Layers](https://effect.website/docs/guides/context-management/layers)

## Appendix: Complete Example

```typescript
// src/services/kv.ts - Complete refactored example

import { Context, Effect, Layer, Option } from "effect"
import { Schema } from "effect"
import { CloudflareEnv } from "./bindings"
import { KVError } from "@/errors"
import type { KVBindingName } from "./types"

/**
 * Effect-wrapped KV operations with typed errors
 */
export interface KVOperations {
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, KVError>
  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<Option.Option<A>, KVError, R>
  readonly set: (
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }
  ) => Effect.Effect<void, KVError>
  readonly setJson: <A>(
    key: string,
    value: A,
    options?: { expirationTtl?: number; expiration?: number }
  ) => Effect.Effect<void, KVError>
  readonly delete: (key: string) => Effect.Effect<void, KVError>
  readonly list: (options?: {
    prefix?: string
    limit?: number
    cursor?: string
  }) => Effect.Effect<{ keys: Array<{ name: string }>; cursor?: string }, KVError>

  /**
   * Access the raw KVNamespace for native API operations.
   * Use this when you need functionality not exposed by the wrapper.
   */
  readonly ["~raw"]: globalThis.KVNamespace
}

/**
 * KV Service providing access to multiple KV namespaces
 */
export interface KVService {
  readonly from: (binding: KVBindingName) => KVOperations
}

export class KV extends Context.Tag("KV")<KV, KVService>() {}

/**
 * Create Effect-wrapped KV operations from a native KVNamespace
 */
const makeKVOperations = (
  kv: globalThis.KVNamespace,
  bindingName: string
): KVOperations => {
  const ops: KVOperations = {
    get: (key) =>
      Effect.tryPromise({
        try: () => kv.get(key),
        catch: (error) => new KVError({
          operation: "get",
          key,
          message: `[${bindingName}] Failed to get key "${key}"`,
          cause: error,
        }),
      }).pipe(
        Effect.map(Option.fromNullable),
        Effect.withSpan("kv.get", {
          attributes: { "kv.binding": bindingName, "kv.key": key },
        })
      ),

    // ... other methods ...

    ["~raw"]: kv,
  }

  return ops
}

/**
 * Live KV Service implementation
 */
export const KVLive = Layer.effect(
  KV,
  Effect.gen(function* () {
    const { env } = yield* CloudflareEnv
    const cache = new Map<KVBindingName, KVOperations>()

    return {
      from: (binding) => {
        let ops = cache.get(binding)
        if (!ops) {
          ops = makeKVOperations(
            env[binding] as globalThis.KVNamespace,
            binding
          )
          cache.set(binding, ops)
        }
        return ops
      },
    }
  })
)
```
