# Phase 3: Recovery System - Infrastructure Failure Recovery

## Overview

This phase implements the `RecoveryManager` service - the component responsible for detecting and recovering from infrastructure failures. When a Durable Object is reset during a deployment or eviction, the recovery system detects stale workflows and resumes them safely.

**Duration**: ~2-3 hours
**Dependencies**: Phase 1 (adapters), Phase 2 (state machine)
**Risk Level**: Medium (core safety feature)

---

## Goals

1. Define recovery configuration with sensible defaults
2. Create `RecoveryManager` Effect service
3. Implement stale workflow detection
4. Implement recovery execution with attempt tracking
5. Integrate with state machine for transitions

---

## Background: The Recovery Problem

When Cloudflare deploys new code or evicts a Durable Object for resource management:

1. The DO instance is stopped mid-execution
2. Alarms are preserved but the running workflow is interrupted
3. On next wake (alarm or request), the workflow status is still "Running"
4. Without recovery, the workflow is orphaned forever

**Solution**: In the constructor (using `blockConcurrencyWhile`), detect stale "Running" or "Paused" workflows and schedule immediate recovery.

---

## File Structure

```
packages/workflow-v2/src/
├── recovery/
│   ├── index.ts               # Recovery exports
│   ├── config.ts              # Recovery configuration
│   └── manager.ts             # RecoveryManager service
└── test/
    └── recovery/
        ├── config.test.ts     # Configuration tests
        └── manager.test.ts    # Recovery manager tests
```

---

## Implementation Details

### 1. Recovery Configuration (`recovery/config.ts`)

```typescript
// packages/workflow-v2/src/recovery/config.ts

import { Data } from "effect";

/**
 * Configuration for the recovery system.
 */
export interface RecoveryConfig {
  /**
   * Time in milliseconds after which a "Running" status is considered stale.
   * If a workflow has been "Running" for longer than this, it was likely
   * interrupted by infrastructure and needs recovery.
   *
   * Default: 30 seconds (typical workflow step shouldn't take this long)
   */
  readonly staleThresholdMs: number;

  /**
   * Maximum number of recovery attempts before marking workflow as failed.
   * Prevents infinite recovery loops from bugs or persistent failures.
   *
   * Default: 3 attempts
   */
  readonly maxRecoveryAttempts: number;

  /**
   * Delay in milliseconds before scheduling recovery alarm.
   * Small delay ensures storage operations complete before alarm fires.
   *
   * Default: 100ms
   */
  readonly recoveryDelayMs: number;

  /**
   * Whether to emit recovery events for observability.
   * When true, emits workflow.recovery events.
   *
   * Default: true
   */
  readonly emitRecoveryEvents: boolean;
}

/**
 * Default recovery configuration.
 * These defaults are tuned for typical Durable Object usage.
 */
export const defaultRecoveryConfig: RecoveryConfig = {
  staleThresholdMs: 30_000,
  maxRecoveryAttempts: 3,
  recoveryDelayMs: 100,
  emitRecoveryEvents: true,
};

/**
 * Create a recovery config by merging with defaults.
 */
export function createRecoveryConfig(
  overrides?: Partial<RecoveryConfig>
): RecoveryConfig {
  return {
    ...defaultRecoveryConfig,
    ...overrides,
  };
}

/**
 * Validate recovery config values.
 */
export function validateRecoveryConfig(config: RecoveryConfig): void {
  if (config.staleThresholdMs < 1000) {
    throw new Error("staleThresholdMs must be at least 1000ms");
  }
  if (config.maxRecoveryAttempts < 1) {
    throw new Error("maxRecoveryAttempts must be at least 1");
  }
  if (config.recoveryDelayMs < 0) {
    throw new Error("recoveryDelayMs must be non-negative");
  }
}
```

### 2. Recovery Manager Service (`recovery/manager.ts`)

