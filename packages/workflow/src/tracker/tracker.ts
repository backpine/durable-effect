// packages/workflow-v2/src/tracker/tracker.ts

import { Context, Effect } from "effect";
import type { InternalWorkflowEvent } from "@durable-effect/core";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * EventTracker service interface.
 *
 * Accepts internal events (without env/serviceKey) and handles
 * enrichment and delivery to the tracking backend.
 */
export interface EventTrackerService {
  /**
   * Emit an event.
   * Events may be buffered for batch delivery.
   * The tracker will enrich with env/serviceKey before sending.
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
 * Effect service tag for EventTracker.
 */
export class EventTracker extends Context.Tag("@durable-effect/EventTracker")<
  EventTracker,
  EventTrackerService
>() {}

// =============================================================================
// Emit Helper
// =============================================================================

/**
 * Emit an event using the tracker from context.
 * Safe to call - does nothing if tracker not available.
 */
export const emitEvent = (
  event: InternalWorkflowEvent
): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(EventTracker), (option) =>
    option._tag === "Some" ? option.value.emit(event) : Effect.void
  );

/**
 * Flush events using the tracker from context.
 */
export const flushEvents: Effect.Effect<void> = Effect.flatMap(
  Effect.serviceOption(EventTracker),
  (option) => (option._tag === "Some" ? option.value.flush() : Effect.void)
);
