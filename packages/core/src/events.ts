/**
 * Tracking events for workflows and jobs.
 *
 * These events represent all lifecycle points in durable workflows and jobs
 * and are used by the optional event tracker service.
 *
 * All events are defined as Effect Schemas for runtime validation.
 *
 * There are two event formats:
 * - Internal events: Created by workflow/job code (no env/serviceKey)
 * - Wire events: Sent to tracking service (includes env/serviceKey)
 *
 * The EventTrackerService enriches internal events with env/serviceKey
 * before sending them over the wire.
 *
 * Events are distinguished by the `source` field:
 * - "workflow" - Events from the workflow package
 * - "job" - Events from the jobs package
 */

import { Schema } from "effect";
import { v7 as uuidv7 } from "uuid";

// =============================================================================
// Shared Base Fields (all events)
// =============================================================================

/**
 * Shared base fields for all tracking events.
 */
const SharedBaseFields = {
  /** Unique event ID for deduplication */
  eventId: Schema.String,
  /** ISO timestamp when event occurred */
  timestamp: Schema.String,
};

// =============================================================================
// Workflow Base Event Schema
// =============================================================================

/**
 * Internal workflow base event fields.
 * Does NOT include env/serviceKey - those are added by the tracker.
 */
const InternalWorkflowBaseFields = {
  ...SharedBaseFields,
  /** Event source discriminator */
  source: Schema.Literal("workflow"),
  /** Durable Object ID */
  workflowId: Schema.String,
  /** Workflow definition name */
  workflowName: Schema.String,
  /** Optional user-provided execution ID for correlation */
  executionId: Schema.optional(Schema.String),
};

export const InternalBaseEventSchema = Schema.Struct(InternalWorkflowBaseFields);
export type InternalBaseEvent = Schema.Schema.Type<typeof InternalBaseEventSchema>;

// =============================================================================
// Job Base Event Schema
// =============================================================================

/**
 * Job type discriminator.
 */
export type JobType = "continuous" | "debounce" | "task" | "workerPool";

/**
 * Internal job base event fields.
 * Does NOT include env/serviceKey - those are added by the tracker.
 */
const InternalJobBaseFields = {
  ...SharedBaseFields,
  /** Event source discriminator */
  source: Schema.Literal("job"),
  /** Durable Object instance ID (format: {type}:{name}:{id}) */
  instanceId: Schema.String,
  /** User-provided ID for business logic correlation */
  id: Schema.optional(Schema.String),
  /** Job type discriminator */
  jobType: Schema.Literal("continuous", "debounce", "task", "workerPool"),
  /** Job definition name */
  jobName: Schema.String,
};

export const InternalJobBaseEventSchema = Schema.Struct(InternalJobBaseFields);
export type InternalJobBaseEvent = Schema.Schema.Type<typeof InternalJobBaseEventSchema>;

// =============================================================================
// Wire Base Event Schema (sent to tracking service)
// =============================================================================

/**
 * Wire format workflow base event fields - includes env and serviceKey.
 * This is what gets sent to the external tracking service.
 */
const WireWorkflowBaseFields = {
  ...InternalWorkflowBaseFields,
  /** Environment identifier (e.g., "production", "staging") */
  env: Schema.String,
  /** User-defined service key */
  serviceKey: Schema.String,
};

export const BaseEventSchema = Schema.Struct(WireWorkflowBaseFields);
export type BaseEvent = Schema.Schema.Type<typeof BaseEventSchema>;

/**
 * Wire format job base event fields - includes env and serviceKey.
 */
const WireJobBaseFields = {
  ...InternalJobBaseFields,
  /** Environment identifier (e.g., "production", "staging") */
  env: Schema.String,
  /** User-defined service key */
  serviceKey: Schema.String,
};

// =============================================================================
// Workflow Events (Internal)
// =============================================================================

/**
 * Emitted when a workflow starts execution.
 */
export const InternalWorkflowStartedEventSchema = Schema.Struct({
  ...InternalWorkflowBaseFields,
  type: Schema.Literal("workflow.started"),
  input: Schema.Unknown,
});
export type InternalWorkflowStartedEvent = Schema.Schema.Type<typeof InternalWorkflowStartedEventSchema>;

/**
 * Emitted when a workflow is queued for async execution.
 */
