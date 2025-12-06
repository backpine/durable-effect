import { Effect, Schedule, Duration } from "effect";
import { StorageError } from "@/errors";

/**
 * Retry schedule for storage operations.
 * Exponential backoff: 50ms → 100ms → 200ms (max 3 retries, 500ms cap)
 */
const retrySchedule = Schedule.exponential(Duration.millis(50), 2).pipe(
  Schedule.intersect(Schedule.recurs(3)),
  Schedule.upTo(Duration.millis(500)),
);

/**
 * Check if an error is retryable.
 * Returns false for permanent errors like DataCloneError or QuotaExceededError.
 */
function isRetryableStorageError(error: unknown): boolean {
  // DataCloneError - not retryable (serialization issue)
  if (error instanceof DOMException && error.name === "DataCloneError") {
    return false;
  }

  // QuotaExceededError - not retryable (storage full)
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return false;
  }

  // Network and transient errors - retryable
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("econnreset") ||
      message.includes("unavailable") ||
      message.includes("connection") ||
      message.includes("internal error")
    ) {
      return true;
    }
  }

  // Default: retry unknown errors (conservative approach for transient issues)
  return true;
}

/**
 * Execute a storage operation with retry.
 */
function withStorageRetry<T>(
  operation: "get" | "put" | "delete" | "deleteAll",
  key: string | undefined,
  fn: () => Promise<T>,
): Effect.Effect<T, StorageError> {
  let retriesAttempted = 0;

  return Effect.tryPromise({
    try: fn,
    catch: (e) =>
      new StorageError({ operation, key, cause: e, retriesAttempted: 0 }),
  }).pipe(
    Effect.retry(
      retrySchedule.pipe(
        Schedule.whileInput((error: StorageError) => {
          if (!isRetryableStorageError(error.cause)) {
            return false;
          }
          retriesAttempted++;
          return true;
        }),
      ),
    ),
    Effect.mapError(
      (e) =>
        new StorageError({
          operation,
          key,
          cause: e.cause,
          retriesAttempted,
        }),
    ),
  );
}

/**
 * Storage get with retry.
 */
export function storageGet<T>(
  storage: DurableObjectStorage,
  key: string,
): Effect.Effect<T | undefined, StorageError> {
  return withStorageRetry("get", key, () => storage.get<T>(key));
}

/**
 * Storage put with retry.
 */
export function storagePut<T>(
  storage: DurableObjectStorage,
  key: string,
  value: T,
): Effect.Effect<void, StorageError> {
  return withStorageRetry("put", key, () => storage.put(key, value));
}

/**
 * Storage put batch with retry.
 */
export function storagePutBatch(
  storage: DurableObjectStorage,
  entries: Record<string, unknown>,
): Effect.Effect<void, StorageError> {
  return withStorageRetry("put", undefined, () => storage.put(entries));
}

/**
 * Storage delete with retry.
 */
export function storageDelete(
  storage: DurableObjectStorage,
  key: string,
): Effect.Effect<boolean, StorageError> {
  return withStorageRetry("delete", key, () => storage.delete(key));
}

/**
 * Storage deleteAll with retry.
 */
export function storageDeleteAll(
  storage: DurableObjectStorage,
): Effect.Effect<void, StorageError> {
  return withStorageRetry("deleteAll", undefined, () => storage.deleteAll());
}
