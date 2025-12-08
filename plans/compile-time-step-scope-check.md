# Plan: Compile-Time Step Scope Checking

## Problem

Currently, using workflow primitives inside a step fails at runtime but not at compile time:

```typescript
yield* Workflow.step("Outer",
  Effect.gen(function* () {
    yield* Workflow.sleep("1 second");  // Runtime error, no compile error
    yield* Workflow.step("Inner", ...);  // Runtime error, no compile error
  })
);
```

We want TypeScript to catch this mistake during development.

## Approach: "Poison Pill" Requirement Pattern

Use Effect's requirements channel (`R`) to propagate a type-level marker that causes a compile error when workflow primitives are used inside a step.

### Key Insight

When you `yield*` an Effect inside `Effect.gen`, its requirements propagate to the outer Effect:

```typescript
const inner: Effect<void, never, FooService> = ...;
const outer = Effect.gen(function* () {
  yield* inner;  // outer now requires FooService
});
// outer: Effect<void, never, FooService>
```

We can exploit this: if `Workflow.sleep` requires a "WorkflowLevel" marker, and `step` doesn't provide that marker to its inner effect, you get a type error.

## Implementation

### Step 1: Create WorkflowLevel Marker

```typescript
// src/context/workflow-level.ts

import { Context } from "effect";

/**
 * Marker service that indicates we're at the workflow level (not inside a step).
 *
 * Workflow primitives (step, sleep, retry, timeout) require this marker.
 * The step() function does NOT provide this to its inner effect, causing
 * a compile-time error if you try to use primitives inside a step.
 */
export interface WorkflowLevelService {
  readonly _brand: "workflow-level";
}

export class WorkflowLevel extends Context.Tag("@durable-effect/WorkflowLevel")<
  WorkflowLevel,
  WorkflowLevelService
>() {}
```

### Step 2: Add Type-Level Check Helper

```typescript
// src/context/workflow-level.ts (continued)

/**
 * Type-level check that produces a helpful error message when
 * WorkflowLevel is missing from requirements.
 *
 * If WorkflowLevel is not in R, return R unchanged.
 * If checking for WorkflowLevel presence inside step (where it's excluded),
 * this will cause the types to not match.
 */
export type RequireWorkflowLevel<R> = R | WorkflowLevel;
```

### Step 3: Update Primitive Signatures

Add `WorkflowLevel` to the requirements of workflow primitives:

```typescript
// sleep.ts
export function sleep(
  duration: string | number
): Effect.Effect<
  void,
  PauseSignal | StorageError | WorkflowScopeError | StepScopeError,
  WorkflowContext | WorkflowScope | RuntimeAdapter | StorageAdapter | WorkflowLevel  // Added
> { ... }

// step.ts
export function step<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  E | StorageError | StepCancelledError | WorkflowScopeError,
  | WorkflowContext
  | StorageAdapter
  | RuntimeAdapter
  | WorkflowLevel  // Added
  | Exclude<R, StepContext | StorageAdapter | RuntimeAdapter | StepScope | WorkflowLevel>  // Exclude WorkflowLevel from inner
> { ... }

// retry.ts
export function retry<A, E, R>(
  options: RetryOptions
): <E2, R2>(
  effect: Effect.Effect<A, E | E2, R | R2>
) => Effect.Effect<
  A,
  E | E2 | StorageError | PauseSignal | RetryExhaustedError,
  R | R2 | StepContext | RuntimeAdapter | WorkflowContext | WorkflowLevel  // Added
> { ... }

// timeout.ts
export function timeout<A, E, R>(
  duration: string | number
): (
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<
  A,
  E | StorageError | WorkflowTimeoutError,
  R | StepContext | RuntimeAdapter | WorkflowContext | WorkflowLevel  // Added
> { ... }
```

### Step 4: Update step() to Exclude WorkflowLevel from Inner Effect

The key is that `step()` provides services to its inner effect but explicitly does NOT provide `WorkflowLevel`:

```typescript
// step.ts

export function step<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  E | StorageError | StepCancelledError | WorkflowScopeError,
  | WorkflowContext
  | StorageAdapter
  | RuntimeAdapter
  | WorkflowLevel
  | Exclude<R, StepContext | StorageAdapter | RuntimeAdapter | StepScope | WorkflowLevel>
> {
  return Effect.gen(function* () {
    // ... existing implementation

    // Build layer that provides step dependencies but NOT WorkflowLevel
    const stepLayer = Layer.mergeAll(
      Layer.succeed(StepContext, stepCtx),
      Layer.succeed(StepScope, stepScopeService),
      Layer.succeed(StorageAdapter, storage),
      Layer.succeed(RuntimeAdapter, runtime)
      // NOTE: WorkflowLevel is NOT provided here
    );

    const result = yield* effect.pipe(Effect.provide(stepLayer));
    // ...
  });
}
```

