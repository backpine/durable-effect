import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Duration, Effect, Option } from "effect";
import { ExecutionContext, PauseSignal } from "@durable-effect/core";
import { StepContext } from "@/services/step-context";
import { WorkflowContext } from "@/services/workflow-context";
import { Workflow } from "@/workflow";
import { Backoff } from "@/backoff";
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
    meta: Record<string, unknown> = {},
  ): StepContext["Type"] {
    const metaStore = { ...meta };
    return {
      stepName,
      attempt,
      getMeta: <T>(key: string) =>
        Effect.succeed(
          metaStore[key] !== undefined
            ? Option.some(metaStore[key] as T)
            : Option.none(),
        ),
      setMeta: (key: string, value: unknown) =>
        Effect.sync(() => {
          metaStore[key] = value;
        }),
      getResult: () => Effect.succeed(Option.none() as any),
      setResult: () => Effect.succeed(undefined),
      incrementAttempt: Effect.succeed(undefined),
      recordStartTime: Effect.succeed(undefined),
      startedAt: Effect.succeed(Option.none() as any),
      deadline: Effect.succeed(Option.none() as any),
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
      // maxAttempts=3 means 3 retries allowed, so at attempt 3 we've exhausted all retries
      const stepCtx = createMockStepContext("test", 3);
      const originalError = new Error("permanent failure");
      const retryEffect = Effect.fail(originalError).pipe(
        Workflow.retry({ maxAttempts: 3 }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBe(originalError);
        expect(exit.cause.error).not.toBeInstanceOf(PauseSignal);
      }
    });

    it("does NOT set alarm when maxAttempts reached", async () => {
      // maxAttempts=3 means 3 retries, so at attempt 3 we're exhausted
      const stepCtx = createMockStepContext("test", 3);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({ maxAttempts: 3 }),
      );

      await runRetry(retryEffect, stepCtx);

      expect(await storage.getAlarm()).toBeNull();
    });

    it("retries when attempt < maxAttempts", async () => {
      // maxAttempts=3 means 3 retries, so at attempt 2 we can still retry
      const stepCtx = createMockStepContext("test", 2);
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
    it("handles maxAttempts of 0 (no retries)", async () => {
      // maxAttempts=0 means 0 retries, so even on first attempt (0) we exhaust
      const stepCtx = createMockStepContext("test", 0);
      const originalError = new Error("fail");
      const retryEffect = Effect.fail(originalError).pipe(
        Workflow.retry({ maxAttempts: 0 }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBe(originalError);
      }
    });

    it("handles maxAttempts of 1 (one retry)", async () => {
      // maxAttempts=1 means 1 retry allowed
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({ maxAttempts: 1 }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      // At attempt 0, we can still retry (0 < 1)
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(PauseSignal);
      }
    });

    it("exhausts after maxAttempts retries", async () => {
      // maxAttempts=1 means 1 retry, so at attempt 1 we're exhausted
      const stepCtx = createMockStepContext("test", 1);
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

  // ============================================================
  // Backoff Configuration Tests
  // ============================================================

  describe("backoff configuration", () => {
    it("uses exponential backoff with base delay", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({
          maxAttempts: 5,
          delay: Backoff.exponential({ base: "1 second" }),
        }),
      );

      await runRetry(retryEffect, stepCtx);

      // At attempt 0: 1s * 2^0 = 1000ms
      expect(await storage.getAlarm()).toBe(1000);
    });

    it("uses exponential backoff with attempt progression", async () => {
      const stepCtx = createMockStepContext("test", 2);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({
          maxAttempts: 5,
          delay: Backoff.exponential({ base: "1 second" }),
        }),
      );

      await runRetry(retryEffect, stepCtx);

      // At attempt 2: 1s * 2^2 = 4000ms
      expect(await storage.getAlarm()).toBe(4000);
    });

    it("respects exponential backoff max cap", async () => {
      const stepCtx = createMockStepContext("test", 10);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({
          maxAttempts: 15,
          delay: Backoff.exponential({
            base: "1 second",
            max: "5 seconds",
          }),
        }),
      );

      await runRetry(retryEffect, stepCtx);

      // Should be capped at 5000ms
      expect(await storage.getAlarm()).toBe(5000);
    });

    it("uses linear backoff", async () => {
      const stepCtx = createMockStepContext("test", 2);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({
          maxAttempts: 5,
          delay: Backoff.linear({
            initial: "1 second",
            increment: "2 seconds",
          }),
        }),
      );

      await runRetry(retryEffect, stepCtx);

      // At attempt 2: 1s + (2 * 2s) = 5000ms
      expect(await storage.getAlarm()).toBe(5000);
    });

    it("uses constant backoff", async () => {
      const stepCtx = createMockStepContext("test", 5);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({
          maxAttempts: 10,
          delay: Backoff.constant("3 seconds"),
        }),
      );

      await runRetry(retryEffect, stepCtx);

      // Constant 3000ms regardless of attempt
      expect(await storage.getAlarm()).toBe(3000);
    });

    it("uses preset backoff - standard", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({
          maxAttempts: 5,
          delay: { ...Backoff.presets.standard(), jitter: undefined },
        }),
      );

      await runRetry(retryEffect, stepCtx);

      // Standard preset: 1s base
      expect(await storage.getAlarm()).toBe(1000);
    });

    it("uses preset backoff - aggressive", async () => {
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({
          maxAttempts: 5,
          delay: { ...Backoff.presets.aggressive(), jitter: undefined },
        }),
      );

      await runRetry(retryEffect, stepCtx);

      // Aggressive preset: 100ms base
      expect(await storage.getAlarm()).toBe(100);
    });
  });

  // ============================================================
  // Max Duration Tests
  // ============================================================

  describe("maxDuration", () => {
    it("allows retry when within maxDuration", async () => {
      vi.setSystemTime(0);
      const stepCtx = createMockStepContext("test", 0);
      const retryEffect = Effect.fail(new Error("fail")).pipe(
        Workflow.retry({
          maxAttempts: 10,
          delay: "1 second",
          maxDuration: "10 seconds",
        }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      // Should retry (within maxDuration)
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(PauseSignal);
      }
    });

    it("exhausts retries when next retry would exceed maxDuration", async () => {
      vi.setSystemTime(9000); // 9 seconds elapsed
      const stepCtx = createMockStepContext("test", 1, {
        "retry:test:startTime": 0, // Started at time 0
      });
      const originalError = new Error("fail");
      const retryEffect = Effect.fail(originalError).pipe(
        Workflow.retry({
          maxAttempts: 10,
          delay: "2 seconds", // Would put us at 11 seconds
          maxDuration: "10 seconds",
        }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      // Should fail (would exceed maxDuration)
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBe(originalError);
        expect(exit.cause.error).not.toBeInstanceOf(PauseSignal);
      }
    });

    it("maxDuration works with backoff", async () => {
      vi.setSystemTime(8000); // 8 seconds elapsed
      const stepCtx = createMockStepContext("test", 3, {
        "retry:test:startTime": 0,
      });
      const originalError = new Error("fail");
      const retryEffect = Effect.fail(originalError).pipe(
        Workflow.retry({
          maxAttempts: 10,
          delay: Backoff.exponential({ base: "1 second" }), // At attempt 3: 8s delay
          maxDuration: "10 seconds",
        }),
      );

      const exit = await runRetry(retryEffect, stepCtx);

      // At attempt 3, exponential delay = 1s * 2^3 = 8s
      // elapsed (8s) + delay (8s) = 16s > maxDuration (10s)
      // Should exhaust
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBe(originalError);
        expect(exit.cause.error).not.toBeInstanceOf(PauseSignal);
      }
    });
  });
});
