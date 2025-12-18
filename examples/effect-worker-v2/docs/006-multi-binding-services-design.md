# 006 - Multi-Binding Services Design

## Problem Statement

The current KV and ObjectStorage services are hardcoded to a single binding:

```typescript
// Current: Single binding, passed at layer creation time
export const KVStoreDefault = KVStoreLive("MY_KV")
export const ObjectStorageDefault = ObjectStorageLive("MY_BUCKET")
```

This creates several limitations:

1. **Single Binding Per Service**: Can only use one KV namespace or R2 bucket per application
2. **Static Binding Selection**: Must choose the binding at layer composition time, not at runtime
3. **No Type Safety on Binding Names**: `bindingName: keyof Env` accepts any env key, not just KV/R2 bindings
4. **Awkward Multi-Binding Setup**: Need multiple service instances with different tags

### Real-World Use Cases

Applications often need multiple bindings:

- **KV Namespaces**: `CACHE_KV`, `SESSION_KV`, `RATE_LIMIT_KV`
- **R2 Buckets**: `UPLOADS_BUCKET`, `ASSETS_BUCKET`, `BACKUPS_BUCKET`

---

## Design Goals

1. **Type-Safe Binding Selection**: Only show bindings of the correct type (KVNamespace, R2Bucket)
2. **Dynamic Binding Selection**: Choose binding at call site, not layer creation
3. **Effectful API**: All operations yield Effects with proper error handling
4. **Single Service Instance**: One service handles all bindings of a type
5. **Ergonomic Usage**: Clean, readable API at the call site

---

## Solution: Binding-Parameterized Operations

### Core Concept

Instead of creating the service with a binding name, pass the binding name to each operation:

```typescript
// New: Select binding at operation time
const kv = yield* KV
const value = yield* kv.from("CACHE_KV").get("my-key")

const storage = yield* Storage
const file = yield* storage.from("UPLOADS_BUCKET").get("file.pdf")
```

### Type-Safe Binding Extraction

Use TypeScript's conditional types to extract only bindings of a specific type:

```typescript
/**
 * Extract keys from Env where the value is of type T
 */
type BindingsOfType<T> = {
  [K in keyof Env]: Env[K] extends T ? K : never
}[keyof Env]

// Only KV namespace binding names
type KVBindingName = BindingsOfType<KVNamespace>
// Result: "MY_KV" | "CACHE_KV" | "SESSION_KV" (based on your Env)

// Only R2 bucket binding names
type R2BindingName = BindingsOfType<R2Bucket>
// Result: "MY_BUCKET" | "UPLOADS_BUCKET" | "ASSETS_BUCKET"
```

---

## Implementation

### Type Definitions

```typescript
// src/services/types.ts

/**
 * Extract keys from Env where the value extends type T
 */
export type BindingsOfType<T> = {
  [K in keyof Env]: Env[K] extends T ? K : never
}[keyof Env]

/**
 * KV Namespace binding names from Env
 */
export type KVBindingName = BindingsOfType<KVNamespace>

/**
 * R2 Bucket binding names from Env
 */
export type R2BindingName = BindingsOfType<R2Bucket>

/**
 * Hyperdrive binding names from Env
 */
export type HyperdriveBindingName = BindingsOfType<Hyperdrive>
```

### KV Service

