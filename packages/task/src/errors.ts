import { Data } from "effect"

// ---------------------------------------------------------------------------
// User-facing: surfaced by TaskContext methods
// ---------------------------------------------------------------------------

export class TaskError extends Data.TaggedError("TaskError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// ---------------------------------------------------------------------------
// Internal control flow signal
// ---------------------------------------------------------------------------

export class PurgeSignal extends Data.TaggedError("PurgeSignal")<{}> {}

// ---------------------------------------------------------------------------
// TaskRunner errors
// ---------------------------------------------------------------------------

export class TaskNotFoundError extends Data.TaggedError("TaskNotFoundError")<{
  readonly name: string
}> {}

export class TaskValidationError extends Data.TaggedError("TaskValidationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class TaskExecutionError extends Data.TaggedError("TaskExecutionError")<{
  readonly cause: unknown
}> {}
