// packages/jobs/src/services/idempotency.ts

import { Context, Effect, Layer } from "effect";
import {
  StorageAdapter,
  RuntimeAdapter,
  type StorageError,
} from "@durable-effect/core";
import { KEYS } from "../storage-keys";

// =============================================================================
// Types
// =============================================================================

/**
 * Record stored for each processed event.
 */
interface IdempotencyRecord {
  readonly processedAt: number;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * IdempotencyService tracks processed events for deduplication.
 *
 * Used by Debounce and WorkerPool jobs to ensure exactly-once semantics.
 * Events are identified by a user-provided eventId.
 */
export interface IdempotencyServiceI {
  /**
   * Check if an event has already been processed.
   */
  readonly check: (eventId: string) => Effect.Effect<boolean, StorageError>;

  /**
   * Mark an event as processed.
   */
  readonly mark: (eventId: string) => Effect.Effect<void, StorageError>;

  /**
   * Check and mark atomically.
   * Returns true if the event was already processed (duplicate).
   * If not processed, marks it and returns false.
   */
  readonly checkAndMark: (eventId: string) => Effect.Effect<boolean, StorageError>;

  /**
   * Clear an idempotency record.
   * Used during purge or when resetting state.
   * Returns true if key existed, false otherwise.
   */
  readonly clear: (eventId: string) => Effect.Effect<boolean, StorageError>;
}

// =============================================================================
// Service Tag
// =============================================================================

export class IdempotencyService extends Context.Tag(
  "@durable-effect/jobs/IdempotencyService"
)<IdempotencyService, IdempotencyServiceI>() {}

// =============================================================================
// Implementation
// =============================================================================

export const IdempotencyServiceLayer = Layer.effect(
  IdempotencyService,
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    const makeKey = (eventId: string) => `${KEYS.IDEMPOTENCY}${eventId}`;

    return {
      check: (eventId: string) =>
        Effect.gen(function* () {
          const key = makeKey(eventId);
          const record = yield* storage.get<IdempotencyRecord>(key);
          return record !== undefined;
        }),

      mark: (eventId: string) =>
        Effect.gen(function* () {
          const key = makeKey(eventId);
          const now = yield* runtime.now();
          const record: IdempotencyRecord = { processedAt: now };
          yield* storage.put(key, record);
        }),

      checkAndMark: (eventId: string) =>
        Effect.gen(function* () {
          const key = makeKey(eventId);
          const existing = yield* storage.get<IdempotencyRecord>(key);

          if (existing !== undefined) {
            // Already processed - this is a duplicate
            return true;
          }

          // Not processed - mark it now
          const now = yield* runtime.now();
          const record: IdempotencyRecord = { processedAt: now };
          yield* storage.put(key, record);

          return false;
        }),

      clear: (eventId: string) => {
        const key = makeKey(eventId);
        return storage.delete(key);
      },
    };
  })
);
