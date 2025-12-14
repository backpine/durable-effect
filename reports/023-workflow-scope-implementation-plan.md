# WorkflowScope Implementation Plan

## Overview

This plan implements compile-time protection to ensure workflow jobs are only used at the workflow level, not inside steps:

- **Compile-time:** `WorkflowScope` forbidden context tag prevents `Workflow.step` and `Workflow.sleep` inside steps

**Note:** `Effect.sleep` is intentionally allowed inside steps because `Effect.timeoutFail` (used by `Workflow.timeout`) uses it internally for timeout racing.

## Implementation Steps

### Step 1: Create WorkflowScope Service

**File:** `packages/workflow/src/services/workflow-scope.ts` (NEW)

```typescript
import { Context } from "effect";

/**
 * WorkflowScope is required by workflow jobs (step, sleep).
 * This scope is NOT available inside a step's effect, preventing nesting.
 *
 * @internal This is a compile-time guard, not a runtime service.
 */
export class WorkflowScope extends Context.Tag("@durable-effect/WorkflowScope")<
  WorkflowScope,
  { readonly _brand: "WorkflowScope" }
>() {}

/**
 * Type-level guard that forbids WorkflowScope in R.
 * If R includes WorkflowScope, this evaluates to `never`.
 */
export type ForbidWorkflowScope<R> = WorkflowScope extends R ? never : R;
```

---

### Step 2: Export WorkflowScope from Services

**File:** `packages/workflow/src/services/index.ts`

```typescript
// Add export
export {
  WorkflowScope,
  type ForbidWorkflowScope,
} from "./workflow-scope";
```

---

### Step 3: Update Workflow.step Signature

**File:** `packages/workflow/src/workflow.ts`

**Import:**
```typescript
import { WorkflowScope, ForbidWorkflowScope } from "@/services/workflow-scope";
```

**Update step function:**
```typescript
export function step<T, E, R>(
  name: string,
  effect: Effect.Effect<T, E, ForbidWorkflowScope<R>>,  // ← Forbid WorkflowScope
): Effect.Effect<
  T,
  E | StepError | PauseSignal | UnknownException,
  WorkflowScope | Exclude<R, StepContext> | ExecutionContext | WorkflowContext  // ← Require WorkflowScope
>
```

---

### Step 4: Update Workflow.sleep Signature

**File:** `packages/workflow/src/workflow.ts`

```typescript
export function sleep(
  duration: Duration.DurationInput,
): Effect.Effect<
  void,
  PauseSignal | UnknownException,
  WorkflowScope | ExecutionContext | WorkflowContext  // ← Add WorkflowScope
>
```

---

### Step 5: Create StepClock That Rejects Sleep

**File:** `packages/workflow/src/services/step-clock.ts` (NEW)

```typescript
import { Clock, Effect } from "effect";

/**
 * Error thrown when Effect.sleep is called inside a step.
 */
export class StepSleepForbiddenError extends Error {
  readonly _tag = "StepSleepForbiddenError";

  constructor() {
    super(
      "Effect.sleep is not allowed inside a step. " +
      "Steps should be atomic units of work. " +
      "Use Workflow.sleep at the workflow level between steps."
    );
    this.name = "StepSleepForbiddenError";
  }
}

/**
 * A Clock implementation that rejects sleep operations.
 * Used inside steps to enforce that Effect.sleep is not called.
 */
export const StepClock: Clock.Clock = {
  [Clock.ClockTypeId]: Clock.ClockTypeId,

  // Allow getting current time
  currentTimeMillis: Clock.currentTimeMillis,
  currentTimeNanos: Clock.currentTimeNanos,

  // Reject sleep operations
  sleep: () => Effect.die(new StepSleepForbiddenError()),
};

/**
 * Layer that provides the step clock.
 */
export const StepClockLayer = Layer.succeed(Clock.Clock, StepClock);
```

---

### Step 6: Update Step Execution to Use StepClock

**File:** `packages/workflow/src/workflow.ts`

In the `step` function, wrap the effect execution with the StepClock:

```typescript
import { Clock, Layer } from "effect";
import { StepClock } from "@/services/step-clock";

export function step<T, E, R>(
  name: string,
  effect: Effect.Effect<T, E, ForbidWorkflowScope<R>>,
): Effect.Effect<
  T,
  E | StepError | PauseSignal | UnknownException,
  WorkflowScope | Exclude<R, StepContext> | ExecutionContext | WorkflowContext
> {
  return Effect.gen(function* () {
    // ... existing setup code ...

    // Execute effect with StepContext AND StepClock provided
    const result = yield* effect.pipe(
      Effect.provideService(StepContext, stepCtx),
      Effect.provideService(Clock.Clock, StepClock),  // ← ADD THIS
      Effect.either,
    );

    // ... rest of implementation ...
  });
}
```

