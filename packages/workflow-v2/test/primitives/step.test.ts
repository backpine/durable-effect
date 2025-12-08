import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  StorageAdapter,
  RuntimeAdapter,
  WorkflowContext,
  WorkflowContextLayer,
  WorkflowScope,
  WorkflowScopeLayer,
  step,
  StepCancelledError,
  WorkflowScopeError,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("Workflow.step", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000 })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const createLayers = () =>
    WorkflowScopeLayer.pipe(
      Layer.provideMerge(WorkflowContextLayer),
      Layer.provideMerge(runtimeLayer)
    );

  const runStep = <A, E>(effect: Effect.Effect<A, E, any>) =>
    effect.pipe(Effect.provide(createLayers()), Effect.runPromise);

  describe("basic execution", () => {
    it("should execute step and return result", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("myStep", Effect.succeed(42));
        })
      );

      expect(result).toBe(42);
    });

    it("should execute async step", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "asyncStep",
            Effect.promise(async () => {
              await new Promise((r) => setTimeout(r, 10));
              return "async result";
            })
          );
        })
      );

      expect(result).toBe("async result");
    });

    it("should propagate step errors", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "failingStep",
            Effect.fail(new Error("step failed"))
          ).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
    });
  });

  describe("result caching", () => {
    it("should cache and replay results", async () => {
      let executionCount = 0;

      // First execution
      await runStep(
        Effect.gen(function* () {
          return yield* step(
            "cachedStep",
            Effect.sync(() => {
              executionCount++;
              return "result";
            })
          );
        })
      );

      expect(executionCount).toBe(1);

      // Second execution (should use cache)
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "cachedStep",
            Effect.sync(() => {
              executionCount++;
              return "result";
            })
          );
        })
      );

      expect(executionCount).toBe(1); // Still 1 - cached
      expect(result).toBe("result");
    });

    it("should not share cache between different steps", async () => {
      let step1Count = 0;
      let step2Count = 0;

      await runStep(
        Effect.gen(function* () {
          yield* step(
            "step1",
            Effect.sync(() => {
              step1Count++;
              return "step1";
            })
          );
          yield* step(
            "step2",
            Effect.sync(() => {
              step2Count++;
              return "step2";
            })
          );
        })
      );

      expect(step1Count).toBe(1);
      expect(step2Count).toBe(1);
    });
  });

  describe("cancellation", () => {
    it("should fail if workflow is cancelled", async () => {
      // Set cancelled flag
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:cancelled", true);
        }).pipe(Effect.provide(runtimeLayer))
      );

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("cancelledStep", Effect.succeed("should not run")).pipe(
            Effect.either
          );
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(StepCancelledError);
      }
    });

    it("should not execute effect when cancelled", async () => {
      let executed = false;

      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:cancelled", true);
        }).pipe(Effect.provide(runtimeLayer))
      );

      await runStep(
        Effect.gen(function* () {
          return yield* step(
            "cancelledStep",
            Effect.sync(() => {
              executed = true;
              return "result";
            })
          ).pipe(Effect.either);
        })
      );

      expect(executed).toBe(false);
    });
  });

  describe("workflow scope requirement", () => {
    it("should fail outside workflow scope", async () => {
      const result = await Effect.gen(function* () {
        return yield* step("noScope", Effect.succeed(42)).pipe(Effect.either);
      }).pipe(
        // No WorkflowScopeLayer!
        Effect.provide(WorkflowContextLayer),
        Effect.provide(runtimeLayer),
        Effect.runPromise
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(WorkflowScopeError);
      }
    });
  });

  describe("multiple steps", () => {
    it("should execute steps in sequence", async () => {
      const order: string[] = [];

      await runStep(
        Effect.gen(function* () {
          yield* step(
            "step1",
            Effect.sync(() => {
              order.push("step1");
              return 1;
            })
          );
          yield* step(
            "step2",
            Effect.sync(() => {
              order.push("step2");
              return 2;
            })
          );
          yield* step(
            "step3",
            Effect.sync(() => {
              order.push("step3");
              return 3;
            })
          );
        })
      );

      expect(order).toEqual(["step1", "step2", "step3"]);
    });

    it("should track completed steps", async () => {
      await runStep(
        Effect.gen(function* () {
          yield* step("stepA", Effect.succeed("A"));
          yield* step("stepB", Effect.succeed("B"));
        })
      );

      const completedSteps = await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          return yield* storage.get<string[]>("workflow:completedSteps");
        }).pipe(Effect.provide(runtimeLayer))
      );

      expect(completedSteps).toContain("stepA");
      expect(completedSteps).toContain("stepB");
    });
  });
});
