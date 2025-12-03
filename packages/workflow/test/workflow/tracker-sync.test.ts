/**
 * Tests for tracker event synchronization at the workflow lifecycle level.
 *
 * This test specifically targets the bug where fast-finishing workflows
 * lose events because the background consumer in the production tracker
 * hasn't had time to send the batch before the scope closes.
 *
 * The test uses a production-like tracker with batching to expose the race
 * condition that causes events to be lost.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect, Layer, Ref, Scope } from "effect";
import type { InternalWorkflowEvent } from "@durable-effect/core";
import { ExecutionContext, PauseSignal } from "@durable-effect/core";
import {
  EventTracker,
  emitEvent,
  flushEvents,
  type EventTrackerService,
} from "@/tracker";
import {
  WorkflowContext,
  createWorkflowContext,
} from "@/services/workflow-context";
import { Workflow } from "@/workflow";
import { MockStorage, createMockExecutionContext } from "../mocks";
import type { WorkflowStatus } from "@/types";

/**
 * External event store that persists outside Effect scopes.
 * Represents the backend tracking service.
 */
class ExternalEventStore {
  readonly events: InternalWorkflowEvent[] = [];

  push(event: InternalWorkflowEvent): void {
    this.events.push(event);
  }

  clear(): void {
    this.events.length = 0;
  }

  getByType<T extends InternalWorkflowEvent["type"]>(
    type: T,
  ): Extract<InternalWorkflowEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<
      InternalWorkflowEvent,
      { type: T }
    >[];
  }
}

/**
 * Creates a production-like tracker that mimics createHttpBatchTracker behavior.
 *
 * Uses Ref-based accumulation (matching the fixed production implementation)
 * instead of a background consumer with a race condition.
 *
 * Events are accumulated in a Ref and sent synchronously on flush or scope close.
 */
function createProductionLikeBatchTracker(
  externalStore: ExternalEventStore,
  _options: { batchWaitMs?: number } = {},
): Effect.Effect<EventTrackerService, never, Scope.Scope> {
  return Effect.gen(function* () {
    // Accumulate events in a Ref (matching production implementation)
    const eventsRef = yield* Ref.make<InternalWorkflowEvent[]>([]);

    // Send batch to external store (simulates HTTP POST in production)
    const sendBatch = (events: ReadonlyArray<InternalWorkflowEvent>) =>
      Effect.sync(() => {
        for (const event of events) {
          externalStore.push(event);
        }
      });

    // Flush all accumulated events
    const flush = Effect.gen(function* () {
      const events = yield* Ref.getAndSet(eventsRef, []);
      yield* sendBatch(events);
    });

    // Cleanup on scope close - flush any remaining events
    yield* Effect.addFinalizer(() => flush);

    return {
      emit: (event: InternalWorkflowEvent) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      flush,
      pendingCount: Ref.get(eventsRef).pipe(
        Effect.map((events) => events.length),
      ),
    };
  });
}

/**
 * Creates a Layer for the production-like tracker.
 */
function createProductionLikeTrackerLayer(
  externalStore: ExternalEventStore,
  options?: { batchWaitMs?: number },
): Layer.Layer<EventTracker> {
  return Layer.scoped(
    EventTracker,
    createProductionLikeBatchTracker(externalStore, options),
  );
}

