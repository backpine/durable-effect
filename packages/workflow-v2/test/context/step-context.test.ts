import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  createInMemoryRuntime,
  StepContext,
  StepContextLayer,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("StepContext", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000 })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const runWithStep = <A, E>(
    stepName: string,
    effect: Effect.Effect<A, E, StepContext>
  ) =>
    effect.pipe(
      Effect.provide(StepContextLayer(stepName)),
      Effect.provide(runtimeLayer),
      Effect.runPromise
    );

  describe("step name", () => {
    it("should return the step name", async () => {
      const result = await runWithStep(
        "fetchData",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return ctx.stepName;
        })
      );

      expect(result).toBe("fetchData");
    });
  });

  describe("attempt tracking", () => {
    it("should start at attempt 1", async () => {
      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.attempt;
        })
      );

      expect(result).toBe(1);
    });

    it("should increment attempts", async () => {
      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          const a1 = yield* ctx.incrementAttempt();
          const a2 = yield* ctx.incrementAttempt();
          const a3 = yield* ctx.incrementAttempt();
          return { a1, a2, a3 };
        })
      );

      // incrementAttempt moves from current attempt (default 1) to next
      // So first call: 1 → 2, second: 2 → 3, third: 3 → 4
      expect(result).toEqual({ a1: 2, a2: 3, a3: 4 });
    });

    it("should reset attempts", async () => {
      await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.incrementAttempt();
          yield* ctx.incrementAttempt();
          yield* ctx.resetAttempt();
        })
      );

      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.attempt;
        })
      );

      expect(result).toBe(1);
    });
  });

  describe("result caching", () => {
    it("should cache and retrieve results", async () => {
      await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.setResult({ data: "result" }, {
            completedAt: 1500,
            attempt: 1,
            durationMs: 500,
          });
        })
      );

      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.getResult<{ data: string }>();
        })
      );

      expect(result).toEqual({
        value: { data: "result" },
        meta: {
          completedAt: 1500,
          attempt: 1,
          durationMs: 500,
        },
      });
    });

    it("should return undefined for missing results", async () => {
      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.getResult();
        })
      );

      expect(result).toBeUndefined();
    });

    it("should check if result exists", async () => {
      const before = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.hasResult;
        })
      );

      await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.setResult("value", {
            completedAt: 1500,
            attempt: 1,
            durationMs: 100,
          });
        })
      );

      const after = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.hasResult;
        })
      );

      expect(before).toBe(false);
      expect(after).toBe(true);
    });
  });

  describe("startedAt tracking", () => {
    it("should set and get startedAt", async () => {
      await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.setStartedAt(1000);
        })
      );

      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.startedAt;
        })
      );

      expect(result).toBe(1000);
    });

    it("should return undefined when startedAt not set", async () => {
      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.startedAt;
        })
      );

      expect(result).toBeUndefined();
    });
  });

  describe("deadline calculation", () => {
    it("should calculate deadline from started time", async () => {
      await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.setStartedAt(1000);
        })
      );

      const deadline = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.calculateDeadline(5000);
        })
      );

      expect(deadline).toBe(6000); // 1000 + 5000
    });

    it("should calculate deadline from now if not started", async () => {
      const deadline = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.calculateDeadline(5000);
        })
      );

      expect(deadline).toBe(6000); // 1000 (initialTime) + 5000
    });
  });

  describe("metadata", () => {
    it("should set and get step metadata", async () => {
      await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.setMeta("retryReason", "network-failure");
        })
      );

      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.getMeta<string>("retryReason");
        })
      );

      expect(result).toBe("network-failure");
    });
  });

  describe("clear", () => {
    it("should clear step state", async () => {
      // Set up state
      await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.incrementAttempt();
          yield* ctx.incrementAttempt();
          yield* ctx.setStartedAt(1000);
          yield* ctx.setResult("value", {
            completedAt: 1500,
            attempt: 2,
            durationMs: 500,
          });
        })
      );

      // Clear
      await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.clear();
        })
      );

      // Verify cleared
      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return {
            attempt: yield* ctx.attempt,
            startedAt: yield* ctx.startedAt,
            hasResult: yield* ctx.hasResult,
          };
        })
      );

      expect(result.attempt).toBe(1);
      expect(result.startedAt).toBeUndefined();
      expect(result.hasResult).toBe(false);
    });
  });

  describe("step isolation", () => {
    it("should isolate state between steps", async () => {
      // Set result for step1
      await runWithStep(
        "step1",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.setResult("step1-result", {
            completedAt: 1000,
            attempt: 1,
            durationMs: 100,
          });
        })
      );

      // step2 should have no result
      const step2Result = await runWithStep(
        "step2",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.getResult();
        })
      );

      expect(step2Result).toBeUndefined();

      // step1 should still have its result
      const step1Result = await runWithStep(
        "step1",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.getResult();
        })
      );

      expect(step1Result?.value).toBe("step1-result");
    });
  });
});