export const InternalWorkflowQueuedEventSchema = Schema.Struct({
  ...InternalWorkflowBaseFields,
  type: Schema.Literal("workflow.queued"),
  input: Schema.Unknown,
});
export type InternalWorkflowQueuedEvent = Schema.Schema.Type<typeof InternalWorkflowQueuedEventSchema>;

/**
 * Emitted when a workflow completes successfully.
 */
export const InternalWorkflowCompletedEventSchema = Schema.Struct({
  ...InternalWorkflowBaseFields,
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
  ...InternalWorkflowBaseFields,
  type: Schema.Literal("workflow.failed"),
  error: WorkflowErrorSchema,
  completedSteps: Schema.Array(Schema.String),
});
export type InternalWorkflowFailedEvent = Schema.Schema.Type<typeof InternalWorkflowFailedEventSchema>;

/**
 * Emitted when a workflow pauses (sleep or retry).
 */
export const InternalWorkflowPausedEventSchema = Schema.Struct({
  ...InternalWorkflowBaseFields,
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
  ...InternalWorkflowBaseFields,
  type: Schema.Literal("workflow.resumed"),
});
export type InternalWorkflowResumedEvent = Schema.Schema.Type<typeof InternalWorkflowResumedEventSchema>;

/**
 * Emitted when a workflow is cancelled.
 */
export const InternalWorkflowCancelledEventSchema = Schema.Struct({
  ...InternalWorkflowBaseFields,
  type: Schema.Literal("workflow.cancelled"),
  reason: Schema.optional(Schema.String),
  completedSteps: Schema.Array(Schema.String),
});
export type InternalWorkflowCancelledEvent = Schema.Schema.Type<typeof InternalWorkflowCancelledEventSchema>;

// =============================================================================
// Step Events (Internal)
// =============================================================================

/**
 * Emitted when a step starts execution.
 */
export const InternalStepStartedEventSchema = Schema.Struct({
  ...InternalWorkflowBaseFields,
  type: Schema.Literal("step.started"),
  stepName: Schema.String,
  attempt: Schema.Number,
});
export type InternalStepStartedEvent = Schema.Schema.Type<typeof InternalStepStartedEventSchema>;

/**
 * Emitted when a step completes successfully.
 */
export const InternalStepCompletedEventSchema = Schema.Struct({
  ...InternalWorkflowBaseFields,
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
  ...InternalWorkflowBaseFields,
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
  ...InternalWorkflowBaseFields,
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
  ...InternalWorkflowBaseFields,
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
  ...InternalWorkflowBaseFields,
  type: Schema.Literal("sleep.started"),
  durationMs: Schema.Number,
  resumeAt: Schema.String,
});
export type InternalSleepStartedEvent = Schema.Schema.Type<typeof InternalSleepStartedEventSchema>;

/**
 * Emitted when a sleep completes.
 */
export const InternalSleepCompletedEventSchema = Schema.Struct({
  ...InternalWorkflowBaseFields,
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
  ...InternalWorkflowBaseFields,
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
  ...InternalWorkflowBaseFields,
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
  InternalWorkflowQueuedEventSchema,
  InternalWorkflowCompletedEventSchema,
  InternalWorkflowFailedEventSchema,
  InternalWorkflowPausedEventSchema,
  InternalWorkflowResumedEventSchema,
  InternalWorkflowCancelledEventSchema,
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
  ...WireWorkflowBaseFields,
  type: Schema.Literal("workflow.started"),
  input: Schema.Unknown,
});
export type WorkflowStartedEvent = Schema.Schema.Type<typeof WorkflowStartedEventSchema>;

export const WorkflowQueuedEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("workflow.queued"),
  input: Schema.Unknown,
});
export type WorkflowQueuedEvent = Schema.Schema.Type<typeof WorkflowQueuedEventSchema>;

export const WorkflowCompletedEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("workflow.completed"),
  completedSteps: Schema.Array(Schema.String),
  durationMs: Schema.Number,
});
export type WorkflowCompletedEvent = Schema.Schema.Type<typeof WorkflowCompletedEventSchema>;

export const WorkflowFailedEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("workflow.failed"),
  error: WorkflowErrorSchema,
  completedSteps: Schema.Array(Schema.String),
});
export type WorkflowFailedEvent = Schema.Schema.Type<typeof WorkflowFailedEventSchema>;

export const WorkflowPausedEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("workflow.paused"),
  reason: Schema.Literal("sleep", "retry"),
  resumeAt: Schema.optional(Schema.String),
  stepName: Schema.optional(Schema.String),
});
export type WorkflowPausedEvent = Schema.Schema.Type<typeof WorkflowPausedEventSchema>;

