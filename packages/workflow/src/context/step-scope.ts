// packages/workflow-v2/src/context/step-scope.ts

import { Context, Effect, Layer, Option } from "effect";

/**
 * StepScope is a compile-time guard that prevents Workflow.* primitives
 * from being used inside Workflow.step().
 *
 * When inside a step, StepScope is present in the context. Workflow-level
 * primitives like Workflow.sleep() and Workflow.step() check for this
 * presence and fail with a helpful error message.
 *
 * IMPORTANT: Effect.sleep() IS allowed inside steps - this guard only
 * rejects workflow-level primitives, not Effect-level operations.
 */
export interface StepScopeService {
  /**
   * Marker that step scope is active.
   */
  readonly _marker: "step-scope-active";

  /**
   * The name of the currently executing step.
   * Useful for error messages.
   */
  readonly stepName: string;
}

/**
 * Effect service tag for StepScope.
 */
export class StepScope extends Context.Tag("@durable-effect/StepScope")<
  StepScope,
  StepScopeService
>() {}

/**
 * Create a StepScope layer for use inside a step.
 */
export const StepScopeLayer = (stepName: string) =>
  Layer.succeed(StepScope, {
    _marker: "step-scope-active",
    stepName,
  });

/**
 * Check if currently inside a step scope.
 * Returns Effect that succeeds with true if in step, false otherwise.
 */
export const isInStepScope: Effect.Effect<boolean> = Effect.map(
  Effect.serviceOption(StepScope),
  Option.isSome
);

/**
 * Error when a workflow primitive is used inside a step.
 */
export class StepScopeError extends Error {
  readonly _tag = "StepScopeError";
  readonly operation: string;
  readonly stepName: string;

  constructor(opts: { operation: string; stepName: string }) {
    super(
      `${opts.operation} cannot be used inside Workflow.step("${opts.stepName}"). ` +
        "Workflow-level primitives like Workflow.sleep() and Workflow.step() " +
        "must be used at the workflow level, not inside other steps. " +
        "Note: Effect.sleep() is allowed inside steps for regular delays."
    );
    this.name = "StepScopeError";
    this.operation = opts.operation;
    this.stepName = opts.stepName;
  }
}

/**
 * Guard that rejects workflow-level operations when inside a step.
 *
 * Use this at the start of workflow primitives like Workflow.sleep()
 * and Workflow.step() to prevent them from being called within a step.
 *
 * @param operationName - The name of the operation being guarded (e.g., "Workflow.sleep")
 */
export const guardWorkflowOperation = (
  operationName: string
): Effect.Effect<void, StepScopeError> =>
  Effect.flatMap(Effect.serviceOption(StepScope), (option) =>
    Option.isNone(option)
      ? Effect.void
      : Effect.fail(
          new StepScopeError({
            operation: operationName,
            stepName: option.value.stepName,
          })
        )
  );

/**
 * Alias for guardWorkflowOperation.
 * Use inside workflow primitives to reject calls from within steps.
 */
export const rejectInsideStep = guardWorkflowOperation;
