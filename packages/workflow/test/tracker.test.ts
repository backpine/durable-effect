import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import type { WorkflowEvent, WorkflowStartedEvent } from "@durable-effect/core";
import { EventTracker, emitEvent, flushEvents } from "@/tracker";
import { SimpleEventCapture } from "./mocks";

describe("EventTracker", () => {
  describe("emitEvent helper", () => {
    it("emits event when tracker is provided", async () => {
      const capture = new SimpleEventCapture();
      const event: WorkflowStartedEvent = {
        eventId: "evt-1",
        timestamp: new Date().toISOString(),
        workflowId: "wf-1",
        workflowName: "test",
        type: "workflow.started",
        input: { foo: "bar" },
      };

      const effect = emitEvent(event).pipe(Effect.provide(capture.createLayer()));

      await Effect.runPromise(effect);

      expect(capture.events).toHaveLength(1);
      expect(capture.events[0]).toEqual(event);
    });

    it("is a no-op when tracker is not provided", async () => {
      const event: WorkflowStartedEvent = {
        eventId: "evt-1",
        timestamp: new Date().toISOString(),
        workflowId: "wf-1",
        workflowName: "test",
        type: "workflow.started",
        input: {},
      };

      // Should not throw when no tracker is provided
      await Effect.runPromise(emitEvent(event));
    });

    it("emits multiple events in sequence", async () => {
      const capture = new SimpleEventCapture();
      const events: WorkflowEvent[] = [
        {
          eventId: "evt-1",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "workflow.started",
          input: {},
        },
        {
          eventId: "evt-2",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "step.started",
          stepName: "step1",
          attempt: 0,
        },
        {
          eventId: "evt-3",
          timestamp: new Date().toISOString(),
          workflowId: "wf-1",
          workflowName: "test",
          type: "step.completed",
          stepName: "step1",
          attempt: 0,
          durationMs: 100,
          cached: false,
        },
      ];

      const effect = Effect.gen(function* () {
        for (const event of events) {
          yield* emitEvent(event);
        }
      }).pipe(Effect.provide(capture.createLayer()));

      await Effect.runPromise(effect);

      expect(capture.events).toHaveLength(3);
      expect(capture.events.map((e) => e.type)).toEqual([
        "workflow.started",
        "step.started",
        "step.completed",
      ]);
    });
  });

  describe("flushEvents helper", () => {
    it("flushes when tracker is provided", async () => {
      const capture = new SimpleEventCapture();
      let flushed = false;

      const trackerWithFlush = Layer.succeed(EventTracker, {
        emit: () => Effect.void,
        flush: Effect.sync(() => {
          flushed = true;
        }),
        pendingCount: Effect.succeed(0),
      });

      await Effect.runPromise(flushEvents.pipe(Effect.provide(trackerWithFlush)));

      expect(flushed).toBe(true);
    });

    it("is a no-op when tracker is not provided", async () => {
      // Should not throw
      await Effect.runPromise(flushEvents);
    });
  });

  describe("SimpleEventCapture", () => {
    let capture: SimpleEventCapture;

    beforeEach(() => {
      capture = new SimpleEventCapture();
    });

    it("captures events by type", async () => {
      const events: WorkflowEvent[] = [
        {
          eventId: "1",
          timestamp: "",
          workflowId: "wf",
          workflowName: "test",
          type: "workflow.started",
          input: {},
        },
        {
          eventId: "2",
          timestamp: "",
          workflowId: "wf",
          workflowName: "test",
          type: "step.started",
          stepName: "s1",
          attempt: 0,
        },
        {
          eventId: "3",
          timestamp: "",
          workflowId: "wf",
          workflowName: "test",
          type: "step.completed",
          stepName: "s1",
          attempt: 0,
          durationMs: 50,
          cached: false,
        },
        {
          eventId: "4",
          timestamp: "",
          workflowId: "wf",
          workflowName: "test",
          type: "step.started",
          stepName: "s2",
          attempt: 0,
        },
      ];

      for (const event of events) {
        capture.events.push(event);
      }

      const stepStarted = capture.getEventsByType("step.started");
      expect(stepStarted).toHaveLength(2);
      expect(stepStarted[0].stepName).toBe("s1");
      expect(stepStarted[1].stepName).toBe("s2");

      const workflowStarted = capture.getEventsByType("workflow.started");
      expect(workflowStarted).toHaveLength(1);
    });

    it("clears events", () => {
      capture.events.push({
        eventId: "1",
        timestamp: "",
        workflowId: "wf",
        workflowName: "test",
        type: "workflow.started",
        input: {},
      });

      expect(capture.events).toHaveLength(1);
      capture.clear();
      expect(capture.events).toHaveLength(0);
    });
  });
});
