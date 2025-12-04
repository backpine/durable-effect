# Execution ID Propagation Fix

## Problem

The current implementation incorrectly tries to extract `executionId` from the Durable Object's internal ID:

```typescript
// engine.ts - WRONG
const workflowId = this.ctx.id.toString();  // This is DO's internal ID, NOT the namespaced instanceId
const executionId = extractExecutionId(workflowId);  // This doesn't work
```

The Durable Object ID (`this.ctx.id.toString()`) is an internal identifier like `abc123def456...`, not the namespaced format `{workflow}:{executionId}`.

## Current Flow (Broken)

```
Client:
  execution?.id = "order-123"
  instanceId = resolveInstanceId("order", "order-123") → "order:order-123"
  doId = binding.idFromName(instanceId)  // Creates DO ID from name
  stub = binding.get(doId)
  stub.run({ workflow: "order", input: {...} })  // ❌ executionId NOT passed!

Engine:
  run({ workflow, input }) {
    const workflowId = this.ctx.id.toString();  // "abc123def456..." - internal DO ID
    const executionId = extractExecutionId(workflowId);  // ❌ Returns garbage
  }
```

## Solution

Pass `executionId` explicitly through the RPC call from client to engine.

### 1. Update WorkflowCall Type

**File:** `packages/workflow/src/types.ts`

```typescript
export type WorkflowCall<W extends WorkflowRegistry> = {
  [K in keyof W & string]: {
    readonly workflow: K;
    readonly input: WorkflowInput<W[K]>;
    readonly executionId?: string;  // NEW: Optional execution ID for correlation
  };
}[keyof W & string];
```

### 2. Update Client Instance

**File:** `packages/workflow/src/client/instance.ts`

```typescript
run(
  request: WorkflowRunRequest<W>,
): Effect.Effect<WorkflowRunResult, WorkflowClientError> {
  return Effect.tryPromise({
    try: async () => {
      const { workflow, input, execution } = request;
      const instanceId = resolveInstanceId(workflow, execution?.id);
      const stub = getStub(instanceId);

      // Pass executionId through the RPC call
      await stub.run({
        workflow,
        input,
        executionId: execution?.id,  // NEW: Pass execution ID
      } as Parameters<typeof stub.run>[0]);

      return { id: instanceId };
    },
    catch: (e) => new WorkflowClientError("run", e),
  });
},

runAsync(
  request: WorkflowRunRequest<W>,
): Effect.Effect<WorkflowRunResult, WorkflowClientError> {
  return Effect.tryPromise({
    try: async () => {
      const { workflow, input, execution } = request;
      const instanceId = resolveInstanceId(workflow, execution?.id);
      const stub = getStub(instanceId);

      await stub.runAsync({
        workflow,
        input,
        executionId: execution?.id,  // NEW: Pass execution ID
      } as Parameters<typeof stub.runAsync>[0]);

      return { id: instanceId };
    },
    catch: (e) => new WorkflowClientError("runAsync", e),
  });
},
```

### 3. Update Engine

**File:** `packages/workflow/src/engine.ts`

Remove the broken `extractExecutionId` function and use the passed value:

```typescript
async run(call: WorkflowCall<T>): Promise<WorkflowRunResult> {
  const { workflow: workflowName, input, executionId } = call;  // Destructure executionId
  const workflowId = this.ctx.id.toString();

  // ... rest of method uses executionId directly
  await Effect.runPromise(
    storeWorkflowMeta(this.ctx.storage, String(workflowName), input, executionId),
  );

  await this.#executeWorkflow(
    workflowDef,
    input,
    workflowId,
    String(workflowName),
    { _tag: "Start", input },
    executionId,
  );
}

async runAsync(call: WorkflowCall<T>): Promise<WorkflowRunResult> {
  const { workflow: workflowName, input, executionId } = call;  // Destructure executionId
  // ... same pattern
}
```

### 4. Delete extractExecutionId

Remove the broken helper function entirely:

```typescript
// DELETE THIS
function extractExecutionId(workflowId: string): string | undefined {
  const colonIndex = workflowId.indexOf(":");
  if (colonIndex === -1) {
    return undefined;
  }
  return workflowId.slice(colonIndex + 1);
}
```

## Updated Data Flow (Fixed)

```
Client:
  execution?.id = "order-123"
  instanceId = resolveInstanceId("order", "order-123") → "order:order-123"
  doId = binding.idFromName(instanceId)
  stub = binding.get(doId)
  stub.run({ workflow: "order", input: {...}, executionId: "order-123" })  // ✅ Passed!

Engine:
  run({ workflow, input, executionId }) {
    // executionId = "order-123" ✅ Direct from client
    storeWorkflowMeta(..., executionId)  // Persisted for alarm handler
  }

Alarm (resume):
  meta = loadWorkflowMeta()  // { executionId: "order-123" } loaded from storage
  // executionId available for all events ✅
```

## Files to Change

| File | Change |
|------|--------|
| `packages/workflow/src/types.ts` | Add `executionId` to `WorkflowCall` |
| `packages/workflow/src/client/instance.ts` | Pass `execution?.id` as `executionId` in RPC calls |
| `packages/workflow/src/engine.ts` | Remove `extractExecutionId`, destructure `executionId` from call |

## Why Storage Persistence Still Works

The alarm handler path remains unchanged:
1. Initial `run()`/`runAsync()` stores `executionId` via `storeWorkflowMeta()`
2. Alarm handler loads it via `loadWorkflowMeta()`
3. All events get `executionId` throughout lifecycle

The fix only changes how `executionId` initially gets into the engine - via RPC parameter instead of trying to parse it from the DO ID.

## Summary

The mistake was assuming `this.ctx.id.toString()` contains the namespaced instanceId. It doesn't - it's an internal DO identifier. The solution is simple: pass `executionId` explicitly through the RPC call, which is the clean and correct approach.