```typescript
// src/services/kv.ts

import { Context, Effect, Layer, Option } from "effect"
import { Schema } from "@effect/schema"
import { CloudflareBindings } from "./bindings"
import { KVError } from "@/errors"
import type { KVBindingName } from "./types"

/**
 * Operations available on a KV namespace
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
}

/**
 * KV Service Interface
 *
 * Provides access to multiple KV namespaces with type-safe binding selection.
 */
export interface KVService {
  /**
   * Get operations for a specific KV namespace
   *
   * @param binding - Type-safe binding name (only KVNamespace bindings shown)
   * @returns Operations scoped to that namespace
   *
   * @example
   * ```typescript
   * const kv = yield* KV
   * const cache = kv.from("CACHE_KV")
   * const value = yield* cache.get("user:123")
   * ```
   */
  readonly from: (binding: KVBindingName) => KVOperations
}

/**
 * KV Service Tag
 */
export class KV extends Context.Tag("KV")<KV, KVService>() {}

/**
 * Create KV operations for a specific namespace
 */
const makeKVOperations = (kv: KVNamespace, bindingName: string): KVOperations => ({
  get: (key: string) =>
    Effect.tryPromise({
      try: () => kv.get(key),
      catch: (error) =>
        new KVError({
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

  getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
    Effect.gen(function* () {
      const value = yield* makeKVOperations(kv, bindingName).get(key)

      return yield* Option.match(value, {
        onNone: () => Effect.succeed(Option.none<A>()),
        onSome: (raw) =>
          Effect.gen(function* () {
            const parsed = yield* Effect.try({
              try: () => JSON.parse(raw) as unknown,
              catch: (error) =>
                new KVError({
                  operation: "getJson",
                  key,
                  message: `[${bindingName}] Invalid JSON in key "${key}"`,
                  cause: error,
                }),
            })

            const decoded = yield* Schema.decodeUnknown(schema)(parsed).pipe(
              Effect.mapError(
                (parseError) =>
                  new KVError({
                    operation: "getJson",
                    key,
                    message: `[${bindingName}] Schema validation failed`,
                    cause: parseError,
                  })
              )
            )

            return Option.some(decoded)
          }),
      })
    }).pipe(
      Effect.withSpan("kv.getJson", {
        attributes: { "kv.binding": bindingName, "kv.key": key },
      })
    ),

  set: (key: string, value: string, options) =>
    Effect.tryPromise({
      try: () => kv.put(key, value, options),
      catch: (error) =>
        new KVError({
          operation: "set",
          key,
          message: `[${bindingName}] Failed to set key "${key}"`,
          cause: error,
        }),
    }).pipe(
      Effect.withSpan("kv.set", {
        attributes: { "kv.binding": bindingName, "kv.key": key },
      })
    ),

  setJson: <A>(
    key: string,
    value: A,
    options?: { expirationTtl?: number; expiration?: number }
  ) =>
    Effect.gen(function* () {
      const json = JSON.stringify(value)
      yield* makeKVOperations(kv, bindingName).set(key, json, options)
    }).pipe(
      Effect.withSpan("kv.setJson", {
        attributes: { "kv.binding": bindingName, "kv.key": key },
      })
    ),

  delete: (key: string) =>
    Effect.tryPromise({
      try: () => kv.delete(key),
      catch: (error) =>
        new KVError({
          operation: "delete",
          key,
          message: `[${bindingName}] Failed to delete key "${key}"`,
          cause: error,
        }),
    }).pipe(
      Effect.withSpan("kv.delete", {
        attributes: { "kv.binding": bindingName, "kv.key": key },
      })
    ),

  list: (options) =>
    Effect.tryPromise({
      try: () => kv.list(options),
      catch: (error) =>
        new KVError({
          operation: "list",
          message: `[${bindingName}] Failed to list keys`,
          cause: error,
        }),
    }).pipe(
      Effect.map((result) => ({
        keys: result.keys,
        cursor: result.list_complete ? undefined : result.cursor,
      })),
      Effect.withSpan("kv.list", {
        attributes: { "kv.binding": bindingName },
      })
    ),
})

/**
 * Live KV Service Implementation
 */
export const KVLive = Layer.effect(
  KV,
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings

    // Cache operations per binding to avoid recreating
    const operationsCache = new Map<KVBindingName, KVOperations>()

    const service: KVService = {
      from: (binding: KVBindingName) => {
        const cached = operationsCache.get(binding)
        if (cached) return cached

        const namespace = env[binding] as KVNamespace
        const ops = makeKVOperations(namespace, binding)
        operationsCache.set(binding, ops)
        return ops
      },
    }

    return service
  })
)
```

### Storage Service

