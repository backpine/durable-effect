# Phase 5: Workflow Primitives - Core (step & make)

## Overview

This phase implements the core workflow primitives: `Workflow.make()` for defining workflows and `Workflow.step()` for executing durable, idempotent operations. The step primitive is the most critical - it handles result caching, replay, and pause signaling.

**Duration**: ~3-4 hours
**Dependencies**: Phase 1-4 (adapters, state machine, recovery, context)
**Risk Level**: Medium (core execution logic)

---

## Goals

1. Implement `Workflow.make()` for defining type-safe workflows
2. Implement `Workflow.step()` with full result caching
3. Create PauseSignal for durable pausing
4. Implement step execution phases
5. Support workflow cancellation checking

---

## Background: The Step Primitive

`Workflow.step()` is the heart of durable execution. It must:

1. **Check cache** - Return cached result if step already completed
2. **Execute once** - Run the effect only if not cached
3. **Cache result** - Store result before returning
4. **Handle errors** - Differentiate user errors from system errors
5. **Support replay** - Work correctly after pause/resume cycles
6. **Check cancellation** - Stop if workflow is being cancelled

---

## File Structure

```
packages/workflow-v2/src/
├── primitives/
│   ├── index.ts               # Primitives exports
│   ├── pause-signal.ts        # PauseSignal error type
│   ├── step.ts                # step() implementation
│   └── make.ts                # Workflow.make() factory
└── test/
    └── primitives/
        ├── step.test.ts       # Step tests
        └── make.test.ts       # Workflow.make tests
```

---

## Implementation Details

### 1. PauseSignal (`primitives/pause-signal.ts`)

```typescript
// packages/workflow-v2/src/primitives/pause-signal.ts

import { Data } from "effect";

/**
 * Reason for pausing workflow execution.
 */
export type PauseReason = "sleep" | "retry";

/**
 * PauseSignal is a special error type that signals the workflow
 * should pause and be resumed later.
 *
 * This is NOT a failure - it's a control flow mechanism.
 * The orchestrator catches this and schedules an alarm.
 */
export class PauseSignal extends Data.TaggedError("PauseSignal")<{
  /** Why the workflow is pausing */
  readonly reason: PauseReason;
  /** When to resume (timestamp ms) */
  readonly resumeAt: number;
  /** Step name that caused pause (for retry) */
  readonly stepName?: string;
  /** Current attempt (for retry) */
  readonly attempt?: number;
}> {
  /**
   * Create a sleep pause signal.
   */
  static sleep(resumeAt: number): PauseSignal {
    return new PauseSignal({ reason: "sleep", resumeAt });
  }

  /**
   * Create a retry pause signal.
   */
  static retry(
    resumeAt: number,
    stepName: string,
    attempt: number
  ): PauseSignal {
    return new PauseSignal({
      reason: "retry",
      resumeAt,
      stepName,
      attempt,
    });
  }
}

/**
 * Check if an error is a PauseSignal.
 */
export function isPauseSignal(error: unknown): error is PauseSignal {
  return error instanceof PauseSignal;
}
```

### 2. Workflow Definition (`primitives/make.ts`)

