// packages/workflow-v2/src/adapters/storage.ts

import { Context, Effect } from "effect";
import type { StorageError } from "../errors";

/**
 * Abstract storage interface for workflow state persistence.
 *
 * Implementations provide runtime-specific storage:
 * - Durable Objects: DurableObjectStorage
 * - Testing: In-memory Map
 * - Future: Redis, Postgres, etc.
 */
export interface StorageAdapterService {
  /**
   * Get a value by key.
   * Returns undefined if key doesn't exist.
   */
  readonly get: <T>(key: string) => Effect.Effect<T | undefined, StorageError>;

  /**
   * Store a value.
   * Overwrites if key already exists.
   */
  readonly put: <T>(key: string, value: T) => Effect.Effect<void, StorageError>;

  /**
   * Store multiple values atomically.
   * All writes succeed or all fail.
   */
  readonly putBatch: (
    entries: Record<string, unknown>
  ) => Effect.Effect<void, StorageError>;

  /**
   * Delete a key.
   * Returns true if key existed, false otherwise.
   */
  readonly delete: (key: string) => Effect.Effect<boolean, StorageError>;

  /**
   * Delete all keys.
   * Used for cleanup after workflow completion/failure.
   */
  readonly deleteAll: () => Effect.Effect<void, StorageError>;

  /**
   * List all keys with a given prefix.
   * Returns a Map of key -> value pairs.
   */
  readonly list: <T = unknown>(
    prefix: string
  ) => Effect.Effect<Map<string, T>, StorageError>;
}

/**
 * Effect service tag for StorageAdapter.
 */
export class StorageAdapter extends Context.Tag("@durable-effect/StorageAdapter")<
  StorageAdapter,
  StorageAdapterService
>() {}
