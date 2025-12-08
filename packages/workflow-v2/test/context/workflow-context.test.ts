import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  createInMemoryRuntime,
  WorkflowContext,
  WorkflowContextLayer,
  StorageAdapter,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("WorkflowContext", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000, instanceId: "wf-123" })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const runWithContext = <A, E>(
    effect: Effect.Effect<A, E, WorkflowContext | StorageAdapter>
  ) =>
    effect.pipe(
      Effect.provide(WorkflowContextLayer),
      Effect.provide(runtimeLayer),
      Effect.runPromise
    );

  describe("identity", () => {
    it("should return workflow ID from runtime", async () => {
      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.workflowId;
        })
      );

      expect(result).toBe("wf-123");
    });

    it("should return workflow name from storage", async () => {
      // Setup: store workflow name
      await runWithContext(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:name", "myWorkflow");
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.workflowName;
        })
      );

      expect(result).toBe("myWorkflow");
    });

    it("should return 'unknown' when workflow name not set", async () => {
      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.workflowName;
        })
      );

      expect(result).toBe("unknown");
    });

    it("should return input from storage", async () => {
      // Setup: store input
      await runWithContext(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:input", { data: 42 });
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.input<{ data: number }>();
        })
      );

      expect(result).toEqual({ data: 42 });
    });

    it("should return executionId from storage", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:executionId", "exec-456");
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.executionId;
        })
      );

      expect(result).toBe("exec-456");
    });
  });

  describe("step tracking", () => {
    it("should track completed steps", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          yield* ctx.markStepCompleted("step1");
          yield* ctx.markStepCompleted("step2");
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.completedSteps;
        })
      );

      expect(result).toEqual(["step1", "step2"]);
    });

    it("should not duplicate completed steps", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          yield* ctx.markStepCompleted("step1");
          yield* ctx.markStepCompleted("step1");
          yield* ctx.markStepCompleted("step1");
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.completedSteps;
        })
      );

      expect(result).toEqual(["step1"]);
    });

    it("should check if step is completed", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          yield* ctx.markStepCompleted("step1");
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return {
            step1: yield* ctx.hasCompletedStep("step1"),
            step2: yield* ctx.hasCompletedStep("step2"),
          };
        })
      );

      expect(result.step1).toBe(true);
      expect(result.step2).toBe(false);
    });
  });

  describe("pause point tracking", () => {
    it("should track pause index", async () => {
      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          const i1 = yield* ctx.incrementPauseIndex();
          const i2 = yield* ctx.incrementPauseIndex();
          const i3 = yield* ctx.incrementPauseIndex();
          return { i1, i2, i3 };
        })
      );

      expect(result).toEqual({ i1: 1, i2: 2, i3: 3 });
    });

    it("should determine if pause should execute based on completedPauseIndex", async () => {
      // completedPauseIndex tracks what was completed in PREVIOUS runs
      // It's set by the orchestrator, not by incrementPauseIndex
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:completedPauseIndex", 2);
        }).pipe(Effect.provide(runtimeLayer))
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return {
            p1: yield* ctx.shouldExecutePause(1),
            p2: yield* ctx.shouldExecutePause(2),
            p3: yield* ctx.shouldExecutePause(3),
          };
        })
      );

      expect(result.p1).toBe(false); // Already completed (1 <= 2)
      expect(result.p2).toBe(false); // Already completed (2 <= 2)
      expect(result.p3).toBe(true); // Should execute (3 > 2)
    });

    it("should return 0 for completedPauseIndex when not set", async () => {
      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.completedPauseIndex;
        })
      );

      expect(result).toBe(0);
    });
  });

  describe("resume tracking", () => {
    it("should set and get pending resume time", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          yield* ctx.setPendingResumeAt(5000);
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.pendingResumeAt;
        })
      );

      expect(result).toBe(5000);
    });

    it("should clear pending resume time", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          yield* ctx.setPendingResumeAt(5000);
          yield* ctx.clearPendingResumeAt();
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.pendingResumeAt;
        })
      );

      expect(result).toBeUndefined();
    });
  });

  describe("metadata", () => {
    it("should store and retrieve metadata", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          yield* ctx.setMeta("customKey", { nested: { value: 42 } });
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.getMeta<{ nested: { value: number } }>("customKey");
        })
      );

      expect(result).toEqual({ nested: { value: 42 } });
    });

    it("should return undefined for missing metadata", async () => {
      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.getMeta("nonexistent");
        })
      );

      expect(result).toBeUndefined();
    });
  });

  describe("timing", () => {
    it("should return current time from runtime", async () => {
      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.now;
        })
      );

      expect(result).toBe(1000);
    });

    it("should get startedAt from storage", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:startedAt", 500);
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.startedAt;
        })
      );

      expect(result).toBe(500);
    });
  });
});
