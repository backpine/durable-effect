# Consolidate Workflow Execution and Add Async Run

## Observation

In `engine.ts`, `run()` and `alarm()` have nearly identical `fullExecution` effects:

```typescript
// run() fullExecution
Effect.gen(function* () {
  yield* storeWorkflowMeta(storage, workflowName, input);
  yield* transitionWorkflow(..., { _tag: "Start", input });

  const startTime = Date.now();
  const result = yield* workflowDef.definition(input).pipe(..., Effect.exit);
  yield* handleWorkflowResult(...);
  yield* flushEvents;
}).pipe(Effect.provide(this.#trackerLayer));

// alarm() fullExecution
Effect.gen(function* () {
  yield* transitionWorkflow(..., { _tag: "Resume" });

  const startTime = Date.now();
  const result = yield* workflowDef.definition(input).pipe(..., Effect.exit);
  yield* handleWorkflowResult(...);
  yield* flushEvents;
}).pipe(Effect.provide(this.#trackerLayer));
```

**The only difference is the transition type** (`Start` vs `Resume`). Everything after the transition is identical.

## Proposed Solution

### 1. Single Execution Effect with Transition Parameter

Consolidate into one function that takes the transition as a parameter:

```typescript
/**
 * Execute a workflow with the given transition.
 * Handles the full lifecycle: transition → execute → handle result → flush.
 */
const createWorkflowExecution = (
  workflowDef: WorkflowDefinition,
  input: unknown,
  execCtx: ExecutionContextService,
  workflowCtx: WorkflowContextService,
  storage: DurableObjectStorage,
  workflowId: string,
  workflowName: string,
  transition: { _tag: "Start"; input: unknown } | { _tag: "Resume" },
): Effect.Effect<void, UnknownException> =>
  Effect.gen(function* () {
    yield* transitionWorkflow(storage, workflowId, workflowName, transition);

    const startTime = Date.now();
    const result = yield* workflowDef
      .definition(input)
      .pipe(
        Effect.provideService(ExecutionContext, execCtx),
        Effect.provideService(WorkflowContext, workflowCtx),
        Effect.exit,
      );

    yield* handleWorkflowResult(result, storage, workflowId, workflowName, startTime);
    yield* flushEvents;
  });
```

### 2. Simplified run() and alarm()

```typescript
async run(call: WorkflowCall<T>): Promise<WorkflowRunResult> {
  // ... validation and idempotency checks ...

  // Store metadata (only needed for first run)
  await Effect.runPromise(storeWorkflowMeta(storage, workflowName, input));

  // Execute with Start transition
  await Effect.runPromise(
    createWorkflowExecution(
      workflowDef, input, execCtx, workflowCtx,
      storage, workflowId, workflowName,
      { _tag: "Start", input },
    ).pipe(Effect.provide(this.#trackerLayer)),
  );

  return { id: workflowId };
}

async alarm(): Promise<void> {
  const status = await this.ctx.storage.get<WorkflowStatus>("workflow:status");

  // Determine transition based on current status
  if (status?._tag === "Queued") {
    // First execution from runAsync()
    const meta = await Effect.runPromise(loadWorkflowMeta(storage));
    await Effect.runPromise(
      createWorkflowExecution(
        workflowDef, meta.input, execCtx, workflowCtx,
        storage, workflowId, meta.workflowName,
        { _tag: "Start", input: meta.input },
      ).pipe(Effect.provide(this.#trackerLayer)),
    );
  } else if (status?._tag === "Paused") {
    // Resume from sleep/retry
    const meta = await Effect.runPromise(loadWorkflowMeta(storage));
    await Effect.runPromise(
      createWorkflowExecution(
        workflowDef, meta.input, execCtx, workflowCtx,
        storage, workflowId, meta.workflowName,
        { _tag: "Resume" },
      ).pipe(Effect.provide(this.#trackerLayer)),
    );
  }
}
```

### 3. Add runAsync() Method

New method that queues the workflow for background execution:

