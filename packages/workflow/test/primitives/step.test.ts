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
  WorkflowLevelLayer,
  step,
  Backoff,
  StepCancelledError,
  RetryExhaustedError,
  WorkflowTimeoutError,
  WorkflowScopeError,
  PauseSignal,
  isPauseSignal,
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
      Layer.provideMerge(WorkflowLevelLayer),
      Layer.provideMerge(runtimeLayer)
    );

  const runStep = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(createLayers() as Layer.Layer<R>),
      Effect.runPromise
    );

  // ===========================================================================
  // BASIC EXECUTION
  // ===========================================================================
  describe("basic execution", () => {
    it("should execute step and return result", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({ name: "myStep", execute: Effect.succeed(42) });
        })
      );

      expect(result).toBe(42);
    });

    it("should execute async step", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "asyncStep",
            execute: Effect.promise(async () => {
              await new Promise((r) => setTimeout(r, 10));
              return "async result";
            }),
          });
        })
      );

      expect(result).toBe("async result");
    });

    it("should propagate step errors", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "failingStep",
            execute: Effect.fail(new Error("step failed")),
          }).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
    });
  });

  // ===========================================================================
  // RESULT CACHING
  // ===========================================================================
  describe("result caching", () => {
    it("should cache and replay results", async () => {
      let executionCount = 0;

      // First execution
      await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "cachedStep",
            execute: Effect.sync(() => {
              executionCount++;
              return "result";
            }),
          });
        })
      );

      expect(executionCount).toBe(1);

      // Second execution (should use cache)
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "cachedStep",
            execute: Effect.sync(() => {
              executionCount++;
              return "result";
            }),
          });
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
          yield* step({
            name: "step1",
            execute: Effect.sync(() => {
              step1Count++;
              return "step1";
            }),
          });
          yield* step({
            name: "step2",
            execute: Effect.sync(() => {
              step2Count++;
              return "step2";
            }),
          });
        })
      );

      expect(step1Count).toBe(1);
      expect(step2Count).toBe(1);
    });
  });

  // ===========================================================================
  // CANCELLATION
  // ===========================================================================
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
          return yield* step({
            name: "cancelledStep",
            execute: Effect.succeed("should not run"),
          }).pipe(Effect.either);
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
          return yield* step({
            name: "cancelledStep",
            execute: Effect.sync(() => {
              executed = true;
              return "result";
            }),
          }).pipe(Effect.either);
        })
      );

      expect(executed).toBe(false);
    });
  });

  // ===========================================================================
  // WORKFLOW SCOPE REQUIREMENT
  // ===========================================================================
  describe("workflow scope requirement", () => {
    it("should fail outside workflow scope", async () => {
      const result = await Effect.gen(function* () {
        return yield* step({
          name: "noScope",
          execute: Effect.succeed(42),
        }).pipe(Effect.either);
      }).pipe(
        // No WorkflowScopeLayer! (but WorkflowLevel is needed for compile-time check)
        Effect.provide(WorkflowLevelLayer),
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

  // ===========================================================================
  // MULTIPLE STEPS
  // ===========================================================================
  describe("multiple steps", () => {
    it("should execute steps in sequence", async () => {
      const order: string[] = [];

      await runStep(
        Effect.gen(function* () {
          yield* step({
            name: "step1",
            execute: Effect.sync(() => {
              order.push("step1");
              return 1;
            }),
          });
          yield* step({
            name: "step2",
            execute: Effect.sync(() => {
              order.push("step2");
              return 2;
            }),
          });
          yield* step({
            name: "step3",
            execute: Effect.sync(() => {
              order.push("step3");
              return 3;
            }),
          });
        })
      );

      expect(order).toEqual(["step1", "step2", "step3"]);
    });

    it("should track completed steps", async () => {
      await runStep(
        Effect.gen(function* () {
          yield* step({ name: "stepA", execute: Effect.succeed("A") });
          yield* step({ name: "stepB", execute: Effect.succeed("B") });
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

  // ===========================================================================
  // RETRY (Config-based)
  // ===========================================================================
  describe("retry", () => {
    it("should succeed on first attempt if no error", async () => {
      let attempts = 0;

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "successfulStep",
            execute: Effect.sync(() => {
              attempts++;
              return "success";
            }),
            retry: { maxAttempts: 3 },
          });
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
          return yield* step({
            name: "cachedRetryStep",
            execute: Effect.sync(() => {
              attempts++;
              return "cached";
            }),
            retry: { maxAttempts: 3 },
          });
        })
      );

      expect(attempts).toBe(1);

      // Second run - should use cache
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "cachedRetryStep",
            execute: Effect.sync(() => {
              attempts++;
              return "new";
            }),
            retry: { maxAttempts: 3 },
          });
        })
      );

      expect(result).toBe("cached");
      expect(attempts).toBe(1); // Still 1
    });

    it("should throw PauseSignal on failure for retry", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "failingStep",
            execute: Effect.fail(new Error("always fails")),
            retry: { maxAttempts: 3 },
          }).pipe(Effect.either);
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
          return yield* step({
            name: "backoffStep",
            execute: Effect.fail(new Error("fails")),
            retry: {
              maxAttempts: 5,
              delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
              jitter: false,
            },
          }).pipe(Effect.either);
        })
      );

      if (result._tag === "Left" && isPauseSignal(result.left)) {
        const signal = result.left as PauseSignal;
        // First failure, delay should be 1000ms from now
        expect(signal.resumeAt).toBe(2000); // 1000 (now) + 1000 (delay)
      }
    });

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
          return yield* step({
            name: "exhaustedStep",
            execute: Effect.fail(new Error("fails")),
            retry: { maxAttempts: 3 },
          }).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RetryExhaustedError);
        const error = result.left as RetryExhaustedError;
        expect(error.stepName).toBe("exhaustedStep");
      }
    });

    it("should allow exactly maxAttempts retries after initial attempt", async () => {
      // Test with maxAttempts: 1 - should get 1 initial + 1 retry = 2 executions
      let executionCount = 0;

      // First execution (attempt 1) - should fail and schedule retry
      const firstResult = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "maxAttempts1Step",
            execute: Effect.gen(function* () {
              executionCount++;
              return yield* Effect.fail(new Error("always fails"));
            }),
            retry: { maxAttempts: 1 },
          }).pipe(Effect.either);
        })
      );

      expect(executionCount).toBe(1);
      expect(firstResult._tag).toBe("Left");
      if (firstResult._tag === "Left") {
        expect(isPauseSignal(firstResult.left)).toBe(true);
        const signal = firstResult.left as PauseSignal;
        expect(signal.reason).toBe("retry");
        expect(signal.attempt).toBe(2); // Next attempt will be 2
      }

      // Second execution (attempt 2) - should fail and exhaust
      const secondResult = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "maxAttempts1Step",
            execute: Effect.gen(function* () {
              executionCount++;
              return yield* Effect.fail(new Error("always fails"));
            }),
            retry: { maxAttempts: 1 },
          }).pipe(Effect.either);
        })
      );

      expect(executionCount).toBe(2); // Executed twice total
      expect(secondResult._tag).toBe("Left");
      if (secondResult._tag === "Left") {
        expect(secondResult.left).toBeInstanceOf(RetryExhaustedError);
        const error = secondResult.left as RetryExhaustedError;
        expect(error.attempts).toBe(2);
      }
    });

    it("should exhaust immediately with maxAttempts: 0 (no retries)", async () => {
      let executionCount = 0;

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "noRetryStep",
            execute: Effect.gen(function* () {
              executionCount++;
              return yield* Effect.fail(new Error("fails"));
            }),
            retry: { maxAttempts: 0 },
          }).pipe(Effect.either);
        })
      );

      expect(executionCount).toBe(1); // Only initial attempt
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RetryExhaustedError);
        const error = result.left as RetryExhaustedError;
        expect(error.attempts).toBe(1);
      }
    });

    it("should respect isRetryable function", async () => {
      class NonRetryableError extends Error {
        readonly _tag = "NonRetryableError";
      }

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "selectiveRetry",
            execute: Effect.fail(new NonRetryableError("not retryable")),
            retry: {
              maxAttempts: 3,
              isRetryable: (e) => !(e instanceof NonRetryableError),
            },
          }).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        // Should fail immediately, not PauseSignal
        expect(result.left).toBeInstanceOf(NonRetryableError);
      }
    });

    describe("delay config variations", () => {
      it("should accept string delay", async () => {
        const result = await runStep(
          Effect.gen(function* () {
            return yield* step({
              name: "stringDelay",
              execute: Effect.fail(new Error("fails")),
              retry: { maxAttempts: 3, delay: "2 seconds", jitter: false },
            }).pipe(Effect.either);
          })
        );

        if (result._tag === "Left" && isPauseSignal(result.left)) {
          expect(result.left.resumeAt).toBe(3000); // 1000 + 2000
        }
      });

      it("should accept number delay", async () => {
        const result = await runStep(
          Effect.gen(function* () {
            return yield* step({
              name: "numberDelay",
              execute: Effect.fail(new Error("fails")),
              retry: { maxAttempts: 3, delay: 1500, jitter: false },
            }).pipe(Effect.either);
          })
        );

        if (result._tag === "Left" && isPauseSignal(result.left)) {
          expect(result.left.resumeAt).toBe(2500); // 1000 + 1500
        }
      });

      it("should accept function delay", async () => {
        const result = await runStep(
          Effect.gen(function* () {
            return yield* step({
              name: "functionDelay",
              execute: Effect.fail(new Error("fails")),
              retry: {
                maxAttempts: 3,
                delay: (attempt) => attempt * 1000,
                jitter: false,
              },
            }).pipe(Effect.either);
          })
        );

        if (result._tag === "Left" && isPauseSignal(result.left)) {
          // First attempt, delay = 1 * 1000 = 1000
          expect(result.left.resumeAt).toBe(2000); // 1000 + 1000
        }
      });
    });
  });

  // ===========================================================================
  // TIMEOUT (Config-based)
  // ===========================================================================
  describe("timeout", () => {
    it("should succeed within timeout", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "fastStep",
            execute: Effect.succeed("done"),
            timeout: "30 seconds",
          });
        })
      );

      expect(result).toBe("done");
    });

    it("should fail if operation times out", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "slowStep",
            execute: Effect.promise(
              () => new Promise((resolve) => setTimeout(resolve, 1000))
            ),
            timeout: 50,
          }).pipe(Effect.either);
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

    it("should accept string duration", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "stringTimeout",
            execute: Effect.succeed("done"),
            timeout: "5 seconds",
          });
        })
      );

      expect(result).toBe("done");
    });

    it("should accept number duration (ms)", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "numberTimeout",
            execute: Effect.succeed("done"),
            timeout: 5000,
          });
        })
      );

      expect(result).toBe("done");
    });

    it("should persist start time across runs", async () => {
      // First run
      await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "persistentTimeout",
            execute: Effect.succeed("first"),
            timeout: "30 seconds",
          });
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
          return yield* step({
            name: "expiredStep",
            execute: Effect.succeed("should not reach"),
            timeout: "500ms",
          }).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(WorkflowTimeoutError);
      }
    });
  });

  // ===========================================================================
  // COMBINED RETRY + TIMEOUT
  // ===========================================================================
  describe("retry + timeout combined", () => {
    it("should apply timeout per attempt", async () => {
      let attempts = 0;

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "retryWithTimeout",
            execute: Effect.gen(function* () {
              attempts++;
              // Simulate slow operation that times out
              yield* Effect.promise(
                () => new Promise((resolve) => setTimeout(resolve, 1000))
              );
              return "done";
            }),
            timeout: 50, // Will timeout
            retry: { maxAttempts: 3 },
          }).pipe(Effect.either);
        })
      );

      expect(attempts).toBe(1);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        // First timeout should trigger retry pause
        expect(isPauseSignal(result.left)).toBe(true);
      }
    });

    it("should succeed immediately without retry on success", async () => {
      let attempts = 0;

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "successWithRetryTimeout",
            execute: Effect.sync(() => {
              attempts++;
              return "success";
            }),
            timeout: "30 seconds",
            retry: { maxAttempts: 3 },
          });
        })
      );

      expect(result).toBe("success");
      expect(attempts).toBe(1);
    });

    it("should use config with all options", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step({
            name: "fullConfig",
            execute: Effect.succeed("done"),
            timeout: "10 seconds",
            retry: {
              maxAttempts: 5,
              delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
              jitter: true,
            },
          });
        })
      );

      expect(result).toBe("done");
    });
  });

  // ===========================================================================
  // BACKOFF HELPERS
  // ===========================================================================
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

  // ===========================================================================
  // ERROR CLASSES
  // ===========================================================================
  describe("error classes", () => {
    it("StepCancelledError should have correct properties", () => {
      const error = new StepCancelledError("myStep");
      expect(error.stepName).toBe("myStep");
      expect(error._tag).toBe("StepCancelledError");
      expect(error.name).toBe("StepCancelledError");
      expect(error.message).toContain("myStep");
    });

    it("RetryExhaustedError should have correct properties", () => {
      const lastError = new Error("original error");
      const error = new RetryExhaustedError("myStep", 3, lastError);
      expect(error.stepName).toBe("myStep");
      expect(error.attempts).toBe(3);
      expect(error.lastError).toBe(lastError);
      expect(error._tag).toBe("RetryExhaustedError");
      expect(error.name).toBe("RetryExhaustedError");
      expect(error.message).toContain("myStep");
      expect(error.message).toContain("3");
    });

    it("WorkflowTimeoutError should have correct properties", () => {
      const error = new WorkflowTimeoutError("myStep", 5000, 5500);
      expect(error.stepName).toBe("myStep");
      expect(error.timeoutMs).toBe(5000);
      expect(error.elapsedMs).toBe(5500);
      expect(error._tag).toBe("WorkflowTimeoutError");
      expect(error.name).toBe("WorkflowTimeoutError");
      expect(error.message).toContain("myStep");
      expect(error.message).toContain("5500ms");
    });
  });
});
