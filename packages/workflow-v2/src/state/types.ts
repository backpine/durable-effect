// packages/workflow-v2/src/state/types.ts

/**
 * All possible workflow statuses.
 *
 * Lifecycle:
 *   Pending → Queued → Running → Completed
 *                  ↘         ↗
 *                   Paused
 *                  ↗         ↘
 *              Running → Failed/Cancelled
 */
export type WorkflowStatus =
  | { readonly _tag: "Pending" }
  | {
      readonly _tag: "Queued";
      /** When the workflow was queued */
      readonly queuedAt: number;
    }
  | {
      readonly _tag: "Running";
      /** When execution started (for stale detection) */
      readonly runningAt: number;
    }
  | {
      readonly _tag: "Paused";
      /** Why paused: sleep or retry */
      readonly reason: "sleep" | "retry";
      /** When to resume */
      readonly resumeAt: number;
      /** Step that caused the pause (for retry) */
      readonly stepName?: string;
    }
  | {
      readonly _tag: "Completed";
      /** When completed */
      readonly completedAt: number;
    }
  | {
      readonly _tag: "Failed";
      /** When failed */
      readonly failedAt: number;
      /** Error details */
      readonly error: WorkflowError;
    }
  | {
      readonly _tag: "Cancelled";
      /** When cancelled */
      readonly cancelledAt: number;
      /** Optional cancellation reason */
      readonly reason?: string;
    };

/**
 * Error information stored with failed workflows.
 */
export interface WorkflowError {
  readonly message: string;
  readonly stack?: string;
  readonly stepName?: string;
  readonly attempt?: number;
}

/**
 * All possible workflow transitions.
 *
 * Each transition represents a state change action.
 */
export type WorkflowTransition =
  | {
      readonly _tag: "Start";
      readonly input: unknown;
    }
  | {
      readonly _tag: "Queue";
      readonly input: unknown;
    }
  | {
      readonly _tag: "Resume";
    }
  | {
      readonly _tag: "Recover";
      readonly reason: "infrastructure_restart" | "stale_detection" | "manual";
      readonly attempt: number;
    }
  | {
      readonly _tag: "Complete";
      readonly completedSteps: ReadonlyArray<string>;
      readonly durationMs: number;
    }
  | {
      readonly _tag: "Pause";
      readonly reason: "sleep" | "retry";
      readonly resumeAt: number;
      readonly stepName?: string;
    }
  | {
      readonly _tag: "Fail";
      readonly error: WorkflowError;
      readonly completedSteps: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Cancel";
      readonly reason?: string;
      readonly completedSteps: ReadonlyArray<string>;
    };

/**
 * Extract the tag from a transition for validation.
 */
export type TransitionTag = WorkflowTransition["_tag"];

/**
 * Extract the tag from a status for validation.
 */
export type StatusTag = WorkflowStatus["_tag"];

/**
 * Complete workflow state including metadata.
 */
export interface WorkflowState {
  /** Current status */
  readonly status: WorkflowStatus;
  /** Workflow definition name */
  readonly workflowName: string;
  /** Input passed to workflow */
  readonly input: unknown;
  /** Optional correlation ID */
  readonly executionId?: string;
  /** Steps that have completed */
  readonly completedSteps: ReadonlyArray<string>;
  /** Pause point tracking */
  readonly completedPauseIndex: number;
  /** Pending resume time (if paused) */
  readonly pendingResumeAt?: number;
  /** Recovery attempt counter */
  readonly recoveryAttempts: number;
  /** Cancellation flag */
  readonly cancelled: boolean;
  /** Cancellation reason */
  readonly cancelReason?: string;
}

/**
 * Default initial state for a new workflow.
 */
export const initialWorkflowState = (
  workflowName: string,
  input: unknown,
  executionId?: string
): WorkflowState => ({
  status: { _tag: "Pending" },
  workflowName,
  input,
  executionId,
  completedSteps: [],
  completedPauseIndex: 0,
  pendingResumeAt: undefined,
  recoveryAttempts: 0,
  cancelled: false,
  cancelReason: undefined,
});
