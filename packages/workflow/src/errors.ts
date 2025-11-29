import { Data } from "effect";

/**
 * Step execution failed after all retries exhausted.
 */
export class StepError extends Data.TaggedError("StepError")<{
  readonly stepName: string;
  readonly cause: unknown;
  readonly attempt: number;
}> {}

/**
 * Step exceeded its timeout deadline.
 */
export class StepTimeoutError extends Data.TaggedError("StepTimeoutError")<{
  readonly stepName: string;
  readonly timeoutMs: number;
}> {}