```typescript
// src/services/storage.ts

import { Context, Effect, Layer, Option } from "effect"
import { Schema } from "@effect/schema"
import { CloudflareBindings } from "./bindings"
import { StorageError } from "@/errors"
import type { R2BindingName } from "./types"

/**
 * Operations available on an R2 bucket
 */
export interface StorageOperations {
  readonly get: (key: string) => Effect.Effect<Option.Option<R2ObjectBody>, StorageError>

  readonly head: (key: string) => Effect.Effect<Option.Option<R2Object>, StorageError>

  readonly put: (
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: R2PutOptions
  ) => Effect.Effect<R2Object, StorageError>

  readonly delete: (key: string) => Effect.Effect<void, StorageError>

  readonly deleteMany: (keys: string[]) => Effect.Effect<void, StorageError>

  readonly list: (options?: R2ListOptions) => Effect.Effect<
    { objects: R2Object[]; truncated: boolean; cursor?: string },
    StorageError
  >

  readonly exists: (key: string) => Effect.Effect<boolean, StorageError>

  readonly getText: (key: string) => Effect.Effect<Option.Option<string>, StorageError>

  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<Option.Option<A>, StorageError, R>

  readonly putJson: <A>(
    key: string,
    value: A,
    options?: Omit<R2PutOptions, "httpMetadata">
  ) => Effect.Effect<R2Object, StorageError>
}

/**
 * Storage Service Interface
 *
 * Provides access to multiple R2 buckets with type-safe binding selection.
 */
export interface StorageService {
  /**
   * Get operations for a specific R2 bucket
   *
   * @param binding - Type-safe binding name (only R2Bucket bindings shown)
   * @returns Operations scoped to that bucket
   *
   * @example
   * ```typescript
   * const storage = yield* Storage
   * const uploads = storage.from("UPLOADS_BUCKET")
   * const file = yield* uploads.get("documents/report.pdf")
   * ```
   */
  readonly from: (binding: R2BindingName) => StorageOperations
}

/**
 * Storage Service Tag
 */
export class Storage extends Context.Tag("Storage")<Storage, StorageService>() {}

/**
 * Create Storage operations for a specific bucket
 */
const makeStorageOperations = (r2: R2Bucket, bindingName: string): StorageOperations => {
  const ops: StorageOperations = {
    get: (key: string) =>
      Effect.tryPromise({
        try: () => r2.get(key),
        catch: (error) =>
          new StorageError({
            operation: "get",
            key,
            message: `[${bindingName}] Failed to get object "${key}"`,
            cause: error,
          }),
      }).pipe(
        Effect.map(Option.fromNullable),
        Effect.withSpan("storage.get", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),

    head: (key: string) =>
      Effect.tryPromise({
        try: () => r2.head(key),
        catch: (error) =>
          new StorageError({
            operation: "head",
            key,
            message: `[${bindingName}] Failed to get metadata "${key}"`,
            cause: error,
          }),
      }).pipe(
        Effect.map(Option.fromNullable),
        Effect.withSpan("storage.head", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),

    put: (key, value, options) =>
      Effect.tryPromise({
        try: () => r2.put(key, value, options),
        catch: (error) =>
          new StorageError({
            operation: "put",
            key,
            message: `[${bindingName}] Failed to put object "${key}"`,
            cause: error,
          }),
      }).pipe(
        Effect.withSpan("storage.put", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),

    delete: (key) =>
      Effect.tryPromise({
        try: () => r2.delete(key),
        catch: (error) =>
          new StorageError({
            operation: "delete",
            key,
            message: `[${bindingName}] Failed to delete object "${key}"`,
            cause: error,
          }),
      }).pipe(
        Effect.withSpan("storage.delete", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),

    deleteMany: (keys) =>
      Effect.tryPromise({
        try: () => r2.delete(keys),
        catch: (error) =>
          new StorageError({
            operation: "deleteMany",
            message: `[${bindingName}] Failed to delete ${keys.length} objects`,
            cause: error,
          }),
      }).pipe(
        Effect.withSpan("storage.deleteMany", {
          attributes: { "storage.binding": bindingName, "storage.count": keys.length },
        })
      ),

    list: (options) =>
      Effect.tryPromise({
        try: () => r2.list(options),
        catch: (error) =>
          new StorageError({
            operation: "list",
            message: `[${bindingName}] Failed to list objects`,
            cause: error,
          }),
      }).pipe(
        Effect.withSpan("storage.list", {
          attributes: { "storage.binding": bindingName },
        })
      ),

    exists: (key) =>
      ops.head(key).pipe(Effect.map(Option.isSome)),

    getText: (key) =>
      ops.get(key).pipe(
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
                    message: `[${bindingName}] Failed to read text from "${key}"`,
                    cause: error,
                  }),
              }).pipe(Effect.map(Option.some)),
          })
        ),
        Effect.withSpan("storage.getText", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),

    getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
      ops.getText(key).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<A>()),
            onSome: (text) =>
              Effect.gen(function* () {
                const parsed = yield* Effect.try({
                  try: () => JSON.parse(text) as unknown,
                  catch: (error) =>
                    new StorageError({
                      operation: "getJson",
                      key,
                      message: `[${bindingName}] Invalid JSON in "${key}"`,
                      cause: error,
                    }),
                })

                const decoded = yield* Schema.decodeUnknown(schema)(parsed).pipe(
                  Effect.mapError(
                    (parseError) =>
                      new StorageError({
                        operation: "getJson",
                        key,
                        message: `[${bindingName}] Schema validation failed`,
                        cause: parseError,
                      })
                  )
                )

                return Option.some(decoded)
              }),
          })
        ),
        Effect.withSpan("storage.getJson", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),

    putJson: <A>(key: string, value: A, options?: Omit<R2PutOptions, "httpMetadata">) =>
      Effect.gen(function* () {
        const json = JSON.stringify(value)
        return yield* ops.put(key, json, {
          ...options,
          httpMetadata: { contentType: "application/json" },
        })
      }).pipe(
        Effect.withSpan("storage.putJson", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),
  }

  return ops
}

/**
 * Live Storage Service Implementation
 */
export const StorageLive = Layer.effect(
  Storage,
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings

    // Cache operations per binding to avoid recreating
    const operationsCache = new Map<R2BindingName, StorageOperations>()

    const service: StorageService = {
      from: (binding: R2BindingName) => {
        const cached = operationsCache.get(binding)
        if (cached) return cached

        const bucket = env[binding] as R2Bucket
        const ops = makeStorageOperations(bucket, binding)
        operationsCache.set(binding, ops)
        return ops
      },
    }

    return service
  })
)
```

