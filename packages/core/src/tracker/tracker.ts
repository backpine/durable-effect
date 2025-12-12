// packages/core/src/tracker/tracker.ts

import { Context, Effect } from "effect";

// =============================================================================
// Base Event Type
// =============================================================================

/**
 * Base tracking event interface.
 * All events must have at minimum these fields.
 * Each package (workflow, primitives) extends this with their own event types.
 */
export interface BaseTrackingEvent {
  /** Unique event ID for deduplication */
  readonly eventId: string;
  /** ISO timestamp when event occurred */
  readonly timestamp: string;
  /** Event type discriminator */
  readonly type: string;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Generic EventTracker service interface.
 *
 * Packages can use this generic interface or create their own typed version.
 * The tracker handles buffering, enrichment, and delivery to backend.
 *
 * @typeParam E - The event type, must extend BaseTrackingEvent
 */
export interface EventTrackerService<E extends BaseTrackingEvent = BaseTrackingEvent> {
  /**
   * Emit an event.
   * Events may be buffered for batch delivery.
   */
  readonly emit: (event: E) => Effect.Effect<void>;

  /**
   * Flush all buffered events.
   * Call before completion to ensure delivery.
   */
  readonly flush: () => Effect.Effect<void>;

  /**
   * Get count of pending events.
   */
  readonly pending: () => Effect.Effect<number>;
}

/**
 * Effect service tag for EventTracker.
 *
 * This is a generic tag. Packages can use this directly or create their own
 * typed tag that extends this interface.
 */
export class EventTracker extends Context.Tag("@durable-effect/EventTracker")<
  EventTracker,
  EventTrackerService
>() {}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Emit an event using the tracker from context.
 * Safe to call - does nothing if tracker not available.
 */
export const emitEvent = <E extends BaseTrackingEvent>(
  event: E,
): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(EventTracker), (option) =>
    option._tag === "Some" ? option.value.emit(event) : Effect.void,
  );

/**
 * Flush events using the tracker from context.
 * Safe to call - does nothing if tracker not available.
 */
export const flushEvents: Effect.Effect<void> = Effect.flatMap(
  Effect.serviceOption(EventTracker),
  (option) => (option._tag === "Some" ? option.value.flush() : Effect.void),
);

/**
 * Get pending event count from tracker in context.
 * Returns 0 if tracker not available.
 */
export const getPendingEvents: Effect.Effect<number> = Effect.flatMap(
  Effect.serviceOption(EventTracker),
  (option) => (option._tag === "Some" ? option.value.pending() : Effect.succeed(0)),
);
