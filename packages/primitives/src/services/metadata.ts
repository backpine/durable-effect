// packages/primitives/src/services/metadata.ts

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
 * Primitive types supported by the runtime.
 */
export type PrimitiveType = "continuous" | "buffer" | "queue";

/**
 * Status of a primitive instance.
 */
export type PrimitiveStatus =
  | "initializing"
  | "running"
  | "buffering"
  | "processing"
  | "idle"
  | "paused"
  | "stopped"
  | "terminated" // State was purged via ctx.terminate()
  | "completed";

/**
 * Metadata stored for every primitive instance.
 */
export interface PrimitiveMetadata {
  readonly type: PrimitiveType;
  readonly name: string;
  readonly status: PrimitiveStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Reason for stopping/terminating (if applicable) */
  readonly stopReason?: string;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * MetadataService manages primitive instance metadata.
 *
 * Every primitive instance stores metadata that identifies:
 * - What type of primitive it is (continuous, buffer, queue)
 * - What named primitive definition it belongs to
 * - Current status
 * - Timestamps
 */
export interface MetadataServiceI {
  /**
   * Initialize metadata for a new primitive instance.
   */
  readonly initialize: (
    type: PrimitiveType,
    name: string
  ) => Effect.Effect<void, StorageError>;

  /**
   * Get metadata for this instance.
   * Returns undefined if instance was never initialized.
   */
  readonly get: () => Effect.Effect<PrimitiveMetadata | undefined, StorageError>;

  /**
   * Update the status of this instance.
   * No-op if instance doesn't exist.
   */
  readonly updateStatus: (
    status: PrimitiveStatus
  ) => Effect.Effect<void, StorageError>;

  /**
   * Delete metadata for this instance.
   * Called during purge.
   * Returns true if key existed, false otherwise.
   */
  readonly delete: () => Effect.Effect<boolean, StorageError>;

  /**
   * Set the stop reason for this instance.
   * Used when terminating/stopping with a reason.
   */
  readonly setStopReason: (
    reason: string | undefined
  ) => Effect.Effect<void, StorageError>;
}

// =============================================================================
// Service Tag
// =============================================================================

export class MetadataService extends Context.Tag(
  "@durable-effect/primitives/MetadataService"
)<MetadataService, MetadataServiceI>() {}

// =============================================================================
// Implementation
// =============================================================================

export const MetadataServiceLayer = Layer.effect(
  MetadataService,
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    return {
      initialize: (type: PrimitiveType, name: string) =>
        Effect.gen(function* () {
          const now = yield* runtime.now();
          const metadata: PrimitiveMetadata = {
            type,
            name,
            status: "initializing",
            createdAt: now,
            updatedAt: now,
          };
          yield* storage.put(KEYS.META, metadata);
        }),

      get: () => storage.get<PrimitiveMetadata>(KEYS.META),

      updateStatus: (status: PrimitiveStatus) =>
        Effect.gen(function* () {
          const current = yield* storage.get<PrimitiveMetadata>(KEYS.META);
          if (!current) return;

          const now = yield* runtime.now();
          const updated: PrimitiveMetadata = {
            ...current,
            status,
            updatedAt: now,
          };
          yield* storage.put(KEYS.META, updated);
        }),

      delete: () => storage.delete(KEYS.META),

      setStopReason: (reason: string | undefined) =>
        Effect.gen(function* () {
          const current = yield* storage.get<PrimitiveMetadata>(KEYS.META);
          if (!current) return;

          const now = yield* runtime.now();
          const updated: PrimitiveMetadata = {
            ...current,
            stopReason: reason,
            updatedAt: now,
          };
          yield* storage.put(KEYS.META, updated);
        }),
    };
  })
);
