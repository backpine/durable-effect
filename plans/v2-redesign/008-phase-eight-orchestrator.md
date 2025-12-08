# Phase 8: Workflow Orchestrator - High-Level Coordination

## Overview

This phase implements the `WorkflowOrchestrator` service - the high-level coordinator that ties everything together. It provides the public API for starting, queueing, resuming, and cancelling workflows. This is the primary interface that runtimes (like Durable Objects) interact with.

**Duration**: ~3-4 hours
**Dependencies**: Phase 1-7 (all previous phases)
**Risk Level**: Medium (integration of all components)

---

## Goals

1. Create `WorkflowOrchestrator` service as the main API
2. Implement workflow lifecycle operations (start, queue, cancel)
3. Handle alarm events (resume, start queued, recover)
4. Coordinate state machine, executor, and recovery
5. Provide workflow registry for definition lookup

---

## Background: Orchestrator Role

The orchestrator is the "brain" of the workflow system:

1. **Entry point** - All operations go through the orchestrator
2. **Coordination** - Sequences state transitions, execution, recovery
3. **Definition lookup** - Maps workflow names to definitions
4. **Error handling** - Wraps all errors in OrchestratorError
5. **Lifecycle management** - Full workflow lifecycle from start to completion

---

## File Structure

```
packages/workflow-v2/src/
├── orchestrator/
│   ├── index.ts               # Orchestrator exports
│   ├── types.ts               # Orchestrator types
│   ├── registry.ts            # Workflow registry
│   └── orchestrator.ts        # WorkflowOrchestrator service
└── test/
    └── orchestrator/
        └── orchestrator.test.ts
```

---

## Implementation Details

### 1. Orchestrator Types (`orchestrator/types.ts`)

```typescript
// packages/workflow-v2/src/orchestrator/types.ts

import type { WorkflowStatus } from "../state/types";
import type { WorkflowDefinition } from "../primitives/make";

/**
 * A registry mapping workflow names to their definitions.
 */
export type WorkflowRegistry = {
  readonly [name: string]: WorkflowDefinition<any, any, any, any>;
};

/**
 * Call specification for starting a workflow.
 */
export interface WorkflowCall<W extends WorkflowRegistry> {
  /** Name of the workflow to execute */
  readonly workflow: keyof W & string;
  /** Input to pass to the workflow */
  readonly input: W[keyof W] extends WorkflowDefinition<infer I, any, any, any>
    ? I
    : never;
  /** Optional execution/correlation ID */
  readonly executionId?: string;
}

/**
 * Result of starting a workflow.
 */
export interface StartResult {
  /** Workflow instance ID */
  readonly id: string;
  /** Whether workflow completed immediately */
  readonly completed: boolean;
  /** Output if completed */
  readonly output?: unknown;
}

/**
 * Result of cancelling a workflow.
 */
export interface CancelResult {
  /** Whether cancellation was applied */
  readonly cancelled: boolean;
  /** Reason if not cancelled */
  readonly reason?: "not_found" | "already_terminal" | "not_running";
  /** Status before cancel attempt */
  readonly previousStatus?: WorkflowStatus["_tag"];
}

/**
 * Options for workflow cancellation.
 */
export interface CancelOptions {
  /** Reason for cancellation */
  readonly reason?: string;
}

/**
 * Workflow status query result.
 */
export interface WorkflowStatusResult {
  /** Current status */
  readonly status: WorkflowStatus | undefined;
  /** Completed steps */
  readonly completedSteps: ReadonlyArray<string>;
  /** Whether workflow exists */
  readonly exists: boolean;
}
```

### 2. Workflow Registry (`orchestrator/registry.ts`)