export const WorkflowResumedEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("workflow.resumed"),
});
export type WorkflowResumedEvent = Schema.Schema.Type<typeof WorkflowResumedEventSchema>;

export const WorkflowCancelledEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("workflow.cancelled"),
  reason: Schema.optional(Schema.String),
  completedSteps: Schema.Array(Schema.String),
});
export type WorkflowCancelledEvent = Schema.Schema.Type<typeof WorkflowCancelledEventSchema>;

export const StepStartedEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("step.started"),
  stepName: Schema.String,
  attempt: Schema.Number,
});
export type StepStartedEvent = Schema.Schema.Type<typeof StepStartedEventSchema>;

export const StepCompletedEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("step.completed"),
  stepName: Schema.String,
  attempt: Schema.Number,
  durationMs: Schema.Number,
  cached: Schema.Boolean,
});
export type StepCompletedEvent = Schema.Schema.Type<typeof StepCompletedEventSchema>;

export const StepFailedEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("step.failed"),
  stepName: Schema.String,
  attempt: Schema.Number,
  error: StepErrorSchema,
  willRetry: Schema.Boolean,
});
export type StepFailedEvent = Schema.Schema.Type<typeof StepFailedEventSchema>;

export const RetryScheduledEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("retry.scheduled"),
  stepName: Schema.String,
  attempt: Schema.Number,
  nextAttemptAt: Schema.String,
  delayMs: Schema.Number,
});
export type RetryScheduledEvent = Schema.Schema.Type<typeof RetryScheduledEventSchema>;

export const RetryExhaustedEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("retry.exhausted"),
  stepName: Schema.String,
  attempts: Schema.Number,
});
export type RetryExhaustedEvent = Schema.Schema.Type<typeof RetryExhaustedEventSchema>;

export const SleepStartedEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("sleep.started"),
  durationMs: Schema.Number,
  resumeAt: Schema.String,
});
export type SleepStartedEvent = Schema.Schema.Type<typeof SleepStartedEventSchema>;

export const SleepCompletedEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("sleep.completed"),
  durationMs: Schema.Number,
});
export type SleepCompletedEvent = Schema.Schema.Type<typeof SleepCompletedEventSchema>;

export const TimeoutSetEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
  type: Schema.Literal("timeout.set"),
  stepName: Schema.String,
  deadline: Schema.String,
  timeoutMs: Schema.Number,
});
export type TimeoutSetEvent = Schema.Schema.Type<typeof TimeoutSetEventSchema>;

export const TimeoutExceededEventSchema = Schema.Struct({
  ...WireWorkflowBaseFields,
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
  WorkflowQueuedEventSchema,
  WorkflowCompletedEventSchema,
  WorkflowFailedEventSchema,
  WorkflowPausedEventSchema,
  WorkflowResumedEventSchema,
  WorkflowCancelledEventSchema,
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
// Job Events (Internal)
// =============================================================================

/**
 * Error details schema for job failures.
 */
const JobErrorSchema = Schema.Struct({
  message: Schema.String,
  stack: Schema.optional(Schema.String),
});

/**
 * Emitted when a job instance is created/started.
 */
export const InternalJobStartedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.started"),
  /** Initial state/input provided */
  input: Schema.optional(Schema.Unknown),
});
export type InternalJobStartedEvent = Schema.Schema.Type<typeof InternalJobStartedEventSchema>;

/**
 * Emitted when a job execution runs successfully.
 */
export const InternalJobExecutedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.executed"),
  /** Run number (1-indexed) */
  runCount: Schema.Number,
  /** Execution duration in milliseconds */
  durationMs: Schema.Number,
  /** Current retry attempt (1 = first attempt) */
  attempt: Schema.Number,
});
export type InternalJobExecutedEvent = Schema.Schema.Type<typeof InternalJobExecutedEventSchema>;

/**
 * Emitted when a job execution fails.
 */
export const InternalJobFailedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.failed"),
  error: JobErrorSchema,
  /** Run number when failure occurred */
  runCount: Schema.Number,
  /** Retry attempt when failure occurred */
  attempt: Schema.Number,
  /** Whether a retry will be attempted */
  willRetry: Schema.Boolean,
});
export type InternalJobFailedEvent = Schema.Schema.Type<typeof InternalJobFailedEventSchema>;

/**
 * Emitted when job retries are exhausted.
 */
export const InternalJobRetryExhaustedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.retryExhausted"),
  /** Total attempts made */
  attempts: Schema.Number,
  /** Reason for exhaustion */
  reason: Schema.Literal("max_attempts", "max_duration"),
});
export type InternalJobRetryExhaustedEvent = Schema.Schema.Type<typeof InternalJobRetryExhaustedEventSchema>;

/**
 * Emitted when a job is terminated.
 */
export const InternalJobTerminatedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.terminated"),
  /** Termination reason */
  reason: Schema.optional(Schema.String),
  /** Total runs before termination */
  runCount: Schema.Number,
});
export type InternalJobTerminatedEvent = Schema.Schema.Type<typeof InternalJobTerminatedEventSchema>;

// =============================================================================
// Debounce-specific Events (Internal)
// =============================================================================

/**
 * Emitted when first event is received for a debounce job.
 */
export const InternalDebounceStartedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("debounce.started"),
  /** When the flush is scheduled */
  flushAt: Schema.String,
});
export type InternalDebounceStartedEvent = Schema.Schema.Type<typeof InternalDebounceStartedEventSchema>;

/**
 * Emitted when a debounce job flushes.
 */
export const InternalDebounceFlushedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("debounce.flushed"),
  /** Number of events in the batch */
  eventCount: Schema.Number,
  /** What triggered the flush */
  reason: Schema.Literal("timeout", "maxEvents", "manual"),
  /** Execution duration in milliseconds */
  durationMs: Schema.Number,
});
export type InternalDebounceFlushedEvent = Schema.Schema.Type<typeof InternalDebounceFlushedEventSchema>;

// =============================================================================
// Task-specific Events (Internal)
// =============================================================================

/**
 * Emitted when a task execution is scheduled.
 */
export const InternalTaskScheduledEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("task.scheduled"),
  /** When execution is scheduled for */
  scheduledAt: Schema.String,
  /** What triggered the schedule */
  trigger: Schema.Literal("event", "execute", "idle", "error"),
});
export type InternalTaskScheduledEvent = Schema.Schema.Type<typeof InternalTaskScheduledEventSchema>;

// =============================================================================
// Job Event Union (Internal)
// =============================================================================

/**
 * Schema for all possible internal job events.
 */
export const InternalJobEventSchema = Schema.Union(
  // Lifecycle
  InternalJobStartedEventSchema,
  InternalJobExecutedEventSchema,
  InternalJobFailedEventSchema,
  InternalJobRetryExhaustedEventSchema,
  InternalJobTerminatedEventSchema,
  // Debounce-specific
  InternalDebounceStartedEventSchema,
  InternalDebounceFlushedEventSchema,
  // Task-specific
  InternalTaskScheduledEventSchema,
);

/**
 * Internal job event type (without env/serviceKey).
 */
export type InternalJobEvent = Schema.Schema.Type<typeof InternalJobEventSchema>;

/**
 * Job event type discriminator values.
 */
export type JobEventType = InternalJobEvent["type"];

// =============================================================================
// Job Events (Wire)
// =============================================================================

export const JobStartedEventSchema = Schema.Struct({
  ...WireJobBaseFields,
  type: Schema.Literal("job.started"),
  input: Schema.optional(Schema.Unknown),
});
export type JobStartedEvent = Schema.Schema.Type<typeof JobStartedEventSchema>;

export const JobExecutedEventSchema = Schema.Struct({
  ...WireJobBaseFields,
  type: Schema.Literal("job.executed"),
  runCount: Schema.Number,
  durationMs: Schema.Number,
  attempt: Schema.Number,
});
export type JobExecutedEvent = Schema.Schema.Type<typeof JobExecutedEventSchema>;

export const JobFailedEventSchema = Schema.Struct({
  ...WireJobBaseFields,
  type: Schema.Literal("job.failed"),
  error: JobErrorSchema,
  runCount: Schema.Number,
  attempt: Schema.Number,
  willRetry: Schema.Boolean,
});
export type JobFailedEvent = Schema.Schema.Type<typeof JobFailedEventSchema>;

export const JobRetryExhaustedEventSchema = Schema.Struct({
  ...WireJobBaseFields,
  type: Schema.Literal("job.retryExhausted"),
  attempts: Schema.Number,
  reason: Schema.Literal("max_attempts", "max_duration"),
});
export type JobRetryExhaustedEvent = Schema.Schema.Type<typeof JobRetryExhaustedEventSchema>;

