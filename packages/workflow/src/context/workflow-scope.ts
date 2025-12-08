// packages/workflow/src/context/workflow-scope.ts

import { Context, Effect, Layer, Option } from "effect";

/**
 * WorkflowScope is a compile-time guard that prevents nesting workflows.
 *
 * When a workflow is executing, WorkflowScope is present in the context.
 * Attempting to start another workflow from within one will fail at
 * compile time because the inner workflow would require WorkflowScope
 * to NOT be present.
 */
export interface WorkflowScopeService {
  /**
   * Marker that workflow scope is active.
   * The actual value doesn't matter - presence in context is what matters.
   */
  readonly _marker: "workflow-scope-active";
}

/**
 * Effect service tag for WorkflowScope.
 */
export class WorkflowScope extends Context.Tag("@durable-effect/WorkflowScope")<
  WorkflowScope,
  WorkflowScopeService
>() {}

/**
 * Layer that provides WorkflowScope.
 */
export const WorkflowScopeLayer = Layer.succeed(WorkflowScope, {
  _marker: "workflow-scope-active",
});

/**
 * Check if currently inside a workflow scope.
 * Returns Effect that succeeds with true if in scope, false otherwise.
 */
export const isInWorkflowScope: Effect.Effect<boolean> = Effect.map(
  Effect.serviceOption(WorkflowScope),
  Option.isSome,
);

/**
 * Error when workflow scope is required but not present.
 */
export class WorkflowScopeError extends Error {
  readonly _tag = "WorkflowScopeError";

  constructor(opts: { message: string }) {
    super(opts.message);
    this.name = "WorkflowScopeError";
  }
}

/**
 * Require workflow scope to be present.
 * Fails with descriptive error if not in a workflow.
 */
export const requireWorkflowScope: Effect.Effect<void, WorkflowScopeError> =
  Effect.flatMap(isInWorkflowScope, (inScope) =>
    inScope
      ? Effect.void
      : Effect.fail(
          new WorkflowScopeError({
            message:
              "Workflow primitives can only be used inside a workflow. " +
              "Did you forget to use Workflow.make()?",
          }),
        ),
  );
