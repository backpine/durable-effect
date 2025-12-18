// packages/workflow/src/orchestrator/orchestrator.ts

import { Context, Effect, Layer } from "effect";
import { createWorkflowBaseEvent, emitEvent } from "@durable-effect/core";
import { StorageAdapter } from "../adapters/storage";
import { SchedulerAdapter } from "../adapters/scheduler";
import { RuntimeAdapter } from "../adapters/runtime";
import { WorkflowStateMachine } from "../state/machine";
import { Start, Queue, Resume, Cancel } from "../state/types";
import { RecoveryManager } from "../recovery/manager";
import { WorkflowExecutor, resultToTransition } from "../executor";
import { OrchestratorError, StorageError } from "../errors";
import { PurgeManager, type TerminalState } from "../purge";
import type { WorkflowDefinition } from "../primitives/make";
import { WorkflowRegistryTag, WorkflowNotFoundError } from "./registry";
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
 * Requirements for workflows in the registry.
 * These are satisfied by the runtime layer.
 */
export type WorkflowRequirements<W extends WorkflowRegistry> =
  W[keyof W] extends WorkflowDefinition<any, any, any, infer R> ? R : never;

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
    call: WorkflowCall<W>,
  ) => Effect.Effect<StartResult, OrchestratorError, WorkflowRequirements<W>>;

  /**
   * Queue a workflow for async execution.
   * Returns immediately, workflow starts on next alarm.
   */
  readonly queue: (
    call: WorkflowCall<W>,
  ) => Effect.Effect<StartResult, OrchestratorError>;

  /**
   * Handle an alarm event.
   * Determines appropriate action (resume, start queued, recover).
   */
  readonly handleAlarm: () => Effect.Effect<
    void,
    OrchestratorError,
    WorkflowRequirements<W>
  >;

  /**
   * Cancel a running or queued workflow.
   */
  readonly cancel: (
    options?: CancelOptions,
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
 * Note: Uses `any` for registry type at the tag level.
 * Type safety is provided through the layer and service creation.
 */
export class WorkflowOrchestrator extends Context.Tag(
  "@durable-effect/WorkflowOrchestrator",
)<WorkflowOrchestrator, WorkflowOrchestratorService<any>>() {}

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
    const purgeManager = yield* PurgeManager;

    // Helper to clean up after terminal state
    const cleanup = (terminalState: TerminalState) =>
      Effect.gen(function* () {
        // Clear scheduled workflow alarm
        yield* scheduler.cancel();

        // Schedule purge (no-op if purge disabled)
        yield* purgeManager.schedulePurge(terminalState);
      });

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
                }),
            ),
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
            call.executionId,
          );

          // Transition to Running
          yield* stateMachine.applyTransition(new Start({ input: call.input }));

          // Emit workflow.started event
          yield* emitEvent({
            ...createWorkflowBaseEvent(
              runtime.instanceId,
              call.workflow,
              call.executionId,
            ),
            type: "workflow.started",
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

          // Apply result transition and emit corresponding event
          const transition = resultToTransition(result);
          yield* stateMachine.applyTransition(transition);

          // Emit result event
          const baseEvent = createWorkflowBaseEvent(
            runtime.instanceId,
            call.workflow,
            call.executionId,
          );
          if (result._tag === "Completed") {
            yield* emitEvent({
              ...baseEvent,
              type: "workflow.completed",
              completedSteps: [...result.completedSteps],
              durationMs: result.durationMs,
            });
            yield* cleanup("completed");
          } else if (result._tag === "Failed") {
            yield* emitEvent({
              ...baseEvent,
              type: "workflow.failed",
              error: {
                message:
                  result.error instanceof Error
                    ? result.error.message
                    : String(result.error),
                stack:
                  result.error instanceof Error
                    ? result.error.stack
                    : undefined,
              },
              completedSteps: [...result.completedSteps],
            });
            yield* cleanup("failed");
          } else if (result._tag === "Paused") {
            yield* emitEvent({
              ...baseEvent,
              type: "workflow.paused",
              reason: result.reason,
              resumeAt: new Date(result.resumeAt).toISOString(),
              stepName: result.stepName,
            });
          } else if (result._tag === "Cancelled") {
            yield* emitEvent({
              ...baseEvent,
              type: "workflow.cancelled",
              reason: result.reason,
              completedSteps: [...result.completedSteps],
            });
            yield* cleanup("cancelled");
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
                : new OrchestratorError({ operation: "start", cause: error }),
            ),
          ),
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
                }),
            ),
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
            call.executionId,
          );

          // Transition to Queued
          yield* stateMachine.applyTransition(new Queue({ input: call.input }));

          // Emit workflow.queued event
          yield* emitEvent({
            ...createWorkflowBaseEvent(
              runtime.instanceId,
              call.workflow,
              call.executionId,
            ),
            type: "workflow.queued",
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
                : new OrchestratorError({ operation: "queue", cause: error }),
            ),
          ),
        ),

      handleAlarm: () =>
        Effect.gen(function* () {
          const status = yield* stateMachine.getStatus();

          if (!status) {
            // No workflow - nothing to do
            return;
          }

          // Helper to emit result events
          const emitResultEvents = (
            result: import("../executor/types").ExecutionResult<unknown>,
            workflowName: string,
            executionId?: string,
          ) =>
            Effect.gen(function* () {
              const baseEvent = createWorkflowBaseEvent(
                runtime.instanceId,
                workflowName,
                executionId,
              );
              switch (result._tag) {
                case "Completed":
                  yield* emitEvent({
                    ...baseEvent,
                    type: "workflow.completed",
                    completedSteps: [...result.completedSteps],
                    durationMs: result.durationMs,
                  });
                  break;
                case "Failed":
                  yield* emitEvent({
                    ...baseEvent,
                    type: "workflow.failed",
                    error: {
                      message:
                        result.error instanceof Error
                          ? result.error.message
                          : String(result.error),
                      stack:
                        result.error instanceof Error
                          ? result.error.stack
                          : undefined,
                    },
                    completedSteps: [...result.completedSteps],
                  });
                  break;
                case "Paused":
                  yield* emitEvent({
                    ...baseEvent,
                    type: "workflow.paused",
                    reason: result.reason,
                    resumeAt: new Date(result.resumeAt).toISOString(),
                    stepName: result.stepName,
                  });
                  break;
                case "Cancelled":
                  yield* emitEvent({
                    ...baseEvent,
                    type: "workflow.cancelled",
                    reason: result.reason,
                    completedSteps: [...result.completedSteps],
                  });
                  break;
              }
            });

          switch (status._tag) {
            case "Queued": {
              // Start queued workflow
              const state = yield* stateMachine.getState();
              if (!state) return;

              const definition = yield* registry.get(state.workflowName);

              yield* stateMachine.applyTransition(
                new Start({ input: state.input }),
              );

              // Emit workflow.started event
              yield* emitEvent({
                ...createWorkflowBaseEvent(
                  runtime.instanceId,
                  state.workflowName,
                  state.executionId,
                ),
                type: "workflow.started",
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
              yield* emitResultEvents(
                result,
                state.workflowName,
                state.executionId,
              );

              if (result._tag === "Completed") {
                yield* cleanup("completed");
              } else if (result._tag === "Failed") {
                yield* cleanup("failed");
              } else if (result._tag === "Cancelled") {
                yield* cleanup("cancelled");
              }
              break;
            }

            case "Paused": {
              // Resume from pause
              const state = yield* stateMachine.getState();
              if (!state) return;

              const definition = yield* registry.get(state.workflowName);

              yield* stateMachine.applyTransition(new Resume());

              // Emit workflow.resumed event
              yield* emitEvent({
                ...createWorkflowBaseEvent(
                  runtime.instanceId,
                  state.workflowName,
                  state.executionId,
                ),
                type: "workflow.resumed",
              });

              const result = yield* executor.execute(definition, {
                workflowId: runtime.instanceId,
                workflowName: state.workflowName,
                input: state.input,
                executionId: state.executionId,
                mode: "resume",
              });

              yield* stateMachine.applyTransition(resultToTransition(result));
              yield* emitResultEvents(
                result,
                state.workflowName,
                state.executionId,
              );

              if (result._tag === "Completed") {
                yield* cleanup("completed");
              } else if (result._tag === "Failed") {
                yield* cleanup("failed");
              } else if (result._tag === "Cancelled") {
                yield* cleanup("cancelled");
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

                // Emit workflow.resumed for recovery (similar to resume)
                yield* emitEvent({
                  ...createWorkflowBaseEvent(
                    runtime.instanceId,
                    state.workflowName,
                    state.executionId,
                  ),
                  type: "workflow.resumed",
                });

                const result = yield* executor.execute(definition, {
                  workflowId: runtime.instanceId,
                  workflowName: state.workflowName,
                  input: state.input,
                  executionId: state.executionId,
                  mode: "recover",
                });

                yield* stateMachine.applyTransition(resultToTransition(result));
                yield* emitResultEvents(
                  result,
                  state.workflowName,
                  state.executionId,
                );

                if (result._tag === "Completed") {
                  yield* cleanup("completed");
                } else if (result._tag === "Failed") {
                  yield* cleanup("failed");
                } else if (result._tag === "Cancelled") {
                  yield* cleanup("cancelled");
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
                : new OrchestratorError({ operation: "alarm", cause: error }),
            ),
          ),
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
            const completedSteps = yield* stateMachine.getCompletedSteps();

            yield* stateMachine.applyTransition(
              new Cancel({ reason: options?.reason, completedSteps }),
            );

            // Emit workflow.cancelled event
            const state = yield* stateMachine.getState();
            if (state) {
              yield* emitEvent({
                ...createWorkflowBaseEvent(
                  runtime.instanceId,
                  state.workflowName,
                  state.executionId,
                ),
                type: "workflow.cancelled",
                reason: options?.reason,
                completedSteps: [...completedSteps],
              });
            }

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
              new OrchestratorError({ operation: "cancel", cause: error }),
            ),
          ),
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

    return service;
  });

/**
 * Create an orchestrator layer for a workflow registry.
 */
export const WorkflowOrchestratorLayer = <W extends WorkflowRegistry>() =>
  Layer.effect(WorkflowOrchestrator, createWorkflowOrchestrator<W>());
