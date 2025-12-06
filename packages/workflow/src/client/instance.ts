import { Effect } from "effect";
import type {
  WorkflowRegistry,
  DurableWorkflowInstance,
  CancelOptions,
  CancelResult,
} from "@/types";
import type {
  WorkflowClientInstance,
  WorkflowRunRequest,
  WorkflowRunResult,
} from "./types";
import { WorkflowClientError } from "./types";

/**
 * Create a workflow client instance from a binding.
 */
export function createClientInstance<W extends WorkflowRegistry>(
  binding: DurableObjectNamespace<DurableWorkflowInstance<W>>,
): WorkflowClientInstance<W> {
  /**
   * Resolve the full instance ID, always namespaced by workflow name.
   *
   * ID Format: `{workflow}:{identifier}`
   *
   * This namespacing ensures:
   * 1. Different workflows can use the same user-provided ID without collision
   * 2. IDs are always deterministic and predictable
   * 3. Query methods (status, completedSteps, meta) work with the same ID format
   */
  const resolveInstanceId = (workflow: string, providedId?: string): string => {
    // Always prepend workflow name for namespacing
    if (providedId) {
      return `${workflow}:${providedId}`;
    }

    // No ID provided - generate random UUID
    const uniqueId = crypto.randomUUID();
    return `${workflow}:${uniqueId}`;
  };

  /**
   * Get stub from instance ID string.
   * Always uses idFromName - the instanceId is the full namespaced string.
   */
  const getStub = (instanceId: string) => {
    const id = binding.idFromName(instanceId);
    return binding.get(id);
  };

  return {
    run(
      request: WorkflowRunRequest<W>,
    ): Effect.Effect<WorkflowRunResult, WorkflowClientError> {
      return Effect.tryPromise({
        try: async () => {
          const { workflow, input, execution } = request;
          const instanceId = resolveInstanceId(workflow, execution?.id);
          const stub = getStub(instanceId);
          await stub.run({
            workflow,
            input,
            executionId: execution?.id,
          } as Parameters<typeof stub.run>[0]);
          return { id: instanceId };
        },
        catch: (e) => new WorkflowClientError("run", e),
      });
    },

    runAsync(
      request: WorkflowRunRequest<W>,
    ): Effect.Effect<WorkflowRunResult, WorkflowClientError> {
      return Effect.tryPromise({
        try: async () => {
          const { workflow, input, execution } = request;
          const instanceId = resolveInstanceId(workflow, execution?.id);
          const stub = getStub(instanceId);
          await stub.runAsync({
            workflow,
            input,
            executionId: execution?.id,
          } as Parameters<typeof stub.runAsync>[0]);
          return { id: instanceId };
        },
        catch: (e) => new WorkflowClientError("runAsync", e),
      });
    },

    cancel(
      instanceId: string,
      options?: CancelOptions,
    ): Effect.Effect<CancelResult, WorkflowClientError> {
      return Effect.tryPromise({
        try: async () => {
          const stub = getStub(instanceId);
          return stub.cancel(options);
        },
        catch: (e) => new WorkflowClientError("cancel", e),
      });
    },

    status(instanceId: string) {
      return Effect.tryPromise({
        try: async () => {
          const stub = getStub(instanceId);
          return stub.getStatus();
        },
        catch: (e) => new WorkflowClientError("status", e),
      });
    },

    completedSteps(instanceId: string) {
      return Effect.tryPromise({
        try: async () => {
          const stub = getStub(instanceId);
          return stub.getCompletedSteps();
        },
        catch: (e) => new WorkflowClientError("completedSteps", e),
      });
    },

    meta<T>(instanceId: string, key: string) {
      return Effect.tryPromise({
        try: async () => {
          const stub = getStub(instanceId);
          return stub.getMeta(key) as Promise<T | undefined>;
        },
        catch: (e) => new WorkflowClientError("meta", e),
      });
    },
  };
}
