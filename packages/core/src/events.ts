/**
 * Workflow tracking events.
 *
 * These events represent all lifecycle points in a durable workflow
 * and are used by the optional event tracker service.
 */

// =============================================================================
// Base Event
// =============================================================================

/**
 * Base event shape - all events include these fields.
 */
export interface BaseEvent {
  /** Unique event ID for deduplication */
  readonly eventId: string;
  /** ISO timestamp when event occurred */
  readonly timestamp: string;
  /** Durable Object ID */
  readonly workflowId: string;
  /** Workflow definition name */
  readonly workflowName: string;
}

// =============================================================================
// Workflow Events
// =============================================================================

/**
 * Emitted when a workflow starts execution.
 */
export interface WorkflowStartedEvent extends BaseEvent {
  readonly type: "workflow.started";
  readonly input: unknown;
}

/**
 * Emitted when a workflow completes successfully.
 */
export interface WorkflowCompletedEvent extends BaseEvent {
  readonly type: "workflow.completed";
  readonly completedSteps: ReadonlyArray<string>;
  readonly durationMs: number;
}

/**
 * Emitted when a workflow fails permanently.
 */
export interface WorkflowFailedEvent extends BaseEvent {
  readonly type: "workflow.failed";
  readonly error: {
    readonly message: string;
    readonly stack?: string;
    readonly stepName?: string;
    readonly attempt?: number;
  };
  readonly completedSteps: ReadonlyArray<string>;
}

/**
 * Emitted when a workflow pauses (sleep or retry).
 */
export interface WorkflowPausedEvent extends BaseEvent {
  readonly type: "workflow.paused";
  readonly reason: "sleep" | "retry";
  readonly resumeAt?: string;
  readonly stepName?: string;
}

/**
 * Emitted when a workflow resumes from a pause.
 */
export interface WorkflowResumedEvent extends BaseEvent {
  readonly type: "workflow.resumed";
}

// =============================================================================
// Step Events
// =============================================================================

/**
 * Emitted when a step starts execution.
 */
export interface StepStartedEvent extends BaseEvent {
  readonly type: "step.started";
  readonly stepName: string;
  readonly attempt: number;
}

/**
 * Emitted when a step completes successfully.
 */
export interface StepCompletedEvent extends BaseEvent {
  readonly type: "step.completed";
  readonly stepName: string;
  readonly attempt: number;
  readonly durationMs: number;
  /** True if result was returned from cache */
  readonly cached: boolean;
}

/**
 * Emitted when a step fails.
 */
export interface StepFailedEvent extends BaseEvent {
  readonly type: "step.failed";
  readonly stepName: string;
  readonly attempt: number;
  readonly error: {
    readonly message: string;
    readonly stack?: string;
  };
  /** True if the step will be retried */
  readonly willRetry: boolean;
}

// =============================================================================
// Retry Events
// =============================================================================

/**
 * Emitted when a retry is scheduled.
 */
export interface RetryScheduledEvent extends BaseEvent {
  readonly type: "retry.scheduled";
  readonly stepName: string;
  readonly attempt: number;
  readonly nextAttemptAt: string;
  readonly delayMs: number;
}

/**
 * Emitted when all retry attempts are exhausted.
 */
export interface RetryExhaustedEvent extends BaseEvent {
  readonly type: "retry.exhausted";
  readonly stepName: string;
  readonly attempts: number;
}

// =============================================================================
// Sleep Events
// =============================================================================

/**
 * Emitted when a sleep starts.
 */
export interface SleepStartedEvent extends BaseEvent {
  readonly type: "sleep.started";
  readonly durationMs: number;
  readonly resumeAt: string;
}

/**
 * Emitted when a sleep completes.
 */
export interface SleepCompletedEvent extends BaseEvent {
  readonly type: "sleep.completed";
  readonly durationMs: number;
}

// =============================================================================
// Timeout Events
// =============================================================================

/**
 * Emitted when a timeout deadline is set.
 */
export interface TimeoutSetEvent extends BaseEvent {
  readonly type: "timeout.set";
  readonly stepName: string;
  readonly deadline: string;
  readonly timeoutMs: number;
}

/**
 * Emitted when a timeout deadline is exceeded.
 */
export interface TimeoutExceededEvent extends BaseEvent {
  readonly type: "timeout.exceeded";
  readonly stepName: string;
  readonly timeoutMs: number;
}

// =============================================================================
// Union Type
// =============================================================================

/**
 * All possible workflow tracking events.
 */
export type WorkflowEvent =
  // Workflow lifecycle
  | WorkflowStartedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | WorkflowPausedEvent
  | WorkflowResumedEvent
  // Step lifecycle
  | StepStartedEvent
  | StepCompletedEvent
  | StepFailedEvent
  // Retry
  | RetryScheduledEvent
  | RetryExhaustedEvent
  // Sleep
  | SleepStartedEvent
  | SleepCompletedEvent
  // Timeout
  | TimeoutSetEvent
  | TimeoutExceededEvent;

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
