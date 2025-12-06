import { Duration, Effect, Option, Schema } from "effect";
import { UnknownException } from "effect/Cause";
import {
  ExecutionContext,
  PauseSignal,
  createBaseEvent,
} from "@durable-effect/core";
import {
  StepContext,
  createStepContext,
  loadStepAttempt,
} from "@/services/step-context";
import { WorkflowContext } from "@/services/workflow-context";
import {
  WorkflowScope,
  type ForbidWorkflowScope,
} from "@/services/workflow-scope";
import { emitEvent } from "@/tracker";
import type {
  DurableWorkflow,
  RetryOptions,
  WorkflowDefinition,
} from "@/types";
import {
  StepError,
  StepTimeoutError,
  StepSerializationError,
  WorkflowCancelledError,
} from "@/errors";
import { calculateDelay, isBackoffConfig } from "@/backoff";

/**
 * Workflow namespace providing all workflow primitives.
 */
export namespace Workflow {
  /**
   * Create a typed workflow definition.
   *
   * @example
   * ```typescript
   * const myWorkflow = Workflow.make(
   *   'processOrder',
   *   (orderId: string) => Effect.gen(function* () {
   *     const order = yield* Workflow.step('Fetch', fetchOrder(orderId));
   *     yield* Workflow.step('Process', processOrder(order));
   *   })
   * );
   * ```
   */
  export function make<const Name extends string, Input, E>(
    definition: WorkflowDefinition<Input, E>,
    options?: { readonly input?: Schema.Schema<Input, unknown> },
  ): DurableWorkflow<Name, Input, E> {
    return {
      _tag: "DurableWorkflow",
      definition,
      inputSchema: options?.input,
    };
  }

  /**
   * Execute a durable step with automatic caching.
   * Results are cached and replayed on workflow resume.
   *
   * **IMPORTANT**: The effect's return value MUST be serializable (JSON-safe).
   * Non-serializable values (functions, Symbols, Proxy objects, ORM results)
   * will cause a `StepSerializationError` at runtime.
   *
   * If your effect returns a complex object (e.g., ORM result), map it to a
   * plain object or discard it:
   * - `.pipe(Effect.map(r => ({ id: r.id })))` - extract needed fields
   * - `.pipe(Effect.asVoid)` - discard the result
   * - `.pipe(Effect.as({ success: true }))` - return explicit value
   *
   * Operators (retry, timeout) should be applied to the effect INSIDE the step.
   *
   * @example
   * ```typescript
   * // Simple step
   * const user = yield* Workflow.step('Fetch user', fetchUser(id));
   *
   * // Step with retry
   * const payment = yield* Workflow.step('Payment',
   *   processPayment(order).pipe(
   *     Workflow.retry({ maxAttempts: 3, delay: '5 seconds' })
   *   )
   * );
   *
   * // Step with timeout and retry
   * yield* Workflow.step('External API',
   *   callAPI().pipe(
   *     Workflow.timeout('30 seconds'),
   *     Workflow.retry({ maxAttempts: 3 })
   *   )
   * );
   *
   * // Step returning ORM result - map to serializable
   * yield* Workflow.step('Update DB',
   *   updateRecord(id).pipe(Effect.asVoid)
   * );
   * ```
   */
  export function step<T, E, R>(
    name: string,
    effect: Effect.Effect<T, E, ForbidWorkflowScope<R>>,
  ): Effect.Effect<
    T,
    | E
    | StepError
    | StepSerializationError
    | PauseSignal
    | UnknownException
    | WorkflowCancelledError,
    WorkflowScope | Exclude<R, StepContext> | ExecutionContext | WorkflowContext
  > {
    return Effect.gen(function* () {
      const { storage } = yield* ExecutionContext;
      const workflowCtx = yield* WorkflowContext;

      // Check for cancellation before executing step
      const cancelled = yield* Effect.promise(() =>
        storage.get<boolean>("workflow:cancelled"),
      );
      if (cancelled) {
        const reason = yield* Effect.promise(() =>
          storage.get<string>("workflow:cancelReason"),
        );
        return yield* Effect.fail(
          new WorkflowCancelledError({
            workflowId: workflowCtx.workflowId,
            reason,
          }),
        );
      }

      // Load attempt and create step context
      const attempt = yield* loadStepAttempt(name, storage);
      const stepCtx = createStepContext(name, storage, attempt);

      // Check if step already completed - return cached result
      const isCompleted = yield* workflowCtx.hasCompleted(name);
      if (isCompleted) {
        const cached = yield* stepCtx.getResult<T>();
        if (Option.isSome(cached)) {
          // Emit step completed (cached)
          yield* emitEvent({
            ...createBaseEvent(
              workflowCtx.workflowId,
              workflowCtx.workflowName,
            ),
            type: "step.completed",
            stepName: name,
            attempt,
            durationMs: 0,
            cached: true,
          });
          return cached.value;
        }
      }

      // Record start time (idempotent)
      yield* stepCtx.recordStartTime;
      const startTime = Date.now();

      // Emit step started event
      yield* emitEvent({
        ...createBaseEvent(workflowCtx.workflowId, workflowCtx.workflowName),
        type: "step.started",
        stepName: name,
        attempt,
      });

      // Execute effect with StepContext provided
      // Note: We don't inject StepClock here because Effect.timeoutFail uses
      // Effect.sleep internally for timeout racing. Compile-time enforcement
      // via ForbidWorkflowScope prevents Workflow.sleep and nested Workflow.step.
      const result = yield* effect.pipe(
        Effect.provideService(StepContext, stepCtx),
        Effect.either,
      );

      if (result._tag === "Right") {
        // Success - try to cache result
        const cacheResult = yield* stepCtx
          .setResult(result.right)
          .pipe(Effect.either);

        if (cacheResult._tag === "Left") {
          const serializationError = cacheResult.left;

          // Emit step.failed for serialization errors
          yield* emitEvent({
            ...createBaseEvent(
              workflowCtx.workflowId,
              workflowCtx.workflowName,
            ),
            type: "step.failed",
            stepName: name,
            attempt,
            error: {
              message:
                serializationError instanceof StepSerializationError
                  ? serializationError.message
                  : "Failed to cache step result: value is not serializable",
              stack:
                serializationError instanceof Error
                  ? serializationError.stack
                  : undefined,
            },
            willRetry: false,
          });

          // Propagate the serialization error (already typed correctly)
          return yield* Effect.fail(serializationError);
        }

        yield* markStepCompleted(name, storage);

        // Emit step completed event
        yield* emitEvent({
          ...createBaseEvent(workflowCtx.workflowId, workflowCtx.workflowName),
          type: "step.completed",
          stepName: name,
          attempt,
          durationMs: Date.now() - startTime,
          cached: false,
        });

        return result.right;
      }

      // Handle failure
      const error = result.left;

      // PauseSignal - increment attempt and propagate (don't emit step.failed for pauses)
      if (error instanceof PauseSignal) {
        yield* stepCtx.incrementAttempt;
        return yield* Effect.fail(error);
      }

      // Emit step failed event
      yield* emitEvent({
        ...createBaseEvent(workflowCtx.workflowId, workflowCtx.workflowName),
        type: "step.failed",
        stepName: name,
        attempt,
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        willRetry: false, // At step level, we don't know - retry operator handles this
      });

      // Other errors - wrap in StepError
      return yield* Effect.fail(
        new StepError({
          stepName: name,
          cause: error,
          attempt,
        }),
      );
    });
  }

