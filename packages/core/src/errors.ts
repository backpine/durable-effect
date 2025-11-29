import { Data } from "effect";

/**
 * Internal signal to pause workflow execution.
 * Used by retry and sleep to trigger alarm-based resume.
 * @internal
 */
export class PauseSignal extends Data.TaggedError("PauseSignal")<{
  readonly reason: "retry" | "sleep";
  readonly resumeAt: number;
  readonly stepName?: string;
}> {}
