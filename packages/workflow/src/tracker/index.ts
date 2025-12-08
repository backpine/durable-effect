// packages/workflow-v2/src/tracker/index.ts

// Re-export event types and helpers from core
export {
  createBaseEvent,
  enrichEvent,
  type InternalWorkflowEvent,
  type InternalBaseEvent,
  type InternalWorkflowStartedEvent,
  type InternalWorkflowQueuedEvent,
  type InternalWorkflowCompletedEvent,
  type InternalWorkflowFailedEvent,
  type InternalWorkflowPausedEvent,
  type InternalWorkflowResumedEvent,
  type InternalStepStartedEvent,
  type InternalStepCompletedEvent,
  type InternalStepFailedEvent,
  type InternalRetryScheduledEvent,
  type InternalRetryExhaustedEvent,
  type InternalSleepStartedEvent,
  type InternalSleepCompletedEvent,
  type InternalTimeoutSetEvent,
  type InternalTimeoutExceededEvent,
  type WorkflowEvent,
  type WorkflowEventType,
} from "@durable-effect/core";

// Tracker service
export {
  EventTracker,
  emitEvent,
  flushEvents,
  type EventTrackerService,
} from "./tracker";

// HTTP batch tracker
export {
  createHttpBatchTracker,
  HttpBatchTrackerLayer,
  HttpTrackerError,
  type HttpBatchTrackerConfig,
} from "./http-batch";

// No-op tracker
export { noopTracker, NoopTrackerLayer } from "./noop";

// In-memory tracker (testing)
export {
  createInMemoryTracker,
  createInMemoryTrackerLayer,
  type InMemoryTrackerHandle,
} from "./in-memory";
