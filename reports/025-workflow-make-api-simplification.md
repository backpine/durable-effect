# Report 025: Workflow.make API Simplification

## Summary

The `Workflow.make` function accepts a `name` string parameter that is **never used**. The actual workflow name used throughout the system comes from the registry key. This report proposes removing the unused parameter.

## Problem Statement

### Current API

```typescript
const workflows = {
  processOrder: Workflow.make(
    "processOrder",  // <-- NEVER USED
    (orderId: string) =>
      Effect.gen(function* () {
        yield* Workflow.step("Fetch", fetchOrder(orderId));
      })
  ),
} as const;
```

### The String Parameter is Never Used

The workflow name used in events, context, and dispatch comes from the **registry key**, not from the string parameter:

```typescript
const workflows = {
  processOrder: Workflow.make("sendEmail", ...),  // Mismatch! No error.
};

// When called: client.run({ workflow: "processOrder", input: ... })
// Events will show: workflowName: "processOrder" (the registry key)
// NOT "sendEmail" (the string parameter)
```

### Proof: How workflowName Actually Flows

**1. Client call provides the registry key:**
```typescript
// client/types.ts:52-58
export type WorkflowRunRequest<W extends WorkflowRegistry> = {
  [K in keyof W & string]: {
    readonly workflow: K;  // <-- Registry key
    readonly input: WorkflowInput<W[K]>;
  };
}[keyof W & string];
```

**2. Engine uses registry key as workflowName:**
```typescript
// engine.ts:211-212
async run(call: WorkflowCall<T>): Promise<WorkflowRunResult> {
  const { workflow: workflowName, input, executionId } = call;  // <-- From registry key
```

**3. Engine looks up by registry key:**
```typescript
// engine.ts:230
const workflowDef = this.#workflows[workflowName];  // <-- Registry key lookup
```

**4. Registry key passed to context and events:**
```typescript
// engine.ts:237-243
await Effect.runPromise(
  storeWorkflowMeta(
    this.ctx.storage,
    String(workflowName),  // <-- Registry key stored
    input,
    executionId,
  ),
);
```

**5. The `workflowDef.name` property is NEVER read:**
```typescript
// Searching for "workflowDef.name" in engine.ts: 0 results
// The .name property on DurableWorkflow is completely unused
```

## What Changes

### Only `Workflow.make` Signature

The internal `workflowName` handling is correct and unchanged. Only the `Workflow.make` function signature changes.

## Proposed API

```typescript
const workflows = {
  processOrder: Workflow.make(
    (orderId: string) =>
      Effect.gen(function* () {
        yield* Workflow.step("Fetch", fetchOrder(orderId));
      })
  ),
} as const;
```

## Usage Pattern Examples

### Example 1: Basic Workflow

**Current:**
```typescript
const myWorkflow = Workflow.make(
  "myWorkflow",  // Ignored
  (input: { userId: string }) =>
    Effect.gen(function* () {
      yield* Workflow.step("fetch", fetchUser(input.userId));
    })
);
```

**Proposed:**
```typescript
const myWorkflow = Workflow.make(
  (input: { userId: string }) =>
    Effect.gen(function* () {
      yield* Workflow.step("fetch", fetchUser(input.userId));
    })
);
```

### Example 2: Full Registry

**Current:**
```typescript
const workflows = {
  processOrder: Workflow.make("processOrder", (id: string) => /* ... */),
  cancelOrder: Workflow.make("cancelOrder", (id: string) => /* ... */),
  refundOrder: Workflow.make("refundOrder", (data: RefundInput) => /* ... */),
} as const;
```

**Proposed:**
```typescript
const workflows = {
  processOrder: Workflow.make((id: string) => /* ... */),
  cancelOrder: Workflow.make((id: string) => /* ... */),
  refundOrder: Workflow.make((data: RefundInput) => /* ... */),
} as const;
```

### Example 3: With Input Schema

**Current:**
```typescript
const processOrder = Workflow.make(
  "processOrder",
  (input: OrderInput) => Effect.gen(function* () { /* ... */ }),
  { input: OrderInputSchema }
);
```

**Proposed:**
```typescript
const processOrder = Workflow.make(
  (input: OrderInput) => Effect.gen(function* () { /* ... */ }),
  { input: OrderInputSchema }
);
```

### Example 4: Accessing Workflow Name at Runtime

**Unchanged behavior - name comes from registry key:**
```typescript
const workflows = {
  myWorkflow: Workflow.make(
    (input: void) =>
      Effect.gen(function* () {
        const ctx = yield* Workflow.Context;
        console.log(ctx.workflowName);  // "myWorkflow" (registry key)
      })
  ),
} as const;
```

## Code Changes Required

### 1. `packages/workflow/src/Workflow.ts` (Lines 37-48)

**Current:**
```typescript
export function make<const Name extends string, Input, E>(
  name: Name,
  definition: WorkflowDefinition<Input, E>,
  options?: { readonly input?: Schema.Schema<Input, unknown> },
): DurableWorkflow<Name, Input, E> {
  return {
    _tag: "DurableWorkflow",
    name,
    definition,
    inputSchema: options?.input,
  };
}
```

