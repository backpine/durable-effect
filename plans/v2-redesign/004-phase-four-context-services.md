# Phase 4: Context Services - Workflow & Step State Access

## Overview

This phase implements the context services that workflow primitives use to access and modify state. `WorkflowContext` provides workflow-level state (input, completed steps, pause points), while `StepContext` provides step-level state (result caching, attempt tracking).

**Duration**: ~2-3 hours
**Dependencies**: Phase 1 (adapters), Phase 2 (state machine)
**Risk Level**: Low

---

## Goals

1. Create `WorkflowContext` service for workflow-level state
2. Create `StepContext` service for step-level state
3. Create `WorkflowScope` compile-time guard against workflow nesting
4. Create `StepScope` guard to prevent `Workflow.*` primitives inside steps
5. Integrate with StorageAdapter abstraction

---

## Background: Context Services Purpose

Workflow primitives (`step()`, `sleep()`, `retry()`) need access to:

1. **Workflow-level state**: workflowId, input, completed steps, pause tracking
2. **Step-level state**: step name, attempt number, cached results, metadata

These services provide a clean Effect-based API while abstracting storage details.

---

## File Structure

```
packages/workflow/src/
├── context/
│   ├── index.ts               # Context exports
│   ├── workflow-context.ts    # WorkflowContext service
│   ├── step-context.ts        # StepContext service
│   ├── workflow-scope.ts      # Workflow nesting guard
│   └── step-scope.ts          # Prevents Workflow.* inside steps
└── test/
    └── context/
        ├── workflow-context.test.ts
        ├── step-context.test.ts
        ├── workflow-scope.test.ts
        └── step-scope.test.ts
```

---

## Implementation Details

### 1. Workflow Context (`context/workflow-context.ts`)

```typescript
// packages/workflow/src/context/workflow-context.ts

import { Context, Effect, Layer } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { RuntimeAdapter } from "../adapters/runtime";
import { StorageError } from "../errors";

// =============================================================================
// Storage Keys
// =============================================================================

const KEYS = {
  workflowId: "workflow:id",
  workflowName: "workflow:name",
  input: "workflow:input",
  executionId: "workflow:executionId",
  completedSteps: "workflow:completedSteps",
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
  readonly input: <T>() => Effect.Effect<T, StorageError>;

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
    stepName: string
  ) => Effect.Effect<boolean, StorageError>;

  /**
   * Mark a step as completed.
   */
  readonly markStepCompleted: (
    stepName: string
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
    index: number
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
    time: number
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
  readonly getMeta: <T>(key: string) => Effect.Effect<T | undefined, StorageError>;

  /**
   * Set workflow-level metadata.
   */
  readonly setMeta: <T>(
    key: string,
    value: T
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
  "@durable-effect/WorkflowContext"
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

    input: <T>() => storage.get<T>(KEYS.input).pipe(Effect.map((i) => i as T)),

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
          (yield* storage.get<number>(KEYS.completedPauseIndex)) ?? 0;
        const next = current + 1;
        yield* storage.put(KEYS.completedPauseIndex, next);
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
  createWorkflowContext
);
```

### 2. Step Context (`context/step-context.ts`)

