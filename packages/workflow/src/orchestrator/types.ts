// packages/workflow/src/orchestrator/types.ts

import type { WorkflowStatus } from "../state/types";
import type { WorkflowDefinition } from "../primitives/make";

/**
 * A registry mapping workflow names to their definitions.
 */
export type WorkflowRegistry = {
  readonly [name: string]: WorkflowDefinition<any, any, any, any>;
};

/**
 * Call specification for starting a workflow.
 */
export interface WorkflowCall<W extends WorkflowRegistry> {
  /** Name of the workflow to execute */
  readonly workflow: keyof W & string;
  /** Input to pass to the workflow */
  readonly input: W[keyof W] extends WorkflowDefinition<infer I, any, any, any>
    ? I
    : never;
  /** Optional execution/correlation ID */
  readonly executionId?: string;
}

/**
 * Result of starting a workflow.
 */
export interface StartResult {
  /** Workflow instance ID */
  readonly id: string;
  /** Whether workflow completed immediately */
  readonly completed: boolean;
  /** Output if completed */
  readonly output?: unknown;
}

/**
 * Result of cancelling a workflow.
 */
export interface CancelResult {
  /** Whether cancellation was applied */
  readonly cancelled: boolean;
  /** Reason if not cancelled */
  readonly reason?: "not_found" | "already_terminal" | "not_running";
  /** Status before cancel attempt */
  readonly previousStatus?: WorkflowStatus["_tag"];
}

/**
 * Options for workflow cancellation.
 */
export interface CancelOptions {
  /** Reason for cancellation */
  readonly reason?: string;
}

/**
 * Workflow status query result.
 */
export interface WorkflowStatusResult {
  /** Current status */
  readonly status: WorkflowStatus | undefined;
  /** Completed steps */
  readonly completedSteps: ReadonlyArray<string>;
  /** Whether workflow exists */
  readonly exists: boolean;
}
