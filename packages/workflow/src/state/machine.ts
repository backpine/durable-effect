// packages/workflow/src/state/machine.ts

import { Context, Effect, Layer } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { RuntimeAdapter } from "../adapters/runtime";
import { InvalidTransitionError, StorageError } from "../errors";
import {
  type WorkflowStatus,
  type WorkflowTransition,
  type WorkflowState,
  // Status classes
  Pending,
  Queued,
  Running,
  Paused,
  Completed,
  Failed,
  Cancelled,
} from "./types";
import {
  isValidTransition,
  getValidTransitions,
  isTerminalStatus,
  isRecoverableStatus,
} from "./transitions";

// =============================================================================
// Storage Keys
// =============================================================================

const KEYS = {
  status: "workflow:status",
  name: "workflow:name",
  input: "workflow:input",
  executionId: "workflow:executionId",
  completedSteps: "workflow:completedSteps",
  completedPauseIndex: "workflow:completedPauseIndex",
  pendingResumeAt: "workflow:pendingResumeAt",
  recoveryAttempts: "workflow:recoveryAttempts",
  cancelled: "workflow:cancelled",
  cancelReason: "workflow:cancelReason",
} as const;

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Information about whether a workflow can be recovered.
 */
export interface RecoverabilityInfo {
  readonly canRecover: boolean;
  readonly reason:
    | "stale_running"
    | "pending_resume"
    | "not_recoverable"
    | "already_terminal"
    | "no_workflow";
  readonly staleDurationMs?: number;
  readonly currentStatus?: WorkflowStatus["_tag"];
}

/**
 * WorkflowStateMachine service interface.
 *
 * Central authority for workflow state management.
 */
export interface WorkflowStateMachineService {
  /**
   * Initialize state for a new workflow.
   */
  readonly initialize: (
    workflowName: string,
    input: unknown,
    executionId?: string,
  ) => Effect.Effect<void, StorageError>;

  /**
   * Get the current workflow state.
   * Returns undefined if no workflow exists.
   */
  readonly getState: () => Effect.Effect<
    WorkflowState | undefined,
    StorageError
  >;

  /**
   * Get just the current status.
   * Returns undefined if no workflow exists.
   */
  readonly getStatus: () => Effect.Effect<
    WorkflowStatus | undefined,
    StorageError
  >;

  /**
   * Check if a transition is valid from current state.
   */
  readonly canTransition: (
    transition: WorkflowTransition,
  ) => Effect.Effect<boolean, StorageError>;

  /**
   * Apply a transition (validates, updates storage).
   * Fails with InvalidTransitionError if transition not allowed.
   */
  readonly applyTransition: (
    transition: WorkflowTransition,
  ) => Effect.Effect<WorkflowStatus, InvalidTransitionError | StorageError>;

  /**
   * Check if the workflow can be recovered.
   */
  readonly checkRecoverability: (
    staleThresholdMs: number,
  ) => Effect.Effect<RecoverabilityInfo, StorageError>;

  /**
   * Add a completed step to the list.
   */
  readonly markStepCompleted: (
    stepName: string,
  ) => Effect.Effect<void, StorageError>;

  /**
   * Get the list of completed steps.
   */
  readonly getCompletedSteps: () => Effect.Effect<
    ReadonlyArray<string>,
    StorageError
  >;

  /**
   * Increment recovery attempts counter.
   */
  readonly incrementRecoveryAttempts: () => Effect.Effect<number, StorageError>;

  /**
   * Reset recovery attempts counter (after successful recovery).
   */
  readonly resetRecoveryAttempts: () => Effect.Effect<void, StorageError>;

  /**
   * Set the pending resume time (for sleep/retry).
   */
  readonly setPendingResumeAt: (
    time: number,
  ) => Effect.Effect<void, StorageError>;

  /**
   * Clear the pending resume time.
   */
  readonly clearPendingResumeAt: () => Effect.Effect<void, StorageError>;

  /**
   * Get the pending resume time.
   */
  readonly getPendingResumeAt: () => Effect.Effect<
    number | undefined,
    StorageError
  >;

