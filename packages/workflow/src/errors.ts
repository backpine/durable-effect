// packages/workflow/src/errors.ts

import { Data } from "effect";

// Re-export adapter errors from core
export { StorageError, SchedulerError } from "@durable-effect/core";

/**
 * Invalid state transition attempted.
 */
export class InvalidTransitionError extends Data.TaggedError(
  "InvalidTransitionError",
)<{
  readonly fromStatus: string;
  readonly toTransition: string;
  readonly validTransitions: ReadonlyArray<string>;
}> {
  get message(): string {
    return `Cannot apply "${this.toTransition}" from status "${this.fromStatus}". Valid transitions: [${this.validTransitions.join(", ")}]`;
  }
}

/**
 * Recovery operation failed.
 */
export class RecoveryError extends Data.TaggedError("RecoveryError")<{
  readonly reason:
    | "max_attempts_exceeded"
    | "execution_failed"
    | "invalid_state";
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly cause?: unknown;
}> {
  get message(): string {
    switch (this.reason) {
      case "max_attempts_exceeded":
        return `Recovery failed: max attempts (${this.maxAttempts}) exceeded after ${this.attempts} attempts`;
      case "execution_failed":
        return `Recovery execution failed: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
      case "invalid_state":
        return `Recovery failed: workflow is in an invalid state for recovery`;
    }
  }
}

/**
 * Orchestrator-level operation failed.
 */
export class OrchestratorError extends Data.TaggedError("OrchestratorError")<{
  readonly operation: "start" | "queue" | "alarm" | "cancel" | "execute";
  readonly cause: unknown;
}> {
  get message(): string {
    return `Orchestrator ${this.operation} failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}
