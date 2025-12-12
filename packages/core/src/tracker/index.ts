// packages/core/src/tracker/index.ts

// Tracker service interface
export {
  EventTracker,
  emitEvent,
  flushEvents,
  getPendingEvents,
  type EventTrackerService,
  type BaseTrackingEvent,
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
