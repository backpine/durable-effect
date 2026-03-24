import { Data } from "effect"

// ---------------------------------------------------------------------------
// User-facing: surfaced by TaskCtx methods (storage/alarm/schema ops)
// ---------------------------------------------------------------------------

export class TaskError extends Data.TaggedError("TaskError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// ---------------------------------------------------------------------------
// Internal control flow signal — ctx.purge() fails with this
// ---------------------------------------------------------------------------

export class PurgeSignal extends Data.TaggedError("PurgeSignal")<{}> {}

// ---------------------------------------------------------------------------
// Runner errors
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

// ---------------------------------------------------------------------------
// System failure — injected by the runtime when the underlying infrastructure
// (e.g. Cloudflare DO) experiences a crash or restart. Available on ctx so
// handlers can detect and recover from infrastructure-level failures.
// ---------------------------------------------------------------------------

export class SystemFailure extends Data.TaggedError("SystemFailure")<{
  readonly message: string
  readonly cause?: unknown
}> {}
