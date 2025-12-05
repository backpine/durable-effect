import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "effect";
import { Workflow } from "@/workflow";
import { createWorkflowHarness } from "../harness";

describe("Workflow Async Run (runAsync)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic async execution", () => {
    it("sets status to Queued immediately", async () => {
      const workflow = Workflow.make((_: void) =>
        Effect.succeed("done"),
      );

      const harness = createWorkflowHarness(workflow);

      await harness.runAsync(undefined);

      const status = await harness.getStatus();
      expect(status?._tag).toBe("Queued");
      expect(status).toMatchObject({
        _tag: "Queued",
        queuedAt: 0,
      });
    });

    it("schedules alarm 300ms in the future", async () => {
      const workflow = Workflow.make((_: void) =>
        Effect.succeed("done"),
      );

      const harness = createWorkflowHarness(workflow);

      await harness.runAsync(undefined);

      const alarm = await harness.storage.getAlarm();
      expect(alarm).toBe(300);
    });

    it("executes workflow when alarm fires", async () => {
      let executed = false;
      const workflow = Workflow.make((_: void) =>
        Effect.sync(() => {
          executed = true;
          return "done";
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Queue the workflow
      await harness.runAsync(undefined);
      expect(executed).toBe(false);
      expect((await harness.getStatus())?._tag).toBe("Queued");

      // Advance time and trigger alarm
      vi.setSystemTime(300);
      await harness.triggerAlarm();

      expect(executed).toBe(true);
      expect((await harness.getStatus())?._tag).toBe("Completed");
    });

    it("stores input for later execution", async () => {
      const workflow = Workflow.make((input: { value: number }) =>
        Effect.succeed(input.value * 2),
      );

      const harness = createWorkflowHarness(workflow);

      await harness.runAsync({ value: 21 });

      const storedInput = await harness.storage.get<{ value: number }>(
        "workflow:input",
      );
      expect(storedInput).toEqual({ value: 21 });
    });
  });

  describe("idempotency", () => {
    it("returns same id on duplicate runAsync calls", async () => {
      const workflow = Workflow.make((_: void) =>
        Effect.succeed("done"),
      );

      const harness = createWorkflowHarness(workflow);

      const result1 = await harness.runAsync(undefined);
      const result2 = await harness.runAsync(undefined);

      expect(result1.id).toBe(result2.id);
    });

    it("does not re-queue if already queued", async () => {
      const workflow = Workflow.make((_: void) =>
        Effect.succeed("done"),
      );

      const harness = createWorkflowHarness(workflow);

      await harness.runAsync(undefined);
      const status1 = await harness.getStatus();

      // Try to queue again
      await harness.runAsync(undefined);
      const status2 = await harness.getStatus();

      // Status should still be Queued with original timestamp
      expect(status1).toEqual(status2);
    });
  });

  describe("async with steps", () => {
    it("executes steps when alarm fires", async () => {
      let stepExecutions = 0;

      const workflow = Workflow.make((_: void) =>
        Effect.gen(function* () {
          const value = yield* Workflow.step(
            "compute",
            Effect.sync(() => {
              stepExecutions++;
              return 42;
            }),
          );
          return value;
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Queue
      await harness.runAsync(undefined);
      expect(stepExecutions).toBe(0);

      // Execute
      vi.setSystemTime(300);
      await harness.triggerAlarm();

      expect(stepExecutions).toBe(1);
      expect(await harness.getCompletedSteps()).toEqual(["compute"]);
      expect((await harness.getStatus())?._tag).toBe("Completed");
    });
  });

  describe("async with sleep", () => {
    it("pauses at sleep after initial execution", async () => {
      const workflow = Workflow.make((_: void) =>
        Effect.gen(function* () {
          yield* Workflow.sleep("5 seconds");
          return "done";
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Queue (t=0)
      await harness.runAsync(undefined);
      expect((await harness.getStatus())?._tag).toBe("Queued");

      // First alarm fires (t=300ms) - should pause at sleep
      vi.setSystemTime(300);
      await harness.triggerAlarm();

      const status = await harness.getStatus();
      expect(status?._tag).toBe("Paused");
      expect(status).toMatchObject({
        _tag: "Paused",
        reason: "sleep",
        resumeAt: 5300, // 300 + 5000
      });
    });

    it("completes after sleep alarm fires", async () => {
      const workflow = Workflow.make((_: void) =>
        Effect.gen(function* () {
          yield* Workflow.sleep("5 seconds");
          return "done";
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Queue (t=0)
      await harness.runAsync(undefined);

      // First alarm - execute and pause at sleep (t=300ms)
      vi.setSystemTime(300);
      await harness.triggerAlarm();
      expect((await harness.getStatus())?._tag).toBe("Paused");

      // Second alarm - resume after sleep (t=5300ms)
      vi.setSystemTime(5300);
      await harness.triggerAlarm();
      expect((await harness.getStatus())?._tag).toBe("Completed");
    });
  });

  describe("runAsyncToCompletion helper", () => {
    it("automatically triggers all alarms until complete", async () => {
      const log: string[] = [];

      const workflow = Workflow.make((_: void) =>
        Effect.gen(function* () {
          log.push("start");
          yield* Workflow.sleep("1 second");
          log.push("after-sleep-1");
          yield* Workflow.sleep("2 seconds");
          log.push("after-sleep-2");
          return "done";
        }),
      );

      const harness = createWorkflowHarness(workflow);
      await harness.runAsyncToCompletion(undefined);

      expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
      // Log shows execution happened multiple times due to replays
      expect(log).toContain("start");
      expect(log).toContain("after-sleep-1");
      expect(log).toContain("after-sleep-2");
    });

    it("handles workflow with steps and sleeps", async () => {
      let stepExecutions = 0;

      const workflow = Workflow.make((_: void) =>
        Effect.gen(function* () {
          const value = yield* Workflow.step(
            "fetch",
            Effect.sync(() => {
              stepExecutions++;
              return 10;
            }),
          );
          yield* Workflow.sleep("1 second");
          return value * 2;
        }),
      );

      const harness = createWorkflowHarness(workflow);
      await harness.runAsyncToCompletion(undefined);

      expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
      expect(stepExecutions).toBe(1); // Step only executed once (cached)
      expect(await harness.getCompletedSteps()).toEqual(["fetch"]);
    });
  });

  describe("comparison with sync run", () => {
    it("runAsync returns before execution, run returns after", async () => {
      const executionLog: string[] = [];

      const workflow = Workflow.make((_: void) =>
        Effect.sync(() => {
          executionLog.push("executed");
          return "done";
        }),
      );

      // Test runAsync
      const asyncHarness = createWorkflowHarness(workflow);
      executionLog.length = 0;

      await asyncHarness.runAsync(undefined);
      expect(executionLog).toEqual([]); // Not executed yet
      expect((await asyncHarness.getStatus())?._tag).toBe("Queued");

      vi.setSystemTime(300);
      await asyncHarness.triggerAlarm();
      expect(executionLog).toEqual(["executed"]);

      // Test sync run
      const syncHarness = createWorkflowHarness(workflow);
      executionLog.length = 0;

      await syncHarness.run(undefined);
      expect(executionLog).toEqual(["executed"]); // Executed immediately
      expect((await syncHarness.getStatus())?._tag).toBe("Completed");
    });
  });
});
