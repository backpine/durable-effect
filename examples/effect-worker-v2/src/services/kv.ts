import { Context, Effect, Layer, Option } from "effect"
import { Schema } from "effect"
import { CloudflareEnv } from "./cloudflare"
import { KVError } from "@/errors"
import type { KVBindingName } from "./types"

/**
 * Operations available on a KV namespace
 *
 * IMPORTANT: Methods require CloudflareEnv to be provided in the context.
 * This is provided per-request via Context.make(CloudflareEnv, { env }).
 */
export interface KVOperations {
  /**
   * Get a value by key
   */
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, KVError, CloudflareEnv>

  /**
   * Get a JSON value with schema validation
   */
  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<Option.Option<A>, KVError, CloudflareEnv | R>

  /**
   * Get a value with metadata
   */
  readonly getWithMetadata: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<Option.Option<{ value: string; metadata: A }>, KVError, CloudflareEnv | R>

  /**
   * Set a value
   */
  readonly set: (
    key: string,
    value: string,
    options?: {
      expirationTtl?: number
      expiration?: number
      metadata?: unknown
    }
  ) => Effect.Effect<void, KVError, CloudflareEnv>

  /**
   * Set a JSON value
   */
  readonly setJson: <A>(
    key: string,
    value: A,
    options?: {
      expirationTtl?: number
      expiration?: number
    }
  ) => Effect.Effect<void, KVError, CloudflareEnv>

  /**
   * Delete a key
   */
  readonly delete: (key: string) => Effect.Effect<void, KVError, CloudflareEnv>

