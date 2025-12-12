// packages/workflow/src/tracker/tracker.ts

import { Context, Effect } from "effect";
import type { InternalWorkflowEvent } from "@durable-effect/core";

// =============================================================================
// Workflow-specific EventTracker
// =============================================================================

/**
 * Workflow-specific EventTracker service interface.
 * Uses InternalWorkflowEvent instead of generic BaseTrackingEvent.
 */
export interface EventTrackerService {
  /**
   * Emit a workflow event.
   * Events may be buffered for batch delivery.
   */
  readonly emit: (event: InternalWorkflowEvent) => Effect.Effect<void>;

  /**
   * Flush all buffered events.
   * Call before workflow completion to ensure delivery.
   */
  readonly flush: () => Effect.Effect<void>;

  /**
   * Get count of pending events.
   */
  readonly pending: () => Effect.Effect<number>;
}

/**
 * Effect service tag for workflow EventTracker.
 *
 * This is the workflow-specific tracker that uses InternalWorkflowEvent.
 * It has the same tag ID as core's EventTracker for compatibility.
 */
export class EventTracker extends Context.Tag("@durable-effect/EventTracker")<
  EventTracker,
  EventTrackerService
>() {}

// =============================================================================
// Emit Helper
// =============================================================================

/**
 * Emit a workflow event using the tracker from context.
 * Safe to call - does nothing if tracker not available.
 */
export const emitEvent = (event: InternalWorkflowEvent): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(EventTracker), (option) =>
    option._tag === "Some" ? option.value.emit(event) : Effect.void,
  );

/**
 * Flush events using the tracker from context.
 */
export const flushEvents: Effect.Effect<void> = Effect.flatMap(
  Effect.serviceOption(EventTracker),
  (option) => (option._tag === "Some" ? option.value.flush() : Effect.void),
);