export const JobTerminatedEventSchema = Schema.Struct({
  ...WireJobBaseFields,
  type: Schema.Literal("job.terminated"),
  reason: Schema.optional(Schema.String),
  runCount: Schema.Number,
});
export type JobTerminatedEvent = Schema.Schema.Type<typeof JobTerminatedEventSchema>;

export const DebounceStartedEventSchema = Schema.Struct({
  ...WireJobBaseFields,
  type: Schema.Literal("debounce.started"),
  flushAt: Schema.String,
});
export type DebounceStartedEvent = Schema.Schema.Type<typeof DebounceStartedEventSchema>;

export const DebounceFlushedEventSchema = Schema.Struct({
  ...WireJobBaseFields,
  type: Schema.Literal("debounce.flushed"),
  eventCount: Schema.Number,
  reason: Schema.Literal("timeout", "maxEvents", "manual"),
  durationMs: Schema.Number,
});
export type DebounceFlushedEvent = Schema.Schema.Type<typeof DebounceFlushedEventSchema>;

export const TaskScheduledEventSchema = Schema.Struct({
  ...WireJobBaseFields,
  type: Schema.Literal("task.scheduled"),
  scheduledAt: Schema.String,
  trigger: Schema.Literal("event", "execute", "idle", "error"),
});
export type TaskScheduledEvent = Schema.Schema.Type<typeof TaskScheduledEventSchema>;

// =============================================================================
// Job Event Union (Wire)
// =============================================================================

/**
 * Schema for all possible wire job events.
 */
export const JobEventSchema = Schema.Union(
  JobStartedEventSchema,
  JobExecutedEventSchema,
  JobFailedEventSchema,
  JobRetryExhaustedEventSchema,
  JobTerminatedEventSchema,
  DebounceStartedEventSchema,
  DebounceFlushedEventSchema,
  TaskScheduledEventSchema,
);

/**
 * Wire format job event (includes env/serviceKey).
 */
export type JobEvent = Schema.Schema.Type<typeof JobEventSchema>;

// =============================================================================
// Combined Event Union (all tracking events)
// =============================================================================

/**
 * Schema for all internal tracking events (workflow + job).
 */
export const InternalTrackingEventSchema = Schema.Union(
  InternalWorkflowEventSchema,
  InternalJobEventSchema,
);

/**
 * Any internal tracking event (workflow or job).
 */
export type InternalTrackingEvent = Schema.Schema.Type<typeof InternalTrackingEventSchema>;

/**
 * Schema for all wire tracking events (workflow + job).
 */
export const TrackingEventSchema = Schema.Union(
  WorkflowEventSchema,
  JobEventSchema,
);

/**
 * Any wire tracking event (workflow or job).
 */
export type TrackingEvent = Schema.Schema.Type<typeof TrackingEventSchema>;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create the base fields for an internal workflow event.
 * Does NOT include env/serviceKey - the tracker adds those.
 *
 * @param workflowId - Durable Object ID
 * @param workflowName - Workflow definition name
 * @param executionId - Optional user-provided ID for correlation (persists across lifecycle)
 */
export function createWorkflowBaseEvent(
  workflowId: string,
  workflowName: string,
  executionId?: string,
): InternalBaseEvent {
  return {
    eventId: uuidv7(),
    timestamp: new Date().toISOString(),
    source: "workflow" as const,
    workflowId,
    workflowName,
    ...(executionId && { executionId }),
  };
}


/**
 * Create the base fields for an internal job event.
 * Does NOT include env/serviceKey - the tracker adds those.
 *
 * @param instanceId - Durable Object instance ID
 * @param jobType - The job type (continuous, debounce, task, workerPool)
 * @param jobName - Job definition name
 * @param id - Optional user-provided ID for business logic correlation
 */
export function createJobBaseEvent(
  instanceId: string,
  jobType: JobType,
  jobName: string,
  id?: string,
): InternalJobBaseEvent {
  return {
    eventId: uuidv7(),
    timestamp: new Date().toISOString(),
    source: "job" as const,
    instanceId,
    jobType,
    jobName,
    ...(id !== undefined && { id }),
  };
}

/**
 * Enrich an internal workflow event with env and serviceKey for wire transmission.
 */
export function enrichWorkflowEvent<T extends InternalWorkflowEvent>(
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


/**
 * Enrich an internal job event with env and serviceKey for wire transmission.
 */
export function enrichJobEvent<T extends InternalJobEvent>(
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
