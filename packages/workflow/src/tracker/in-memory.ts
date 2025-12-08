// packages/workflow-v2/src/tracker/in-memory.ts

import { Effect, Layer, Ref } from "effect";
import type {
  InternalWorkflowEvent,
  WorkflowEventType,
} from "@durable-effect/core";
import { EventTracker, type EventTrackerService } from "./tracker";

/**
 * In-memory tracker that stores events for testing.
 */
export interface InMemoryTrackerHandle {
  /**
   * Get all recorded events.
   */
  readonly getEvents: () => Effect.Effect<InternalWorkflowEvent[]>;

  /**
   * Get events of a specific type.
   */
  readonly getEventsByType: <T extends WorkflowEventType>(
    type: T
  ) => Effect.Effect<Array<Extract<InternalWorkflowEvent, { type: T }>>>;

  /**
   * Clear all recorded events.
   */
  readonly clear: () => Effect.Effect<void>;

  /**
   * Check if a specific event type was emitted.
   */
  readonly hasEvent: (type: WorkflowEventType) => Effect.Effect<boolean>;
}

/**
 * Create an in-memory tracker for testing.
 */
export function createInMemoryTracker(): Effect.Effect<{
  service: EventTrackerService;
  handle: InMemoryTrackerHandle;
}> {
  return Effect.gen(function* () {
    const events = yield* Ref.make<InternalWorkflowEvent[]>([]);

    const service: EventTrackerService = {
      emit: (event) => Ref.update(events, (e) => [...e, event]),
      flush: () => Effect.void,
      pending: () => Ref.get(events).pipe(Effect.map((e) => e.length)),
    };

    const handle: InMemoryTrackerHandle = {
      getEvents: () => Ref.get(events),

      getEventsByType: <T extends WorkflowEventType>(type: T) =>
        Ref.get(events).pipe(
          Effect.map(
            (e) =>
              e.filter((ev) => ev.type === type) as Array<
                Extract<InternalWorkflowEvent, { type: T }>
              >
          )
        ),

      clear: () => Ref.set(events, []),

      hasEvent: (type) =>
        Ref.get(events).pipe(
          Effect.map((e) => e.some((ev) => ev.type === type))
        ),
    };

    return { service, handle };
  });
}

/**
 * Create an in-memory tracker layer.
 * Returns both the layer and a handle for test assertions.
 */
export const createInMemoryTrackerLayer = () =>
  Effect.gen(function* () {
    const { service, handle } = yield* createInMemoryTracker();
    const layer = Layer.succeed(EventTracker, service);
    return { layer, handle };
  });
