// packages/workflow-v2/src/tracker/noop.ts

import { Effect, Layer } from "effect";
import { EventTracker, type EventTrackerService } from "./tracker";

/**
 * No-op tracker that discards all events.
 * Useful for testing or when tracking is disabled.
 */
export const noopTracker: EventTrackerService = {
  emit: () => Effect.void,
  flush: () => Effect.void,
  pending: () => Effect.succeed(0),
};

/**
 * Layer that provides a no-op tracker.
 */
export const NoopTrackerLayer = Layer.succeed(EventTracker, noopTracker);
