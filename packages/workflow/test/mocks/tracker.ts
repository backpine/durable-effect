import { Effect, Queue, Layer } from "effect";
import type { WorkflowEvent } from "@durable-effect/core";
import { EventTracker, type EventTrackerService } from "@/tracker";

/**
 * Mock tracker service that captures events for testing.
 */
export interface MockTrackerService extends EventTrackerService {
  /** Get all captured events */
  readonly getEvents: Effect.Effect<ReadonlyArray<WorkflowEvent>>;
  /** Clear captured events */
  readonly clearEvents: Effect.Effect<void>;
}

/**
 * Create a mock tracker that captures events instead of sending them.
 */
export const createMockTracker = Effect.gen(function* () {
  const events = yield* Queue.unbounded<WorkflowEvent>();

  const service: MockTrackerService = {
    emit: (event: WorkflowEvent) => Queue.offer(events, event).pipe(Effect.asVoid),
    flush: Effect.void,
    pendingCount: Queue.size(events),
    getEvents: Effect.gen(function* () {
      const all: WorkflowEvent[] = [];
      let size = yield* Queue.size(events);
      while (size > 0) {
        const event = yield* Queue.take(events);
        all.push(event);
        // Re-add to queue so events persist
        yield* Queue.offer(events, event);
        size--;
      }
      return all;
    }),
    clearEvents: Effect.gen(function* () {
      let size = yield* Queue.size(events);
      while (size > 0) {
        yield* Queue.take(events);
        size = yield* Queue.size(events);
      }
    }),
  };

  return service;
});

/**
 * Layer that provides a mock tracker service.
 */
export const MockTrackerLayer = Layer.effect(EventTracker, createMockTracker);

/**
 * Simple in-memory tracker for synchronous testing.
 */
export class SimpleEventCapture {
  readonly events: WorkflowEvent[] = [];

  createService(): EventTrackerService {
    return {
      emit: (event: WorkflowEvent) => {
        this.events.push(event);
        return Effect.void;
      },
      flush: Effect.void,
      pendingCount: Effect.succeed(this.events.length),
    };
  }

  createLayer(): Layer.Layer<EventTracker> {
    return Layer.succeed(EventTracker, this.createService());
  }

  getEventsByType<T extends WorkflowEvent["type"]>(
    type: T,
  ): Extract<WorkflowEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<
      WorkflowEvent,
      { type: T }
    >[];
  }

  clear(): void {
    this.events.length = 0;
  }
}
