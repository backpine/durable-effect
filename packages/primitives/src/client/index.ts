// packages/jobs/src/client/index.ts

export { createJobsClient } from "./client";

export {
  narrowResponse,
  narrowResponseAsync,
  narrowResponseEffect,
  isResponseType,
  UnexpectedResponseError,
  jobCallError,
  type JobCallError,
  type ClientError,
  type ResponseTypeMap,
  type ResponseType,
} from "./response";

export type {
  // Client instance types
  ContinuousClient,
  DebounceClient,
  WorkerPoolClient,
  WorkerPoolAggregatedStatus,
  // Client factory types
  JobsClient,
  JobsClientFactory,
  // Type helpers
  ContinuousKeys,
  DebounceKeys,
  WorkerPoolKeys,
  ContinuousStateType,
  DebounceEventType,
  DebounceStateType,
  WorkerPoolEventType,
} from "./types";
