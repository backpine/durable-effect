// packages/jobs/src/handlers/debounce/types.ts

import type { Effect } from "effect";
import type { DebounceRequest } from "../../runtime/types";
import type {
  DebounceAddResponse,
  DebounceFlushResponse,
  DebounceClearResponse,
  DebounceStatusResponse,
  DebounceGetStateResponse,
} from "../../runtime/types";
import type { JobError } from "../../errors";

export type DebounceResponse =
  | DebounceAddResponse
  | DebounceFlushResponse
  | DebounceClearResponse
  | DebounceStatusResponse
  | DebounceGetStateResponse;

export interface DebounceHandlerI {
  handle(request: DebounceRequest): Effect.Effect<DebounceResponse, JobError>;
  handleAlarm(): Effect.Effect<void, JobError>;
}
