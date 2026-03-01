import { Effect, Layer } from "effect";
import { Store } from "../adapter/store.js";

export interface TestStoreHandle {
  readonly get: (key: string) => Effect.Effect<unknown | null>;
  readonly set: (key: string, value: unknown) => Effect.Effect<void>;
  readonly delete: (key: string) => Effect.Effect<void>;
  readonly deleteAll: () => Effect.Effect<void>;
  readonly getData: () => Map<string, unknown>;
  readonly clear: () => void;
  readonly has: (key: string) => boolean;
  readonly keys: () => string[];
}

export function createTestStore(): { layer: Layer.Layer<Store>; handle: TestStoreHandle } {
  const data = new Map<string, unknown>();

  const handle: TestStoreHandle = {
    get: (key) => Effect.succeed(data.get(key) ?? null),
    set: (key, value) => Effect.sync(() => { data.set(key, value); }),
    delete: (key) => Effect.sync(() => { data.delete(key); }),
    deleteAll: () => Effect.sync(() => { data.clear(); }),
    getData: () => data,
    clear: () => { data.clear(); },
    has: (key) => data.has(key),
    keys: () => [...data.keys()],
  };

  const layer = Layer.succeed(Store)({
    get: handle.get,
    set: handle.set,
    delete: handle.delete,
    deleteAll: handle.deleteAll,
  });

  return { layer, handle };
}
