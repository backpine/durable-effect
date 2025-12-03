// Service
export {
  EventTracker,
  createHttpBatchTracker,
  emitEvent,
  flushEvents,
  noopTracker,
  NoopTrackerLayer,
  type EventTrackerService,
} from "./service";

// Types
export type { EventTrackerConfig } from "./types";