```typescript
/**
 * Start a workflow asynchronously.
 *
 * Unlike `run()`, this returns immediately after scheduling the workflow.
 * The workflow executes via alarm after a short delay (300ms).
 *
 * Use this when you want to offload work without blocking the client.
 *
 * @example
 * ```typescript
 * // Returns immediately - workflow runs in background
 * const { id } = await stub.runAsync({ workflow: 'processOrder', input: 'order-123' });
 *
 * // Check status later
 * const status = await stub.getStatus();
 * ```
 */
async runAsync(call: WorkflowCall<T>): Promise<WorkflowRunResult> {
  const { workflow: workflowName, input } = call;
  const workflowId = this.ctx.id.toString();

  // Check if workflow already exists (idempotent)
  const existingStatus = await this.ctx.storage.get<WorkflowStatus>("workflow:status");
  if (existingStatus) {
    return { id: workflowId };
  }

  // Get workflow definition (validate early)
  const workflowDef = this.#workflows[workflowName];
  if (!workflowDef) {
    throw new Error(`Unknown workflow: ${String(workflowName)}`);
  }

  const storage = this.ctx.storage;

  // Store metadata and set status to Queued
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* storeWorkflowMeta(storage, String(workflowName), input);
      yield* transitionWorkflow(storage, workflowId, String(workflowName), {
        _tag: "Queue",
        input,
      });
    }).pipe(Effect.provide(this.#trackerLayer)),
  );

  // Schedule alarm 300ms from now
  await this.ctx.storage.setAlarm(Date.now() + 300);

  return { id: workflowId };
}
```

### 4. New Transition: Queue

Add a new transition for async queueing:

```typescript
// In transitions.ts
export type WorkflowTransition =
  | { readonly _tag: "Start"; readonly input: unknown }
  | { readonly _tag: "Queue"; readonly input: unknown }  // NEW
  | { readonly _tag: "Resume" }
  // ...

// In transitionWorkflow switch:
case "Queue":
  yield* setWorkflowStatus(storage, { _tag: "Queued" });
  yield* emitEvent({
    ...base,
    type: "workflow.queued",
    input: t.input,
  });
  break;
```

### 5. New Status: Queued

```typescript
// In types.ts
export type WorkflowStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Queued" }  // NEW - waiting for alarm
  | { readonly _tag: "Running" }
  // ...
```

## New Event: workflow.queued

```typescript
// In core/events.ts
export const InternalWorkflowQueuedEventSchema = Schema.Struct({
  ...InternalBaseEventFields,
  type: Schema.Literal("workflow.queued"),
  input: Schema.Unknown,
});
```

## Benefits

1. **DRY**: Core execution logic defined once
2. **Non-blocking**: `runAsync()` returns immediately (~1-5ms vs potentially seconds)
3. **Observability**: New `workflow.queued` event for tracking async workflows
4. **Client flexibility**: Choose sync (`run`) or async (`runAsync`) based on use case

## API Summary

| Method | Behavior | Status Flow |
|--------|----------|-------------|
| `run()` | Blocks until complete | → Running → Completed/Failed/Paused |
| `runAsync()` | Returns immediately | → Queued → (alarm) → Running → ... |

## Implementation Order

1. Add `Queued` status to `WorkflowStatus` type
2. Add `workflow.queued` event schema to core
3. Add `Queue` transition to `transitions.ts`
4. Extract `createWorkflowExecution` helper in `engine.ts`
5. Refactor `run()` to use helper with `{ _tag: "Start" }`
6. Refactor `alarm()` to use helper with `{ _tag: "Start" }` or `{ _tag: "Resume" }` based on status
7. Add `runAsync()` method
8. Add `runAsync` to `TypedWorkflowEngine` interface
9. Tests



```ts
export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows);
// Workflows - durable object class that will be used for cloudflare export
// WorkflowClient - effecful service that will allow for operations

##### Useage in effect
const client = WorkflowClient.createFromBinding(env.WORKFLOW);
yield* client.runAsync("workflowname", { some: "data" })
```
