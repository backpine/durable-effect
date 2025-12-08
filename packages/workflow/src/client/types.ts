// packages/workflow/src/client/types.ts

import type { Context, Effect } from "effect";
import type { WorkflowRegistry } from "../orchestrator/types";
import type { WorkflowStatus } from "../state/types";
import type { WorkflowInput } from "../primitives/make";

/**
 * Error thrown by workflow client operations.
 */
export class WorkflowClientError extends Error {
  readonly _tag = "WorkflowClientError";

  constructor(
    readonly operation: string,
    readonly cause: unknown,
  ) {
    super(
      `Workflow client ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "WorkflowClientError";
  }
}

/**
 * Result from starting a workflow.
 */
export interface WorkflowRunResult {
  readonly id: string;
}

/**
 * Execution options for controlling workflow instance behavior.
 */
export interface ExecutionOptions {
  /**
   * Custom instance ID suffix. The final ID will be `{workflow}:{id}`.
   * If not provided, a random UUID is generated.
   */
  readonly id?: string;
}

/**
 * Options for cancelling a workflow.
 */
export interface CancelOptions {
  readonly reason?: string;
}

/**
 * Result of a cancel operation.
 */
export interface CancelResult {
  readonly cancelled: boolean;
  readonly reason?: string;
}

/**
 * Type-safe workflow run request.
 * The `workflow` field determines the `input` type.
 */
export type WorkflowRunRequest<W extends WorkflowRegistry> = {
  [K in keyof W & string]: {
    readonly workflow: K;
    readonly input: WorkflowInput<W[K]>;
    readonly execution?: ExecutionOptions;
  };
}[keyof W & string];

/**
 * A workflow client instance with type-safe operations.
 * All methods return Effects, making them yieldable.
 */
export interface WorkflowClientInstance<W extends WorkflowRegistry> {
  /**
   * Run workflow synchronously (blocks until complete/pause/fail).
   */
  run(
    request: WorkflowRunRequest<W>,
  ): Effect.Effect<WorkflowRunResult, WorkflowClientError>;

  /**
   * Run workflow asynchronously (returns immediately).
   */
  runAsync(
    request: WorkflowRunRequest<W>,
  ): Effect.Effect<WorkflowRunResult, WorkflowClientError>;

  /**
   * Cancel a workflow by instance ID.
   */
  cancel(
    instanceId: string,
    options?: CancelOptions,
  ): Effect.Effect<CancelResult, WorkflowClientError>;

  /**
   * Get workflow status by instance ID.
   */
  status(
    instanceId: string,
  ): Effect.Effect<WorkflowStatus | undefined, WorkflowClientError>;

  /**
   * Get completed steps by instance ID.
   */
  completedSteps(
    instanceId: string,
  ): Effect.Effect<ReadonlyArray<string>, WorkflowClientError>;

  /**
   * Get workflow metadata by instance ID.
   */
  meta<T>(
    instanceId: string,
    key: string,
  ): Effect.Effect<T | undefined, WorkflowClientError>;
}

/**
 * Factory for creating workflow client instances.
 */
export interface WorkflowClientFactory<W extends WorkflowRegistry> {
  /**
   * Create a client instance from a Durable Object binding.
   */
  fromBinding(binding: DurableObjectNamespace): WorkflowClientInstance<W>;

  /**
   * Effect Tag for service pattern usage.
   */
  Tag: Context.Tag<WorkflowClientInstance<W>, WorkflowClientInstance<W>>;
}
