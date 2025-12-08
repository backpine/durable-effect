# Phase 2: State Machine - Workflow State Management

## Overview

This phase implements the `WorkflowStateMachine` service - the central authority for workflow state. It validates transitions, manages status updates, and provides state queries. This is a critical component that ensures workflows never enter invalid states.

**Duration**: ~2-3 hours
**Dependencies**: Phase 1 (adapters)
**Risk Level**: Low

---

## Goals

1. Define all workflow status types
2. Define all workflow transition types (including `Recover`)
3. Implement transition validation matrix
4. Create `WorkflowStateMachine` Effect service
5. Persist state changes through `StorageAdapter`

---

## File Structure

```
packages/workflow/src/
├── state/
│   ├── index.ts               # State exports
│   ├── types.ts               # Status & Transition types
│   ├── transitions.ts         # Transition validation matrix
│   └── machine.ts             # WorkflowStateMachine service
└── test/
    └── state/
        ├── transitions.test.ts   # Transition validation tests
        └── machine.test.ts       # State machine integration tests
```

---

## Implementation Details

### 1. State Types (`state/types.ts`)

```typescript
// packages/workflow/src/state/types.ts

/**
 * All possible workflow statuses.
 *
 * Lifecycle:
 *   Pending → Queued → Running → Completed
 *                  ↘         ↗
 *                   Paused
 *                  ↗         ↘
 *              Running → Failed/Cancelled
 */
export type WorkflowStatus =
  | { readonly _tag: "Pending" }
  | {
      readonly _tag: "Queued";
      /** When the workflow was queued */
      readonly queuedAt: number;
    }
  | {
      readonly _tag: "Running";
      /** When execution started (for stale detection) */
      readonly runningAt: number;
    }
  | {
      readonly _tag: "Paused";
      /** Why paused: sleep or retry */
      readonly reason: "sleep" | "retry";
      /** When to resume */
      readonly resumeAt: number;
      /** Step that caused the pause (for retry) */
      readonly stepName?: string;
    }
  | {
      readonly _tag: "Completed";
      /** When completed */
      readonly completedAt: number;
    }
  | {
      readonly _tag: "Failed";
      /** When failed */
      readonly failedAt: number;
      /** Error details */
      readonly error: WorkflowError;
    }
  | {
      readonly _tag: "Cancelled";
      /** When cancelled */
      readonly cancelledAt: number;
      /** Optional cancellation reason */
      readonly reason?: string;
    };

/**
 * Error information stored with failed workflows.
 */
export interface WorkflowError {
  readonly message: string;
  readonly stack?: string;
  readonly stepName?: string;
  readonly attempt?: number;
}

/**
 * All possible workflow transitions.
 *
 * Each transition represents a state change action.
 */
export type WorkflowTransition =
  | {
      readonly _tag: "Start";
      readonly input: unknown;
    }
  | {
      readonly _tag: "Queue";
      readonly input: unknown;
    }
  | {
      readonly _tag: "Resume";
    }
  | {
      readonly _tag: "Recover";
      readonly reason: "infrastructure_restart" | "stale_detection" | "manual";
      readonly attempt: number;
    }
  | {
      readonly _tag: "Complete";
      readonly completedSteps: ReadonlyArray<string>;
      readonly durationMs: number;
    }
  | {
      readonly _tag: "Pause";
      readonly reason: "sleep" | "retry";
      readonly resumeAt: number;
      readonly stepName?: string;
    }
  | {
      readonly _tag: "Fail";
      readonly error: WorkflowError;
      readonly completedSteps: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Cancel";
      readonly reason?: string;
      readonly completedSteps: ReadonlyArray<string>;
    };

/**
 * Extract the tag from a transition for validation.
 */
export type TransitionTag = WorkflowTransition["_tag"];

/**
 * Extract the tag from a status for validation.
 */
export type StatusTag = WorkflowStatus["_tag"];

/**
 * Complete workflow state including metadata.
 */
export interface WorkflowState {
  /** Current status */
  readonly status: WorkflowStatus;
  /** Workflow definition name */
  readonly workflowName: string;
  /** Input passed to workflow */
  readonly input: unknown;
  /** Optional correlation ID */
  readonly executionId?: string;
  /** Steps that have completed */
  readonly completedSteps: ReadonlyArray<string>;
  /** Pause point tracking */
  readonly completedPauseIndex: number;
  /** Pending resume time (if paused) */
  readonly pendingResumeAt?: number;
  /** Recovery attempt counter */
  readonly recoveryAttempts: number;
  /** Cancellation flag */
  readonly cancelled: boolean;
  /** Cancellation reason */
  readonly cancelReason?: string;
}

/**
 * Default initial state for a new workflow.
 */
export const initialWorkflowState = (
  workflowName: string,
  input: unknown,
  executionId?: string
): WorkflowState => ({
  status: { _tag: "Pending" },
  workflowName,
  input,
  executionId,
  completedSteps: [],
  completedPauseIndex: 0,
  pendingResumeAt: undefined,
  recoveryAttempts: 0,
  cancelled: false,
  cancelReason: undefined,
});
```