```typescript
// packages/workflow-v2/src/recovery/manager.ts

import { Context, Effect, Layer } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { SchedulerAdapter } from "../adapters/scheduler";
import { RuntimeAdapter } from "../adapters/runtime";
import {
  WorkflowStateMachine,
  type RecoverabilityInfo,
} from "../state/machine";
import { RecoveryError, StorageError, SchedulerError } from "../errors";
import {
  type RecoveryConfig,
  defaultRecoveryConfig,
} from "./config";

// =============================================================================
// Types
// =============================================================================

/**
 * Result of checking for recovery needs.
 */
export interface RecoveryCheckResult {
  /** Whether recovery was scheduled */
  readonly scheduled: boolean;
  /** Why recovery was or wasn't scheduled */
  readonly reason:
    | "stale_running"
    | "pending_resume"
    | "not_needed"
    | "already_terminal"
    | "no_workflow"
    | "max_attempts_exceeded";
  /** Duration the workflow has been stale (if applicable) */
  readonly staleDurationMs?: number;
  /** Current status before recovery */
  readonly currentStatus?: string;
  /** Recovery attempt number (if scheduled) */
  readonly attempt?: number;
}

/**
 * Result of executing recovery.
 */
export interface RecoveryExecuteResult {
  /** Whether recovery completed successfully */
  readonly success: boolean;
  /** Recovery attempt number */
  readonly attempt: number;
  /** Reason for success/failure */
  readonly reason:
    | "recovered"
    | "already_completed"
    | "max_attempts_exceeded"
    | "transition_failed";
  /** New status after recovery */
  readonly newStatus?: string;
}

/**
 * Recovery statistics for observability.
 */
export interface RecoveryStats {
  /** Current recovery attempt count */
  readonly attempts: number;
  /** Maximum allowed attempts */
  readonly maxAttempts: number;
  /** Timestamp of last recovery attempt */
  readonly lastAttemptAt?: number;
  /** Whether max attempts has been exceeded */
  readonly maxExceeded: boolean;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * RecoveryManager service interface.
 *
 * Handles detection and recovery of workflows interrupted by infrastructure.
 */
export interface RecoveryManagerService {
  /**
   * Check for stale workflows and schedule recovery if needed.
   *
   * This should be called in the runtime's initialization phase.
   * For Durable Objects, call in constructor with blockConcurrencyWhile.
   */
  readonly checkAndScheduleRecovery: () => Effect.Effect<
    RecoveryCheckResult,
    StorageError | SchedulerError
  >;

  /**
   * Execute recovery for a stale workflow.
   *
   * This should be called when:
   * 1. The alarm fires and status is still "Running"
   * 2. A recovery alarm was scheduled in checkAndScheduleRecovery
   */
  readonly executeRecovery: () => Effect.Effect<
    RecoveryExecuteResult,
    RecoveryError | StorageError
  >;

  /**
   * Get recovery statistics for observability.
   */
  readonly getStats: () => Effect.Effect<RecoveryStats, StorageError>;

  /**
   * Check if recovery is needed without scheduling.
   * Useful for status queries.
   */
  readonly checkRecoveryNeeded: () => Effect.Effect<
    RecoverabilityInfo,
    StorageError
  >;
}

/**
 * Effect service tag for RecoveryManager.
 */
export class RecoveryManager extends Context.Tag(
  "@durable-effect/RecoveryManager"
)<RecoveryManager, RecoveryManagerService>() {}

// =============================================================================
// Storage Keys
// =============================================================================

const KEYS = {
  lastRecoveryAt: "workflow:lastRecoveryAt",
} as const;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create the RecoveryManager service implementation.
 */
export const createRecoveryManager = (
  config: RecoveryConfig = defaultRecoveryConfig
) =>
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const scheduler = yield* SchedulerAdapter;
    const runtime = yield* RuntimeAdapter;
    const stateMachine = yield* WorkflowStateMachine;

    const service: RecoveryManagerService = {
      checkAndScheduleRecovery: () =>
        Effect.gen(function* () {
          // Check current recoverability
          const info = yield* stateMachine.checkRecoverability(
            config.staleThresholdMs
          );

          // No workflow or not recoverable
          if (!info.canRecover) {
            return {
              scheduled: false,
              reason: info.reason === "already_terminal"
                ? "already_terminal"
                : info.reason === "no_workflow"
                ? "no_workflow"
                : "not_needed",
              currentStatus: info.currentStatus,
            } satisfies RecoveryCheckResult;
          }

          // Check recovery attempt count
          const stats = yield* service.getStats();
          if (stats.maxExceeded) {
            return {
              scheduled: false,
              reason: "max_attempts_exceeded",
              currentStatus: info.currentStatus,
            } satisfies RecoveryCheckResult;
          }

          // Schedule recovery alarm
          const now = yield* runtime.now();
          const recoveryTime = now + config.recoveryDelayMs;
          yield* scheduler.schedule(recoveryTime);

          // Track when we scheduled recovery
          yield* storage.put(KEYS.lastRecoveryAt, now);

          return {
            scheduled: true,
            reason: info.reason === "stale_running"
              ? "stale_running"
              : "pending_resume",
            staleDurationMs: info.staleDurationMs,
            currentStatus: info.currentStatus,
            attempt: stats.attempts + 1,
          } satisfies RecoveryCheckResult;
        }),

      executeRecovery: () =>
        Effect.gen(function* () {
          // Get current state
          const status = yield* stateMachine.getStatus();

          // No workflow or already terminal
          if (!status) {
            return {
              success: false,
              attempt: 0,
              reason: "already_completed" as const,
            };
          }

          if (
            status._tag === "Completed" ||
            status._tag === "Failed" ||
            status._tag === "Cancelled"
          ) {
            return {
              success: false,
              attempt: 0,
              reason: "already_completed" as const,
              newStatus: status._tag,
            };
          }

          // Check recovery attempts
          const stats = yield* service.getStats();
          if (stats.maxExceeded) {
            // Mark workflow as failed due to max recovery attempts
            yield* stateMachine.applyTransition({
              _tag: "Fail",
              error: {
                message: `Workflow failed after ${stats.maxAttempts} recovery attempts`,
              },
              completedSteps: yield* stateMachine.getCompletedSteps(),
            });

            return yield* Effect.fail(
              new RecoveryError({
                reason: "max_attempts_exceeded",
                attempts: stats.attempts,
                maxAttempts: stats.maxAttempts,
              })
            );
          }

          // Increment recovery counter
          const attempt = yield* stateMachine.incrementRecoveryAttempts();

          // Apply recovery transition
          const transitionResult = yield* stateMachine
            .applyTransition({
              _tag: "Recover",
              reason: status._tag === "Running"
                ? "stale_detection"
                : "infrastructure_restart",
              attempt,
            })
            .pipe(
              Effect.map((newStatus) => ({
                success: true,
                attempt,
                reason: "recovered" as const,
                newStatus: newStatus._tag,
              })),
              Effect.catchTag("InvalidTransitionError", (err) =>
                Effect.succeed({
                  success: false,
                  attempt,
                  reason: "transition_failed" as const,
                })
              )
            );

          // If recovery succeeded, reset attempt counter
          if (transitionResult.success) {
            yield* stateMachine.resetRecoveryAttempts();
          }

          return transitionResult;
        }),

      getStats: () =>
        Effect.gen(function* () {
          const attempts = yield* storage
            .get<number>("workflow:recoveryAttempts")
            .pipe(Effect.map((a) => a ?? 0));

          const lastAttemptAt = yield* storage.get<number>(KEYS.lastRecoveryAt);

          return {
            attempts,
            maxAttempts: config.maxRecoveryAttempts,
            lastAttemptAt,
            maxExceeded: attempts >= config.maxRecoveryAttempts,
          };
        }),

      checkRecoveryNeeded: () =>
        stateMachine.checkRecoverability(config.staleThresholdMs),
    };

    return service;
  });

/**
 * Create a RecoveryManager layer with custom config.
 */
export const RecoveryManagerLayer = (
  config?: Partial<RecoveryConfig>
) =>
  Layer.effect(
    RecoveryManager,
    createRecoveryManager({
      ...defaultRecoveryConfig,
      ...config,
    })
  );

/**
 * RecoveryManager layer with default config.
 */
export const DefaultRecoveryManagerLayer = Layer.effect(
  RecoveryManager,
  createRecoveryManager()
);
```

