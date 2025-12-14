// packages/primitives/src/runtime/types.ts

import type { PrimitiveStatus } from "../services/metadata";

// =============================================================================
// Request Types
// =============================================================================

/**
 * Union of all primitive request types.
 */
export type PrimitiveRequest =
  | ContinuousRequest
  | BufferRequest
  | QueueRequest;

/**
 * Continuous primitive request.
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
 * Buffer primitive request.
 */
export interface BufferRequest {
  readonly type: "buffer";
  readonly action: "add" | "flush" | "clear" | "status" | "getState";
  readonly name: string;
  readonly id: string;
  readonly event?: unknown;
  readonly eventId?: string;
}

/**
 * Queue primitive request.
 */
export interface QueueRequest {
  readonly type: "queue";
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
 * Union of all primitive response types.
 */
export type PrimitiveResponse =
  | ContinuousStartResponse
  | ContinuousStopResponse
  | ContinuousTriggerResponse
  | ContinuousStatusResponse
  | ContinuousGetStateResponse
  | BufferAddResponse
  | BufferFlushResponse
  | BufferClearResponse
  | BufferStatusResponse
  | BufferGetStateResponse
  | QueueEnqueueResponse
  | QueuePauseResponse
  | QueueResumeResponse
  | QueueCancelResponse
  | QueueStatusResponse
  | QueueDrainResponse;

// -----------------------------------------------------------------------------
// Continuous Responses
// -----------------------------------------------------------------------------

export interface ContinuousStartResponse {
  readonly _type: "continuous.start";
  readonly instanceId: string;
  readonly created: boolean;
  readonly status: PrimitiveStatus;
}

export interface ContinuousStopResponse {
  readonly _type: "continuous.stop";
  readonly stopped: boolean;
  readonly reason?: string;
}

export interface ContinuousTriggerResponse {
  readonly _type: "continuous.trigger";
  readonly triggered: boolean;
  /** True if the primitive terminated during this trigger */
  readonly terminated?: boolean;
}

export interface ContinuousStatusResponse {
  readonly _type: "continuous.status";
  readonly status: PrimitiveStatus | "not_found";
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
// Buffer Responses
// -----------------------------------------------------------------------------

export interface BufferAddResponse {
  readonly _type: "buffer.add";
  readonly instanceId: string;
  readonly eventCount: number;
  readonly willFlushAt: number | null;
  readonly created: boolean;
  readonly duplicate: boolean;
}

export interface BufferFlushResponse {
  readonly _type: "buffer.flush";
  readonly flushed: boolean;
  readonly eventCount: number;
  readonly reason: "manual" | "empty";
}

export interface BufferClearResponse {
  readonly _type: "buffer.clear";
  readonly cleared: boolean;
  readonly discardedEvents: number;
}

export interface BufferStatusResponse {
  readonly _type: "buffer.status";
  readonly status: "buffering" | "idle" | "not_found";
  readonly eventCount?: number;
  readonly startedAt?: number;
  readonly willFlushAt?: number;
}

export interface BufferGetStateResponse {
  readonly _type: "buffer.getState";
  readonly state: unknown | null;
}

// -----------------------------------------------------------------------------
// Queue Responses
// -----------------------------------------------------------------------------

export interface QueueEnqueueResponse {
  readonly _type: "queue.enqueue";
  readonly eventId: string;
  readonly instanceId: string;
  readonly instanceIndex: number;
  readonly position: number;
  readonly created: boolean;
  readonly duplicate: boolean;
}

export interface QueuePauseResponse {
  readonly _type: "queue.pause";
  readonly paused: boolean;
}

export interface QueueResumeResponse {
  readonly _type: "queue.resume";
  readonly resumed: boolean;
}

export interface QueueCancelResponse {
  readonly _type: "queue.cancel";
  readonly cancelled: boolean;
  readonly reason: "cancelled" | "not_found" | "already_processing" | "already_completed";
}

export interface QueueStatusResponse {
  readonly _type: "queue.status";
  readonly status: "processing" | "idle" | "paused" | "not_found";
  readonly pendingCount?: number;
  readonly processedCount?: number;
  readonly currentEventId?: string | null;
}

export interface QueueDrainResponse {
  readonly _type: "queue.drain";
  readonly drained: boolean;
}