### 2. Transition Validation (`state/transitions.ts`)

```typescript
// packages/workflow/src/state/transitions.ts

import type { StatusTag, TransitionTag } from "./types";

/**
 * Valid transitions from each status.
 *
 * This matrix is the source of truth for allowed state changes.
 * Any transition not in this matrix will be rejected.
 */
export const VALID_TRANSITIONS: Record<StatusTag, readonly TransitionTag[]> = {
  // Pending: Can start immediately or queue for later
  Pending: ["Start", "Queue"],

  // Queued: Can start when alarm fires, or cancel
  Queued: ["Start", "Cancel"],

  // Running: Can complete, pause, fail, cancel, or recover (from interrupt)
  Running: ["Complete", "Pause", "Fail", "Cancel", "Recover"],

  // Paused: Can resume when alarm fires, cancel, or recover (from interrupt)
  Paused: ["Resume", "Cancel", "Recover"],

  // Terminal states: No transitions allowed
  Completed: [],
  Failed: [],
  Cancelled: [],
} as const;

/**
 * Check if a transition is valid from a given status.
 */
export function isValidTransition(
  fromStatus: StatusTag,
  transition: TransitionTag
): boolean {
  return VALID_TRANSITIONS[fromStatus].includes(transition);
}

/**
 * Get all valid transitions from a status.
 */
export function getValidTransitions(fromStatus: StatusTag): readonly TransitionTag[] {
  return VALID_TRANSITIONS[fromStatus];
}

/**
 * Check if a status is terminal (no further transitions).
 */
export function isTerminalStatus(status: StatusTag): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}

/**
 * Check if a status is recoverable (can apply Recover transition).
 */
export function isRecoverableStatus(status: StatusTag): boolean {
  return VALID_TRANSITIONS[status].includes("Recover");
}
```

### 3. State Machine Service (`state/machine.ts`)