```typescript
// packages/workflow/src/context/step-context.ts

import { Context, Effect, Layer, Ref } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { RuntimeAdapter } from "../adapters/runtime";
import { StorageError } from "../errors";

// =============================================================================
// Storage Keys
// =============================================================================

const stepKey = (stepName: string, suffix: string) =>
  `step:${stepName}:${suffix}`;

const KEYS = {
  attempt: (stepName: string) => stepKey(stepName, "attempt"),
  startedAt: (stepName: string) => stepKey(stepName, "startedAt"),
  result: (stepName: string) => stepKey(stepName, "result"),
  meta: (stepName: string, key: string) => stepKey(stepName, `meta:${key}`),
} as const;

// =============================================================================
// Types
// =============================================================================

/**
 * Step execution metadata stored with results.
 */
export interface StepResultMeta {
  readonly completedAt: number;
  readonly attempt: number;
  readonly durationMs: number;
}

/**
 * Cached step result with metadata.
 */
export interface CachedStepResult<T> {
  readonly value: T;
  readonly meta: StepResultMeta;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * StepContext service interface.
 *
 * Provides step-level state access for the step primitive.
 * Each step has its own isolated state in storage.
 */
export interface StepContextService {
  /**
   * Get the current step name.
   */
  readonly stepName: string;

  /**
   * Get current attempt number (1-indexed).
   */
  readonly attempt: Effect.Effect<number, StorageError>;

  /**
   * Increment and get next attempt number.
   */
  readonly incrementAttempt: () => Effect.Effect<number, StorageError>;

  /**
   * Reset attempt counter (after success).
   */
  readonly resetAttempt: () => Effect.Effect<void, StorageError>;

  /**
   * Get step start time.
   */
  readonly startedAt: Effect.Effect<number | undefined, StorageError>;

  /**
   * Set step start time.
   */
  readonly setStartedAt: (time: number) => Effect.Effect<void, StorageError>;

  /**
   * Get cached result (if exists).
   */
  readonly getResult: <T>() => Effect.Effect<
    CachedStepResult<T> | undefined,
    StorageError
  >;

  /**
   * Cache step result.
   */
  readonly setResult: <T>(
    value: T,
    meta: StepResultMeta
  ) => Effect.Effect<void, StorageError>;

  /**
   * Check if step has cached result.
   */
  readonly hasResult: Effect.Effect<boolean, StorageError>;

  /**
   * Get step-level metadata.
   */
  readonly getMeta: <T>(
    key: string
  ) => Effect.Effect<T | undefined, StorageError>;

  /**
   * Set step-level metadata.
   */
  readonly setMeta: <T>(
    key: string,
    value: T
  ) => Effect.Effect<void, StorageError>;

  /**
   * Clear all step state (for cleanup).
   */
  readonly clear: () => Effect.Effect<void, StorageError>;

  /**
   * Calculate deadline time given a timeout duration.
   */
  readonly calculateDeadline: (
    timeoutMs: number
  ) => Effect.Effect<number, StorageError>;
}

/**
 * Effect service tag for StepContext.
 */
export class StepContext extends Context.Tag("@durable-effect/StepContext")<
  StepContext,
  StepContextService
>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a StepContext service for a specific step.
 */
export const createStepContext = (stepName: string) =>
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    const service: StepContextService = {
      stepName,

      attempt: storage
        .get<number>(KEYS.attempt(stepName))
        .pipe(Effect.map((a) => a ?? 1)),

      incrementAttempt: () =>
        Effect.gen(function* () {
          const current =
            (yield* storage.get<number>(KEYS.attempt(stepName))) ?? 0;
          const next = current + 1;
          yield* storage.put(KEYS.attempt(stepName), next);
          return next;
        }),

      resetAttempt: () => storage.put(KEYS.attempt(stepName), 1),

      startedAt: storage.get<number>(KEYS.startedAt(stepName)),

      setStartedAt: (time) => storage.put(KEYS.startedAt(stepName), time),

      getResult: <T>() =>
        storage.get<CachedStepResult<T>>(KEYS.result(stepName)),

      setResult: <T>(value: T, meta: StepResultMeta) =>
        storage.put(KEYS.result(stepName), { value, meta }),

      hasResult: storage
        .get(KEYS.result(stepName))
        .pipe(Effect.map((r) => r !== undefined)),

      getMeta: <T>(key: string) =>
        storage.get<T>(KEYS.meta(stepName, key)),

      setMeta: <T>(key: string, value: T) =>
        storage.put(KEYS.meta(stepName, key), value),

      clear: () =>
        Effect.gen(function* () {
          yield* storage.delete(KEYS.attempt(stepName));
          yield* storage.delete(KEYS.startedAt(stepName));
          yield* storage.delete(KEYS.result(stepName));
          // Note: We don't delete meta here - metadata may need to persist
        }),

      calculateDeadline: (timeoutMs) =>
        Effect.gen(function* () {
          const started = yield* storage.get<number>(KEYS.startedAt(stepName));
          if (started === undefined) {
            const now = yield* runtime.now();
            return now + timeoutMs;
          }
          return started + timeoutMs;
        }),
    };

    return service;
  });

/**
 * Create a StepContext layer for a specific step.
 */
export const StepContextLayer = (stepName: string) =>
  Layer.effect(StepContext, createStepContext(stepName));
```

