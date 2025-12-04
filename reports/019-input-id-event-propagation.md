# Execution ID Event Propagation

## Overview

Add an optional `executionId` field to tracker events that corresponds to the user-provided ID from `execution.id` in the client. This allows the tracking database to link events back to the original workflow ID provided by the user.

## Current Architecture

```
Client (execution.id) → Engine (ctx.id) → WorkflowContext → Events (workflowId)
```

- `execution.id` is optional, user-provided identifier
- `workflowId` in events is the Durable Object ID (internal)
- No way to correlate events with the user's original ID

## Goal

```
Client (execution.id) → Engine → Storage → WorkflowContext (executionId) → Events (executionId)
```

Events should include optional `executionId` when the user provides one, persisting across the entire workflow lifecycle.

## Lifecycle Persistence Analysis

**Question:** Does `executionId` persist across sleeps, retries, and alarm triggers?

**Answer:** Yes. Here's why:

```typescript
// engine.ts - Initial run stores metadata
await Effect.runPromise(
  storeWorkflowMeta(this.ctx.storage, workflowName, input, executionId), // Persisted to DO storage
);

// engine.ts - Alarm handler loads metadata
async alarm(): Promise<void> {
  const meta = await Effect.runPromise(loadWorkflowMeta(this.ctx.storage)); // Loaded from storage
  // meta.executionId is available here
}
```

The Durable Object storage persists across:
- Sleep pauses (alarm triggers resume)
- Retry pauses (alarm triggers retry)
- Worker cold starts (DO storage is durable)
- Multiple execution runs of the same workflow

**Data flow across lifecycle:**

```
Initial Run:
  storeWorkflowMeta(storage, name, input, executionId)  // Store to DO
      ↓
Sleep/Pause:
  Workflow pauses, sets alarm
      ↓
Alarm Triggers:
  loadWorkflowMeta(storage)  // Load executionId from DO
      ↓
  createWorkflowContext(..., executionId)  // Available for events
      ↓
Resume/Complete:
  Events include executionId
```

## Design

### Changes Required

#### 1. Core: Add `executionId` to Base Event Schema

**File:** `packages/core/src/events.ts`

```typescript
const InternalBaseEventFields = {
  eventId: Schema.String,
  timestamp: Schema.String,
  workflowId: Schema.String,
  workflowName: Schema.String,
  executionId: Schema.optional(Schema.String), // NEW: Optional user-provided ID
};
```

Update `createBaseEvent`:

```typescript
export function createBaseEvent(
  workflowId: string,
  workflowName: string,
  executionId?: string, // NEW parameter
): InternalBaseEvent {
  return {
    eventId: uuidv7(),
    timestamp: new Date().toISOString(),
    workflowId,
    workflowName,
    ...(executionId && { executionId }), // Only include if provided
  };
}
```

#### 2. Workflow Package: Add `executionId` to WorkflowContext

**File:** `packages/workflow/src/services/workflow-context.ts`

```typescript
export interface WorkflowContextService {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly input: unknown;
  readonly executionId: string | undefined; // NEW: Optional user-provided ID
  // ... rest of interface
}

export function createWorkflowContext(
  workflowId: string,
  workflowName: string,
  input: unknown,
  storage: DurableObjectStorage,
  executionId?: string, // NEW parameter
): WorkflowContextService {
  return {
    workflowId,
    workflowName,
    input,
    executionId, // NEW
    // ... rest of implementation
  };
}
```

Update metadata storage:

```typescript
export function storeWorkflowMeta(
  storage: DurableObjectStorage,
  workflowName: string,
  input: unknown,
  executionId?: string, // NEW parameter
): Effect.Effect<void, UnknownException> {
  return Effect.tryPromise({
    try: () =>
      storage.put({
        [workflowKey("name")]: workflowName,
        [workflowKey("input")]: input,
        [workflowKey("executionId")]: executionId, // NEW: Persist to storage
      }),
    catch: (e) => new UnknownException(e),
  });
}

export function loadWorkflowMeta(
  storage: DurableObjectStorage,
): Effect.Effect<
  { workflowName: string | undefined; input: unknown; executionId: string | undefined },
  UnknownException
> {
  return Effect.tryPromise({
    try: async () => {
      const [workflowName, input, executionId] = await Promise.all([
        storage.get<string>(workflowKey("name")),
        storage.get<unknown>(workflowKey("input")),
        storage.get<string>(workflowKey("executionId")), // NEW: Load from storage
      ]);
      return { workflowName, input, executionId };
    },
    catch: (e) => new UnknownException(e),
  });
}
```

#### 3. Workflow Package: Update Transitions

**File:** `packages/workflow/src/transitions.ts`

