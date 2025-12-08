// packages/workflow-v2/src/adapters/durable-object/storage.ts

import { Effect, Schedule, Duration } from "effect";
import { StorageError } from "../../errors";
import type { StorageAdapterService } from "../storage";

/**
 * Retry schedule for storage operations.
 * Cloudflare storage can have transient failures.
 */
const STORAGE_RETRY_SCHEDULE = Schedule.exponential(Duration.millis(10)).pipe(
  Schedule.compose(Schedule.recurs(3)),
  Schedule.jittered
);

/**
 * Check if an error is retryable.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("network") ||
      msg.includes("timeout") ||
      msg.includes("temporarily") ||
      msg.includes("rate limit")
    );
  }
  return false;
}

/**
 * Create a Durable Object storage adapter.
 *
 * Wraps DurableObjectStorage with Effect error handling and retries.
 */
export function createDOStorageAdapter(
  storage: DurableObjectStorage
): StorageAdapterService {
  return {
    get: <T>(key: string) =>
      Effect.tryPromise({
        try: () => storage.get<T>(key),
        catch: (e) => new StorageError({ operation: "get", key, cause: e }),
      }).pipe(
        Effect.retry({
          schedule: STORAGE_RETRY_SCHEDULE,
          while: (e) => isRetryableError(e.cause),
        })
      ),

    put: <T>(key: string, value: T) =>
      Effect.tryPromise({
        try: () => storage.put(key, value),
        catch: (e) => new StorageError({ operation: "put", key, cause: e }),
      }).pipe(
        Effect.retry({
          schedule: STORAGE_RETRY_SCHEDULE,
          while: (e) => isRetryableError(e.cause),
        })
      ),

    putBatch: (entries: Record<string, unknown>) =>
      Effect.tryPromise({
        try: () => storage.put(entries),
        catch: (e) => new StorageError({ operation: "put", cause: e }),
      }).pipe(
        Effect.retry({
          schedule: STORAGE_RETRY_SCHEDULE,
          while: (e) => isRetryableError(e.cause),
        })
      ),

    delete: (key: string) =>
      Effect.tryPromise({
        try: async () => {
          const existed = (await storage.get(key)) !== undefined;
          await storage.delete(key);
          return existed;
        },
        catch: (e) => new StorageError({ operation: "delete", key, cause: e }),
      }).pipe(
        Effect.retry({
          schedule: STORAGE_RETRY_SCHEDULE,
          while: (e) => isRetryableError(e.cause),
        })
      ),

    deleteAll: () =>
      Effect.tryPromise({
        try: () => storage.deleteAll(),
        catch: (e) => new StorageError({ operation: "deleteAll", cause: e }),
      }),

    list: <T = unknown>(prefix: string) =>
      Effect.tryPromise({
        try: async () => {
          const result = await storage.list<T>({ prefix });
          return result;
        },
        catch: (e) => new StorageError({ operation: "list", cause: e }),
      }).pipe(
        Effect.retry({
          schedule: STORAGE_RETRY_SCHEDULE,
          while: (e) => isRetryableError(e.cause),
        })
      ),
  };
}