---

## Usage Examples

### Basic Usage

```typescript
import { Effect } from "effect"
import { KV, Storage } from "@/services"

const program = Effect.gen(function* () {
  const kv = yield* KV
  const storage = yield* Storage

  // KV operations with different namespaces
  const cache = kv.from("CACHE_KV")
  const sessions = kv.from("SESSION_KV")

  yield* cache.set("user:123:profile", JSON.stringify({ name: "Alice" }))
  const session = yield* sessions.get("sess:abc")

  // Storage operations with different buckets
  const uploads = storage.from("UPLOADS_BUCKET")
  const assets = storage.from("ASSETS_BUCKET")

  const avatar = yield* uploads.get("users/123/avatar.png")
  yield* assets.put("images/logo.svg", svgContent, {
    httpMetadata: { contentType: "image/svg+xml" },
  })
})
```

### In Route Handlers

```typescript
// src/api/routes/files.ts
import { Hono } from "hono"
import { Effect, Option } from "effect"
import { effectHandler } from "../effect"
import { Storage } from "@/services"
import { NotFoundError } from "@/errors"
import type { AppDependencies } from "@/app"

const app = new Hono()

/**
 * GET /files/uploads/:key
 * Get a file from the uploads bucket
 */
app.get(
  "/uploads/*",
  effectHandler<AppDependencies>((c) =>
    Effect.gen(function* () {
      const key = c.req.path.replace("/files/uploads/", "")
      const storage = yield* Storage

      const file = yield* storage.from("UPLOADS_BUCKET").get(key)

      if (Option.isNone(file)) {
        return yield* Effect.fail(new NotFoundError({ resource: "File", id: key }))
      }

      return new Response(file.value.body, {
        headers: {
          "Content-Type": file.value.httpMetadata?.contentType ?? "application/octet-stream",
        },
      })
    })
  )
)

/**
 * GET /files/assets/:key
 * Get a file from the assets bucket
 */
app.get(
  "/assets/*",
  effectHandler<AppDependencies>((c) =>
    Effect.gen(function* () {
      const key = c.req.path.replace("/files/assets/", "")
      const storage = yield* Storage

      const file = yield* storage.from("ASSETS_BUCKET").get(key)

      if (Option.isNone(file)) {
        return yield* Effect.fail(new NotFoundError({ resource: "Asset", id: key }))
      }

      return new Response(file.value.body, {
        headers: {
          "Content-Type": file.value.httpMetadata?.contentType ?? "application/octet-stream",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      })
    })
  )
)
```

### Caching Pattern

```typescript
// src/lib/cache.ts
import { Effect, Option, Duration } from "effect"
import { KV } from "@/services"

/**
 * Cache-aside pattern with KV
 */
export const cached = <A, E, R>(
  key: string,
  ttlSeconds: number,
  compute: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | KV> =>
  Effect.gen(function* () {
    const kv = yield* KV
    const cache = kv.from("CACHE_KV")

    // Try cache first
    const cached = yield* cache.get(key).pipe(
      Effect.map(Option.map((s) => JSON.parse(s) as A)),
      Effect.orElseSucceed(() => Option.none<A>())
    )

    if (Option.isSome(cached)) {
      return cached.value
    }

    // Compute and cache
    const value = yield* compute
    yield* cache.set(key, JSON.stringify(value), { expirationTtl: ttlSeconds }).pipe(
      Effect.catchAll(() => Effect.void) // Don't fail if cache write fails
    )

    return value
  })

// Usage
const getExpensiveData = (id: string) =>
  cached(
    `expensive:${id}`,
    3600, // 1 hour TTL
    Effect.gen(function* () {
      // Expensive computation here
      return { data: "computed" }
    })
  )
```