```typescript
// packages/workflow-v2/src/orchestrator/registry.ts

import { Context, Effect, Layer } from "effect";
import type { WorkflowDefinition } from "../primitives/make";
import type { WorkflowRegistry } from "./types";

/**
 * Error when workflow definition is not found.
 */
export class WorkflowNotFoundError extends Error {
  readonly _tag = "WorkflowNotFoundError";
  readonly workflowName: string;
  readonly availableWorkflows: ReadonlyArray<string>;

  constructor(workflowName: string, availableWorkflows: ReadonlyArray<string>) {
    super(
      `Workflow "${workflowName}" not found. Available: [${availableWorkflows.join(", ")}]`
    );
    this.name = "WorkflowNotFoundError";
    this.workflowName = workflowName;
    this.availableWorkflows = availableWorkflows;
  }
}

/**
 * WorkflowRegistryService interface.
 */
export interface WorkflowRegistryService<W extends WorkflowRegistry> {
  /**
   * Get a workflow definition by name.
   */
  readonly get: (
    name: string
  ) => Effect.Effect<
    WorkflowDefinition<any, any, any, any>,
    WorkflowNotFoundError
  >;

  /**
   * List all available workflow names.
   */
  readonly list: () => ReadonlyArray<string>;

  /**
   * Check if a workflow exists.
   */
  readonly has: (name: string) => boolean;
}

/**
 * Effect service tag for WorkflowRegistry.
 */
export class WorkflowRegistryTag extends Context.Tag(
  "@durable-effect/WorkflowRegistry"
)<WorkflowRegistryTag, WorkflowRegistryService<any>>() {}

/**
 * Create a workflow registry from a workflows object.
 */
export function createWorkflowRegistry<W extends WorkflowRegistry>(
  workflows: W
): WorkflowRegistryService<W> {
  const names = Object.keys(workflows);

  return {
    get: (name: string) => {
      const workflow = workflows[name];
      if (!workflow) {
        return Effect.fail(new WorkflowNotFoundError(name, names));
      }
      return Effect.succeed(workflow);
    },

    list: () => names,

    has: (name: string) => name in workflows,
  };
}

/**
 * Create a registry layer.
 */
export const WorkflowRegistryLayer = <W extends WorkflowRegistry>(
  workflows: W
) =>
  Layer.succeed(WorkflowRegistryTag, createWorkflowRegistry(workflows));
```

### 3. Workflow Orchestrator Service (`orchestrator/orchestrator.ts`)

