// packages/jobs/src/services/entity-state.ts

import { Effect, Schema } from "effect";
import { StorageAdapter, type StorageError } from "@durable-effect/core";
import { KEYS } from "../storage-keys";
import { ValidationError } from "../errors";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * EntityStateService provides schema-validated state management.
 *
 * Unlike a generic key-value store, EntityStateService:
 * - Validates state against an Effect Schema
 * - Returns null (not undefined) when state doesn't exist
 * - Provides update() for atomic read-modify-write
 */
export interface EntityStateServiceI<S> {
  /**
   * Get the current state.
   * Returns null if no state has been set.
   */
  readonly get: () => Effect.Effect<S | null, StorageError | ValidationError>;

  /**
   * Set the state (validates against schema).
   */
  readonly set: (state: S) => Effect.Effect<void, StorageError | ValidationError>;

  /**
   * Update state atomically (read-modify-write).
   * No-op if state doesn't exist.
   */
  readonly update: (
    fn: (current: S) => S
  ) => Effect.Effect<void, StorageError | ValidationError>;

  /**
   * Delete the state.
   * Returns true if key existed, false otherwise.
   */
  readonly delete: () => Effect.Effect<boolean, StorageError>;
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Creates an EntityStateService for a specific schema.
 *
 * This is a factory function (not a Layer) because each job
 * handler needs a state service typed to its own schema.
 *
 * Note: Schema must have no context requirements (R = never).
 *
 * @example
 * ```ts
 * const state = yield* createEntityStateService(def.stateSchema);
 * const current = yield* state.get();
 * yield* state.set({ ...current, count: current.count + 1 });
 * ```
 */
export function createEntityStateService<A, I>(
  schema: Schema.Schema<A, I, never>
): Effect.Effect<EntityStateServiceI<A>, never, StorageAdapter> {
  return Effect.gen(function* () {
    const storage = yield* StorageAdapter;

    // Create decode/encode functions from schema
    const decode = Schema.decodeUnknown(schema);
    const encode = Schema.encode(schema);

    return {
      get: () =>
        Effect.gen(function* () {
          const raw = yield* storage.get<I>(KEYS.STATE);
          if (raw === undefined) return null;

          // Decode with schema validation
          const result = yield* decode(raw).pipe(
            Effect.mapError(
              (error) =>
                new ValidationError({
                  schemaName: schema.ast._tag,
                  issues: error,
                })
            )
          );

          return result;
        }),

      set: (state: A) =>
        Effect.gen(function* () {
          // Encode state (converts to serializable form)
          const encoded = yield* encode(state).pipe(
            Effect.mapError(
              (error) =>
                new ValidationError({
                  schemaName: schema.ast._tag,
                  issues: error,
                })
            )
          );
          yield* storage.put(KEYS.STATE, encoded);
        }),

      update: (fn: (current: A) => A) =>
        Effect.gen(function* () {
          const raw = yield* storage.get<I>(KEYS.STATE);
          if (raw === undefined) return;

          // Decode current state
          const current = yield* decode(raw).pipe(
            Effect.mapError(
              (error) =>
                new ValidationError({
                  schemaName: schema.ast._tag,
                  issues: error,
                })
            )
          );

          // Apply update function
          const updated = fn(current);

          // Encode and save
          const encoded = yield* encode(updated).pipe(
            Effect.mapError(
              (error) =>
                new ValidationError({
                  schemaName: schema.ast._tag,
                  issues: error,
                })
            )
          );
          yield* storage.put(KEYS.STATE, encoded);
        }),

      delete: () => storage.delete(KEYS.STATE),
    };
  });
}