### 3. Recovery Exports (`recovery/index.ts`)

```typescript
// packages/workflow-v2/src/recovery/index.ts

// Configuration
export {
  type RecoveryConfig,
  defaultRecoveryConfig,
  createRecoveryConfig,
  validateRecoveryConfig,
} from "./config";

// Manager service
export {
  RecoveryManager,
  RecoveryManagerLayer,
  DefaultRecoveryManagerLayer,
  createRecoveryManager,
  type RecoveryManagerService,
  type RecoveryCheckResult,
  type RecoveryExecuteResult,
  type RecoveryStats,
} from "./manager";
```

### 4. Update Main Index

```typescript
// packages/workflow-v2/src/index.ts

// ... existing exports ...

// Recovery
export {
  // Config
  type RecoveryConfig,
  defaultRecoveryConfig,
  createRecoveryConfig,
  // Manager
  RecoveryManager,
  RecoveryManagerLayer,
  DefaultRecoveryManagerLayer,
  type RecoveryManagerService,
  type RecoveryCheckResult,
  type RecoveryExecuteResult,
  type RecoveryStats,
} from "./recovery";
```

---

## Testing Strategy

### Test File: `test/recovery/config.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import {
  defaultRecoveryConfig,
  createRecoveryConfig,
  validateRecoveryConfig,
} from "../../src";

