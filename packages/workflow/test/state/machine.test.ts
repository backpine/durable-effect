import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  createInMemoryRuntime,
  WorkflowStateMachine,
  WorkflowStateMachineLayer,
  InvalidTransitionError,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("WorkflowStateMachine", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000 })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const runWithMachine = <A, E>(
    effect: Effect.Effect<A, E, WorkflowStateMachine>
  ) =>
    effect.pipe(
      Effect.provide(WorkflowStateMachineLayer),
      Effect.provide(runtimeLayer),
      Effect.runPromise
    );

  describe("initialize", () => {
    it("should initialize workflow state", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("myWorkflow", { data: 42 }, "exec-123");
          return yield* machine.getState();
        })
      );

      expect(result).toBeDefined();
      expect(result!.status._tag).toBe("Pending");
      expect(result!.workflowName).toBe("myWorkflow");
      expect(result!.input).toEqual({ data: 42 });
      expect(result!.executionId).toBe("exec-123");
      expect(result!.completedSteps).toEqual([]);
      expect(result!.recoveryAttempts).toBe(0);
    });
  });

  describe("applyTransition", () => {
    it("should transition from Pending to Running via Start", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          return yield* machine.applyTransition({
            _tag: "Start",
            input: {},
          });
        })
      );

      expect(result._tag).toBe("Running");
      if (result._tag === "Running") {
        expect(result.runningAt).toBe(1000);
      }
    });

    it("should transition from Pending to Queued via Queue", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          return yield* machine.applyTransition({
            _tag: "Queue",
            input: {},
          });
        })
      );

      expect(result._tag).toBe("Queued");
    });

    it("should transition from Running to Paused", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          return yield* machine.applyTransition({
            _tag: "Pause",
            reason: "sleep",
            resumeAt: 5000,
          });
        })
      );

      expect(result._tag).toBe("Paused");
      if (result._tag === "Paused") {
        expect(result.reason).toBe("sleep");
        expect(result.resumeAt).toBe(5000);
      }
    });

    it("should transition from Paused to Running via Resume", async () => {
      await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          yield* machine.applyTransition({
            _tag: "Pause",
            reason: "sleep",
            resumeAt: 5000,
          });
        })
      );

      // Advance time and resume
      await Effect.runPromise(handle.advanceTime(5000));

      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.applyTransition({ _tag: "Resume" });
        })
      );

      expect(result._tag).toBe("Running");
    });

    it("should transition from Running to Completed", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          return yield* machine.applyTransition({
            _tag: "Complete",
            completedSteps: ["step1", "step2"],
            durationMs: 500,
          });
        })
      );

      expect(result._tag).toBe("Completed");
    });

    it("should transition from Running to Failed", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          return yield* machine.applyTransition({
            _tag: "Fail",
            error: { message: "Something went wrong" },
            completedSteps: ["step1"],
          });
        })
      );

      expect(result._tag).toBe("Failed");
      if (result._tag === "Failed") {
        expect(result.error.message).toBe("Something went wrong");
      }
    });

    it("should reject invalid transitions", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          // Try to Complete from Pending (invalid)
          return yield* machine.applyTransition({
            _tag: "Complete",
            completedSteps: [],
            durationMs: 0,
          }).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(InvalidTransitionError);
      }
    });
  });

  describe("checkRecoverability", () => {
    it("should detect stale Running workflow", async () => {
      await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
        })
      );

      // Advance time past threshold
      await Effect.runPromise(handle.advanceTime(35_000));

      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.checkRecoverability(30_000);
        })
      );

      expect(result.canRecover).toBe(true);
      expect(result.reason).toBe("stale_running");
      expect(result.staleDurationMs).toBeGreaterThanOrEqual(35_000);
    });

    it("should not recover Running workflow that is not stale", async () => {
      await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
        })
      );

      // Only advance time a little
      await Effect.runPromise(handle.advanceTime(5_000));

      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.checkRecoverability(30_000);
        })
      );

      expect(result.canRecover).toBe(false);
      expect(result.reason).toBe("not_recoverable");
    });

    it("should detect Paused workflow with pending resume", async () => {
      await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          yield* machine.applyTransition({
            _tag: "Pause",
            reason: "sleep",
            resumeAt: 5000,
          });
          yield* machine.setPendingResumeAt(5000);
        })
      );

      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.checkRecoverability(30_000);
        })
      );

      expect(result.canRecover).toBe(true);
      expect(result.reason).toBe("pending_resume");
    });

    it("should not recover terminal states", async () => {
      await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          yield* machine.applyTransition({
            _tag: "Complete",
            completedSteps: [],
            durationMs: 100,
          });
        })
      );

      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.checkRecoverability(30_000);
        })
      );

      expect(result.canRecover).toBe(false);
      expect(result.reason).toBe("already_terminal");
    });
  });

  describe("step tracking", () => {
    it("should track completed steps", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.markStepCompleted("step1");
          yield* machine.markStepCompleted("step2");
          yield* machine.markStepCompleted("step1"); // Duplicate
          return yield* machine.getCompletedSteps();
        })
      );

      expect(result).toEqual(["step1", "step2"]);
    });
  });

  describe("recovery attempts", () => {
    it("should track recovery attempts", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          const a1 = yield* machine.incrementRecoveryAttempts();
          const a2 = yield* machine.incrementRecoveryAttempts();
          yield* machine.resetRecoveryAttempts();
          const a3 = yield* machine.incrementRecoveryAttempts();
          return { a1, a2, a3 };
        })
      );

      expect(result.a1).toBe(1);
      expect(result.a2).toBe(2);
      expect(result.a3).toBe(1);
    });
  });

  describe("cancellation", () => {
    it("should track cancellation flag", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          const before = yield* machine.isCancelled();
          yield* machine.setCancelled("user request");
          const after = yield* machine.isCancelled();
          return { before, after };
        })
      );

      expect(result.before).toBe(false);
      expect(result.after).toBe(true);
    });
  });
});
