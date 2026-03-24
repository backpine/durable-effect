import { Effect } from "effect"
import type { Storage } from "../services/Storage.js"
import { StorageError } from "../services/Storage.js"
import type { DurableObjectStorageLike } from "./types.js"

// ---------------------------------------------------------------------------
// Wraps CF DurableObjectStorage into the Storage service interface.
// ---------------------------------------------------------------------------

export function makeCloudflareStorage(doStorage: DurableObjectStorageLike): Storage["Service"] {
  return {
    get: (key) =>
      Effect.tryPromise({
        try: () => doStorage.get(key) as Promise<unknown>,
        catch: (cause) =>
          new StorageError({ message: `Failed to get key "${key}"`, cause }),
      }).pipe(Effect.map((v) => v ?? null)),

    set: (key, value) =>
      Effect.tryPromise({
        try: () => (doStorage as { put(k: string, v: unknown): Promise<void> }).put(key, value),
        catch: (cause) =>
          new StorageError({ message: `Failed to set key "${key}"`, cause }),
      }),

    delete: (key) =>
      Effect.tryPromise({
        try: async () => { await (doStorage as { delete(k: string): Promise<boolean> }).delete(key) },
        catch: (cause) =>
          new StorageError({ message: `Failed to delete key "${key}"`, cause }),
      }),

    deleteAll: () =>
      Effect.tryPromise({
        try: () => doStorage.deleteAll(),
        catch: (cause) =>
          new StorageError({ message: "Failed to delete all keys", cause }),
      }),
  }
}
