// packages/workflow/src/primitives/make.ts

import { Effect, type Types } from "effect";
import type { StorageError } from "../errors";
import type { PauseSignal } from "./pause-signal";

// =============================================================================
// Types
// =============================================================================

/**
 * A workflow definition.
 *
 * This is the type-safe container for a workflow's execution logic.
 * Created with Workflow.make().
 *
 * The workflow name comes from the registry key, not from the definition itself.
 */
export interface WorkflowDefinition<Input, Output, Error, Requirements> {
  /**
   * Marker tag for workflow definitions.
   */
  readonly _tag: "WorkflowDefinition";

  /**
   * Execute the workflow.
   *
   * This runs the workflow effect and returns the result.
   * Should only be called by the executor.
   */
  readonly execute: (
    input: Input,
  ) => Effect.Effect<Output, Error | PauseSignal | StorageError, Requirements>;

  /**
   * Type witnesses for inference.
   */
  readonly _Input: Types.Covariant<Input>;
  readonly _Output: Types.Covariant<Output>;
  readonly _Error: Types.Covariant<Error>;
}

/**
 * The workflow effect signature.
 */
export type WorkflowEffect<Input, Output, Error, Requirements> = (
  input: Input,
) => Effect.Effect<Output, Error | PauseSignal | StorageError, Requirements>;

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a workflow definition.
 *
 * The workflow name is determined by the key in the workflow registry,
 * not by the definition itself. This eliminates name duplication.
 *
 * @example
 * ```ts
 * // Define the workflow
 * const processOrder = Workflow.make((input: { orderId: string }) =>
 *   Effect.gen(function* () {
 *     const order = yield* Workflow.step("fetchOrder",
 *       fetchOrder(input.orderId)
 *     );
 *
 *     yield* Workflow.sleep("1 hour");
 *
 *     const result = yield* Workflow.step("processPayment",
 *       processPayment(order)
 *     );
 *
 *     return result;
 *   })
 * );
 *
 * // Register with a name (the key becomes the workflow name)
 * const workflows = {
 *   processOrder,  // workflow name is "processOrder"
 * } as const;
 *
 * export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows);
 * ```
 */
export function make<Input, Output, Error, Requirements>(
  execute: WorkflowEffect<Input, Output, Error, Requirements>,
): WorkflowDefinition<Input, Output, Error, Requirements> {
  return {
    _tag: "WorkflowDefinition",
    execute,
    // Type witnesses - runtime value is never used, only type information matters
    _Input: undefined as unknown as Types.Covariant<Input>,
    _Output: undefined as unknown as Types.Covariant<Output>,
    _Error: undefined as unknown as Types.Covariant<Error>,
  };
}

/**
 * Extract input type from a workflow definition.
 */
export type WorkflowInput<W> =
  W extends WorkflowDefinition<infer I, any, any, any> ? I : never;

/**
 * Extract output type from a workflow definition.
 */
export type WorkflowOutput<W> =
  W extends WorkflowDefinition<any, infer O, any, any> ? O : never;

/**
 * Extract error type from a workflow definition.
 */
export type WorkflowError<W> =
  W extends WorkflowDefinition<any, any, infer E, any> ? E : never;

/**
 * Extract requirements type from a workflow definition.
 */
export type WorkflowRequirements<W> =
  W extends WorkflowDefinition<any, any, any, infer R> ? R : never;
