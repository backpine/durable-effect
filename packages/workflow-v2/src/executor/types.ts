// packages/workflow-v2/src/executor/types.ts

import type { WorkflowTransition } from "../state/types";

/**
 * Execution mode determines how the workflow is run.
 */
export type ExecutionMode =
  | "fresh" // New workflow, start from beginning
  | "resume" // Resume from pause (sleep/retry woke up)
  | "recover"; // Recovery from infrastructure failure

/**
 * Result of workflow execution.
 */
export type ExecutionResult<Output> =
  | {
      readonly _tag: "Completed";
      readonly output: Output;
      readonly durationMs: number;
      readonly completedSteps: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Paused";
      readonly reason: "sleep" | "retry";
      readonly resumeAt: number;
      readonly stepName?: string;
      readonly attempt?: number;
    }
  | {
      readonly _tag: "Failed";
      readonly error: unknown;
      readonly durationMs: number;
      readonly completedSteps: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Cancelled";
      readonly reason?: string;
      readonly completedSteps: ReadonlyArray<string>;
    };

/**
 * Execution context provided to the executor.
 */
export interface ExecutionContext {
  /** Workflow instance ID */
  readonly workflowId: string;
  /** Workflow definition name */
  readonly workflowName: string;
  /** Workflow input */
  readonly input: unknown;
  /** Optional execution/correlation ID */
  readonly executionId?: string;
  /** Execution mode */
  readonly mode: ExecutionMode;
}

/**
 * Map execution result to state transition.
 */
export function resultToTransition<Output>(
  result: ExecutionResult<Output>
): WorkflowTransition {
  switch (result._tag) {
    case "Completed":
      return {
        _tag: "Complete",
        completedSteps: result.completedSteps,
        durationMs: result.durationMs,
      };

    case "Paused":
      return {
        _tag: "Pause",
        reason: result.reason,
        resumeAt: result.resumeAt,
        stepName: result.stepName,
      };

    case "Failed":
      return {
        _tag: "Fail",
        error: {
          message:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
          stack:
            result.error instanceof Error ? result.error.stack : undefined,
        },
        completedSteps: result.completedSteps,
      };

    case "Cancelled":
      return {
        _tag: "Cancel",
        reason: result.reason,
        completedSteps: result.completedSteps,
      };
  }
}
