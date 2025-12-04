import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import { ExecutionContext, PauseSignal } from "@durable-effect/core";
import { WorkflowContext } from "@/services/workflow-context";
import { WorkflowScope } from "@/services/workflow-scope";
import { StepContext } from "@/services/step-context";
import { Workflow } from "@/workflow";
import { StepError } from "@/errors";
import { createTestContexts, testWorkflowScope, MockStorage } from "./mocks";

describe("Workflow.step", () => {
  let storage: MockStorage;
  let executionContext: ReturnType<
    typeof createTestContexts
  >["executionContext"];
  let workflowContext: ReturnType<typeof createTestContexts>["workflowContext"];

  beforeEach(() => {
    const contexts = createTestContexts();
    storage = contexts.storage;
    executionContext = contexts.executionContext;
    workflowContext = contexts.workflowContext;
  });

  /**
   * Helper to run a step effect with contexts provided.
   */
  function runStep<T, E>(
    stepEffect: Effect.Effect<T, E, WorkflowScope | ExecutionContext | WorkflowContext>,
  ) {
    return stepEffect.pipe(
      Effect.provideService(ExecutionContext, executionContext),
      Effect.provideService(WorkflowContext, workflowContext),
      Effect.provideService(WorkflowScope, testWorkflowScope),
    );
  }

  // ===========================================================================
  // Cache Hit Tests
  // ===========================================================================

  describe("cache hit", () => {
    it("returns cached result when step already completed", async () => {
      // Seed storage with completed step
      storage.seed({
        "workflow:completedSteps": ["FetchUser"],
        "step:FetchUser:result": { id: 1, name: "John" },
      });

      let effectExecuted = false;
      const step = Workflow.step(
        "FetchUser",
        Effect.sync(() => {
          effectExecuted = true;
          return { id: 2, name: "Jane" };
        }),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toEqual({ id: 1, name: "John" });
      expect(effectExecuted).toBe(false);
    });

    it("does NOT re-execute effect when cached", async () => {
      storage.seed({
        "workflow:completedSteps": ["ComputeValue"],
        "step:ComputeValue:result": 42,
      });

      let executionCount = 0;
      const step = Workflow.step(
        "ComputeValue",
        Effect.sync(() => {
          executionCount++;
          return 100;
        }),
      );

      await Effect.runPromise(runStep(step));
      await Effect.runPromise(runStep(step));

      expect(executionCount).toBe(0);
    });

    it("works with primitive cached values", async () => {
      storage.seed({
        "workflow:completedSteps": ["GetNumber"],
        "step:GetNumber:result": 42,
      });

      const step = Workflow.step("GetNumber", Effect.succeed(0));
      const result = await Effect.runPromise(runStep(step));

      expect(result).toBe(42);
    });

    it("works with string cached values", async () => {
      storage.seed({
        "workflow:completedSteps": ["GetString"],
        "step:GetString:result": "cached-value",
      });

      const step = Workflow.step("GetString", Effect.succeed("new-value"));
      const result = await Effect.runPromise(runStep(step));

      expect(result).toBe("cached-value");
    });

    it("works with array cached values", async () => {
      storage.seed({
        "workflow:completedSteps": ["GetArray"],
        "step:GetArray:result": [1, 2, 3],
      });

      const step = Workflow.step("GetArray", Effect.succeed([4, 5, 6]));
      const result = await Effect.runPromise(runStep(step));

      expect(result).toEqual([1, 2, 3]);
    });

    it("works with null cached value", async () => {
      storage.seed({
        "workflow:completedSteps": ["GetNull"],
        "step:GetNull:result": null,
      });

      const step = Workflow.step("GetNull", Effect.succeed("not-null"));
      const result = await Effect.runPromise(runStep(step));

      // Note: null is stored but get() returns undefined for null
      // This depends on storage implementation
      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // First Execution Tests
  // ===========================================================================

  describe("first execution", () => {
    it("executes effect when step not completed", async () => {
      let effectExecuted = false;
      const step = Workflow.step(
        "NewStep",
        Effect.sync(() => {
          effectExecuted = true;
          return "result";
        }),
      );

      await Effect.runPromise(runStep(step));

      expect(effectExecuted).toBe(true);
    });

    it("caches successful result to storage", async () => {
      const step = Workflow.step(
        "CacheTest",
        Effect.succeed({ data: "important" }),
      );

      await Effect.runPromise(runStep(step));

      const cached = await storage.get("step:CacheTest:result");
      expect(cached).toEqual({ data: "important" });
    });

    it("adds step name to completedSteps list", async () => {
      const step = Workflow.step("AddToList", Effect.succeed("done"));

      await Effect.runPromise(runStep(step));

      const completedSteps = await storage.get<string[]>(
        "workflow:completedSteps",
      );
      expect(completedSteps).toContain("AddToList");
    });

    it("appends to existing completedSteps list", async () => {
      storage.seed({
        "workflow:completedSteps": ["Step1", "Step2"],
      });

      const step = Workflow.step("Step3", Effect.succeed("done"));

      await Effect.runPromise(runStep(step));

      const completedSteps = await storage.get<string[]>(
        "workflow:completedSteps",
      );
      expect(completedSteps).toEqual(["Step1", "Step2", "Step3"]);
    });

    it("records start time on first execution", async () => {
      const beforeTime = Date.now();

      const step = Workflow.step("TimedStep", Effect.succeed("done"));
      await Effect.runPromise(runStep(step));

      const afterTime = Date.now();
      const startedAt = await storage.get<number>("step:TimedStep:startedAt");

      expect(startedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(startedAt).toBeLessThanOrEqual(afterTime);
    });

    it("provides StepContext to the effect", async () => {
      let capturedStepName: string | undefined;
      let capturedAttempt: number | undefined;

      const step = Workflow.step(
        "ContextTest",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          capturedStepName = ctx.stepName;
          capturedAttempt = ctx.attempt;
          return "done";
        }),
      );

      await Effect.runPromise(runStep(step));

      expect(capturedStepName).toBe("ContextTest");
      expect(capturedAttempt).toBe(0);
    });

    it("returns the effect result", async () => {
      const step = Workflow.step(
        "ReturnTest",
        Effect.succeed({ computed: true, value: 123 }),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toEqual({ computed: true, value: 123 });
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe("error handling", () => {
    it("wraps effect errors in StepError", async () => {
      const originalError = new Error("Something went wrong");
      const step = Workflow.step("FailingStep", Effect.fail(originalError));

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = exit.cause;
        expect(error._tag).toBe("Fail");
        if (error._tag === "Fail") {
          expect(error.error).toBeInstanceOf(StepError);
          const stepError = error.error as StepError;
          expect(stepError.stepName).toBe("FailingStep");
          expect(stepError.cause).toBe(originalError);
          expect(stepError.attempt).toBe(0);
        }
      }
    });

    it("includes correct attempt number in StepError", async () => {
      storage.seed({
        "step:RetryingStep:attempt": 2,
      });

      const step = Workflow.step(
        "RetryingStep",
        Effect.fail(new Error("Still failing")),
      );

      const exit = await Effect.runPromiseExit(runStep(step));

      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const stepError = exit.cause.error as StepError;
        expect(stepError.attempt).toBe(2);
      }
    });

    it("does NOT wrap PauseSignal in StepError", async () => {
      const pauseSignal = new PauseSignal({
        reason: "retry",
        resumeAt: Date.now() + 5000,
        stepName: "TestStep",
      });

      const step = Workflow.step("TestStep", Effect.fail(pauseSignal));

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(PauseSignal);
        expect(exit.cause.error).not.toBeInstanceOf(StepError);
      }
    });

    it("increments attempt counter on PauseSignal", async () => {
      storage.seed({
        "step:PausingStep:attempt": 1,
      });

      const pauseSignal = new PauseSignal({
        reason: "retry",
        resumeAt: Date.now() + 5000,
      });

      const step = Workflow.step("PausingStep", Effect.fail(pauseSignal));

      await Effect.runPromiseExit(runStep(step));

      const newAttempt = await storage.get<number>("step:PausingStep:attempt");
      expect(newAttempt).toBe(2);
    });

    it("does NOT increment attempt on regular errors", async () => {
      storage.seed({
        "step:ErrorStep:attempt": 1,
      });

      const step = Workflow.step(
        "ErrorStep",
        Effect.fail(new Error("Regular error")),
      );

      await Effect.runPromiseExit(runStep(step));

      const attempt = await storage.get<number>("step:ErrorStep:attempt");
      expect(attempt).toBe(1); // Unchanged
    });

    it("does NOT cache result on failure", async () => {
      const step = Workflow.step(
        "FailedStep",
        Effect.fail(new Error("Failed")),
      );

      await Effect.runPromiseExit(runStep(step));

      const cached = await storage.get("step:FailedStep:result");
      expect(cached).toBeUndefined();
    });

    it("does NOT add to completedSteps on failure", async () => {
      const step = Workflow.step(
        "FailedStep",
        Effect.fail(new Error("Failed")),
      );

      await Effect.runPromiseExit(runStep(step));

      const completedSteps = await storage.get<string[]>(
        "workflow:completedSteps",
      );
      expect(completedSteps ?? []).not.toContain("FailedStep");
    });
  });

  // ===========================================================================
  // Idempotency Tests
  // ===========================================================================

  describe("idempotency", () => {
    it("second call returns cached result without re-execution", async () => {
      let executionCount = 0;
      const makeStep = () =>
        Workflow.step(
          "IdempotentStep",
          Effect.sync(() => {
            executionCount++;
            return `execution-${executionCount}`;
          }),
        );

      // First execution
      const result1 = await Effect.runPromise(runStep(makeStep()));
      expect(result1).toBe("execution-1");
      expect(executionCount).toBe(1);

      // Second execution - should return cached
      const result2 = await Effect.runPromise(runStep(makeStep()));
      expect(result2).toBe("execution-1");
      expect(executionCount).toBe(1); // Still 1, not re-executed
    });

    it("does not duplicate step in completedSteps", async () => {
      const step = Workflow.step("DuplicateTest", Effect.succeed("done"));

      await Effect.runPromise(runStep(step));
      await Effect.runPromise(runStep(step));

      const completedSteps = await storage.get<string[]>(
        "workflow:completedSteps",
      );
      const count = completedSteps?.filter((s) => s === "DuplicateTest").length;
      expect(count).toBe(1);
    });
  });

  // ===========================================================================
  // Attempt Counter Tests
  // ===========================================================================

  describe("attempt counter", () => {
    it("starts at 0 for new step", async () => {
      let capturedAttempt: number | undefined;

      const step = Workflow.step(
        "NewAttemptStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          capturedAttempt = ctx.attempt;
          return "done";
        }),
      );

      await Effect.runPromise(runStep(step));

      expect(capturedAttempt).toBe(0);
    });

    it("loads existing attempt from storage", async () => {
      storage.seed({
        "step:RetryStep:attempt": 3,
      });

      let capturedAttempt: number | undefined;

      const step = Workflow.step(
        "RetryStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          capturedAttempt = ctx.attempt;
          return "done";
        }),
      );

      await Effect.runPromise(runStep(step));

      expect(capturedAttempt).toBe(3);
    });
  });

  // ===========================================================================
  // Storage Key Tests
  // ===========================================================================

  describe("storage keys", () => {
    it("uses correct key for step result", async () => {
      const step = Workflow.step("MyStep", Effect.succeed("value"));
      await Effect.runPromise(runStep(step));

      expect(storage.has("step:MyStep:result")).toBe(true);
    });

    it("uses correct key for step attempt", async () => {
      const pauseSignal = new PauseSignal({
        reason: "retry",
        resumeAt: Date.now() + 5000,
      });

      const step = Workflow.step("MyStep", Effect.fail(pauseSignal));
      await Effect.runPromiseExit(runStep(step));

      expect(storage.has("step:MyStep:attempt")).toBe(true);
    });

    it("uses correct key for step startedAt", async () => {
      const step = Workflow.step("MyStep", Effect.succeed("value"));
      await Effect.runPromise(runStep(step));

      expect(storage.has("step:MyStep:startedAt")).toBe(true);
    });

    it("handles step names with special characters", async () => {
      const step = Workflow.step(
        "Step With Spaces & Special-Chars_123",
        Effect.succeed("value"),
      );
      await Effect.runPromise(runStep(step));

      expect(
        storage.has("step:Step With Spaces & Special-Chars_123:result"),
      ).toBe(true);
    });
  });

  // ===========================================================================
  // Async Effect Tests
  // ===========================================================================

  describe("async effects", () => {
    it("handles async effects correctly", async () => {
      const step = Workflow.step(
        "AsyncStep",
        Effect.promise(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return "async-result";
        }),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toBe("async-result");
    });

    it("rejects Effect.sleep (now forbidden inside steps)", async () => {
      // Effect.sleep is now forbidden inside steps to ensure steps are atomic.
      // Use Workflow.sleep at the workflow level between steps instead.
      const step = Workflow.step(
        "SleepStep",
        Effect.gen(function* () {
          yield* Effect.sleep("10 millis");
          return "after-sleep";
        }),
      );

      const exit = await Effect.runPromiseExit(runStep(step));

      // Should fail with StepSleepForbiddenError
      expect(exit._tag).toBe("Failure");
    });

    it("caches async effect results", async () => {
      let callCount = 0;
      const step = Workflow.step(
        "CachedAsyncStep",
        Effect.promise(async () => {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return `call-${callCount}`;
        }),
      );

      const result1 = await Effect.runPromise(runStep(step));
      const result2 = await Effect.runPromise(runStep(step));

      expect(result1).toBe("call-1");
      expect(result2).toBe("call-1");
      expect(callCount).toBe(1);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe("edge cases", () => {
    it("handles undefined return value", async () => {
      const step = Workflow.step("UndefinedStep", Effect.succeed(undefined));

      const result = await Effect.runPromise(runStep(step));

      expect(result).toBeUndefined();
    });

    it("handles empty object return value", async () => {
      const step = Workflow.step("EmptyObjectStep", Effect.succeed({}));

      const result = await Effect.runPromise(runStep(step));

      expect(result).toEqual({});
    });

    it("handles empty array return value", async () => {
      const step = Workflow.step("EmptyArrayStep", Effect.succeed([]));

      const result = await Effect.runPromise(runStep(step));

      expect(result).toEqual([]);
    });

    it("handles boolean false return value", async () => {
      const step = Workflow.step("FalseStep", Effect.succeed(false));

      const result = await Effect.runPromise(runStep(step));

      expect(result).toBe(false);
    });

    it("handles zero return value", async () => {
      const step = Workflow.step("ZeroStep", Effect.succeed(0));

      const result = await Effect.runPromise(runStep(step));

      expect(result).toBe(0);
    });

    it("handles empty string return value", async () => {
      const step = Workflow.step("EmptyStringStep", Effect.succeed(""));

      const result = await Effect.runPromise(runStep(step));

      expect(result).toBe("");
    });
  });
});
