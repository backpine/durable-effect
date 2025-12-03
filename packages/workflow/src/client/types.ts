import type { Context, Effect } from "effect";
import type {
  WorkflowRegistry,
  WorkflowInput,
  WorkflowStatus,
  DurableWorkflowInstance,
} from "@/types";

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
 * Extensible for future features like concurrency control, buffering, etc.
 */
export interface ExecutionOptions {
  /**
   * Custom instance ID suffix. The final ID will be `{workflow}:{id}`.
   * If not provided, a random UUID is generated.
   */
  readonly id?: string;

  // Future options:
  // readonly concurrency?: { key: string; max: number };
  // readonly buffer?: { strategy: "latest" | "queue" };
}

/**
 * Type-safe workflow run request.
 * Uses discriminated union so `workflow` determines the `input` type.
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
  fromBinding(
    binding: DurableObjectNamespace<DurableWorkflowInstance<W>>,
  ): WorkflowClientInstance<W>;

  /**
   * Effect Tag for service pattern usage.
   */
  Tag: Context.Tag<WorkflowClientInstance<W>, WorkflowClientInstance<W>>;
}
