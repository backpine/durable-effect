/**
 * Workflow tracking events.
 *
 * These events represent all lifecycle points in a durable workflow
 * and are used by the optional event tracker service.
 *
 * All events are defined as Effect Schemas for runtime validation.
 *
 * There are two event formats:
 * - Internal events: Created by workflow code (no env/serviceKey)
 * - Wire events: Sent to tracking service (includes env/serviceKey)
 *
 * The EventTrackerService enriches internal events with env/serviceKey
 * before sending them over the wire.
 */

import { Schema } from "effect";
import { v7 as uuidv7 } from "uuid";

// =============================================================================
// Internal Base Event Schema (used by workflow code)
// =============================================================================

/**
 * Internal base event fields - created by workflow code.
 * Does NOT include env/serviceKey - those are added by the tracker.
 */
const InternalBaseEventFields = {
  /** Unique event ID for deduplication */
  eventId: Schema.String,
  /** ISO timestamp when event occurred */
  timestamp: Schema.String,
  /** Durable Object ID */
  workflowId: Schema.String,
  /** Workflow definition name */
  workflowName: Schema.String,
};

export const InternalBaseEventSchema = Schema.Struct(InternalBaseEventFields);
export type InternalBaseEvent = Schema.Schema.Type<typeof InternalBaseEventSchema>;

// =============================================================================
// Wire Base Event Schema (sent to tracking service)
// =============================================================================

/**
 * Wire format base event fields - includes env and serviceKey.
 * This is what gets sent to the external tracking service.
 */
const WireBaseEventFields = {
  ...InternalBaseEventFields,
  /** Environment identifier (e.g., "production", "staging") */
  env: Schema.String,
  /** User-defined service key */
  serviceKey: Schema.String,
};

export const BaseEventSchema = Schema.Struct(WireBaseEventFields);
export type BaseEvent = Schema.Schema.Type<typeof BaseEventSchema>;

// =============================================================================
// Workflow Events (Internal)
// =============================================================================

/**
 * Emitted when a workflow starts execution.
 */
export const InternalWorkflowStartedEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("workflow.started"),
  input: Schema.Unknown,
});
export type InternalWorkflowStartedEvent = Schema.Schema.Type<typeof InternalWorkflowStartedEventSchema>;

/**
 * Emitted when a workflow completes successfully.
 */
export const InternalWorkflowCompletedEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("workflow.completed"),
  completedSteps: Schema.Array(Schema.String),
  durationMs: Schema.Number,
});
export type InternalWorkflowCompletedEvent = Schema.Schema.Type<typeof InternalWorkflowCompletedEventSchema>;

/**
 * Error details schema for workflow failures.
 */
const WorkflowErrorSchema = Schema.Struct({
  message: Schema.String,
  stack: Schema.optional(Schema.String),
  stepName: Schema.optional(Schema.String),
  attempt: Schema.optional(Schema.Number),
});

/**
 * Emitted when a workflow fails permanently.
 */
export const InternalWorkflowFailedEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("workflow.failed"),
  error: WorkflowErrorSchema,
  completedSteps: Schema.Array(Schema.String),
});
export type InternalWorkflowFailedEvent = Schema.Schema.Type<typeof InternalWorkflowFailedEventSchema>;

/**
 * Emitted when a workflow pauses (sleep or retry).
 */
export const InternalWorkflowPausedEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("workflow.paused"),
  reason: Schema.Literal("sleep", "retry"),
  resumeAt: Schema.optional(Schema.String),
  stepName: Schema.optional(Schema.String),
});
export type InternalWorkflowPausedEvent = Schema.Schema.Type<typeof InternalWorkflowPausedEventSchema>;

/**
 * Emitted when a workflow resumes from a pause.
 */
export const InternalWorkflowResumedEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("workflow.resumed"),
});
export type InternalWorkflowResumedEvent = Schema.Schema.Type<typeof InternalWorkflowResumedEventSchema>;

// =============================================================================
// Step Events (Internal)
// =============================================================================

/**
 * Emitted when a step starts execution.
 */
export const InternalStepStartedEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("step.started"),
  stepName: Schema.String,
  attempt: Schema.Number,
});
export type InternalStepStartedEvent = Schema.Schema.Type<typeof InternalStepStartedEventSchema>;

/**
 * Emitted when a step completes successfully.
 */
export const InternalStepCompletedEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("step.completed"),
  stepName: Schema.String,
  attempt: Schema.Number,
  durationMs: Schema.Number,
  /** True if result was returned from cache */
  cached: Schema.Boolean,
});
export type InternalStepCompletedEvent = Schema.Schema.Type<typeof InternalStepCompletedEventSchema>;

/**
 * Error details schema for step failures.
 */