---

### Step 7: Provide WorkflowScope in Engine

**File:** `packages/workflow/src/engine.ts`

```typescript
import { WorkflowScope } from "@/services/workflow-scope";

// In #executeWorkflow method:
async #executeWorkflow(
  workflowDef: T[keyof T],
  input: unknown,
  workflowId: string,
  workflowName: string,
  transition: { _tag: "Start"; input: unknown } | { _tag: "Resume" },
  executionId?: string,
): Promise<void> {
  const storage = this.ctx.storage;
  const execCtx = createExecutionContext(this.ctx);
  const workflowCtx = createWorkflowContext(
    workflowId,
    workflowName,
    input,
    storage,
    executionId,
  );

  const execution = Effect.gen(function* () {
    yield* transitionWorkflow(storage, workflowId, workflowName, transition, executionId);

    const startTime = Date.now();
    const result = yield* workflowDef
      .definition(input)
      .pipe(
        Effect.provideService(ExecutionContext, execCtx),
        Effect.provideService(WorkflowContext, workflowCtx),
        Effect.provideService(WorkflowScope, { _brand: "WorkflowScope" as const }),  // ← ADD THIS
        Effect.exit,
      );

    yield* handleWorkflowResult(
      result,
      storage,
      workflowId,
      workflowName,
      startTime,
      executionId,
    );

    yield* flushEvents;
  }).pipe(Effect.provide(this.#trackerLayer));

  await Effect.runPromise(execution);
}
```

---

### Step 8: Update ProvidedContext Type

**File:** `packages/workflow/src/types.ts`

```typescript
import type { WorkflowScope } from "@/services/workflow-scope";

/**
 * Context requirements provided by the workflow engine.
 */
export type ProvidedContext = WorkflowScope | WorkflowContext | ExecutionContext;
```

---

### Step 9: Update Package Exports

**File:** `packages/workflow/src/index.ts`

```typescript
// Services
export {
  WorkflowContext,
  StepContext,
  WorkflowScope,
  type WorkflowContextService,
  type StepContextService,
  type ForbidWorkflowScope,
} from "@/services";

// Errors (add new error)
export { StepError, StepTimeoutError, StepSleepForbiddenError } from "@/errors";
```

**File:** `packages/workflow/src/errors.ts`

```typescript
// Re-export from step-clock
export { StepSleepForbiddenError } from "@/services/step-clock";
```

---

### Step 10: Update Test Mocks

**File:** `packages/workflow/test/mocks/contexts.ts`

Add WorkflowScope to the test context creation:

```typescript
import { WorkflowScope } from "@/services/workflow-scope";

/**
 * Helper to run effects with full workflow context (including WorkflowScope).
 */
export function runWithWorkflowContext<T, E>(
  effect: Effect.Effect<T, E, WorkflowScope | ExecutionContext | WorkflowContext>,
  contexts: ReturnType<typeof createTestContexts>,
) {
  return effect.pipe(
    Effect.provideService(ExecutionContext, contexts.executionContext),
    Effect.provideService(WorkflowContext, contexts.workflowContext),
    Effect.provideService(WorkflowScope, { _brand: "WorkflowScope" as const }),
  );
}
```

---

### Step 11: Update Existing Tests

Tests that call `Workflow.step` or `Workflow.sleep` directly need to provide `WorkflowScope`.

**File:** `packages/workflow/test/step.test.ts`

Update the `runStep` helper:

```typescript
import { WorkflowScope } from "@/services/workflow-scope";

function runStep<T, E>(
  stepEffect: Effect.Effect<T, E, WorkflowScope | ExecutionContext | WorkflowContext>,
) {
  return stepEffect.pipe(
    Effect.provideService(ExecutionContext, executionContext),
    Effect.provideService(WorkflowContext, workflowContext),
    Effect.provideService(WorkflowScope, { _brand: "WorkflowScope" as const }),
  );
}
```

**File:** `packages/workflow/test/sleep.test.ts`

Same pattern - add WorkflowScope to the test helper.

---

### Step 12: Add Tests for New Behavior