```typescript
// packages/workflow/src/state/machine.ts

import { Context, Effect, Layer } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { RuntimeAdapter } from "../adapters/runtime";
import { InvalidTransitionError, StorageError } from "../errors";
import {
  type WorkflowStatus,
  type WorkflowTransition,
  type WorkflowState,
  type WorkflowError,
  initialWorkflowState,
} from "./types";
import {
  isValidTransition,
  getValidTransitions,
  isTerminalStatus,
  isRecoverableStatus,
} from "./transitions";

// =============================================================================
// Storage Keys
// =============================================================================

const KEYS = {
  status: "workflow:status",
  name: "workflow:name",
  input: "workflow:input",
  executionId: "workflow:executionId",
  completedSteps: "workflow:completedSteps",
  completedPauseIndex: "workflow:completedPauseIndex",
  pendingResumeAt: "workflow:pendingResumeAt",
  recoveryAttempts: "workflow:recoveryAttempts",
  cancelled: "workflow:cancelled",
  cancelReason: "workflow:cancelReason",
} as const;

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Information about whether a workflow can be recovered.
 */
export interface RecoverabilityInfo {
  readonly canRecover: boolean;
  readonly reason:
    | "stale_running"
    | "pending_resume"
    | "not_recoverable"
    | "already_terminal"
    | "no_workflow";
  readonly staleDurationMs?: number;
  readonly currentStatus?: WorkflowStatus["_tag"];
}

/**
 * WorkflowStateMachine service interface.
 *
 * Central authority for workflow state management.
 */
export interface WorkflowStateMachineService {
  /**
   * Initialize state for a new workflow.
   */
  readonly initialize: (
    workflowName: string,
    input: unknown,
    executionId?: string
  ) => Effect.Effect<void, StorageError>;

  /**
   * Get the current workflow state.
   * Returns undefined if no workflow exists.
   */
  readonly getState: () => Effect.Effect<WorkflowState | undefined, StorageError>;

  /**
   * Get just the current status.
   * Returns undefined if no workflow exists.
   */
  readonly getStatus: () => Effect.Effect<WorkflowStatus | undefined, StorageError>;

  /**
   * Check if a transition is valid from current state.
   */
  readonly canTransition: (
    transition: WorkflowTransition
  ) => Effect.Effect<boolean, StorageError>;

  /**
   * Apply a transition (validates, updates storage).
   * Fails with InvalidTransitionError if transition not allowed.
   */
  readonly applyTransition: (
    transition: WorkflowTransition
  ) => Effect.Effect<WorkflowStatus, InvalidTransitionError | StorageError>;

  /**
   * Check if the workflow can be recovered.
   */
  readonly checkRecoverability: (
    staleThresholdMs: number
  ) => Effect.Effect<RecoverabilityInfo, StorageError>;

  /**
   * Add a completed step to the list.
   */
  readonly markStepCompleted: (
    stepName: string
  ) => Effect.Effect<void, StorageError>;

  /**
   * Get the list of completed steps.
   */
  readonly getCompletedSteps: () => Effect.Effect<ReadonlyArray<string>, StorageError>;

  /**
   * Increment recovery attempts counter.
   */
  readonly incrementRecoveryAttempts: () => Effect.Effect<number, StorageError>;

  /**
   * Reset recovery attempts counter (after successful recovery).
   */
  readonly resetRecoveryAttempts: () => Effect.Effect<void, StorageError>;

  /**
   * Set the pending resume time (for sleep/retry).
   */
  readonly setPendingResumeAt: (time: number) => Effect.Effect<void, StorageError>;

  /**
   * Clear the pending resume time.
   */
  readonly clearPendingResumeAt: () => Effect.Effect<void, StorageError>;

  /**
   * Get the pending resume time.
   */
  readonly getPendingResumeAt: () => Effect.Effect<number | undefined, StorageError>;

  /**
   * Set the cancellation flag.
   */
  readonly setCancelled: (reason?: string) => Effect.Effect<void, StorageError>;

  /**
   * Check if workflow is cancelled.
   */
  readonly isCancelled: () => Effect.Effect<boolean, StorageError>;
}

/**
 * Effect service tag for WorkflowStateMachine.
 */
export class WorkflowStateMachine extends Context.Tag(
  "@durable-effect/WorkflowStateMachine"
)<WorkflowStateMachine, WorkflowStateMachineService>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Apply a transition to produce a new status.
 * Assumes transition has already been validated.
 */
function applyTransitionToStatus(
  transition: WorkflowTransition,
  now: number
): WorkflowStatus {
  switch (transition._tag) {
    case "Start":
    case "Resume":
    case "Recover":
      return { _tag: "Running", runningAt: now };

    case "Queue":
      return { _tag: "Queued", queuedAt: now };

    case "Pause":
      return {
        _tag: "Paused",
        reason: transition.reason,
        resumeAt: transition.resumeAt,
        stepName: transition.stepName,
      };

    case "Complete":
      return { _tag: "Completed", completedAt: now };

    case "Fail":
      return {
        _tag: "Failed",
        failedAt: now,
        error: transition.error,
      };

    case "Cancel":
      return {
        _tag: "Cancelled",
        cancelledAt: now,
        reason: transition.reason,
      };
  }
}

/**
 * Create the WorkflowStateMachine service implementation.
 */
export const createWorkflowStateMachine = Effect.gen(function* () {
  const storage = yield* StorageAdapter;
  const runtime = yield* RuntimeAdapter;

  const getStatus = (): Effect.Effect<WorkflowStatus | undefined, StorageError> =>
    storage.get<WorkflowStatus>(KEYS.status);

  const getState = (): Effect.Effect<WorkflowState | undefined, StorageError> =>
    Effect.gen(function* () {
      const status = yield* getStatus();
      if (!status) return undefined;

      const [
        workflowName,
        input,
        executionId,
        completedSteps,
        completedPauseIndex,
        pendingResumeAt,
        recoveryAttempts,
        cancelled,
        cancelReason,
      ] = yield* Effect.all([
        storage.get<string>(KEYS.name),
        storage.get<unknown>(KEYS.input),
        storage.get<string>(KEYS.executionId),
        storage.get<string[]>(KEYS.completedSteps),
        storage.get<number>(KEYS.completedPauseIndex),
        storage.get<number>(KEYS.pendingResumeAt),
        storage.get<number>(KEYS.recoveryAttempts),
        storage.get<boolean>(KEYS.cancelled),
        storage.get<string>(KEYS.cancelReason),
      ]);

      return {
        status,
        workflowName: workflowName ?? "unknown",
        input,
        executionId,
        completedSteps: completedSteps ?? [],
        completedPauseIndex: completedPauseIndex ?? 0,
        pendingResumeAt,
        recoveryAttempts: recoveryAttempts ?? 0,
        cancelled: cancelled ?? false,
        cancelReason,
      };
    });

  const service: WorkflowStateMachineService = {
    initialize: (workflowName, input, executionId) =>
      storage.putBatch({
        [KEYS.status]: { _tag: "Pending" } satisfies WorkflowStatus,
        [KEYS.name]: workflowName,
        [KEYS.input]: input,
        [KEYS.executionId]: executionId,
        [KEYS.completedSteps]: [],
        [KEYS.completedPauseIndex]: 0,
        [KEYS.recoveryAttempts]: 0,
        [KEYS.cancelled]: false,
      }),

    getState,
    getStatus,

    canTransition: (transition) =>
      Effect.gen(function* () {
        const status = yield* getStatus();
        if (!status) return false;
        return isValidTransition(status._tag, transition._tag);
      }),

    applyTransition: (transition) =>
      Effect.gen(function* () {
        const currentStatus = yield* getStatus();

        // No workflow exists - only Queue and Start are valid for new workflows
        if (!currentStatus) {
          if (transition._tag !== "Queue" && transition._tag !== "Start") {
            return yield* Effect.fail(
              new InvalidTransitionError({
                fromStatus: "none",
                toTransition: transition._tag,
                validTransitions: ["Queue", "Start"],
              })
            );
          }
        } else {
          // Validate transition
          if (!isValidTransition(currentStatus._tag, transition._tag)) {
            return yield* Effect.fail(
              new InvalidTransitionError({
                fromStatus: currentStatus._tag,
                toTransition: transition._tag,
                validTransitions: getValidTransitions(currentStatus._tag),
              })
            );
          }
        }

        // Get current time
        const now = yield* runtime.now();

        // Calculate new status
        const newStatus = applyTransitionToStatus(transition, now);

        // Persist
        yield* storage.put(KEYS.status, newStatus);

        return newStatus;
      }),

    checkRecoverability: (staleThresholdMs) =>
      Effect.gen(function* () {
        const status = yield* getStatus();

        if (!status) {
          return {
            canRecover: false,
            reason: "no_workflow" as const,
          };
        }

        if (isTerminalStatus(status._tag)) {
          return {
            canRecover: false,
            reason: "already_terminal" as const,
            currentStatus: status._tag,
          };
        }

        if (!isRecoverableStatus(status._tag)) {
          return {
            canRecover: false,
            reason: "not_recoverable" as const,
            currentStatus: status._tag,
          };
        }

        // Check for stale Running status
        if (status._tag === "Running") {
          const now = yield* runtime.now();
          const staleDuration = now - status.runningAt;

          if (staleDuration >= staleThresholdMs) {
            return {
              canRecover: true,
              reason: "stale_running" as const,
              staleDurationMs: staleDuration,
              currentStatus: status._tag,
            };
          }

          // Running but not stale - don't recover
          return {
            canRecover: false,
            reason: "not_recoverable" as const,
            currentStatus: status._tag,
          };
        }

        // Check Paused status with pending resume
        if (status._tag === "Paused") {
          const pendingResumeAt = yield* storage.get<number>(KEYS.pendingResumeAt);

          if (pendingResumeAt !== undefined) {
            return {
              canRecover: true,
              reason: "pending_resume" as const,
              currentStatus: status._tag,
            };
          }
        }

        return {
          canRecover: false,
          reason: "not_recoverable" as const,
          currentStatus: status._tag,
        };
      }),

    markStepCompleted: (stepName) =>
      Effect.gen(function* () {
        const steps = (yield* storage.get<string[]>(KEYS.completedSteps)) ?? [];
        if (!steps.includes(stepName)) {
          yield* storage.put(KEYS.completedSteps, [...steps, stepName]);
        }
      }),

    getCompletedSteps: () =>
      storage.get<string[]>(KEYS.completedSteps).pipe(
        Effect.map((steps) => steps ?? [])
      ),

    incrementRecoveryAttempts: () =>
      Effect.gen(function* () {
        const current = (yield* storage.get<number>(KEYS.recoveryAttempts)) ?? 0;
        const next = current + 1;
        yield* storage.put(KEYS.recoveryAttempts, next);
        return next;
      }),

    resetRecoveryAttempts: () =>
      storage.put(KEYS.recoveryAttempts, 0),

    setPendingResumeAt: (time) =>
      storage.put(KEYS.pendingResumeAt, time),

    clearPendingResumeAt: () =>
      storage.delete(KEYS.pendingResumeAt).pipe(Effect.asVoid),

    getPendingResumeAt: () =>
      storage.get<number>(KEYS.pendingResumeAt),

    setCancelled: (reason) =>
      Effect.gen(function* () {
        yield* storage.put(KEYS.cancelled, true);
        if (reason) {
          yield* storage.put(KEYS.cancelReason, reason);
        }
      }),

    isCancelled: () =>
      storage.get<boolean>(KEYS.cancelled).pipe(
        Effect.map((cancelled) => cancelled ?? false)
      ),
  };

  return service;
});

/**
 * Layer that provides WorkflowStateMachine.
 * Requires StorageAdapter and RuntimeAdapter.
 */
export const WorkflowStateMachineLayer = Layer.effect(
  WorkflowStateMachine,
  createWorkflowStateMachine
);
```

