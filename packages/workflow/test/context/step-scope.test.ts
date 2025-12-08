import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  StepScopeLayer,
  isInStepScope,
  guardWorkflowOperation,
  rejectInsideStep,
  StepScopeError,
} from "../../src";

describe("StepScope", () => {
  describe("isInStepScope", () => {
    it("should return false outside step", async () => {
      const result = await Effect.runPromise(isInStepScope);
      expect(result).toBe(false);
    });

    it("should return true inside step", async () => {
      const result = await Effect.runPromise(
        isInStepScope.pipe(Effect.provide(StepScopeLayer("myStep")))
      );
      expect(result).toBe(true);
    });
  });

  describe("guardWorkflowOperation", () => {
    it("should succeed outside step", async () => {
      const result = await Effect.runPromise(
        guardWorkflowOperation("Workflow.sleep").pipe(Effect.either)
      );

      expect(result._tag).toBe("Right");
    });

    it("should fail inside step", async () => {
      const result = await Effect.runPromise(
        guardWorkflowOperation("Workflow.sleep").pipe(
          Effect.provide(StepScopeLayer("fetchData")),
          Effect.either
        )
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(StepScopeError);
        expect(result.left.operation).toBe("Workflow.sleep");
        expect(result.left.stepName).toBe("fetchData");
      }
    });

    it("should include helpful error message", async () => {
      const result = await Effect.runPromise(
        guardWorkflowOperation("Workflow.step").pipe(
          Effect.provide(StepScopeLayer("processOrder")),
          Effect.either
        )
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.message).toContain("Workflow.step");
        expect(result.left.message).toContain("processOrder");
        expect(result.left.message).toContain("Effect.sleep() is allowed inside steps");
      }
    });
  });

  describe("rejectInsideStep (alias)", () => {
    it("should be an alias for guardWorkflowOperation", async () => {
      expect(rejectInsideStep).toBe(guardWorkflowOperation);
    });

    it("should work the same way", async () => {
      const result = await Effect.runPromise(
        rejectInsideStep("Workflow.sleep").pipe(
          Effect.provide(StepScopeLayer("myStep")),
          Effect.either
        )
      );

      expect(result._tag).toBe("Left");
    });
  });

  describe("StepScopeError", () => {
    it("should have correct properties", () => {
      const error = new StepScopeError({
        operation: "Workflow.sleep",
        stepName: "fetchData",
      });

      expect(error.operation).toBe("Workflow.sleep");
      expect(error.stepName).toBe("fetchData");
      expect(error._tag).toBe("StepScopeError");
      expect(error.name).toBe("StepScopeError");
    });

    it("should have descriptive message", () => {
      const error = new StepScopeError({
        operation: "Workflow.step",
        stepName: "innerStep",
      });

      expect(error.message).toContain("Workflow.step");
      expect(error.message).toContain("innerStep");
      expect(error.message).toContain("cannot be used inside");
      expect(error.message).toContain("Effect.sleep() is allowed");
    });
  });

  describe("nesting detection", () => {
    it("should detect nested workflow primitives", async () => {
      // Simulate: step tries to call Workflow.sleep
      const stepEffect = Effect.gen(function* () {
        // We're inside a step, try to use a workflow primitive
        yield* guardWorkflowOperation("Workflow.sleep");
        return "should not reach here";
      });

      const result = await Effect.runPromise(
        stepEffect.pipe(
          Effect.provide(StepScopeLayer("outerStep")),
          Effect.either
        )
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(StepScopeError);
      }
    });

    it("should detect nested step calls", async () => {
      // Simulate: step tries to call Workflow.step
      const stepEffect = Effect.gen(function* () {
        yield* guardWorkflowOperation("Workflow.step");
        return "should not reach here";
      });

      const result = await Effect.runPromise(
        stepEffect.pipe(
          Effect.provide(StepScopeLayer("outerStep")),
          Effect.either
        )
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.operation).toBe("Workflow.step");
        expect(result.left.stepName).toBe("outerStep");
      }
    });
  });

  describe("step name tracking", () => {
    it("should track different step names", async () => {
      const step1Result = await Effect.runPromise(
        guardWorkflowOperation("Workflow.sleep").pipe(
          Effect.provide(StepScopeLayer("step1")),
          Effect.either
        )
      );

      const step2Result = await Effect.runPromise(
        guardWorkflowOperation("Workflow.sleep").pipe(
          Effect.provide(StepScopeLayer("step2")),
          Effect.either
        )
      );

      expect(step1Result._tag).toBe("Left");
      expect(step2Result._tag).toBe("Left");
      if (step1Result._tag === "Left" && step2Result._tag === "Left") {
        expect(step1Result.left.stepName).toBe("step1");
        expect(step2Result.left.stepName).toBe("step2");
      }
    });
  });
});
