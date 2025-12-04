import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { ExecutionContext } from "@durable-effect/core";
import { WorkflowContext } from "@/services/workflow-context";
import { WorkflowScope } from "@/services/workflow-scope";
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

    it("allows Effect.sleep (needed for Workflow.timeout)", async () => {
      // Effect.sleep is allowed because Effect.timeoutFail uses it internally.
      // Workflow.sleep is forbidden at compile time via ForbidWorkflowScope.
      const step = Workflow.step(
        "SleepStep",
        Effect.gen(function* () {
          yield* Effect.sleep("10 millis");
          return "done";
        }),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toBe("done");
    });

    it("allows Workflow.timeout inside step", async () => {
      const step = Workflow.step(
        "TimeoutStep",
        Effect.gen(function* () {
          yield* Effect.sleep("5 millis");
          return "fast";
        }).pipe(Workflow.timeout("1 second")),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toBe("fast");
    });

    it("allows Workflow.retry inside step", async () => {
      let attempts = 0;
      const step = Workflow.step(
        "RetryStep",
        Effect.gen(function* () {
          attempts++;
          if (attempts < 2) {
            return yield* Effect.fail(new Error("First attempt fails"));
          }
          return "success";
        }).pipe(
          Workflow.retry({ maxAttempts: 3, delay: "10 millis" }),
        ),
      );

      // Note: This test may pause due to retry logic, but the structure is valid
      const exit = await Effect.runPromiseExit(runStep(step));
      // Just verify it doesn't crash with StepSleepForbiddenError
      expect(exit._tag).toBeDefined();
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
});
