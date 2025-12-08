import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  WorkflowStateMachine,
  WorkflowStateMachineLayer,
  RecoveryManager,
  RecoveryManagerLayer,
  RecoveryError,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("RecoveryManager", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000 })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const createLayers = (recoveryConfig?: { maxRecoveryAttempts?: number }) =>
    RecoveryManagerLayer(recoveryConfig).pipe(
      Layer.provideMerge(WorkflowStateMachineLayer),
      Layer.provide(runtimeLayer)
    );

  const runWithRecovery = <A, E>(
    effect: Effect.Effect<A, E, RecoveryManager | WorkflowStateMachine>,
    recoveryConfig?: { maxRecoveryAttempts?: number }
  ) => effect.pipe(Effect.provide(createLayers(recoveryConfig)), Effect.runPromise);

  describe("checkAndScheduleRecovery", () => {
    it("should return no_workflow when no workflow exists", async () => {
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe("no_workflow");
    });

    it("should return not_needed for Pending workflow", async () => {
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          const recovery = yield* RecoveryManager;

          yield* machine.initialize("test", {});
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe("not_needed");
    });

    it("should return not_needed for Running workflow that is not stale", async () => {
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          const recovery = yield* RecoveryManager;

          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });

          // Only advance 5 seconds (not stale)
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      // Advance time a little but not past threshold
      await Effect.runPromise(handle.advanceTime(5000));

      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe("not_needed");
    });

    it("should schedule recovery for stale Running workflow", async () => {
      // Start workflow
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
        })
      );

      // Advance time past stale threshold
      await Effect.runPromise(handle.advanceTime(35_000));

      // Check recovery
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(result.scheduled).toBe(true);
      expect(result.reason).toBe("stale_running");
      expect(result.staleDurationMs).toBeGreaterThanOrEqual(35_000);
      expect(result.attempt).toBe(1);

      // Verify alarm was scheduled
      const schedulerState = await Effect.runPromise(handle.getSchedulerState());
      expect(schedulerState.scheduledTime).toBeDefined();
    });

    it("should schedule recovery for Paused workflow with pending resume", async () => {
      // Start and pause workflow
      await runWithRecovery(
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

      // Check recovery
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(result.scheduled).toBe(true);
      expect(result.reason).toBe("pending_resume");
    });

    it("should return already_terminal for completed workflow", async () => {
      // Complete workflow
      await runWithRecovery(
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

      // Check recovery
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe("already_terminal");
    });

    it("should respect maxRecoveryAttempts", async () => {
      // Start workflow and exhaust recovery attempts
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          // Simulate 3 failed recovery attempts
          yield* machine.incrementRecoveryAttempts();
          yield* machine.incrementRecoveryAttempts();
          yield* machine.incrementRecoveryAttempts();
        })
      );

      // Advance time past stale threshold
      await Effect.runPromise(handle.advanceTime(35_000));

      // Check recovery - should be blocked by max attempts
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe("max_attempts_exceeded");
    });
  });

  describe("executeRecovery", () => {
    it("should recover stale Running workflow", async () => {
      // Start workflow
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
        })
      );

      // Simulate infrastructure restart - workflow is "Running" but actually interrupted
      // Advance time to make it stale
      await Effect.runPromise(handle.advanceTime(35_000));

      // Execute recovery
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.executeRecovery();
        })
      );

      expect(result.success).toBe(true);
      expect(result.reason).toBe("recovered");
      expect(result.newStatus).toBe("Running");
      expect(result.attempt).toBe(1);

      // Verify recovery attempts reset
      const stats = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.getStats();
        })
      );

      expect(stats.attempts).toBe(0); // Reset after success
    });

    it("should fail after max attempts exceeded", async () => {
      // Start workflow and exhaust recovery attempts
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          yield* machine.incrementRecoveryAttempts();
          yield* machine.incrementRecoveryAttempts();
          yield* machine.incrementRecoveryAttempts();
        })
      );

      // Advance time
      await Effect.runPromise(handle.advanceTime(35_000));

      // Try to execute recovery - should fail
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.executeRecovery().pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RecoveryError);
        expect((result.left as RecoveryError).reason).toBe("max_attempts_exceeded");
      }

      // Verify workflow was marked as failed
      const status = await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.getStatus();
        })
      );

      expect(status?._tag).toBe("Failed");
    });

    it("should return already_completed for terminal workflows", async () => {
      // Complete workflow
      await runWithRecovery(
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

      // Try recovery
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.executeRecovery();
        })
      );

      expect(result.success).toBe(false);
      expect(result.reason).toBe("already_completed");
    });
  });

  describe("getStats", () => {
    it("should track recovery attempts", async () => {
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
        })
      );

      const stats1 = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.getStats();
        })
      );

      expect(stats1.attempts).toBe(0);
      expect(stats1.maxAttempts).toBe(3);
      expect(stats1.maxExceeded).toBe(false);

      // Simulate a recovery attempt
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.incrementRecoveryAttempts();
        })
      );

      const stats2 = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.getStats();
        })
      );

      expect(stats2.attempts).toBe(1);
      expect(stats2.maxExceeded).toBe(false);
    });

    it("should use custom maxRecoveryAttempts", async () => {
      const stats = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.getStats();
        }),
        { maxRecoveryAttempts: 5 }
      );

      expect(stats.maxAttempts).toBe(5);
    });
  });

  describe("integration: full recovery flow", () => {
    it("should handle complete recovery cycle", async () => {
      // 1. Start a workflow
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", { data: 42 });
          yield* machine.applyTransition({ _tag: "Start", input: { data: 42 } });
        })
      );

      // 2. Simulate infrastructure restart (time passes)
      await Effect.runPromise(handle.advanceTime(35_000));

      // 3. Constructor runs - check and schedule recovery
      const checkResult = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(checkResult.scheduled).toBe(true);
      expect(checkResult.reason).toBe("stale_running");

      // 4. Alarm fires - execute recovery
      await Effect.runPromise(handle.advanceTime(100)); // Past recovery delay

      const executeResult = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.executeRecovery();
        })
      );

      expect(executeResult.success).toBe(true);
      expect(executeResult.newStatus).toBe("Running");

      // 5. Verify workflow can continue
      const state = await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.getState();
        })
      );

      expect(state?.status._tag).toBe("Running");
      expect(state?.recoveryAttempts).toBe(0); // Reset after success
    });
  });
});