```typescript
export const transitionWorkflow = (
  storage: DurableObjectStorage,
  workflowId: string,
  workflowName: string,
  t: WorkflowTransition,
  executionId?: string, // NEW parameter
): Effect.Effect<void, UnknownException> =>
  Effect.gen(function* () {
    const base = createBaseEvent(workflowId, workflowName, executionId);
    // ... rest stays the same
  });
```

#### 4. Workflow Package: Update Engine

**File:** `packages/workflow/src/engine.ts`

Extract and store `executionId`:

```typescript
// In run() method - extract executionId from the namespaced instanceId
async run(call: WorkflowCall<T>): Promise<WorkflowRunResult> {
  const { workflow: workflowName, input } = call;
  const workflowId = this.ctx.id.toString();

  // Extract executionId: instanceId format is "{workflow}:{executionId}" or "{workflow}:{uuid}"
  // We only want to capture it if it was user-provided (not auto-generated UUID)
  // This requires passing it from the client or marking it somehow

  // Store metadata including executionId
  await Effect.runPromise(
    storeWorkflowMeta(this.ctx.storage, String(workflowName), input, executionId),
  );
  // ...
}
```

In `alarm()` handler:

```typescript
async alarm(): Promise<void> {
  // ...
  const meta = await Effect.runPromise(loadWorkflowMeta(this.ctx.storage));

  const workflowId = this.ctx.id.toString();
  const workflowName = meta.workflowName;
  const input = meta.input;
  const executionId = meta.executionId; // NEW: Load from storage

  // Pass to executeWorkflow
  await this.#executeWorkflow(
    workflowDef,
    input,
    workflowId,
    workflowName,
    transition,
    executionId, // NEW
  );
}
```

In `#executeWorkflow`:

```typescript
async #executeWorkflow(
  workflowDef: T[keyof T],
  input: unknown,
  workflowId: string,
  workflowName: string,
  transition: { _tag: "Start"; input: unknown } | { _tag: "Resume" },
  executionId?: string, // NEW parameter
): Promise<void> {
  const workflowCtx = createWorkflowContext(
    workflowId,
    workflowName,
    input,
    storage,
    executionId, // NEW: Pass to context
  );

  const execution = Effect.gen(function* () {
    yield* transitionWorkflow(storage, workflowId, workflowName, transition, executionId);
    // ...
  });
}
```

#### 5. Workflow Package: Update Client Types

**File:** `packages/workflow/src/client/types.ts`

```typescript
export interface ExecutionOptions {
  /**
   * Custom instance ID suffix. The final ID will be `{workflow}:{id}`.
   * If not provided, a random UUID is generated.
   *
   * This ID is also included in tracker events as `executionId` for correlation
   * and persists across the entire workflow lifecycle (sleeps, retries, etc).
   */
  readonly id?: string;
}
```

### Complete Data Flow

```
INITIAL RUN:
1. Client: run({ workflow: "order", input: {...}, execution: { id: "order-123" } })
2. Instance: resolveInstanceId("order", "order-123") → "order:order-123"
3. Engine.run():
   - Extract executionId = "order-123"
   - storeWorkflowMeta(storage, "order", input, "order-123")  // PERSISTED
   - transitionWorkflow(..., "order-123")
4. Events include: executionId: "order-123"

AFTER SLEEP/RETRY (Alarm triggers):
5. Engine.alarm():
   - loadWorkflowMeta(storage) → { ..., executionId: "order-123" }  // LOADED
   - #executeWorkflow(..., "order-123")
6. Engine.#executeWorkflow():
   - createWorkflowContext(..., "order-123")
   - transitionWorkflow(..., "order-123")
7. Events include: executionId: "order-123"  ✓ Same as initial run
```

### Database Schema Note

Add to your schema:

```sql
execution_id TEXT  -- Optional user-provided ID (from execution.id)
```

## Implementation Order

1. **Core package:** Add `executionId` to schemas and `createBaseEvent`
2. **Workflow package:** Add `executionId` to WorkflowContext
3. **Workflow package:** Update `storeWorkflowMeta`/`loadWorkflowMeta` for persistence
4. **Workflow package:** Update `transitionWorkflow`
5. **Workflow package:** Update engine (`run`, `runAsync`, `alarm`, `#executeWorkflow`)
6. **Tests:** Add tests for executionId propagation across lifecycle

## Estimated Scope

- **Core:** ~20 lines changed
- **Workflow:** ~60 lines changed
- **Tests:** ~40 lines for lifecycle tests
- **Total:** ~120 lines

## Summary

The design persists `executionId` in Durable Object storage via `storeWorkflowMeta`/`loadWorkflowMeta`. This ensures:

1. **Initial run:** `executionId` stored with workflow metadata
2. **Sleep/retry alarm:** `executionId` loaded from storage
3. **All events:** Include `executionId` throughout lifecycle

The storage-based persistence is the key insight - it's already the pattern used for `workflowName` and `input`, so `executionId` follows naturally.
