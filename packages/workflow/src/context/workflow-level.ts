// packages/workflow-v2/src/context/workflow-level.ts

import { Context, Layer } from "effect";

/**
 * Marker service that indicates we're at the workflow level (not inside a step).
 *
 * This enables compile-time checking to prevent using workflow primitives
 * (step, sleep, retry, timeout) inside a step.
 *
 * How it works:
 * 1. Workflow primitives require WorkflowLevel in their Effect requirements
 * 2. step() provides services to its inner effect but NOT WorkflowLevel
 * 3. If you try to use sleep/step/etc inside a step, TypeScript errors because
 *    WorkflowLevel is required but not provided
 * 4. At the workflow execution level, WorkflowLevel IS provided
 *
 * This gives compile-time safety in addition to the existing runtime checks.
 */
export interface WorkflowLevelService {
  readonly _brand: "workflow-level";
}

/**
 * Effect service tag for WorkflowLevel.
 *
 * Required by: Workflow.step, Workflow.sleep, Workflow.retry, Workflow.timeout
 * Provided by: Workflow executor (at workflow level)
 * NOT provided by: step() to its inner effect
 */
export class WorkflowLevel extends Context.Tag("@durable-effect/WorkflowLevel")<
  WorkflowLevel,
  WorkflowLevelService
>() {}

/**
 * Layer that provides WorkflowLevel.
 * Used by the executor when running workflows.
 */
export const WorkflowLevelLayer = Layer.succeed(WorkflowLevel, {
  _brand: "workflow-level",
});
