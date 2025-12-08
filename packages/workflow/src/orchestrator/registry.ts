// packages/workflow/src/orchestrator/registry.ts

import { Context, Effect, Layer } from "effect";
import type { WorkflowDefinition } from "../primitives/make";
import type { WorkflowRegistry } from "./types";

/**
 * Error when workflow definition is not found.
 */
export class WorkflowNotFoundError extends Error {
  readonly _tag = "WorkflowNotFoundError";
  readonly workflowName: string;
  readonly availableWorkflows: ReadonlyArray<string>;

  constructor(workflowName: string, availableWorkflows: ReadonlyArray<string>) {
    super(
      `Workflow "${workflowName}" not found. Available: [${availableWorkflows.join(", ")}]`,
    );
    this.name = "WorkflowNotFoundError";
    this.workflowName = workflowName;
    this.availableWorkflows = availableWorkflows;
  }
}

/**
 * WorkflowRegistryService interface.
 */
export interface WorkflowRegistryService<W extends WorkflowRegistry> {
  /**
   * Get a workflow definition by name.
   */
  readonly get: (
    name: string,
  ) => Effect.Effect<
    WorkflowDefinition<any, any, any, any>,
    WorkflowNotFoundError
  >;

  /**
   * List all available workflow names.
   */
  readonly list: () => ReadonlyArray<string>;

  /**
   * Check if a workflow exists.
   */
  readonly has: (name: string) => boolean;
}

/**
 * Effect service tag for WorkflowRegistry.
 */
export class WorkflowRegistryTag extends Context.Tag(
  "@durable-effect/WorkflowRegistry",
)<WorkflowRegistryTag, WorkflowRegistryService<any>>() {}

/**
 * Create a workflow registry from a workflows object.
 */
export function createWorkflowRegistry<W extends WorkflowRegistry>(
  workflows: W,
): WorkflowRegistryService<W> {
  const names = Object.keys(workflows);

  return {
    get: (name: string) => {
      const workflow = workflows[name];
      if (!workflow) {
        return Effect.fail(new WorkflowNotFoundError(name, names));
      }
      return Effect.succeed(workflow);
    },

    list: () => names,

    has: (name: string) => name in workflows,
  };
}

/**
 * Create a registry layer.
 */
export const WorkflowRegistryLayer = <W extends WorkflowRegistry>(
  workflows: W,
) => Layer.succeed(WorkflowRegistryTag, createWorkflowRegistry(workflows));