  /**
   * List keys with optional prefix
   */
  readonly list: (options?: {
    prefix?: string
    limit?: number
    cursor?: string
  }) => Effect.Effect<{ keys: Array<{ name: string }>; cursor?: string }, KVError, CloudflareEnv>
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
 * Create KV operations for a specific namespace.
 *
 * IMPORTANT: Each method accesses CloudflareEnv at CALL time, not construction time.
 * This allows the layer to be built once while still accessing request-specific env.
 */
const makeKVOperations = (bindingName: KVBindingName): KVOperations => {
  const getKV = Effect.gen(function* () {
    const { env } = yield* CloudflareEnv
    return env[bindingName] as KVNamespace
  })

  const ops: KVOperations = {
    get: (key: string) =>
      Effect.gen(function* () {
        const kv = yield* getKV
        return yield* Effect.tryPromise({
          try: () => kv.get(key),
          catch: (error) =>
            new KVError({
              operation: "get",
              key,
              message: `[${bindingName}] Failed to get key "${key}"`,
              cause: error,
            }),
        })
      }).pipe(
        Effect.map(Option.fromNullable),
        Effect.withSpan("kv.get", {
          attributes: { "kv.binding": bindingName, "kv.key": key },
        })
      ),

    getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
      ops.get(key).pipe(
        Effect.flatMap(
          Option.match({
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
        ),
        Effect.withSpan("kv.getJson", {
          attributes: { "kv.binding": bindingName, "kv.key": key },
        })
      ),

    getWithMetadata: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
      Effect.gen(function* () {
        const kv = yield* getKV
        const result = yield* Effect.tryPromise({
          try: () => kv.getWithMetadata(key),
          catch: (error) =>
            new KVError({
              operation: "getWithMetadata",
              key,
              message: `[${bindingName}] Failed to get metadata for key "${key}"`,
              cause: error,
            }),
        })

        if (result.value === null) {
          return Option.none()
        }

        const metadata = yield* Schema.decodeUnknown(schema)(result.metadata).pipe(
          Effect.mapError(
            (parseError) =>
              new KVError({
                operation: "getWithMetadata",
                key,
                message: `[${bindingName}] Metadata validation failed`,
                cause: parseError,
              })
          )
        )

        return Option.some({
          value: result.value,
          metadata,
        })
      }).pipe(
        Effect.withSpan("kv.getWithMetadata", {
          attributes: { "kv.binding": bindingName, "kv.key": key },
        })
      ),

    set: (key, value, options) =>
      Effect.gen(function* () {
        const kv = yield* getKV
        yield* Effect.tryPromise({
          try: () => kv.put(key, value, options),
          catch: (error) =>
            new KVError({
              operation: "set",
              key,
              message: `[${bindingName}] Failed to set key "${key}"`,
              cause: error,
            }),
        })
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
        yield* ops.set(key, json, options)
      }).pipe(
        Effect.withSpan("kv.setJson", {
          attributes: { "kv.binding": bindingName, "kv.key": key },
        })
      ),

    delete: (key) =>
      Effect.gen(function* () {
        const kv = yield* getKV
        yield* Effect.tryPromise({
          try: () => kv.delete(key),
          catch: (error) =>
            new KVError({
              operation: "delete",
              key,
              message: `[${bindingName}] Failed to delete key "${key}"`,
              cause: error,
            }),
        })
      }).pipe(
        Effect.withSpan("kv.delete", {
          attributes: { "kv.binding": bindingName, "kv.key": key },
        })
      ),

    list: (options) =>
      Effect.gen(function* () {
        const kv = yield* getKV
        const result = yield* Effect.tryPromise({
          try: () => kv.list(options),
          catch: (error) =>
            new KVError({
              operation: "list",
              message: `[${bindingName}] Failed to list keys`,
              cause: error,
            }),
        })
        return {
          keys: result.keys,
          cursor: result.list_complete ? undefined : result.cursor,
        }
      }).pipe(
        Effect.withSpan("kv.list", {
          attributes: { "kv.binding": bindingName },
        })
      ),
  }

  return ops
}

/**
 * Live KV Service Implementation
 *
 * IMPORTANT: This layer is built ONCE at module level.
 * CloudflareEnv is accessed at METHOD CALL time, not construction time.
 */
export const KVLive = Layer.succeed(KV, {
  from: (binding: KVBindingName) => makeKVOperations(binding),
})

// ---------------------------------------------------------------------------
// Legacy Exports (for backwards compatibility during migration)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use KV.from(binding) instead
 */
export { KV as KVStore }

/**
 * @deprecated Use KVLive instead
 */
export const KVStoreDefault = KVLive

/**
 * In-Memory KV Implementation (for testing)
 */
export const KVMemory = Layer.sync(KV, () => {
  const stores = new Map<string, Map<string, { value: string; metadata?: unknown; expiresAt?: number }>>()

  const getStore = (binding: string) => {
    let store = stores.get(binding)
    if (!store) {
      store = new Map()
      stores.set(binding, store)
    }
    return store
  }

  const makeMemoryOps = (binding: string): KVOperations => {
    const store = getStore(binding)

    const ops: KVOperations = {
      get: (key: string) =>
        Effect.sync(() => {
          const item = store.get(key)
          if (!item) return Option.none()

          if (item.expiresAt && Date.now() > item.expiresAt) {
            store.delete(key)
            return Option.none()
          }

          return Option.some(item.value)
        }),

      getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
        Effect.gen(function* () {
          const value = yield* ops.get(key)
          if (Option.isNone(value)) return Option.none()

          const parsed = JSON.parse(value.value)
          const decoded = yield* Schema.decodeUnknown(schema)(parsed).pipe(
            Effect.mapError(
              (parseError) =>
                new KVError({
                  operation: "getJson",
                  key,
                  message: `Schema validation failed`,
                  cause: parseError,
                })
            )
          )

          return Option.some(decoded)
        }),

      getWithMetadata: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
        Effect.gen(function* () {
          const item = store.get(key)
          if (!item) return Option.none()

          if (item.expiresAt && Date.now() > item.expiresAt) {
            store.delete(key)
            return Option.none()
          }

          const metadata = yield* Schema.decodeUnknown(schema)(item.metadata).pipe(
            Effect.mapError(
              (parseError) =>
                new KVError({
                  operation: "getWithMetadata",
                  key,
                  message: `Metadata validation failed`,
                  cause: parseError,
                })
            )
          )

          return Option.some({ value: item.value, metadata })
        }),

      set: (key, value, options) =>
        Effect.sync(() => {
          const expiresAt = options?.expirationTtl
            ? Date.now() + options.expirationTtl * 1000
            : options?.expiration
              ? options.expiration * 1000
              : undefined

          store.set(key, {
            value,
            metadata: options?.metadata,
            expiresAt,
          })
        }),

      setJson: <A>(
        key: string,
        value: A,
        options?: { expirationTtl?: number; expiration?: number }
      ) => ops.set(key, JSON.stringify(value), options),

      delete: (key) =>
        Effect.sync(() => {
          store.delete(key)
        }),

      list: (options) =>
        Effect.sync(() => {
          const keys: Array<{ name: string }> = []
          const prefix = options?.prefix ?? ""
          const limit = options?.limit ?? 1000

          for (const [key] of store) {
            if (key.startsWith(prefix)) {
              keys.push({ name: key })
            }
            if (keys.length >= limit) break
          }

          return { keys }
        }),
    }

    return ops
  }

  const service: KVService = {
    from: (binding: KVBindingName) => makeMemoryOps(binding),
  }

  return service
})
