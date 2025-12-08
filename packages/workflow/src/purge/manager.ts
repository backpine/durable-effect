// packages/workflow/src/purge/manager.ts

import { Context, Effect, Layer } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { SchedulerAdapter } from "../adapters/scheduler";
import { RuntimeAdapter } from "../adapters/runtime";
import type { StorageError, SchedulerError } from "../errors";
import type { ParsedPurgeConfig } from "./config";

// =============================================================================
// Storage Keys
// =============================================================================

const PURGE_KEYS = {
  scheduled: "workflow:purge:scheduled",
  purgeAt: "workflow:purge:purgeAt",
  reason: "workflow:purge:reason",
  alarmType: "workflow:alarm:type",
} as const;

// =============================================================================
// Types
// =============================================================================

/**
 * Result of executePurgeIfDue.
 */
export type PurgeExecutionResult =
  | { readonly purged: true; readonly reason: string }
  | { readonly purged: false };

/**
 * Terminal workflow states that trigger purge.
 */
export type TerminalState = "completed" | "failed" | "cancelled";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * PurgeManager service interface.
 *
 * Manages scheduling and executing data purges after workflow terminal states.
 */
export interface PurgeManagerService {
  /**
   * Schedule a purge after terminal state.
   * No-op if purge is disabled.
   */
  readonly schedulePurge: (
    terminalState: TerminalState
  ) => Effect.Effect<void, StorageError | SchedulerError>;

  /**
   * Execute pending purge if due.
   * Returns { purged: true, reason } if purge was executed, { purged: false } otherwise.
   */
  readonly executePurgeIfDue: () => Effect.Effect<
    PurgeExecutionResult,
    StorageError
  >;

  /**
   * Check if a purge is scheduled.
   */
  readonly isPurgeScheduled: () => Effect.Effect<boolean, StorageError>;

  /**
   * Cancel scheduled purge (e.g., if workflow is restarted).
   */
  readonly cancelPurge: () => Effect.Effect<void, StorageError>;
}

/**
 * Effect service tag for PurgeManager.
 */
export class PurgeManager extends Context.Tag("@durable-effect/PurgeManager")<
  PurgeManager,
  PurgeManagerService
>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create PurgeManager service implementation.
 */
export const createPurgeManager = (config: ParsedPurgeConfig) =>
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const scheduler = yield* SchedulerAdapter;
    const runtime = yield* RuntimeAdapter;

    const service: PurgeManagerService = {
      schedulePurge: (terminalState) =>
        Effect.gen(function* () {
          // No-op if purge disabled
          if (!config.enabled) {
            return;
          }

          const now = yield* runtime.now();
          const purgeAt = now + config.delayMs;

          // Store purge metadata
          yield* storage.putBatch({
            [PURGE_KEYS.scheduled]: true,
            [PURGE_KEYS.purgeAt]: purgeAt,
            [PURGE_KEYS.reason]: terminalState,
            [PURGE_KEYS.alarmType]: "purge",
          });

          // Schedule alarm
          yield* scheduler.schedule(purgeAt);
        }),

      executePurgeIfDue: () =>
        Effect.gen(function* () {
          const scheduled = yield* storage.get<boolean>(PURGE_KEYS.scheduled);
          if (!scheduled) {
            return { purged: false as const };
          }

          const purgeAt = yield* storage.get<number>(PURGE_KEYS.purgeAt);
          const reason = yield* storage.get<string>(PURGE_KEYS.reason);
          const now = yield* runtime.now();

          if (purgeAt && now >= purgeAt) {
            // Execute purge - deleteAll removes everything including purge metadata
            yield* storage.deleteAll();
            return { purged: true as const, reason: reason ?? "unknown" };
          }

          return { purged: false as const };
        }),

      isPurgeScheduled: () =>
        storage.get<boolean>(PURGE_KEYS.scheduled).pipe(
          Effect.map((v) => v ?? false)
        ),

      cancelPurge: () =>
        Effect.gen(function* () {
          yield* storage.delete(PURGE_KEYS.scheduled);
          yield* storage.delete(PURGE_KEYS.purgeAt);
          yield* storage.delete(PURGE_KEYS.reason);
          yield* storage.delete(PURGE_KEYS.alarmType);
        }),
    };

    return service;
  });

// =============================================================================
// Layers
// =============================================================================

/**
 * Create PurgeManager layer with configuration.
 */
export const PurgeManagerLayer = (config: ParsedPurgeConfig) =>
  Layer.effect(PurgeManager, createPurgeManager(config));

/**
 * Disabled PurgeManager layer (no-op).
 * Used when purge config is not provided.
 */
export const DisabledPurgeManagerLayer = Layer.succeed(PurgeManager, {
  schedulePurge: () => Effect.void,
  executePurgeIfDue: () => Effect.succeed({ purged: false as const }),
  isPurgeScheduled: () => Effect.succeed(false),
  cancelPurge: () => Effect.void,
});
