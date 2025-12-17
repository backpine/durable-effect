// packages/jobs/src/handlers/task/types.ts

import type { Effect } from "effect";
import type { TaskRequest } from "../../runtime/types";
import type {
  TaskSendResponse,
  TaskTriggerResponse,
  TaskClearResponse,
  TaskStatusResponse,
  TaskGetStateResponse,
} from "../../runtime/types";
import type { JobError } from "../../errors";

export type TaskResponse =
  | TaskSendResponse
  | TaskTriggerResponse
  | TaskClearResponse
  | TaskStatusResponse
  | TaskGetStateResponse;

export interface TaskHandlerI {
  handle(request: TaskRequest): Effect.Effect<TaskResponse, JobError, any>;
  handleAlarm(): Effect.Effect<void, JobError, any>;
}
