import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "effect";
import { Workflow } from "@/workflow";
import { createWorkflowHarness } from "../harness";

describe("Workflow Sleep Lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("single sleep", () => {
    it("pauses at sleep and resumes after alarm", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.sleep("5 seconds");
          return "done";
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Initial run - should pause at sleep
      await harness.run(undefined);
      expect(await harness.getStatus()).toMatchObject({
        _tag: "Paused",
        reason: "sleep",
        resumeAt: 5000,
      });
      expect(await harness.getCompletedPauseIndex()).toBe(0);

      // Trigger alarm - should complete
      vi.setSystemTime(5000);
      await harness.triggerAlarm();
      expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
      expect(await harness.getCompletedPauseIndex()).toBe(1);
    });

    it("sleep is skipped on resume (not re-executed)", async () => {
      let sleepReached = 0;

      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          sleepReached++;
          yield* Workflow.sleep("1 second");
          return "done";
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // First run
      await harness.run(undefined);
      expect(sleepReached).toBe(1);

      // Resume - effect re-runs but sleep should be skipped
      vi.setSystemTime(1000);
      await harness.triggerAlarm();
      expect(sleepReached).toBe(2); // Effect body runs again
      expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
    });
  });

  describe("multiple sleeps", () => {
    it("handles two sequential sleeps", async () => {
      const log: string[] = [];

      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          log.push("before-sleep-1");
          yield* Workflow.sleep("5 seconds");
          log.push("after-sleep-1");
          yield* Workflow.sleep("10 seconds");
          log.push("after-sleep-2");
          return "done";
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Run 1: Pause at first sleep
      await harness.run(undefined);
      expect(await harness.getStatus()).toMatchObject({
        _tag: "Paused",
        resumeAt: 5000,
      });
      expect(log).toEqual(["before-sleep-1"]);
      expect(await harness.getCompletedPauseIndex()).toBe(0);

      // Run 2: Skip sleep 1, pause at sleep 2
      vi.setSystemTime(5000);
      await harness.triggerAlarm();
      expect(await harness.getStatus()).toMatchObject({
        _tag: "Paused",
        resumeAt: 15000, // 5000 + 10000
      });
      expect(log).toEqual([
        "before-sleep-1",
        "before-sleep-1", // Re-executed
        "after-sleep-1", // Continued past first sleep
      ]);
      expect(await harness.getCompletedPauseIndex()).toBe(1);

      // Run 3: Skip both sleeps, complete
      vi.setSystemTime(15000);
      await harness.triggerAlarm();
      expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
      expect(log).toEqual([
        "before-sleep-1",
        "before-sleep-1",
        "after-sleep-1",
        "before-sleep-1", // Re-executed again
        "after-sleep-1", // First sleep skipped
        "after-sleep-2", // Second sleep skipped
      ]);
      expect(await harness.getCompletedPauseIndex()).toBe(2);
    });
  });

  describe("sleep with steps", () => {
    it("steps are cached, sleeps are tracked independently", async () => {
      let stepExecutions = 0;

      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          const value = yield* Workflow.step(
            "fetch",
            Effect.sync(() => {
              stepExecutions++;
              return 42;
            }),
          );
          yield* Workflow.sleep("1 second");
          return value * 2;
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Run 1: Execute step, pause at sleep
      await harness.run(undefined);
      expect(stepExecutions).toBe(1);
      expect(await harness.getCompletedSteps()).toEqual(["fetch"]);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

      // Run 2: Step cached (not re-executed), sleep completed
      vi.setSystemTime(1000);
      await harness.triggerAlarm();
      expect(stepExecutions).toBe(1); // Step NOT re-executed
      expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
      expect(await harness.getCompletedPauseIndex()).toBe(1);
    });
  });

  describe("runToCompletion helper", () => {
    it("automatically triggers alarms until complete", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.sleep("1 second");
          yield* Workflow.sleep("2 seconds");
          yield* Workflow.sleep("3 seconds");
          return "done";
        }),
      );

      const harness = createWorkflowHarness(workflow);
      await harness.runToCompletion(undefined);

      expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
      expect(await harness.getCompletedPauseIndex()).toBe(3);
    });
  });
});