---

## Layer Composition

```typescript
// src/app.ts
import { Layer } from "effect"
import { KVLive, StorageLive, ConfigLive, DatabaseHyperdrive } from "@/services"

/**
 * Core Application Layer
 *
 * Includes KV and Storage with multi-binding support
 */
export const AppCoreLive = Layer.mergeAll(
  ConfigLive,
  KVLive,
  StorageLive,
)

/**
 * Full Application Layer (with Database)
 */
export const AppLive = (hyperdrive: Hyperdrive) =>
  Layer.mergeAll(
    AppCoreLive,
    DatabaseHyperdrive(hyperdrive),
  )
```

---

## Type Safety Demonstration

Given this `Env` type (generated by `wrangler types`):

```typescript
// worker-configuration.d.ts
interface Env {
  // KV Namespaces
  CACHE_KV: KVNamespace
  SESSION_KV: KVNamespace
  RATE_LIMIT_KV: KVNamespace

  // R2 Buckets
  UPLOADS_BUCKET: R2Bucket
  ASSETS_BUCKET: R2Bucket
  BACKUPS_BUCKET: R2Bucket

  // Other bindings
  HYPERDRIVE: Hyperdrive
  ENVIRONMENT: string
}
```

The type system enforces:

```typescript
const kv = yield* KV
const storage = yield* Storage

// ✅ Valid - these are KVNamespace bindings
kv.from("CACHE_KV")
kv.from("SESSION_KV")
kv.from("RATE_LIMIT_KV")

// ❌ Type Error - not a KVNamespace
kv.from("UPLOADS_BUCKET")  // Error: R2Bucket is not assignable to KVNamespace
kv.from("ENVIRONMENT")     // Error: string is not assignable to KVNamespace
kv.from("HYPERDRIVE")      // Error: Hyperdrive is not assignable to KVNamespace

// ✅ Valid - these are R2Bucket bindings
storage.from("UPLOADS_BUCKET")
storage.from("ASSETS_BUCKET")
storage.from("BACKUPS_BUCKET")

// ❌ Type Error - not an R2Bucket
storage.from("CACHE_KV")   // Error: KVNamespace is not assignable to R2Bucket
storage.from("HYPERDRIVE") // Error: Hyperdrive is not assignable to R2Bucket
```

---

## Migration Path

### From Current Single-Binding Services

**Before:**
```typescript
// Current usage
const kvStore = yield* KVStore
const value = yield* kvStore.get("key")

const storage = yield* ObjectStorage
const file = yield* storage.get("file.pdf")
```

**After:**
```typescript
// New usage - specify binding
const kv = yield* KV
const value = yield* kv.from("MY_KV").get("key")

const storage = yield* Storage
const file = yield* storage.from("MY_BUCKET").get("file.pdf")
```

### Gradual Migration

Keep both patterns during migration:

```typescript
// services/index.ts

// New multi-binding services
export { KV, KVLive } from "./kv-multi"
export { Storage, StorageLive } from "./storage-multi"

// Legacy single-binding (deprecated, remove after migration)
export { KVStore, KVStoreDefault } from "./kv"
export { ObjectStorage, ObjectStorageDefault } from "./storage"
```

---

## Benefits

1. **Type Safety**: IDE autocomplete shows only valid bindings
2. **Flexibility**: Use any binding at any call site
3. **Single Service**: One layer handles all bindings of a type
4. **Tracing**: Binding name included in all spans for observability
5. **Performance**: Operations cached per binding, created lazily
6. **Ergonomic**: Clean `service.from(binding).operation()` API

## Trade-offs

1. **Slightly More Verbose**: Must call `.from()` on each operation chain
2. **Runtime Binding Selection**: Binding errors only caught at runtime (though TypeScript catches invalid binding names at compile time)

---

## Conclusion

This pattern provides a truly effectful, type-safe API for working with multiple Cloudflare bindings. By moving binding selection to the operation level and using TypeScript's type system to constrain valid binding names, we get the best of both worlds: flexibility and safety.
