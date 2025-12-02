/**
 * Workflow tracking events.
 *
 * These events represent all lifecycle points in a durable workflow
 * and are used by the optional event tracker service.
 *
 * All events are defined as Effect Schemas for runtime validation.
 */

import { Schema } from "effect";

// =============================================================================
// Base Event Schema
// =============================================================================

/**
 * Base event fields - all events include these.
 */
const BaseEventFields = {
  /** Unique event ID for deduplication */
  eventId: Schema.String,
  /** ISO timestamp when event occurred */
  timestamp: Schema.String,
  /** Durable Object ID */
  workflowId: Schema.String,
  /** Workflow definition name */
  workflowName: Schema.String,
};

export const BaseEventSchema = Schema.Struct(BaseEventFields);
export type BaseEvent = Schema.Schema.Type<typeof BaseEventSchema>;

// =============================================================================
// Workflow Events
// =============================================================================

/**
 * Emitted when a workflow starts execution.
 */
export const WorkflowStartedEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("workflow.started"),
  input: Schema.Unknown,
});
export type WorkflowStartedEvent = Schema.Schema.Type<typeof WorkflowStartedEventSchema>;

/**
 * Emitted when a workflow completes successfully.
 */
export const WorkflowCompletedEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("workflow.completed"),
  completedSteps: Schema.Array(Schema.String),
  durationMs: Schema.Number,
});
export type WorkflowCompletedEvent = Schema.Schema.Type<typeof WorkflowCompletedEventSchema>;

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
export const WorkflowFailedEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("workflow.failed"),
  error: WorkflowErrorSchema,
  completedSteps: Schema.Array(Schema.String),
});
export type WorkflowFailedEvent = Schema.Schema.Type<typeof WorkflowFailedEventSchema>;

/**
 * Emitted when a workflow pauses (sleep or retry).
 */
export const WorkflowPausedEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("workflow.paused"),
  reason: Schema.Literal("sleep", "retry"),
  resumeAt: Schema.optional(Schema.String),
  stepName: Schema.optional(Schema.String),
});
export type WorkflowPausedEvent = Schema.Schema.Type<typeof WorkflowPausedEventSchema>;

/**
 * Emitted when a workflow resumes from a pause.
 */
export const WorkflowResumedEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("workflow.resumed"),
});
export type WorkflowResumedEvent = Schema.Schema.Type<typeof WorkflowResumedEventSchema>;

// =============================================================================
// Step Events
// =============================================================================

/**
 * Emitted when a step starts execution.
 */
export const StepStartedEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("step.started"),
  stepName: Schema.String,
  attempt: Schema.Number,
});
export type StepStartedEvent = Schema.Schema.Type<typeof StepStartedEventSchema>;

/**
 * Emitted when a step completes successfully.
 */
export const StepCompletedEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("step.completed"),
  stepName: Schema.String,
  attempt: Schema.Number,
  durationMs: Schema.Number,
  /** True if result was returned from cache */
  cached: Schema.Boolean,
});
export type StepCompletedEvent = Schema.Schema.Type<typeof StepCompletedEventSchema>;

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
export const StepFailedEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("step.failed"),
  stepName: Schema.String,
  attempt: Schema.Number,
  error: StepErrorSchema,
  /** True if the step will be retried */
  willRetry: Schema.Boolean,
});
export type StepFailedEvent = Schema.Schema.Type<typeof StepFailedEventSchema>;

// =============================================================================
// Retry Events
// =============================================================================

/**
 * Emitted when a retry is scheduled.
 */
export const RetryScheduledEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("retry.scheduled"),
  stepName: Schema.String,
  attempt: Schema.Number,
  nextAttemptAt: Schema.String,
  delayMs: Schema.Number,
});
export type RetryScheduledEvent = Schema.Schema.Type<typeof RetryScheduledEventSchema>;

/**
 * Emitted when all retry attempts are exhausted.
 */
export const RetryExhaustedEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("retry.exhausted"),
  stepName: Schema.String,
  attempts: Schema.Number,
});
export type RetryExhaustedEvent = Schema.Schema.Type<typeof RetryExhaustedEventSchema>;

// =============================================================================
// Sleep Events
// =============================================================================

/**
 * Emitted when a sleep starts.
 */
export const SleepStartedEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("sleep.started"),
  durationMs: Schema.Number,
  resumeAt: Schema.String,
});
export type SleepStartedEvent = Schema.Schema.Type<typeof SleepStartedEventSchema>;

/**
 * Emitted when a sleep completes.
 */
export const SleepCompletedEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("sleep.completed"),
  durationMs: Schema.Number,
});
export type SleepCompletedEvent = Schema.Schema.Type<typeof SleepCompletedEventSchema>;

// =============================================================================
// Timeout Events
// =============================================================================

/**
 * Emitted when a timeout deadline is set.
 */
export const TimeoutSetEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("timeout.set"),
  stepName: Schema.String,
  deadline: Schema.String,
  timeoutMs: Schema.Number,
});
export type TimeoutSetEvent = Schema.Schema.Type<typeof TimeoutSetEventSchema>;

/**
 * Emitted when a timeout deadline is exceeded.
 */
export const TimeoutExceededEventSchema = Schema.Struct({
  ...BaseEventFields,
  type: Schema.Literal("timeout.exceeded"),
  stepName: Schema.String,
  timeoutMs: Schema.Number,
});
export type TimeoutExceededEvent = Schema.Schema.Type<typeof TimeoutExceededEventSchema>;

// =============================================================================
// Union Schema
// =============================================================================

/**
 * Schema for all possible workflow tracking events.
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
 * All possible workflow tracking events.
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
 * Create the base fields for an event.
 */
export function createBaseEvent(
  workflowId: string,
  workflowName: string,
): BaseEvent {
  return {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    workflowId,
    workflowName,
  };
}
