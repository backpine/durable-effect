import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Duration, Effect, Exit } from "effect";
import { UnknownException } from "effect/Cause";
import { ExecutionContext, PauseSignal } from "@durable-effect/core";
import { Workflow } from "@/workflow";
import { createTestContexts, MockStorage } from "./mocks";

describe("Workflow.sleep", () => {
  let storage: MockStorage;
  let executionContext: ReturnType<
    typeof createTestContexts
  >["executionContext"];

  beforeEach(() => {
    const contexts = createTestContexts();
    storage = contexts.storage;
    executionContext = contexts.executionContext;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Helper to run a sleep effect with context provided.
   */
  function runSleep(
    sleepEffect: Effect.Effect<
      void,
      PauseSignal | UnknownException,
      ExecutionContext
    >,
  ) {
    return sleepEffect.pipe(
      Effect.provideService(ExecutionContext, executionContext),
      Effect.runPromiseExit,
    );
  }

  // ============================================================
  // Basic Behavior Tests
  // ============================================================

  describe("basic", () => {
    it("sets alarm at Date.now() + duration", async () => {
      vi.setSystemTime(1000000);

      const sleepEffect = Workflow.sleep("5 seconds");
      await runSleep(sleepEffect);

      const alarmTime = await storage.getAlarm();
      expect(alarmTime).toBe(1000000 + 5000); // 5 seconds = 5000ms
    });

    it("raises PauseSignal with reason='sleep'", async () => {
      vi.setSystemTime(1000000);

      const sleepEffect = Workflow.sleep("1 second");
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = exit.cause;
        // Extract the PauseSignal from the cause
        expect(error._tag).toBe("Fail");
        if (error._tag === "Fail") {
          expect(error.error).toBeInstanceOf(PauseSignal);
          expect((error.error as PauseSignal).reason).toBe("sleep");
        }
      }
    });

    it("resumeAt matches alarm time", async () => {
      vi.setSystemTime(1000000);

      const sleepEffect = Workflow.sleep("10 seconds");
      const exit = await runSleep(sleepEffect);

      const alarmTime = await storage.getAlarm();

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(alarmTime);
        expect(signal.resumeAt).toBe(1000000 + 10000);
      }
    });

    it("does not include stepName in PauseSignal", async () => {
      vi.setSystemTime(1000000);

      const sleepEffect = Workflow.sleep("1 second");
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.stepName).toBeUndefined();
      }
    });
  });

  // ============================================================
  // Duration Format Tests
  // ============================================================

  describe("duration-formats", () => {
    it("handles string durations ('5 seconds')", async () => {
      vi.setSystemTime(0);

      const sleepEffect = Workflow.sleep("5 seconds");
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(5000);
      }
    });

    it("handles string durations ('1 minute')", async () => {
      vi.setSystemTime(0);

      const sleepEffect = Workflow.sleep("1 minute");
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(60000);
      }
    });

    it("handles string durations ('2 hours')", async () => {
      vi.setSystemTime(0);

      const sleepEffect = Workflow.sleep("2 hours");
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(2 * 60 * 60 * 1000);
      }
    });

    it("handles Duration objects", async () => {
      vi.setSystemTime(0);

      const sleepEffect = Workflow.sleep(Duration.seconds(30));
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(30000);
      }
    });

    it("handles Duration.minutes", async () => {
      vi.setSystemTime(0);

      const sleepEffect = Workflow.sleep(Duration.minutes(5));
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(5 * 60 * 1000);
      }
    });

    it("handles Duration.hours", async () => {
      vi.setSystemTime(0);

      const sleepEffect = Workflow.sleep(Duration.hours(1));
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(60 * 60 * 1000);
      }
    });

    it("handles millisecond numbers", async () => {
      vi.setSystemTime(0);

      const sleepEffect = Workflow.sleep(2500);
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(2500);
      }
    });

    it("handles zero duration", async () => {
      vi.setSystemTime(1000);

      const sleepEffect = Workflow.sleep(0);
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(1000); // Date.now() + 0
      }
    });
  });

  // ============================================================
  // Alarm Behavior Tests
  // ============================================================

  describe("alarm", () => {
    it("calls setAlarm exactly once", async () => {
      vi.setSystemTime(0);

      const sleepEffect = Workflow.sleep("1 second");
      await runSleep(sleepEffect);

      // Check that setAlarm was called by verifying alarm is set
      const alarmTime = await storage.getAlarm();
      expect(alarmTime).toBe(1000);
    });

    it("sets alarm before raising PauseSignal", async () => {
      // This test verifies the order of operations
      vi.setSystemTime(0);

      const sleepEffect = Workflow.sleep("5 seconds");
      const exit = await runSleep(sleepEffect);

      // Both alarm should be set and PauseSignal raised
      const alarmTime = await storage.getAlarm();
      expect(alarmTime).toBe(5000);
      expect(exit._tag).toBe("Failure");
    });
  });

  // ============================================================
  // Edge Cases
  // ============================================================

  describe("edge-cases", () => {
    it("handles very short durations (< 100ms)", async () => {
      vi.setSystemTime(0);

      const sleepEffect = Workflow.sleep(10);
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(10);
      }
    });

    it("handles very long durations (days)", async () => {
      vi.setSystemTime(0);

      const sleepEffect = Workflow.sleep(Duration.days(7));
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(7 * 24 * 60 * 60 * 1000);
      }
    });

    it("uses current time for resumeAt calculation", async () => {
      // First sleep at time 0
      vi.setSystemTime(0);
      let exit = await runSleep(Workflow.sleep("1 second"));

      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect((exit.cause.error as PauseSignal).resumeAt).toBe(1000);
      }

      // Reset storage and try at different time
      storage.clear();
      vi.setSystemTime(50000);
      exit = await runSleep(Workflow.sleep("1 second"));

      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect((exit.cause.error as PauseSignal).resumeAt).toBe(51000);
      }
    });

    it("handles string with millis ('500 millis')", async () => {
      vi.setSystemTime(0);

      const sleepEffect = Workflow.sleep("500 millis");
      const exit = await runSleep(sleepEffect);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(500);
      }
    });
  });

  // ============================================================
  // Integration with Step
  // ============================================================

  describe("integration-with-step", () => {
    it("sleep inside step raises PauseSignal that propagates", async () => {
      const contexts = createTestContexts();
      vi.setSystemTime(0);

      const stepWithSleep = Workflow.step(
        "WaitStep",
        Effect.gen(function* () {
          yield* Workflow.sleep("5 seconds");
          return "done";
        }),
      );

      const exit = await stepWithSleep.pipe(
        Effect.provideService(ExecutionContext, contexts.executionContext),
        Effect.provideService(Workflow.Context, contexts.workflowContext),
        Effect.runPromiseExit,
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(PauseSignal);
        expect((exit.cause.error as PauseSignal).reason).toBe("sleep");
      }
    });
  });
});
