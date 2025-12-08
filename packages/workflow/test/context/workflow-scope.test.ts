import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  WorkflowScopeLayer,
  isInWorkflowScope,
  requireWorkflowScope,
  WorkflowScopeError,
} from "../../src";

describe("WorkflowScope", () => {
  describe("isInWorkflowScope", () => {
    it("should return false outside workflow", async () => {
      const result = await Effect.runPromise(isInWorkflowScope);
      expect(result).toBe(false);
    });

    it("should return true inside workflow", async () => {
      const result = await Effect.runPromise(
        isInWorkflowScope.pipe(Effect.provide(WorkflowScopeLayer))
      );
      expect(result).toBe(true);
    });
  });

  describe("requireWorkflowScope", () => {
    it("should fail outside workflow", async () => {
      const result = await Effect.runPromise(
        requireWorkflowScope.pipe(Effect.either)
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(WorkflowScopeError);
        expect(result.left.message).toContain("Workflow primitives can only be used inside a workflow");
      }
    });

    it("should succeed inside workflow", async () => {
      const result = await Effect.runPromise(
        requireWorkflowScope.pipe(
          Effect.provide(WorkflowScopeLayer),
          Effect.either
        )
      );

      expect(result._tag).toBe("Right");
    });
  });

});