### 3. Workflow Scope Guard (`context/workflow-scope.ts`)

```typescript
// packages/workflow/src/context/workflow-scope.ts

import { Context, Effect, Layer } from "effect";

/**
 * WorkflowScope is a compile-time guard that prevents nesting workflows.
 *
 * When a workflow is executing, WorkflowScope is present in the context.
 * Attempting to start another workflow from within one will fail at
 * compile time because the inner workflow would require WorkflowScope
 * to NOT be present.
 */
export interface WorkflowScopeService {
  /**
   * Marker that workflow scope is active.
   * The actual value doesn't matter - presence in context is what matters.
   */
  readonly _marker: "workflow-scope-active";
}

/**
 * Effect service tag for WorkflowScope.
 */
export class WorkflowScope extends Context.Tag("@durable-effect/WorkflowScope")<
  WorkflowScope,
  WorkflowScopeService
>() {}

/**
 * Layer that provides WorkflowScope.
 */
export const WorkflowScopeLayer = Layer.succeed(WorkflowScope, {
  _marker: "workflow-scope-active",
});

/**
 * Check if currently inside a workflow scope.
 * Returns Effect that succeeds with true if in scope, false otherwise.
 */
export const isInWorkflowScope: Effect.Effect<boolean> = Effect.map(
  Effect.serviceOption(WorkflowScope),
  (option) => option._tag === "Some"
);

/**
 * Require workflow scope to be present.
 * Fails with descriptive error if not in a workflow.
 */
export const requireWorkflowScope: Effect.Effect<void, WorkflowScopeError> =
  Effect.flatMap(isInWorkflowScope, (inScope) =>
    inScope
      ? Effect.void
      : Effect.fail(
          new WorkflowScopeError({
            message:
              "Workflow primitives can only be used inside a workflow. " +
              "Did you forget to use Workflow.make()?",
          })
        )
  );

/**
 * Error when workflow scope is required but not present.
 */
export class WorkflowScopeError extends Error {
  readonly _tag = "WorkflowScopeError";

  constructor(opts: { message: string }) {
    super(opts.message);
    this.name = "WorkflowScopeError";
  }
}
```

### 4. Step Scope Guard (`context/step-scope.ts`)