```typescript
// packages/workflow-v2/src/primitives/make.ts

import { Effect, type Types } from "effect";
import type { StorageError } from "../errors";
import type { PauseSignal } from "./pause-signal";

// =============================================================================
// Types
// =============================================================================

/**
 * A workflow definition.
 *
 * This is the type-safe container for a workflow's execution logic.
 * Created with Workflow.make().
 */
export interface WorkflowDefinition<
  Input,
  Output,
  Error,
  Requirements
> {
  /**
   * Unique name for this workflow type.
   */
  readonly name: string;

  /**
   * Execute the workflow.
   *
   * This runs the workflow effect and returns the result.
   * Should only be called by the executor.
   */
  readonly execute: (
    input: Input
  ) => Effect.Effect<Output, Error | PauseSignal | StorageError, Requirements>;

  /**
   * Type witnesses for inference.
   */
  readonly _Input: Types.Covariant<Input>;
  readonly _Output: Types.Covariant<Output>;
  readonly _Error: Types.Covariant<Error>;
}

/**
 * Options for creating a workflow.
 */
export interface WorkflowOptions {
  /**
   * Unique name for this workflow.
   * Must be stable - used for storage keys.
   */
  readonly name: string;
}

/**
 * The workflow effect signature.
 */
export type WorkflowEffect<Input, Output, Error, Requirements> = (
  input: Input
) => Effect.Effect<Output, Error | PauseSignal | StorageError, Requirements>;

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a workflow definition.
 *
 * @example
 * ```ts
 * const myWorkflow = Workflow.make({
 *   name: "processOrder"
 * }, (input: { orderId: string }) =>
 *   Effect.gen(function* () {
 *     const order = yield* Workflow.step("fetchOrder", () =>
 *       fetchOrder(input.orderId)
 *     );
 *
 *     yield* Workflow.sleep("1 hour");
 *
 *     const result = yield* Workflow.step("processPayment", () =>
 *       processPayment(order)
 *     );
 *
 *     return result;
 *   })
 * );
 * ```
 */
export function make<Input, Output, Error, Requirements>(
  options: WorkflowOptions,
  execute: WorkflowEffect<Input, Output, Error, Requirements>
): WorkflowDefinition<Input, Output, Error, Requirements> {
  return {
    name: options.name,
    execute,
    _Input: undefined as any,
    _Output: undefined as any,
    _Error: undefined as any,
  };
}

/**
 * Extract input type from a workflow definition.
 */
export type WorkflowInput<W> = W extends WorkflowDefinition<
  infer I,
  any,
  any,
  any
>
  ? I
  : never;

/**
 * Extract output type from a workflow definition.
 */
export type WorkflowOutput<W> = W extends WorkflowDefinition<
  any,
  infer O,
  any,
  any
>
  ? O
  : never;

/**
 * Extract error type from a workflow definition.
 */
export type WorkflowError<W> = W extends WorkflowDefinition<
  any,
  any,
  infer E,
  any
>
  ? E
  : never;

/**
 * Extract requirements type from a workflow definition.
 */
export type WorkflowRequirements<W> = W extends WorkflowDefinition<
  any,
  any,
  any,
  infer R
>
  ? R
  : never;
```

### 3. Step Primitive (`primitives/step.ts`)

```typescript
// packages/workflow-v2/src/primitives/step.ts

import { Effect, Option } from "effect";
import { WorkflowContext } from "../context/workflow-context";
import { StepContext, StepContextLayer, type StepResultMeta } from "../context/step-context";
import { WorkflowScope, WorkflowScopeError } from "../context/workflow-scope";
import { StepScopeLayer } from "../context/step-scope";
import { StorageAdapter } from "../adapters/storage";
import { RuntimeAdapter } from "../adapters/runtime";
import { StorageError } from "../errors";

// =============================================================================
// Types
// =============================================================================

/**
 * Options for a step.
 */
export interface StepOptions {
  /**
   * Optional timeout for the step in milliseconds.
   * If exceeded, the step fails with a timeout error.
   */
  readonly timeout?: number;
}

/**
 * Error when a step times out.
 */
export class StepTimeoutError extends Error {
  readonly _tag = "StepTimeoutError";
  readonly stepName: string;
  readonly timeoutMs: number;

  constructor(stepName: string, timeoutMs: number) {
    super(`Step "${stepName}" timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
    this.stepName = stepName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error when a step is cancelled.
 */
export class StepCancelledError extends Error {
  readonly _tag = "StepCancelledError";
  readonly stepName: string;

  constructor(stepName: string) {
    super(`Step "${stepName}" was cancelled`);
    this.name = "StepCancelledError";
    this.stepName = stepName;
  }
}

// =============================================================================
// Step Implementation
// =============================================================================

/**
 * Execute a durable step within a workflow.
 *
 * Steps are the fundamental building blocks of durable workflows:
 * - Results are cached and returned on replay
 * - Each step has a unique name for identification
 * - Steps check for cancellation before executing
 * - Step errors are captured and stored
 *
 * @param name - Unique name for this step within the workflow
 * @param execute - The effect to execute (should be idempotent)
 * @param options - Optional step configuration
 *
 * @example
 * ```ts
 * const result = yield* Workflow.step("fetchUser", () =>
 *   Effect.tryPromise(() => fetch(`/api/users/${userId}`))
 * );
 * ```
 */
