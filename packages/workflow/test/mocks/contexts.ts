import { Effect, Option } from "effect";
import { UnknownException } from "effect/Cause";
import { ExecutionContext, type ExecutionContextService } from "@durable-effect/core";
import { WorkflowContext, type WorkflowContextService } from "@/services/workflow-context";
import { WorkflowScope } from "@/services/workflow-scope";
import type { WorkflowStatus } from "@/types";
import { MockStorage } from "./storage";

/**
 * WorkflowScope value for testing.
 */
export const testWorkflowScope = { _brand: "WorkflowScope" as const };

/**
 * Create a mock ExecutionContext service.
 */
export function createMockExecutionContext(
  storage: MockStorage,
): ExecutionContextService {
  return {
    storage: storage as unknown as DurableObjectStorage,
    setAlarm: (time: number) =>
      Effect.tryPromise({
        try: () => storage.setAlarm(time),
        catch: (e) => new UnknownException(e),
      }),
  };
}

/**
 * Create a mock WorkflowContext service.
 */
export function createMockWorkflowContext(
  storage: MockStorage,
  options: {
    workflowId?: string;
    workflowName?: string;
    input?: unknown;
    executionId?: string;
  } = {},
): WorkflowContextService {
  const {
    workflowId = "test-workflow-id",
    workflowName = "testWorkflow",
    input = {},
    executionId,
  } = options;

  // Runtime pause counter - resets each workflow execution
  let pauseCounter = 0;

  return {
    workflowId,
    workflowName,
    input,
    executionId,

    getMeta: <T>(key: string) =>
      Effect.tryPromise({
        try: () => storage.get<T>(`workflow:meta:${key}`),
        catch: (e) => new UnknownException(e),
      }).pipe(
        Effect.map((value) =>
          value !== undefined ? Option.some(value) : Option.none<T>(),
        ),
      ),

    setMeta: <T>(key: string, value: T) =>
      Effect.tryPromise({
        try: () => storage.put(`workflow:meta:${key}`, value),
        catch: (e) => new UnknownException(e),
      }),

    completedSteps: Effect.tryPromise({
      try: () => storage.get<string[]>("workflow:completedSteps"),
      catch: (e) => new UnknownException(e),
    }).pipe(Effect.map((steps) => steps ?? [])),

    status: Effect.tryPromise({
      try: () => storage.get<WorkflowStatus>("workflow:status"),
      catch: (e) => new UnknownException(e),
    }).pipe(
      Effect.map((status) => status ?? ({ _tag: "Pending" } as const)),
    ),

    hasCompleted: (stepName: string) =>
      Effect.tryPromise({
        try: () => storage.get<string[]>("workflow:completedSteps"),
        catch: (e) => new UnknownException(e),
      }).pipe(Effect.map((steps) => steps?.includes(stepName) ?? false)),

    // ============================================================
    // Pause Point Tracking
    // ============================================================

    nextPauseIndex: Effect.sync(() => ++pauseCounter),

    completedPauseIndex: Effect.tryPromise({
      try: () => storage.get<number>("workflow:completedPauseIndex"),
      catch: (e) => new UnknownException(e),
    }).pipe(Effect.map((n) => n ?? 0)),

    setCompletedPauseIndex: (index: number) =>
      Effect.tryPromise({
        try: () => storage.put("workflow:completedPauseIndex", index),
        catch: (e) => new UnknownException(e),
      }),

    pendingResumeAt: Effect.tryPromise({
      try: () => storage.get<number>("workflow:pendingResumeAt"),
      catch: (e) => new UnknownException(e),
    }).pipe(
      Effect.map((t) =>
        t !== undefined ? Option.some(t) : Option.none<number>(),
      ),
    ),

    setPendingResumeAt: (time: number) =>
      Effect.tryPromise({
        try: () => storage.put("workflow:pendingResumeAt", time),
        catch: (e) => new UnknownException(e),
      }),

    clearPendingResumeAt: Effect.tryPromise({
      try: () => storage.delete("workflow:pendingResumeAt"),
      catch: (e) => new UnknownException(e),
    }),
  };
}

/**
 * Options for creating a test context.
 */
export interface TestContextOptions {
  workflowId?: string;
  workflowName?: string;
  input?: unknown;
  seedData?: Record<string, unknown>;
}

/**
 * Create both contexts with a shared storage for testing.
 */
export function createTestContexts(options: TestContextOptions = {}) {
  const storage = new MockStorage();

  if (options.seedData) {
    storage.seed(options.seedData);
  }

  const executionContext = createMockExecutionContext(storage);
  const workflowContext = createMockWorkflowContext(storage, options);

  return {
    storage,
    executionContext,
    workflowContext,
  };
}

/**
 * Helper to run an effect with all workflow contexts provided.
 * Includes ExecutionContext, WorkflowContext, and WorkflowScope.
 */
export function provideTestContexts<T, E>(
  effect: Effect.Effect<T, E, ExecutionContext | WorkflowContext | WorkflowScope>,
  contexts: ReturnType<typeof createTestContexts>,
) {
  return effect.pipe(
    Effect.provideService(ExecutionContext, contexts.executionContext),
    Effect.provideService(WorkflowContext, contexts.workflowContext),
    Effect.provideService(WorkflowScope, testWorkflowScope),
  );
}
