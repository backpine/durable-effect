// packages/jobs/src/errors.ts

import { Data } from "effect";

// Re-export core errors for convenience
export { StorageError, SchedulerError } from "@durable-effect/core";

/**
 * Job type not found in registry.
 */
export class JobNotFoundError extends Data.TaggedError(
  "JobNotFoundError"
)<{
  readonly type: string;
  readonly name: string;
}> {
  get message(): string {
    return `Job not found: ${this.type}/${this.name}`;
  }
}

/**
 * Instance not found (no metadata stored).
 */
export class InstanceNotFoundError extends Data.TaggedError(
  "InstanceNotFoundError"
)<{
  readonly instanceId: string;
}> {
  get message(): string {
    return `Instance not found: ${this.instanceId}`;
  }
}

/**
 * Invalid state transition.
 */
export class InvalidStateError extends Data.TaggedError("InvalidStateError")<{
  readonly expected: string;
  readonly actual: string;
  readonly operation: string;
}> {
  get message(): string {
    return `Invalid state for ${this.operation}: expected ${this.expected}, got ${this.actual}`;
  }
}

/**
 * Schema validation failed.
 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly schemaName: string;
  readonly issues: unknown;
}> {
  get message(): string {
    return `Validation failed for ${this.schemaName}`;
  }
}

/**
 * Execution of user function failed.
 */
export class ExecutionError extends Data.TaggedError("ExecutionError")<{
  readonly jobType: string;
  readonly jobName: string;
  readonly instanceId: string;
  readonly cause: unknown;
}> {
  get message(): string {
    return `Execution failed for ${this.jobType}/${this.jobName} (${this.instanceId})`;
  }
}

/**
 * Retry attempts exhausted (WorkerPool job).
 */
export class RetryExhaustedError extends Data.TaggedError(
  "RetryExhaustedError"
)<{
  readonly eventId: string;
  readonly attempts: number;
  readonly lastError: unknown;
}> {
  get message(): string {
    return `Retry exhausted for event ${this.eventId} after ${this.attempts} attempts`;
  }
}

/**
 * Unknown job type in request.
 */
export class UnknownJobTypeError extends Data.TaggedError(
  "UnknownJobTypeError"
)<{
  readonly type: string;
}> {
  get message(): string {
    return `Unknown job type: ${this.type}`;
  }
}

/**
 * Duplicate event (idempotency check failed).
 */
export class DuplicateEventError extends Data.TaggedError(
  "DuplicateEventError"
)<{
  readonly eventId: string;
}> {
  get message(): string {
    return `Duplicate event: ${this.eventId}`;
  }
}

/**
 * Signal that the task should clear all state and terminate.
 * Internal use only - caught by handler.
 */
export class ClearSignal extends Data.TaggedError("ClearSignal")<{}> {}

/**
 * Signal that the job should terminate.
 *
 * Not a true error - used to short-circuit execution from within
 * the execute function via ctx.terminate().
 */
export class TerminateSignal extends Data.TaggedError("TerminateSignal")<{
  readonly reason: string | undefined;
  readonly purgeState: boolean;
}> {
  get message(): string {
    return `Terminate signal${this.reason ? `: ${this.reason}` : ""}`;
  }
}

// Import for type reference
import type {
  StorageError as CoreStorageError,
  SchedulerError as CoreSchedulerError,
} from "@durable-effect/core";

/**
 * Union of all job errors.
 */
export type JobError =
  | CoreStorageError
  | CoreSchedulerError
  | JobNotFoundError
  | InstanceNotFoundError
  | InvalidStateError
  | ValidationError
  | ExecutionError
  | RetryExhaustedError
  | UnknownJobTypeError
  | DuplicateEventError;
