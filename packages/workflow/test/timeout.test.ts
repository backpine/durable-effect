import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Duration, Effect, Option } from "effect";
import { ExecutionContext } from "@durable-effect/core";
import { StepContext } from "@/services/step-context";
import { WorkflowContext } from "@/services/workflow-context";
import { StepTimeoutError } from "@/errors";
import { Workflow } from "@/workflow";
import { createTestContexts, MockStorage } from "./mocks";

describe("Workflow.timeout", () => {
  let storage: MockStorage;
  let executionContext: ReturnType<
    typeof createTestContexts
  >["executionContext"];
  let workflowContext: ReturnType<
    typeof createTestContexts
  >["workflowContext"];

  beforeEach(() => {
    const contexts = createTestContexts();
    storage = contexts.storage;
    executionContext = contexts.executionContext;
    workflowContext = contexts.workflowContext;
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Create a mock StepContext for testing timeout.
   * Tracks deadline in local state to simulate storage behavior.
   */
  function createMockStepContext(
    stepName: string,
    options: {
      attempt?: number;
      existingDeadline?: number;
    } = {},
  ): StepContext["Type"] {
    const { attempt = 0, existingDeadline } = options;
    let storedDeadline: number | undefined = existingDeadline;

    return {
      stepName,
      attempt,
      getMeta: <T>(key: string) =>
        Effect.succeed(
          key === "deadline" && storedDeadline !== undefined
            ? Option.some(storedDeadline as T)
            : Option.none<T>(),
        ),
      setMeta: <T>(key: string, value: T) => {
        if (key === "deadline") {
          storedDeadline = value as number;
        }
        return Effect.succeed(undefined);
      },
      getResult: () => Effect.succeed(Option.none()),
      setResult: () => Effect.succeed(undefined),
      incrementAttempt: Effect.succeed(undefined),
      recordStartTime: Effect.succeed(undefined),
      startedAt: Effect.succeed(Option.none()),
      deadline: Effect.succeed(
        storedDeadline !== undefined
          ? Option.some(storedDeadline)
          : Option.none<number>(),
      ),
    };
  }

  /**
   * Helper to run a timeout effect with contexts provided.
   */
  function runTimeout<T, E>(
    effect: Effect.Effect<T, E | StepTimeoutError, ExecutionContext | StepContext | WorkflowContext>,
    stepContext: StepContext["Type"],
  ) {
    return effect.pipe(
      Effect.provideService(ExecutionContext, executionContext),
      Effect.provideService(StepContext, stepContext),
      Effect.provideService(WorkflowContext, workflowContext),
      Effect.runPromiseExit,
    );
  }

  // ============================================================
  // Success Tests
  // ============================================================

  describe("success", () => {
    it("returns value when effect succeeds within timeout", async () => {
      const stepCtx = createMockStepContext("test");
      const timeoutEffect = Effect.succeed("data").pipe(
        Workflow.timeout("10 seconds"),
      );

      const exit = await runTimeout(timeoutEffect, stepCtx);

      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") {
        expect(exit.value).toBe("data");
      }
    });

    it("returns value when effect completes before deadline", async () => {
      const stepCtx = createMockStepContext("test");
      const timeoutEffect = Effect.gen(function* () {
        yield* Effect.sleep("1 second");
        return "completed";
      }).pipe(Workflow.timeout("5 seconds"));

      const exitPromise = runTimeout(timeoutEffect, stepCtx);
      await vi.advanceTimersByTimeAsync(1000);
      const exit = await exitPromise;

      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") {
        expect(exit.value).toBe("completed");
      }
    });
  });

  // ============================================================
  // Deadline Calculation Tests
  // ============================================================

  describe("deadline calculation", () => {
    it("calculates deadline as now + duration on first run", async () => {
      vi.setSystemTime(10000);
      let capturedDeadline: number | undefined;

      const stepCtx: StepContext["Type"] = {
        stepName: "test",
        attempt: 0,
        getMeta: () => Effect.succeed(Option.none()),
        setMeta: (key, value) => {
          if (key === "deadline") {
            capturedDeadline = value as number;
          }
          return Effect.succeed(undefined);
        },
        getResult: () => Effect.succeed(Option.none()),
        setResult: () => Effect.succeed(undefined),
        incrementAttempt: Effect.succeed(undefined),
        recordStartTime: Effect.succeed(undefined),
        startedAt: Effect.succeed(Option.none()),
        deadline: Effect.succeed(Option.none()),
      };

      const timeoutEffect = Effect.succeed("data").pipe(
        Workflow.timeout("30 seconds"),
      );

      await runTimeout(timeoutEffect, stepCtx);

      expect(capturedDeadline).toBe(10000 + 30000); // now + 30 seconds
    });

    it("uses existing deadline on subsequent runs", async () => {
      vi.setSystemTime(20000); // Time has advanced
      const existingDeadline = 15000; // Deadline was set at 15000

      const stepCtx = createMockStepContext("test", { existingDeadline });
      const timeoutEffect = Effect.succeed("data").pipe(
        Workflow.timeout("30 seconds"),
      );

      // Should fail because now (20000) > deadline (15000)
      const exit = await runTimeout(timeoutEffect, stepCtx);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(StepTimeoutError);
      }
    });

    it("does not overwrite existing deadline", async () => {
      const existingDeadline = 50000;
      let setMetaCalled = false;

      const stepCtx: StepContext["Type"] = {
        stepName: "test",
        attempt: 0,
        getMeta: () => Effect.succeed(Option.none()),
        setMeta: () => {
          setMetaCalled = true;
          return Effect.succeed(undefined);
        },
        getResult: () => Effect.succeed(Option.none()),
        setResult: () => Effect.succeed(undefined),
        incrementAttempt: Effect.succeed(undefined),
        recordStartTime: Effect.succeed(undefined),
        startedAt: Effect.succeed(Option.none()),
        deadline: Effect.succeed(Option.some(existingDeadline)),
      };

      const timeoutEffect = Effect.succeed("data").pipe(
        Workflow.timeout("10 seconds"),
      );

      await runTimeout(timeoutEffect, stepCtx);

      expect(setMetaCalled).toBe(false);
    });
  });

  // ============================================================
  // Timeout Failure Tests
  // ============================================================

  describe("timeout failure", () => {
    it("fails with StepTimeoutError when deadline already passed", async () => {
      vi.setSystemTime(100000); // Now is 100 seconds
      const stepCtx = createMockStepContext("myStep", {
        existingDeadline: 50000, // Deadline was 50 seconds
      });

      const timeoutEffect = Effect.succeed("data").pipe(
        Workflow.timeout("30 seconds"),
      );

      const exit = await runTimeout(timeoutEffect, stepCtx);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const error = exit.cause.error as StepTimeoutError;
        expect(error).toBeInstanceOf(StepTimeoutError);
        expect(error.stepName).toBe("myStep");
        expect(error.timeoutMs).toBe(30000);
      }
    });

    it("fails with StepTimeoutError when effect exceeds remaining time", async () => {
      vi.setSystemTime(0);
      const stepCtx = createMockStepContext("slowStep");

      // Effect takes 10 seconds, timeout is 5 seconds
      const timeoutEffect = Effect.gen(function* () {
        yield* Effect.sleep("10 seconds");
        return "never reached";
      }).pipe(Workflow.timeout("5 seconds"));

      const exitPromise = runTimeout(timeoutEffect, stepCtx);

      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(6000);

      const exit = await exitPromise;

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const error = exit.cause.error as StepTimeoutError;
        expect(error).toBeInstanceOf(StepTimeoutError);
        expect(error.stepName).toBe("slowStep");
        expect(error.timeoutMs).toBe(5000);
      }
    });

    it("includes correct timeoutMs in error", async () => {
      vi.setSystemTime(0);
      const stepCtx = createMockStepContext("test", {
        existingDeadline: -1000, // Already expired
      });

      const timeoutEffect = Effect.succeed("data").pipe(
        Workflow.timeout(Duration.minutes(2)),
      );

      const exit = await runTimeout(timeoutEffect, stepCtx);

      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const error = exit.cause.error as StepTimeoutError;
        expect(error.timeoutMs).toBe(120000); // 2 minutes in ms
      }
    });
  });

  // ============================================================
  // Duration Format Tests
  // ============================================================

  describe("duration formats", () => {
    it("accepts Duration string", async () => {
      const stepCtx = createMockStepContext("test");
      const timeoutEffect = Effect.succeed("data").pipe(
        Workflow.timeout("45 seconds"),
      );

      const exit = await runTimeout(timeoutEffect, stepCtx);
      expect(exit._tag).toBe("Success");
    });

    it("accepts Duration object", async () => {
      const stepCtx = createMockStepContext("test");
      const timeoutEffect = Effect.succeed("data").pipe(
        Workflow.timeout(Duration.minutes(5)),
      );

      const exit = await runTimeout(timeoutEffect, stepCtx);
      expect(exit._tag).toBe("Success");
    });

    it("accepts Duration.millis", async () => {
      const stepCtx = createMockStepContext("test");
      const timeoutEffect = Effect.succeed("data").pipe(
        Workflow.timeout(Duration.millis(500)),
      );

      const exit = await runTimeout(timeoutEffect, stepCtx);
      expect(exit._tag).toBe("Success");
    });
  });

  // ============================================================
  // Edge Cases
  // ============================================================

  describe("edge cases", () => {
    it("handles very short timeout", async () => {
      vi.setSystemTime(0);
      const stepCtx = createMockStepContext("test");

      const timeoutEffect = Effect.gen(function* () {
        yield* Effect.sleep("100 millis");
        return "done";
      }).pipe(Workflow.timeout("10 millis"));

      const exitPromise = runTimeout(timeoutEffect, stepCtx);
      await vi.advanceTimersByTimeAsync(50);
      const exit = await exitPromise;

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(StepTimeoutError);
      }
    });

    it("handles very long timeout", async () => {
      let capturedDeadline: number | undefined;

      const stepCtx: StepContext["Type"] = {
        stepName: "test",
        attempt: 0,
        getMeta: () => Effect.succeed(Option.none()),
        setMeta: (key, value) => {
          if (key === "deadline") {
            capturedDeadline = value as number;
          }
          return Effect.succeed(undefined);
        },
        getResult: () => Effect.succeed(Option.none()),
        setResult: () => Effect.succeed(undefined),
        incrementAttempt: Effect.succeed(undefined),
        recordStartTime: Effect.succeed(undefined),
        startedAt: Effect.succeed(Option.none()),
        deadline: Effect.succeed(Option.none()),
      };

      const timeoutEffect = Effect.succeed("data").pipe(
        Workflow.timeout(Duration.days(7)),
      );

      await runTimeout(timeoutEffect, stepCtx);

      expect(capturedDeadline).toBe(7 * 24 * 60 * 60 * 1000); // 7 days in ms
    });

    it("propagates effect errors", async () => {
      const stepCtx = createMockStepContext("test");

      class CustomError extends Error {
        readonly _tag = "CustomError";
      }

      const timeoutEffect = Effect.fail(new CustomError("effect failed")).pipe(
        Workflow.timeout("10 seconds"),
      );

      const exit = await runTimeout(timeoutEffect, stepCtx);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(CustomError);
      }
    });

    it("succeeds at exact deadline boundary", async () => {
      vi.setSystemTime(10000);
      const stepCtx = createMockStepContext("test", {
        existingDeadline: 10000, // Deadline is exactly now
      });

      // When now === deadline, it should NOT fail (only fails when now > deadline)
      const timeoutEffect = Effect.succeed("data").pipe(
        Workflow.timeout("5 seconds"),
      );

      const exit = await runTimeout(timeoutEffect, stepCtx);

      // Should succeed because we have 0ms remaining but haven't passed deadline
      expect(exit._tag).toBe("Success");
    });
  });
});
