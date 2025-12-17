// packages/jobs/src/services/metadata.ts

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
 * Job types supported by the runtime.
 */
export type JobType = "continuous" | "debounce" | "workerPool" | "task";

/**
 * Status of a job instance.
 */
export type JobStatus =
  | "initializing"
  | "running"
  | "stopped"
  | "terminated"; // State was purged via ctx.terminate()

/**
 * Metadata stored for every job instance.
 */
export interface JobMetadata {
  readonly type: JobType;
  readonly name: string;
  readonly status: JobStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Reason for stopping/terminating (if applicable) */
  readonly stopReason?: string;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * MetadataService manages job instance metadata.
 *
 * Every job instance stores metadata that identifies:
 * - What type of job it is (continuous, debounce, workerPool)
 * - What named job definition it belongs to
 * - Current status
 * - Timestamps
 */
export interface MetadataServiceI {
  /**
   * Initialize metadata for a new job instance.
   */
  readonly initialize: (
    type: JobType,
    name: string
  ) => Effect.Effect<void, StorageError>;

  /**
   * Get metadata for this instance.
   * Returns undefined if instance was never initialized.
   */
  readonly get: () => Effect.Effect<JobMetadata | undefined, StorageError>;

  /**
   * Update the status of this instance.
   * No-op if instance doesn't exist.
   */
  readonly updateStatus: (
    status: JobStatus
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
  "@durable-effect/jobs/MetadataService"
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
      initialize: (type: JobType, name: string) =>
        Effect.gen(function* () {
          const now = yield* runtime.now();
          const metadata: JobMetadata = {
            type,
            name,
            status: "initializing",
            createdAt: now,
            updatedAt: now,
          };
          yield* storage.put(KEYS.META, metadata);
        }),

      get: () => storage.get<JobMetadata>(KEYS.META),

      updateStatus: (status: JobStatus) =>
        Effect.gen(function* () {
          const current = yield* storage.get<JobMetadata>(KEYS.META);
          if (!current) return;

          const now = yield* runtime.now();
          const updated: JobMetadata = {
            ...current,
            status,
            updatedAt: now,
          };
          yield* storage.put(KEYS.META, updated);
        }),

      delete: () => storage.delete(KEYS.META),

      setStopReason: (reason: string | undefined) =>
        Effect.gen(function* () {
          const current = yield* storage.get<JobMetadata>(KEYS.META);
          if (!current) return;

          const now = yield* runtime.now();
          const updated: JobMetadata = {
            ...current,
            stopReason: reason,
            updatedAt: now,
          };
          yield* storage.put(KEYS.META, updated);
        }),
    };
  })
);
