// packages/workflow/src/engine/types.ts

import type { WorkflowRegistry, WorkflowCall } from "../orchestrator/types";
import type { WorkflowStatus } from "../state/types";
import type { HttpBatchTrackerConfig } from "@durable-effect/core";
import type { RecoveryConfig } from "../recovery/config";
import type { WorkflowClientFactory } from "../client/types";
import type { PurgeConfig } from "../purge/config";

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

  /**
   * Automatic data purging configuration.
   * When provided, workflow data is deleted after terminal states (completed, failed, cancelled).
   * Omit to retain data indefinitely.
   *
   * @example
   * ```ts
   * // Enable purge with default 60 second delay
   * purge: {}
   *
   * // Enable purge with custom delay
   * purge: { delay: "5 minutes" }
   * ```
   */
  readonly purge?: PurgeConfig;
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
      env: unknown,
    ): DurableWorkflowEngineInterface<W>;
  };

  /**
   * Factory for creating type-safe workflow clients.
   */
  readonly WorkflowClient: WorkflowClientFactory<W>;
}

/**
 * Public interface of the Durable Workflow Engine.
 * This is the RPC interface exposed by the Durable Object.
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
