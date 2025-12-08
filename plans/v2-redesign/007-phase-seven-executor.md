# Phase 7: Workflow Executor - Execution Engine

## Overview

This phase implements the `WorkflowExecutor` service - the component that actually runs workflow definitions and handles their results. It provides the execution layer, manages context provision, catches PauseSignals, and translates workflow exits into state transitions.

**Duration**: ~3-4 hours
**Dependencies**: Phase 1-6 (all previous phases)
**Risk Level**: Medium (core execution logic)

---

## Goals

1. Create `WorkflowExecutor` service for running workflows
2. Handle workflow exit types (success, failure, pause)
3. Provide workflow context layers during execution
4. Translate PauseSignal into state transitions
5. Support execution modes (fresh start, resume, recover)

---

## Background: Executor Responsibilities

The executor is the bridge between the orchestrator and workflow definitions:

1. **Provide context** - Inject WorkflowContext, WorkflowScope
2. **Run effect** - Execute the workflow definition
3. **Handle exits** - Map Success/Failure/PauseSignal to transitions
4. **Track timing** - Record start/end times, duration
5. **Clean up** - Handle cleanup on completion/failure

---

## File Structure

```
packages/workflow/src/
├── executor/
│   ├── index.ts               # Executor exports
│   ├── types.ts               # Execution types
│   └── executor.ts            # WorkflowExecutor service
└── test/
    └── executor/
        └── executor.test.ts
```

---

## Implementation Details

### 1. Execution Types (`executor/types.ts`)

```typescript
// packages/workflow/src/executor/types.ts

import type { WorkflowDefinition } from "../primitives/make";
import type { WorkflowStatus, WorkflowTransition } from "../state/types";

/**
 * Execution mode determines how the workflow is run.
 */
export type ExecutionMode =
  | "fresh"    // New workflow, start from beginning
  | "resume"   // Resume from pause (sleep/retry woke up)
  | "recover"; // Recovery from infrastructure failure

/**
 * Result of workflow execution.
 */
export type ExecutionResult<Output> =
  | {
      readonly _tag: "Completed";
      readonly output: Output;
      readonly durationMs: number;
      readonly completedSteps: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Paused";
      readonly reason: "sleep" | "retry";
      readonly resumeAt: number;
      readonly stepName?: string;
      readonly attempt?: number;
    }
  | {
      readonly _tag: "Failed";
      readonly error: unknown;
      readonly durationMs: number;
      readonly completedSteps: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Cancelled";
      readonly reason?: string;
      readonly completedSteps: ReadonlyArray<string>;
    };

/**
 * Execution context provided to the executor.
 */
export interface ExecutionContext {
  /** Workflow instance ID */
  readonly workflowId: string;
  /** Workflow definition name */
  readonly workflowName: string;
  /** Workflow input */
  readonly input: unknown;
  /** Optional execution/correlation ID */
  readonly executionId?: string;
  /** Execution mode */
  readonly mode: ExecutionMode;
}

/**
 * Map execution result to state transition.
 */
export function resultToTransition<Output>(
  result: ExecutionResult<Output>
): WorkflowTransition {
  switch (result._tag) {
    case "Completed":
      return {
        _tag: "Complete",
        completedSteps: result.completedSteps,
        durationMs: result.durationMs,
      };

    case "Paused":
      return {
        _tag: "Pause",
        reason: result.reason,
        resumeAt: result.resumeAt,
        stepName: result.stepName,
      };

    case "Failed":
      return {
        _tag: "Fail",
        error: {
          message:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
          stack:
            result.error instanceof Error ? result.error.stack : undefined,
        },
        completedSteps: result.completedSteps,
      };

    case "Cancelled":
      return {
        _tag: "Cancel",
        reason: result.reason,
        completedSteps: result.completedSteps,
      };
  }
}
```

### 2. Workflow Executor Service (`executor/executor.ts`)