export function step<A, E, R>(
  name: string,
  execute: () => Effect.Effect<A, E, R>,
  options?: StepOptions
): Effect.Effect<
  A,
  E | StorageError | StepTimeoutError | StepCancelledError | WorkflowScopeError,
  WorkflowContext | WorkflowScope | StorageAdapter | RuntimeAdapter | R
> {
  return Effect.gen(function* () {
    // Verify we're in a workflow scope
    const scope = yield* Effect.serviceOption(WorkflowScope);
    if (Option.isNone(scope)) {
      return yield* Effect.fail(
        new WorkflowScopeError({
          message: `Workflow.step("${name}") can only be used inside a workflow`,
        })
      );
    }

    const workflowCtx = yield* WorkflowContext;
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    // -------------------------------------------------------------------------
    // Phase 1: Check for cancellation
    // -------------------------------------------------------------------------
    const isCancelled = yield* storage
      .get<boolean>("workflow:cancelled")
      .pipe(Effect.map((c) => c ?? false));

    if (isCancelled) {
      return yield* Effect.fail(new StepCancelledError(name));
    }

    // -------------------------------------------------------------------------
    // Phase 2: Create step context
    // -------------------------------------------------------------------------
    const stepCtx = yield* Effect.provide(
      StepContext,
      StepContextLayer(name).pipe(
        Effect.provideService(StorageAdapter, storage),
        Effect.provideService(RuntimeAdapter, runtime)
      )
    );

    // -------------------------------------------------------------------------
    // Phase 3: Check cache for existing result
    // -------------------------------------------------------------------------
    const cached = yield* stepCtx.getResult<A>();
    if (cached !== undefined) {
      // Step already completed - return cached result
      return cached.value;
    }

    // -------------------------------------------------------------------------
    // Phase 4: Execute the step
    // -------------------------------------------------------------------------
    const now = yield* runtime.now();
    yield* stepCtx.setStartedAt(now);

    // Wrap execution with timeout if specified
    let stepEffect = execute();
    if (options?.timeout !== undefined) {
      stepEffect = Effect.timeoutFail(stepEffect, {
        duration: options.timeout,
        onTimeout: () => new StepTimeoutError(name, options.timeout!),
      });
    }

    // Execute with step scope that prevents Workflow.* primitives inside steps
    // Note: Effect.sleep IS allowed inside steps
    const result = yield* stepEffect.pipe(
      Effect.provide(StepScopeLayer(name))
    );

    // -------------------------------------------------------------------------
    // Phase 5: Cache result
    // -------------------------------------------------------------------------
    const completedAt = yield* runtime.now();
    const meta: StepResultMeta = {
      completedAt,
      attempt: yield* stepCtx.attempt,
      durationMs: completedAt - now,
    };

    yield* stepCtx.setResult(result, meta);

    // -------------------------------------------------------------------------
    // Phase 6: Mark step as completed
    // -------------------------------------------------------------------------
    yield* workflowCtx.markStepCompleted(name);

    return result;
  });
}

```

### 4. Primitives Exports (`primitives/index.ts`)

```typescript
// packages/workflow-v2/src/primitives/index.ts

// PauseSignal
export {
  PauseSignal,
  isPauseSignal,
  type PauseReason,
} from "./pause-signal";

// Workflow.make
export {
  make,
  type WorkflowDefinition,
  type WorkflowOptions,
  type WorkflowEffect,
  type WorkflowInput,
  type WorkflowOutput,
  type WorkflowError,
  type WorkflowRequirements,
} from "./make";

// Workflow.step
export {
  step,
  type StepOptions,
  StepTimeoutError,
  StepCancelledError,
} from "./step";
```

### 5. Update Main Index

```typescript
// packages/workflow-v2/src/index.ts

// ... existing exports ...

