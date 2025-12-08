// packages/workflow/src/recovery/manager.ts

import { Context, Effect, Layer } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { SchedulerAdapter } from "../adapters/scheduler";
import { RuntimeAdapter } from "../adapters/runtime";
import {
  WorkflowStateMachine,
  type RecoverabilityInfo,
} from "../state/machine";
import { RecoveryError, StorageError, SchedulerError } from "../errors";
import { type RecoveryConfig, defaultRecoveryConfig } from "./config";

// =============================================================================
// Types
// =============================================================================

/**
 * Result of checking for recovery needs.
 */
export interface RecoveryCheckResult {
  /** Whether recovery was scheduled */
  readonly scheduled: boolean;
  /** Why recovery was or wasn't scheduled */
  readonly reason:
    | "stale_running"
    | "pending_resume"
    | "not_needed"
    | "already_terminal"
    | "no_workflow"
    | "max_attempts_exceeded";
  /** Duration the workflow has been stale (if applicable) */
  readonly staleDurationMs?: number;
  /** Current status before recovery */
  readonly currentStatus?: string;
  /** Recovery attempt number (if scheduled) */
  readonly attempt?: number;
}

/**
 * Result of executing recovery.
 */
export interface RecoveryExecuteResult {
  /** Whether recovery completed successfully */
  readonly success: boolean;
  /** Recovery attempt number */
  readonly attempt: number;
  /** Reason for success/failure */
  readonly reason:
    | "recovered"
    | "already_completed"
    | "max_attempts_exceeded"
    | "transition_failed";
  /** New status after recovery */
  readonly newStatus?: string;
}

/**
 * Recovery statistics for observability.
 */
export interface RecoveryStats {
  /** Current recovery attempt count */
  readonly attempts: number;
  /** Maximum allowed attempts */
  readonly maxAttempts: number;
  /** Timestamp of last recovery attempt */
  readonly lastAttemptAt?: number;
  /** Whether max attempts has been exceeded */
  readonly maxExceeded: boolean;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * RecoveryManager service interface.
 *
 * Handles detection and recovery of workflows interrupted by infrastructure.
 */
export interface RecoveryManagerService {
  /**
   * Check for stale workflows and schedule recovery if needed.
   *
   * This should be called in the runtime's initialization phase.
   * For Durable Objects, call in constructor with blockConcurrencyWhile.
   */
  readonly checkAndScheduleRecovery: () => Effect.Effect<
    RecoveryCheckResult,
    StorageError | SchedulerError
  >;

  /**
   * Execute recovery for a stale workflow.
   *
   * This should be called when:
   * 1. The alarm fires and status is still "Running"
   * 2. A recovery alarm was scheduled in checkAndScheduleRecovery
   */
  readonly executeRecovery: () => Effect.Effect<
    RecoveryExecuteResult,
    RecoveryError | StorageError
  >;

  /**
   * Get recovery statistics for observability.
   */
  readonly getStats: () => Effect.Effect<RecoveryStats, StorageError>;

  /**
   * Check if recovery is needed without scheduling.
   * Useful for status queries.
   */
  readonly checkRecoveryNeeded: () => Effect.Effect<
    RecoverabilityInfo,
    StorageError
  >;
}

/**
 * Effect service tag for RecoveryManager.
 */
export class RecoveryManager extends Context.Tag(
  "@durable-effect/RecoveryManager",
)<RecoveryManager, RecoveryManagerService>() {}

// =============================================================================
// Storage Keys
// =============================================================================

const KEYS = {
  lastRecoveryAt: "workflow:lastRecoveryAt",
} as const;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create the RecoveryManager service implementation.
 */
export const createRecoveryManager = (
  config: RecoveryConfig = defaultRecoveryConfig,
) =>
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const scheduler = yield* SchedulerAdapter;
    const runtime = yield* RuntimeAdapter;
    const stateMachine = yield* WorkflowStateMachine;

