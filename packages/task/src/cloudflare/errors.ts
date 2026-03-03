import { Data } from "effect"

export class TaskClientError extends Data.TaggedError("TaskClientError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