const StepErrorSchema = Schema.Struct({
  message: Schema.String,
  stack: Schema.optional(Schema.String),
});

/**
 * Emitted when a step fails.
 */
export const InternalStepFailedEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("step.failed"),
  stepName: Schema.String,
  attempt: Schema.Number,
  error: StepErrorSchema,
  /** True if the step will be retried */
  willRetry: Schema.Boolean,
});
export type InternalStepFailedEvent = Schema.Schema.Type<typeof InternalStepFailedEventSchema>;

// =============================================================================
// Retry Events (Internal)
// =============================================================================

/**
 * Emitted when a retry is scheduled.
 */
export const InternalRetryScheduledEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("retry.scheduled"),
  stepName: Schema.String,
  attempt: Schema.Number,
  nextAttemptAt: Schema.String,
  delayMs: Schema.Number,
});
export type InternalRetryScheduledEvent = Schema.Schema.Type<typeof InternalRetryScheduledEventSchema>;

/**
 * Emitted when all retry attempts are exhausted.
 */
export const InternalRetryExhaustedEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("retry.exhausted"),
  stepName: Schema.String,
  attempts: Schema.Number,
});
export type InternalRetryExhaustedEvent = Schema.Schema.Type<typeof InternalRetryExhaustedEventSchema>;

// =============================================================================
// Sleep Events (Internal)
// =============================================================================

/**
 * Emitted when a sleep starts.
 */
export const InternalSleepStartedEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("sleep.started"),
  durationMs: Schema.Number,
  resumeAt: Schema.String,
});
export type InternalSleepStartedEvent = Schema.Schema.Type<typeof InternalSleepStartedEventSchema>;

/**
 * Emitted when a sleep completes.
 */
export const InternalSleepCompletedEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("sleep.completed"),
  durationMs: Schema.Number,
});
export type InternalSleepCompletedEvent = Schema.Schema.Type<typeof InternalSleepCompletedEventSchema>;

// =============================================================================
// Timeout Events (Internal)
// =============================================================================

/**
 * Emitted when a timeout deadline is set.
 */
export const InternalTimeoutSetEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("timeout.set"),
  stepName: Schema.String,
  deadline: Schema.String,
  timeoutMs: Schema.Number,
});
export type InternalTimeoutSetEvent = Schema.Schema.Type<typeof InternalTimeoutSetEventSchema>;

/**
 * Emitted when a timeout deadline is exceeded.
 */
export const InternalTimeoutExceededEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("timeout.exceeded"),
  stepName: Schema.String,
  timeoutMs: Schema.Number,
});
export type InternalTimeoutExceededEvent = Schema.Schema.Type<typeof InternalTimeoutExceededEventSchema>;

// =============================================================================
// Internal Union Schema (used by workflow code)
// =============================================================================

/**
 * Schema for all possible internal workflow events.
 * These are created by workflow code and don't include env/serviceKey.
 */
export const InternalWorkflowEventSchema = Schema.Union(
  // Workflow lifecycle
  InternalWorkflowStartedEventSchema,
  InternalWorkflowCompletedEventSchema,
  InternalWorkflowFailedEventSchema,
  InternalWorkflowPausedEventSchema,
  InternalWorkflowResumedEventSchema,
  // Step lifecycle
  InternalStepStartedEventSchema,
  InternalStepCompletedEventSchema,
  InternalStepFailedEventSchema,
  // Retry
  InternalRetryScheduledEventSchema,
  InternalRetryExhaustedEventSchema,
  // Sleep
  InternalSleepStartedEventSchema,
  InternalSleepCompletedEventSchema,
  // Timeout
  InternalTimeoutSetEventSchema,
  InternalTimeoutExceededEventSchema,
);

/**
 * Internal workflow event type (without env/serviceKey).
 * This is what workflow code creates.
 */
export type InternalWorkflowEvent = Schema.Schema.Type<typeof InternalWorkflowEventSchema>;

// =============================================================================
// Wire Event Schemas (sent to tracking service)
// =============================================================================

export const WorkflowStartedEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("workflow.started"),
  input: Schema.Unknown,
});
export type WorkflowStartedEvent = Schema.Schema.Type<typeof WorkflowStartedEventSchema>;

export const WorkflowCompletedEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("workflow.completed"),
  completedSteps: Schema.Array(Schema.String),
  durationMs: Schema.Number,
});
export type WorkflowCompletedEvent = Schema.Schema.Type<typeof WorkflowCompletedEventSchema>;

export const WorkflowFailedEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("workflow.failed"),
  error: WorkflowErrorSchema,
  completedSteps: Schema.Array(Schema.String),
});
export type WorkflowFailedEvent = Schema.Schema.Type<typeof WorkflowFailedEventSchema>;

