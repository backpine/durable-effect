# Forbid Workflow Primitives Inside Steps

## Problem

Currently, workflow primitives (`Workflow.step`, `Workflow.sleep`, `Workflow.retry`) can be accidentally nested inside a step's effect:

```typescript
const fetchOrder = (orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Fetching order ${orderId}...`);
    yield* Workflow.sleep("10 seconds");  // ❌ Should not be allowed inside a step
    yield* Workflow.step("nested", Effect.succeed(true));  // ❌ Should not be allowed
    return { id: orderId, amount: 99.99 };
  });

// Later, used in a step - this compiles but is semantically wrong
yield* Workflow.step("Fetch order", fetchOrder(orderId));
```

This is problematic because:
1. Workflow primitives have special semantics (pause points, durability)
2. Nesting breaks the execution model (steps should be atomic units)
3. It leads to confusing behavior and potential bugs

## Goal

Make TypeScript reject workflow primitives inside step effects at compile time.

## Design Options

### Option 1: Forbidden Context Tag (Recommended)

Use Effect's context system to create a compile-time guard.

**Concept:**
1. Create a `WorkflowScope` context tag that workflow primitives require
2. Inside a step, the effect type explicitly excludes `WorkflowScope`
3. If the inner effect requires `WorkflowScope`, TypeScript errors

**Implementation:**

```typescript
// packages/workflow/src/scope.ts

import { Context } from "effect";

/**
 * WorkflowScope is required by workflow primitives (step, sleep, retry).
 * This scope is NOT available inside a step's effect, preventing nesting.
 */
export class WorkflowScope extends Context.Tag("@durable-effect/WorkflowScope")<
  WorkflowScope,
  { readonly _brand: "WorkflowScope" }
>() {}

/**
 * Type-level guard that forbids WorkflowScope in R.
 * If R includes WorkflowScope, this evaluates to `never`.
 */
export type ForbidWorkflowScope<R> =
  [WorkflowScope] extends [R] ? never :
  R extends WorkflowScope ? never :
  R;
```

**Update workflow primitives:**

```typescript
// packages/workflow/src/sleep.ts

export const sleep = (
  duration: Duration.DurationInput
): Effect.Effect<void, PauseSignal, WorkflowScope | WorkflowContext> =>
  Effect.gen(function* () {
    // ... existing implementation
  });
```

**Update step signature:**

```typescript
// packages/workflow/src/step.ts

export const step = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, ForbidWorkflowScope<R>>,
): Effect.Effect<A, E | StepError | PauseSignal, WorkflowScope | WorkflowContext | R> =>
  // ... existing implementation
```

**How it works:**

```typescript
// Workflow.sleep returns Effect<void, PauseSignal, WorkflowScope | WorkflowContext>
const badEffect = Effect.gen(function* () {
  yield* Workflow.sleep("10 seconds");  // Requires WorkflowScope
  return { id: "123" };
});
// badEffect :: Effect<{ id: string }, PauseSignal, WorkflowScope | WorkflowContext>

// Now try to use in a step:
Workflow.step("bad", badEffect);
//                   ^^^^^^^^^
// Error: Argument of type 'Effect<..., WorkflowScope | WorkflowContext>'
// is not assignable to parameter of type 'Effect<..., never>'
// Type 'WorkflowScope' is not assignable to type 'never'.

// Good effect (no workflow primitives)
const goodEffect = Effect.gen(function* () {
  yield* Effect.sleep("100 millis");  // Regular Effect.sleep is fine
  yield* Effect.log("Fetching...");
  return { id: "123" };
});
// goodEffect :: Effect<{ id: string }, never, never>

Workflow.step("good", goodEffect);  // ✅ Compiles!
```

**Providing WorkflowScope at the workflow level:**

```typescript
// In engine.ts or workflow execution

const workflowScopeLayer = Layer.succeed(WorkflowScope, { _brand: "WorkflowScope" as const });

// Workflow definition now requires WorkflowScope
const execution = workflowDef
  .definition(input)
  .pipe(
    Effect.provide(workflowScopeLayer),  // Provided at workflow level
    Effect.provideService(ExecutionContext, execCtx),
    Effect.provideService(WorkflowContext, workflowCtx),
  );
```

### Option 2: Branded Effect Type

Create a distinct type for workflow-level effects.

```typescript
// A branded type that can only be created by workflow primitives
declare const WorkflowEffectBrand: unique symbol;

type WorkflowEffect<A, E, R> = Effect.Effect<A, E, R> & {
  readonly [WorkflowEffectBrand]: true;
};

// Workflow.sleep returns WorkflowEffect
export const sleep = (duration: DurationInput): WorkflowEffect<void, PauseSignal, WorkflowContext> => ...

