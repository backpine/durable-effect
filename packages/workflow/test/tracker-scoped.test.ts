/**
 * Tests for tracker events using Layer.scoped (matching production behavior).
 *
 * These tests expose the bug where events are lost because:
 * 1. Each Effect.runPromise creates a new scope
 * 2. The scoped tracker is recreated for each call
 * 3. Events are lost when the scope closes before batch can send
 *
 * Unlike other tests that use SimpleEventCapture (Layer.succeed),
 * these tests use Layer.scoped to match production behavior.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer, Queue, Scope, Chunk, Fiber, Duration } from "effect";
import type { InternalWorkflowEvent } from "@durable-effect/core";
import { EventTracker, emitEvent, type EventTrackerService } from "@/tracker";

/**
 * Shared event store that persists outside Effect scopes.
 * This allows us to verify what events were actually captured
 * even after scopes close.
 */
class ExternalEventStore {
  readonly events: InternalWorkflowEvent[] = [];

  push(event: InternalWorkflowEvent): void {
    this.events.push(event);
  }

  clear(): void {
    this.events.length = 0;
  }

  getByType<T extends InternalWorkflowEvent["type"]>(
    type: T,
  ): Extract<InternalWorkflowEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<
      InternalWorkflowEvent,
      { type: T }
    >[];
  }
}

/**
 * Creates a scoped tracker that mimics production behavior.
 * Uses Layer.scoped with a finalizer, just like createHttpBatchTracker.
 *
 * Events are only "sent" (pushed to external store) when:
 * 1. flush is called, OR
 * 2. The scope closes (finalizer runs)
 */
function createScopedMockTracker(
  externalStore: ExternalEventStore,
): Effect.Effect<EventTrackerService, never, Scope.Scope> {
  return Effect.gen(function* () {
    // Internal queue (like production) - events buffered here
    const eventQueue = yield* Queue.unbounded<InternalWorkflowEvent>();

    // Flush events to external store
    const flushToStore = Effect.gen(function* () {
      const events = yield* Queue.takeAll(eventQueue);
      if (Chunk.size(events) > 0) {
        for (const event of Chunk.toReadonlyArray(events)) {
          externalStore.push(event);
        }
      }
    });

    // Register finalizer to flush on scope close (like production)
    yield* Effect.addFinalizer(() => flushToStore);

    // Return service that queues events (like production)
    return {
      emit: (event: InternalWorkflowEvent) =>
        Queue.offer(eventQueue, event).pipe(Effect.asVoid),
      flush: flushToStore,
      pendingCount: Queue.size(eventQueue),
    };
  });
}

/**
 * Creates a scoped tracker that EXACTLY mimics production behavior.
 * Includes a background consumer fiber that causes the race condition.
 *
 * This is the pattern from createHttpBatchTracker in service.ts:
 * - Background consumer takes events from queue
 * - Consumer waits for batch timeout before sending
 * - Finalizer tries to takeAll but events already taken by consumer
 * - Consumer gets interrupted before it can send
 * - Events LOST
 */