```typescript
// packages/workflow/src/context/step-scope.ts

import { Context, Effect, Layer } from "effect";

/**
 * StepScope is a compile-time and runtime guard that prevents misuse of
 * workflow-level primitives inside steps.
 *
 * IMPORTANT DISTINCTION:
 * - Effect.sleep IS ALLOWED inside steps - it's a standard Effect operation
 *   that will simply delay execution. The step will still complete and its
 *   result will be cached as expected.
 * - Workflow.sleep IS NOT ALLOWED inside steps - it's a workflow-level
 *   primitive that creates durable pause points. Using it inside a step
 *   would create incorrect behavior because the pause point would be nested
 *   inside a step that may be replayed.
 *
 * When a step is executing, StepScope is present in the context.
 * Workflow-level primitives (sleep, step) check for StepScope and fail
 * if present.
 */
export interface StepScopeService {
  /**
   * Marker that step scope is active.
   * The actual value doesn't matter - presence in context is what matters.
   */
  readonly _marker: "step-scope-active";
  
  /**
   * The name of the currently executing step.
   */
  readonly stepName: string;
}

/**
 * Effect service tag for StepScope.
 */
export class StepScope extends Context.Tag("@durable-effect/StepScope")<
  StepScope,
  StepScopeService
>() {}

/**
 * Create a StepScope layer for a specific step.
 */
export const StepScopeLayer = (stepName: string) =>
  Layer.succeed(StepScope, {
    _marker: "step-scope-active",
    stepName,
  });

/**
 * Check if currently inside a step scope.
 * Returns Effect that succeeds with true if in scope, false otherwise.
 */
export const isInStepScope: Effect.Effect<boolean> = Effect.map(
  Effect.serviceOption(StepScope),
  (option) => option._tag === "Some"
);

/**
 * Require that we are NOT inside a step scope.
 * Used by workflow-level primitives to prevent nesting.
 * Fails with descriptive error if inside a step.
 */
export const rejectInsideStep: Effect.Effect<void, StepScopeError> =
  Effect.flatMap(Effect.serviceOption(StepScope), (option) =>
    option._tag === "None"
      ? Effect.void
      : Effect.fail(
          new StepScopeError({
            operation: "Workflow primitive",
            stepName: option.value.stepName,
          })
        )
  );

/**
 * Create a guard for a specific workflow operation.
 * Returns an effect that fails if called inside a step.
 */
export const guardWorkflowOperation = (operationName: string): Effect.Effect<void, StepScopeError> =>
  Effect.flatMap(Effect.serviceOption(StepScope), (option) =>
    option._tag === "None"
      ? Effect.void
      : Effect.fail(
          new StepScopeError({
            operation: operationName,
            stepName: option.value.stepName,
          })
        )
  );

/**
 * Error when a workflow-level primitive is used inside a step.
 */
export class StepScopeError extends Error {
  readonly _tag = "StepScopeError";
  readonly operation: string;
  readonly stepName: string;

  constructor(opts: { operation: string; stepName: string }) {
    super(
      `${opts.operation} cannot be used inside Workflow.step("${opts.stepName}"). ` +
        "Workflow-level primitives like Workflow.sleep() and Workflow.step() " +
        "must be used at the workflow level, not inside other steps. " +
        "Note: Effect.sleep() is allowed inside steps for regular delays."
    );
    this.name = "StepScopeError";
    this.operation = opts.operation;
    this.stepName = opts.stepName;
  }
}
```

**Design Rationale:**

The key insight is distinguishing between:

1. **Effect.sleep** - Standard Effect operation, perfectly fine inside steps:
   ```typescript
   Workflow.step("process", () =>
     Effect.gen(function* () {
       yield* Effect.sleep("100 millis"); // OK - just delays execution
       return yield* doSomeWork();
     })
   );
   ```

2. **Workflow.sleep** - Durable workflow primitive, NOT allowed inside steps:
   ```typescript
   Workflow.step("process", () =>
     Effect.gen(function* () {
       yield* Workflow.sleep("1 hour"); // ERROR - creates nested pause point
       return yield* doSomeWork();
     })
   );
   ```

The `StepScope` guard is applied when executing a step, and `Workflow.sleep()` (and other workflow primitives) check for this scope and fail with a helpful error if present.

### 5. Context Exports (`context/index.ts`)

```typescript
// packages/workflow/src/context/index.ts

// Workflow Context
export {
  WorkflowContext,
  WorkflowContextLayer,
  createWorkflowContext,
  type WorkflowContextService,
} from "./workflow-context";

// Step Context
export {
  StepContext,
  StepContextLayer,
  createStepContext,
  type StepContextService,
  type StepResultMeta,
  type CachedStepResult,
} from "./step-context";

// Workflow Scope
export {
  WorkflowScope,
  WorkflowScopeLayer,
  isInWorkflowScope,
  requireWorkflowScope,
  WorkflowScopeError,
} from "./workflow-scope";

// Step Scope (prevents Workflow.* inside steps)
export {
  StepScope,
  StepScopeLayer,
  isInStepScope,
  rejectInsideStep,
  guardWorkflowOperation,
  StepScopeError,
} from "./step-scope";
```

### 6. Update Main Index

