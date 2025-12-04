/**
 * Type-level tests for WorkflowScope forbidden context pattern.
 *
 * These tests verify compile-time behavior - they should type-check correctly.
 * Run with: pnpm tsc --noEmit
 */
import { Effect, Context } from "effect";

// =============================================================================
// Mock WorkflowScope implementation (mirrors proposed design)
// =============================================================================

class WorkflowScope extends Context.Tag("@durable-effect/WorkflowScope")<
  WorkflowScope,
  { readonly _brand: "WorkflowScope" }
>() {}

class WorkflowContext extends Context.Tag("Workflow/Context")<
  WorkflowContext,
  { readonly workflowId: string }
>() {}

class StepContext extends Context.Tag("Workflow/StepContext")<
  StepContext,
  { readonly stepName: string }
>() {}

// The key type - forbids WorkflowScope in the context requirements
type ForbidWorkflowScope<R> = WorkflowScope extends R ? never : R;

// =============================================================================
// Mock primitives with proposed signatures
// =============================================================================

declare function sleep(
  duration: string,
): Effect.Effect<void, Error, WorkflowScope | WorkflowContext>;

declare function step<T, E, R>(
  name: string,
  effect: Effect.Effect<T, E, ForbidWorkflowScope<R>>,
): Effect.Effect<
  T,
  E | Error,
  WorkflowScope | WorkflowContext | Exclude<R, StepContext>
>;

// =============================================================================
// Test Cases
// =============================================================================

// Test 1: Regular effect inside step - SHOULD PASS
{
  const regularEffect = Effect.succeed({ id: "123" });
  // Type: Effect<{ id: string }, never, never>

  const result = step("test", regularEffect);
  // Should compile ✓
}

// Test 2: Effect with other context inside step - SHOULD PASS
{
  interface MyServiceInterface {
    readonly fetch: () => Promise<string>;
  }
  class MyService extends Context.Tag("MyService")<MyService, MyServiceInterface>() {}

  const effectWithService = Effect.gen(function* () {
    const svc = yield* MyService;
    return svc.fetch();
  });
  // Type: Effect<Promise<string>, never, MyService>

  const result = step("test", effectWithService);
  // Should compile ✓ - MyService is not WorkflowScope
}

// Test 3: Effect using sleep at workflow level - SHOULD PASS
{
  const workflowLevelEffect = Effect.gen(function* () {
    yield* sleep("1 second");
    const data = yield* step("fetch", Effect.succeed({ id: "123" }));
    yield* sleep("1 second");
    return data;
  });
  // Type: Effect<{ id: string }, Error, WorkflowScope | WorkflowContext>
  // This is fine at workflow level ✓
}

// Test 4: Effect.sleep (standard library) inside step - SHOULD PASS
{
  const effectWithStandardSleep = Effect.gen(function* () {
    yield* Effect.sleep("100 millis");
    yield* Effect.log("Done");
    return { processed: true };
  });
  // Type: Effect<{ processed: true }, never, never>

  const result = step("test", effectWithStandardSleep);
  // Should compile ✓ - Effect.sleep doesn't require WorkflowScope
}

// =============================================================================
// These should produce type errors (uncomment to verify)
// =============================================================================

// Test 5: Workflow.sleep inside step - SHOULD FAIL
{
  const badEffect = Effect.gen(function* () {
    yield* sleep("1 second");  // Adds WorkflowScope to requirements
    return { id: "123" };
  });
  // Type: Effect<{ id: string }, Error, WorkflowScope | WorkflowContext>

  // @ts-expect-error - WorkflowScope is forbidden inside step
  const result = step("bad", badEffect);
}

// Test 6: Nested step - SHOULD FAIL
{
  const nestedStep = Effect.gen(function* () {
    const inner = yield* step("inner", Effect.succeed(1));
    return inner;
  });
  // Type: Effect<number, Error, WorkflowScope | WorkflowContext>

  // @ts-expect-error - WorkflowScope is forbidden inside step
  const result = step("outer", nestedStep);
}

// Test 7: Direct sleep in step - SHOULD FAIL
{
  // @ts-expect-error - WorkflowScope is forbidden inside step
  const result = step("bad", sleep("1 second"));
}

// =============================================================================
// Verify the ForbidWorkflowScope type behavior
// =============================================================================

// Type-level assertions
type Assert<T extends true> = T;
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// When R includes WorkflowScope, result should be never
type Test1 = ForbidWorkflowScope<WorkflowScope>;
type _t1 = Assert<Equals<Test1, never>>;

type Test2 = ForbidWorkflowScope<WorkflowScope | WorkflowContext>;
type _t2 = Assert<Equals<Test2, never>>;

// When R doesn't include WorkflowScope, result should be R
type Test3 = ForbidWorkflowScope<WorkflowContext>;
type _t3 = Assert<Equals<Test3, WorkflowContext>>;

type Test4 = ForbidWorkflowScope<never>;
type _t4 = Assert<Equals<Test4, never>>;

type Test5 = ForbidWorkflowScope<WorkflowContext | StepContext>;
type _t5 = Assert<Equals<Test5, WorkflowContext | StepContext>>;

console.log("Type tests passed!");