  /**
   * Set the cancellation flag.
   */
  readonly setCancelled: (reason?: string) => Effect.Effect<void, StorageError>;

  /**
   * Check if workflow is cancelled.
   */
  readonly isCancelled: () => Effect.Effect<boolean, StorageError>;
}

/**
 * Effect service tag for WorkflowStateMachine.
 */
export class WorkflowStateMachine extends Context.Tag(
  "@durable-effect/WorkflowStateMachine",
)<WorkflowStateMachine, WorkflowStateMachineService>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Apply a transition to produce a new status.
 * Assumes transition has already been validated.
 */
function applyTransitionToStatus(
  transition: WorkflowTransition,
  now: number,
): WorkflowStatus {
  switch (transition._tag) {
    case "Start":
    case "Resume":
    case "Recover":
      return new Running({ runningAt: now });

    case "Queue":
      return new Queued({ queuedAt: now });

    case "Pause":
      return new Paused({
        reason: transition.reason,
        resumeAt: transition.resumeAt,
        stepName: transition.stepName,
      });

    case "Complete":
      return new Completed({ completedAt: now });

    case "Fail":
      return new Failed({
        failedAt: now,
        error: transition.error,
      });

    case "Cancel":
      return new Cancelled({
        cancelledAt: now,
        reason: transition.reason,
      });
  }
}

/**
 * Create the WorkflowStateMachine service implementation.
 */
