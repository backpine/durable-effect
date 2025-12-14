# Report 039: "workflowDef.definition is not a function" Error

## Error Message

```
TypeError: workflowDef.definition is not a function
    at index.js:33332:43
```

With accompanying failure message:
```
Step "Process payment" failed after 21 attempts: ...
```

## Root Cause

This error occurs due to **API migration mismatch**. The workflow was defined using the **old API format** but the runtime expects the **new API format**.

### Old API (Deprecated)

```typescript
// OLD - No longer works
const myWorkflow = {
  name: "myWorkflow",
  definition: (input: { orderId: string }) =>
    Effect.gen(function* () {
      // workflow logic
    })
};
```

### New API (Current)

```typescript
// NEW - Correct format
const myWorkflow = Workflow.make(
  (input: { orderId: string }) =>
    Effect.gen(function* () {
      // workflow logic
    })
);
```

## Why This Happens

The executor (`packages/workflow/src/executor/executor.ts:96-97`) calls:

```typescript
const exit = yield* definition
  .execute(context.input as Input)
```

The `WorkflowDefinition` interface expects an `execute` method:

```typescript
// packages/workflow/src/jobs/make.ts
export interface WorkflowDefinition<Input, Output, Error, Requirements> {
  readonly _tag: "WorkflowDefinition";
  readonly execute: (input: Input) => Effect.Effect<...>;
  // ...
}
```

When using `Workflow.make()`, this structure is created correctly:

```typescript
export function make<Input, Output, Error, Requirements>(
  execute: WorkflowEffect<Input, Output, Error, Requirements>
): WorkflowDefinition<...> {
  return {
    _tag: "WorkflowDefinition",
    execute,  // <-- The execute method
    // ...
  };
}
```

However, if you pass an object with a `definition` property (old format), there is no `execute` method, causing the runtime error.

## Resolution

### Option 1: Update Workflow Definition (Recommended)

Convert from old format to new format:

```typescript
// Before (old)
const workflows = {
  processPayment: {
    name: "processPayment",
    definition: (input: { amount: number }) =>
      Effect.gen(function* () {
        yield* Workflow.step("charge", chargeCard(input.amount));
        return { success: true };
      })
  }
};

// After (new)
const workflows = {
  processPayment: Workflow.make(
    (input: { amount: number }) =>
      Effect.gen(function* () {
        yield* Workflow.step("charge", chargeCard(input.amount));
        return { success: true };
      })
  )
};
```

### Option 2: Add Migration Shim (Temporary)

If you need backward compatibility during migration, you could add a runtime check in the executor, though this is not recommended for production:

```typescript
// In executor.ts - NOT RECOMMENDED for long-term
const executeMethod = typeof definition.execute === 'function'
  ? definition.execute
  : (definition as any).definition;

if (typeof executeMethod !== 'function') {
  throw new Error('Invalid workflow definition: missing execute or definition method');
}
```

## Key Changes from Old to New API

| Aspect | Old API | New API |
|--------|---------|---------|
| Factory | Plain object | `Workflow.make()` |
| Method name | `definition` | `execute` |
| Name source | `name` property | Registry key |
| Type tag | None | `_tag: "WorkflowDefinition"` |

## Why the Retry Happens

The error message mentions "failed after 21 attempts" because:

1. The error `workflowDef.definition is not a function` is a JavaScript `TypeError`
2. This error is caught by the retry logic
3. The retry logic doesn't recognize it as a non-retryable error
4. It retries until `maxAttempts` is exhausted

**Note:** After the fix in `packages/workflow/src/jobs/retry.ts`, `StepScopeError` is now treated as non-retryable. However, this particular `TypeError` (from API mismatch) would still be retried since it's not a `StepScopeError`.

## Recommendations

1. **Use TypeScript strictly** - The new API provides better type inference and will catch this at compile time if types are properly configured

2. **Check workflow definitions** - Ensure all workflows use `Workflow.make()`:
   ```typescript
   import { Workflow } from "@durable-effect/workflow";

   const myWorkflow = Workflow.make((input) => ...);
   ```

3. **Validate at startup** - Consider adding validation when registering workflows:
   ```typescript
   function validateWorkflowDefinition(def: unknown): def is WorkflowDefinition {
     return def !== null
       && typeof def === 'object'
       && '_tag' in def
       && def._tag === 'WorkflowDefinition'
       && 'execute' in def
       && typeof def.execute === 'function';
   }
   ```