```typescript
// packages/workflow/src/index.ts

// ... existing exports ...

// Context
export {
  // Workflow Context
  WorkflowContext,
  WorkflowContextLayer,
  type WorkflowContextService,
  // Step Context
  StepContext,
  StepContextLayer,
  type StepContextService,
  type StepResultMeta,
  type CachedStepResult,
  // Workflow Scope
  WorkflowScope,
  WorkflowScopeLayer,
  isInWorkflowScope,
  requireWorkflowScope,
  WorkflowScopeError,
  // Step Scope (prevents Workflow.* inside steps)
  StepScope,
  StepScopeLayer,
  isInStepScope,
  rejectInsideStep,
  guardWorkflowOperation,
  StepScopeError,
} from "./context";
```

---

## Testing Strategy

### Test File: `test/context/workflow-context.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  WorkflowContext,
  WorkflowContextLayer,
  StorageAdapter,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("WorkflowContext", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000, instanceId: "wf-123" })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const runWithContext = <A, E>(
    effect: Effect.Effect<A, E, WorkflowContext | StorageAdapter>
  ) =>
    effect.pipe(
      Effect.provide(WorkflowContextLayer),
      Effect.provide(runtimeLayer),
      Effect.runPromise
    );

  describe("identity", () => {
    it("should return workflow ID from runtime", async () => {
      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.workflowId;
        })
      );

      expect(result).toBe("wf-123");
    });

    it("should return workflow name from storage", async () => {
      // Setup: store workflow name
      await runWithContext(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:name", "myWorkflow");
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.workflowName;
        })
      );

      expect(result).toBe("myWorkflow");
    });

    it("should return input from storage", async () => {
      // Setup: store input
      await runWithContext(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:input", { data: 42 });
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.input<{ data: number }>();
        })
      );

      expect(result).toEqual({ data: 42 });
    });
  });

  describe("step tracking", () => {
    it("should track completed steps", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          yield* ctx.markStepCompleted("step1");
          yield* ctx.markStepCompleted("step2");
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.completedSteps;
        })
      );

      expect(result).toEqual(["step1", "step2"]);
    });

    it("should not duplicate completed steps", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          yield* ctx.markStepCompleted("step1");
          yield* ctx.markStepCompleted("step1");
          yield* ctx.markStepCompleted("step1");
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.completedSteps;
        })
      );

      expect(result).toEqual(["step1"]);
    });

    it("should check if step is completed", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          yield* ctx.markStepCompleted("step1");
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return {
            step1: yield* ctx.hasCompletedStep("step1"),
            step2: yield* ctx.hasCompletedStep("step2"),
          };
        })
      );

      expect(result.step1).toBe(true);
      expect(result.step2).toBe(false);
    });
  });

  describe("pause point tracking", () => {
    it("should track pause index", async () => {
      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          const i1 = yield* ctx.incrementPauseIndex();
          const i2 = yield* ctx.incrementPauseIndex();
          const i3 = yield* ctx.incrementPauseIndex();
          return { i1, i2, i3 };
        })
      );

      expect(result).toEqual({ i1: 1, i2: 2, i3: 3 });
    });

    it("should determine if pause should execute", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          yield* ctx.incrementPauseIndex();
          yield* ctx.incrementPauseIndex();
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return {
            p1: yield* ctx.shouldExecutePause(1),
            p2: yield* ctx.shouldExecutePause(2),
            p3: yield* ctx.shouldExecutePause(3),
          };
        })
      );

      expect(result.p1).toBe(false); // Already completed
      expect(result.p2).toBe(false); // Already completed
      expect(result.p3).toBe(true); // Should execute
    });
  });

  describe("metadata", () => {
    it("should store and retrieve metadata", async () => {
      await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          yield* ctx.setMeta("customKey", { nested: { value: 42 } });
        })
      );

      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.getMeta<{ nested: { value: number } }>("customKey");
        })
      );

      expect(result).toEqual({ nested: { value: 42 } });
    });
  });

  describe("timing", () => {
    it("should return current time from runtime", async () => {
      const result = await runWithContext(
        Effect.gen(function* () {
          const ctx = yield* WorkflowContext;
          return yield* ctx.now;
        })
      );

      expect(result).toBe(1000);
    });
  });
});
```

### Test File: `test/context/step-context.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  createInMemoryRuntime,
  StepContext,
  StepContextLayer,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("StepContext", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000 })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const runWithStep = <A, E>(
    stepName: string,
    effect: Effect.Effect<A, E, StepContext>
  ) =>
    effect.pipe(
      Effect.provide(StepContextLayer(stepName)),
      Effect.provide(runtimeLayer),
      Effect.runPromise
    );

  describe("step name", () => {
    it("should return the step name", async () => {
      const result = await runWithStep(
        "fetchData",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return ctx.stepName;
        })
      );

      expect(result).toBe("fetchData");
    });
  });

  describe("attempt tracking", () => {
    it("should start at attempt 1", async () => {
      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.attempt;
        })
      );

      expect(result).toBe(1);
    });

    it("should increment attempts", async () => {
      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          const a1 = yield* ctx.incrementAttempt();
          const a2 = yield* ctx.incrementAttempt();
          const a3 = yield* ctx.incrementAttempt();
          return { a1, a2, a3 };
        })
      );

      expect(result).toEqual({ a1: 1, a2: 2, a3: 3 });
    });

    it("should reset attempts", async () => {
      await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.incrementAttempt();
          yield* ctx.incrementAttempt();
          yield* ctx.resetAttempt();
        })
      );

      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.attempt;
        })
      );

      expect(result).toBe(1);
    });
  });

  describe("result caching", () => {
    it("should cache and retrieve results", async () => {
      await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.setResult({ data: "result" }, {
            completedAt: 1500,
            attempt: 1,
            durationMs: 500,
          });
        })
      );

      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.getResult<{ data: string }>();
        })
      );

      expect(result).toEqual({
        value: { data: "result" },
        meta: {
          completedAt: 1500,
          attempt: 1,
          durationMs: 500,
        },
      });
    });

    it("should return undefined for missing results", async () => {
      const result = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.getResult();
        })
      );

      expect(result).toBeUndefined();
    });

    it("should check if result exists", async () => {
      const before = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.hasResult;
        })
      );

      await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.setResult("value", {
            completedAt: 1500,
            attempt: 1,
            durationMs: 100,
          });
        })
      );

      const after = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.hasResult;
        })
      );

      expect(before).toBe(false);
      expect(after).toBe(true);
    });
  });

  describe("deadline calculation", () => {
    it("should calculate deadline from started time", async () => {
      await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.setStartedAt(1000);
        })
      );

      const deadline = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.calculateDeadline(5000);
        })
      );

      expect(deadline).toBe(6000); // 1000 + 5000
    });

    it("should calculate deadline from now if not started", async () => {
      const deadline = await runWithStep(
        "myStep",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.calculateDeadline(5000);
        })
      );

      expect(deadline).toBe(6000); // 1000 (initialTime) + 5000
    });
  });

  describe("step isolation", () => {
    it("should isolate state between steps", async () => {
      // Set result for step1
      await runWithStep(
        "step1",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          yield* ctx.setResult("step1-result", {
            completedAt: 1000,
            attempt: 1,
            durationMs: 100,
          });
        })
      );

      // step2 should have no result
      const step2Result = await runWithStep(
        "step2",
        Effect.gen(function* () {
          const ctx = yield* StepContext;
          return yield* ctx.getResult();
        })
      );

      expect(step2Result).toBeUndefined();
    });
  });
});
```

### Test File: `test/context/workflow-scope.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  WorkflowScope,
  WorkflowScopeLayer,
  isInWorkflowScope,
  requireWorkflowScope,
  WorkflowScopeError,
} from "../../src";