### Step 5: Provide WorkflowLevel at Execution Time

In the executor, provide `WorkflowLevel` when running the workflow:

```typescript
// executor/executor.ts

const workflowLevelLayer = Layer.succeed(WorkflowLevel, { _brand: "workflow-level" });

// Add to the layer stack when executing
const result = yield* definition.execute(context.input).pipe(
  Effect.provide(workflowLevelLayer),
  // ... other layers
);
```

## How It Works

### Valid Usage (Compiles)

```typescript
const workflow = Workflow.make((input: string) =>
  Effect.gen(function* () {
    // At workflow level - WorkflowLevel is provided
    yield* Workflow.step("Step 1", doSomething());  // ✓ Requires WorkflowLevel, has it
    yield* Workflow.sleep("1 second");               // ✓ Requires WorkflowLevel, has it
  })
);
```

### Invalid Usage (Compile Error)

```typescript
const workflow = Workflow.make((input: string) =>
  Effect.gen(function* () {
    yield* Workflow.step("Outer",
      Effect.gen(function* () {
        // Inside step - WorkflowLevel is NOT provided
        yield* Workflow.sleep("1 second");  // ✗ Requires WorkflowLevel, doesn't have it
        // Error: Property 'WorkflowLevel' is missing in type...
      })
    );
  })
);
```

### Error Message

The TypeScript error would look something like:

```
Argument of type 'Effect<void, PauseSignal, WorkflowContext | WorkflowLevel>'
is not assignable to parameter of type 'Effect<void, PauseSignal, WorkflowContext>'.
  Type 'WorkflowContext | WorkflowLevel' is not assignable to type 'WorkflowContext'.
    Type 'WorkflowLevel' is not assignable to type 'WorkflowContext'.
```

## Alternative: Custom Error Message Type

For a clearer error message, we could use a conditional type:

```typescript
// Helper that produces a string literal type error
type ForbidStepNesting<R> = WorkflowLevel extends R
  ? R
  : "Error: Cannot use Workflow.step(), sleep(), retry(), or timeout() inside a step";

// step signature with clearer error
export function step<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, ForbidStepNesting<R>>
): Effect.Effect<...>
```

When `R` includes `WorkflowLevel` (from an inner sleep/step call), the parameter type becomes a string literal, causing a type mismatch with a helpful message.

## Files to Modify

1. **Create** `src/context/workflow-level.ts` - New marker service
2. **Update** `src/context/index.ts` - Export new module
3. **Update** `src/primitives/step.ts` - Add WorkflowLevel requirement
4. **Update** `src/primitives/sleep.ts` - Add WorkflowLevel requirement
5. **Update** `src/executor/executor.ts` - Provide WorkflowLevel when executing
6. **Update** `src/index.ts` - Export new types

**Note**: `retry` and `timeout` do NOT need WorkflowLevel - they are specifically designed to be used inside steps.

## Minimal Changes Summary

The changes are additive and localized:

1. **Add one new file** (~40 lines) - The WorkflowLevel marker
2. **Add one requirement** to 3 functions - step, sleep, sleepUntil
3. **Add one layer** in executor - Provide WorkflowLevel

No changes to:
- Runtime behavior (existing runtime checks remain as fallback)
- User-facing API
- Workflow definition syntax
- Client API

## Testing the Implementation

```typescript
// test/compile-time-scope.test.ts

// This file should NOT compile - used to verify type errors work
// Run with: tsc --noEmit

import { Effect } from "effect";
import { Workflow } from "../src";

// Should compile ✓
const validWorkflow = Workflow.make((input: string) =>
  Effect.gen(function* () {
    yield* Workflow.step("Step", Effect.succeed("ok"));
    yield* Workflow.sleep("1 second");
  })
);

// Should NOT compile ✗
const invalidWorkflow = Workflow.make((input: string) =>
  Effect.gen(function* () {
    yield* Workflow.step("Outer",
      Effect.gen(function* () {
        // @ts-expect-error - WorkflowLevel not available inside step
        yield* Workflow.sleep("1 second");
      })
    );
  })
);
```

## Rollout

1. Implement the changes
2. Run existing tests to ensure runtime behavior unchanged
3. Add compile-time test file with `@ts-expect-error` annotations
4. Update documentation to mention compile-time checking