  /**
   * Mark a step as completed in the workflow's completed steps list.
   * @internal
   */
  function markStepCompleted(
    name: string,
    storage: DurableObjectStorage,
  ): Effect.Effect<void, UnknownException> {
    return Effect.tryPromise({
      try: async () => {
        const completed =
          (await storage.get<string[]>("workflow:completedSteps")) ?? [];
        if (!completed.includes(name)) {
          await storage.put("workflow:completedSteps", [...completed, name]);
        }
      },
      catch: (e) => new UnknownException(e),
    });
  }

  /**
   * Durable retry operator.
   * Persists retry state across workflow restarts.
   *
   * @example
   * ```typescript
   * // Fixed delay
   * effect.pipe(Workflow.retry({ maxAttempts: 3, delay: '5 seconds' }))
   *
   * // Custom backoff function
   * effect.pipe(Workflow.retry({
   *   maxAttempts: 5,
   *   delay: (attempt) => Duration.millis(1000 * Math.pow(2, attempt))
   * }))
   *
   * // Exponential backoff with preset
   * effect.pipe(Workflow.retry({
   *   maxAttempts: 5,
   *   delay: Backoff.presets.standard()
   * }))
   *
   * // Custom exponential with jitter
   * effect.pipe(Workflow.retry({
   *   maxAttempts: 5,
   *   delay: Backoff.exponential({
   *     base: '1 second',
   *     factor: 2,
   *     max: '30 seconds',
   *     jitter: true
   *   })
   * }))
   *
   * // With max total duration
   * effect.pipe(Workflow.retry({
   *   maxAttempts: 10,
   *   delay: Backoff.exponential({ base: '1 second' }),
   *   maxDuration: '5 minutes'
   * }))
   * ```
   */
  export function retry<T, E, R>(
    options: RetryOptions,
  ): (
    effect: Effect.Effect<T, E, R>,
  ) => Effect.Effect<
    T,
    E | PauseSignal | UnknownException,
    R | ExecutionContext | StepContext | WorkflowContext
  > {
    const { maxAttempts, delay, maxDuration } = options;

    return (effect) =>
      Effect.gen(function* () {
        const ctx = yield* ExecutionContext;
        const stepCtx = yield* StepContext;
        const workflowCtx = yield* WorkflowContext;

        // Get or initialize retry start time for maxDuration tracking
        const retryStartKey = `retry:${stepCtx.stepName}:startTime`;
        let retryStartTime: number | undefined;

        if (maxDuration !== undefined) {
          const existingStart = yield* stepCtx.getMeta<number>(retryStartKey);
          if (Option.isSome(existingStart)) {
            retryStartTime = existingStart.value;
          } else {
            retryStartTime = Date.now();
            yield* stepCtx.setMeta(retryStartKey, retryStartTime);
          }
        }

        // Try to execute the effect
        const result = yield* Effect.either(effect);

        if (result._tag === "Right") {
          return result.right;
        }

        // Effect failed - check if we should retry
        const error = result.left;

        // Check retry conditions
        // maxAttempts is the number of retries (not including initial attempt)
        // So if attempt >= maxAttempts, we've exhausted all retries
        if (stepCtx.attempt >= maxAttempts) {
          // Emit retry exhausted event
          yield* emitEvent({
            ...createBaseEvent(
              workflowCtx.workflowId,
              workflowCtx.workflowName,
            ),
            type: "retry.exhausted",
            stepName: stepCtx.stepName,
            attempts: maxAttempts,
          });

          return yield* Effect.fail(error);
        }

        // Calculate delay for next attempt
        let delayDuration: Duration.Duration;

        if (delay === undefined) {
          delayDuration = Duration.seconds(1);
        } else if (typeof delay === "function") {
          delayDuration = Duration.decode(delay(stepCtx.attempt));
        } else if (isBackoffConfig(delay)) {
          delayDuration = calculateDelay(delay, stepCtx.attempt);
        } else {
          delayDuration = Duration.decode(delay);
        }

        const delayMs = Duration.toMillis(delayDuration);

        // Check maxDuration before scheduling retry
        if (maxDuration !== undefined && retryStartTime !== undefined) {
          const maxDurationMs = Duration.toMillis(Duration.decode(maxDuration));
          const elapsed = Date.now() - retryStartTime;

          if (elapsed + delayMs > maxDurationMs) {
            // Would exceed max duration, exhaust retries early
            yield* emitEvent({
              ...createBaseEvent(
                workflowCtx.workflowId,
                workflowCtx.workflowName,
              ),
              type: "retry.exhausted",
              stepName: stepCtx.stepName,
              attempts: stepCtx.attempt,
            });

            return yield* Effect.fail(error);
          }
        }

        const resumeAt = Date.now() + delayMs;

        // Set alarm for retry
        yield* ctx.setAlarm(resumeAt);

        // Emit retry scheduled event
        yield* emitEvent({
          ...createBaseEvent(workflowCtx.workflowId, workflowCtx.workflowName),
          type: "retry.scheduled",
          stepName: stepCtx.stepName,
          attempt: stepCtx.attempt,
          nextAttemptAt: new Date(resumeAt).toISOString(),
          delayMs,
          ...(isBackoffConfig(delay) && { backoffType: delay._tag.toLowerCase() }),
        });

        // Pause workflow - will resume at alarm time
        return yield* Effect.fail(
          new PauseSignal({
            reason: "retry",
            resumeAt,
            stepName: stepCtx.stepName,
          }),
        );
      });
  }

