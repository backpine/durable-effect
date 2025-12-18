// packages/jobs/src/services/cleanup.ts

import { Context, Effect, Layer } from "effect";
import {
  StorageAdapter,
  type StorageError,
  type SchedulerError,
} from "@durable-effect/core";
import { AlarmService } from "./alarm";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * CleanupService provides centralized cleanup operations for job instances.
 *
 * This service handles all cleanup atomically to prevent partial cleanup states
 * where alarm continues but storage is deleted (or vice versa).
 */
export interface CleanupServiceI {
  /**
   * Terminate the job instance completely.
   *
   * This is the standard cleanup operation that:
   * 1. Cancels any scheduled alarm
   * 2. Deletes all storage (state, metadata, counters, etc.)
   *
   * After termination, the instance ID can be reused for a fresh start.
   */
  readonly terminate: () => Effect.Effect<void, StorageError | SchedulerError>;
}

// =============================================================================
// Service Tag
// =============================================================================

export class CleanupService extends Context.Tag(
  "@durable-effect/jobs/CleanupService"
)<CleanupService, CleanupServiceI>() {}

// =============================================================================
// Implementation
// =============================================================================

export const CleanupServiceLayer = Layer.effect(
  CleanupService,
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const alarm = yield* AlarmService;

    return {
      terminate: () =>
        Effect.gen(function* () {
          // Cancel alarm first to prevent it firing during cleanup
          yield* alarm.cancel();
          // Delete all storage (state, metadata, counters, retry state, etc.)
          yield* storage.deleteAll();
        }),
    };
  })
);
