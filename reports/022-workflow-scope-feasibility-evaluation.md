# WorkflowScope Feasibility Evaluation & Rollout Plan

## Executive Summary

This report evaluates the feasibility of implementing a `WorkflowScope` forbidden context tag to prevent workflow primitives (`step`, `sleep`, `retry`) from being nested inside a step's effect. After thorough analysis of the codebase and TypeScript's type system behavior, **Option 1 is feasible with some caveats**.

## Current State Analysis

### Existing Primitive Signatures

From `packages/workflow/src/workflow.ts`:

```typescript
// Workflow.step
export function step<T, E, R>(
  name: string,
  effect: Effect.Effect<T, E, R>,
): Effect.Effect<
  T,
  E | StepError | PauseSignal | UnknownException,
  Exclude<R, StepContext> | ExecutionContext | WorkflowContext
>

// Workflow.sleep
export function sleep(
  duration: Duration.DurationInput,
): Effect.Effect<
  void,
  PauseSignal | UnknownException,
  ExecutionContext | WorkflowContext
>

// Workflow.retry (higher-order)
export function retry<T, E, R>(
  options: RetryOptions,
): (
  effect: Effect.Effect<T, E, R>,
) => Effect.Effect<
  T,
  E | PauseSignal | UnknownException,
  R | ExecutionContext | StepContext | WorkflowContext
>

// Workflow.timeout (higher-order)
export function timeout<T, E, R>(
  duration: Duration.DurationInput,
): (
  effect: Effect.Effect<T, E, R>,
) => Effect.Effect<
  T,
  E | StepTimeoutError | UnknownException,
  R | ExecutionContext | StepContext | WorkflowContext
>
```

### Key Observation: retry and timeout REQUIRE StepContext

The current design already enforces that `retry` and `timeout` **must** be used inside a step:

```typescript
// workflow.ts:234-236
const ctx = yield* ExecutionContext;
const stepCtx = yield* StepContext;  // ← REQUIRES StepContext
const workflowCtx = yield* WorkflowContext;
```

This means `retry` and `timeout` already fail at runtime if used outside a step. The WorkflowScope pattern would add **compile-time** enforcement for `step` and `sleep` primitives.

## Type System Analysis

### The ForbidWorkflowScope Type

The proposed type:

```typescript
export type ForbidWorkflowScope<R> =
  [WorkflowScope] extends [R] ? never :
  R extends WorkflowScope ? never :
  R;
```

**Issue: This type has subtle problems.**

Let me trace through the behavior:

#### Case 1: R = `WorkflowScope | WorkflowContext`
```
[WorkflowScope] extends [WorkflowScope | WorkflowContext]
= false (tuple types don't extend union tuples this way)

R extends WorkflowScope
= (WorkflowScope extends WorkflowScope) | (WorkflowContext extends WorkflowScope)
= true | false (distributive)
= Result: (never | WorkflowContext) = WorkflowContext  ← WRONG! Should be never
```

#### The Problem

TypeScript's distributive conditional types mean `R extends WorkflowScope` distributes over unions, which doesn't give us the behavior we want.

### Correct Implementation

The correct approach uses the **extends direction**:

```typescript
export type ForbidWorkflowScope<R> = WorkflowScope extends R ? never : R;
```

Trace:
- `R = WorkflowScope | WorkflowContext`
- `WorkflowScope extends (WorkflowScope | WorkflowContext)` → **true** (member of union)
- Result: `never` ✓

- `R = WorkflowContext`
- `WorkflowScope extends WorkflowContext` → **false** (different tags)
- Result: `WorkflowContext` ✓

- `R = never`
- `WorkflowScope extends never` → **false**
- Result: `never` ✓

**This version works correctly!**

## Implementation Plan

### Phase 1: Create WorkflowScope Service

**File:** `packages/workflow/src/services/workflow-scope.ts`

```typescript
import { Context } from "effect";

/**
 * WorkflowScope is required by workflow primitives (step, sleep).
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
 *
 * @example
 * ```typescript
 * // R = WorkflowScope | WorkflowContext → never (forbidden)
 * // R = WorkflowContext → WorkflowContext (allowed)
 * // R = never → never (allowed, no requirements)
 * ```
 */
export type ForbidWorkflowScope<R> = WorkflowScope extends R ? never : R;
```

### Phase 2: Update Primitive Signatures

**File:** `packages/workflow/src/workflow.ts`

```typescript
import { WorkflowScope, ForbidWorkflowScope } from "@/services/workflow-scope";

// sleep - add WorkflowScope to requirements
export function sleep(
  duration: Duration.DurationInput,
): Effect.Effect<
  void,
  PauseSignal | UnknownException,
  WorkflowScope | ExecutionContext | WorkflowContext  // ← Added WorkflowScope
>

// step - forbid WorkflowScope in inner effect, require it for outer
export function step<T, E, R>(
  name: string,
  effect: Effect.Effect<T, E, ForbidWorkflowScope<R>>,  // ← Forbid WorkflowScope
): Effect.Effect<
  T,
  E | StepError | PauseSignal | UnknownException,
  WorkflowScope | Exclude<R, StepContext> | ExecutionContext | WorkflowContext  // ← Added WorkflowScope
>
```

