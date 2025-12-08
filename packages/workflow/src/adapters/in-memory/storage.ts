// packages/workflow-v2/src/adapters/in-memory/storage.ts

import { Effect, Ref } from "effect";
import { StorageError } from "../../errors";
import type { StorageAdapterService } from "../storage";

/**
 * In-memory storage state.
 */
export interface InMemoryStorageState {
  readonly data: Map<string, unknown>;
}

/**
 * Create an in-memory storage adapter.
 *
 * Used for testing - all data stored in a Map.
 * Optionally accepts a Ref for external state inspection.
 */
export function createInMemoryStorage(
  stateRef?: Ref.Ref<InMemoryStorageState>
): Effect.Effect<StorageAdapterService, never, never> {
  return Effect.gen(function* () {
    // Use provided ref or create new one
    const ref = stateRef ?? (yield* Ref.make<InMemoryStorageState>({ data: new Map() }));

    return {
      get: <T>(key: string) =>
        Ref.get(ref).pipe(
          Effect.map((state) => state.data.get(key) as T | undefined)
        ),

      put: <T>(key: string, value: T) =>
        Ref.update(ref, (state) => ({
          data: new Map(state.data).set(key, value),
        })),

      putBatch: (entries: Record<string, unknown>) =>
        Ref.update(ref, (state) => {
          const newData = new Map(state.data);
          for (const [key, value] of Object.entries(entries)) {
            newData.set(key, value);
          }
          return { data: newData };
        }),

      delete: (key: string) =>
        Ref.modify(ref, (state) => {
          const existed = state.data.has(key);
          const newData = new Map(state.data);
          newData.delete(key);
          return [existed, { data: newData }];
        }),

      deleteAll: () =>
        Ref.set(ref, { data: new Map() }),

      list: <T = unknown>(prefix: string) =>
        Ref.get(ref).pipe(
          Effect.map((state) => {
            const result = new Map<string, T>();
            for (const [key, value] of state.data) {
              if (key.startsWith(prefix)) {
                result.set(key, value as T);
              }
            }
            return result;
          })
        ),
    };
  });
}

/**
 * Create in-memory storage with injectable error simulation.
 * Useful for testing error handling paths.
 */
export function createInMemoryStorageWithErrors(
  errorConfig: {
    failOn?: {
      get?: string[];      // Keys that should fail on get
      put?: string[];      // Keys that should fail on put
      delete?: string[];   // Keys that should fail on delete
    };
    failAll?: boolean;     // Fail all operations
  }
): Effect.Effect<StorageAdapterService, never, never> {
  return Effect.gen(function* () {
    const base = yield* createInMemoryStorage();

    const shouldFail = (op: "get" | "put" | "delete", key?: string): boolean => {
      if (errorConfig.failAll) return true;
      if (key && errorConfig.failOn?.[op]?.includes(key)) return true;
      return false;
    };

    return {
      get: <T>(key: string) =>
        shouldFail("get", key)
          ? Effect.fail(new StorageError({ operation: "get", key, cause: new Error("Simulated failure") }))
          : base.get<T>(key),

      put: <T>(key: string, value: T) =>
        shouldFail("put", key)
          ? Effect.fail(new StorageError({ operation: "put", key, cause: new Error("Simulated failure") }))
          : base.put(key, value),

      putBatch: (entries: Record<string, unknown>) =>
        errorConfig.failAll
          ? Effect.fail(new StorageError({ operation: "put", cause: new Error("Simulated failure") }))
          : base.putBatch(entries),

      delete: (key: string) =>
        shouldFail("delete", key)
          ? Effect.fail(new StorageError({ operation: "delete", key, cause: new Error("Simulated failure") }))
          : base.delete(key),

      deleteAll: () =>
        errorConfig.failAll
          ? Effect.fail(new StorageError({ operation: "deleteAll", cause: new Error("Simulated failure") }))
          : base.deleteAll(),

      list: <T = unknown>(prefix: string) =>
        errorConfig.failAll
          ? Effect.fail(new StorageError({ operation: "list", cause: new Error("Simulated failure") }))
          : base.list<T>(prefix),
    };
  });
}
