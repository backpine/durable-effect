import { Context } from "effect";

/**
 * WorkflowScope is required by workflow primitives (step, sleep).
 * This scope is NOT available inside a step's effect, preventing nesting.
 *
 * The workflow engine provides this scope at the top level.
 * The `step` function's inner effect parameter uses `ForbidWorkflowScope<R>`
 * to reject effects that require WorkflowScope.
 *
 * @internal This is a compile-time guard, not a runtime service.
 */
export class WorkflowScope extends Context.Tag("@durable-effect/WorkflowScope")<
  WorkflowScope,
  { readonly _brand: "WorkflowScope" }
>() {}

/**
 * Type-level guard that forbids WorkflowScope in R.
 * If R includes WorkflowScope, this evaluates to `never`.
 *
 * @example
 * ```typescript
 * // R = WorkflowScope | WorkflowContext → never (forbidden)
 * // R = WorkflowContext → WorkflowContext (allowed)
 * // R = never → never (allowed, no requirements)
 * ```
 */
export type ForbidWorkflowScope<R> = WorkflowScope extends R ? never : R;
