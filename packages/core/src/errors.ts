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

// =============================================================================
// Adapter Errors (shared across workflow and primitives)
// =============================================================================

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