**Proposed:**
```typescript
export function make<Input, E>(
  definition: WorkflowDefinition<Input, E>,
  options?: { readonly input?: Schema.Schema<Input, unknown> },
): DurableWorkflow<Input, E> {
  return {
    _tag: "DurableWorkflow",
    definition,
    inputSchema: options?.input,
  };
}
```

### 2. `packages/workflow/src/types.ts` (Lines 77-82)

**Current:**
```typescript
export interface DurableWorkflow<Name extends string, Input, E> {
  readonly _tag: "DurableWorkflow";
  readonly name: Name;
  readonly definition: WorkflowDefinition<Input, E>;
  readonly inputSchema?: Schema.Schema<Input, unknown>;
}
```

**Proposed:**
```typescript
export interface DurableWorkflow<Input, E> {
  readonly _tag: "DurableWorkflow";
  readonly definition: WorkflowDefinition<Input, E>;
  readonly inputSchema?: Schema.Schema<Input, unknown>;
}
```

### 3. `packages/workflow/src/types.ts` (Lines 87-90)

**Current:**
```typescript
export type WorkflowRegistry = Record<
  string,
  DurableWorkflow<string, any, any>
>;
```

**Proposed:**
```typescript
export type WorkflowRegistry = Record<
  string,
  DurableWorkflow<any, any>
>;
```

### 4. `packages/workflow/src/types.ts` (Lines 99-106)

**Current:**
```typescript
export type WorkflowInput<W> =
  W extends DurableWorkflow<any, infer I, any> ? I : never;

export type WorkflowError<W> =
  W extends DurableWorkflow<any, any, infer E> ? E : never;
```

**Proposed:**
```typescript
export type WorkflowInput<W> =
  W extends DurableWorkflow<infer I, any> ? I : never;

export type WorkflowError<W> =
  W extends DurableWorkflow<any, infer E> ? E : never;
```

### 5. `packages/workflow/src/types.ts` (Line 160-162)

**Current:**
```typescript
export interface DurableWorkflowInstance<W extends WorkflowRegistry>
  extends Rpc.DurableObjectBranded {
```

No change needed - uses `WorkflowRegistry` which is updated.

### 6. Docstring Update in `Workflow.ts`

Update the example in the docstring (lines 27-35):

**Current:**
```typescript
* @example
* ```typescript
* const myWorkflow = Workflow.make(
*   'processOrder',
*   (orderId: string) => Effect.gen(function* () {
*     const order = yield* Workflow.step('Fetch', fetchOrder(orderId));
*     yield* Workflow.step('Process', processOrder(order));
*   })
* );
* ```
```

**Proposed:**
```typescript
* @example
* ```typescript
* const myWorkflow = Workflow.make(
*   (orderId: string) => Effect.gen(function* () {
*     const order = yield* Workflow.step('Fetch', fetchOrder(orderId));
*     yield* Workflow.step('Process', processOrder(order));
*   })
* );
* ```
```

## What Does NOT Change

The following internal logic remains untouched:

- `createBaseEvent(workflowId, workflowName, ...)` - still receives name from registry key
- `createWorkflowContext(workflowId, workflowName, ...)` - still receives name from registry key
- `storeWorkflowMeta(storage, workflowName, ...)` - still receives name from registry key
- `transitionWorkflow(storage, workflowId, workflowName, ...)` - still receives name from registry key
- All event schemas with `workflowName` field - unchanged
- `WorkflowContext.workflowName` - unchanged
- Engine dispatch logic - unchanged

## Test File Updates

Simple find-and-replace pattern:
```
Workflow.make("...", (   →   Workflow.make((
```

**Files to update:**
| File | Pattern |
|------|---------|
| `test/workflow/async-run.test.ts` | `Workflow.make("test", ` → `Workflow.make(` |
| `test/workflow/sleep-lifecycle.test.ts` | Same |
| `test/workflow/retry-lifecycle.test.ts` | Same |
| `test/workflow/tracker-events.test.ts` | Same |
| `test/workflow/tracker-sync.test.ts` | Same |
| `test/sleep.test.ts` | Same |
| `test/retry.test.ts` | Same |
| `test/timeout.test.ts` | Same |
| `test/tracker.test.ts` | Same |
| `test/tracker-scoped.test.ts` | Same |
| `test/harness/workflow-harness.ts` | Same |

## Summary

| What | Status |
|------|--------|
| `Workflow.make` signature | Remove unused `name` param |
| `DurableWorkflow` type | Remove unused `Name` type param and `name` property |
| Internal `workflowName` handling | **No changes** |
| Events | **No changes** |
| WorkflowContext | **No changes** |
| Engine dispatch | **No changes** |
| Storage | **No changes** |

The fix is surgical: remove an unused parameter. The workflow name has always come from the registry key, and that's exactly how it should work.