// Primitives
export {
  // PauseSignal
  PauseSignal,
  isPauseSignal,
  type PauseReason,
  // Workflow.make
  make,
  type WorkflowDefinition,
  type WorkflowOptions,
  type WorkflowInput,
  type WorkflowOutput,
  type WorkflowError,
  type WorkflowRequirements,
  // Workflow.step
  step,
  type StepOptions,
  StepTimeoutError,
  StepCancelledError,
} from "./primitives";

// Re-export as Workflow namespace for convenience
export * as Workflow from "./primitives";
```

---

## Testing Strategy

### Test File: `test/primitives/step.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  StorageAdapter,
  RuntimeAdapter,
  WorkflowContext,
  WorkflowContextLayer,
  WorkflowScope,
  WorkflowScopeLayer,
  step,
  StepTimeoutError,
  StepCancelledError,
  WorkflowScopeError,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("Workflow.step", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000, instanceId: "wf-123" })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  // Create a layer stack for step execution
  const createStepLayers = () =>
    WorkflowScopeLayer.pipe(
      Layer.provideMerge(WorkflowContextLayer),
      Layer.provide(runtimeLayer)
    );

  const runStep = <A, E>(
    effect: Effect.Effect<A, E, WorkflowContext | WorkflowScope | StorageAdapter | RuntimeAdapter>
  ) =>
    effect.pipe(Effect.provide(createStepLayers()), Effect.runPromise);

  describe("basic execution", () => {
    it("should execute step and return result", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("myStep", () => Effect.succeed(42));
        })
      );

      expect(result).toBe(42);
    });

    it("should execute async step", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("asyncStep", () =>
            Effect.promise(async () => {
              await new Promise((r) => setTimeout(r, 10));
              return "async result";
            })
          );
        })
      );

      expect(result).toBe("async result");
    });

    it("should propagate step errors", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("failingStep", () =>
            Effect.fail(new Error("step failed"))
          ).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
    });
  });

  describe("result caching", () => {
    it("should cache and replay results", async () => {
      let executionCount = 0;

      // First execution
      await runStep(
        Effect.gen(function* () {
          return yield* step("cachedStep", () =>
            Effect.sync(() => {
              executionCount++;
              return "result";
            })
          );
        })
      );

      expect(executionCount).toBe(1);

      // Second execution (should use cache)
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("cachedStep", () =>
            Effect.sync(() => {
              executionCount++;
              return "result";
            })
          );
        })
      );

      expect(executionCount).toBe(1); // Still 1 - cached
      expect(result).toBe("result");
    });

    it("should not share cache between different steps", async () => {
      let step1Count = 0;
      let step2Count = 0;

      await runStep(
        Effect.gen(function* () {
          yield* step("step1", () =>
            Effect.sync(() => {
              step1Count++;
              return "step1";
            })
          );
          yield* step("step2", () =>
            Effect.sync(() => {
              step2Count++;
              return "step2";
            })
          );
        })
      );

      expect(step1Count).toBe(1);
      expect(step2Count).toBe(1);
    });
  });

  describe("cancellation", () => {
    it("should fail if workflow is cancelled", async () => {
      // Set cancelled flag
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:cancelled", true);
        }).pipe(Effect.provide(runtimeLayer))
      );

      const result = await runStep(
        Effect.gen(function* () {
          return yield* step("cancelledStep", () =>
            Effect.succeed("should not run")
          ).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(StepCancelledError);
      }
    });

    it("should not execute effect when cancelled", async () => {
      let executed = false;

      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          yield* storage.put("workflow:cancelled", true);
        }).pipe(Effect.provide(runtimeLayer))
      );

      await runStep(
        Effect.gen(function* () {
          return yield* step("cancelledStep", () =>
            Effect.sync(() => {
              executed = true;
              return "result";
            })
          ).pipe(Effect.either);
        })
      );

      expect(executed).toBe(false);
    });
  });

  describe("timeout", () => {
    it("should timeout slow steps", async () => {
      const result = await runStep(
        Effect.gen(function* () {
          return yield* step(
            "slowStep",
            () =>
              Effect.promise(
                () => new Promise((resolve) => setTimeout(resolve, 1000))
              ),
            { timeout: 50 }
          ).pipe(Effect.either);
        })
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(StepTimeoutError);
      }
    });
  });

  describe("workflow scope requirement", () => {
    it("should fail outside workflow scope", async () => {
      const result = await Effect.gen(function* () {
        return yield* step("noScope", () => Effect.succeed(42)).pipe(
          Effect.either
        );
      }).pipe(
        // No WorkflowScopeLayer!
        Effect.provide(WorkflowContextLayer),
        Effect.provide(runtimeLayer),
        Effect.runPromise
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(WorkflowScopeError);
      }
    });
  });

  describe("multiple steps", () => {
    it("should execute steps in sequence", async () => {
      const order: string[] = [];

      await runStep(
        Effect.gen(function* () {
          yield* step("step1", () =>
            Effect.sync(() => {
              order.push("step1");
              return 1;
            })
          );
          yield* step("step2", () =>
            Effect.sync(() => {
              order.push("step2");
              return 2;
            })
          );
          yield* step("step3", () =>
            Effect.sync(() => {
              order.push("step3");
              return 3;
            })
          );
        })
      );

      expect(order).toEqual(["step1", "step2", "step3"]);
    });

    it("should track completed steps", async () => {
      await runStep(
        Effect.gen(function* () {
          yield* step("stepA", () => Effect.succeed("A"));
          yield* step("stepB", () => Effect.succeed("B"));
        })
      );

      const completedSteps = await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          return yield* storage.get<string[]>("workflow:completedSteps");
        }).pipe(Effect.provide(runtimeLayer))
      );

      expect(completedSteps).toContain("stepA");
      expect(completedSteps).toContain("stepB");
    });
  });
});
```

### Test File: `test/primitives/make.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { make, type WorkflowDefinition } from "../../src";