```typescript
// packages/workflow-v2/src/orchestrator/orchestrator.ts

import { Context, Effect, Layer } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { SchedulerAdapter } from "../adapters/scheduler";
import { RuntimeAdapter } from "../adapters/runtime";
import { WorkflowStateMachine } from "../state/machine";
import { RecoveryManager } from "../recovery/manager";
import { WorkflowExecutor, resultToTransition } from "../executor";
import { OrchestratorError, StorageError } from "../errors";
import {
  WorkflowRegistryTag,
  WorkflowNotFoundError,
} from "./registry";
import type {
  WorkflowRegistry,
  WorkflowCall,
  StartResult,
  CancelResult,
  CancelOptions,
  WorkflowStatusResult,
} from "./types";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * WorkflowOrchestrator service interface.
 *
 * The main API for workflow management.
 */
export interface WorkflowOrchestratorService<W extends WorkflowRegistry> {
  /**
   * Start a workflow synchronously.
   * Executes immediately and returns when complete or paused.
   */
  readonly start: (
    call: WorkflowCall<W>
  ) => Effect.Effect<StartResult, OrchestratorError>;

  /**
   * Queue a workflow for async execution.
   * Returns immediately, workflow starts on next alarm.
   */
  readonly queue: (
    call: WorkflowCall<W>
  ) => Effect.Effect<StartResult, OrchestratorError>;

  /**
   * Handle an alarm event.
   * Determines appropriate action (resume, start queued, recover).
   */
  readonly handleAlarm: () => Effect.Effect<void, OrchestratorError>;

  /**
   * Cancel a running or queued workflow.
   */
  readonly cancel: (
    options?: CancelOptions
  ) => Effect.Effect<CancelResult, OrchestratorError>;

  /**
   * Get workflow status.
   */
  readonly getStatus: () => Effect.Effect<WorkflowStatusResult, StorageError>;

  /**
   * Check if workflow exists.
   */
  readonly exists: () => Effect.Effect<boolean, StorageError>;
}

/**
 * Effect service tag for WorkflowOrchestrator.
 */
export class WorkflowOrchestrator<
  W extends WorkflowRegistry
> extends Context.Tag("@durable-effect/WorkflowOrchestrator")<
  WorkflowOrchestrator<W>,
  WorkflowOrchestratorService<W>
>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create the WorkflowOrchestrator service implementation.
 */
export const createWorkflowOrchestrator = <W extends WorkflowRegistry>() =>
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const scheduler = yield* SchedulerAdapter;
    const runtime = yield* RuntimeAdapter;
    const stateMachine = yield* WorkflowStateMachine;
    const recovery = yield* RecoveryManager;
    const executor = yield* WorkflowExecutor;
    const registry = yield* WorkflowRegistryTag;

    const service: WorkflowOrchestratorService<W> = {
      start: (call) =>
        Effect.gen(function* () {
          // Get workflow definition
          const definition = yield* registry.get(call.workflow).pipe(
            Effect.mapError(
              (err) =>
                new OrchestratorError({
                  operation: "start",
                  cause: err,
                })
            )
          );

          // Check for existing workflow
          const existingStatus = yield* stateMachine.getStatus();
          if (existingStatus) {
            // Idempotent - already exists
            return {
              id: runtime.instanceId,
              completed: existingStatus._tag === "Completed",
            };
          }

          // Initialize state
          yield* stateMachine.initialize(
            call.workflow,
            call.input,
            call.executionId
          );

          // Transition to Running
          yield* stateMachine.applyTransition({
            _tag: "Start",
            input: call.input,
          });

          // Execute workflow
          const result = yield* executor.execute(definition, {
            workflowId: runtime.instanceId,
            workflowName: call.workflow,
            input: call.input,
            executionId: call.executionId,
            mode: "fresh",
          });

          // Apply result transition
          const transition = resultToTransition(result);
          yield* stateMachine.applyTransition(transition);

          // Clean up if completed
          if (result._tag === "Completed") {
            yield* cleanup();
          }

          return {
            id: runtime.instanceId,
            completed: result._tag === "Completed",
            output: result._tag === "Completed" ? result.output : undefined,
          };
        }).pipe(
          Effect.catchAll((error) =>
            Effect.fail(
              error instanceof OrchestratorError
                ? error
                : new OrchestratorError({ operation: "start", cause: error })
            )
          )
        ),

      queue: (call) =>
        Effect.gen(function* () {
          // Get workflow definition (validate it exists)
          yield* registry.get(call.workflow).pipe(
            Effect.mapError(
              (err) =>
                new OrchestratorError({
                  operation: "queue",
                  cause: err,
                })
            )
          );

          // Check for existing workflow
          const existingStatus = yield* stateMachine.getStatus();
          if (existingStatus) {
            return {
              id: runtime.instanceId,
              completed: existingStatus._tag === "Completed",
            };
          }

          // Initialize state
          yield* stateMachine.initialize(
            call.workflow,
            call.input,
            call.executionId
          );

          // Transition to Queued
          yield* stateMachine.applyTransition({
            _tag: "Queue",
            input: call.input,
          });

          // Schedule alarm to start
          const now = yield* runtime.now();
          yield* scheduler.schedule(now + 1); // Start almost immediately

          return {
            id: runtime.instanceId,
            completed: false,
          };
        }).pipe(
          Effect.catchAll((error) =>
            Effect.fail(
              error instanceof OrchestratorError
                ? error
                : new OrchestratorError({ operation: "queue", cause: error })
            )
          )
        ),

      handleAlarm: () =>
        Effect.gen(function* () {
          const status = yield* stateMachine.getStatus();

          if (!status) {
            // No workflow - nothing to do
            return;
          }

          switch (status._tag) {
            case "Queued": {
              // Start queued workflow
              const state = yield* stateMachine.getState();
              if (!state) return;

              const definition = yield* registry.get(state.workflowName);

              yield* stateMachine.applyTransition({
                _tag: "Start",
                input: state.input,
              });

              const result = yield* executor.execute(definition, {
                workflowId: runtime.instanceId,
                workflowName: state.workflowName,
                input: state.input,
                executionId: state.executionId,
                mode: "fresh",
              });

              yield* stateMachine.applyTransition(resultToTransition(result));

              if (result._tag === "Completed") {
                yield* cleanup();
              }
              break;
            }

            case "Paused": {
              // Resume from pause
              const state = yield* stateMachine.getState();
              if (!state) return;

              const definition = yield* registry.get(state.workflowName);

              yield* stateMachine.applyTransition({ _tag: "Resume" });

              const result = yield* executor.execute(definition, {
                workflowId: runtime.instanceId,
                workflowName: state.workflowName,
                input: state.input,
                executionId: state.executionId,
                mode: "resume",
              });

              yield* stateMachine.applyTransition(resultToTransition(result));

              if (result._tag === "Completed") {
                yield* cleanup();
              }
              break;
            }

            case "Running": {
              // This shouldn't happen normally - workflow interrupted
              // Use recovery system
              const recoveryResult = yield* recovery.executeRecovery();

              if (recoveryResult.success) {
                // Re-execute
                const state = yield* stateMachine.getState();
                if (!state) return;

                const definition = yield* registry.get(state.workflowName);

                const result = yield* executor.execute(definition, {
                  workflowId: runtime.instanceId,
                  workflowName: state.workflowName,
                  input: state.input,
                  executionId: state.executionId,
                  mode: "recover",
                });

                yield* stateMachine.applyTransition(resultToTransition(result));

                if (result._tag === "Completed") {
                  yield* cleanup();
                }
              }
              break;
            }

            // Terminal states - nothing to do
            case "Completed":
            case "Failed":
            case "Cancelled":
            case "Pending":
              break;
          }
        }).pipe(
          Effect.catchAll((error) =>
            Effect.fail(
              error instanceof OrchestratorError
                ? error
                : new OrchestratorError({ operation: "alarm", cause: error })
            )
          )
        ),

      cancel: (options) =>
        Effect.gen(function* () {
          const status = yield* stateMachine.getStatus();

          if (!status) {
            return {
              cancelled: false,
              reason: "not_found" as const,
            };
          }

          // Check if cancellable
          if (
            status._tag === "Completed" ||
            status._tag === "Failed" ||
            status._tag === "Cancelled"
          ) {
            return {
              cancelled: false,
              reason: "already_terminal" as const,
              previousStatus: status._tag,
            };
          }

          // Set cancellation flag
          yield* stateMachine.setCancelled(options?.reason);

          // If queued or paused, cancel immediately
          if (status._tag === "Queued" || status._tag === "Paused") {
            yield* stateMachine.applyTransition({
              _tag: "Cancel",
              reason: options?.reason,
              completedSteps: yield* stateMachine.getCompletedSteps(),
            });

            // Cancel any scheduled alarm
            yield* scheduler.cancel();

            return {
              cancelled: true,
              previousStatus: status._tag,
            };
          }

          // If running, let the step check catch it
          return {
            cancelled: true,
            previousStatus: status._tag,
          };
        }).pipe(
          Effect.catchAll((error) =>
            Effect.fail(
              new OrchestratorError({ operation: "cancel", cause: error })
            )
          )
        ),

      getStatus: () =>
        Effect.gen(function* () {
          const status = yield* stateMachine.getStatus();
          const completedSteps = yield* stateMachine.getCompletedSteps();

          return {
            status,
            completedSteps,
            exists: status !== undefined,
          };
        }),

      exists: () =>
        stateMachine.getStatus().pipe(Effect.map((s) => s !== undefined)),
    };

    // Helper to clean up after completion
    const cleanup = () =>
      Effect.gen(function* () {
        // Clear scheduled alarm
        yield* scheduler.cancel();
        // Note: We don't delete storage - keep for history/queries
      });

    return service;
  });

/**
 * Create an orchestrator layer for a workflow registry.
 */
export const WorkflowOrchestratorLayer = <W extends WorkflowRegistry>() =>
  Layer.effect(
    WorkflowOrchestrator<W>(),
    createWorkflowOrchestrator<W>()
  );
```

