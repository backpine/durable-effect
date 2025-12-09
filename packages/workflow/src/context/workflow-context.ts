// packages/workflow/src/context/workflow-context.ts

import { Context, Effect, Layer } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { RuntimeAdapter } from "../adapters/runtime";
import type { StorageError } from "../errors";

// =============================================================================
// Storage Keys
// =============================================================================

const KEYS = {
  workflowId: "workflow:id",
  workflowName: "workflow:name",
  input: "workflow:input",
  executionId: "workflow:executionId",
  completedSteps: "workflow:completedSteps",
  currentPauseIndex: "workflow:currentPauseIndex",
  completedPauseIndex: "workflow:completedPauseIndex",
  pendingResumeAt: "workflow:pendingResumeAt",
  startedAt: "workflow:startedAt",
  meta: (key: string) => `workflow:meta:${key}`,
} as const;

// =============================================================================
// Service Interface
// =============================================================================

/**
 * WorkflowContext service interface.
 *
 * Provides workflow-level state access for primitives.
 * All state is persisted through StorageAdapter.
 */
export interface WorkflowContextService {
  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  /**
   * Get the workflow instance ID.
   * This is the unique identifier for this workflow execution.
   */
  readonly workflowId: Effect.Effect<string, StorageError>;

  /**
   * Get the workflow definition name.
   */
  readonly workflowName: Effect.Effect<string, StorageError>;

  /**
   * Get the workflow input.
   */
  readonly input: <T>() => Effect.Effect<T | undefined, StorageError>;

  /**
   * Get the execution/correlation ID (optional).
   */
  readonly executionId: Effect.Effect<string | undefined, StorageError>;

  // ---------------------------------------------------------------------------
  // Step Tracking
  // ---------------------------------------------------------------------------

  /**
   * Get list of completed step names.
   */
  readonly completedSteps: Effect.Effect<ReadonlyArray<string>, StorageError>;

  /**
   * Check if a step has already completed.
   */
  readonly hasCompletedStep: (
    stepName: string,
  ) => Effect.Effect<boolean, StorageError>;

  /**
   * Mark a step as completed.
   */
  readonly markStepCompleted: (
    stepName: string,
  ) => Effect.Effect<void, StorageError>;

  // ---------------------------------------------------------------------------
  // Pause Point Tracking
  // ---------------------------------------------------------------------------

  /**
   * Get the completed pause index.
   * Used to skip already-executed pause points on replay.
   */
  readonly completedPauseIndex: Effect.Effect<number, StorageError>;

  /**
   * Increment and get the next pause index.
   */
  readonly incrementPauseIndex: () => Effect.Effect<number, StorageError>;

  /**
   * Check if we should execute a pause point at the given index.
   */
  readonly shouldExecutePause: (
    index: number,
  ) => Effect.Effect<boolean, StorageError>;

  // ---------------------------------------------------------------------------
  // Resume Tracking
  // ---------------------------------------------------------------------------

  /**
   * Get pending resume time (if paused).
   */
  readonly pendingResumeAt: Effect.Effect<number | undefined, StorageError>;

  /**
   * Set pending resume time.
   */
  readonly setPendingResumeAt: (
    time: number,
  ) => Effect.Effect<void, StorageError>;

  /**
   * Clear pending resume time.
   */
  readonly clearPendingResumeAt: () => Effect.Effect<void, StorageError>;

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  /**
   * Get workflow-level metadata.
   */
  readonly getMeta: <T>(
    key: string,
  ) => Effect.Effect<T | undefined, StorageError>;

  /**
   * Set workflow-level metadata.
   */
  readonly setMeta: <T>(
    key: string,
    value: T,
  ) => Effect.Effect<void, StorageError>;

  // ---------------------------------------------------------------------------
  // Timing
  // ---------------------------------------------------------------------------

  /**
   * Get workflow start time.
   */
  readonly startedAt: Effect.Effect<number | undefined, StorageError>;

  /**
   * Get current time from runtime.
   */
  readonly now: Effect.Effect<number>;
}

/**
 * Effect service tag for WorkflowContext.
 */
export class WorkflowContext extends Context.Tag(
  "@durable-effect/WorkflowContext",
)<WorkflowContext, WorkflowContextService>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a WorkflowContext service bound to storage.
 */
export const createWorkflowContext = Effect.gen(function* () {
  const storage = yield* StorageAdapter;
  const runtime = yield* RuntimeAdapter;

  const service: WorkflowContextService = {
    // Identity
    workflowId: Effect.succeed(runtime.instanceId),

    workflowName: storage
      .get<string>(KEYS.workflowName)
      .pipe(Effect.map((name) => name ?? "unknown")),

    input: <T>() => storage.get<T>(KEYS.input),

    executionId: storage.get<string>(KEYS.executionId),

    // Step Tracking
    completedSteps: storage
      .get<string[]>(KEYS.completedSteps)
      .pipe(Effect.map((steps) => steps ?? [])),

    hasCompletedStep: (stepName) =>
      storage
        .get<string[]>(KEYS.completedSteps)
        .pipe(Effect.map((steps) => (steps ?? []).includes(stepName))),

    markStepCompleted: (stepName) =>
      Effect.gen(function* () {
        const steps = (yield* storage.get<string[]>(KEYS.completedSteps)) ?? [];
        if (!steps.includes(stepName)) {
          yield* storage.put(KEYS.completedSteps, [...steps, stepName]);
        }
      }),

    // Pause Point Tracking
    completedPauseIndex: storage
      .get<number>(KEYS.completedPauseIndex)
      .pipe(Effect.map((idx) => idx ?? 0)),

    incrementPauseIndex: () =>
      Effect.gen(function* () {
        const current =
          (yield* storage.get<number>(KEYS.currentPauseIndex)) ?? 0;
        const next = current + 1;
        yield* storage.put(KEYS.currentPauseIndex, next);
        return next;
      }),

    shouldExecutePause: (index) =>
      storage
        .get<number>(KEYS.completedPauseIndex)
        .pipe(Effect.map((completed) => index > (completed ?? 0))),

    // Resume Tracking
    pendingResumeAt: storage.get<number>(KEYS.pendingResumeAt),

    setPendingResumeAt: (time) => storage.put(KEYS.pendingResumeAt, time),

    clearPendingResumeAt: () =>
      storage.delete(KEYS.pendingResumeAt).pipe(Effect.asVoid),

    // Metadata
    getMeta: <T>(key: string) => storage.get<T>(KEYS.meta(key)),

    setMeta: <T>(key: string, value: T) => storage.put(KEYS.meta(key), value),

    // Timing
    startedAt: storage.get<number>(KEYS.startedAt),

    now: runtime.now(),
  };

  return service;
});

/**
 * Layer that provides WorkflowContext.
 */
export const WorkflowContextLayer = Layer.effect(
  WorkflowContext,
  createWorkflowContext,
);
