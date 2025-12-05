import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "effect";
import { Workflow } from "@/workflow";
import { createWorkflowHarness } from "../harness";
import { SimpleEventCapture } from "../mocks";

describe("Workflow Tracker Events", () => {
  let eventCapture: SimpleEventCapture;

  beforeEach(() => {
    eventCapture = new SimpleEventCapture();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ============================================================
  // Step Events
  // ============================================================

  describe("step events", () => {
    it("emits step.started and step.completed on successful step", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step("myStep", Effect.succeed("result"));
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });
      await harness.run(undefined);

      const started = eventCapture.getEventsByType("step.started");
      const completed = eventCapture.getEventsByType("step.completed");

      expect(started).toHaveLength(1);
      expect(started[0].stepName).toBe("myStep");
      expect(started[0].attempt).toBe(0);

      expect(completed).toHaveLength(1);
      expect(completed[0].stepName).toBe("myStep");
      expect(completed[0].attempt).toBe(0);
      expect(completed[0].cached).toBe(false);
      expect(completed[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("emits step.completed with cached=true on replay", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step("cachedStep", Effect.succeed("data"));
          yield* Workflow.sleep("1 second");
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });

      // First run - step executes and sleeps
      await harness.run(undefined);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

      eventCapture.clear();

      // Resume - step should be cached
      vi.setSystemTime(1000);
      await harness.triggerAlarm();

      const completed = eventCapture.getEventsByType("step.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].stepName).toBe("cachedStep");
      expect(completed[0].cached).toBe(true);
    });

    it("emits step.failed when step fails without retry", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step("failingStep", Effect.fail(new Error("oops")));
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });
      await harness.run(undefined);

      const failed = eventCapture.getEventsByType("step.failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].stepName).toBe("failingStep");
      expect(failed[0].attempt).toBe(0);
      expect(failed[0].error.message).toBe("oops");
      expect(failed[0].willRetry).toBe(false);
    });

    it("emits events for multiple steps in sequence", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step("step1", Effect.succeed(1));
          yield* Workflow.step("step2", Effect.succeed(2));
          yield* Workflow.step("step3", Effect.succeed(3));
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });
      await harness.run(undefined);

      const started = eventCapture.getEventsByType("step.started");
      const completed = eventCapture.getEventsByType("step.completed");

      expect(started).toHaveLength(3);
      expect(started.map((e) => e.stepName)).toEqual(["step1", "step2", "step3"]);

      expect(completed).toHaveLength(3);
      expect(completed.map((e) => e.stepName)).toEqual(["step1", "step2", "step3"]);
    });
  });

  // ============================================================
  // Retry Events
  // ============================================================

  describe("retry events", () => {
    it("emits retry.scheduled when step fails and retry is pending", async () => {
      let attempts = 0;

      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "retryStep",
            Effect.gen(function* () {
              attempts++;
              if (attempts < 3) {
                return yield* Effect.fail(new Error("temp"));
              }
              return "ok";
            }).pipe(Workflow.retry({ maxAttempts: 5, delay: "2 seconds" })),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });

      // First attempt - fails, schedules retry
      await harness.run(undefined);

      const scheduled = eventCapture.getEventsByType("retry.scheduled");
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0].stepName).toBe("retryStep");
      expect(scheduled[0].attempt).toBe(0);
      expect(scheduled[0].delayMs).toBe(2000);
    });

    it("emits retry.exhausted when max attempts reached", async () => {
      // maxAttempts: 1 means 1 retry allowed (2 total attempts: initial + 1 retry)
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "exhaustedStep",
            Effect.fail(new Error("permanent")).pipe(
              Workflow.retry({ maxAttempts: 1, delay: "1 second" }),
            ),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });

      // Attempt 0 (initial) - fail, retry scheduled (0 < 1)
      await harness.run(undefined);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

      // Attempt 1 (retry 1) - fail, exhausted (1 >= 1)
      vi.setSystemTime(1000);
      await harness.triggerAlarm();

      const exhausted = eventCapture.getEventsByType("retry.exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0].stepName).toBe("exhaustedStep");
      expect(exhausted[0].attempts).toBe(1);

      expect(await harness.getStatus()).toMatchObject({ _tag: "Failed" });
    });

    it("does not emit retry.exhausted when retry succeeds", async () => {
      let attempts = 0;

      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "eventualSuccess",
            Effect.gen(function* () {
              attempts++;
              if (attempts < 2) {
                return yield* Effect.fail(new Error("temp"));
              }
              return "ok";
            }).pipe(Workflow.retry({ maxAttempts: 3, delay: "1 second" })),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });

      await harness.run(undefined);
      vi.setSystemTime(1000);
      await harness.triggerAlarm();

      const exhausted = eventCapture.getEventsByType("retry.exhausted");
      expect(exhausted).toHaveLength(0);

      const completed = eventCapture.getEventsByType("step.completed");
      expect(completed).toHaveLength(1);
    });
  });

  // ============================================================
  // Sleep Events
  // ============================================================

  describe("sleep events", () => {
    it("emits sleep.started when sleep begins", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.sleep("5 seconds");
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });
      await harness.run(undefined);

      const started = eventCapture.getEventsByType("sleep.started");
      expect(started).toHaveLength(1);
      expect(started[0].durationMs).toBe(5000);
      expect(started[0].resumeAt).toBeDefined();
    });

    it("emits sleep.completed when sleep resumes", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.sleep("3 seconds");
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });

      await harness.run(undefined);
      eventCapture.clear();

      vi.setSystemTime(3000);
      await harness.triggerAlarm();

      const completed = eventCapture.getEventsByType("sleep.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].durationMs).toBe(3000);
    });

    it("emits events for multiple sleeps", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.sleep("1 second");
          yield* Workflow.sleep("2 seconds");
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });

      // First sleep starts
      await harness.run(undefined);
      expect(eventCapture.getEventsByType("sleep.started")).toHaveLength(1);

      // First sleep completes, second starts
      vi.setSystemTime(1000);
      await harness.triggerAlarm();
      expect(eventCapture.getEventsByType("sleep.completed")).toHaveLength(1);
      expect(eventCapture.getEventsByType("sleep.started")).toHaveLength(2);

      // Second sleep completes
      vi.setSystemTime(3000);
      await harness.triggerAlarm();
      expect(eventCapture.getEventsByType("sleep.completed")).toHaveLength(2);
    });
  });

  // ============================================================
  // Timeout Events
  // ============================================================

  describe("timeout events", () => {
    it("emits timeout.set when deadline is established", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "timedStep",
            Effect.succeed("fast").pipe(Workflow.timeout("10 seconds")),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });
      await harness.run(undefined);

      const set = eventCapture.getEventsByType("timeout.set");
      expect(set).toHaveLength(1);
      expect(set[0].stepName).toBe("timedStep");
      expect(set[0].timeoutMs).toBe(10000);
    });

    it("emits timeout.exceeded when deadline passes on resume", async () => {
      // Test timeout exceeded by having deadline pass between runs
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "slowStep",
            Effect.succeed("ok").pipe(
              // First run: sets deadline at 5000ms
              // We'll manually advance time past deadline before resume
              Workflow.timeout("5 seconds"),
              Workflow.retry({ maxAttempts: 3, delay: "1 second" }),
            ),
          );
        }),
      );

      // Manually set up a scenario where deadline passes
      // Use a step that fails first, then we advance time past deadline
      let attempts = 0;
      const workflowWithFail = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "slowStep",
            Effect.gen(function* () {
              attempts++;
              if (attempts === 1) {
                return yield* Effect.fail(new Error("first fail"));
              }
              return "ok";
            }).pipe(
              Workflow.timeout("5 seconds"),
              Workflow.retry({ maxAttempts: 3, delay: "1 second" }),
            ),
          );
        }),
      );

      const harness = createWorkflowHarness(workflowWithFail, { eventCapture });

      // First run at time 0 - sets deadline at 5000, fails, schedules retry at 1000
      vi.setSystemTime(0);
      await harness.run(undefined);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

      const setEvents = eventCapture.getEventsByType("timeout.set");
      expect(setEvents).toHaveLength(1);

      // Advance time past the deadline (5000ms) then trigger alarm
      vi.setSystemTime(6000);
      await harness.triggerAlarm();

      const exceeded = eventCapture.getEventsByType("timeout.exceeded");
      expect(exceeded).toHaveLength(1);
      expect(exceeded[0].stepName).toBe("slowStep");
      expect(exceeded[0].timeoutMs).toBe(5000);
    });
  });

  // ============================================================
  // Event Ordering
  // ============================================================

  describe("event ordering", () => {
    it("emits events in correct order for step with retry", async () => {
      let attempts = 0;

      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "orderedStep",
            Effect.gen(function* () {
              attempts++;
              if (attempts < 2) {
                return yield* Effect.fail(new Error("first fail"));
              }
              return "success";
            }).pipe(Workflow.retry({ maxAttempts: 3, delay: "1 second" })),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });

      // First attempt
      await harness.run(undefined);

      // Resume for second attempt
      vi.setSystemTime(1000);
      await harness.triggerAlarm();

      const allEvents = eventCapture.events.map((e) => e.type);

      // First run: step.started -> retry.scheduled
      // Second run: step.started -> step.completed
      expect(allEvents).toEqual([
        "step.started",
        "retry.scheduled",
        "step.started",
        "step.completed",
      ]);
    });

    it("includes workflowId and workflowName in all events", async () => {
      const workflow = Workflow.make("myWorkflow", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step("s1", Effect.succeed(1));
        }),
      );

      const harness = createWorkflowHarness(workflow, { eventCapture });
      await harness.run(undefined);

      for (const event of eventCapture.events) {
        expect(event.workflowId).toBe("test-workflow-id");
        expect(event.workflowName).toBe("myWorkflow");
        expect(event.eventId).toBeDefined();
        expect(event.timestamp).toBeDefined();
      }
    });
  });
});
