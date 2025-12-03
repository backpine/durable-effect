import { Context } from "effect";
import type { WorkflowRegistry, DurableWorkflowInstance } from "@/types";
import type { WorkflowClientFactory, WorkflowClientInstance } from "./types";
import { createClientInstance } from "./instance";

/**
 * Create a workflow client factory for a specific workflow registry.
 */
export function createWorkflowClientFactory<
  W extends WorkflowRegistry,
>(): WorkflowClientFactory<W> {
  // Create the Effect Tag for service pattern
  const Tag = Context.GenericTag<WorkflowClientInstance<W>>("WorkflowClient");

  return {
    fromBinding(
      binding: DurableObjectNamespace<DurableWorkflowInstance<W>>,
    ): WorkflowClientInstance<W> {
      return createClientInstance(binding);
    },

    Tag,
  };
}