export const createWorkflowStateMachine = Effect.gen(function* () {
  const storage = yield* StorageAdapter;
  const runtime = yield* RuntimeAdapter;

  const getStatus = (): Effect.Effect<
    WorkflowStatus | undefined,
    StorageError
  > => storage.get<WorkflowStatus>(KEYS.status);

  const getState = (): Effect.Effect<WorkflowState | undefined, StorageError> =>
    Effect.gen(function* () {
      // Use batch read with list() instead of individual get() calls
      const entries = yield* storage.list<unknown>("workflow:");

      // If no status, no workflow exists
      const status = entries.get(KEYS.status) as WorkflowStatus | undefined;
      if (!status) return undefined;

      return {
        status,
        workflowName: (entries.get(KEYS.name) as string) ?? "unknown",
        input: entries.get(KEYS.input),
        executionId: entries.get(KEYS.executionId) as string | undefined,
        completedSteps: (entries.get(KEYS.completedSteps) as string[]) ?? [],
        completedPauseIndex: (entries.get(KEYS.completedPauseIndex) as number) ?? 0,
        pendingResumeAt: entries.get(KEYS.pendingResumeAt) as number | undefined,
        recoveryAttempts: (entries.get(KEYS.recoveryAttempts) as number) ?? 0,
        cancelled: (entries.get(KEYS.cancelled) as boolean) ?? false,
        cancelReason: entries.get(KEYS.cancelReason) as string | undefined,
      };
    });

  const service: WorkflowStateMachineService = {
    initialize: (workflowName, input, executionId) =>
      storage.putBatch({
        [KEYS.status]: new Pending(),
        [KEYS.name]: workflowName,
        [KEYS.input]: input,
        [KEYS.executionId]: executionId,
        [KEYS.completedSteps]: [],
        [KEYS.completedPauseIndex]: 0,
        [KEYS.recoveryAttempts]: 0,
        [KEYS.cancelled]: false,
      }),

    getState,
    getStatus,

    canTransition: (transition) =>
      Effect.gen(function* () {
        const status = yield* getStatus();
        if (!status) return false;
        return isValidTransition(status._tag, transition._tag);
      }),

    applyTransition: (transition) =>
      Effect.gen(function* () {
        const currentStatus = yield* getStatus();

        // No workflow exists - only Queue and Start are valid for new workflows
        if (!currentStatus) {
          if (transition._tag !== "Queue" && transition._tag !== "Start") {
            return yield* Effect.fail(
              new InvalidTransitionError({
                fromStatus: "none",
                toTransition: transition._tag,
                validTransitions: ["Queue", "Start"],
              }),
            );
          }
        } else {
          // Validate transition
          if (!isValidTransition(currentStatus._tag, transition._tag)) {
            return yield* Effect.fail(
              new InvalidTransitionError({
                fromStatus: currentStatus._tag,
                toTransition: transition._tag,
                validTransitions: getValidTransitions(currentStatus._tag),
              }),
            );
          }
        }

        // Get current time
        const now = yield* runtime.now();

        // Calculate new status
        const newStatus = applyTransitionToStatus(transition, now);

        // Persist
        yield* storage.put(KEYS.status, newStatus);

        return newStatus;
      }),

    checkRecoverability: (staleThresholdMs) =>
      Effect.gen(function* () {
        const status = yield* getStatus();

        if (!status) {
          return {
            canRecover: false,
            reason: "no_workflow" as const,
          };
        }

        if (isTerminalStatus(status._tag)) {
          return {
            canRecover: false,
            reason: "already_terminal" as const,
            currentStatus: status._tag,
          };
        }

        if (!isRecoverableStatus(status._tag)) {
          return {
            canRecover: false,
            reason: "not_recoverable" as const,
            currentStatus: status._tag,
          };
        }

        // Check for stale Running status
        if (status._tag === "Running") {
          const now = yield* runtime.now();
          const staleDuration = now - status.runningAt;

          if (staleDuration >= staleThresholdMs) {
            return {
              canRecover: true,
              reason: "stale_running" as const,
              staleDurationMs: staleDuration,
              currentStatus: status._tag,
            };
          }

          // Running but not stale - don't recover
          return {
            canRecover: false,
            reason: "not_recoverable" as const,
            currentStatus: status._tag,
          };
        }

        // Check Paused status with pending resume
        if (status._tag === "Paused") {
          const pendingResumeAt = yield* storage.get<number>(
            KEYS.pendingResumeAt,
          );

          if (pendingResumeAt !== undefined) {
            return {
              canRecover: true,
              reason: "pending_resume" as const,
              currentStatus: status._tag,
            };
          }
        }

        return {
          canRecover: false,
          reason: "not_recoverable" as const,
          currentStatus: status._tag,
        };
      }),

    markStepCompleted: (stepName) =>
      Effect.gen(function* () {
        const steps = (yield* storage.get<string[]>(KEYS.completedSteps)) ?? [];
        if (!steps.includes(stepName)) {
          yield* storage.put(KEYS.completedSteps, [...steps, stepName]);
        }
      }),

    getCompletedSteps: () =>
      storage
        .get<string[]>(KEYS.completedSteps)
        .pipe(Effect.map((steps) => steps ?? [])),

    incrementRecoveryAttempts: () =>
      Effect.gen(function* () {
        const current =
          (yield* storage.get<number>(KEYS.recoveryAttempts)) ?? 0;
        const next = current + 1;
        yield* storage.put(KEYS.recoveryAttempts, next);
        return next;
      }),

    resetRecoveryAttempts: () => storage.put(KEYS.recoveryAttempts, 0),

    setPendingResumeAt: (time) => storage.put(KEYS.pendingResumeAt, time),

    clearPendingResumeAt: () =>
      storage.delete(KEYS.pendingResumeAt).pipe(Effect.asVoid),

    getPendingResumeAt: () => storage.get<number>(KEYS.pendingResumeAt),

    setCancelled: (reason) =>
      Effect.gen(function* () {
        yield* storage.put(KEYS.cancelled, true);
        if (reason) {
          yield* storage.put(KEYS.cancelReason, reason);
        }
      }),

    isCancelled: () =>
      storage
        .get<boolean>(KEYS.cancelled)
        .pipe(Effect.map((cancelled) => cancelled ?? false)),
  };

  return service;
});

/**
 * Layer that provides WorkflowStateMachine.
 * Requires StorageAdapter and RuntimeAdapter.
 */
export const WorkflowStateMachineLayer = Layer.effect(
  WorkflowStateMachine,
  createWorkflowStateMachine,
);
