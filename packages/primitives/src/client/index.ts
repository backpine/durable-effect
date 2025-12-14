// packages/primitives/src/client/index.ts

export { createPrimitivesClient } from "./client";

export {
  narrowResponse,
  narrowResponseAsync,
  narrowResponseEffect,
  isResponseType,
  UnexpectedResponseError,
  primitiveCallError,
  type PrimitiveCallError,
  type ClientError,
  type ResponseTypeMap,
  type ResponseType,
} from "./response";

export type {
  // Client instance types
  ContinuousClient,
  BufferClient,
  QueueClient,
  QueueAggregatedStatus,
  // Client factory types
  PrimitivesClient,
  PrimitivesClientFactory,
  // Type helpers
  ContinuousKeys,
  BufferKeys,
  QueueKeys,
  ContinuousStateType,
  BufferEventType,
  BufferStateType,
  QueueEventType,
} from "./types";
