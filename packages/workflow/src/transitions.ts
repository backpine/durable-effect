/**
 * Workflow state transitions.
 *
 * Unifies status updates and event emission into a single operation,
 * ensuring they are always in sync.
 */

import { Effect } from "effect";
import { UnknownException } from "effect/Cause";
import { createBaseEvent } from "@durable-effect/core";
import { setWorkflowStatus } from "@/services/workflow-context";
import { emitEvent } from "@/tracker";

// =============================================================================
// Types
// =============================================================================

/**
 * Represents a workflow state transition.
 * Each transition maps to both a status update and an event emission.
 */
export type WorkflowTransition =
  | { readonly _tag: "Start"; readonly input: unknown }
  | { readonly _tag: "Queue"; readonly input: unknown }
  | { readonly _tag: "Resume" }
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
      readonly error: {
        readonly message: string;
        readonly stack?: string;
        readonly stepName?: string;
        readonly attempt?: number;
      };
      readonly completedSteps: ReadonlyArray<string>;
    };

// =============================================================================
// Transition Function
// =============================================================================

/**
 * Execute a workflow transition: update status AND emit event atomically.
 *
 * This ensures status and events are always in sync. Every workflow state
 * change goes through this function.
 *
 * @param storage - Durable Object storage
 * @param workflowId - Durable Object ID
 * @param workflowName - Workflow definition name
 * @param t - The transition to execute
 * @param executionId - Optional user-provided ID for event correlation
 *
 * @example
 * ```typescript
 * // Start a workflow
 * yield* transitionWorkflow(storage, workflowId, workflowName, {
 *   _tag: "Start",
 *   input: { orderId: "123" },
 * }, executionId);
 *
 * // Complete a workflow
 * yield* transitionWorkflow(storage, workflowId, workflowName, {
 *   _tag: "Complete",
 *   completedSteps: ["step1", "step2"],
 *   durationMs: 1500,
 * }, executionId);
 * ```
 */
export const transitionWorkflow = (
  storage: DurableObjectStorage,
  workflowId: string,
  workflowName: string,
  t: WorkflowTransition,
  executionId?: string,
): Effect.Effect<void, UnknownException> =>
  Effect.gen(function* () {
    const base = createBaseEvent(workflowId, workflowName, executionId);
    const now = Date.now();

    switch (t._tag) {
      case "Start":
        yield* setWorkflowStatus(storage, { _tag: "Running" });
        yield* emitEvent({ ...base, type: "workflow.started", input: t.input });
        break;

      case "Queue":
        yield* setWorkflowStatus(storage, { _tag: "Queued", queuedAt: now });
        yield* emitEvent({ ...base, type: "workflow.queued", input: t.input });
        break;

      case "Resume":
        yield* setWorkflowStatus(storage, { _tag: "Running" });
        yield* emitEvent({ ...base, type: "workflow.resumed" });
        break;

      case "Complete":
        yield* setWorkflowStatus(storage, {
          _tag: "Completed",
          completedAt: now,
        });
        yield* emitEvent({
          ...base,
          type: "workflow.completed",
          completedSteps: t.completedSteps,
          durationMs: t.durationMs,
        });
        break;

      case "Pause":
        yield* setWorkflowStatus(storage, {
          _tag: "Paused",
          reason: t.reason,
          resumeAt: t.resumeAt,
        });
        yield* emitEvent({
          ...base,
          type: "workflow.paused",
          reason: t.reason,
          resumeAt: new Date(t.resumeAt).toISOString(),
          stepName: t.stepName,
        });
        break;

      case "Fail":
        yield* setWorkflowStatus(storage, {
          _tag: "Failed",
          error: t.error,
          failedAt: now,
        });
        yield* emitEvent({
          ...base,
          type: "workflow.failed",
          error: t.error,
          completedSteps: t.completedSteps,
        });
        break;
    }
  });
