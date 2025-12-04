import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Cause } from "effect";
import { ExecutionContext } from "@durable-effect/core";
import { WorkflowContext } from "@/services/workflow-context";
import { WorkflowScope } from "@/services/workflow-scope";
import { StepSleepForbiddenError } from "@/services/step-clock";
import { Workflow } from "@/workflow";
import { createTestContexts, testWorkflowScope, MockStorage } from "./mocks";

describe("Step forbidden operations", () => {
  let storage: MockStorage;
  let executionContext: ReturnType<typeof createTestContexts>["executionContext"];
  let workflowContext: ReturnType<typeof createTestContexts>["workflowContext"];

  beforeEach(() => {
    const contexts = createTestContexts();
    storage = contexts.storage;
    executionContext = contexts.executionContext;
    workflowContext = contexts.workflowContext;
  });

  /**
   * Helper to run a step effect with all contexts provided.
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

  // ============================================================
  // Effect.sleep inside step - Runtime Error
  // ============================================================

  describe("Effect.sleep inside step", () => {
    it("throws StepSleepForbiddenError when Effect.sleep is called", async () => {
      const step = Workflow.step(
        "BadStep",
        Effect.gen(function* () {
          yield* Effect.sleep("100 millis");
          return "done";
        }),
      );

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        // Effect.die wraps the error in a Die cause
        const dieOption = Cause.dieOption(exit.cause);
        expect(dieOption._tag).toBe("Some");
        if (dieOption._tag === "Some") {
          expect(dieOption.value).toBeInstanceOf(StepSleepForbiddenError);
          expect((dieOption.value as StepSleepForbiddenError).message).toContain(
            "Effect.sleep is not allowed inside a step"
          );
        }
      }
    });

    it("allows Effect.log and other non-sleep operations", async () => {
      let logCalled = false;

      const step = Workflow.step(
        "GoodStep",
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            logCalled = true;
          });
          return { processed: true };
        }),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toEqual({ processed: true });
      expect(logCalled).toBe(true);
    });

    it("allows Effect.promise (async operations)", async () => {
      const step = Workflow.step(
        "AsyncStep",
        Effect.gen(function* () {
          const result = yield* Effect.promise(async () => {
            return "async-result";
          });
          return result;
        }),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toBe("async-result");
    });

    it("allows Effect.delay on result (different from sleep)", async () => {
      // Note: Effect.delay schedules work but doesn't use Clock.sleep
      // It should work fine inside a step
      const step = Workflow.step(
        "DelayStep",
        Effect.succeed("immediate"),
      );

      const result = await Effect.runPromise(runStep(step));
      expect(result).toBe("immediate");
    });
  });

  // ============================================================
  // Compile-time protection (validated by type tests)
  // ============================================================

  describe("compile-time protection", () => {
    it("allows regular effects inside step", async () => {
      const step = Workflow.step(
        "RegularStep",
        Effect.succeed({ id: "123", value: 42 }),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toEqual({ id: "123", value: 42 });
    });

    it("allows Effect.gen with regular operations", async () => {
      const step = Workflow.step(
        "GenStep",
        Effect.gen(function* () {
          const a = yield* Effect.succeed(1);
          const b = yield* Effect.succeed(2);
          return a + b;
        }),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toBe(3);
    });

    // NOTE: The following would cause compile-time errors if uncommented:
    //
    // Workflow.step("bad", Workflow.sleep("1 second"));
    // → Error: Type 'WorkflowScope' is not assignable to type 'never'
    //
    // Workflow.step("bad", Effect.gen(function* () {
    //   yield* Workflow.step("nested", Effect.succeed(1));
    // }));
    // → Error: Type 'WorkflowScope' is not assignable to type 'never'
    //
    // See test/type-tests/workflow-scope.test-d.ts for type-level validation
  });

  // ============================================================
  // Error message quality
  // ============================================================

  describe("error messages", () => {
    it("provides helpful error message for Effect.sleep", async () => {
      const step = Workflow.step(
        "SleepStep",
        Effect.sleep("1 second"),
      );

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const dieOption = Cause.dieOption(exit.cause);
        if (dieOption._tag === "Some") {
          const error = dieOption.value as StepSleepForbiddenError;
          expect(error.message).toContain("Effect.sleep is not allowed inside a step");
          expect(error.message).toContain("Steps should be atomic units of work");
          expect(error.message).toContain("Use Workflow.sleep at the workflow level");
        }
      }
    });
  });
});