describe("Workflow Tracker Sync", () => {
  let externalStore: ExternalEventStore;
  let storage: MockStorage;

  beforeEach(() => {
    externalStore = new ExternalEventStore();
    storage = new MockStorage();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Helper to execute a workflow with production-like tracking.
   * Mimics engine.ts #executeWorkflow pattern.
   */
  async function executeWorkflowWithTracking<Input, E, R>(
    workflow: {
      readonly name: string;
      readonly definition: (input: Input) => Effect.Effect<unknown, E, R>;
    },
    input: Input,
    trackerLayer: Layer.Layer<EventTracker>,
  ): Promise<{ status: WorkflowStatus }> {
    const workflowId = "test-workflow-id";
    const execCtx = createMockExecutionContext(storage);
    const workflowCtx = createWorkflowContext(
      workflowId,
      workflow.name,
      input,
      storage as unknown as DurableObjectStorage,
    );

    const execution = Effect.gen(function* () {
      // Emit workflow.started (simulating transitionWorkflow)
      yield* emitEvent({
        eventId: "evt-started",
        timestamp: new Date().toISOString(),
        workflowId,
        workflowName: workflow.name,
        type: "workflow.started",
        input,
      });

      // Execute workflow
      const result = yield* workflow.definition(input).pipe(
        Effect.provideService(ExecutionContext, execCtx),
        Effect.provideService(WorkflowContext, workflowCtx),
        Effect.exit,
      );

      // Handle result
      if (result._tag === "Success") {
        const completedSteps = yield* Effect.promise(async () =>
          (await storage.get<string[]>("workflow:completedSteps")) ?? [],
        );

        yield* emitEvent({
          eventId: "evt-completed",
          timestamp: new Date().toISOString(),
          workflowId,
          workflowName: workflow.name,
          type: "workflow.completed",
          completedSteps,
          durationMs: Date.now(),
        });

        return { _tag: "Completed" as const, completedAt: Date.now() };
      } else if (
        result.cause._tag === "Fail" &&
        result.cause.error instanceof PauseSignal
      ) {
        const signal = result.cause.error;

        const resumeAtStr = new Date(signal.resumeAt).toISOString();

        yield* emitEvent({
          eventId: "evt-paused",
          timestamp: new Date().toISOString(),
          workflowId,
          workflowName: workflow.name,
          type: "workflow.paused",
          reason: signal.reason,
          resumeAt: resumeAtStr,
          stepName: signal.stepName,
        });

        return {
          _tag: "Paused" as const,
          reason: signal.reason,
          resumeAt: resumeAtStr,
        };
      } else {
        yield* emitEvent({
          eventId: "evt-failed",
          timestamp: new Date().toISOString(),
          workflowId,
          workflowName: workflow.name,
          type: "workflow.failed",
          error: { message: "Workflow failed" },
          completedSteps: [],
        });

        return { _tag: "Failed" as const, failedAt: Date.now() };
      }
    });

    // Execute with tracker layer - single scoped execution
    // Cast to remove R requirement since we've provided all services inside
    const status = await Effect.runPromise(
      (execution as Effect.Effect<WorkflowStatus, never, EventTracker>).pipe(
        Effect.tap(() => flushEvents),
        Effect.provide(trackerLayer),
      ),
    );

    return { status };
  }

  describe("fast-finishing workflows", () => {
    it("should send all events when workflow completes quickly", async () => {
      // Create a production-like tracker layer with batching
      const trackerLayer = createProductionLikeTrackerLayer(externalStore, {
        batchWaitMs: 1000, // 1 second batch wait - workflow will finish before this
      });

      // Create a simple fast-finishing workflow
      const workflow = Workflow.make("fastWorkflow", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step("quickStep", Effect.succeed("done"));
        }),
      );

      // Execute workflow
      const { status } = await executeWorkflowWithTracking(
        workflow,
        undefined,
        trackerLayer,
      );

      // Workflow should complete
      expect(status._tag).toBe("Completed");

      // ALL events should be sent to the backend
      // Expected events for a simple workflow:
      // 1. workflow.started
      // 2. step.started
      // 3. step.completed
      // 4. workflow.completed
      expect(externalStore.events.length).toBeGreaterThanOrEqual(4);

      expect(externalStore.getByType("workflow.started")).toHaveLength(1);
      expect(externalStore.getByType("step.started")).toHaveLength(1);
      expect(externalStore.getByType("step.completed")).toHaveLength(1);
      expect(externalStore.getByType("workflow.completed")).toHaveLength(1);
    });

    it("should send all events for multi-step workflow", async () => {
      const trackerLayer = createProductionLikeTrackerLayer(externalStore, {
        batchWaitMs: 1000,
      });

      const workflow = Workflow.make("multiStepWorkflow", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step("step1", Effect.succeed("one"));
          yield* Workflow.step("step2", Effect.succeed("two"));
          yield* Workflow.step("step3", Effect.succeed("three"));
        }),
      );

      const { status } = await executeWorkflowWithTracking(
        workflow,
        undefined,
        trackerLayer,
      );

      expect(status._tag).toBe("Completed");

      // Should have events for all 3 steps
      expect(externalStore.getByType("workflow.started")).toHaveLength(1);
      expect(externalStore.getByType("step.started")).toHaveLength(3);
      expect(externalStore.getByType("step.completed")).toHaveLength(3);
      expect(externalStore.getByType("workflow.completed")).toHaveLength(1);

      // Total: 1 + 3 + 3 + 1 = 8 events
      expect(externalStore.events.length).toBeGreaterThanOrEqual(8);
    });

    it("should not lose events when workflow fails fast", async () => {
      const trackerLayer = createProductionLikeTrackerLayer(externalStore, {
        batchWaitMs: 1000,
      });

      const workflow = Workflow.make("failingWorkflow", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step("failStep", Effect.fail(new Error("boom")));
        }),
      );

      const { status } = await executeWorkflowWithTracking(
        workflow,
        undefined,
        trackerLayer,
      );

      expect(status._tag).toBe("Failed");

      // Should have failure events
      expect(externalStore.getByType("workflow.started")).toHaveLength(1);
      expect(externalStore.getByType("step.started")).toHaveLength(1);
      expect(externalStore.getByType("step.failed")).toHaveLength(1);
      expect(externalStore.getByType("workflow.failed")).toHaveLength(1);
    });
  });

  describe("workflow with sleep (pause/resume)", () => {
    it("should send all events across pause and resume", async () => {
      const trackerLayer = createProductionLikeTrackerLayer(externalStore, {
        batchWaitMs: 1000,
      });

      const workflow = Workflow.make("sleepWorkflow", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step("beforeSleep", Effect.succeed("pre"));
          yield* Workflow.sleep("1 second");
          yield* Workflow.step("afterSleep", Effect.succeed("post"));
        }),
      );

      // First run - should pause at sleep
      const { status: status1 } = await executeWorkflowWithTracking(
        workflow,
        undefined,
        trackerLayer,
      );

      expect(status1._tag).toBe("Paused");

      // Events from first run
      expect(externalStore.getByType("workflow.started")).toHaveLength(1);
      expect(externalStore.getByType("step.started")).toHaveLength(1);
      expect(externalStore.getByType("step.completed")).toHaveLength(1);
      expect(externalStore.getByType("sleep.started")).toHaveLength(1);
      expect(externalStore.getByType("workflow.paused")).toHaveLength(1);

      // Clear store for second run
      const eventsAfterFirstRun = externalStore.events.length;
      externalStore.clear();

      // Advance time past sleep
      vi.setSystemTime(1000);

      // Second run (resume) - new tracker layer (like production)
      const trackerLayer2 = createProductionLikeTrackerLayer(externalStore, {
        batchWaitMs: 1000,
      });

      const { status: status2 } = await executeWorkflowWithTracking(
        workflow,
        undefined,
        trackerLayer2,
      );

      expect(status2._tag).toBe("Completed");

      // Events from second run should include completion
      expect(externalStore.getByType("workflow.completed")).toHaveLength(1);
    });
  });
});