function createProductionLikeScopedTracker(
  externalStore: ExternalEventStore,
  options: { batchWaitMs?: number } = {},
): Effect.Effect<EventTrackerService, never, Scope.Scope> {
  const batchWaitMs = options.batchWaitMs ?? 1000; // Default 1 second like production

  return Effect.gen(function* () {
    const eventQueue = yield* Queue.unbounded<InternalWorkflowEvent>();
    const flushSignal = yield* Queue.unbounded<void>();

    // Send batch to external store (like HTTP POST in production)
    const sendBatch = (events: ReadonlyArray<InternalWorkflowEvent>) =>
      Effect.sync(() => {
        for (const event of events) {
          externalStore.push(event);
        }
      });

    // Background consumer - EXACTLY like production
    // Takes events, waits for batch, then sends
    const consumer = Effect.gen(function* () {
      while (true) {
        // Wait for first event (blocks until available)
        const firstEvent = yield* Queue.take(eventQueue);
        const batch: InternalWorkflowEvent[] = [firstEvent];

        // Wait for more events or timeout (like production's maxWaitMs)
        const result = yield* Effect.raceAll([
          Queue.take(eventQueue).pipe(
            Effect.map((e) => ({ _tag: "event" as const, event: e })),
          ),
          Queue.take(flushSignal).pipe(
            Effect.map(() => ({ _tag: "flush" as const })),
          ),
          Effect.sleep(Duration.millis(batchWaitMs)).pipe(
            Effect.map(() => ({ _tag: "timeout" as const })),
          ),
        ]);

        if (result._tag === "event") {
          batch.push(result.event);
        }

        // Send batch
        yield* sendBatch(batch);
      }
    });

    // Fork background consumer (like production)
    const consumerFiber = yield* Effect.fork(consumer);

    // Finalizer - EXACTLY like production
    // This is where the race condition happens!
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Signal flush
        yield* Queue.offer(flushSignal, undefined);

        // Try to take remaining events - BUT consumer may have already taken them!
        const remaining = yield* Queue.takeAll(eventQueue);
        if (Chunk.size(remaining) > 0) {
          yield* sendBatch(Chunk.toReadonlyArray(remaining));
        }

        // Shutdown
        yield* Queue.shutdown(eventQueue);
        yield* Queue.shutdown(flushSignal);
        yield* Fiber.interrupt(consumerFiber); // Consumer interrupted before sending!
      }),
    );

    return {
      emit: (event: InternalWorkflowEvent) =>
        Queue.offer(eventQueue, event).pipe(Effect.asVoid),
      flush: Queue.offer(flushSignal, undefined).pipe(Effect.asVoid),
      pendingCount: Queue.size(eventQueue),
    };
  });
}

/**
 * Creates a Layer.scoped tracker layer (matching production pattern).
 */
function createScopedTrackerLayer(
  externalStore: ExternalEventStore,
): Layer.Layer<EventTracker> {
  return Layer.scoped(EventTracker, createScopedMockTracker(externalStore));
}

/**
 * Creates a production-like Layer.scoped tracker layer.
 * Includes background consumer fiber that causes the race condition.
 */
function createProductionLikeTrackerLayer(
  externalStore: ExternalEventStore,
  options?: { batchWaitMs?: number },
): Layer.Layer<EventTracker> {
  return Layer.scoped(
    EventTracker,
    createProductionLikeScopedTracker(externalStore, options),
  );
}

