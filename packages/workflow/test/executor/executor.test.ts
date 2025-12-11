import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  WorkflowStateMachine,
  WorkflowStateMachineLayer,
  WorkflowExecutor,
  WorkflowExecutorLayer,
  make,
  step,
  sleep,
  StorageAdapter,
  type TestRuntimeHandle,
  type RuntimeLayer,
  type ExecutionResult,
} from "../../src";

describe("WorkflowExecutor", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000, instanceId: "wf-exec-123" })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const createLayers = () =>
    WorkflowExecutorLayer.pipe(
      Layer.provideMerge(WorkflowStateMachineLayer),
      Layer.provideMerge(runtimeLayer)
    );

  const runExecutor = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(createLayers() as Layer.Layer<R>),
      Effect.runPromise
    );

  // Initialize workflow state before execution
  const initWorkflow = async (name: string, input: unknown) => {
    await runExecutor(
      Effect.gen(function* () {
        const machine = yield* WorkflowStateMachine;
        yield* machine.initialize(name, input);
        yield* machine.applyTransition({ _tag: "Start", input });
      })
    );
  };

  describe("successful execution", () => {
    it("should execute simple workflow", async () => {
      await initWorkflow("simpleWorkflow", { x: 5 });

      const workflow = make((input: { x: number }) => Effect.succeed(input.x * 2));

      const result = await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          return yield* executor.execute(workflow, {
            workflowId: "wf-exec-123",
            workflowName: "simpleWorkflow",
            input: { x: 5 },
            mode: "fresh",
          });
        })
      );

      expect(result._tag).toBe("Completed");
      if (result._tag === "Completed") {
        expect(result.output).toBe(10);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("should execute workflow with steps", async () => {
      await initWorkflow("steppedWorkflow", {});

      const workflow = make((_input: {}) =>
        Effect.gen(function* () {
          const a = yield* step({ name: "step1", execute: Effect.succeed(1) });
          const b = yield* step({ name: "step2", execute: Effect.succeed(2) });
          return a + b;
        })
      );

      const result = await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          return yield* executor.execute(workflow, {
            workflowId: "wf-exec-123",
            workflowName: "steppedWorkflow",
            input: {},
            mode: "fresh",
          });
        })
      );

      expect(result._tag).toBe("Completed");
      if (result._tag === "Completed") {
        expect(result.output).toBe(3);
        expect(result.completedSteps).toContain("step1");
        expect(result.completedSteps).toContain("step2");
      }
    });
  });

  describe("pause handling", () => {
    it("should return Paused result for sleep", async () => {
      await initWorkflow("sleepWorkflow", {});

      const workflow = make((_input: {}) =>
        Effect.gen(function* () {
          yield* sleep("5 seconds");
          return "done";
        })
      );

      const result = await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          return yield* executor.execute(workflow, {
            workflowId: "wf-exec-123",
            workflowName: "sleepWorkflow",
            input: {},
            mode: "fresh",
          });
        })
      );

      expect(result._tag).toBe("Paused");
      if (result._tag === "Paused") {
        expect(result.reason).toBe("sleep");
        expect(result.resumeAt).toBe(1000 + 5000);
      }
    });

    it("should schedule alarm for pause", async () => {
      await initWorkflow("alarmWorkflow", {});

      const workflow = make((_input: {}) =>
        Effect.gen(function* () {
          yield* sleep("10 seconds");
          return "done";
        })
      );

      await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          yield* executor.execute(workflow, {
            workflowId: "wf-exec-123",
            workflowName: "alarmWorkflow",
            input: {},
            mode: "fresh",
          });
        })
      );

      // Check alarm was scheduled
      const schedulerState = await Effect.runPromise(handle.getSchedulerState());
      expect(schedulerState.scheduledTime).toBe(1000 + 10000);
    });
  });

  describe("failure handling", () => {
    it("should return Failed result for errors", async () => {
      await initWorkflow("failingWorkflow", {});

      const workflow = make((_input: {}) =>
        Effect.fail(new Error("workflow failed"))
      );

      const result = await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          return yield* executor.execute(workflow, {
            workflowId: "wf-exec-123",
            workflowName: "failingWorkflow",
            input: {},
            mode: "fresh",
          });
        })
      );

      expect(result._tag).toBe("Failed");
      if (result._tag === "Failed") {
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toBe("workflow failed");
      }
    });

    it("should return Failed result for step errors", async () => {
      await initWorkflow("stepFailWorkflow", {});

      const workflow = make((_input: {}) =>
        Effect.gen(function* () {
          yield* step({ name: "goodStep", execute: Effect.succeed("ok") });
          yield* step({ name: "badStep", execute: Effect.fail(new Error("step failed")) });
          return "done";
        })
      );

      const result = await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          return yield* executor.execute(workflow, {
            workflowId: "wf-exec-123",
            workflowName: "stepFailWorkflow",
            input: {},
            mode: "fresh",
          });
        })
      );

      expect(result._tag).toBe("Failed");
      if (result._tag === "Failed") {
        expect(result.completedSteps).toContain("goodStep");
        expect(result.completedSteps).not.toContain("badStep");
      }
    });
  });

  describe("cancellation handling", () => {
    it("should return Cancelled result when cancelled", async () => {
      await initWorkflow("cancelledWorkflow", {});

      // Set cancelled flag
      await runExecutor(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:cancelled", true);
        })
      );

      const workflow = make((_input: {}) =>
        Effect.gen(function* () {
          yield* step({ name: "firstStep", execute: Effect.succeed("ok") });
          return "done";
        })
      );

      const result = await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          return yield* executor.execute(workflow, {
            workflowId: "wf-exec-123",
            workflowName: "cancelledWorkflow",
            input: {},
            mode: "fresh",
          });
        })
      );

      expect(result._tag).toBe("Cancelled");
    });
  });

  describe("execution modes", () => {
    it("should work with fresh mode", async () => {
      await initWorkflow("freshWorkflow", { value: 42 });

      const workflow = make((input: { value: number }) => Effect.succeed(input.value));

      const result = await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          return yield* executor.execute(workflow, {
            workflowId: "wf-exec-123",
            workflowName: "freshWorkflow",
            input: { value: 42 },
            mode: "fresh",
          });
        })
      );

      expect(result._tag).toBe("Completed");
    });

    it("should work with resume mode (replay cached steps)", async () => {
      // First execution - completes first step, pauses at sleep
      await initWorkflow("resumeWorkflow", {});

      const workflow = make((_input: {}) =>
        Effect.gen(function* () {
          yield* step({ name: "step1", execute: Effect.succeed("first") });
          yield* sleep("1 second");
          const second = yield* step({ name: "step2", execute: Effect.succeed("second") });
          return second;
        })
      );

      // First run - will pause at sleep
      const firstResult = await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          return yield* executor.execute(workflow, {
            workflowId: "wf-exec-123",
            workflowName: "resumeWorkflow",
            input: {},
            mode: "fresh",
          });
        })
      );

      expect(firstResult._tag).toBe("Paused");

      // Apply Pause transition to update state machine (simulating orchestrator behavior)
      await runExecutor(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.applyTransition({
            _tag: "Pause",
            reason: "sleep",
            resumeAt: 1000 + 1000,
          });
        })
      );

      // Simulate time passing and alarm firing
      await Effect.runPromise(handle.advanceTime(2000));

      // Apply Resume transition (Paused -> Running)
      await runExecutor(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.applyTransition({ _tag: "Resume" });
          // Mark pause as completed so sleep is skipped on replay
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:completedPauseIndex", 1);
        })
      );

      // Second run - resume mode, step1 should be cached
      let step1Executed = false;
      const resumeWorkflow = make((_input: {}) =>
        Effect.gen(function* () {
          yield* step({
            name: "step1",
            execute: Effect.sync(() => {
              step1Executed = true;
              return "first";
            }),
          });
          yield* sleep("1 second");
          const second = yield* step({ name: "step2", execute: Effect.succeed("second") });
          return second;
        })
      );

      const result = await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          return yield* executor.execute(resumeWorkflow, {
            workflowId: "wf-exec-123",
            workflowName: "resumeWorkflow",
            input: {},
            mode: "resume",
          });
        })
      );

      expect(step1Executed).toBe(false); // Should use cached result
      expect(result._tag).toBe("Completed");
      if (result._tag === "Completed") {
        expect(result.output).toBe("second");
      }
    });
  });

  describe("timing", () => {
    it("should track execution duration", async () => {
      await initWorkflow("timedWorkflow", {});

      const workflow = make((_input: {}) =>
        Effect.succeed("done")
      );

      const result = await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          return yield* executor.execute(workflow, {
            workflowId: "wf-exec-123",
            workflowName: "timedWorkflow",
            input: {},
            mode: "fresh",
          });
        })
      );

      expect(result._tag).toBe("Completed");
      if (result._tag === "Completed") {
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("should record start time in storage", async () => {
      await initWorkflow("startTimeWorkflow", {});

      const workflow = make((_input: {}) =>
        Effect.succeed("done")
      );

      await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          yield* executor.execute(workflow, {
            workflowId: "wf-exec-123",
            workflowName: "startTimeWorkflow",
            input: {},
            mode: "fresh",
          });
        })
      );

      const startedAt = await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          return yield* storage.get<number>("workflow:startedAt");
        }).pipe(Effect.provide(runtimeLayer))
      );

      expect(startedAt).toBe(1000);
    });
  });

  describe("resultToTransition", () => {
    it("should convert Completed result to Complete transition", async () => {
      const { resultToTransition } = await import("../../src");

      const result: ExecutionResult<string> = {
        _tag: "Completed",
        output: "done",
        durationMs: 100,
        completedSteps: ["step1", "step2"],
      };

      const transition = resultToTransition(result);

      expect(transition._tag).toBe("Complete");
      if (transition._tag === "Complete") {
        expect(transition.completedSteps).toEqual(["step1", "step2"]);
        expect(transition.durationMs).toBe(100);
      }
    });

    it("should convert Paused result to Pause transition", async () => {
      const { resultToTransition } = await import("../../src");

      const result: ExecutionResult<string> = {
        _tag: "Paused",
        reason: "sleep",
        resumeAt: 5000,
        stepName: "sleepStep",
      };

      const transition = resultToTransition(result);

      expect(transition._tag).toBe("Pause");
      if (transition._tag === "Pause") {
        expect(transition.reason).toBe("sleep");
        expect(transition.resumeAt).toBe(5000);
        expect(transition.stepName).toBe("sleepStep");
      }
    });

    it("should convert Failed result to Fail transition", async () => {
      const { resultToTransition } = await import("../../src");

      const result: ExecutionResult<string> = {
        _tag: "Failed",
        error: new Error("something went wrong"),
        durationMs: 50,
        completedSteps: ["step1"],
      };

      const transition = resultToTransition(result);

      expect(transition._tag).toBe("Fail");
      if (transition._tag === "Fail") {
        expect(transition.error.message).toBe("something went wrong");
        expect(transition.completedSteps).toEqual(["step1"]);
      }
    });

    it("should convert Cancelled result to Cancel transition", async () => {
      const { resultToTransition } = await import("../../src");

      const result: ExecutionResult<string> = {
        _tag: "Cancelled",
        reason: "user requested",
        completedSteps: [],
      };

      const transition = resultToTransition(result);

      expect(transition._tag).toBe("Cancel");
      if (transition._tag === "Cancel") {
        expect(transition.reason).toBe("user requested");
        expect(transition.completedSteps).toEqual([]);
      }
    });
  });
});
