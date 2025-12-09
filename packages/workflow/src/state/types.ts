// packages/workflow/src/state/types.ts

import { Data } from "effect";

// =============================================================================
// Workflow Status - Data.TaggedClass variants
// =============================================================================

/**
 * Workflow is initialized but not yet started.
 */
export class Pending extends Data.TaggedClass("Pending")<{}> {}

/**
 * Workflow is queued for async execution.
 */
export class Queued extends Data.TaggedClass("Queued")<{
  /** When the workflow was queued */
  readonly queuedAt: number;
}> {}

/**
 * Workflow is actively executing.
 */
export class Running extends Data.TaggedClass("Running")<{
  /** When execution started (for stale detection) */
  readonly runningAt: number;
}> {}

/**
 * Workflow is paused (sleep or retry).
 */
export class Paused extends Data.TaggedClass("Paused")<{
  /** Why paused: sleep or retry */
  readonly reason: "sleep" | "retry";
  /** When to resume */
  readonly resumeAt: number;
  /** Step that caused the pause (for retry) */
  readonly stepName?: string;
}> {}

/**
 * Workflow completed successfully.
 */
export class Completed extends Data.TaggedClass("Completed")<{
  /** When completed */
  readonly completedAt: number;
}> {}

/**
 * Workflow failed with an error.
 */
export class Failed extends Data.TaggedClass("Failed")<{
  /** When failed */
  readonly failedAt: number;
  /** Error details */
  readonly error: WorkflowError;
}> {}

/**
 * Workflow was cancelled.
 */
export class Cancelled extends Data.TaggedClass("Cancelled")<{
  /** When cancelled */
  readonly cancelledAt: number;
  /** Optional cancellation reason */
  readonly reason?: string;
}> {}

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
  | Pending
  | Queued
  | Running
  | Paused
  | Completed
  | Failed
  | Cancelled;

/**
 * Error information stored with failed workflows.
 */
export interface WorkflowError {
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
  readonly stepName?: string;
  readonly attempt?: number;
}

// =============================================================================
// Workflow Transitions - Data.TaggedClass variants
// =============================================================================

/**
 * Start a workflow.
 */
export class Start extends Data.TaggedClass("Start")<{
  readonly input: unknown;
}> {}

/**
 * Queue a workflow for async execution.
 */
export class Queue extends Data.TaggedClass("Queue")<{
  readonly input: unknown;
}> {}

/**
 * Resume a paused workflow.
 */
export class Resume extends Data.TaggedClass("Resume")<{}> {}

/**
 * Recover a workflow after infrastructure failure.
 */
export class Recover extends Data.TaggedClass("Recover")<{
  readonly reason: "infrastructure_restart" | "stale_detection" | "manual";
  readonly attempt: number;
}> {}

/**
 * Complete a workflow successfully.
 */
export class Complete extends Data.TaggedClass("Complete")<{
  readonly completedSteps: ReadonlyArray<string>;
  readonly durationMs: number;
}> {}

/**
 * Pause a workflow (sleep or retry).
 */
export class Pause extends Data.TaggedClass("Pause")<{
  readonly reason: "sleep" | "retry";
  readonly resumeAt: number;
  readonly stepName?: string;
}> {}

/**
 * Fail a workflow with an error.
 */
export class Fail extends Data.TaggedClass("Fail")<{
  readonly error: WorkflowError;
  readonly completedSteps: ReadonlyArray<string>;
}> {}

/**
 * Cancel a workflow.
 */
export class Cancel extends Data.TaggedClass("Cancel")<{
  readonly reason?: string;
  readonly completedSteps: ReadonlyArray<string>;
}> {}

/**
 * All possible workflow transitions.
 *
 * Each transition represents a state change action.
 */
export type WorkflowTransition =
  | Start
  | Queue
  | Resume
  | Recover
  | Complete
  | Pause
  | Fail
  | Cancel;

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
  executionId?: string,
): WorkflowState => ({
  status: new Pending(),
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