### 4. State Exports (`state/index.ts`)

```typescript
// packages/workflow/src/state/index.ts

// Types
export type {
  WorkflowStatus,
  WorkflowTransition,
  WorkflowState,
  WorkflowError,
  TransitionTag,
  StatusTag,
} from "./types";

export { initialWorkflowState } from "./types";

// Transition validation
export {
  VALID_TRANSITIONS,
  isValidTransition,
  getValidTransitions,
  isTerminalStatus,
  isRecoverableStatus,
} from "./transitions";

// State machine service
export {
  WorkflowStateMachine,
  WorkflowStateMachineLayer,
  createWorkflowStateMachine,
  type WorkflowStateMachineService,
  type RecoverabilityInfo,
} from "./machine";
```

### 5. Update Main Index

```typescript
// packages/workflow/src/index.ts

// ... existing exports ...

// State
export {
  // Types
  type WorkflowStatus,
  type WorkflowTransition,
  type WorkflowState,
  type WorkflowError,
  type TransitionTag,
  type StatusTag,
  initialWorkflowState,
  // Transition validation
  VALID_TRANSITIONS,
  isValidTransition,
  getValidTransitions,
  isTerminalStatus,
  isRecoverableStatus,
  // State machine
  WorkflowStateMachine,
  WorkflowStateMachineLayer,
  type WorkflowStateMachineService,
  type RecoverabilityInfo,
} from "./state";
```

