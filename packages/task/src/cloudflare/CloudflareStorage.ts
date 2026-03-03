import { Effect, Layer } from "effect"
import { Storage, StorageError } from "../services/Storage.js"

// ---------------------------------------------------------------------------
// Minimal structural interface — compatible with CF DurableObjectStorage
// ---------------------------------------------------------------------------

export interface DurableObjectStorageMethods {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  deleteAll(): Promise<void>
}

// ---------------------------------------------------------------------------
// CloudflareStorage — wraps CF DurableObjectStorage into the Storage service
// ---------------------------------------------------------------------------

export function makeCloudflareStorage(
  doStorage: DurableObjectStorageMethods,
): Layer.Layer<Storage> {
  return Layer.succeed(Storage, {
    get: (key) =>
      Effect.tryPromise({
        try: () => doStorage.get(key),
        catch: (cause) =>
          new StorageError({ message: `Failed to get key "${key}"`, cause }),
      }).pipe(Effect.map((v) => v ?? null)),

    set: (key, value) =>
      Effect.tryPromise({
        try: () => doStorage.put(key, value),
        catch: (cause) =>
          new StorageError({ message: `Failed to set key "${key}"`, cause }),
      }),

    delete: (key) =>
      Effect.tryPromise({
        try: async () => {
          await doStorage.delete(key)
        },
        catch: (cause) =>
          new StorageError({
            message: `Failed to delete key "${key}"`,
            cause,
          }),
      }),

    deleteAll: () =>
      Effect.tryPromise({
        try: () => doStorage.deleteAll(),
        catch: (cause) =>
          new StorageError({ message: "Failed to delete all keys", cause }),
      }),
  })
}