describe("Workflow.make", () => {
  it("should create a workflow definition", () => {
    const workflow = make(
      { name: "testWorkflow" },
      (input: { value: number }) =>
        Effect.succeed(input.value * 2)
    );

    expect(workflow.name).toBe("testWorkflow");
    expect(typeof workflow.execute).toBe("function");
  });

  it("should preserve type information", () => {
    const workflow = make(
      { name: "typedWorkflow" },
      (input: { name: string; count: number }) =>
        Effect.succeed({ result: `${input.name}-${input.count}` })
    );

    // Type checking - these should compile
    type Input = Parameters<typeof workflow.execute>[0];
    type _CheckInput = Input extends { name: string; count: number }
      ? true
      : false;

    expect(workflow.name).toBe("typedWorkflow");
  });

  it("should execute workflow effect", async () => {
    const workflow = make(
      { name: "executableWorkflow" },
      (input: { x: number }) =>
        Effect.gen(function* () {
          return input.x + 10;
        })
    );

    const result = await Effect.runPromise(workflow.execute({ x: 5 }));
    expect(result).toBe(15);
  });

  it("should handle workflow errors", async () => {
    class CustomError {
      readonly _tag = "CustomError";
    }

    const workflow = make(
      { name: "failingWorkflow" },
      (_input: {}) =>
        Effect.fail(new CustomError())
    );

    const result = await Effect.runPromise(
      workflow.execute({}).pipe(Effect.either)
    );

    expect(result._tag).toBe("Left");
  });
});
```

---

## Definition of Done

- [ ] PauseSignal error type implemented
- [ ] Workflow.make() creates typed definitions
- [ ] Workflow.step() executes and caches results
- [ ] Step result caching works on replay
- [ ] Cancellation check prevents execution
- [ ] Timeout option works correctly
- [ ] WorkflowScope requirement enforced
- [ ] Completed steps are tracked
- [ ] All tests passing
- [ ] Package builds without errors

---

## Notes for Implementation

1. **Cache check is first** - Always check cache before any execution
2. **Cancellation check is early** - Check before expensive operations
3. **Step names must be unique** - Duplicate names cause cache collisions
4. **StepScope prevents Workflow.* inside steps** - Workflow primitives must be at workflow level
5. **Effect.sleep is allowed inside steps** - Only Workflow.sleep is blocked
6. **Type inference is critical** - Workflow.make preserves input/output types