### 4. Orchestrator Exports (`orchestrator/index.ts`)

```typescript
// packages/workflow-v2/src/orchestrator/index.ts

// Types
export type {
  WorkflowRegistry,
  WorkflowCall,
  StartResult,
  CancelResult,
  CancelOptions,
  WorkflowStatusResult,
} from "./types";

// Registry
export {
  WorkflowRegistryTag,
  WorkflowRegistryLayer,
  createWorkflowRegistry,
  WorkflowNotFoundError,
  type WorkflowRegistryService,
} from "./registry";

// Orchestrator
export {
  WorkflowOrchestrator,
  WorkflowOrchestratorLayer,
  createWorkflowOrchestrator,
  type WorkflowOrchestratorService,
} from "./orchestrator";
```

### 5. Update Main Index

```typescript
// packages/workflow-v2/src/index.ts

// ... existing exports ...

// Orchestrator
export {
  WorkflowOrchestrator,
  WorkflowOrchestratorLayer,
  type WorkflowOrchestratorService,
  WorkflowRegistryTag,
  WorkflowRegistryLayer,
  createWorkflowRegistry,
  WorkflowNotFoundError,
  type WorkflowRegistry,
  type WorkflowCall,
  type StartResult,
  type CancelResult,
  type CancelOptions,
  type WorkflowStatusResult,
} from "./orchestrator";
```