describe("WorkflowScope", () => {
  describe("isInWorkflowScope", () => {
    it("should return false outside workflow", async () => {
      const result = await Effect.runPromise(isInWorkflowScope);
      expect(result).toBe(false);
    });

    it("should return true inside workflow", async () => {
      const result = await Effect.runPromise(
        isInWorkflowScope.pipe(Effect.provide(WorkflowScopeLayer))
      );
      expect(result).toBe(true);
    });
  });

  describe("requireWorkflowScope", () => {
    it("should fail outside workflow", async () => {
      const result = await Effect.runPromise(
        requireWorkflowScope.pipe(Effect.either)
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(WorkflowScopeError);
      }
    });

    it("should succeed inside workflow", async () => {
      const result = await Effect.runPromise(
        requireWorkflowScope.pipe(
          Effect.provide(WorkflowScopeLayer),
          Effect.either
        )
      );

      expect(result._tag).toBe("Right");
    });
  });
});
```

---

### Test File: `test/context/step-scope.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  StepScope,
  StepScopeLayer,
  isInStepScope,
  rejectInsideStep,
  guardWorkflowOperation,
  StepScopeError,
} from "../../src";

describe("StepScope", () => {
  describe("isInStepScope", () => {
    it("should return false outside step", async () => {
      const result = await Effect.runPromise(isInStepScope);
      expect(result).toBe(false);
    });

    it("should return true inside step", async () => {
      const result = await Effect.runPromise(
        isInStepScope.pipe(Effect.provide(StepScopeLayer("myStep")))
      );
      expect(result).toBe(true);
    });
  });

  describe("rejectInsideStep", () => {
    it("should succeed outside step", async () => {
      const result = await Effect.runPromise(
        rejectInsideStep.pipe(Effect.either)
      );

      expect(result._tag).toBe("Right");
    });

    it("should fail inside step", async () => {
      const result = await Effect.runPromise(
        rejectInsideStep.pipe(
          Effect.provide(StepScopeLayer("fetchData")),
          Effect.either
        )
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(StepScopeError);
        expect(result.left.stepName).toBe("fetchData");
      }
    });
  });

  describe("guardWorkflowOperation", () => {
    it("should succeed outside step", async () => {
      const result = await Effect.runPromise(
        guardWorkflowOperation("Workflow.sleep").pipe(Effect.either)
      );

      expect(result._tag).toBe("Right");
    });

    it("should fail inside step with operation name", async () => {
      const result = await Effect.runPromise(
        guardWorkflowOperation("Workflow.sleep").pipe(
          Effect.provide(StepScopeLayer("processData")),
          Effect.either
        )
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(StepScopeError);
        expect(result.left.operation).toBe("Workflow.sleep");
        expect(result.left.stepName).toBe("processData");
        expect(result.left.message).toContain("Workflow.sleep");
        expect(result.left.message).toContain("processData");
        expect(result.left.message).toContain("Effect.sleep() is allowed");
      }
    });

    it("should provide helpful error message", async () => {
      const result = await Effect.runPromise(
        guardWorkflowOperation("Workflow.step").pipe(
          Effect.provide(StepScopeLayer("outerStep")),
          Effect.either
        )
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        // Error message should clarify the distinction
        expect(result.left.message).toContain("Workflow.step");
        expect(result.left.message).toContain("outerStep");
        expect(result.left.message).toContain("workflow level");
      }
    });
  });

  describe("StepScopeError", () => {
    it("should include operation and step name in error", () => {
      const error = new StepScopeError({
        operation: "Workflow.sleep",
        stepName: "myStep",
      });

      expect(error._tag).toBe("StepScopeError");
      expect(error.operation).toBe("Workflow.sleep");
      expect(error.stepName).toBe("myStep");
      expect(error.name).toBe("StepScopeError");
    });
  });
});
```

---

## Definition of Done

- [ ] WorkflowContext service complete with all operations
- [ ] StepContext service complete with result caching
- [ ] WorkflowScope guard prevents workflow nesting
- [ ] StepScope guard prevents `Workflow.*` primitives inside steps
- [ ] Step state is properly isolated by step name
- [ ] Pause point tracking works correctly
- [ ] All tests passing
- [ ] Package builds without errors

---

## Notes for Implementation

1. **Storage keys must match v1 for migration** - Check existing schema
2. **Step isolation is critical** - Each step's state is independent
3. **WorkflowScope is compile-time** - Leverages Effect's type system
4. **StepScope guards workflow primitives** - `Workflow.sleep()`, `Workflow.step()` check for StepScope and fail if present
5. **Effect.sleep is allowed inside steps** - Only `Workflow.*` primitives are blocked
6. **Context services are stateless** - All state lives in StorageAdapter