```typescript
// packages/workflow/src/executor/executor.ts

import { Context, Effect, Layer, Exit, Cause, Option } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { SchedulerAdapter } from "../adapters/scheduler";
import { RuntimeAdapter } from "../adapters/runtime";
import { WorkflowStateMachine } from "../state/machine";
import {
  WorkflowContext,
  WorkflowContextLayer,
  createWorkflowContext,
} from "../context/workflow-context";
import { WorkflowScopeLayer } from "../context/workflow-scope";
import { StorageError, OrchestratorError } from "../errors";
import { PauseSignal, isPauseSignal } from "../primitives/pause-signal";
import { StepCancelledError } from "../primitives/step";
import type { WorkflowDefinition } from "../primitives/make";
import type {
  ExecutionMode,
  ExecutionResult,
  ExecutionContext,
} from "./types";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * WorkflowExecutor service interface.
 *
 * Executes workflow definitions and returns structured results.
 */
export interface WorkflowExecutorService {
  /**
   * Execute a workflow definition.
   *
   * @param definition - The workflow definition to execute
   * @param context - Execution context (id, input, mode)
   * @returns Execution result (completed, paused, failed, cancelled)
   */
  readonly execute: <Input, Output, Error, Requirements>(
    definition: WorkflowDefinition<Input, Output, Error, Requirements>,
    context: ExecutionContext
  ) => Effect.Effect<
    ExecutionResult<Output>,
    OrchestratorError,
    StorageAdapter | SchedulerAdapter | RuntimeAdapter | WorkflowStateMachine | Requirements
  >;
}

/**
 * Effect service tag for WorkflowExecutor.
 */
export class WorkflowExecutor extends Context.Tag(
  "@durable-effect/WorkflowExecutor"
)<WorkflowExecutor, WorkflowExecutorService>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create the WorkflowExecutor service implementation.
 */
export const createWorkflowExecutor = Effect.gen(function* () {
  const service: WorkflowExecutorService = {
    execute: <Input, Output, Error, Requirements>(
      definition: WorkflowDefinition<Input, Output, Error, Requirements>,
      context: ExecutionContext
    ) =>
      Effect.gen(function* () {
        const storage = yield* StorageAdapter;
        const scheduler = yield* SchedulerAdapter;
        const runtime = yield* RuntimeAdapter;
        const stateMachine = yield* WorkflowStateMachine;

        // Record start time
        const startedAt = yield* runtime.now();
        yield* storage.put("workflow:startedAt", startedAt);

        // Create execution layer with all context services
        const executionLayer = WorkflowScopeLayer.pipe(
          Layer.provideMerge(WorkflowContextLayer),
          Layer.provide(Layer.succeed(StorageAdapter, storage)),
          Layer.provide(Layer.succeed(RuntimeAdapter, runtime)),
        );

        // Execute the workflow
        const exit = yield* definition
          .execute(context.input as Input)
          .pipe(
            Effect.provide(executionLayer),
            Effect.exit
          );

        // Calculate duration
        const completedAt = yield* runtime.now();
        const durationMs = completedAt - startedAt;

        // Get completed steps
        const completedSteps = yield* stateMachine.getCompletedSteps();

        // Handle exit
        return yield* handleExit<Output>(
          exit,
          durationMs,
          completedSteps,
          scheduler
        );
      }).pipe(
        Effect.catchAll((error) =>
          Effect.fail(
            new OrchestratorError({
              operation: "execute",
              cause: error,
            })
          )
        )
      ),
  };

  return service;
});

/**
 * Handle workflow exit and produce execution result.
 */
function handleExit<Output>(
  exit: Exit.Exit<Output, unknown>,
  durationMs: number,
  completedSteps: ReadonlyArray<string>,
  scheduler: SchedulerAdapter
): Effect.Effect<ExecutionResult<Output>, never, never> {
  return Effect.gen(function* () {
    if (Exit.isSuccess(exit)) {
      // Workflow completed successfully
      return {
        _tag: "Completed" as const,
        output: exit.value,
        durationMs,
        completedSteps,
      };
    }

    // Handle failure
    const failure = exit.cause;

    // Check for PauseSignal (not a real failure)
    const pauseSignal = findPauseSignal(failure);
    if (pauseSignal) {
      // Schedule alarm for resume
      yield* scheduler.schedule(pauseSignal.resumeAt);

      return {
        _tag: "Paused" as const,
        reason: pauseSignal.reason,
        resumeAt: pauseSignal.resumeAt,
        stepName: pauseSignal.stepName,
        attempt: pauseSignal.attempt,
      };
    }

    // Check for cancellation
    const cancelError = findCancelError(failure);
    if (cancelError) {
      return {
        _tag: "Cancelled" as const,
        reason: cancelError.stepName,
        completedSteps,
      };
    }

    // Real failure
    const error = Cause.failureOption(failure);
    return {
      _tag: "Failed" as const,
      error: Option.getOrElse(error, () => Cause.squash(failure)),
      durationMs,
      completedSteps,
    };
  });
}

/**
 * Find PauseSignal in a cause chain.
 */
function findPauseSignal(cause: Cause.Cause<unknown>): PauseSignal | undefined {
  // Check direct failure
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure) && isPauseSignal(failure.value)) {
    return failure.value;
  }

  // Check sequential causes
  if (cause._tag === "Sequential") {
    for (const c of [cause.left, cause.right]) {
      const found = findPauseSignal(c);
      if (found) return found;
    }
  }

  // Check parallel causes
  if (cause._tag === "Parallel") {
    for (const c of [cause.left, cause.right]) {
      const found = findPauseSignal(c);
      if (found) return found;
    }
  }

  return undefined;
}

/**
 * Find StepCancelledError in a cause chain.
 */
function findCancelError(
  cause: Cause.Cause<unknown>
): StepCancelledError | undefined {
  const failure = Cause.failureOption(cause);
  if (
    Option.isSome(failure) &&
    failure.value instanceof StepCancelledError
  ) {
    return failure.value;
  }

  if (cause._tag === "Sequential") {
    for (const c of [cause.left, cause.right]) {
      const found = findCancelError(c);
      if (found) return found;
    }
  }

  if (cause._tag === "Parallel") {
    for (const c of [cause.left, cause.right]) {
      const found = findCancelError(c);
      if (found) return found;
    }
  }

  return undefined;
}

/**
 * Layer that provides WorkflowExecutor.
 */
export const WorkflowExecutorLayer = Layer.effect(
  WorkflowExecutor,
  createWorkflowExecutor
);
```

