// packages/workflow/src/primitives/step.ts

import { Effect, Layer, Option } from "effect";
import { createBaseEvent } from "@durable-effect/core";
import { WorkflowContext } from "../context/workflow-context";
import {
  StepContext,
  createStepContext,
  type StepResultMeta,
} from "../context/step-context";
import { WorkflowScope, WorkflowScopeError } from "../context/workflow-scope";
import { StepScope } from "../context/step-scope";
import { WorkflowLevel } from "../context/workflow-level";
import { StorageAdapter } from "../adapters/storage";
import { RuntimeAdapter } from "../adapters/runtime";
import { emitEvent } from "../tracker";
import type { StorageError } from "../errors";
import { isPauseSignal } from "./pause-signal";

// =============================================================================
// Types
// =============================================================================

/**
 * Error when a step is cancelled.
 */
export class StepCancelledError extends Error {
  readonly _tag = "StepCancelledError";
  readonly stepName: string;

  constructor(stepName: string) {
    super(`Step "${stepName}" was cancelled`);
    this.name = "StepCancelledError";
    this.stepName = stepName;
  }
}

// =============================================================================
// Step Implementation
// =============================================================================

/**
 * Execute a durable step within a workflow.
 *
 * Steps are the fundamental building blocks of durable workflows:
 * - Results are cached and returned on replay
 * - Each step has a unique name for identification
 * - Steps check for cancellation before executing
 * - Retry and timeout operators can be piped inside
 *
 * @param name - Unique name for this step within the workflow
 * @param effect - The effect to execute (can include piped operators)
 *
 * @example
 * ```ts
 * // Simple step
 * const result = yield* Workflow.step("fetchUser",
 *   Effect.tryPromise(() => fetch(`/api/users/${userId}`))
 * );
 *
 * // Step with retry
 * yield* Workflow.step("callAPI",
 *   callAPI().pipe(
 *     Workflow.retry({ maxAttempts: 5, delay: "5 seconds" })
 *   )
 * );
 *
 * // Step with timeout and retry
 * yield* Workflow.step("resilientCall",
 *   riskyOperation().pipe(
 *     Workflow.timeout("30 seconds"),
 *     Workflow.retry({ maxAttempts: 3 })
 *   )
 * );
 * ```
 */
export function step<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | StorageError | StepCancelledError | WorkflowScopeError,
  | WorkflowContext
  | StorageAdapter
  | RuntimeAdapter
  | WorkflowLevel
  | Exclude<R, StepContext | StorageAdapter | RuntimeAdapter | StepScope>
> {
  return Effect.gen(function* () {
    // Access WorkflowLevel to ensure this primitive can only be used at workflow level
    // This enables compile-time checking - if used inside a step, WorkflowLevel won't be available
    yield* WorkflowLevel;

    // Verify we're in a workflow scope
    const scope = yield* Effect.serviceOption(WorkflowScope);
    if (Option.isNone(scope)) {
      return yield* Effect.fail(
        new WorkflowScopeError({
          message: `Workflow.step("${name}") can only be used inside a workflow`,
        }),
      );
    }

    const workflowCtx = yield* WorkflowContext;
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    // -------------------------------------------------------------------------
    // Phase 1: Check for cancellation
    // -------------------------------------------------------------------------
    const isCancelled = yield* storage
      .get<boolean>("workflow:cancelled")
      .pipe(Effect.map((c) => c ?? false));

    if (isCancelled) {
      return yield* Effect.fail(new StepCancelledError(name));
    }

    // -------------------------------------------------------------------------
    // Phase 2: Check cache for existing result
    // -------------------------------------------------------------------------
    // Create StepContext to check cache
    const stepCtx = yield* createStepContext(name);

    // Get workflow identity for events
    const workflowId = yield* workflowCtx.workflowId;
    const workflowName = yield* workflowCtx.workflowName;
    const executionId = yield* workflowCtx.executionId;

    const cached = yield* stepCtx.getResult<A>();
    if (cached !== undefined) {
      // Step already completed - return cached result (no event needed)
      return cached.value;
    }

    // -------------------------------------------------------------------------
    // Phase 3: Set start time if not set
    // -------------------------------------------------------------------------
    const now = yield* runtime.now();
    const startedAt = yield* stepCtx.startedAt;
    const currentAttempt = yield* stepCtx.attempt;
    if (startedAt === undefined) {
      yield* stepCtx.setStartedAt(now);
    }

    // Emit step.started event
    yield* emitEvent({
      ...createBaseEvent(workflowId, workflowName, executionId),
      type: "step.started",
      stepName: name,
      attempt: currentAttempt,
    });

    // -------------------------------------------------------------------------
    // Phase 4: Execute the effect with StepContext and StepScope provided
    // -------------------------------------------------------------------------
    // The effect can include piped operators like retry() and timeout()
    // that require StepContext and RuntimeAdapter.
    //
    // We provide services directly to avoid complex layer composition issues:
    // - StepContext (already created as stepCtx)
    // - StepScope (for guard checks)
    // - RuntimeAdapter (for retry/timeout operators)
    // - StorageAdapter (in case the effect needs it directly)
    const stepScopeService = {
      _marker: "step-scope-active" as const,
      stepName: name,
    };

    // Build a single layer that provides all step-execution dependencies
    const stepLayer = Layer.mergeAll(
      Layer.succeed(StepContext, stepCtx),
      Layer.succeed(StepScope, stepScopeService),
      Layer.succeed(StorageAdapter, storage),
      Layer.succeed(RuntimeAdapter, runtime),
    );

    const effectResult = yield* effect.pipe(
      Effect.provide(stepLayer),
      Effect.map((value) => ({ _tag: "Success" as const, value })),
      Effect.catchAll((error) =>
        Effect.succeed({ _tag: "Failure" as const, error: error as E }),
      ),
    );

    // Handle failure
    if (effectResult._tag === "Failure") {
      const error = effectResult.error;

      // Don't emit step.failed for PauseSignal (it's a control flow signal)
      if (!isPauseSignal(error)) {
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName, executionId),
          type: "step.failed",
          stepName: name,
          attempt: currentAttempt,
          error: {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          willRetry: false, // At step level we don't know - retry operator handles this
        });
      }

      return yield* Effect.fail(error);
    }

    const result = effectResult.value;

    // -------------------------------------------------------------------------
    // Phase 5: Cache result (only on success, not on PauseSignal)
    // -------------------------------------------------------------------------
    const completedAt = yield* runtime.now();
    const attempt = yield* stepCtx.attempt;
    const durationMs = completedAt - (startedAt ?? now);
    const meta: StepResultMeta = {
      completedAt,
      attempt,
      durationMs,
    };

    yield* stepCtx.setResult(result, meta);

    // -------------------------------------------------------------------------
    // Phase 6: Mark step as completed
    // -------------------------------------------------------------------------
    yield* workflowCtx.markStepCompleted(name);

    // Emit step.completed event
    yield* emitEvent({
      ...createBaseEvent(workflowId, workflowName, executionId),
      type: "step.completed",
      stepName: name,
      attempt,
      durationMs,
      cached: false,
    });

    return result;
  });
}
