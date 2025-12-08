// packages/workflow-v2/src/engine/types.ts

import type { WorkflowRegistry, WorkflowCall } from "../orchestrator/types";
import type { WorkflowStatus } from "../state/types";
import type { HttpBatchTrackerConfig } from "../tracker/http-batch";
import type { RecoveryConfig } from "../recovery/config";

/**
 * Options for creating durable workflows.
 */
export interface CreateDurableWorkflowsOptions {
  /**
   * Event tracker configuration.
   * If not provided, no events are emitted.
   */
  readonly tracker?: HttpBatchTrackerConfig;

  /**
   * Recovery configuration.
   * Uses defaults if not provided.
   */
  readonly recovery?: Partial<RecoveryConfig>;
}

/**
 * Result of createDurableWorkflows factory.
 */
export interface CreateDurableWorkflowsResult<W extends WorkflowRegistry> {
  /**
   * The Durable Object class to export.
   */
  readonly Workflows: {
    new (
      state: DurableObjectState,
      env: unknown
    ): DurableWorkflowEngineInterface<W>;
  };

  /**
   * Factory for creating type-safe workflow clients.
   */
  readonly WorkflowClient: WorkflowClientFactory<W>;
}

/**
 * Public interface of the Durable Workflow Engine.
 */
export interface DurableWorkflowEngineInterface<W extends WorkflowRegistry> {
  /**
   * Start a workflow synchronously.
   */
  run(call: WorkflowCall<W>): Promise<{ id: string; completed: boolean }>;

  /**
   * Queue a workflow for async execution.
   */
  runAsync(call: WorkflowCall<W>): Promise<{ id: string }>;

  /**
   * Cancel a running workflow.
   */
  cancel(options?: { reason?: string }): Promise<{
    cancelled: boolean;
    reason?: string;
  }>;

  /**
   * Get current workflow status.
   */
  getStatus(): Promise<WorkflowStatus | undefined>;

  /**
   * Get completed step names.
   */
  getCompletedSteps(): Promise<readonly string[]>;

  /**
   * Get workflow metadata.
   */
  getMeta<T>(key: string): Promise<T | undefined>;
}

/**
 * Workflow client factory type.
 */
export interface WorkflowClientFactory<W extends WorkflowRegistry> {
  /**
   * Create a client from a Durable Object binding.
   */
  fromBinding(
    binding: DurableObjectNamespace,
    options?: { idFromName?: string; id?: DurableObjectId }
  ): WorkflowClientInstance<W>;
}

/**
 * Type-safe workflow client instance.
 */
export interface WorkflowClientInstance<W extends WorkflowRegistry> {
  /**
   * Start a workflow.
   */
  run(call: WorkflowCall<W>): Promise<{ id: string; completed: boolean }>;

  /**
   * Queue a workflow.
   */
  runAsync(call: WorkflowCall<W>): Promise<{ id: string }>;

  /**
   * Cancel a workflow.
   */
  cancel(options?: { reason?: string }): Promise<{
    cancelled: boolean;
    reason?: string;
  }>;

  /**
   * Get status.
   */
  getStatus(): Promise<WorkflowStatus | undefined>;

  /**
   * Get the workflow instance ID.
   */
  readonly id: string;
}
