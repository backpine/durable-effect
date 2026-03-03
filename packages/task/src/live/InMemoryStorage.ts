import { Effect, Layer } from "effect"
import { Storage } from "../services/Storage.js"

export interface InMemoryStorageHandle {
  readonly getData: () => Map<string, unknown>
  readonly clear: () => void
  readonly has: (key: string) => boolean
  readonly keys: () => ReadonlyArray<string>
}

export function makeInMemoryStorage(): {
  layer: Layer.Layer<Storage>
  handle: InMemoryStorageHandle
} {
  const data = new Map<string, unknown>()

  const handle: InMemoryStorageHandle = {
    getData: () => data,
    clear: () => { data.clear() },
    has: (key) => data.has(key),
    keys: () => [...data.keys()],
  }

  const layer = Layer.succeed(Storage, {
    get: (key) => Effect.succeed(data.get(key) ?? null),
    set: (key, value) => Effect.sync(() => { data.set(key, value) }),
    delete: (key) => Effect.sync(() => { data.delete(key) }),
    deleteAll: () => Effect.sync(() => { data.clear() }),
  })

  return { layer, handle }
}
