import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createBaseEvent,
  type InternalWorkflowStartedEvent,
  type InternalStepStartedEvent,
  type InternalWorkflowCompletedEvent,
} from "@durable-effect/core";
import {
  EventTracker,
  emitEvent,
  flushEvents,
  NoopTrackerLayer,
  createInMemoryTrackerLayer,
  type InMemoryTrackerHandle,
} from "../../src";

// Helper to create typed events
const createWorkflowStartedEvent = (
  base: ReturnType<typeof createBaseEvent>,
  input: unknown
): InternalWorkflowStartedEvent => ({
  ...base,
  type: "workflow.started",
  input,
});

const createStepStartedEvent = (
  base: ReturnType<typeof createBaseEvent>,
  stepName: string,
  attempt: number
): InternalStepStartedEvent => ({
  ...base,
  type: "step.started",
  stepName,
  attempt,
});

const createWorkflowCompletedEvent = (
  base: ReturnType<typeof createBaseEvent>,
  durationMs: number,
  completedSteps: string[]
): InternalWorkflowCompletedEvent => ({
  ...base,
  type: "workflow.completed",
  durationMs,
  completedSteps,
});

describe("EventTracker", () => {
  describe("createBaseEvent from core", () => {
    it("should create base event with eventId and timestamp", () => {
      const base = createBaseEvent("wf-123", "testWorkflow", "exec-456");

      expect(base.workflowId).toBe("wf-123");
      expect(base.workflowName).toBe("testWorkflow");
      expect(base.executionId).toBe("exec-456");
      expect(base.eventId).toBeDefined();
      expect(base.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("should work without executionId", () => {
      const base = createBaseEvent("wf-123", "testWorkflow");

      expect(base.workflowId).toBe("wf-123");
      expect(base.workflowName).toBe("testWorkflow");
      expect(base.executionId).toBeUndefined();
    });
  });

  describe("emitEvent helper", () => {
    it("should emit event when tracker available", async () => {
      const { layer, handle } = await Effect.runPromise(
        createInMemoryTrackerLayer()
      );

      const base = createBaseEvent("wf-123", "test");
      const event = createWorkflowStartedEvent(base, { data: 42 });

      await Effect.runPromise(emitEvent(event).pipe(Effect.provide(layer)));

      const events = await Effect.runPromise(handle.getEvents());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("workflow.started");
    });

    it("should do nothing when tracker not available", async () => {
      const base = createBaseEvent("wf-123", "test");
      const event = createWorkflowStartedEvent(base, {});

      // Should not throw
      await Effect.runPromise(emitEvent(event));
    });
  });

  describe("flushEvents helper", () => {
    it("should flush events when tracker available", async () => {
      const { layer, handle } = await Effect.runPromise(
        createInMemoryTrackerLayer()
      );

      const base = createBaseEvent("wf-123", "test");
      const event = createWorkflowStartedEvent(base, {});

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* emitEvent(event);
          yield* flushEvents;
        }).pipe(Effect.provide(layer))
      );

      const events = await Effect.runPromise(handle.getEvents());
      expect(events).toHaveLength(1);
    });

    it("should do nothing when tracker not available", async () => {
      // Should not throw
      await Effect.runPromise(flushEvents);
    });
  });

  describe("NoopTrackerLayer", () => {
    it("should discard all events", async () => {
      const base = createBaseEvent("wf-123", "test");
      const event = createWorkflowStartedEvent(base, {});

      await Effect.runPromise(
        Effect.gen(function* () {
          const tracker = yield* EventTracker;
          yield* tracker.emit(event);
          yield* tracker.emit(event);
          const pending = yield* tracker.pending();
          expect(pending).toBe(0);
        }).pipe(Effect.provide(NoopTrackerLayer))
      );
    });

    it("should have no-op flush", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const tracker = yield* EventTracker;
          yield* tracker.flush();
          // Should complete without error
        }).pipe(Effect.provide(NoopTrackerLayer))
      );
    });
  });

  describe("InMemoryTracker", () => {
    let handle: InMemoryTrackerHandle;
    let layer: Layer.Layer<EventTracker>;

    beforeEach(async () => {
      const result = await Effect.runPromise(createInMemoryTrackerLayer());
      handle = result.handle;
      layer = result.layer;
    });

    it("should record all events", async () => {
      const base = createBaseEvent("wf-123", "test");

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* emitEvent(createWorkflowStartedEvent(base, {}));
          yield* emitEvent(createStepStartedEvent(base, "step1", 1));
          yield* emitEvent(createWorkflowCompletedEvent(base, 100, ["step1"]));
        }).pipe(Effect.provide(layer))
      );

      const events = await Effect.runPromise(handle.getEvents());
      expect(events).toHaveLength(3);
    });

    it("should filter events by type", async () => {
      const base = createBaseEvent("wf-123", "test");

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* emitEvent(createWorkflowStartedEvent(base, {}));
          yield* emitEvent(createStepStartedEvent(base, "step1", 1));
          yield* emitEvent(createStepStartedEvent(base, "step2", 1));
        }).pipe(Effect.provide(layer))
      );

      const stepEvents = await Effect.runPromise(
        handle.getEventsByType("step.started")
      );
      expect(stepEvents).toHaveLength(2);
      expect(stepEvents[0].stepName).toBe("step1");
      expect(stepEvents[1].stepName).toBe("step2");
    });

    it("should check for event presence", async () => {
      const base = createBaseEvent("wf-123", "test");

      const before = await Effect.runPromise(
        handle.hasEvent("workflow.started")
      );
      expect(before).toBe(false);

      await Effect.runPromise(
        emitEvent(createWorkflowStartedEvent(base, {})).pipe(
          Effect.provide(layer)
        )
      );

      const after = await Effect.runPromise(
        handle.hasEvent("workflow.started")
      );
      expect(after).toBe(true);
    });

    it("should clear events", async () => {
      const base = createBaseEvent("wf-123", "test");

      await Effect.runPromise(
        emitEvent(createWorkflowStartedEvent(base, {})).pipe(
          Effect.provide(layer)
        )
      );

      await Effect.runPromise(handle.clear());

      const events = await Effect.runPromise(handle.getEvents());
      expect(events).toHaveLength(0);
    });

    it("should report pending count", async () => {
      const base = createBaseEvent("wf-123", "test");

      await Effect.runPromise(
        Effect.gen(function* () {
          const tracker = yield* EventTracker;

          const before = yield* tracker.pending();
          expect(before).toBe(0);

          yield* tracker.emit(createWorkflowStartedEvent(base, {}));
          yield* tracker.emit(createStepStartedEvent(base, "step1", 1));

          const after = yield* tracker.pending();
          expect(after).toBe(2);
        }).pipe(Effect.provide(layer))
      );
    });
  });
});
