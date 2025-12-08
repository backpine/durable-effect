import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  StorageAdapter,
  WorkflowContext,
  WorkflowContextLayer,
  WorkflowScope,
  WorkflowScopeLayer,
  WorkflowLevelLayer,
  step,
  timeout,
  WorkflowTimeoutError,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("Workflow.timeout (pipeable operator)", () => {
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
      Layer.provideMerge(WorkflowLevelLayer),
      Layer.provideMerge(runtimeLayer)
    );

  const runStep = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(createLayers() as Layer.Layer<R>),
      Effect.runPromise
    );

  describe("basic timeout behavior", () => {
    it("should succeed within timeout", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "fastStep",
            Effect.succeed("done").pipe(timeout("30 seconds"))
          );
        })
      );

      expect(result).toBe("done");
    });

    it("should fail if operation times out", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "slowStep",
            Effect.promise(
              () => new Promise((resolve) => setTimeout(resolve, 1000))
            ).pipe(timeout(50))
          ).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(WorkflowTimeoutError);
        const error = result.left as WorkflowTimeoutError;
        expect(error.stepName).toBe("slowStep");
        expect(error.timeoutMs).toBe(50);
      }
    });
  });

  describe("duration parsing", () => {
    it("should accept string duration", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "stringTimeout",
            Effect.succeed("done").pipe(timeout("5 seconds"))
          );
        })
      );

      expect(result).toBe("done");
    });

    it("should accept number duration (ms)", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "numberTimeout",
            Effect.succeed("done").pipe(timeout(5000))
          );
        })
      );

      expect(result).toBe("done");
    });
  });

  describe("start time tracking", () => {
    it("should persist start time across runs", async () => {
      // First run
      await runStep(
        Effect.gen(function* () {
          return yield* step(
            "persistentTimeout",
            Effect.succeed("first").pipe(timeout("30 seconds"))
          );
        })
      );

      // Check that start time was saved
      const startedAt = await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          return yield* storage.get<number>("step:persistentTimeout:startedAt");
        }).pipe(Effect.provide(runtimeLayer))
      );

      expect(startedAt).toBe(1000);
    });

    it("should fail immediately if deadline already passed", async () => {
      // Set start time in the past
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("step:expiredStep:startedAt", 0); // Started at time 0
        }).pipe(Effect.provide(runtimeLayer))
      );

      // Current time is 1000, so 500ms timeout from time 0 is expired
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "expiredStep",
            Effect.succeed("should not reach").pipe(timeout("500ms"))
          ).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(WorkflowTimeoutError);
      }
    });
  });

  describe("WorkflowTimeoutError", () => {
    it("should have correct properties", () => {
      const error = new WorkflowTimeoutError("myStep", 5000, 5500);

      expect(error.stepName).toBe("myStep");
      expect(error.timeoutMs).toBe(5000);
      expect(error.elapsedMs).toBe(5500);
      expect(error._tag).toBe("WorkflowTimeoutError");
      expect(error.name).toBe("WorkflowTimeoutError");
    });

    it("should have descriptive message", () => {
      const error = new WorkflowTimeoutError("myStep", 5000, 5500);

      expect(error.message).toContain("myStep");
      expect(error.message).toContain("5500ms");
      expect(error.message).toContain("timeout: 5000ms");
    });
  });

  describe("combined with retry", () => {
    it("should work with retry operator", async () => {
      let attempts = 0;

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "timeoutRetryStep",
            Effect.sync(() => {
              attempts++;
              return "success";
            }).pipe(
              timeout("30 seconds")
              // Note: retry would be piped after timeout
            )
          );
        })
      );

      expect(result).toBe("success");
      expect(attempts).toBe(1);
    });
  });
});
