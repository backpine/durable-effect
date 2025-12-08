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
  retry,
  Backoff,
  RetryExhaustedError,
  PauseSignal,
  isPauseSignal,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("Workflow.retry (pipeable operator)", () => {
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

  describe("basic retry behavior", () => {
    it("should succeed on first attempt if no error", async () => {
      let attempts = 0;

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "successfulStep",
            Effect.sync(() => {
              attempts++;
              return "success";
            }).pipe(retry({ maxAttempts: 3 }))
          );
        })
      );

      expect(result).toBe("success");
      expect(attempts).toBe(1);
    });

    it("should return cached result on replay", async () => {
      let attempts = 0;

      // First run - success
      await runStep(
        Effect.gen(function* () {
          return yield* step(
            "cachedStep",
            Effect.sync(() => {
              attempts++;
              return "cached";
            }).pipe(retry({ maxAttempts: 3 }))
          );
        })
      );

      expect(attempts).toBe(1);

      // Second run - should use cache
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "cachedStep",
            Effect.sync(() => {
              attempts++;
              return "new";
            }).pipe(retry({ maxAttempts: 3 }))
          );
        })
      );

      expect(result).toBe("cached");
      expect(attempts).toBe(1); // Still 1
    });
  });

  describe("PauseSignal on failure", () => {
    it("should throw PauseSignal on failure for retry", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "failingStep",
            Effect.fail(new Error("always fails")).pipe(
              retry({ maxAttempts: 3 })
            )
          ).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(isPauseSignal(result.left)).toBe(true);
        const signal = result.left as PauseSignal;
        expect(signal.reason).toBe("retry");
        expect(signal.stepName).toBe("failingStep");
        expect(signal.attempt).toBe(2);
      }
    });

    it("should calculate delay using backoff strategy", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "backoffStep",
            Effect.fail(new Error("fails")).pipe(
              retry({
                maxAttempts: 5,
                delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
                jitter: false,
              })
            )
          ).pipe(Effect.either);
        })
      );

      if (result._tag === "Left" && isPauseSignal(result.left)) {
        const signal = result.left as PauseSignal;
        // First failure, delay should be 1000ms from now
        expect(signal.resumeAt).toBe(2000); // 1000 (now) + 1000 (delay)
      }
    });
  });

  describe("retry exhaustion", () => {
    it("should throw RetryExhaustedError after max attempts", async () => {
      // Simulate being at max attempts
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("step:exhaustedStep:attempt", 5); // maxAttempts + 2
        }).pipe(Effect.provide(runtimeLayer))
      );

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "exhaustedStep",
            Effect.fail(new Error("fails")).pipe(retry({ maxAttempts: 3 }))
          ).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RetryExhaustedError);
        const error = result.left as RetryExhaustedError;
        expect(error.stepName).toBe("exhaustedStep");
      }
    });
  });

  describe("isRetryable option", () => {
    it("should respect isRetryable function", async () => {
      class NonRetryableError extends Error {
        readonly _tag = "NonRetryableError";
      }

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "selectiveRetry",
            Effect.fail(new NonRetryableError("not retryable")).pipe(
              retry({
                maxAttempts: 3,
                isRetryable: (e) => !(e instanceof NonRetryableError),
              })
            )
          ).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        // Should fail immediately, not PauseSignal
        expect(result.left).toBeInstanceOf(NonRetryableError);
      }
    });
  });

  describe("Backoff helpers", () => {
    it("should create constant backoff", () => {
      const strategy = Backoff.constant("5 seconds");
      expect(strategy.type).toBe("constant");
      if (strategy.type === "constant") {
        expect(strategy.delayMs).toBe(5000);
      }
    });

    it("should create linear backoff", () => {
      const strategy = Backoff.linear({
        initial: "1 second",
        increment: "500ms",
        max: "10 seconds",
      });
      expect(strategy.type).toBe("linear");
      if (strategy.type === "linear") {
        expect(strategy.initialDelayMs).toBe(1000);
        expect(strategy.incrementMs).toBe(500);
        expect(strategy.maxDelayMs).toBe(10000);
      }
    });

    it("should create exponential backoff", () => {
      const strategy = Backoff.exponential({
        base: "1 second",
        factor: 3,
        max: "30 seconds",
      });
      expect(strategy.type).toBe("exponential");
      if (strategy.type === "exponential") {
        expect(strategy.initialDelayMs).toBe(1000);
        expect(strategy.multiplier).toBe(3);
        expect(strategy.maxDelayMs).toBe(30000);
      }
    });

    it("should have preset strategies", () => {
      const standard = Backoff.presets.standard();
      expect(standard.type).toBe("exponential");
      if (standard.type === "exponential") {
        expect(standard.initialDelayMs).toBe(1000);
      }

      const aggressive = Backoff.presets.aggressive();
      if (aggressive.type === "exponential") {
        expect(aggressive.initialDelayMs).toBe(100);
      }

      const patient = Backoff.presets.patient();
      if (patient.type === "exponential") {
        expect(patient.initialDelayMs).toBe(5000);
      }

      const simple = Backoff.presets.simple();
      expect(simple.type).toBe("constant");
    });
  });

  describe("delay config variations", () => {
    it("should accept string delay", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "stringDelay",
            Effect.fail(new Error("fails")).pipe(
              retry({ maxAttempts: 3, delay: "2 seconds", jitter: false })
            )
          ).pipe(Effect.either);
        })
      );

      if (result._tag === "Left" && isPauseSignal(result.left)) {
        expect(result.left.resumeAt).toBe(3000); // 1000 + 2000
      }
    });

    it("should accept number delay", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "numberDelay",
            Effect.fail(new Error("fails")).pipe(
              retry({ maxAttempts: 3, delay: 1500, jitter: false })
            )
          ).pipe(Effect.either);
        })
      );

      if (result._tag === "Left" && isPauseSignal(result.left)) {
        expect(result.left.resumeAt).toBe(2500); // 1000 + 1500
      }
    });

    it("should accept function delay", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "functionDelay",
            Effect.fail(new Error("fails")).pipe(
              retry({
                maxAttempts: 3,
                delay: (attempt) => attempt * 1000,
                jitter: false,
              })
            )
          ).pipe(Effect.either);
        })
      );

      if (result._tag === "Left" && isPauseSignal(result.left)) {
        // First attempt, delay = 1 * 1000 = 1000
        expect(result.left.resumeAt).toBe(2000); // 1000 + 1000
      }
    });
  });
});