---

## Testing Strategy

### Test File: `test/orchestrator/orchestrator.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  WorkflowStateMachine,
  WorkflowStateMachineLayer,
  WorkflowExecutor,
  WorkflowExecutorLayer,
  RecoveryManager,
  RecoveryManagerLayer,
  WorkflowOrchestrator,
  WorkflowOrchestratorLayer,
  WorkflowRegistryLayer,
  make,
  step,
  sleep,
  type TestRuntimeHandle,
  type RuntimeLayer,
  type WorkflowRegistry,
} from "../../src";

// Test workflows
const testWorkflows = {
  simpleWorkflow: make(
    { name: "simpleWorkflow" },
    (input: { value: number }) =>
      Effect.succeed(input.value * 2)
  ),

  steppedWorkflow: make(
    { name: "steppedWorkflow" },
    (input: { items: string[] }) =>
      Effect.gen(function* () {
        const results: string[] = [];
        for (const item of input.items) {
          const result = yield* step(`process-${item}`, () =>
            Effect.succeed(item.toUpperCase())
          );
          results.push(result);
        }
        return results;
      })
  ),

  sleepingWorkflow: make(
    { name: "sleepingWorkflow" },
    (_input: {}) =>
      Effect.gen(function* () {
        yield* step("before", () => Effect.succeed("before"));
        yield* sleep("5 seconds");
        yield* step("after", () => Effect.succeed("after"));
        return "done";
      })
  ),

  failingWorkflow: make(
    { name: "failingWorkflow" },
    (_input: {}) =>
      Effect.fail(new Error("intentional failure"))
  ),
} satisfies WorkflowRegistry;

