// packages/jobs/src/runtime/types.ts

import type { JobStatus } from "../services/metadata";

// =============================================================================
// Request Types
// =============================================================================

/**
 * Union of all job request types.
 */
export type JobRequest =
  | ContinuousRequest
  | DebounceRequest
  | WorkerPoolRequest;

/**
 * Continuous job request.
 */
export interface ContinuousRequest {
  readonly type: "continuous";
  readonly action: "start" | "stop" | "trigger" | "status" | "getState";
  readonly name: string;
  readonly id: string;
  readonly input?: unknown;
  readonly reason?: string;
}

/**
 * Debounce job request.
 */
export interface DebounceRequest {
  readonly type: "debounce";
  readonly action: "add" | "flush" | "clear" | "status" | "getState";
  readonly name: string;
  readonly id: string;
  readonly event?: unknown;
  readonly eventId?: string;
}

/**
 * WorkerPool job request.
 */
export interface WorkerPoolRequest {
  readonly type: "workerPool";
  readonly action:
    | "enqueue"
    | "pause"
    | "resume"
    | "cancel"
    | "status"
    | "drain";
  readonly name: string;
  readonly instanceIndex: number;
  readonly eventId?: string;
  readonly event?: unknown;
  readonly partitionKey?: string;
  readonly priority?: number;
}

// =============================================================================
// Response Types
// =============================================================================

/**
 * Union of all job response types.
 */
export type JobResponse =
  | ContinuousStartResponse
  | ContinuousStopResponse
  | ContinuousTriggerResponse
  | ContinuousStatusResponse
  | ContinuousGetStateResponse
  | DebounceAddResponse
  | DebounceFlushResponse
  | DebounceClearResponse
  | DebounceStatusResponse
  | DebounceGetStateResponse
  | WorkerPoolEnqueueResponse
  | WorkerPoolPauseResponse
  | WorkerPoolResumeResponse
  | WorkerPoolCancelResponse
  | WorkerPoolStatusResponse
  | WorkerPoolDrainResponse;

// -----------------------------------------------------------------------------
// Continuous Responses
// -----------------------------------------------------------------------------

export interface ContinuousStartResponse {
  readonly _type: "continuous.start";
  readonly instanceId: string;
  readonly created: boolean;
  readonly status: JobStatus;
}

export interface ContinuousStopResponse {
  readonly _type: "continuous.stop";
  readonly stopped: boolean;
  readonly reason?: string;
}

export interface ContinuousTriggerResponse {
  readonly _type: "continuous.trigger";
  readonly triggered: boolean;
  /** True if the job terminated during this trigger */
  readonly terminated?: boolean;
}

export interface ContinuousStatusResponse {
  readonly _type: "continuous.status";
  readonly status: JobStatus | "not_found";
  readonly nextRunAt?: number;
  readonly runCount?: number;
  /** Reason for stopping/terminating (if applicable) */
  readonly stopReason?: string;
}

export interface ContinuousGetStateResponse {
  readonly _type: "continuous.getState";
  readonly state: unknown | null;
}

// -----------------------------------------------------------------------------
// Debounce Responses
// -----------------------------------------------------------------------------

export interface DebounceAddResponse {
  readonly _type: "debounce.add";
  readonly instanceId: string;
  readonly eventCount: number;
  readonly willFlushAt: number | null;
  readonly created: boolean;
  readonly duplicate: boolean;
}

export interface DebounceFlushResponse {
  readonly _type: "debounce.flush";
  readonly flushed: boolean;
  readonly eventCount: number;
  readonly reason: "manual" | "empty";
}

export interface DebounceClearResponse {
  readonly _type: "debounce.clear";
  readonly cleared: boolean;
  readonly discardedEvents: number;
}

export interface DebounceStatusResponse {
  readonly _type: "debounce.status";
  readonly status: "debouncing" | "idle" | "not_found";
  readonly eventCount?: number;
  readonly startedAt?: number;
  readonly willFlushAt?: number;
}

export interface DebounceGetStateResponse {
  readonly _type: "debounce.getState";
  readonly state: unknown | null;
}

// -----------------------------------------------------------------------------
// WorkerPool Responses
// -----------------------------------------------------------------------------

export interface WorkerPoolEnqueueResponse {
  readonly _type: "workerPool.enqueue";
  readonly eventId: string;
  readonly instanceId: string;
  readonly instanceIndex: number;
  readonly position: number;
  readonly created: boolean;
  readonly duplicate: boolean;
}

export interface WorkerPoolPauseResponse {
  readonly _type: "workerPool.pause";
  readonly paused: boolean;
}

export interface WorkerPoolResumeResponse {
  readonly _type: "workerPool.resume";
  readonly resumed: boolean;
}

export interface WorkerPoolCancelResponse {
  readonly _type: "workerPool.cancel";
  readonly cancelled: boolean;
  readonly reason: "cancelled" | "not_found" | "already_processing" | "already_completed";
}

export interface WorkerPoolStatusResponse {
  readonly _type: "workerPool.status";
  readonly status: "processing" | "idle" | "paused" | "not_found";
  readonly pendingCount?: number;
  readonly processedCount?: number;
  readonly currentEventId?: string | null;
}

export interface WorkerPoolDrainResponse {
  readonly _type: "workerPool.drain";
  readonly drained: boolean;
}