describe("Tracker with Layer.scoped (production pattern)", () => {
  let externalStore: ExternalEventStore;
  let scopedLayer: Layer.Layer<EventTracker>;

  beforeEach(() => {
    externalStore = new ExternalEventStore();
    scopedLayer = createScopedTrackerLayer(externalStore);
  });

  describe("single Effect.runPromise call", () => {
    it("should capture events when emitted in a single scoped execution", async () => {
      // Single Effect.runPromise with scoped layer - this SHOULD work
      const effect = Effect.gen(function* () {
        yield* emitEvent({
          eventId: "1",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "workflow.started",
          input: {},
        });
      }).pipe(Effect.provide(scopedLayer));

      await Effect.runPromise(effect);

      // Events should be flushed when scope closes
      expect(externalStore.events).toHaveLength(1);
      expect(externalStore.events[0].type).toBe("workflow.started");
    });

    it("should capture multiple events in single execution", async () => {
      const effect = Effect.gen(function* () {
        yield* emitEvent({
          eventId: "1",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "workflow.started",
          input: {},
        });
        yield* emitEvent({
          eventId: "2",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "step.started",
          stepName: "step1",
          attempt: 0,
        });
        yield* emitEvent({
          eventId: "3",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "step.completed",
          stepName: "step1",
          attempt: 0,
          durationMs: 100,
          cached: false,
        });
        yield* emitEvent({
          eventId: "4",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "workflow.completed",
          completedSteps: ["step1"],
          durationMs: 100,
        });
      }).pipe(Effect.provide(scopedLayer));

      await Effect.runPromise(effect);

      expect(externalStore.events).toHaveLength(4);
      expect(externalStore.getByType("workflow.started")).toHaveLength(1);
      expect(externalStore.getByType("step.started")).toHaveLength(1);
      expect(externalStore.getByType("step.completed")).toHaveLength(1);
      expect(externalStore.getByType("workflow.completed")).toHaveLength(1);
    });
  });

  describe("multiple Effect.runPromise calls (production pattern)", () => {
    /**
     * THIS TEST EXPOSES THE BUG
     *
     * In production, engine.ts does:
     *   await Effect.runPromise(this.#withTracker(setupEffect));      // workflow.started
     *   await Effect.runPromise(workflowEffect);                       // step events
     *   await Effect.runPromise(this.#withTracker(completedEffect));  // workflow.completed
     *
     * Each call creates a NEW tracker instance with its own queue.
     * Events from one call are NOT available in the next call's tracker.
     */
    it("should capture events across multiple Effect.runPromise calls", async () => {
      // Simulates engine.ts run() method pattern:
      // First call - emit workflow.started
      const setupEffect = Effect.gen(function* () {
        yield* emitEvent({
          eventId: "1",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "workflow.started",
          input: {},
        });
      }).pipe(Effect.provide(scopedLayer));

      await Effect.runPromise(setupEffect);

      // Second call - emit step events (simulates workflowEffect)
      const workflowEffect = Effect.gen(function* () {
        yield* emitEvent({
          eventId: "2",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "step.started",
          stepName: "step1",
          attempt: 0,
        });
        yield* emitEvent({
          eventId: "3",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "step.completed",
          stepName: "step1",
          attempt: 0,
          durationMs: 100,
          cached: false,
        });
      }).pipe(Effect.provide(scopedLayer));

      await Effect.runPromise(workflowEffect);

      // Third call - emit workflow.completed
      const completedEffect = Effect.gen(function* () {
        yield* emitEvent({
          eventId: "4",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "workflow.completed",
          completedSteps: ["step1"],
          durationMs: 100,
        });
      }).pipe(Effect.provide(scopedLayer));

      await Effect.runPromise(completedEffect);

      // EXPECTATION: All 4 events should be captured
      // REALITY (BUG): Each runPromise creates a new tracker, events may be lost
      expect(externalStore.events).toHaveLength(4);
      expect(externalStore.getByType("workflow.started")).toHaveLength(1);
      expect(externalStore.getByType("step.started")).toHaveLength(1);
      expect(externalStore.getByType("step.completed")).toHaveLength(1);
      expect(externalStore.getByType("workflow.completed")).toHaveLength(1);
    });

    it("should preserve event order across multiple calls", async () => {
      // First call
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* emitEvent({
            eventId: "1",
            timestamp: new Date().toISOString(),
            workflowId: "wf-1",
            workflowName: "test",
            type: "workflow.started",
            input: {},
          });
        }).pipe(Effect.provide(scopedLayer)),
      );

      // Second call
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* emitEvent({
            eventId: "2",
            timestamp: new Date().toISOString(),
            workflowId: "wf-1",
            workflowName: "test",
            type: "step.started",
            stepName: "step1",
            attempt: 0,
          });
        }).pipe(Effect.provide(scopedLayer)),
      );

      // Third call
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* emitEvent({
            eventId: "3",
            timestamp: new Date().toISOString(),
            workflowId: "wf-1",
            workflowName: "test",
            type: "workflow.completed",
            completedSteps: ["step1"],
            durationMs: 100,
          });
        }).pipe(Effect.provide(scopedLayer)),
      );

      // Events should be in order
      expect(externalStore.events.map((e) => e.type)).toEqual([
        "workflow.started",
        "step.started",
        "workflow.completed",
      ]);
    });
  });

  describe("Layer.scoped vs Layer.succeed behavior", () => {
    it("Layer.succeed should work with multiple runPromise calls", async () => {
      // This is what current tests use - Layer.succeed doesn't have scope issues
      const sharedEvents: InternalWorkflowEvent[] = [];
      const succeedLayer = Layer.succeed(EventTracker, {
        emit: (event: InternalWorkflowEvent) => {
          sharedEvents.push(event);
          return Effect.void;
        },
        flush: Effect.void,
        pendingCount: Effect.succeed(sharedEvents.length),
      });

      // Multiple calls all write to same shared array
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* emitEvent({
            eventId: "1",
            timestamp: new Date().toISOString(),
            workflowId: "wf-1",
            workflowName: "test",
            type: "workflow.started",
            input: {},
          });
        }).pipe(Effect.provide(succeedLayer)),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* emitEvent({
            eventId: "2",
            timestamp: new Date().toISOString(),
            workflowId: "wf-1",
            workflowName: "test",
            type: "workflow.completed",
            completedSteps: [],
            durationMs: 100,
          });
        }).pipe(Effect.provide(succeedLayer)),
      );

      // Layer.succeed works because it's not scoped - same instance shared
      expect(sharedEvents).toHaveLength(2);
    });

    it("Layer.scoped creates new instance per provide", async () => {
      // Track how many times the tracker is created
      let creationCount = 0;

      const countingLayer = Layer.scoped(
        EventTracker,
        Effect.gen(function* () {
          creationCount++;
          const queue = yield* Queue.unbounded<InternalWorkflowEvent>();

          yield* Effect.addFinalizer(() =>
            Queue.takeAll(queue).pipe(
              Effect.flatMap((events) => {
                for (const e of Chunk.toReadonlyArray(events)) {
                  externalStore.push(e);
                }
                return Effect.void;
              }),
            ),
          );

          return {
            emit: (event: InternalWorkflowEvent) =>
              Queue.offer(queue, event).pipe(Effect.asVoid),
            flush: Effect.void,
            pendingCount: Queue.size(queue),
          };
        }),
      );

      // First runPromise
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* emitEvent({
            eventId: "1",
            timestamp: new Date().toISOString(),
            workflowId: "wf-1",
            workflowName: "test",
            type: "workflow.started",
            input: {},
          });
        }).pipe(Effect.provide(countingLayer)),
      );

      // Second runPromise
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* emitEvent({
            eventId: "2",
            timestamp: new Date().toISOString(),
            workflowId: "wf-1",
            workflowName: "test",
            type: "workflow.completed",
            completedSteps: [],
            durationMs: 100,
          });
        }).pipe(Effect.provide(countingLayer)),
      );

      // Each Effect.runPromise with Layer.scoped creates a NEW tracker instance
      // This is the root cause of the bug!
      expect(creationCount).toBe(2);

      // Events should still be captured (via finalizer), but they went to DIFFERENT instances
      expect(externalStore.events).toHaveLength(2);
    });
  });
});

