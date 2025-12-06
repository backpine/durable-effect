import { Context, Effect, Option } from "effect";
import { UnknownException } from "effect/Cause";
import type { WorkflowStatus } from "@/types";
import {
  storageGet,
  storagePut,
  storagePutBatch,
  storageDelete,
} from "./storage-utils";

/**
 * Workflow-level context service interface.
 */
export interface WorkflowContextService {
  /** Unique identifier for this workflow instance */
  readonly workflowId: string;

  /** Name of the currently executing workflow */
  readonly workflowName: string;

  /** Input passed to the workflow */
  readonly input: unknown;

  /** Optional user-provided execution ID for correlation (persists across lifecycle) */
  readonly executionId: string | undefined;

  /** Get workflow-level metadata */
  readonly getMeta: <T>(
    key: string,
  ) => Effect.Effect<Option.Option<T>, UnknownException>;

  /** Set workflow-level metadata */
  readonly setMeta: <T>(
    key: string,
    value: T,
  ) => Effect.Effect<void, UnknownException>;

  /** Get list of completed step names */
  readonly completedSteps: Effect.Effect<ReadonlyArray<string>, UnknownException>;

  /** Get current workflow status */
  readonly status: Effect.Effect<WorkflowStatus, UnknownException>;

  /** Check if a step has completed */
  readonly hasCompleted: (
    stepName: string,
  ) => Effect.Effect<boolean, UnknownException>;

  // ============================================================
  // Pause Point Tracking
  // ============================================================

  /**
   * Get the next pause index (increments internal counter).
   * The counter resets each workflow execution.
   */
  readonly nextPauseIndex: Effect.Effect<number, never>;

  /**
   * Get the completed pause index from storage.
   * This is the highest pause point index that has completed.
   */
  readonly completedPauseIndex: Effect.Effect<number, UnknownException>;

  /**
   * Set the completed pause index.
   */
  readonly setCompletedPauseIndex: (
    index: number,
  ) => Effect.Effect<void, UnknownException>;

  /**
   * Get the pending resume timestamp (when the current pause should resume).
   */
  readonly pendingResumeAt: Effect.Effect<Option.Option<number>, UnknownException>;

  /**
   * Set the pending resume timestamp.
   */
  readonly setPendingResumeAt: (
    time: number,
  ) => Effect.Effect<void, UnknownException>;

  /**
   * Clear the pending resume timestamp.
   */
  readonly clearPendingResumeAt: Effect.Effect<void, UnknownException>;
}

/**
 * Workflow-level context.
 * Available throughout the entire workflow execution.
 */
export class WorkflowContext extends Context.Tag("Workflow/Context")<
  WorkflowContext,
  WorkflowContextService
>() {}

/**
 * Storage key for workflow data.
 */
const workflowKey = (suffix: string) => `workflow:${suffix}`;

/**
 * Create a WorkflowContext service for a workflow execution.
 *
 * @param workflowId - Durable Object ID
 * @param workflowName - Workflow definition name
 * @param input - Input passed to the workflow
 * @param storage - Durable Object storage
 * @param executionId - Optional user-provided ID for correlation (persists across lifecycle)
 */
export function createWorkflowContext(
  workflowId: string,
  workflowName: string,
  input: unknown,
  storage: DurableObjectStorage,
  executionId?: string,
): WorkflowContextService {
  // Runtime pause counter - resets each workflow execution
  let pauseCounter = 0;

  return {
    workflowId,
    workflowName,
    input,
    executionId,

    getMeta: <T>(key: string) =>
      storageGet<T>(storage, workflowKey(`meta:${key}`)).pipe(
        Effect.map((value) =>
          value !== undefined ? Option.some(value) : Option.none<T>(),
        ),
        Effect.mapError((e) => new UnknownException(e)),
      ),

    setMeta: <T>(key: string, value: T) =>
      storagePut(storage, workflowKey(`meta:${key}`), value).pipe(
        Effect.mapError((e) => new UnknownException(e)),
      ),

    completedSteps: storageGet<string[]>(
      storage,
      workflowKey("completedSteps"),
    ).pipe(
      Effect.map((steps) => steps ?? []),
      Effect.mapError((e) => new UnknownException(e)),
    ),

    status: storageGet<WorkflowStatus>(storage, workflowKey("status")).pipe(
      Effect.map((status) => status ?? { _tag: "Pending" as const }),
      Effect.mapError((e) => new UnknownException(e)),
    ),

    hasCompleted: (stepName: string) =>
      storageGet<string[]>(storage, workflowKey("completedSteps")).pipe(
        Effect.map((steps) => steps?.includes(stepName) ?? false),
        Effect.mapError((e) => new UnknownException(e)),
      ),

    // ============================================================
    // Pause Point Tracking
    // ============================================================

    nextPauseIndex: Effect.sync(() => ++pauseCounter),

    completedPauseIndex: storageGet<number>(
      storage,
      workflowKey("completedPauseIndex"),
    ).pipe(
      Effect.map((n) => n ?? 0),
      Effect.mapError((e) => new UnknownException(e)),
    ),

    setCompletedPauseIndex: (index: number) =>
      storagePut(storage, workflowKey("completedPauseIndex"), index).pipe(
        Effect.mapError((e) => new UnknownException(e)),
      ),

    pendingResumeAt: storageGet<number>(
      storage,
      workflowKey("pendingResumeAt"),
    ).pipe(
      Effect.map((t) =>
        t !== undefined ? Option.some(t) : Option.none<number>(),
      ),
      Effect.mapError((e) => new UnknownException(e)),
    ),

    setPendingResumeAt: (time: number) =>
      storagePut(storage, workflowKey("pendingResumeAt"), time).pipe(
        Effect.mapError((e) => new UnknownException(e)),
      ),

    clearPendingResumeAt: storageDelete(
      storage,
      workflowKey("pendingResumeAt"),
    ).pipe(
      Effect.asVoid,
      Effect.mapError((e) => new UnknownException(e)),
    ),
  };
}

/**
 * Set workflow status in storage.
 */
export function setWorkflowStatus(
  storage: DurableObjectStorage,
  status: WorkflowStatus,
): Effect.Effect<void, UnknownException> {
  return storagePut(storage, workflowKey("status"), status).pipe(
    Effect.mapError((e) => new UnknownException(e)),
  );
}

/**
 * Store workflow metadata (name, input, and executionId) in storage.
 *
 * @param storage - Durable Object storage
 * @param workflowName - Workflow definition name
 * @param input - Input passed to the workflow
 * @param executionId - Optional user-provided ID for correlation
 */
export function storeWorkflowMeta(
  storage: DurableObjectStorage,
  workflowName: string,
  input: unknown,
  executionId?: string,
): Effect.Effect<void, UnknownException> {
  return storagePutBatch(storage, {
    [workflowKey("name")]: workflowName,
    [workflowKey("input")]: input,
    [workflowKey("executionId")]: executionId,
  }).pipe(Effect.mapError((e) => new UnknownException(e)));
}

/**
 * Load workflow metadata from storage.
 * Returns workflowName, input, and executionId (if stored).
 */
export function loadWorkflowMeta(
  storage: DurableObjectStorage,
): Effect.Effect<
  { workflowName: string | undefined; input: unknown; executionId: string | undefined },
  UnknownException
> {
  return Effect.all({
    workflowName: storageGet<string>(storage, workflowKey("name")),
    input: storageGet<unknown>(storage, workflowKey("input")),
    executionId: storageGet<string>(storage, workflowKey("executionId")),
  }).pipe(Effect.mapError((e) => new UnknownException(e)));
}