// Step takes regular Effect, not WorkflowEffect
export const step = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,  // Not WorkflowEffect
): WorkflowEffect<A, E | StepError, R | WorkflowContext> => ...
```

**Pros:** Very explicit branding
**Cons:** Doesn't compose well with Effect's type system, requires casting

### Option 3: Two-Phase Context

Split context into "workflow phase" and "step phase":

```typescript
class WorkflowPhase extends Context.Tag("WorkflowPhase")<WorkflowPhase, void>() {}
class StepPhase extends Context.Tag("StepPhase")<StepPhase, void>() {}

// Workflow primitives require WorkflowPhase
export const sleep = (...): Effect<..., WorkflowPhase> => ...

// Step provides StepPhase and removes WorkflowPhase
export const step = <A, E, R>(
  name: string,
  effect: Effect<A, E, R>,  // R cannot require WorkflowPhase
): Effect<A, E, WorkflowPhase | Exclude<R, StepPhase>> =>
  Effect.gen(function* () {
    // Run inner effect WITHOUT WorkflowPhase context
    const result = yield* effect.pipe(
      Effect.provideService(StepPhase, undefined),
      // WorkflowPhase is NOT provided here
    );
    return result;
  });
```

**Pros:** Clear phase distinction
**Cons:** More complex, requires careful context management

## Recommended Approach: Option 1

Option 1 (Forbidden Context Tag) is recommended because:

1. **Minimal changes** - Only need to add `WorkflowScope` to primitive return types
2. **Clear error messages** - TypeScript shows which service is forbidden
3. **Composable** - Works naturally with Effect's context system
4. **No runtime overhead** - Pure compile-time checking

## Implementation Plan

### 1. Create WorkflowScope

```typescript
// packages/workflow/src/scope.ts
import { Context } from "effect";

export class WorkflowScope extends Context.Tag("@durable-effect/WorkflowScope")<
  WorkflowScope,
  { readonly _brand: "WorkflowScope" }
>() {}

export type ForbidWorkflowScope<R> =
  [WorkflowScope] extends [R] ? never :
  R extends WorkflowScope ? never :
  R;
```

### 2. Update Primitives

Add `WorkflowScope` to the context requirements:

| Primitive | Before | After |
|-----------|--------|-------|
| `sleep` | `Effect<void, PauseSignal, WorkflowContext>` | `Effect<void, PauseSignal, WorkflowScope \| WorkflowContext>` |
| `step` (outer) | `Effect<A, E, WorkflowContext>` | `Effect<A, E, WorkflowScope \| WorkflowContext>` |
| `retry` | `Effect<A, E, R>` | `Effect<A, E, WorkflowScope \| R>` |

### 3. Update Step Signature

```typescript
export const step = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, ForbidWorkflowScope<R>>,
): Effect.Effect<A, E | StepError | PauseSignal, WorkflowScope | WorkflowContext | R>
```

### 4. Provide WorkflowScope in Engine

```typescript
// engine.ts
const workflowScopeLayer = Layer.succeed(WorkflowScope, { _brand: "WorkflowScope" as const });

// In #executeWorkflow
const execution = Effect.gen(function* () {
  // ...
}).pipe(
  Effect.provide(workflowScopeLayer),
  Effect.provide(this.#trackerLayer),
);
```

### 5. Update Exports

```typescript
// packages/workflow/src/index.ts
export { WorkflowScope, type ForbidWorkflowScope } from "./scope";
```

## Error Messages

With this approach, users get clear error messages:

```typescript
const badStep = Workflow.step("bad", Effect.gen(function* () {
  yield* Workflow.sleep("1 second");
  //     ^^^^^^^^^^^^^^^^^^^^^^^^
  // Error: Type 'WorkflowScope' is not assignable to type 'never'.
  //
  // The inner effect of a step cannot use workflow primitives.
  // Move Workflow.sleep() outside the step.
}));
```

## Migration

Existing code using workflow primitives inside steps will get compile errors. The fix is straightforward:

```typescript
// Before (wrong)
yield* Workflow.step("process", Effect.gen(function* () {
  yield* Workflow.sleep("1 second");  // ❌
  return process();
}));

// After (correct)
yield* Workflow.sleep("1 second");  // ✅ At workflow level
yield* Workflow.step("process", Effect.gen(function* () {
  return process();
}));
```

## Summary

Using `WorkflowScope` as a forbidden context tag provides compile-time enforcement that workflow primitives can only be used at the workflow level, not inside steps. This aligns with the semantic model where steps are atomic units and workflow primitives (sleep, nested steps) are coordination points between steps.