/**
 * Tests that demonstrate the scoped layer race condition.
 *
 * These use createProductionLikeTrackerLayer which includes a background
 * consumer fiber that causes a race condition when used with MULTIPLE
 * Effect.runPromise calls:
 *
 * 1. emit() adds event to queue
 * 2. Consumer fiber takes event from queue (queue now empty)
 * 3. Effect completes, scope closes
 * 4. Finalizer calls takeAll() - gets nothing (consumer already took it)
 * 5. Finalizer interrupts consumer fiber
 * 6. Event is in consumer's local batch variable - LOST FOREVER
 *
 * The FIX (implemented in engine.ts) is to use a SINGLE scoped execution
 * per workflow run, so all events go to the same tracker instance.
 *
 * These tests document the problematic pattern for understanding.
 */
describe("Tracker with production-like batching (documents race condition)", () => {
  let externalStore: ExternalEventStore;
  let productionLayer: Layer.Layer<EventTracker>;

  beforeEach(() => {
    externalStore = new ExternalEventStore();
    // Use short batch wait to speed up tests, but still demonstrates the race
    productionLayer = createProductionLikeTrackerLayer(externalStore, {
      batchWaitMs: 100,
    });
  });

  it("should capture events in single execution (baseline)", async () => {
    // Single execution should work because scope stays open long enough
    const effect = Effect.gen(function* () {
      yield* emitEvent({
        eventId: "1",
        timestamp: new Date().toISOString(),
        workflowId: "wf-1",
        workflowName: "test",
        type: "workflow.started",
        input: {},
      });
      yield* emitEvent({
        eventId: "2",
        timestamp: new Date().toISOString(),
        workflowId: "wf-1",
        workflowName: "test",
        type: "workflow.completed",
        completedSteps: [],
        durationMs: 100,
      });

      // Wait for batch to be sent (give consumer time)
      yield* Effect.sleep(Duration.millis(150));
    }).pipe(Effect.provide(productionLayer));

    await Effect.runPromise(effect);

    // Both events should be captured
    expect(externalStore.events).toHaveLength(2);
  });

  it.skip("DOCUMENTED BUG: events lost with multiple Effect.runPromise calls", async () => {
    /**
     * THIS TEST DOCUMENTS THE BUG THAT WAS FIXED IN engine.ts
     *
     * The pattern shown here (multiple Effect.runPromise with scoped layers) loses events.
     * It is skipped because we no longer use this pattern in production.
     *
     * Each runPromise:
     * 1. Creates new tracker with new queue and consumer
     * 2. Event emitted to queue
     * 3. Consumer takes event
     * 4. Scope closes immediately (effect is fast)
     * 5. Finalizer can't get event (consumer has it)
     * 6. Consumer interrupted before sending
     * 7. Event LOST
     *
     * FIX: Use single scoped execution per workflow (see engine.ts run() method)
     */

    // First call - workflow.started
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* emitEvent({
          eventId: "1",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "workflow.started",
          input: {},
        });
        // Yield to let consumer fiber take the event
        yield* Effect.yieldNow();
      }).pipe(Effect.provide(productionLayer)),
    );

    // Second call - step events
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* emitEvent({
          eventId: "2",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "step.started",
          stepName: "step1",
          attempt: 0,
        });
        yield* Effect.yieldNow();
        yield* emitEvent({
          eventId: "3",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "step.completed",
          stepName: "step1",
          attempt: 0,
          durationMs: 50,
          cached: false,
        });
        yield* Effect.yieldNow();
      }).pipe(Effect.provide(productionLayer)),
    );

    // Third call - workflow.completed
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* emitEvent({
          eventId: "4",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "workflow.completed",
          completedSteps: ["step1"],
          durationMs: 100,
        });
        yield* Effect.yieldNow();
      }).pipe(Effect.provide(productionLayer)),
    );

    // EXPECTATION: All 4 events captured
    // REALITY with this pattern: Events are lost due to race condition
    //
    // This test is skipped because we no longer use this pattern.
    // The fix (single scoped execution in engine.ts) avoids this problem entirely.
    expect(externalStore.events).toHaveLength(4);
    expect(externalStore.getByType("workflow.started")).toHaveLength(1);
    expect(externalStore.getByType("step.started")).toHaveLength(1);
    expect(externalStore.getByType("step.completed")).toHaveLength(1);
    expect(externalStore.getByType("workflow.completed")).toHaveLength(1);
  });

  it.skip("DOCUMENTED BUG: even single event lost with short-lived scope", async () => {
    /**
     * THIS TEST DOCUMENTS THE BUG THAT WAS FIXED IN engine.ts
     *
     * Even a single event can be lost if the scope closes before
     * the consumer can send the batch.
     *
     * The yieldNow() lets the consumer fiber take the event from the queue.
     * Then when the scope closes, the finalizer's takeAll() finds an empty queue.
     * The consumer is interrupted before it can send.
     *
     * FIX: Use single scoped execution with explicit flushEvents call (see engine.ts)
     */

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* emitEvent({
          eventId: "1",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "workflow.started",
          input: {},
        });
        // Yield to let consumer take the event from queue
        yield* Effect.yieldNow();
        // Scope closes immediately - consumer has event but hasn't sent yet
      }).pipe(Effect.provide(productionLayer)),
    );

    // Event should be captured
    expect(externalStore.events).toHaveLength(1);
    expect(externalStore.events[0].type).toBe("workflow.started");
  });
});