**Note:** `retry` and `timeout` don't need changes because they already require `StepContext`, which is only available inside a step.

### Phase 3: Provide WorkflowScope in Engine

**File:** `packages/workflow/src/engine.ts`

```typescript
import { Layer } from "effect";
import { WorkflowScope } from "@/services/workflow-scope";

// Create the layer (compile-time only, runtime value is never used)
const WorkflowScopeLayer = Layer.succeed(WorkflowScope, { _brand: "WorkflowScope" as const });

// In #executeWorkflow
const execution = Effect.gen(function* () {
  yield* transitionWorkflow(storage, workflowId, workflowName, transition, executionId);

  const result = yield* workflowDef
    .definition(input)
    .pipe(
      Effect.provideService(ExecutionContext, execCtx),
      Effect.provideService(WorkflowContext, workflowCtx),
      // WorkflowScope provided at top level
      Effect.provideService(WorkflowScope, { _brand: "WorkflowScope" as const }),
      Effect.exit,
    );
  // ...
}).pipe(Effect.provide(this.#trackerLayer));
```

### Phase 4: Update Types

**File:** `packages/workflow/src/types.ts`

```typescript
import type { WorkflowScope } from "@/services/workflow-scope";

/**
 * Context requirements provided by the workflow engine.
 */
export type ProvidedContext = WorkflowScope | WorkflowContext | ExecutionContext;
```

### Phase 5: Update Exports

**File:** `packages/workflow/src/services/index.ts`

```typescript
export { WorkflowScope, type ForbidWorkflowScope } from "./workflow-scope";
```

**File:** `packages/workflow/src/index.ts`

```typescript
export {
  WorkflowContext,
  StepContext,
  WorkflowScope,
  type WorkflowContextService,
  type StepContextService,
  type ForbidWorkflowScope,
} from "@/services";
```

### Phase 6: Update Test Mocks

**File:** `packages/workflow/test/mocks/contexts.ts`

The test harness needs to provide `WorkflowScope` when testing workflow-level primitives.

```typescript
import { WorkflowScope } from "@/services/workflow-scope";

export function runWithWorkflowScope<T, E>(
  effect: Effect.Effect<T, E, WorkflowScope | ExecutionContext | WorkflowContext>,
) {
  return effect.pipe(
    Effect.provideService(ExecutionContext, executionContext),
    Effect.provideService(WorkflowContext, workflowContext),
    Effect.provideService(WorkflowScope, { _brand: "WorkflowScope" as const }),
  );
}
```

## Feasibility Concerns

### 1. **Composability with User Effects**

Users who create helper functions that internally use workflow primitives will get the correct error:

```typescript
// User's helper function
const myHelper = (id: string) => Effect.gen(function* () {
  yield* Workflow.sleep("1 second");  // ← Adds WorkflowScope to R
  return { id };
});
// Type: Effect<{ id: string }, PauseSignal, WorkflowScope | ...>

// Using in a step - COMPILE ERROR
yield* Workflow.step("bad", myHelper("123"));
// Error: Type 'WorkflowScope' is not assignable to type 'never'
```

**This is the desired behavior.**

### 2. **Error Message Clarity**

The TypeScript error will be:

```
Argument of type 'Effect<..., WorkflowScope | WorkflowContext>' is not
assignable to parameter of type 'Effect<..., never>'
  Type 'WorkflowScope' is not assignable to type 'never'.
```

This is reasonably clear but could be improved with documentation.

### 3. **No Runtime Overhead**

`WorkflowScope` is purely a compile-time construct. The runtime value `{ _brand: "WorkflowScope" }` is never actually used - it just satisfies TypeScript's requirement that a context tag has a value.

### 4. **Backward Compatibility**

**Breaking change**: Any existing code that accidentally nests workflow primitives inside steps will now fail to compile. This is intentional and desirable - it surfaces bugs.

### 5. **Effect's Context Union Behavior**

Effect accumulates context requirements as unions. When you `yield*` multiple effects with different context requirements, they combine:

```typescript
Effect.gen(function* () {
  yield* effectRequiringA;  // R = A
  yield* effectRequiringB;  // R = A | B
  yield* effectRequiringC;  // R = A | B | C
});
```

The `ForbidWorkflowScope<R>` correctly handles this - if ANY yielded effect requires `WorkflowScope`, the whole generator requires it, and it will be forbidden.

## Files to Change