### 3. Executor Exports (`executor/index.ts`)

```typescript
// packages/workflow/src/executor/index.ts

// Types
export type {
  ExecutionMode,
  ExecutionResult,
  ExecutionContext,
} from "./types";

export { resultToTransition } from "./types";

// Executor service
export {
  WorkflowExecutor,
  WorkflowExecutorLayer,
  createWorkflowExecutor,
  type WorkflowExecutorService,
} from "./executor";
```

### 4. Update Main Index

```typescript
// packages/workflow/src/index.ts

// ... existing exports ...

// Executor
export {
  WorkflowExecutor,
  WorkflowExecutorLayer,
  type WorkflowExecutorService,
  type ExecutionMode,
  type ExecutionResult,
  type ExecutionContext,
  resultToTransition,
} from "./executor";
```

---

## Testing Strategy

### Test File: `test/executor/executor.test.ts`

```typescript
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
  PauseSignal,
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
      Layer.provide(runtimeLayer)
    );

  const runExecutor = <A, E>(effect: Effect.Effect<A, E, any>) =>
    effect.pipe(Effect.provide(createLayers()), Effect.runPromise);

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

      const workflow = make(
        { name: "simpleWorkflow" },
        (input: { x: number }) =>
          Effect.succeed(input.x * 2)
      );

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

      const workflow = make(
        { name: "steppedWorkflow" },
        (_input: {}) =>
          Effect.gen(function* () {
            const a = yield* step("step1", () => Effect.succeed(1));
            const b = yield* step("step2", () => Effect.succeed(2));
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

      const workflow = make(
        { name: "sleepWorkflow" },
        (_input: {}) =>
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

      const workflow = make(
        { name: "alarmWorkflow" },
        (_input: {}) =>
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

      const workflow = make(
        { name: "failingWorkflow" },
        (_input: {}) =>
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

      const workflow = make(
        { name: "stepFailWorkflow" },
        (_input: {}) =>
          Effect.gen(function* () {
            yield* step("goodStep", () => Effect.succeed("ok"));
            yield* step("badStep", () => Effect.fail(new Error("step failed")));
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

      const workflow = make(
        { name: "cancelledWorkflow" },
        (_input: {}) =>
          Effect.gen(function* () {
            yield* step("firstStep", () => Effect.succeed("ok"));
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

      const workflow = make(
        { name: "freshWorkflow" },
        (input: { value: number }) =>
          Effect.succeed(input.value)
      );

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

      const workflow = make(
        { name: "resumeWorkflow" },
        (_input: {}) =>
          Effect.gen(function* () {
            yield* step("step1", () => Effect.succeed("first"));
            yield* sleep("1 second");
            const second = yield* step("step2", () => Effect.succeed("second"));
            return second;
          })
      );

      // First run - will pause at sleep
      await runExecutor(
        Effect.gen(function* () {
          const executor = yield* WorkflowExecutor;
          yield* executor.execute(workflow, {
            workflowId: "wf-exec-123",
            workflowName: "resumeWorkflow",
            input: {},
            mode: "fresh",
          });
        })
      );

      // Simulate time passing and alarm firing
      await Effect.runPromise(handle.advanceTime(2000));

      // Update state to resumed
      await runExecutor(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.applyTransition({ _tag: "Resume" });
          // Mark pause as completed
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:completedPauseIndex", 1);
        })
      );

      // Second run - resume mode, step1 should be cached
      let step1Executed = false;
      const resumeWorkflow = make(
        { name: "resumeWorkflow" },
        (_input: {}) =>
          Effect.gen(function* () {
            yield* step("step1", () =>
              Effect.sync(() => {
                step1Executed = true;
                return "first";
              })
            );
            yield* sleep("1 second");
            const second = yield* step("step2", () => Effect.succeed("second"));
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

      const workflow = make(
        { name: "timedWorkflow" },
        (_input: {}) =>
          Effect.gen(function* () {
            // Simulate some work
            yield* Effect.sleep(10);
            return "done";
          })
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
  });
});
```

---

## Definition of Done

- [ ] ExecutionResult type covers all outcomes
- [ ] ExecutionContext provides execution metadata
- [ ] WorkflowExecutor executes workflow definitions
- [ ] Context layers properly provided during execution
- [ ] PauseSignal caught and converted to Paused result
- [ ] Scheduler alarm set for pause resume time
- [ ] StepCancelledError converted to Cancelled result
- [ ] Errors converted to Failed result
- [ ] Timing tracked (startedAt, durationMs)
- [ ] Completed steps tracked in results
- [ ] All tests passing
- [ ] Package builds without errors

---

## Notes for Implementation

1. **Exit handling is critical** - Must find PauseSignal in cause chain
2. **Layer provision order matters** - WorkflowScope must wrap WorkflowContext
3. **Alarm scheduling on pause** - Orchestrator won't do this, executor must
4. **Duration includes replay time** - OK because individual steps are cached
5. **Requirements pass-through** - User effects may have additional deps