**File:** `packages/workflow/test/step-forbidden.test.ts` (NEW)

```typescript
import { describe, it, expect } from "vitest";
import { Effect, Clock } from "effect";
import { Workflow } from "@/workflow";
import { StepSleepForbiddenError } from "@/errors";
import { createTestContexts } from "./mocks";

describe("Step forbidden operations", () => {
  it("Effect.sleep inside step throws StepSleepForbiddenError", async () => {
    const contexts = createTestContexts();

    const step = Workflow.step(
      "BadStep",
      Effect.gen(function* () {
        yield* Effect.sleep("100 millis");  // Should throw
        return "done";
      }),
    );

    const result = await Effect.runPromiseExit(
      step.pipe(
        Effect.provideService(ExecutionContext, contexts.executionContext),
        Effect.provideService(WorkflowContext, contexts.workflowContext),
        Effect.provideService(WorkflowScope, { _brand: "WorkflowScope" as const }),
      ),
    );

    expect(result._tag).toBe("Failure");
    // Check that it died with StepSleepForbiddenError
  });

  it("Regular effects without sleep work inside step", async () => {
    const contexts = createTestContexts();

    const step = Workflow.step(
      "GoodStep",
      Effect.gen(function* () {
        yield* Effect.log("Processing...");
        return { processed: true };
      }),
    );

    const result = await Effect.runPromise(
      step.pipe(
        Effect.provideService(ExecutionContext, contexts.executionContext),
        Effect.provideService(WorkflowContext, contexts.workflowContext),
        Effect.provideService(WorkflowScope, { _brand: "WorkflowScope" as const }),
      ),
    );

    expect(result).toEqual({ processed: true });
  });
});
```

---

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/services/workflow-scope.ts` | **NEW** | WorkflowScope tag and ForbidWorkflowScope type |
| `src/services/step-clock.ts` | **NEW** | StepClock that rejects Effect.sleep |
| `src/services/index.ts` | EDIT | Export new modules |
| `src/workflow.ts` | EDIT | Update step/sleep signatures, add StepClock |
| `src/engine.ts` | EDIT | Provide WorkflowScope |
| `src/types.ts` | EDIT | Update ProvidedContext type |
| `src/errors.ts` | EDIT | Export StepSleepForbiddenError |
| `src/index.ts` | EDIT | Export new types |
| `test/mocks/contexts.ts` | EDIT | Add WorkflowScope helper |
| `test/step.test.ts` | EDIT | Add WorkflowScope to test helper |
| `test/sleep.test.ts` | EDIT | Add WorkflowScope to test helper |
| `test/step-forbidden.test.ts` | **NEW** | Tests for forbidden operations |
| `test/type-tests/workflow-scope.test-d.ts` | EXISTS | Already created, validates types |

---

## Enforcement Summary

| Operation | Location | Compile-Time | Runtime |
|-----------|----------|--------------|---------|
| `Workflow.step` | Inside step | **ERROR** | N/A |
| `Workflow.sleep` | Inside step | **ERROR** | N/A |
| `Effect.sleep` | Inside step | Allowed | Allowed |
| `Workflow.retry` | Inside step | Allowed | Allowed (requires StepContext) |
| `Workflow.timeout` | Inside step | Allowed | Allowed (requires StepContext) |
| All jobs | Workflow level | Allowed | Allowed |

**Note on Effect.sleep:** We intentionally allow `Effect.sleep` inside steps because `Effect.timeoutFail` (used by `Workflow.timeout`) uses it internally for timeout racing. Blocking all sleep operations would break the timeout functionality.

---

## Rollout Order

1. Create `workflow-scope.ts` and `step-clock.ts`
2. Update service exports
3. Update `workflow.ts` signatures and add StepClock
4. Update `engine.ts` to provide WorkflowScope
5. Update `types.ts` and package exports
6. Update test mocks
7. Update existing tests
8. Add new forbidden operation tests
9. Run full test suite
10. Verify type-level tests pass

---

## Expected Errors After Implementation

**Compile-time (TypeScript):**
```
Argument of type 'Effect<..., WorkflowScope | WorkflowContext>' is not
assignable to parameter of type 'Effect<..., never>'
  Type 'WorkflowScope' is not assignable to type 'never'.
```

**Runtime (Effect.sleep inside step):**
```
StepSleepForbiddenError: Effect.sleep is not allowed inside a step.
Steps should be atomic units of work.
Use Workflow.sleep at the workflow level between steps.
```
