import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Duration, Effect } from "effect";
import { ExecutionContext, PauseSignal } from "@durable-effect/core";
import { StepContext } from "@/services/step-context";
import { WorkflowContext } from "@/services/workflow-context";
import { Workflow } from "@/workflow";
import { createTestContexts, MockStorage } from "./mocks";

describe("Workflow.retry", () => {
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
   * Create a mock StepContext for testing retry.
   */
  function createMockStepContext(
    stepName: string,
    attempt: number,
  ): StepContext["Type"] {
    return {
      stepName,
      attempt,
      getMeta: () => Effect.succeed(null as any),
      setMeta: () => Effect.succeed(undefined),
      getResult: () => Effect.succeed(null as any),
      setResult: () => Effect.succeed(undefined),
      incrementAttempt: Effect.succeed(undefined),
      recordStartTime: Effect.succeed(undefined),
      startedAt: Effect.succeed(null as any),
      deadline: Effect.succeed(null as any),
    };
  }

  /**
   * Helper to run a retry effect with contexts provided.
   */
  function runRetry<T, E>(
    effect: Effect.Effect<T, E | PauseSignal, ExecutionContext | StepContext | WorkflowContext>,
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
    it("returns value when effect succeeds on first try", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.succeed("data").pipe(
        Workflow.retry({ maxAttempts: 3 }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") {
        expect(exit.value).toBe("data");
      }
    });

    it("does not set alarm when effect succeeds", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.succeed("data").pipe(
        Workflow.retry({ maxAttempts: 3, delay: "5 seconds" }),
      );

      await runRetry(retryEffect, stepCtx);

      expect(await storage.getAlarm()).toBeNull();
    });
  });

  // ============================================================
  // Retry Behavior Tests
  // ============================================================

  describe("retry behavior", () => {
    it("raises PauseSignal with reason='retry' on failure", async () => {
      const stepCtx = createMockStepContext("myStep", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({ maxAttempts: 3, delay: "2 seconds" }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(PauseSignal);
        const signal = exit.cause.error as PauseSignal;
        expect(signal.reason).toBe("retry");
        expect(signal.stepName).toBe("myStep");
      }
    });

    it("sets alarm at resumeAt time", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({ maxAttempts: 3, delay: "5 seconds" }),
      );

      await runRetry(retryEffect, stepCtx);

      expect(await storage.getAlarm()).toBe(5000);
    });

    it("resumeAt matches alarm time in PauseSignal", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({ maxAttempts: 3, delay: "3 seconds" }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const signal = exit.cause.error as PauseSignal;
        expect(signal.resumeAt).toBe(3000);
        expect(await storage.getAlarm()).toBe(signal.resumeAt);
      }
    });
  });

  // ============================================================
  // Max Attempts Tests
  // ============================================================

  describe("max attempts", () => {
    it("fails with original error when maxAttempts reached", async () => {
      const stepCtx = createMockStepContext("test", 2); // Already at attempt 2
      const originalError = new Error("permanent failure");
      const retryEffect = Effect.fail(originalError).pipe(
        Workflow.retry({ maxAttempts: 3 }), // nextAttempt would be 3, which >= maxAttempts
      );

      const exit = await runRetry(retryEffect, stepCtx);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBe(originalError);
        expect(exit.cause.error).not.toBeInstanceOf(PauseSignal);
      }
    });

    it("does NOT set alarm when maxAttempts reached", async () => {
      const stepCtx = createMockStepContext("test", 2);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({ maxAttempts: 3 }),
      );

      await runRetry(retryEffect, stepCtx);

      expect(await storage.getAlarm()).toBeNull();
    });

    it("retries when attempt < maxAttempts - 1", async () => {
      const stepCtx = createMockStepContext("test", 1); // nextAttempt = 2 < 3
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({ maxAttempts: 3 }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(PauseSignal);
      }
    });
  });

  // ============================================================
  // While Predicate Tests
  // ============================================================

  describe("while predicate", () => {
    it("retries when while() returns true", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("retryable")).pipe(
        Workflow.retry({
          maxAttempts: 3,
          while: (err) => err instanceof Error && err.message === "retryable",
        }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(PauseSignal);
      }
    });

    it("fails immediately when while() returns false", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const originalError = new Error("non-retryable");
      const retryEffect = Effect.fail(originalError).pipe(
        Workflow.retry({
          maxAttempts: 3,
          while: () => false,
        }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBe(originalError);
        expect(exit.cause.error).not.toBeInstanceOf(PauseSignal);
      }
    });

    it("does NOT set alarm when while() returns false", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({
          maxAttempts: 3,
          delay: "5 seconds",
          while: () => false,
        }),
      );

      await runRetry(retryEffect, stepCtx);

      expect(await storage.getAlarm()).toBeNull();
    });

    it("receives the actual error in while()", async () => {
      const stepCtx = createMockStepContext("test", 0);
      let receivedError: unknown;

      class CustomError extends Error {
        readonly code = 500;
      }

      const retryEffect = Effect.fail(new CustomError("server error")).pipe(
        Workflow.retry({
          maxAttempts: 3,
          while: (err) => {
            receivedError = err;
            return true;
          },
        }),
      );

      await runRetry(retryEffect, stepCtx);

      expect(receivedError).toBeInstanceOf(CustomError);
      expect((receivedError as CustomError).code).toBe(500);
    });
  });

  // ============================================================
  // Delay Calculation Tests
  // ============================================================

  describe("delay calculation", () => {
    it("uses default 1 second delay when not specified", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({ maxAttempts: 3 }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      expect(await storage.getAlarm()).toBe(1000);
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect((exit.cause.error as PauseSignal).resumeAt).toBe(1000);
      }
    });

    it("uses fixed delay when Duration string provided", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({ maxAttempts: 3, delay: "10 seconds" }),
      );

      await runRetry(retryEffect, stepCtx);

      expect(await storage.getAlarm()).toBe(10000);
    });

    it("uses fixed delay when Duration object provided", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({ maxAttempts: 3, delay: Duration.minutes(2) }),
      );

      await runRetry(retryEffect, stepCtx);

      expect(await storage.getAlarm()).toBe(120000);
    });

    it("uses backoff function with current attempt", async () => {
      const stepCtx = createMockStepContext("test", 2); // attempt = 2
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({
          maxAttempts: 5,
          delay: (attempt) => Duration.millis(1000 * Math.pow(2, attempt)),
        }),
      );

      await runRetry(retryEffect, stepCtx);

      // delay = 1000 * 2^2 = 4000
      expect(await storage.getAlarm()).toBe(4000);
    });

    it("backoff function receives correct attempt number", async () => {
      let receivedAttempt: number | undefined;
      const stepCtx = createMockStepContext("test", 3);

      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({
          maxAttempts: 10,
          delay: (attempt) => {
            receivedAttempt = attempt;
            return "1 second";
          },
        }),
      );

      await runRetry(retryEffect, stepCtx);

      expect(receivedAttempt).toBe(3);
    });
  });

  // ============================================================
  // Edge Cases
  // ============================================================

  describe("edge cases", () => {
    it("handles maxAttempts of 1 (no retries)", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const originalError = new Error("fail");
      const retryEffect = Effect.fail(originalError).pipe(
        Workflow.retry({ maxAttempts: 1 }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBe(originalError);
      }
    });

    it("handles very short delay", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({ maxAttempts: 3, delay: "10 millis" }),
      );

      await runRetry(retryEffect, stepCtx);

      expect(await storage.getAlarm()).toBe(10);
    });

    it("handles very long delay", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({ maxAttempts: 3, delay: Duration.days(1) }),
      );

      await runRetry(retryEffect, stepCtx);

      expect(await storage.getAlarm()).toBe(86400000); // 24 hours in ms
    });
  });
});
