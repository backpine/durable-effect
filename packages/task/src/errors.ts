import { Data } from "effect";

export class StoreError extends Data.TaggedError("StoreError")<{
  message: string;
  cause?: unknown;
}> {}

export class SchedulerError extends Data.TaggedError("SchedulerError")<{
  message: string;
  cause?: unknown;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  message: string;
  cause?: unknown;
}> {}

export class TaskNotFoundError extends Data.TaggedError("TaskNotFoundError")<{
  name: string;
}> {}

export class ClientError extends Data.TaggedError("ClientError")<{
  message: string;
  cause?: unknown;
}> {}

export class PurgeSignal extends Data.TaggedError("PurgeSignal")<{}> {}