---

## Testing Strategy

### Test File: `test/state/transitions.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  getValidTransitions,
  isTerminalStatus,
  isRecoverableStatus,
  VALID_TRANSITIONS,
} from "../../src";

describe("Transition Validation", () => {
  describe("VALID_TRANSITIONS matrix", () => {
    it("should define transitions for all statuses", () => {
      const statuses = [
        "Pending",
        "Queued",
        "Running",
        "Paused",
        "Completed",
        "Failed",
        "Cancelled",
      ];

      for (const status of statuses) {
        expect(VALID_TRANSITIONS[status]).toBeDefined();
      }
    });
  });

  describe("isValidTransition", () => {
    // Pending transitions
    it("should allow Start from Pending", () => {
      expect(isValidTransition("Pending", "Start")).toBe(true);
    });

    it("should allow Queue from Pending", () => {
      expect(isValidTransition("Pending", "Queue")).toBe(true);
    });

    it("should reject Resume from Pending", () => {
      expect(isValidTransition("Pending", "Resume")).toBe(false);
    });

    // Queued transitions
    it("should allow Start from Queued", () => {
      expect(isValidTransition("Queued", "Start")).toBe(true);
    });

    it("should allow Cancel from Queued", () => {
      expect(isValidTransition("Queued", "Cancel")).toBe(true);
    });

    it("should reject Complete from Queued", () => {
      expect(isValidTransition("Queued", "Complete")).toBe(false);
    });

    // Running transitions
    it("should allow Complete from Running", () => {
      expect(isValidTransition("Running", "Complete")).toBe(true);
    });

    it("should allow Pause from Running", () => {
      expect(isValidTransition("Running", "Pause")).toBe(true);
    });

    it("should allow Fail from Running", () => {
      expect(isValidTransition("Running", "Fail")).toBe(true);
    });

    it("should allow Cancel from Running", () => {
      expect(isValidTransition("Running", "Cancel")).toBe(true);
    });

    it("should allow Recover from Running", () => {
      expect(isValidTransition("Running", "Recover")).toBe(true);
    });

    it("should reject Start from Running", () => {
      expect(isValidTransition("Running", "Start")).toBe(false);
    });

    // Paused transitions
    it("should allow Resume from Paused", () => {
      expect(isValidTransition("Paused", "Resume")).toBe(true);
    });

    it("should allow Cancel from Paused", () => {
      expect(isValidTransition("Paused", "Cancel")).toBe(true);
    });

    it("should allow Recover from Paused", () => {
      expect(isValidTransition("Paused", "Recover")).toBe(true);
    });

    // Terminal states
    it("should reject all transitions from Completed", () => {
      expect(isValidTransition("Completed", "Start")).toBe(false);
      expect(isValidTransition("Completed", "Cancel")).toBe(false);
      expect(isValidTransition("Completed", "Recover")).toBe(false);
    });

    it("should reject all transitions from Failed", () => {
      expect(isValidTransition("Failed", "Start")).toBe(false);
      expect(isValidTransition("Failed", "Resume")).toBe(false);
    });

    it("should reject all transitions from Cancelled", () => {
      expect(isValidTransition("Cancelled", "Start")).toBe(false);
      expect(isValidTransition("Cancelled", "Resume")).toBe(false);
    });
  });

  describe("isTerminalStatus", () => {
    it("should return true for terminal states", () => {
      expect(isTerminalStatus("Completed")).toBe(true);
      expect(isTerminalStatus("Failed")).toBe(true);
      expect(isTerminalStatus("Cancelled")).toBe(true);
    });

    it("should return false for non-terminal states", () => {
      expect(isTerminalStatus("Pending")).toBe(false);
      expect(isTerminalStatus("Queued")).toBe(false);
      expect(isTerminalStatus("Running")).toBe(false);
      expect(isTerminalStatus("Paused")).toBe(false);
    });
  });

  describe("isRecoverableStatus", () => {
    it("should return true for Running and Paused", () => {
      expect(isRecoverableStatus("Running")).toBe(true);
      expect(isRecoverableStatus("Paused")).toBe(true);
    });

    it("should return false for non-recoverable states", () => {
      expect(isRecoverableStatus("Pending")).toBe(false);
      expect(isRecoverableStatus("Queued")).toBe(false);
      expect(isRecoverableStatus("Completed")).toBe(false);
    });
  });
});
```

### Test File: `test/state/machine.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  WorkflowStateMachine,
  WorkflowStateMachineLayer,
  InvalidTransitionError,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("WorkflowStateMachine", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000 })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const runWithMachine = <A, E>(
    effect: Effect.Effect<A, E, WorkflowStateMachine>
  ) =>
    effect.pipe(
      Effect.provide(WorkflowStateMachineLayer),
      Effect.provide(runtimeLayer),
      Effect.runPromise
    );

  describe("initialize", () => {
    it("should initialize workflow state", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("myWorkflow", { data: 42 }, "exec-123");
          return yield* machine.getState();
        })
      );

      expect(result).toBeDefined();
      expect(result!.status._tag).toBe("Pending");
      expect(result!.workflowName).toBe("myWorkflow");
      expect(result!.input).toEqual({ data: 42 });
      expect(result!.executionId).toBe("exec-123");
      expect(result!.completedSteps).toEqual([]);
      expect(result!.recoveryAttempts).toBe(0);
    });
  });

  describe("applyTransition", () => {
    it("should transition from Pending to Running via Start", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          return yield* machine.applyTransition({
            _tag: "Start",
            input: {},
          });
        })
      );

      expect(result._tag).toBe("Running");
      if (result._tag === "Running") {
        expect(result.runningAt).toBe(1000);
      }
    });

    it("should transition from Pending to Queued via Queue", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          return yield* machine.applyTransition({
            _tag: "Queue",
            input: {},
          });
        })
      );

      expect(result._tag).toBe("Queued");
    });

    it("should transition from Running to Paused", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          return yield* machine.applyTransition({
            _tag: "Pause",
            reason: "sleep",
            resumeAt: 5000,
          });
        })
      );

      expect(result._tag).toBe("Paused");
      if (result._tag === "Paused") {
        expect(result.reason).toBe("sleep");
        expect(result.resumeAt).toBe(5000);
      }
    });

    it("should transition from Paused to Running via Resume", async () => {
      await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          yield* machine.applyTransition({
            _tag: "Pause",
            reason: "sleep",
            resumeAt: 5000,
          });
        })
      );

      // Advance time and resume
      await Effect.runPromise(handle.advanceTime(5000));

      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.applyTransition({ _tag: "Resume" });
        })
      );

      expect(result._tag).toBe("Running");
    });

    it("should transition from Running to Completed", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          return yield* machine.applyTransition({
            _tag: "Complete",
            completedSteps: ["step1", "step2"],
            durationMs: 500,
          });
        })
      );

      expect(result._tag).toBe("Completed");
    });

    it("should transition from Running to Failed", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          return yield* machine.applyTransition({
            _tag: "Fail",
            error: { message: "Something went wrong" },
            completedSteps: ["step1"],
          });
        })
      );

      expect(result._tag).toBe("Failed");
      if (result._tag === "Failed") {
        expect(result.error.message).toBe("Something went wrong");
      }
    });

    it("should reject invalid transitions", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          // Try to Complete from Pending (invalid)
          return yield* machine.applyTransition({
            _tag: "Complete",
            completedSteps: [],
            durationMs: 0,
          }).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(InvalidTransitionError);
      }
    });
  });

  describe("checkRecoverability", () => {
    it("should detect stale Running workflow", async () => {
      await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
        })
      );

      // Advance time past threshold
      await Effect.runPromise(handle.advanceTime(35_000));

      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.checkRecoverability(30_000);
        })
      );

      expect(result.canRecover).toBe(true);
      expect(result.reason).toBe("stale_running");
      expect(result.staleDurationMs).toBeGreaterThanOrEqual(35_000);
    });

    it("should not recover Running workflow that is not stale", async () => {
      await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
        })
      );

      // Only advance time a little
      await Effect.runPromise(handle.advanceTime(5_000));

      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.checkRecoverability(30_000);
        })
      );

      expect(result.canRecover).toBe(false);
      expect(result.reason).toBe("not_recoverable");
    });

    it("should detect Paused workflow with pending resume", async () => {
      await runWithMachine(
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

      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.checkRecoverability(30_000);
        })
      );

      expect(result.canRecover).toBe(true);
      expect(result.reason).toBe("pending_resume");
    });

    it("should not recover terminal states", async () => {
      await runWithMachine(
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

      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.checkRecoverability(30_000);
        })
      );

      expect(result.canRecover).toBe(false);
      expect(result.reason).toBe("already_terminal");
    });
  });

  describe("step tracking", () => {
    it("should track completed steps", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.markStepCompleted("step1");
          yield* machine.markStepCompleted("step2");
          yield* machine.markStepCompleted("step1"); // Duplicate
          return yield* machine.getCompletedSteps();
        })
      );

      expect(result).toEqual(["step1", "step2"]);
    });
  });

  describe("recovery attempts", () => {
    it("should track recovery attempts", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          const a1 = yield* machine.incrementRecoveryAttempts();
          const a2 = yield* machine.incrementRecoveryAttempts();
          yield* machine.resetRecoveryAttempts();
          const a3 = yield* machine.incrementRecoveryAttempts();
          return { a1, a2, a3 };
        })
      );

      expect(result.a1).toBe(1);
      expect(result.a2).toBe(2);
      expect(result.a3).toBe(1);
    });
  });

  describe("cancellation", () => {
    it("should track cancellation flag", async () => {
      const result = await runWithMachine(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          const before = yield* machine.isCancelled();
          yield* machine.setCancelled("user request");
          const after = yield* machine.isCancelled();
          return { before, after };
        })
      );

      expect(result.before).toBe(false);
      expect(result.after).toBe(true);
    });
  });
});
```

---

## Definition of Done

- [ ] All status types defined with documentation
- [ ] All transition types defined including `Recover`
- [ ] Transition validation matrix implemented
- [ ] `WorkflowStateMachine` service complete
- [ ] All storage keys properly namespaced
- [ ] Recoverability check implemented
- [ ] Step tracking implemented
- [ ] Recovery attempt tracking implemented
- [ ] Cancellation flag tracking implemented
- [ ] All tests passing
- [ ] Package builds without errors

---

## Notes for Implementation

1. **Start with types.ts** - Other files depend on type definitions
2. **Test transition matrix first** - This is the core logic
3. **Use in-memory runtime from Phase 1** - Don't need real storage
4. **Time-sensitive tests** - Use handle.advanceTime() for stale detection
5. **Keep storage keys consistent** - Match existing v1 schema for migration
