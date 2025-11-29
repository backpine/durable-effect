import { Context, Effect, Option } from "effect";
import { UnknownException } from "effect/Cause";
import type { WorkflowStatus } from "@/types";

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

  /** Get workflow-level metadata */
  readonly getMeta: <T>(key: string) => Effect.Effect<Option.Option<T>, UnknownException>;

  /** Set workflow-level metadata */
  readonly setMeta: <T>(key: string, value: T) => Effect.Effect<void, UnknownException>;

  /** Get list of completed step names */
  readonly completedSteps: Effect.Effect<ReadonlyArray<string>, UnknownException>;

  /** Get current workflow status */
  readonly status: Effect.Effect<WorkflowStatus, UnknownException>;

  /** Check if a step has completed */
  readonly hasCompleted: (stepName: string) => Effect.Effect<boolean, UnknownException>;
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
 */
export function createWorkflowContext(
  workflowId: string,
  workflowName: string,
  input: unknown,
  storage: DurableObjectStorage,
): WorkflowContextService {
  return {
    workflowId,
    workflowName,
    input,

    getMeta: <T>(key: string) =>
      Effect.tryPromise({
        try: () => storage.get<T>(workflowKey(`meta:${key}`)),
        catch: (e) => new UnknownException(e),
      }).pipe(
        Effect.map((value) =>
          value !== undefined ? Option.some(value) : Option.none<T>(),
        ),
      ),

    setMeta: <T>(key: string, value: T) =>
      Effect.tryPromise({
        try: () => storage.put(workflowKey(`meta:${key}`), value),
        catch: (e) => new UnknownException(e),
      }),

    completedSteps: Effect.tryPromise({
      try: () => storage.get<string[]>(workflowKey("completedSteps")),
      catch: (e) => new UnknownException(e),
    }).pipe(Effect.map((steps) => steps ?? [])),

    status: Effect.tryPromise({
      try: () => storage.get<WorkflowStatus>(workflowKey("status")),
      catch: (e) => new UnknownException(e),
    }).pipe(
      Effect.map((status) => status ?? { _tag: "Pending" as const }),
    ),

    hasCompleted: (stepName: string) =>
      Effect.tryPromise({
        try: () => storage.get<string[]>(workflowKey("completedSteps")),
        catch: (e) => new UnknownException(e),
      }).pipe(Effect.map((steps) => steps?.includes(stepName) ?? false)),
  };
}

/**
 * Set workflow status in storage.
 */
export function setWorkflowStatus(
  storage: DurableObjectStorage,
  status: WorkflowStatus,
): Effect.Effect<void, UnknownException> {
  return Effect.tryPromise({
    try: () => storage.put(workflowKey("status"), status),
    catch: (e) => new UnknownException(e),
  });
}

/**
 * Store workflow metadata (name and input) in storage.
 */
export function storeWorkflowMeta(
  storage: DurableObjectStorage,
  workflowName: string,
  input: unknown,
): Effect.Effect<void, UnknownException> {
  return Effect.tryPromise({
    try: () =>
      storage.put({
        [workflowKey("name")]: workflowName,
        [workflowKey("input")]: input,
      }),
    catch: (e) => new UnknownException(e),
  });
}

/**
 * Load workflow metadata from storage.
 */
export function loadWorkflowMeta(
  storage: DurableObjectStorage,
): Effect.Effect<
  { workflowName: string | undefined; input: unknown },
  UnknownException
> {
  return Effect.tryPromise({
    try: async () => {
      const [workflowName, input] = await Promise.all([
        storage.get<string>(workflowKey("name")),
        storage.get<unknown>(workflowKey("input")),
      ]);
      return { workflowName, input };
    },
    catch: (e) => new UnknownException(e),
  });
}
