// packages/core/src/testing/storage.ts

import { Effect } from "effect";
import type { StorageAdapterService } from "../adapters/storage";

/**
 * Create an in-memory storage adapter for testing.
 *
 * Provides a simple Map-backed implementation that works synchronously.
 */
export function createInMemoryStorage(): StorageAdapterService {
  const data = new Map<string, unknown>();

  return {
    get: <T>(key: string) => Effect.succeed(data.get(key) as T | undefined),

    put: <T>(key: string, value: T) =>
      Effect.sync(() => {
        data.set(key, value);
      }),

    putBatch: (entries: Record<string, unknown>) =>
      Effect.sync(() => {
        for (const [k, v] of Object.entries(entries)) {
          data.set(k, v);
        }
      }),

    delete: (key: string) =>
      Effect.sync(() => {
        const existed = data.has(key);
        data.delete(key);
        return existed;
      }),

    deleteAll: () =>
      Effect.sync(() => {
        data.clear();
      }),

    list: <T = unknown>(prefix: string) =>
      Effect.sync(() => {
        const result = new Map<string, T>();
        for (const [k, v] of data) {
          if (k.startsWith(prefix)) {
            result.set(k, v as T);
          }
        }
        return result;
      }),
  };
}

/**
 * In-memory storage with test helpers.
 */
export interface InMemoryStorageHandle extends StorageAdapterService {
  /**
   * Get the raw data map for inspection.
   */
  readonly getData: () => Map<string, unknown>;

  /**
   * Clear all data.
   */
  readonly clear: () => void;

  /**
   * Check if a key exists.
   */
  readonly has: (key: string) => boolean;

  /**
   * Get all keys.
   */
  readonly keys: () => string[];
}

/**
 * Create an in-memory storage adapter with test helpers.
 */
export function createInMemoryStorageWithHandle(): InMemoryStorageHandle {
  const data = new Map<string, unknown>();

  return {
    get: <T>(key: string) => Effect.succeed(data.get(key) as T | undefined),

    put: <T>(key: string, value: T) =>
      Effect.sync(() => {
        data.set(key, value);
      }),

    putBatch: (entries: Record<string, unknown>) =>
      Effect.sync(() => {
        for (const [k, v] of Object.entries(entries)) {
          data.set(k, v);
        }
      }),

    delete: (key: string) =>
      Effect.sync(() => {
        const existed = data.has(key);
        data.delete(key);
        return existed;
      }),

    deleteAll: () =>
      Effect.sync(() => {
        data.clear();
      }),

    list: <T = unknown>(prefix: string) =>
      Effect.sync(() => {
        const result = new Map<string, T>();
        for (const [k, v] of data) {
          if (k.startsWith(prefix)) {
            result.set(k, v as T);
          }
        }
        return result;
      }),

    // Test helpers
    getData: () => data,
    clear: () => data.clear(),
    has: (key: string) => data.has(key),
    keys: () => Array.from(data.keys()),
  };
}