export const WorkflowPausedEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("workflow.paused"),
  reason: Schema.Literal("sleep", "retry"),
  resumeAt: Schema.optional(Schema.String),
  stepName: Schema.optional(Schema.String),
});
export type WorkflowPausedEvent = Schema.Schema.Type<typeof WorkflowPausedEventSchema>;

export const WorkflowResumedEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("workflow.resumed"),
});
export type WorkflowResumedEvent = Schema.Schema.Type<typeof WorkflowResumedEventSchema>;

export const StepStartedEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("step.started"),
  stepName: Schema.String,
  attempt: Schema.Number,
});
export type StepStartedEvent = Schema.Schema.Type<typeof StepStartedEventSchema>;

export const StepCompletedEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("step.completed"),
  stepName: Schema.String,
  attempt: Schema.Number,
  durationMs: Schema.Number,
  cached: Schema.Boolean,
});
export type StepCompletedEvent = Schema.Schema.Type<typeof StepCompletedEventSchema>;

export const StepFailedEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("step.failed"),
  stepName: Schema.String,
  attempt: Schema.Number,
  error: StepErrorSchema,
  willRetry: Schema.Boolean,
});
export type StepFailedEvent = Schema.Schema.Type<typeof StepFailedEventSchema>;

export const RetryScheduledEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("retry.scheduled"),
  stepName: Schema.String,
  attempt: Schema.Number,
  nextAttemptAt: Schema.String,
  delayMs: Schema.Number,
});
export type RetryScheduledEvent = Schema.Schema.Type<typeof RetryScheduledEventSchema>;

export const RetryExhaustedEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("retry.exhausted"),
  stepName: Schema.String,
  attempts: Schema.Number,
});
export type RetryExhaustedEvent = Schema.Schema.Type<typeof RetryExhaustedEventSchema>;

export const SleepStartedEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("sleep.started"),
  durationMs: Schema.Number,
  resumeAt: Schema.String,
});
export type SleepStartedEvent = Schema.Schema.Type<typeof SleepStartedEventSchema>;

export const SleepCompletedEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("sleep.completed"),
  durationMs: Schema.Number,
});
export type SleepCompletedEvent = Schema.Schema.Type<typeof SleepCompletedEventSchema>;

export const TimeoutSetEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("timeout.set"),
  stepName: Schema.String,
  deadline: Schema.String,
  timeoutMs: Schema.Number,
});
export type TimeoutSetEvent = Schema.Schema.Type<typeof TimeoutSetEventSchema>;

export const TimeoutExceededEventSchema = Schema.Struct({
  ...WireBaseEventFields,
  type: Schema.Literal("timeout.exceeded"),
  stepName: Schema.String,
  timeoutMs: Schema.Number,
});
export type TimeoutExceededEvent = Schema.Schema.Type<typeof TimeoutExceededEventSchema>;

// =============================================================================
// Wire Union Schema
// =============================================================================

/**
 * Schema for all possible wire workflow events.
 * Uses discriminated union on the `type` field.
 */
export const WorkflowEventSchema = Schema.Union(
  // Workflow lifecycle
  WorkflowStartedEventSchema,
  WorkflowCompletedEventSchema,
  WorkflowFailedEventSchema,
  WorkflowPausedEventSchema,
  WorkflowResumedEventSchema,
  // Step lifecycle
  StepStartedEventSchema,
  StepCompletedEventSchema,
  StepFailedEventSchema,
  // Retry
  RetryScheduledEventSchema,
  RetryExhaustedEventSchema,
  // Sleep
  SleepStartedEventSchema,
  SleepCompletedEventSchema,
  // Timeout
  TimeoutSetEventSchema,
  TimeoutExceededEventSchema,
);

/**
 * Wire format workflow event (includes env/serviceKey).
 * This is what gets sent to the tracking service.
 */
export type WorkflowEvent = Schema.Schema.Type<typeof WorkflowEventSchema>;

/**
 * Event type discriminator values.
 */
export type WorkflowEventType = WorkflowEvent["type"];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create the base fields for an internal event.
 * Does NOT include env/serviceKey - the tracker adds those.
 */
export function createBaseEvent(
  workflowId: string,
  workflowName: string,
): InternalBaseEvent {
  return {
    eventId: uuidv7(),
    timestamp: new Date().toISOString(),
    workflowId,
    workflowName,
  };
}

/**
 * Enrich an internal event with env and serviceKey for wire transmission.
 */
export function enrichEvent<T extends InternalWorkflowEvent>(
  event: T,
  env: string,
  serviceKey: string,
): T & { env: string; serviceKey: string } {
  return {
    ...event,
    env,
    serviceKey,
  };
}