describe("WorkflowOrchestrator", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000, instanceId: "orch-test-123" })
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
      Layer.provide(runtimeLayer)
    );

  const runOrchestrator = <A, E>(effect: Effect.Effect<A, E, any>) =>
    effect.pipe(Effect.provide(createLayers()), Effect.runPromise);

  describe("start", () => {
    it("should start and complete simple workflow", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.start({
            workflow: "simpleWorkflow",
            input: { value: 21 },
          });
        })
      );

      expect(result.id).toBe("orch-test-123");
      expect(result.completed).toBe(true);
      expect(result.output).toBe(42);
    });

    it("should start workflow with steps", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.start({
            workflow: "steppedWorkflow",
            input: { items: ["a", "b", "c"] },
          });
        })
      );

      expect(result.completed).toBe(true);
      expect(result.output).toEqual(["A", "B", "C"]);
    });

    it("should handle workflow that pauses", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.start({
            workflow: "sleepingWorkflow",
            input: {},
          });
        })
      );

      expect(result.completed).toBe(false);

      // Check status
      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.getStatus();
        })
      );

      expect(status.status?._tag).toBe("Paused");
      expect(status.completedSteps).toContain("before");
    });

    it("should be idempotent (return existing workflow)", async () => {
      // First start
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          yield* orchestrator.start({
            workflow: "simpleWorkflow",
            input: { value: 10 },
          });
        })
      );

      // Second start (same workflow)
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.start({
            workflow: "simpleWorkflow",
            input: { value: 999 }, // Different input
          });
        })
      );

      // Should return existing (completed) workflow
      expect(result.completed).toBe(true);
    });
  });

  describe("queue", () => {
    it("should queue workflow for async execution", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.queue({
            workflow: "simpleWorkflow",
            input: { value: 5 },
          });
        })
      );

      expect(result.completed).toBe(false);

      // Check status
      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.getStatus();
        })
      );

      expect(status.status?._tag).toBe("Queued");

      // Check alarm was scheduled
      const schedulerState = await Effect.runPromise(handle.getSchedulerState());
      expect(schedulerState.scheduledTime).toBeDefined();
    });
  });

  describe("handleAlarm", () => {
    it("should start queued workflow", async () => {
      // Queue workflow
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          yield* orchestrator.queue({
            workflow: "simpleWorkflow",
            input: { value: 7 },
          });
        })
      );

      // Handle alarm
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          yield* orchestrator.handleAlarm();
        })
      );

      // Check completed
      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.getStatus();
        })
      );

      expect(status.status?._tag).toBe("Completed");
    });

    it("should resume paused workflow", async () => {
      // Start workflow (will pause at sleep)
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          yield* orchestrator.start({
            workflow: "sleepingWorkflow",
            input: {},
          });
        })
      );

      // Advance time past sleep
      await Effect.runPromise(handle.advanceTime(6000));

      // Handle alarm (resume)
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          yield* orchestrator.handleAlarm();
        })
      );

      // Check completed
      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.getStatus();
        })
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
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          yield* orchestrator.queue({
            workflow: "simpleWorkflow",
            input: { value: 1 },
          });
        })
      );

      // Cancel
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.cancel({ reason: "user request" });
        })
      );

      expect(result.cancelled).toBe(true);
      expect(result.previousStatus).toBe("Queued");

      // Check status
      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.getStatus();
        })
      );

      expect(status.status?._tag).toBe("Cancelled");
    });

    it("should return not_found for non-existent workflow", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.cancel();
        })
      );

      expect(result.cancelled).toBe(false);
      expect(result.reason).toBe("not_found");
    });

    it("should return already_terminal for completed workflow", async () => {
      // Start and complete workflow
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          yield* orchestrator.start({
            workflow: "simpleWorkflow",
            input: { value: 1 },
          });
        })
      );

      // Try to cancel
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.cancel();
        })
      );

      expect(result.cancelled).toBe(false);
      expect(result.reason).toBe("already_terminal");
    });
  });

  describe("getStatus", () => {
    it("should return status for existing workflow", async () => {
      await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          yield* orchestrator.start({
            workflow: "simpleWorkflow",
            input: { value: 1 },
          });
        })
      );

      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.getStatus();
        })
      );

      expect(status.exists).toBe(true);
      expect(status.status?._tag).toBe("Completed");
    });

    it("should return exists: false for non-existent workflow", async () => {
      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.getStatus();
        })
      );

      expect(status.exists).toBe(false);
      expect(status.status).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("should handle workflow failure", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.start({
            workflow: "failingWorkflow",
            input: {},
          });
        })
      );

      expect(result.completed).toBe(false);

      const status = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.getStatus();
        })
      );

      expect(status.status?._tag).toBe("Failed");
    });

    it("should fail for unknown workflow", async () => {
      const result = await runOrchestrator(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<typeof testWorkflows>();
          return yield* orchestrator.start({
            workflow: "unknownWorkflow" as any,
            input: {},
          }).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
    });
  });
});
```

---

## Definition of Done

- [ ] WorkflowRegistry maps names to definitions
- [ ] WorkflowOrchestrator provides full lifecycle API
- [ ] start() executes workflow synchronously
- [ ] queue() schedules workflow for async execution
- [ ] handleAlarm() processes all alarm scenarios
- [ ] cancel() stops running/queued workflows
- [ ] getStatus() returns workflow state
- [ ] Idempotent start (returns existing workflow)
- [ ] Error wrapping in OrchestratorError
- [ ] All tests passing
- [ ] Package builds without errors

---

## Notes for Implementation

1. **Registry is type-safe** - WorkflowCall enforces correct input types
2. **Idempotency is important** - Second start returns existing workflow
3. **handleAlarm is the core loop** - Most execution happens here
4. **Recovery integration** - Running status in alarm triggers recovery
5. **Cleanup is minimal** - Keep storage for history/debugging