describe("RecoveryConfig", () => {
  describe("defaultRecoveryConfig", () => {
    it("should have sensible defaults", () => {
      expect(defaultRecoveryConfig.staleThresholdMs).toBe(30_000);
      expect(defaultRecoveryConfig.maxRecoveryAttempts).toBe(3);
      expect(defaultRecoveryConfig.recoveryDelayMs).toBe(100);
      expect(defaultRecoveryConfig.emitRecoveryEvents).toBe(true);
    });
  });

  describe("createRecoveryConfig", () => {
    it("should use defaults when no overrides", () => {
      const config = createRecoveryConfig();
      expect(config).toEqual(defaultRecoveryConfig);
    });

    it("should merge overrides with defaults", () => {
      const config = createRecoveryConfig({
        maxRecoveryAttempts: 5,
      });
      expect(config.maxRecoveryAttempts).toBe(5);
      expect(config.staleThresholdMs).toBe(30_000); // unchanged
    });
  });

  describe("validateRecoveryConfig", () => {
    it("should accept valid config", () => {
      expect(() => validateRecoveryConfig(defaultRecoveryConfig)).not.toThrow();
    });

    it("should reject staleThresholdMs < 1000", () => {
      expect(() =>
        validateRecoveryConfig({ ...defaultRecoveryConfig, staleThresholdMs: 500 })
      ).toThrow("staleThresholdMs must be at least 1000ms");
    });

    it("should reject maxRecoveryAttempts < 1", () => {
      expect(() =>
        validateRecoveryConfig({ ...defaultRecoveryConfig, maxRecoveryAttempts: 0 })
      ).toThrow("maxRecoveryAttempts must be at least 1");
    });

    it("should reject negative recoveryDelayMs", () => {
      expect(() =>
        validateRecoveryConfig({ ...defaultRecoveryConfig, recoveryDelayMs: -1 })
      ).toThrow("recoveryDelayMs must be non-negative");
    });
  });
});
```

### Test File: `test/recovery/manager.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  WorkflowStateMachine,
  WorkflowStateMachineLayer,
  RecoveryManager,
  RecoveryManagerLayer,
  RecoveryError,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("RecoveryManager", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;
  const STALE_THRESHOLD = 30_000;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000 })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const createLayers = (recoveryConfig?: { maxRecoveryAttempts?: number }) =>
    RecoveryManagerLayer(recoveryConfig).pipe(
      Layer.provideMerge(WorkflowStateMachineLayer),
      Layer.provide(runtimeLayer)
    );

  const runWithRecovery = <A, E>(
    effect: Effect.Effect<A, E, RecoveryManager | WorkflowStateMachine>,
    recoveryConfig?: { maxRecoveryAttempts?: number }
  ) => effect.pipe(Effect.provide(createLayers(recoveryConfig)), Effect.runPromise);

  describe("checkAndScheduleRecovery", () => {
    it("should return no_workflow when no workflow exists", async () => {
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe("no_workflow");
    });

    it("should return not_needed for Pending workflow", async () => {
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          const recovery = yield* RecoveryManager;

          yield* machine.initialize("test", {});
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe("not_needed");
    });

    it("should return not_needed for Running workflow that is not stale", async () => {
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          const recovery = yield* RecoveryManager;

          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });

          // Only advance 5 seconds (not stale)
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      // Advance time a little but not past threshold
      await Effect.runPromise(handle.advanceTime(5000));

      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe("not_needed");
    });

    it("should schedule recovery for stale Running workflow", async () => {
      // Start workflow
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
        })
      );

      // Advance time past stale threshold
      await Effect.runPromise(handle.advanceTime(35_000));

      // Check recovery
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(result.scheduled).toBe(true);
      expect(result.reason).toBe("stale_running");
      expect(result.staleDurationMs).toBeGreaterThanOrEqual(35_000);
      expect(result.attempt).toBe(1);

      // Verify alarm was scheduled
      const schedulerState = await Effect.runPromise(handle.getSchedulerState());
      expect(schedulerState.scheduledTime).toBeDefined();
    });

    it("should schedule recovery for Paused workflow with pending resume", async () => {
      // Start and pause workflow
      await runWithRecovery(
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

      // Check recovery
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(result.scheduled).toBe(true);
      expect(result.reason).toBe("pending_resume");
    });

    it("should return already_terminal for completed workflow", async () => {
      // Complete workflow
      await runWithRecovery(
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

      // Check recovery
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe("already_terminal");
    });

    it("should respect maxRecoveryAttempts", async () => {
      // Start workflow and exhaust recovery attempts
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          // Simulate 3 failed recovery attempts
          yield* machine.incrementRecoveryAttempts();
          yield* machine.incrementRecoveryAttempts();
          yield* machine.incrementRecoveryAttempts();
        })
      );

      // Advance time past stale threshold
      await Effect.runPromise(handle.advanceTime(35_000));

      // Check recovery - should be blocked by max attempts
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe("max_attempts_exceeded");
    });
  });

  describe("executeRecovery", () => {
    it("should recover stale Running workflow", async () => {
      // Start workflow
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
        })
      );

      // Simulate infrastructure restart - workflow is "Running" but actually interrupted
      // Advance time to make it stale
      await Effect.runPromise(handle.advanceTime(35_000));

      // Execute recovery
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.executeRecovery();
        })
      );

      expect(result.success).toBe(true);
      expect(result.reason).toBe("recovered");
      expect(result.newStatus).toBe("Running");
      expect(result.attempt).toBe(1);

      // Verify recovery attempts reset
      const stats = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.getStats();
        })
      );

      expect(stats.attempts).toBe(0); // Reset after success
    });

    it("should fail after max attempts exceeded", async () => {
      // Start workflow and exhaust recovery attempts
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
          yield* machine.applyTransition({ _tag: "Start", input: {} });
          yield* machine.incrementRecoveryAttempts();
          yield* machine.incrementRecoveryAttempts();
          yield* machine.incrementRecoveryAttempts();
        })
      );

      // Advance time
      await Effect.runPromise(handle.advanceTime(35_000));

      // Try to execute recovery - should fail
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.executeRecovery().pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RecoveryError);
        expect((result.left as RecoveryError).reason).toBe("max_attempts_exceeded");
      }

      // Verify workflow was marked as failed
      const status = await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.getStatus();
        })
      );

      expect(status?._tag).toBe("Failed");
    });

    it("should return already_completed for terminal workflows", async () => {
      // Complete workflow
      await runWithRecovery(
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

      // Try recovery
      const result = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.executeRecovery();
        })
      );

      expect(result.success).toBe(false);
      expect(result.reason).toBe("already_completed");
    });
  });

  describe("getStats", () => {
    it("should track recovery attempts", async () => {
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", {});
        })
      );

      const stats1 = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.getStats();
        })
      );

      expect(stats1.attempts).toBe(0);
      expect(stats1.maxAttempts).toBe(3);
      expect(stats1.maxExceeded).toBe(false);

      // Simulate a recovery attempt
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.incrementRecoveryAttempts();
        })
      );

      const stats2 = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.getStats();
        })
      );

      expect(stats2.attempts).toBe(1);
      expect(stats2.maxExceeded).toBe(false);
    });

    it("should use custom maxRecoveryAttempts", async () => {
      const stats = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.getStats();
        }),
        { maxRecoveryAttempts: 5 }
      );

      expect(stats.maxAttempts).toBe(5);
    });
  });

  describe("integration: full recovery flow", () => {
    it("should handle complete recovery cycle", async () => {
      // 1. Start a workflow
      await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          yield* machine.initialize("test", { data: 42 });
          yield* machine.applyTransition({ _tag: "Start", input: { data: 42 } });
        })
      );

      // 2. Simulate infrastructure restart (time passes)
      await Effect.runPromise(handle.advanceTime(35_000));

      // 3. Constructor runs - check and schedule recovery
      const checkResult = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.checkAndScheduleRecovery();
        })
      );

      expect(checkResult.scheduled).toBe(true);
      expect(checkResult.reason).toBe("stale_running");

      // 4. Alarm fires - execute recovery
      await Effect.runPromise(handle.advanceTime(100)); // Past recovery delay

      const executeResult = await runWithRecovery(
        Effect.gen(function* () {
          const recovery = yield* RecoveryManager;
          return yield* recovery.executeRecovery();
        })
      );

      expect(executeResult.success).toBe(true);
      expect(executeResult.newStatus).toBe("Running");

      // 5. Verify workflow can continue
      const state = await runWithRecovery(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.getState();
        })
      );

      expect(state?.status._tag).toBe("Running");
      expect(state?.recoveryAttempts).toBe(0); // Reset after success
    });
  });
});
```

---

## Definition of Done

- [ ] RecoveryConfig type and defaults defined
- [ ] Config validation implemented
- [ ] RecoveryManager service interface complete
- [ ] checkAndScheduleRecovery detects stale workflows
- [ ] checkAndScheduleRecovery schedules recovery alarms
- [ ] executeRecovery transitions workflow to Running
- [ ] Recovery attempt tracking works correctly
- [ ] Max attempts exceeded marks workflow as Failed
- [ ] Recovery stats are queryable
- [ ] All tests passing
- [ ] Package builds without errors

---

## Notes for Implementation

1. **Start with config.ts** - Keep configuration separate and validated
2. **Integrate with state machine** - Don't duplicate state logic
3. **Time-sensitive tests** - Use handle.advanceTime() extensively
4. **Recovery alarm timing** - Small delay (100ms) ensures atomicity
5. **Max attempts is a safety net** - Prevents infinite loops from bugs
6. **Resetting attempts after success** - Ensures fresh start for next interruption

---

## Recovery Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Infrastructure Reset Flow                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  [Workflow Running]  ──(infrastructure reset)──►  [DO Evicted]         │
│         │                                               │               │
│         │                                               │               │
│         ▼                                               ▼               │
│  Status: "Running"                               [New DO Instance]      │
│  runningAt: T1                                          │               │
│                                                         │               │
│                                                         ▼               │
│                                              ┌──────────────────────┐   │
│                                              │     Constructor      │   │
│                                              │                      │   │
│                                              │  blockConcurrency    │   │
│                                              │  While(() => {       │   │
│                                              │    checkAndSchedule  │   │
│                                              │    Recovery()        │   │
│                                              │  })                  │   │
│                                              └──────────┬───────────┘   │
│                                                         │               │
│                                                         ▼               │
│                                              ┌──────────────────────┐   │
│                                              │ checkRecoverability  │   │
│                                              │                      │   │
│                                              │ staleDuration =      │   │
│                                              │   now - runningAt    │   │
│                                              │                      │   │
│                                              │ if staleDuration >   │   │
│                                              │    threshold:        │   │
│                                              │   schedule alarm     │   │
│                                              └──────────┬───────────┘   │
│                                                         │               │
│                                                         │ (alarm fires) │
│                                                         ▼               │
│                                              ┌──────────────────────┐   │
│                                              │  executeRecovery()   │   │
│                                              │                      │   │
│                                              │  1. Check attempts   │   │
│                                              │  2. Increment count  │   │
│                                              │  3. Apply Recover    │   │
│                                              │     transition       │   │
│                                              │  4. Reset counter    │   │
│                                              │     on success       │   │
│                                              └──────────┬───────────┘   │
│                                                         │               │
│                                                         ▼               │
│                                              [Workflow Continues]       │
│                                              Status: "Running"          │
│                                              runningAt: T2 (now)        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```