    const service: RecoveryManagerService = {
      checkAndScheduleRecovery: () =>
        Effect.gen(function* () {
          // Check current recoverability
          const info = yield* stateMachine.checkRecoverability(
            config.staleThresholdMs,
          );

          // No workflow or not recoverable
          if (!info.canRecover) {
            return {
              scheduled: false,
              reason:
                info.reason === "already_terminal"
                  ? "already_terminal"
                  : info.reason === "no_workflow"
                    ? "no_workflow"
                    : "not_needed",
              currentStatus: info.currentStatus,
            } satisfies RecoveryCheckResult;
          }

          // Check recovery attempt count
          const stats = yield* service.getStats();
          if (stats.maxExceeded) {
            return {
              scheduled: false,
              reason: "max_attempts_exceeded",
              currentStatus: info.currentStatus,
            } satisfies RecoveryCheckResult;
          }

          // Schedule recovery alarm
          const now = yield* runtime.now();
          const recoveryTime = now + config.recoveryDelayMs;
          yield* scheduler.schedule(recoveryTime);

          // Track when we scheduled recovery
          yield* storage.put(KEYS.lastRecoveryAt, now);

          return {
            scheduled: true,
            reason:
              info.reason === "stale_running"
                ? "stale_running"
                : "pending_resume",
            staleDurationMs: info.staleDurationMs,
            currentStatus: info.currentStatus,
            attempt: stats.attempts + 1,
          } satisfies RecoveryCheckResult;
        }),

      executeRecovery: () =>
        Effect.gen(function* () {
          // Get current state
          const status = yield* stateMachine.getStatus();

          // No workflow or already terminal
          if (!status) {
            return {
              success: false,
              attempt: 0,
              reason: "already_completed" as const,
            };
          }

          if (
            status._tag === "Completed" ||
            status._tag === "Failed" ||
            status._tag === "Cancelled"
          ) {
            return {
              success: false,
              attempt: 0,
              reason: "already_completed" as const,
              newStatus: status._tag,
            };
          }

          // Check recovery attempts
          const stats = yield* service.getStats();
          if (stats.maxExceeded) {
            // Mark workflow as failed due to max recovery attempts
            const completedSteps = yield* stateMachine.getCompletedSteps();
            yield* stateMachine
              .applyTransition({
                _tag: "Fail",
                error: {
                  message: `Workflow failed after ${stats.maxAttempts} recovery attempts`,
                },
                completedSteps,
              })
              .pipe(
                Effect.catchTag("InvalidTransitionError", () => Effect.void),
              );

            return yield* Effect.fail(
              new RecoveryError({
                reason: "max_attempts_exceeded",
                attempts: stats.attempts,
                maxAttempts: stats.maxAttempts,
              }),
            );
          }

          // Increment recovery counter
          const attempt = yield* stateMachine.incrementRecoveryAttempts();

          // Apply recovery transition
          const transitionResult = yield* stateMachine
            .applyTransition({
              _tag: "Recover",
              reason:
                status._tag === "Running"
                  ? "stale_detection"
                  : "infrastructure_restart",
              attempt,
            })
            .pipe(
              Effect.map((newStatus) => ({
                success: true as const,
                attempt,
                reason: "recovered" as const,
                newStatus: newStatus._tag,
              })),
              Effect.catchTag("InvalidTransitionError", () =>
                Effect.succeed({
                  success: false as const,
                  attempt,
                  reason: "transition_failed" as const,
                }),
              ),
            );

          // If recovery succeeded, reset attempt counter
          if (transitionResult.success) {
            yield* stateMachine.resetRecoveryAttempts();
          }

          return transitionResult;
        }),

      getStats: () =>
        Effect.gen(function* () {
          const attempts = yield* storage
            .get<number>("workflow:recoveryAttempts")
            .pipe(Effect.map((a) => a ?? 0));

          const lastAttemptAt = yield* storage.get<number>(KEYS.lastRecoveryAt);

          return {
            attempts,
            maxAttempts: config.maxRecoveryAttempts,
            lastAttemptAt,
            maxExceeded: attempts >= config.maxRecoveryAttempts,
          };
        }),

      checkRecoveryNeeded: () =>
        stateMachine.checkRecoverability(config.staleThresholdMs),
    };

    return service;
  });

/**
 * Create a RecoveryManager layer with custom config.
 */
export const RecoveryManagerLayer = (config?: Partial<RecoveryConfig>) =>
  Layer.effect(
    RecoveryManager,
    createRecoveryManager({
      ...defaultRecoveryConfig,
      ...config,
    }),
  );

/**
 * RecoveryManager layer with default config.
 */
export const DefaultRecoveryManagerLayer = Layer.effect(
  RecoveryManager,
  createRecoveryManager(),
);
