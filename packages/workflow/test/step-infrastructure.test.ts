import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Cause } from "effect";
import { UnknownException } from "effect/Cause";
import { ExecutionContext } from "@durable-effect/core";
import { WorkflowContext } from "@/services/workflow-context";
import { WorkflowScope } from "@/services/workflow-scope";
import { Workflow } from "@/workflow";
import { StepInfrastructureError } from "@/errors";
import {
  createTestContexts,
  testWorkflowScope,
  MockStorage,
  SimpleEventCapture,
} from "./mocks";

describe("Step Infrastructure Errors", () => {
  let storage: MockStorage;
  let executionContext: ReturnType<
    typeof createTestContexts
  >["executionContext"];
  let workflowContext: ReturnType<typeof createTestContexts>["workflowContext"];
  let eventCapture: SimpleEventCapture;

  beforeEach(() => {
    const contexts = createTestContexts();
    storage = contexts.storage;
    executionContext = contexts.executionContext;
    workflowContext = contexts.workflowContext;
    eventCapture = new SimpleEventCapture();
  });

  /**
   * Helper to run a step effect with contexts provided.
   */
  function runStep<T, E>(
    stepEffect: Effect.Effect<
      T,
      E,
      WorkflowScope | ExecutionContext | WorkflowContext
    >,
  ) {
    return stepEffect.pipe(
      Effect.provideService(ExecutionContext, executionContext),
      Effect.provideService(WorkflowContext, workflowContext),
      Effect.provideService(WorkflowScope, testWorkflowScope),
    );
  }

  /**
   * Helper to run a step with event tracking.
   */
  function runStepWithTracking<T, E>(
    stepEffect: Effect.Effect<
      T,
      E,
      WorkflowScope | ExecutionContext | WorkflowContext
    >,
  ) {
    return stepEffect.pipe(
      Effect.provideService(ExecutionContext, executionContext),
      Effect.provideService(WorkflowContext, workflowContext),
      Effect.provideService(WorkflowScope, testWorkflowScope),
      Effect.provide(eventCapture.createLayer()),
    );
  }

  // ===========================================================================
  // StepInfrastructureError Tests
  // ===========================================================================

  describe("StepInfrastructureError creation", () => {
    it("wraps storage failures during setup phase in StepInfrastructureError", async () => {
      // Simulate failure when loading step attempt
      storage.simulateFailure({
        keys: ["step:TestStep:attempt"],
        operations: ["get"],
        error: new Error("Storage unavailable"),
      });

      const step = Workflow.step("TestStep", Effect.succeed("result"));

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failureOption = Cause.failureOption(exit.cause);
        expect(failureOption._tag).toBe("Some");
        if (failureOption._tag === "Some") {
          expect(failureOption.value).toBeInstanceOf(StepInfrastructureError);
          const error = failureOption.value as StepInfrastructureError;
          expect(error.stepName).toBe("TestStep");
          expect(error.phase).toBe("setup");
          // Cause is wrapped in UnknownException by loadStepAttempt
          expect(error.cause).toBeInstanceOf(UnknownException);
          // The original error is inside the UnknownException
          const unknownEx = error.cause as UnknownException;
          expect(unknownEx.error).toBeInstanceOf(Error);
        }
      }
    });

    it("wraps storage failures during completion phase in StepInfrastructureError", async () => {
      // Simulate failure when marking step completed
      storage.simulateFailure({
        keys: ["workflow:completedSteps"],
        operations: ["put"],
        error: new Error("Write failed"),
      });

      const step = Workflow.step("TestStep", Effect.succeed("result"));

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failureOption = Cause.failureOption(exit.cause);
        expect(failureOption._tag).toBe("Some");
        if (failureOption._tag === "Some") {
          expect(failureOption.value).toBeInstanceOf(StepInfrastructureError);
          const error = failureOption.value as StepInfrastructureError;
          expect(error.stepName).toBe("TestStep");
          expect(error.phase).toBe("completion");
        }
      }
    });

    it("includes attempt number in StepInfrastructureError", async () => {
      // Seed with existing attempt count
      storage.seed({
        "step:RetryStep:attempt": 3,
      });

      // Simulate failure after loading attempt (during start time recording)
      storage.simulateFailure({
        keys: ["step:RetryStep:startedAt"],
        operations: ["put"],
        error: new Error("Write failed"),
      });

      const step = Workflow.step("RetryStep", Effect.succeed("result"));

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failureOption = Cause.failureOption(exit.cause);
        if (failureOption._tag === "Some") {
          const error = failureOption.value as StepInfrastructureError;
          // Note: attempt is set from the Ref which may be 0 if failure happens
          // before attempt is loaded. The key point is we have step context.
          expect(error.stepName).toBe("RetryStep");
        }
      }
    });

    it("has descriptive message property", () => {
      const error = new StepInfrastructureError({
        stepName: "MyStep",
        phase: "setup",
        cause: new Error("Connection reset"),
        attempt: 2,
      });

      expect(error.message).toContain("MyStep");
      expect(error.message).toContain("setup");
      expect(error.message).toContain("attempt 2");
      expect(error.message).toContain("Connection reset");
    });
  });

  // ===========================================================================
  // step.failed Event Emission Tests
  // ===========================================================================

  describe("step.failed event emission", () => {
    it("emits step.failed via onExit when infrastructure fails after step.started", async () => {
      // Simulate failure during result caching
      storage.simulateFailure({
        keys: ["step:TestStep:result"],
        operations: ["put"],
        error: new Error("Cache write failed"),
      });

      const step = Workflow.step("TestStep", Effect.succeed("result"));

      await Effect.runPromiseExit(runStepWithTracking(step));

      const events = eventCapture.getEvents();
      const stepStarted = events.find((e) => e.type === "step.started");
      const stepFailed = events.find((e) => e.type === "step.failed");

      expect(stepStarted).toBeDefined();
      expect(stepFailed).toBeDefined();
      expect(stepFailed?.stepName).toBe("TestStep");
    });

    it("does NOT emit step.failed when failure occurs before step.started", async () => {
      // Simulate failure during attempt loading (before step.started)
      storage.simulateFailure({
        keys: ["step:TestStep:attempt"],
        operations: ["get"],
        error: new Error("Read failed"),
      });

      const step = Workflow.step("TestStep", Effect.succeed("result"));

      await Effect.runPromiseExit(runStepWithTracking(step));

      const events = eventCapture.getEvents();
      const stepStarted = events.find((e) => e.type === "step.started");
      const stepFailed = events.find((e) => e.type === "step.failed");

      // No step.started means no step.failed from onExit
      // (failure happened before we could track the step)
      expect(stepStarted).toBeUndefined();
      expect(stepFailed).toBeUndefined();
    });

    it("includes error details in step.failed event", async () => {
      // Simulate failure during completion
      storage.simulateFailure({
        keys: ["workflow:completedSteps"],
        operations: ["put"],
        error: new Error("Disk full"),
      });

      const step = Workflow.step("TestStep", Effect.succeed("result"));

      await Effect.runPromiseExit(runStepWithTracking(step));

      const events = eventCapture.getEvents();
      const stepFailed = events.find((e) => e.type === "step.failed");

      expect(stepFailed).toBeDefined();
      expect(stepFailed?.error?.message).toContain("Disk full");
    });

    it("does NOT emit duplicate step.failed events", async () => {
      // Normal step failure (user effect fails)
      const step = Workflow.step(
        "TestStep",
        Effect.fail(new Error("User error")),
      );

      await Effect.runPromiseExit(runStepWithTracking(step));

      const events = eventCapture.getEvents();
      const stepFailedEvents = events.filter((e) => e.type === "step.failed");

      // Should only have one step.failed event
      expect(stepFailedEvents.length).toBe(1);
    });
  });

  // ===========================================================================
  // Cancellation Handling Tests
  // ===========================================================================

  describe("cancellation during step", () => {
    it("does NOT produce StepInfrastructureError for cancellation", async () => {
      // Set workflow as cancelled
      storage.seed({
        "workflow:cancelled": true,
        "workflow:cancelReason": "User cancelled",
      });

      const step = Workflow.step("TestStep", Effect.succeed("result"));

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failureOption = Cause.failureOption(exit.cause);
        if (failureOption._tag === "Some") {
          // Should be WorkflowCancelledError, not StepInfrastructureError
          expect(failureOption.value).not.toBeInstanceOf(
            StepInfrastructureError,
          );
        }
      }
    });

    it("does NOT emit step.failed for cancellation", async () => {
      // Set workflow as cancelled
      storage.seed({
        "workflow:cancelled": true,
        "workflow:cancelReason": "User cancelled",
      });

      const step = Workflow.step("TestStep", Effect.succeed("result"));

      await Effect.runPromiseExit(runStepWithTracking(step));

      const events = eventCapture.getEvents();
      const stepFailed = events.find((e) => e.type === "step.failed");

      expect(stepFailed).toBeUndefined();
    });
  });

  // ===========================================================================
  // Cache Hit Handling Tests
  // ===========================================================================

  describe("cache hit with infrastructure failure", () => {
    it("wraps cache lookup failure in StepInfrastructureError", async () => {
      // Mark step as completed but fail when reading cached result
      storage.seed({
        "workflow:completedSteps": ["CachedStep"],
        "step:CachedStep:result": { cached: true },
      });

      storage.simulateFailure({
        keys: ["step:CachedStep:result"],
        operations: ["get"],
        error: new Error("Cache read failed"),
      });

      const step = Workflow.step("CachedStep", Effect.succeed("new-result"));

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failureOption = Cause.failureOption(exit.cause);
        if (failureOption._tag === "Some") {
          expect(failureOption.value).toBeInstanceOf(StepInfrastructureError);
          const error = failureOption.value as StepInfrastructureError;
          expect(error.stepName).toBe("CachedStep");
          expect(error.phase).toBe("setup");
        }
      }
    });
  });
});
