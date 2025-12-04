import { Clock, Effect, Layer } from "effect";
import type { Duration } from "effect";

/**
 * Error thrown when Effect.sleep is called inside a step.
 */
export class StepSleepForbiddenError extends Error {
  readonly _tag = "StepSleepForbiddenError";

  constructor() {
    super(
      "Effect.sleep is not allowed inside a step. " +
        "Steps should be atomic units of work. " +
        "Use Workflow.sleep at the workflow level between steps.",
    );
    this.name = "StepSleepForbiddenError";
  }
}

/**
 * A Clock implementation that rejects sleep operations.
 * Used inside steps to enforce that Effect.sleep is not called.
 *
 * Time-related operations (currentTimeMillis, currentTimeNanos) are allowed.
 */
export const StepClock: Clock.Clock = {
  [Clock.ClockTypeId]: Clock.ClockTypeId,

  // Allow getting current time (synchronous)
  unsafeCurrentTimeMillis: () => Date.now(),
  unsafeCurrentTimeNanos: () => BigInt(Date.now()) * BigInt(1_000_000),

  // Allow getting current time (effectful)
  currentTimeMillis: Effect.sync(() => Date.now()),
  currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * BigInt(1_000_000)),

  // Reject sleep operations
  sleep: (_duration: Duration.Duration) => Effect.die(new StepSleepForbiddenError()),
};

/**
 * Layer that provides the step clock.
 * This clock rejects Effect.sleep calls inside steps.
 */
export const StepClockLayer = Layer.succeed(Clock.Clock, StepClock);