  /**
   * Durable timeout operator.
   * Sets a deadline that persists across workflow restarts.
   *
   * @example
   * ```typescript
   * effect.pipe(Workflow.timeout('30 seconds'))
   * effect.pipe(Workflow.timeout(Duration.minutes(5)))
   * ```
   */
  export function timeout<T, E, R>(
    duration: Duration.DurationInput,
  ): (
    effect: Effect.Effect<T, E, R>,
  ) => Effect.Effect<
    T,
    E | StepTimeoutError | UnknownException,
    R | ExecutionContext | StepContext | WorkflowContext
  > {
    return (effect) =>
      Effect.gen(function* () {
        const stepCtx = yield* StepContext;
        const workflowCtx = yield* WorkflowContext;
        const timeoutMs = Duration.toMillis(Duration.decode(duration));

        // Get or calculate deadline
        const existingDeadline = yield* stepCtx.deadline;
        const deadline =
          existingDeadline._tag === "Some"
            ? existingDeadline.value
            : Date.now() + timeoutMs;

        // Store deadline if first execution
        if (existingDeadline._tag === "None") {
          yield* stepCtx.setMeta("deadline", deadline);

          // Emit timeout set event
          yield* emitEvent({
            ...createBaseEvent(
              workflowCtx.workflowId,
              workflowCtx.workflowName,
            ),
            type: "timeout.set",
            stepName: stepCtx.stepName,
            deadline: new Date(deadline).toISOString(),
            timeoutMs,
          });
        }

        // Check if deadline has passed
        if (Date.now() > deadline) {
          // Emit timeout exceeded event
          yield* emitEvent({
            ...createBaseEvent(
              workflowCtx.workflowId,
              workflowCtx.workflowName,
            ),
            type: "timeout.exceeded",
            stepName: stepCtx.stepName,
            timeoutMs,
          });

          return yield* Effect.fail(
            new StepTimeoutError({
              stepName: stepCtx.stepName,
              timeoutMs,
            }),
          );
        }

        // Execute with remaining time
        const remainingMs = deadline - Date.now();
        const result = yield* Effect.timeoutFail(effect, {
          duration: Duration.millis(remainingMs),
          onTimeout: () =>
            new StepTimeoutError({
              stepName: stepCtx.stepName,
              timeoutMs,
            }),
        }).pipe(Effect.either);

        if (result._tag === "Left" && result.left instanceof StepTimeoutError) {
          // Emit timeout exceeded event for runtime timeout
          yield* emitEvent({
            ...createBaseEvent(
              workflowCtx.workflowId,
              workflowCtx.workflowName,
            ),
            type: "timeout.exceeded",
            stepName: stepCtx.stepName,
            timeoutMs,
          });
          return yield* Effect.fail(result.left);
        }

        if (result._tag === "Left") {
          return yield* Effect.fail(result.left);
        }

        return result.right;
      });
  }

