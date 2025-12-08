// packages/workflow-v2/src/errors.ts

import { Data } from "effect";

/**
 * Storage operation failed.
 */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: "get" | "put" | "delete" | "deleteAll" | "list";
  readonly key?: string;
  readonly cause: unknown;
}> {
  get message(): string {
    const keyPart = this.key ? ` for key "${this.key}"` : "";
    return `Storage ${this.operation}${keyPart} failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}

/**
 * Scheduler operation failed.
 */
export class SchedulerError extends Data.TaggedError("SchedulerError")<{
  readonly operation: "schedule" | "cancel" | "get";
  readonly cause: unknown;
}> {
  get message(): string {
    return `Scheduler ${this.operation} failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}

/**
 * Invalid state transition attempted.
 */
export class InvalidTransitionError extends Data.TaggedError("InvalidTransitionError")<{
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
  readonly reason: "max_attempts_exceeded" | "execution_failed" | "invalid_state";
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
