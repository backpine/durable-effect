import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  WorkflowStateMachineLayer,
  WorkflowExecutorLayer,
  RecoveryManagerLayer,
  WorkflowOrchestrator,
  WorkflowOrchestratorLayer,
  WorkflowRegistryLayer,
  DisabledPurgeManagerLayer,
  make,
  step,
  sleep,
  type TestRuntimeHandle,
  type RuntimeLayer,
  type WorkflowRegistry,
} from "../../src";

// Test workflows
const testWorkflows = {
  simpleWorkflow: make((input: { value: number }) =>
    Effect.succeed(input.value * 2),
  ),

  steppedWorkflow: make((input: { items: string[] }) =>
    Effect.gen(function* () {
      const results: string[] = [];
      for (const item of input.items) {
        const result = yield* step({
          name: `process-${item}`,
          execute: Effect.succeed(item.toUpperCase()),
        });
        results.push(result);
      }
      return results;
    }),
  ),

  sleepingWorkflow: make((_input: {}) =>
    Effect.gen(function* () {
      yield* step({ name: "before", execute: Effect.succeed("before") });
      yield* sleep("5 seconds");
      yield* step({ name: "after", execute: Effect.succeed("after") });
      return "done";
    }),
  ),

  failingWorkflow: make((_input: {}) =>
    Effect.fail(new Error("intentional failure")),
  ),
} satisfies WorkflowRegistry;

describe("WorkflowOrchestrator", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000, instanceId: "orch-test-123" }),
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const createLayers = () =>
    WorkflowOrchestratorLayer<typeof testWorkflows>().pipe(
      Layer.provideMerge(WorkflowRegistryLayer(testWorkflows)),
      Layer.provideMerge(WorkflowExecutorLayer),
      Layer.provideMerge(RecoveryManagerLayer()),
      Layer.provideMerge(WorkflowStateMachineLayer),
      Layer.provideMerge(DisabledPurgeManagerLayer),
      Layer.provideMerge(runtimeLayer),
    );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runOrchestrator = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(createLayers())) as Effect.Effect<A, E, never>,
    );

  describe("start", () => {
    it("should start and complete simple workflow", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.start({
            workflow: "simpleWorkflow",
            input: { value: 21 },
          });
        }),
      );

      expect(result.id).toBe("orch-test-123");
      expect(result.completed).toBe(true);
      expect(result.output).toBe(42);
    });

    it("should start workflow with steps", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.start({
            workflow: "steppedWorkflow",
            input: { items: ["a", "b", "c"] },
          });
        }),
      );

      expect(result.completed).toBe(true);
      expect(result.output).toEqual(["A", "B", "C"]);
    });

    it("should handle workflow that pauses", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.start({
            workflow: "sleepingWorkflow",
            input: {},
          });
        }),
      );

      expect(result.completed).toBe(false);

      // Check status
      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.getStatus();
        }),
      );

      expect(status.status?._tag).toBe("Paused");
      expect(status.completedSteps).toContain("before");
    });

    it("should be idempotent (return existing workflow)", async () => {
      // First start
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          yield* orchestrator.start({
            workflow: "simpleWorkflow",
            input: { value: 10 },
          });
        }),
      );

      // Second start (same workflow)
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.start({
            workflow: "simpleWorkflow",
            input: { value: 999 }, // Different input
          });
        }),
      );

      // Should return existing (completed) workflow
      expect(result.completed).toBe(true);
    });
  });

  describe("queue", () => {
    it("should queue workflow for async execution", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.queue({
            workflow: "simpleWorkflow",
            input: { value: 5 },
          });
        }),
      );

      expect(result.completed).toBe(false);

      // Check status
      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.getStatus();
        }),
      );

      expect(status.status?._tag).toBe("Queued");

      // Check alarm was scheduled
      const schedulerState = await Effect.runPromise(
        handle.getSchedulerState(),
      );
      expect(schedulerState.scheduledTime).toBeDefined();
    });
  });

  describe("handleAlarm", () => {
    it("should start queued workflow", async () => {
      // Queue workflow
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          yield* orchestrator.queue({
            workflow: "simpleWorkflow",
            input: { value: 7 },
          });
        }),
      );

      // Handle alarm
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          yield* orchestrator.handleAlarm();
        }),
      );

      // Check completed
      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.getStatus();
        }),
      );

      expect(status.status?._tag).toBe("Completed");
    });

    it("should resume paused workflow", async () => {
      // Start workflow (will pause at sleep)
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          yield* orchestrator.start({
            workflow: "sleepingWorkflow",
            input: {},
          });
        }),
      );

      // Advance time past sleep
      await Effect.runPromise(handle.advanceTime(6000));

      // Handle alarm (resume)
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          yield* orchestrator.handleAlarm();
        }),
      );

      // Check completed
      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.getStatus();
        }),
      );

      expect(status.status?._tag).toBe("Completed");
      expect(status.completedSteps).toContain("before");
      expect(status.completedSteps).toContain("after");
    });
  });

  describe("cancel", () => {
    it("should cancel queued workflow", async () => {
      // Queue workflow
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          yield* orchestrator.queue({
            workflow: "simpleWorkflow",
            input: { value: 1 },
          });
        }),
      );

      // Cancel
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.cancel({ reason: "user request" });
        }),
      );

      expect(result.cancelled).toBe(true);
      expect(result.previousStatus).toBe("Queued");

      // Check status
      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.getStatus();
        }),
      );

      expect(status.status?._tag).toBe("Cancelled");
    });

    it("should return not_found for non-existent workflow", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.cancel();
        }),
      );

      expect(result.cancelled).toBe(false);
      expect(result.reason).toBe("not_found");
    });

    it("should return already_terminal for completed workflow", async () => {
      // Start and complete workflow
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          yield* orchestrator.start({
            workflow: "simpleWorkflow",
            input: { value: 1 },
          });
        }),
      );

      // Try to cancel
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.cancel();
        }),
      );

      expect(result.cancelled).toBe(false);
      expect(result.reason).toBe("already_terminal");
    });
  });

  describe("getStatus", () => {
    it("should return status for existing workflow", async () => {
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          yield* orchestrator.start({
            workflow: "simpleWorkflow",
            input: { value: 1 },
          });
        }),
      );

      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.getStatus();
        }),
      );

      expect(status.exists).toBe(true);
      expect(status.status?._tag).toBe("Completed");
    });

    it("should return exists: false for non-existent workflow", async () => {
      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.getStatus();
        }),
      );

      expect(status.exists).toBe(false);
      expect(status.status).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("should handle workflow failure", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.start({
            workflow: "failingWorkflow",
            input: {},
          });
        }),
      );

      expect(result.completed).toBe(false);

      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.getStatus();
        }),
      );

      expect(status.status?._tag).toBe("Failed");
    });

    it("should fail for unknown workflow", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator
            .start({
              workflow: "unknownWorkflow" as any,
              input: {},
            })
            .pipe(Effect.either);
        }),
      );

      expect(result._tag).toBe("Left");
    });
  });

  describe("exists", () => {
    it("should return true for existing workflow", async () => {
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          yield* orchestrator.start({
            workflow: "simpleWorkflow",
            input: { value: 1 },
          });
        }),
      );

      const exists = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.exists();
        }),
      );

      expect(exists).toBe(true);
    });

    it("should return false for non-existent workflow", async () => {
      const exists = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.exists();
        }),
      );

      expect(exists).toBe(false);
    });
  });
});
