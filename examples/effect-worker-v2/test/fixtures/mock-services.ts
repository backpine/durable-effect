import { Effect, Layer, Option, Schema } from "effect"
import {
  Config,
  Storage,
  KVMemory,
  CloudflareEnv,
  CloudflareCtx,
} from "@/services"
import type {
  ConfigService,
  StorageService,
  StorageOperations,
  R2BindingName,
} from "@/services"
import { ConfigError, StorageError } from "@/errors"

/**
 * Mock Cloudflare Environment for tests
 *
 * Provides a minimal Env object for testing.
 * Tests can override this with custom values if needed.
 */
export const MockCloudflareEnv = Layer.succeed(CloudflareEnv, {
  env: {
    ENVIRONMENT: "test",
    LOG_LEVEL: "debug",
    API_KEY: "test-api-key",
    DATABASE_URL: "postgres://test:test@localhost:5432/test",
  } as unknown as Env,
})

/**
 * Mock Execution Context for tests
 */
export const MockCloudflareCtx = Layer.succeed(CloudflareCtx, {
  ctx: {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext,
})

/**
 * Mock Config for tests
 */
export const MockConfig = Layer.succeed(Config, {
  get: (key: string) => {
    const values: Record<string, string> = {
      ENVIRONMENT: "test",
      LOG_LEVEL: "debug",
      API_KEY: "test-api-key",
    }
    const value = values[key]
    if (value !== undefined) {
      return Effect.succeed(value)
    }
    return Effect.fail(
      new ConfigError({ key, message: `Config key "${key}" not found` })
    )
  },

  getSecret: (key: string) => {
    const values: Record<string, string> = {
      ENVIRONMENT: "test",
      LOG_LEVEL: "debug",
      API_KEY: "test-api-key",
    }
    const value = values[key]
    if (value !== undefined) {
      return Effect.succeed(value)
    }
    return Effect.fail(
      new ConfigError({ key, message: `Secret "${key}" not found` })
    )
  },

  getNumber: (key: string) =>
    Effect.gen(function* () {
      const values: Record<string, string> = {
        ENVIRONMENT: "test",
        LOG_LEVEL: "debug",
        API_KEY: "test-api-key",
      }
      const value = values[key]
      if (value === undefined) {
        return yield* Effect.fail(
          new ConfigError({ key, message: `Config key "${key}" not found` })
        )
      }
      const num = Number(value)
      if (Number.isNaN(num)) {
        return yield* Effect.fail(
          new ConfigError({ key, message: "Not a number" })
        )
      }
      return num
    }),

  getBoolean: (key: string) =>
    Effect.gen(function* () {
      const values: Record<string, string> = {
        ENVIRONMENT: "test",
        LOG_LEVEL: "debug",
        API_KEY: "test-api-key",
      }
      const value = values[key]
      if (value === undefined) {
        return yield* Effect.fail(
          new ConfigError({ key, message: `Config key "${key}" not found` })
        )
      }
      return value === "true"
    }),

  getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
    Effect.gen(function* () {
      const values: Record<string, string> = {
        ENVIRONMENT: "test",
        LOG_LEVEL: "debug",
        API_KEY: "test-api-key",
      }
      const value = values[key]
      if (value === undefined) {
        return yield* Effect.fail(
          new ConfigError({ key, message: `Config key "${key}" not found` })
        )
      }
      const parsed = JSON.parse(value)
      return yield* Schema.decodeUnknown(schema)(parsed).pipe(
        Effect.mapError(
          (parseError) =>
            new ConfigError({
              key,
              message: `Schema validation failed: ${parseError}`,
            })
        )
      )
    }),

  getOrElse: (key: string, defaultValue: string) => {
    const values: Record<string, string> = {
      ENVIRONMENT: "test",
      LOG_LEVEL: "debug",
      API_KEY: "test-api-key",
    }
    const value = values[key]
    return Effect.succeed(value ?? defaultValue)
  },

  getAll: () => Effect.succeed({ ENVIRONMENT: "test", LOG_LEVEL: "debug" }),
} satisfies ConfigService)

/**
 * In-memory KV Store for tests
 */
export const MockKV = KVMemory

/**
 * Create mock storage operations for a binding
 */
const makeMockStorageOperations = (
  store: Map<string, { data: string; metadata?: Record<string, unknown> }>,
  bindingName: string
): StorageOperations => {
  const ops: StorageOperations = {
    get: (key: string) =>
      Effect.sync(() => {
        const item = store.get(key)
        if (!item) return Option.none()

        // Create a mock R2ObjectBody
        const mockObject = {
          key,
          size: item.data.length,
          httpEtag: `"${key}-etag"`,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(item.data))
              controller.close()
            },
          }),
          text: async () => item.data,
          httpMetadata: {
            contentType: "text/plain",
          },
        } as R2ObjectBody

        return Option.some(mockObject)
      }),

    head: (key: string) =>
      Effect.sync(() => {
        const item = store.get(key)
        if (!item) return Option.none()

        const mockObject = {
          key,
          size: item.data.length,
          httpEtag: `"${key}-etag"`,
          httpMetadata: {
            contentType: "text/plain",
          },
        } as R2Object

        return Option.some(mockObject)
      }),

    put: (
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
      options?: R2PutOptions
    ) =>
      Effect.gen(function* () {
        let data: string
        if (typeof value === "string") {
          data = value
        } else if (value instanceof Blob) {
          data = yield* Effect.tryPromise({
            try: () => value.text(),
            catch: (error) =>
              new StorageError({
                operation: "put",
                key,
                message: `[${bindingName}] Failed to read blob`,
                cause: error,
              }),
          })
        } else if (value instanceof ReadableStream) {
          const reader = value.getReader()
          const chunks: Uint8Array[] = []
          let done = false
          while (!done) {
            const result = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: (error) =>
                new StorageError({
                  operation: "put",
                  key,
                  message: `[${bindingName}] Failed to read stream`,
                  cause: error,
                }),
            })
            done = result.done
            if (result.value) chunks.push(result.value)
          }
          data = new TextDecoder().decode(new Uint8Array(chunks.flatMap(c => [...c])))
        } else {
          data = new TextDecoder().decode(value as ArrayBuffer)
        }

        store.set(key, { data, metadata: options?.customMetadata as Record<string, unknown> | undefined })

        return {
          key,
          size: data.length,
          httpEtag: `"${key}-etag"`,
          httpMetadata: options?.httpMetadata,
        } as R2Object
      }),

    delete: (key: string) =>
      Effect.sync(() => {
        store.delete(key)
      }),

    deleteMany: (keys: string[]) =>
      Effect.sync(() => {
        keys.forEach((k) => store.delete(k))
      }),

    list: (options?: R2ListOptions) =>
      Effect.sync(() => {
        const objects: R2Object[] = []
        const prefix = options?.prefix ?? ""
        const limit = options?.limit ?? 1000

        for (const [key] of store) {
          if (key.startsWith(prefix)) {
            objects.push({ key, size: store.get(key)!.data.length, httpEtag: `"${key}-etag"` } as R2Object)
          }
          if (objects.length >= limit) break
        }

        return {
          objects,
          truncated: false,
        }
      }),

    exists: (key: string) =>
      Effect.sync(() => store.has(key)),

    getText: (key: string) =>
      Effect.gen(function* () {
        const obj = yield* ops.get(key)
        if (Option.isNone(obj)) return Option.none()
        const text = yield* Effect.tryPromise({
          try: () => obj.value.text(),
          catch: (error) =>
            new StorageError({
              operation: "getText",
              key,
              message: `[${bindingName}] Failed to read text`,
              cause: error,
            }),
        })
        return Option.some(text)
      }),

    getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
      Effect.gen(function* () {
        const text = yield* ops.getText(key)
        if (Option.isNone(text)) return Option.none()
        const parsed = JSON.parse(text.value)
        const decoded = yield* Schema.decodeUnknown(schema)(parsed).pipe(
          Effect.mapError(
            (parseError) =>
              new StorageError({
                operation: "getJson",
                key,
                message: `[${bindingName}] Schema validation failed: ${parseError}`,
                cause: parseError,
              })
          )
        )
        return Option.some(decoded)
      }),

    putJson: <A>(key: string, value: A, options?: Omit<R2PutOptions, "httpMetadata">) =>
      ops.put(key, JSON.stringify(value), {
        ...options,
        httpMetadata: {
          contentType: "application/json",
        },
      }),
  }

  return ops
}

/**
 * Mock Object Storage for tests
 *
 * Uses in-memory storage per binding
 */
export const MockStorage = Layer.sync(Storage, () => {
  const stores = new Map<string, Map<string, { data: string; metadata?: Record<string, unknown> }>>()

  const getStore = (binding: string) => {
    let store = stores.get(binding)
    if (!store) {
      store = new Map()
      stores.set(binding, store)
    }
    return store
  }

  const operationsCache = new Map<R2BindingName, StorageOperations>()

  const service: StorageService = {
    from: (binding: R2BindingName) => {
      const cached = operationsCache.get(binding)
      if (cached) return cached

      const store = getStore(binding)
      const ops = makeMockStorageOperations(store, binding)
      operationsCache.set(binding, ops)
      return ops
    },
  }

  return service
})

/**
 * Complete test layer
 *
 * Includes mock Cloudflare context so services that access
 * CloudflareEnv at call time will work in tests.
 */
export const TestLayer = Layer.mergeAll(
  MockCloudflareEnv,
  MockCloudflareCtx,
  MockConfig,
  MockKV,
  MockStorage,
)