  /**
   * Durable sleep that survives workflow restarts.
   *
   * Uses execution order tracking to ensure each sleep only pauses once.
   * On resume, completed sleeps are skipped automatically.
   *
   * @example
   * ```typescript
   * yield* Workflow.sleep('5 seconds');
   * yield* Workflow.sleep(Duration.hours(1));
   * ```
   */
  export function sleep(
    duration: Duration.DurationInput,
  ): Effect.Effect<
    void,
    PauseSignal | UnknownException,
    WorkflowScope | ExecutionContext | WorkflowContext
  > {
    return Effect.gen(function* () {
      const ctx = yield* ExecutionContext;
      const workflowCtx = yield* WorkflowContext;
      const durationMs = Duration.toMillis(Duration.decode(duration));

      // Get this pause point's index
      const pauseIndex = yield* workflowCtx.nextPauseIndex;
      const completedIndex = yield* workflowCtx.completedPauseIndex;

      // Already completed - skip this sleep
      if (pauseIndex <= completedIndex) {
        return;
      }

      // Check if we're resuming from this pause
      const pendingResumeAt = yield* workflowCtx.pendingResumeAt;
      if (
        Option.isSome(pendingResumeAt) &&
        Date.now() >= pendingResumeAt.value
      ) {
        // This is the pause we're resuming from
        yield* workflowCtx.setCompletedPauseIndex(pauseIndex);
        yield* workflowCtx.clearPendingResumeAt;

        // Emit sleep completed event
        yield* emitEvent({
          ...createBaseEvent(workflowCtx.workflowId, workflowCtx.workflowName),
          type: "sleep.completed",
          durationMs,
        });

        return;
      }

      // New pause - set alarm and pause
      const resumeAt = Date.now() + durationMs;

      yield* workflowCtx.setPendingResumeAt(resumeAt);
      yield* ctx.setAlarm(resumeAt);

      // Emit sleep started event
      yield* emitEvent({
        ...createBaseEvent(workflowCtx.workflowId, workflowCtx.workflowName),
        type: "sleep.started",
        durationMs,
        resumeAt: new Date(resumeAt).toISOString(),
      });

      // Pause workflow - will resume at alarm time
      return yield* Effect.fail(
        new PauseSignal({
          reason: "sleep",
          resumeAt,
        }),
      );
    });
  }

  /**
   * Direct access to workflow context.
   *
   * @example
   * ```typescript
   * const ctx = yield* Workflow.Context;
   * yield* ctx.setMeta('key', value);
   * const completed = yield* ctx.completedSteps;
   * ```
   */
  export const Context = WorkflowContext;

  /**
   * Direct access to step context (within step handlers).
   *
   * @example
   * ```typescript
   * yield* Workflow.step('MyStep', Effect.gen(function* () {
   *   const step = yield* Workflow.Step;
   *   console.log(`Attempt ${step.attempt + 1}`);
   * }));
   * ```
   */
  export const Step = StepContext;
}
