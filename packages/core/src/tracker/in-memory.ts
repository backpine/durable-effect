// packages/core/src/tracker/in-memory.ts

import { Effect, Layer, Ref } from "effect";
import { EventTracker, type EventTrackerService, type BaseTrackingEvent } from "./tracker";

/**
 * Handle for accessing recorded events in tests.
 */
export interface InMemoryTrackerHandle<E extends BaseTrackingEvent = BaseTrackingEvent> {
  /**
   * Get all recorded events.
   */
  readonly getEvents: () => Effect.Effect<E[]>;

  /**
   * Get events of a specific type.
   */
  readonly getEventsByType: <T extends string>(
    type: T,
  ) => Effect.Effect<Array<Extract<E, { type: T }>>>;

  /**
   * Clear all recorded events.
   */
  readonly clear: () => Effect.Effect<void>;

  /**
   * Check if a specific event type was emitted.
   */
  readonly hasEvent: (type: string) => Effect.Effect<boolean>;
}

/**
 * Create an in-memory tracker for testing.
 *
 * @typeParam E - The event type to track
 */
export function createInMemoryTracker<E extends BaseTrackingEvent = BaseTrackingEvent>(): Effect.Effect<{
  service: EventTrackerService<E>;
  handle: InMemoryTrackerHandle<E>;
}> {
  return Effect.gen(function* () {
    const events = yield* Ref.make<E[]>([]);

    const service: EventTrackerService<E> = {
      emit: (event) => Ref.update(events, (e) => [...e, event]),
      flush: () => Effect.void,
      pending: () => Ref.get(events).pipe(Effect.map((e) => e.length)),
    };

    const handle: InMemoryTrackerHandle<E> = {
      getEvents: () => Ref.get(events),

      getEventsByType: <T extends string>(type: T) =>
        Ref.get(events).pipe(
          Effect.map(
            (e) =>
              e.filter((ev) => ev.type === type) as Array<
                Extract<E, { type: T }>
              >,
          ),
        ),

      clear: () => Ref.set(events, []),

      hasEvent: (type) =>
        Ref.get(events).pipe(
          Effect.map((e) => e.some((ev) => ev.type === type)),
        ),
    };

    return { service, handle };
  });
}

/**
 * Create an in-memory tracker layer.
 * Returns both the layer and a handle for test assertions.
 */
export const createInMemoryTrackerLayer = <E extends BaseTrackingEvent = BaseTrackingEvent>() =>
  Effect.gen(function* () {
    const { service, handle } = yield* createInMemoryTracker<E>();
    const layer = Layer.succeed(EventTracker, service as EventTrackerService);
    return { layer, handle };
  });