| File | Change |
|------|--------|
| `packages/workflow/src/services/workflow-scope.ts` | **NEW** - Create WorkflowScope and ForbidWorkflowScope |
| `packages/workflow/src/services/index.ts` | Export new module |
| `packages/workflow/src/workflow.ts` | Update `step` and `sleep` signatures |
| `packages/workflow/src/engine.ts` | Provide WorkflowScope in execution |
| `packages/workflow/src/types.ts` | Update ProvidedContext type |
| `packages/workflow/src/index.ts` | Export WorkflowScope |
| `packages/workflow/test/mocks/contexts.ts` | Add WorkflowScope to test contexts |
| `packages/workflow/test/step.test.ts` | May need updates for new context |
| `packages/workflow/test/sleep.test.ts` | May need updates for new context |

## Edge Cases to Test

### 1. **Nested Workflow Primitives (Should Fail)**

```typescript
// Should produce compile error
Workflow.step("outer", Effect.gen(function* () {
  yield* Workflow.step("inner", Effect.succeed(1));  // ❌
}));

Workflow.step("outer", Effect.gen(function* () {
  yield* Workflow.sleep("1 second");  // ❌
}));
```

### 2. **Regular Effects Inside Step (Should Pass)**

```typescript
// Should compile fine
Workflow.step("fetch", Effect.gen(function* () {
  yield* Effect.sleep("100 millis");  // ✓ Regular Effect.sleep
  yield* Effect.log("Fetching...");   // ✓
  return fetch("/api/data");
}));
```

### 3. **Workflow Primitives at Workflow Level (Should Pass)**

```typescript
// Should compile fine
const myWorkflow = Workflow.make("test", () => Effect.gen(function* () {
  yield* Workflow.sleep("1 second");  // ✓ At workflow level
  yield* Workflow.step("fetch", fetchData());  // ✓
  yield* Workflow.sleep("1 second");  // ✓
}));
```

### 4. **retry and timeout Inside Step (Should Pass)**

```typescript
// Should compile fine - retry/timeout are MEANT to be inside steps
yield* Workflow.step("payment",
  processPayment(order).pipe(
    Workflow.retry({ maxAttempts: 3 }),  // ✓
    Workflow.timeout("30 seconds"),      // ✓
  )
);
```

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Type system edge cases | Low | Medium | Comprehensive test suite |
| Error message confusion | Medium | Low | Good documentation |
| Test suite updates | High | Low | Update affected tests |
| Breaking user code | Medium | Medium | Desired behavior - surfaces bugs |

## Proof of Concept Validation

A type-level test file was created at `packages/workflow/test/type-tests/workflow-scope.test-d.ts` to validate the approach.

### Validated Scenarios

**Passing cases (should compile):**
- Regular effects inside step
- Effects with custom services inside step (e.g., `MyService`)
- `Effect.sleep` (standard library) inside step
- Workflow primitives at workflow level

**Failing cases (correctly rejected with `@ts-expect-error`):**
- `Workflow.sleep("1 second")` inside step - **Correctly rejected**
- Nested `Workflow.step` inside step - **Correctly rejected**
- Direct `sleep(...)` passed to `step(...)` - **Correctly rejected**

### Type Assertions

```typescript
// All assertions pass at compile time
type Test1 = ForbidWorkflowScope<WorkflowScope>;
// → never ✓

type Test2 = ForbidWorkflowScope<WorkflowScope | WorkflowContext>;
// → never ✓

type Test3 = ForbidWorkflowScope<WorkflowContext>;
// → WorkflowContext ✓

type Test4 = ForbidWorkflowScope<never>;
// → never ✓

type Test5 = ForbidWorkflowScope<WorkflowContext | StepContext>;
// → WorkflowContext | StepContext ✓
```

**Result:** `pnpm typecheck` passes with all tests, confirming the approach is sound.

## Conclusion

**Option 1 is feasible** with the corrected `ForbidWorkflowScope` type:

```typescript
export type ForbidWorkflowScope<R> = WorkflowScope extends R ? never : R;
```

The implementation is relatively straightforward:
1. ~30 lines for new `workflow-scope.ts`
2. ~10 lines changed in `workflow.ts`
3. ~5 lines changed in `engine.ts`
4. ~10 lines changed in types/exports
5. ~20 lines in test mocks

**Total: ~75 lines of changes**

The approach leverages Effect's existing context system and provides compile-time safety with zero runtime overhead. The main trade-off is that error messages, while accurate, could be more user-friendly. This can be addressed through documentation and examples.

## Recommended Next Steps

1. Create `workflow-scope.ts` with the service and type
2. Update `workflow.ts` signatures
3. Update `engine.ts` to provide WorkflowScope
4. Update test mocks
5. Run full test suite to catch any issues
6. Add compile-time tests to verify the forbidden pattern works
7. Update documentation with examples
