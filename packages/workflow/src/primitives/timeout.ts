// packages/workflow/src/primitives/timeout.ts

import { Effect } from "effect";
import { createBaseEvent } from "@durable-effect/core";
import { StepContext } from "../context/step-context";
import { WorkflowContext } from "../context/workflow-context";
import { RuntimeAdapter } from "../adapters/runtime";
import { emitEvent } from "../tracker";
import type { StorageError } from "../errors";
import { parseDuration } from "./backoff";

// =============================================================================
// Types
// =============================================================================

/**
 * Error when a step times out.
 */
export class WorkflowTimeoutError extends Error {
  readonly _tag = "WorkflowTimeoutError";
  readonly stepName: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;

  constructor(stepName: string, timeoutMs: number, elapsedMs: number) {
    super(
      `Step "${stepName}" timed out after ${elapsedMs}ms (timeout: ${timeoutMs}ms)`,
    );
    this.name = "WorkflowTimeoutError";
    this.stepName = stepName;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
  }
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Durable timeout operator for use inside Workflow.step().
 *
 * This operator adds a deadline to any Effect:
 * - Persists start time for deadline tracking across restarts
 * - Calculates remaining time on replay
 * - Fails with WorkflowTimeoutError if deadline exceeded
 *
 * @param duration - Timeout duration (string like "30 seconds" or number in ms)
 *
 * @example
 * ```ts
 * yield* Workflow.step("Call API",
 *   callExternalAPI().pipe(
 *     Workflow.timeout("30 seconds")
 *   )
 * );
 *
 * // Combined with retry (timeout applies to each attempt)
 * yield* Workflow.step("Resilient call",
 *   riskyOperation().pipe(
 *     Workflow.timeout("10 seconds"),
 *     Workflow.retry({ maxAttempts: 3 })
 *   )
 * );
 * ```
 */
export function timeout<A, E, R>(
  duration: string | number,
): (
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<
  A,
  E | StorageError | WorkflowTimeoutError,
  R | StepContext | RuntimeAdapter | WorkflowContext
> {
  const timeoutMs = parseDuration(duration);

  return (effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const stepCtx = yield* StepContext;
      const runtime = yield* RuntimeAdapter;
      const workflowCtx = yield* WorkflowContext;
      const now = yield* runtime.now();

      // Get workflow identity for events
      const workflowId = yield* workflowCtx.workflowId;
      const workflowName = yield* workflowCtx.workflowName;
      const executionId = yield* workflowCtx.executionId;

      // Get or set start time (for deadline calculation)
      const existingStartedAt = yield* stepCtx.startedAt;
      const isFirstExecution = existingStartedAt === undefined;
      const startedAt = existingStartedAt ?? now;
      if (isFirstExecution) {
        yield* stepCtx.setStartedAt(startedAt);
      }

      // Calculate remaining time
      const deadline = startedAt + timeoutMs;
      const remainingMs = deadline - now;

      // Emit timeout.set event on first execution
      if (isFirstExecution) {
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName, executionId),
          type: "timeout.set",
          stepName: stepCtx.stepName,
          deadline: new Date(deadline).toISOString(),
          timeoutMs,
        });
      }

      // Check if already timed out
      if (remainingMs <= 0) {
        // Emit timeout.exceeded event
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName, executionId),
          type: "timeout.exceeded",
          stepName: stepCtx.stepName,
          timeoutMs,
        });

        return yield* Effect.fail(
          new WorkflowTimeoutError(
            stepCtx.stepName,
            timeoutMs,
            now - startedAt,
          ),
        );
      }

      // Execute with Effect.timeout for the remaining time
      return yield* effect.pipe(
        Effect.timeoutFail({
          duration: remainingMs,
          onTimeout: () =>
            new WorkflowTimeoutError(
              stepCtx.stepName,
              timeoutMs,
              now - startedAt,
            ),
        }),
        Effect.tapError((error) =>
          error instanceof WorkflowTimeoutError
            ? emitEvent({
                ...createBaseEvent(workflowId, workflowName, executionId),
                type: "timeout.exceeded",
                stepName: stepCtx.stepName,
                timeoutMs,
              })
            : Effect.void,
        ),
      );
    });
}
