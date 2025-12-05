import { vi } from "vitest";
import { Effect, Layer } from "effect";
import { ExecutionContext, PauseSignal } from "@durable-effect/core";
import {
  WorkflowContext,
  createWorkflowContext,
} from "@/services/workflow-context";
import { WorkflowScope } from "@/services/workflow-scope";
import type { DurableWorkflow, WorkflowStatus } from "@/types";
import {
  MockStorage,
  createMockExecutionContext,
  testWorkflowScope,
  SimpleEventCapture,
} from "../mocks";

/**
 * Result returned when starting a workflow.
 */
export interface WorkflowRunResult {
  readonly id: string;
}

/**
 * Options for creating a workflow test harness.
 */
export interface WorkflowHarnessOptions {
  /** Event capture for testing tracker events */
  readonly eventCapture?: SimpleEventCapture;
  /** Workflow name (defaults to "test") */
  readonly name?: string;
}

/**
 * Test harness for workflow-level testing.
 * Simulates the run → pause → alarm → resume cycle.
 */
export interface WorkflowTestHarness<Input> {
  /** The mock storage instance */
  readonly storage: MockStorage;

  /** Event capture (if provided) */
  readonly eventCapture?: SimpleEventCapture;

  /** Run the workflow synchronously (simulates run()) */
  run(input: Input): Promise<WorkflowRunResult>;

  /** Queue the workflow for async execution (simulates runAsync()) */
  runAsync(input: Input): Promise<WorkflowRunResult>;

  /** Simulate alarm firing (simulates alarm()) */
  triggerAlarm(): Promise<void>;

  /** Get current workflow status */
  getStatus(): Promise<WorkflowStatus | undefined>;

  /** Get completed steps */
  getCompletedSteps(): Promise<string[]>;

  /** Get completed pause index */
  getCompletedPauseIndex(): Promise<number>;

  /** Run workflow to completion (auto-triggering alarms) */
  runToCompletion(
    input: Input,
    options?: { maxAlarms?: number },
  ): Promise<void>;

  /** Run workflow async to completion (queue then auto-trigger alarms) */
  runAsyncToCompletion(
    input: Input,
    options?: { maxAlarms?: number },
  ): Promise<void>;
}

/**
 * Create a test harness for a workflow.
 */
export function createWorkflowHarness<Input, E>(
  workflow: DurableWorkflow<string, Input, E>,
  options?: WorkflowHarnessOptions,
): WorkflowTestHarness<Input> {
  const storage = new MockStorage();
  const workflowId = "test-workflow-id";
  const workflowName = options?.name ?? "test";
  const eventCapture = options?.eventCapture;

  /**
   * Execute the workflow with fresh contexts.
   * The storage is shared, but WorkflowContext is recreated each run
   * to reset the runtime pauseCounter.
   */
  async function executeWorkflow(input: Input): Promise<void> {
    // Create fresh contexts - pauseCounter resets each execution
    const execCtx = createMockExecutionContext(storage);
    const workflowCtx = createWorkflowContext(
      workflowId,
      workflowName,
      input,
      storage as unknown as DurableObjectStorage,
    );

    // Execute workflow effect
    let effect = workflow
      .definition(input)
      .pipe(
        Effect.provideService(ExecutionContext, execCtx),
        Effect.provideService(WorkflowContext, workflowCtx),
        Effect.provideService(WorkflowScope, testWorkflowScope),
      );

    // Provide tracker layer if event capture is provided
    if (eventCapture) {
      effect = effect.pipe(Effect.provide(eventCapture.createLayer()));
    }

    const result = await Effect.runPromiseExit(effect);

    // Handle result (same logic as engine)
    if (result._tag === "Success") {
      await storage.put("workflow:status", {
        _tag: "Completed",
        completedAt: Date.now(),
      } as WorkflowStatus);
    } else if (
      result.cause._tag === "Fail" &&
      result.cause.error instanceof PauseSignal
    ) {
      const signal = result.cause.error;
      await storage.put("workflow:status", {
        _tag: "Paused",
        reason: signal.reason,
        resumeAt: signal.resumeAt,
      } as WorkflowStatus);
    } else {
      await storage.put("workflow:status", {
        _tag: "Failed",
        error: result.cause,
        failedAt: Date.now(),
      } as WorkflowStatus);
    }
  }

  return {
    storage,
    eventCapture,

    async run(input: Input): Promise<WorkflowRunResult> {
      await storage.put("workflow:name", workflowName);
      await storage.put("workflow:input", input);
      await storage.put("workflow:status", {
        _tag: "Running",
      } as WorkflowStatus);
      await executeWorkflow(input);
      return { id: workflowId };
    },

    async runAsync(input: Input): Promise<WorkflowRunResult> {
      await storage.put("workflow:name", workflowName);
      await storage.put("workflow:input", input);
      await storage.put("workflow:status", {
        _tag: "Queued",
        queuedAt: Date.now(),
      } as WorkflowStatus);
      // Schedule alarm 300ms from now (matching engine behavior)
      await storage.setAlarm(Date.now() + 300);
      return { id: workflowId };
    },

    async triggerAlarm(): Promise<void> {
      const status = await storage.get<WorkflowStatus>("workflow:status");

      // Handle both Queued (first run) and Paused (resume)
      if (status?._tag !== "Paused" && status?._tag !== "Queued") return;

      const input = await storage.get<Input>("workflow:input");
      await storage.put("workflow:status", {
        _tag: "Running",
      } as WorkflowStatus);
      await executeWorkflow(input!);
    },

    async getStatus(): Promise<WorkflowStatus | undefined> {
      return storage.get("workflow:status");
    },

    async getCompletedSteps(): Promise<string[]> {
      return (await storage.get<string[]>("workflow:completedSteps")) ?? [];
    },

    async getCompletedPauseIndex(): Promise<number> {
      return (await storage.get<number>("workflow:completedPauseIndex")) ?? 0;
    },

    async runToCompletion(
      input: Input,
      options: { maxAlarms?: number } = {},
    ): Promise<void> {
      const maxAlarms = options.maxAlarms ?? 10;
      await this.run(input);

      for (let i = 0; i < maxAlarms; i++) {
        const status = await this.getStatus();
        if (status?._tag === "Completed" || status?._tag === "Failed") {
          return;
        }

        const alarm = await storage.getAlarm();
        if (!alarm) break;

        // Advance time to alarm and trigger
        vi.setSystemTime(alarm);
        await storage.deleteAlarm();
        await this.triggerAlarm();
      }
    },

    async runAsyncToCompletion(
      input: Input,
      options: { maxAlarms?: number } = {},
    ): Promise<void> {
      const maxAlarms = options.maxAlarms ?? 10;
      await this.runAsync(input);

      for (let i = 0; i < maxAlarms; i++) {
        const status = await this.getStatus();
        if (status?._tag === "Completed" || status?._tag === "Failed") {
          return;
        }

        const alarm = await storage.getAlarm();
        if (!alarm) break;

        // Advance time to alarm and trigger
        vi.setSystemTime(alarm);
        await storage.deleteAlarm();
        await this.triggerAlarm();
      }
    },
  };
}
