// packages/workflow-v2/src/primitives/sleep.ts

import { Effect, Option } from "effect";
import { createBaseEvent } from "@durable-effect/core";
import { WorkflowContext } from "../context/workflow-context";
import { WorkflowScope, WorkflowScopeError } from "../context/workflow-scope";
import { guardWorkflowOperation, StepScopeError } from "../context/step-scope";
import { WorkflowLevel } from "../context/workflow-level";
import { RuntimeAdapter } from "../adapters/runtime";
import { StorageAdapter } from "../adapters/storage";
import { emitEvent } from "../tracker";
import type { StorageError } from "../errors";
import { PauseSignal } from "./pause-signal";
import { parseDuration } from "./backoff";

/**
 * Durable sleep that survives process restarts.
 *
 * Unlike Effect.sleep, this:
 * - Persists the wake-up time
 * - Pauses workflow execution
 * - Schedules an alarm to resume
 * - Skips if already completed on replay
 *
 * @param duration - Duration to sleep (string like "5 seconds" or number in ms)
 *
 * @example
 * ```ts
 * // Sleep for 1 hour (survives process restarts!)
 * yield* Workflow.sleep("1 hour");
 *
 * // Sleep for 5 seconds
 * yield* Workflow.sleep("5s");
 *
 * // Sleep for specific milliseconds
 * yield* Workflow.sleep(30000);
 * ```
 */
export function sleep(
  duration: string | number
): Effect.Effect<
  void,
  PauseSignal | StorageError | WorkflowScopeError | StepScopeError,
  WorkflowContext | WorkflowScope | RuntimeAdapter | StorageAdapter | WorkflowLevel
> {
  return Effect.gen(function* () {
    // Access WorkflowLevel to ensure this primitive can only be used at workflow level
    // This enables compile-time checking - if used inside a step, WorkflowLevel won't be available
    yield* WorkflowLevel;

    // Guard against calling inside a step (runtime check as fallback)
    yield* guardWorkflowOperation("Workflow.sleep");

    // Verify we're in a workflow scope
    const scope = yield* Effect.serviceOption(WorkflowScope);
    if (Option.isNone(scope)) {
      return yield* Effect.fail(
        new WorkflowScopeError({
          message: "Workflow.sleep() can only be used inside a workflow",
        })
      );
    }

    const workflowCtx = yield* WorkflowContext;
    const runtime = yield* RuntimeAdapter;
    const storage = yield* StorageAdapter;

    // Get workflow identity for events
    const workflowId = yield* workflowCtx.workflowId;
    const workflowName = yield* workflowCtx.workflowName;
    const executionId = yield* workflowCtx.executionId;

    // Calculate duration in ms for event
    const durationMs = parseDuration(duration);

    // Get current pause index and increment
    const pauseIndex = yield* workflowCtx.incrementPauseIndex();

    // Check if this pause point was already completed
    const shouldExecute = yield* workflowCtx.shouldExecutePause(pauseIndex);

    if (!shouldExecute) {
      // Already completed on replay - skip
      return;
    }

    // Check if there's a pending resume time that has passed
    // This handles the case where we're resuming after the alarm fired
    const pendingResumeAt = yield* workflowCtx.pendingResumeAt;
    const now = yield* runtime.now();

    if (pendingResumeAt !== undefined && now >= pendingResumeAt) {
      // Wake time has passed - mark this pause as completed and continue

      // Emit sleep.completed event
      yield* emitEvent({
        ...createBaseEvent(workflowId, workflowName, executionId),
        type: "sleep.completed",
        durationMs,
      });

      yield* storage.put("workflow:completedPauseIndex", pauseIndex);
      yield* workflowCtx.clearPendingResumeAt();
      return;
    }

    // Calculate resume time (first time hitting this sleep)
    const resumeAt = now + durationMs;

    // Store pending resume time
    yield* workflowCtx.setPendingResumeAt(resumeAt);

    // Emit sleep.started event
    yield* emitEvent({
      ...createBaseEvent(workflowId, workflowName, executionId),
      type: "sleep.started",
      durationMs,
      resumeAt: new Date(resumeAt).toISOString(),
    });

    // Throw PauseSignal - orchestrator will catch this and schedule alarm
    return yield* Effect.fail(PauseSignal.sleep(resumeAt));
  });
}

/**
 * Sleep until a specific timestamp.
 *
 * @param timestamp - Unix timestamp in milliseconds to wake at
 */
export function sleepUntil(
  timestamp: number
): Effect.Effect<
  void,
  PauseSignal | StorageError | WorkflowScopeError | StepScopeError,
  WorkflowContext | WorkflowScope | RuntimeAdapter | StorageAdapter | WorkflowLevel
> {
  return Effect.gen(function* () {
    // Access WorkflowLevel to ensure this primitive can only be used at workflow level
    // This enables compile-time checking - if used inside a step, WorkflowLevel won't be available
    yield* WorkflowLevel;

    // Guard against calling inside a step (runtime check as fallback)
    yield* guardWorkflowOperation("Workflow.sleepUntil");

    const scope = yield* Effect.serviceOption(WorkflowScope);
    if (Option.isNone(scope)) {
      return yield* Effect.fail(
        new WorkflowScopeError({
          message: "Workflow.sleepUntil() can only be used inside a workflow",
        })
      );
    }

    const workflowCtx = yield* WorkflowContext;
    const runtime = yield* RuntimeAdapter;
    const storage = yield* StorageAdapter;

    // Get workflow identity for events
    const workflowId = yield* workflowCtx.workflowId;
    const workflowName = yield* workflowCtx.workflowName;
    const executionId = yield* workflowCtx.executionId;

    const pauseIndex = yield* workflowCtx.incrementPauseIndex();
    const shouldExecute = yield* workflowCtx.shouldExecutePause(pauseIndex);

    if (!shouldExecute) {
      return;
    }

    const now = yield* runtime.now();

    // Check if there's a pending resume time that has passed
    const pendingResumeAt = yield* workflowCtx.pendingResumeAt;

    if (pendingResumeAt !== undefined && now >= pendingResumeAt) {
      // Wake time has passed - mark this pause as completed and continue
      const durationMs = pendingResumeAt - (now - (now - pendingResumeAt));

      // Emit sleep.completed event
      yield* emitEvent({
        ...createBaseEvent(workflowId, workflowName, executionId),
        type: "sleep.completed",
        durationMs: Math.max(0, durationMs),
      });

      yield* storage.put("workflow:completedPauseIndex", pauseIndex);
      yield* workflowCtx.clearPendingResumeAt();
      return;
    }

    // Check if timestamp is in the past
    if (timestamp <= now) {
      // Already past - no need to pause
      return;
    }

    const durationMs = timestamp - now;

    yield* workflowCtx.setPendingResumeAt(timestamp);

    // Emit sleep.started event
    yield* emitEvent({
      ...createBaseEvent(workflowId, workflowName, executionId),
      type: "sleep.started",
      durationMs,
      resumeAt: new Date(timestamp).toISOString(),
    });

    return yield* Effect.fail(PauseSignal.sleep(timestamp));
  });
}
