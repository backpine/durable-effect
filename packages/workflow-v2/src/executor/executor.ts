// packages/workflow-v2/src/executor/executor.ts

import { Context, Effect, Layer, Exit, Cause, Option } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { SchedulerAdapter, type SchedulerAdapterService } from "../adapters/scheduler";
import { RuntimeAdapter } from "../adapters/runtime";
import { WorkflowStateMachine } from "../state/machine";
import { WorkflowContextLayer } from "../context/workflow-context";
import { WorkflowScopeLayer } from "../context/workflow-scope";
import { OrchestratorError, SchedulerError } from "../errors";
import { PauseSignal, isPauseSignal } from "../primitives/pause-signal";
import { StepCancelledError } from "../primitives/step";
import type { WorkflowDefinition } from "../primitives/make";
import type { ExecutionResult, ExecutionContext } from "./types";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * WorkflowExecutor service interface.
 *
 * Executes workflow definitions and returns structured results.
 */
export interface WorkflowExecutorService {
  /**
   * Execute a workflow definition.
   *
   * @param definition - The workflow definition to execute
   * @param context - Execution context (id, input, mode)
   * @returns Execution result (completed, paused, failed, cancelled)
   */
  readonly execute: <Input, Output, Error, Requirements>(
    definition: WorkflowDefinition<Input, Output, Error, Requirements>,
    context: ExecutionContext
  ) => Effect.Effect<
    ExecutionResult<Output>,
    OrchestratorError,
    StorageAdapter | SchedulerAdapter | RuntimeAdapter | WorkflowStateMachine | Requirements
  >;
}

/**
 * Effect service tag for WorkflowExecutor.
 */
export class WorkflowExecutor extends Context.Tag(
  "@durable-effect/WorkflowExecutor"
)<WorkflowExecutor, WorkflowExecutorService>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create the WorkflowExecutor service implementation.
 */
export const createWorkflowExecutor = Effect.gen(function* () {
  const service: WorkflowExecutorService = {
    execute: <Input, Output, Error, Requirements>(
      definition: WorkflowDefinition<Input, Output, Error, Requirements>,
      context: ExecutionContext
    ) =>
      Effect.gen(function* () {
        const storage = yield* StorageAdapter;
        const scheduler = yield* SchedulerAdapter;
        const runtime = yield* RuntimeAdapter;
        const stateMachine = yield* WorkflowStateMachine;

        // Record start time
        const startedAt = yield* runtime.now();
        yield* storage.put("workflow:startedAt", startedAt);

        // Reset current pause index for this execution run
        // This ensures pause points are encountered in the same order on replay
        yield* storage.put("workflow:currentPauseIndex", 0);

        // Create execution layer with all context services
        // We need to provide:
        // - WorkflowScope (marks we're in a workflow)
        // - WorkflowContext (workflow-level state access)
        // - StorageAdapter, RuntimeAdapter (for primitives/steps to use)
        const adapterLayer = Layer.mergeAll(
          Layer.succeed(StorageAdapter, storage),
          Layer.succeed(RuntimeAdapter, runtime)
        );

        const executionLayer = WorkflowScopeLayer.pipe(
          Layer.provideMerge(WorkflowContextLayer),
          Layer.provideMerge(adapterLayer)
        );

        // Execute the workflow
        const exit = yield* definition
          .execute(context.input as Input)
          .pipe(
            Effect.provide(executionLayer),
            Effect.exit
          );

        // Calculate duration
        const completedAt = yield* runtime.now();
        const durationMs = completedAt - startedAt;

        // Get completed steps
        const completedSteps = yield* stateMachine.getCompletedSteps();

        // Handle exit
        return yield* handleExit<Output>(
          exit,
          durationMs,
          completedSteps,
          scheduler
        );
      }).pipe(
        Effect.catchAll((error) =>
          Effect.fail(
            new OrchestratorError({
              operation: "execute",
              cause: error,
            })
          )
        )
      ),
  };

  return service;
});

/**
 * Handle workflow exit and produce execution result.
 */
function handleExit<Output>(
  exit: Exit.Exit<Output, unknown>,
  durationMs: number,
  completedSteps: ReadonlyArray<string>,
  scheduler: SchedulerAdapterService
): Effect.Effect<ExecutionResult<Output>, SchedulerError, never> {
  return Effect.gen(function* () {
    if (Exit.isSuccess(exit)) {
      // Workflow completed successfully
      return {
        _tag: "Completed" as const,
        output: exit.value,
        durationMs,
        completedSteps,
      };
    }

    // Handle failure
    const failure = exit.cause;

    // Check for PauseSignal (not a real failure)
    const pauseSignal = findPauseSignal(failure);
    if (pauseSignal) {
      // Schedule alarm for resume
      yield* scheduler.schedule(pauseSignal.resumeAt);

      return {
        _tag: "Paused" as const,
        reason: pauseSignal.reason,
        resumeAt: pauseSignal.resumeAt,
        stepName: pauseSignal.stepName,
        attempt: pauseSignal.attempt,
      };
    }

    // Check for cancellation
    const cancelError = findCancelError(failure);
    if (cancelError) {
      return {
        _tag: "Cancelled" as const,
        reason: cancelError.stepName,
        completedSteps,
      };
    }

    // Real failure
    const error = Cause.failureOption(failure);
    return {
      _tag: "Failed" as const,
      error: Option.getOrElse(error, () => Cause.squash(failure)),
      durationMs,
      completedSteps,
    };
  });
}

/**
 * Find PauseSignal in a cause chain.
 */
function findPauseSignal(cause: Cause.Cause<unknown>): PauseSignal | undefined {
  // Check direct failure
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure) && isPauseSignal(failure.value)) {
    return failure.value;
  }

  // Check sequential causes
  if (cause._tag === "Sequential") {
    for (const c of [cause.left, cause.right]) {
      const found = findPauseSignal(c);
      if (found) return found;
    }
  }

  // Check parallel causes
  if (cause._tag === "Parallel") {
    for (const c of [cause.left, cause.right]) {
      const found = findPauseSignal(c);
      if (found) return found;
    }
  }

  return undefined;
}

/**
 * Find StepCancelledError in a cause chain.
 */
function findCancelError(
  cause: Cause.Cause<unknown>
): StepCancelledError | undefined {
  const failure = Cause.failureOption(cause);
  if (
    Option.isSome(failure) &&
    failure.value instanceof StepCancelledError
  ) {
    return failure.value;
  }

  if (cause._tag === "Sequential") {
    for (const c of [cause.left, cause.right]) {
      const found = findCancelError(c);
      if (found) return found;
    }
  }

  if (cause._tag === "Parallel") {
    for (const c of [cause.left, cause.right]) {
      const found = findCancelError(c);
      if (found) return found;
    }
  }

  return undefined;
}

/**
 * Layer that provides WorkflowExecutor.
 */
export const WorkflowExecutorLayer = Layer.effect(
  WorkflowExecutor,
  createWorkflowExecutor
);
