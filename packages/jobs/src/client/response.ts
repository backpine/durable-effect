// packages/jobs/src/client/response.ts

import { Effect } from "effect";
import type {
  JobResponse,
  ContinuousStartResponse,
  ContinuousStopResponse,
  ContinuousTriggerResponse,
  ContinuousStatusResponse,
  ContinuousGetStateResponse,
  DebounceAddResponse,
  DebounceFlushResponse,
  DebounceClearResponse,
  DebounceStatusResponse,
  DebounceGetStateResponse,
  WorkerPoolEnqueueResponse,
  WorkerPoolPauseResponse,
  WorkerPoolResumeResponse,
  WorkerPoolCancelResponse,
  WorkerPoolStatusResponse,
  WorkerPoolDrainResponse,
} from "../runtime/types";

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error when DO call fails.
 */
export interface JobCallError {
  readonly _tag: "JobCallError";
  readonly cause: unknown;
}

/**
 * Create a JobCallError.
 */
export const jobCallError = (cause: unknown): JobCallError => ({
  _tag: "JobCallError",
  cause,
});

// =============================================================================
// Response Type Map
// =============================================================================

/**
 * Maps response _type discriminants to their full types.
 */
export interface ResponseTypeMap {
  "continuous.start": ContinuousStartResponse;
  "continuous.stop": ContinuousStopResponse;
  "continuous.trigger": ContinuousTriggerResponse;
  "continuous.status": ContinuousStatusResponse;
  "continuous.getState": ContinuousGetStateResponse;
  "debounce.add": DebounceAddResponse;
  "debounce.flush": DebounceFlushResponse;
  "debounce.clear": DebounceClearResponse;
  "debounce.status": DebounceStatusResponse;
  "debounce.getState": DebounceGetStateResponse;
  "workerPool.enqueue": WorkerPoolEnqueueResponse;
  "workerPool.pause": WorkerPoolPauseResponse;
  "workerPool.resume": WorkerPoolResumeResponse;
  "workerPool.cancel": WorkerPoolCancelResponse;
  "workerPool.status": WorkerPoolStatusResponse;
  "workerPool.drain": WorkerPoolDrainResponse;
}

/**
 * All valid response type discriminants.
 */
export type ResponseType = keyof ResponseTypeMap;

// =============================================================================
// Response Narrowing
// =============================================================================

/**
 * Runtime error for unexpected response types.
 */
export class UnexpectedResponseError extends Error {
  readonly _tag = "UnexpectedResponseError";
  readonly expected: ResponseType;
  readonly actual: string;

  constructor(expected: ResponseType, actual: string) {
    super(`Expected response type "${expected}" but received "${actual}"`);
    this.name = "UnexpectedResponseError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Type guard to check if a response has a specific _type.
 */
export function isResponseType<T extends ResponseType>(
  response: JobResponse,
  expectedType: T
): response is ResponseTypeMap[T] {
  return response._type === expectedType;
}

/**
 * Narrow a response to a specific type with runtime validation.
 *
 * This provides both compile-time type safety AND runtime validation,
 * unlike raw type casts which only provide compile-time types.
 *
 * @throws UnexpectedResponseError if the response type doesn't match
 */
export function narrowResponse<T extends ResponseType>(
  response: JobResponse,
  expectedType: T
): ResponseTypeMap[T] {
  if (isResponseType(response, expectedType)) {
    return response;
  }
  throw new UnexpectedResponseError(expectedType, response._type);
}

/**
 * Narrow a Promise<JobResponse> to a specific type.
 *
 * @example
 * ```ts
 * const response = await narrowResponseAsync(
 *   stub.call({ type: "continuous", action: "start", ... }),
 *   "continuous.start"
 * );
 * // response is typed as ContinuousStartResponse
 * ```
 */
export async function narrowResponseAsync<T extends ResponseType>(
  promise: Promise<JobResponse>,
  expectedType: T
): Promise<ResponseTypeMap[T]> {
  const response = await promise;
  return narrowResponse(response, expectedType);
}

// =============================================================================
// Combined error type
// =============================================================================

/**
 * Combined error type for client operations.
 */
export type ClientError = JobCallError | UnexpectedResponseError;

// =============================================================================
// Effect-based Response Narrowing
// =============================================================================

/**
 * Narrow a Promise<JobResponse> to a specific type, returning an Effect.
 *
 * This is the Effect-based version that properly handles errors and can be used
 * with Effect.gen and yield*.
 *
 * @example
 * ```ts
 * const response = yield* narrowResponseEffect(
 *   stub.call({ type: "continuous", action: "start", ... }),
 *   "continuous.start"
 * );
 * // response is typed as ContinuousStartResponse
 * ```
 */
export function narrowResponseEffect<T extends ResponseType>(
  promise: Promise<JobResponse>,
  expectedType: T
): Effect.Effect<ResponseTypeMap[T], ClientError> {
  return Effect.tryPromise({
    try: () => promise,
    catch: (error) => jobCallError(error),
  }).pipe(
    Effect.flatMap((response) => {
      if (isResponseType(response, expectedType)) {
        return Effect.succeed(response);
      }
      return Effect.fail(
        new UnexpectedResponseError(expectedType, response._type)
      );
    })
  );
}
