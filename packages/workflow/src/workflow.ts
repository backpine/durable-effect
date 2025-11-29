import { Duration, Effect, Option, Schema } from "effect";
import { UnknownException } from "effect/Cause";
import { ExecutionContext, PauseSignal } from "@durable-effect/core";
import {
  StepContext,
  createStepContext,
  loadStepAttempt,
} from "@/services/step-context";
import { WorkflowContext } from "@/services/workflow-context";
import type {
  DurableWorkflow,
  RetryOptions,
  WorkflowDefinition,
} from "@/types";
import { StepError, StepTimeoutError } from "@/errors";

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
    name: Name,
    definition: WorkflowDefinition<Input, E>,
    options?: { readonly input?: Schema.Schema<Input, unknown> },
  ): DurableWorkflow<Name, Input, E> {
    return {
      _tag: "DurableWorkflow",
      name,
      definition,
      inputSchema: options?.input,
    };
  }

  /**
   * Execute a durable step with automatic caching.
   * Results are cached and replayed on workflow resume.
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
   * ```
   */
  export function step<T, E, R>(
    name: string,
    effect: Effect.Effect<T, E, R>,
  ): Effect.Effect<
    T,
    E | StepError | PauseSignal | UnknownException,
    Exclude<R, StepContext> | ExecutionContext | WorkflowContext
  > {
    return Effect.gen(function* () {
      const { storage } = yield* ExecutionContext;
      const workflowCtx = yield* WorkflowContext;

      // Load attempt and create step context
      const attempt = yield* loadStepAttempt(name, storage);
      const stepCtx = createStepContext(name, storage, attempt);

      // Check if step already completed - return cached result
      const isCompleted = yield* workflowCtx.hasCompleted(name);
      if (isCompleted) {
        const cached = yield* stepCtx.getResult<T>();
        if (Option.isSome(cached)) {
          return cached.value;
        }
      }

      // Record start time (idempotent)
      yield* stepCtx.recordStartTime;

      // Execute effect with StepContext provided
      const result = yield* effect.pipe(
        Effect.provideService(StepContext, stepCtx),
        Effect.either,
      );

      if (result._tag === "Right") {
        // Success - cache result and mark completed
        yield* stepCtx.setResult(result.right);
        yield* markStepCompleted(name, storage);
        return result.right;
      }

      // Handle failure
      const error = result.left;

      // PauseSignal - increment attempt and propagate
      if (error instanceof PauseSignal) {
        yield* stepCtx.incrementAttempt;
        return yield* Effect.fail(error);
      }

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
   * // Exponential backoff
   * effect.pipe(Workflow.retry({
   *   maxAttempts: 5,
   *   delay: (attempt) => Duration.millis(1000 * Math.pow(2, attempt))
   * }))
   *
   * // Conditional retry
   * effect.pipe(Workflow.retry({
   *   maxAttempts: 3,
   *   while: (err) => err instanceof TemporaryError
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
    R | ExecutionContext | StepContext
  > {
    const { maxAttempts, delay, while: shouldRetry } = options;

    return (effect) =>
      Effect.gen(function* () {
        const ctx = yield* ExecutionContext;
        const stepCtx = yield* StepContext;

        // Try to execute the effect
        const result = yield* Effect.either(effect);

        if (result._tag === "Right") {
          return result.right;
        }

        // Effect failed - check if we should retry
        const error = result.left;
        const nextAttempt = stepCtx.attempt + 1;

        // Check retry conditions
        if (nextAttempt >= maxAttempts) {
          return yield* Effect.fail(error);
        }

        if (shouldRetry && !shouldRetry(error)) {
          return yield* Effect.fail(error);
        }

        // Calculate delay for next attempt
        const delayDuration =
          typeof delay === "function"
            ? Duration.decode(delay(stepCtx.attempt))
            : delay
              ? Duration.decode(delay)
              : Duration.seconds(1);

        const delayMs = Duration.toMillis(delayDuration);
        const resumeAt = Date.now() + delayMs;

        // Set alarm for retry
        yield* ctx.setAlarm(resumeAt);

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
    R | ExecutionContext | StepContext
  > {
    return (effect) =>
      Effect.gen(function* () {
        const stepCtx = yield* StepContext;

        // Get or calculate deadline
        const existingDeadline = yield* stepCtx.deadline;
        const deadline =
          existingDeadline._tag === "Some"
            ? existingDeadline.value
            : Date.now() + Duration.toMillis(Duration.decode(duration));

        // Store deadline if first execution
        if (existingDeadline._tag === "None") {
          yield* stepCtx.setMeta("deadline", deadline);
        }

        // Check if deadline has passed
        if (Date.now() > deadline) {
          return yield* Effect.fail(
            new StepTimeoutError({
              stepName: stepCtx.stepName,
              timeoutMs: Duration.toMillis(Duration.decode(duration)),
            }),
          );
        }

        // Execute with remaining time
        const remainingMs = deadline - Date.now();
        return yield* Effect.timeoutFail(effect, {
          duration: Duration.millis(remainingMs),
          onTimeout: () =>
            new StepTimeoutError({
              stepName: stepCtx.stepName,
              timeoutMs: Duration.toMillis(Duration.decode(duration)),
            }),
        });
      });
  }

  /**
   * Durable sleep that survives workflow restarts.
   *
   * @example
   * ```typescript
   * yield* Workflow.sleep('5 seconds');
   * yield* Workflow.sleep(Duration.hours(1));
   * ```
   */
  export function sleep(
    duration: Duration.DurationInput,
  ): Effect.Effect<void, PauseSignal | UnknownException, ExecutionContext> {
    return Effect.gen(function* () {
      const ctx = yield* ExecutionContext;
      yield* Effect.log("Sleeping for " + duration);
      const durationMs = Duration.toMillis(Duration.decode(duration));
      const resumeAt = Date.now() + durationMs;

      // Set alarm for wake-up
      yield* ctx.setAlarm(resumeAt);

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
