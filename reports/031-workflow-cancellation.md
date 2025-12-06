# Report 031: Workflow Cancellation Support

## Problem

There is no way to cancel a running or paused workflow:

```typescript
// User starts a long-running workflow
const { id } = await client.run({
  workflow: "processLargeDataset",
  input: { datasetId: "large-123" },
});

// Later, user wants to cancel it
// ??? No API exists
```

**Use Cases:**
- User cancels a pending operation from the UI
- Workflow becomes obsolete (e.g., order cancelled)
- Error in upstream system requires workflow termination
- Timeout at application level (not step level)
- Cost control for long-running workflows

## Goal

Add `cancel(instanceId, options?)` method to:
1. `DurableWorkflowEngine` (Durable Object class)
2. `WorkflowClientInstance` (Effect-based client)

Cancellation should:
- Be idempotent (calling twice is safe)
- Emit `workflow.cancelled` event
- Clean up storage
- Prevent paused workflows from resuming
- Allow in-progress steps to complete (graceful) or abort (immediate)

## Design Decisions

### 1. Cancellation Modes

```typescript
interface CancelOptions {
  /**
   * Cancellation mode:
   * - "graceful": Wait for current step to complete, then cancel
   * - "immediate": Cancel immediately, abort current step (default)
   */
  mode?: "graceful" | "immediate";

  /**
   * Reason for cancellation (included in event).
   */
  reason?: string;
}
```

**Graceful Mode:**
- Sets a `workflow:cancelRequested` flag
- Current step completes normally
- Before next step, workflow checks flag and cancels

**Immediate Mode:**
- Sets `workflow:cancelled` status directly
- Deletes pending alarm
- Clears storage
- Current execution is interrupted (via Effect interruption)

### 2. New Workflow Status

Add `Cancelled` to `WorkflowStatus`:

```typescript
export type WorkflowStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Queued"; readonly queuedAt: number }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Paused"; readonly reason: string; readonly resumeAt: number }
  | { readonly _tag: "Completed"; readonly completedAt: number }
  | { readonly _tag: "Failed"; readonly error: unknown; readonly failedAt: number }
  | { readonly _tag: "Cancelled"; readonly cancelledAt: number; readonly reason?: string };  // NEW
```

### 3. New Transition

Add `Cancel` to `WorkflowTransition`:

```typescript
export type WorkflowTransition =
  | { readonly _tag: "Start"; readonly input: unknown }
  | { readonly _tag: "Queue"; readonly input: unknown }
  | { readonly _tag: "Resume" }
  | { readonly _tag: "Complete"; ... }
  | { readonly _tag: "Pause"; ... }
  | { readonly _tag: "Fail"; ... }
  | {
      readonly _tag: "Cancel";
      readonly reason?: string;
      readonly completedSteps: ReadonlyArray<string>;
      readonly mode: "graceful" | "immediate";
    };  // NEW
```

### 4. New Error Type

```typescript
/**
 * Workflow was cancelled.
 * Used internally to signal cancellation through the Effect error channel.
 */
export class WorkflowCancelledError extends Data.TaggedError("WorkflowCancelledError")<{
  readonly workflowId: string;
  readonly reason?: string;
}> {}
```

### 5. Cancellation Check Points

For graceful cancellation, check the flag at these points:
1. Before each `Workflow.step()` execution
2. After each `Workflow.sleep()` pause point
3. At workflow resume (in `alarm()`)

```typescript
// Utility to check if cancellation was requested
const checkCancellation = Effect.gen(function* () {
  const cancelRequested = yield* storageGet<boolean>(storage, "workflow:cancelRequested");
  if (cancelRequested) {
    yield* Effect.fail(new WorkflowCancelledError({ workflowId, reason }));
  }
});
```

### 6. Cancelling a Paused Workflow

When a workflow is paused (sleeping or waiting for retry):
1. Delete the pending alarm: `storage.deleteAlarm()`
2. Set status to `Cancelled`
3. Emit `workflow.cancelled` event
4. Clear storage

This is straightforward because no code is currently executing.

### 7. Cancelling a Running Workflow

When a workflow is actively running:

**Immediate mode:**
- Set `workflow:cancelled` flag
- The running workflow continues until it checks the flag
- If using Effect interruption, can interrupt immediately

**Graceful mode:**
- Set `workflow:cancelRequested` flag
- Current step completes
- Next step checks flag and fails with `WorkflowCancelledError`

## Implementation Plan

### 1. Update types.ts

```diff
 export type WorkflowStatus =
   | { readonly _tag: "Pending" }
   | { readonly _tag: "Queued"; readonly queuedAt: number }
   | { readonly _tag: "Running" }
   | { readonly _tag: "Paused"; readonly reason: string; readonly resumeAt: number }
   | { readonly _tag: "Completed"; readonly completedAt: number }
-  | { readonly _tag: "Failed"; readonly error: unknown; readonly failedAt: number };
+  | { readonly _tag: "Failed"; readonly error: unknown; readonly failedAt: number }
+  | { readonly _tag: "Cancelled"; readonly cancelledAt: number; readonly reason?: string };
```

Also add to `DurableWorkflowInstance`:

```diff
 export interface DurableWorkflowInstance<W extends WorkflowRegistry>
   extends Rpc.DurableObjectBranded {
   run(call: WorkflowCall<W>): Promise<{ id: string }>;
   runAsync(call: WorkflowCall<W>): Promise<{ id: string }>;
+  cancel(options?: CancelOptions): Promise<{ cancelled: boolean }>;
   getStatus(): Promise<WorkflowStatus | undefined>;
   getCompletedSteps(): Promise<ReadonlyArray<string>>;
   getMeta<T>(key: string): Promise<T | undefined>;
 }

+export interface CancelOptions {
+  readonly mode?: "graceful" | "immediate";
+  readonly reason?: string;
+}
+
+export interface CancelResult {
+  /** Whether the workflow was cancelled (false if already completed/failed/cancelled) */
+  readonly cancelled: boolean;
+  /** Previous status before cancellation */
+  readonly previousStatus?: WorkflowStatus;
+}
```

### 2. Add WorkflowCancelledError to errors.ts

```typescript
/**
 * Workflow was cancelled by user request.
 */
export class WorkflowCancelledError extends Data.TaggedError("WorkflowCancelledError")<{
  readonly workflowId: string;
  readonly reason?: string;
}> {}
```

### 3. Update transitions.ts

```diff
 export type WorkflowTransition =
   | { readonly _tag: "Start"; readonly input: unknown }
   | { readonly _tag: "Queue"; readonly input: unknown }
   | { readonly _tag: "Resume" }
   | { readonly _tag: "Complete"; ... }
   | { readonly _tag: "Pause"; ... }
-  | { readonly _tag: "Fail"; ... };
+  | { readonly _tag: "Fail"; ... }
+  | {
+      readonly _tag: "Cancel";
+      readonly reason?: string;
+      readonly completedSteps: ReadonlyArray<string>;
+    };

 export const transitionWorkflow = (...) =>
   Effect.gen(function* () {
     // ... existing cases ...

+    case "Cancel":
+      yield* setWorkflowStatus(storage, {
+        _tag: "Cancelled",
+        cancelledAt: now,
+        reason: t.reason,
+      });
+      yield* emitEvent({
+        ...base,
+        type: "workflow.cancelled",
+        reason: t.reason,
+        completedSteps: t.completedSteps,
+      });
+      break;
   });
```

### 4. Update engine.ts - Add cancel() method

```typescript
/**
 * Cancel options for workflow cancellation.
 */
export interface CancelOptions {
  /** Cancellation mode (default: "immediate") */
  readonly mode?: "graceful" | "immediate";
  /** Reason for cancellation */
  readonly reason?: string;
}

/**
 * Result of a cancellation request.
 */
export interface CancelResult {
  readonly cancelled: boolean;
  readonly previousStatus?: WorkflowStatus;
}

// In DurableWorkflowEngine class:

/**
 * Cancel a workflow.
 *
 * For paused/queued workflows: Immediately cancels and cleans up.
 * For running workflows:
 *   - immediate: Sets cancel flag, clears alarm (workflow checks on next step)
 *   - graceful: Sets cancel request flag (workflow checks before next step)
 *
 * Idempotent - calling cancel on an already cancelled workflow returns success.
 */
async cancel(options?: CancelOptions): Promise<CancelResult> {
  const mode = options?.mode ?? "immediate";
  const reason = options?.reason;
  const storage = this.ctx.storage;
  const workflowId = this.ctx.id.toString();

  // Get current status
  const status = await storage.get<WorkflowStatus>("workflow:status");

  // Already in terminal state - no-op
  if (
    status?._tag === "Completed" ||
    status?._tag === "Failed" ||
    status?._tag === "Cancelled"
  ) {
    return { cancelled: false, previousStatus: status };
  }

  // Load workflow metadata for event emission
  const meta = await Effect.runPromise(loadWorkflowMeta(storage));
  const workflowName = meta.workflowName ?? "unknown";
  const executionId = meta.executionId;
  const completedSteps = (await storage.get<string[]>("workflow:completedSteps")) ?? [];

  if (status?._tag === "Paused" || status?._tag === "Queued") {
    // Paused or queued - can cancel immediately
    // Delete pending alarm
    await storage.deleteAlarm();

    // Transition to Cancelled
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* transitionWorkflow(storage, workflowId, workflowName, {
          _tag: "Cancel",
          reason,
          completedSteps,
        }, executionId);
        yield* flushEvents;
      }).pipe(Effect.provide(this.#trackerLayer)),
    );

    // Clear storage
    await storage.deleteAll();

    return { cancelled: true, previousStatus: status };
  }

  if (status?._tag === "Running") {
    if (mode === "immediate") {
      // Set cancelled flag - workflow will check on next yield point
      await storage.put("workflow:cancelled", true);
      await storage.put("workflow:cancelReason", reason);

      // Note: We can't interrupt the running Effect directly from here.
      // The workflow will detect the flag at the next check point.
      // For truly immediate cancellation, the workflow must cooperate.

      return { cancelled: true, previousStatus: status };
    } else {
      // Graceful - set request flag
      await storage.put("workflow:cancelRequested", true);
      await storage.put("workflow:cancelReason", reason);

      return { cancelled: true, previousStatus: status };
    }
  }

  // Pending or unknown - just cancel
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* transitionWorkflow(storage, workflowId, workflowName, {
        _tag: "Cancel",
        reason,
        completedSteps,
      }, executionId);
      yield* flushEvents;
    }).pipe(Effect.provide(this.#trackerLayer)),
  );

  await storage.deleteAll();

  return { cancelled: true, previousStatus: status };
}
```

### 5. Add Cancellation Check to Workflow.step()

```diff
 // packages/workflow/src/workflow.ts

+/**
+ * Check if workflow cancellation was requested.
+ * Throws WorkflowCancelledError if cancellation is pending.
+ */
+const checkCancellation = Effect.gen(function* () {
+  const { storage } = yield* ExecutionContext;
+  const workflowCtx = yield* WorkflowContext;
+
+  const cancelled = yield* Effect.promise(() =>
+    storage.get<boolean>("workflow:cancelled"),
+  );
+
+  if (cancelled) {
+    const reason = yield* Effect.promise(() =>
+      storage.get<string>("workflow:cancelReason"),
+    );
+    return yield* Effect.fail(
+      new WorkflowCancelledError({
+        workflowId: workflowCtx.workflowId,
+        reason,
+      }),
+    );
+  }
+
+  const cancelRequested = yield* Effect.promise(() =>
+    storage.get<boolean>("workflow:cancelRequested"),
+  );
+
+  if (cancelRequested) {
+    const reason = yield* Effect.promise(() =>
+      storage.get<string>("workflow:cancelReason"),
+    );
+    return yield* Effect.fail(
+      new WorkflowCancelledError({
+        workflowId: workflowCtx.workflowId,
+        reason,
+      }),
+    );
+  }
+});

 export function step<T, E, R>(
   name: string,
   effect: Effect.Effect<T, E, ForbidWorkflowScope<R>>,
 ): Effect.Effect<...> {
   return Effect.gen(function* () {
+    // Check for cancellation before executing step
+    yield* checkCancellation;

     const { storage } = yield* ExecutionContext;
     const workflowCtx = yield* WorkflowContext;
     // ... rest of step implementation
   });
 }
```

### 6. Handle WorkflowCancelledError in engine.ts

```diff
 function handleWorkflowResult<E>(
   result: Exit.Exit<unknown, E>,
   // ...
 ): Effect.Effect<void, UnknownException> {
   return Effect.gen(function* () {
     if (Exit.isSuccess(result)) {
       // ... existing success handling
     }

     const cause = result.cause;
     const failureOption = Cause.failureOption(cause);

     if (failureOption._tag === "Some") {
       const error = failureOption.value;

       // Check for PauseSignal
       if (error instanceof PauseSignal) {
         // ... existing pause handling
       }

+      // Check for WorkflowCancelledError
+      if (error instanceof WorkflowCancelledError) {
+        const completedSteps = yield* getCompletedStepsFromStorage(storage);
+        yield* transitionWorkflow(
+          storage,
+          workflowId,
+          workflowName,
+          {
+            _tag: "Cancel",
+            reason: error.reason,
+            completedSteps,
+          },
+          executionId,
+        );
+        yield* Effect.promise(() => storage.deleteAll());
+        return;
+      }
     }

     // ... existing failure handling
   });
 }
```

### 7. Update alarm() to check cancellation

```diff
 async alarm(): Promise<void> {
   const status = await this.ctx.storage.get<WorkflowStatus>("workflow:status");

+  // Check if cancelled while paused
+  const cancelled = await this.ctx.storage.get<boolean>("workflow:cancelled");
+  if (cancelled) {
+    // Don't resume - just clean up
+    const reason = await this.ctx.storage.get<string>("workflow:cancelReason");
+    const completedSteps = (await this.ctx.storage.get<string[]>("workflow:completedSteps")) ?? [];
+    const meta = await Effect.runPromise(loadWorkflowMeta(this.ctx.storage));
+
+    await Effect.runPromise(
+      Effect.gen(function* () {
+        yield* transitionWorkflow(
+          this.ctx.storage,
+          this.ctx.id.toString(),
+          meta.workflowName ?? "unknown",
+          { _tag: "Cancel", reason, completedSteps },
+          meta.executionId,
+        );
+        yield* flushEvents;
+      }).pipe(Effect.provide(this.#trackerLayer)),
+    );
+
+    await this.ctx.storage.deleteAll();
+    return;
+  }

   if (status?._tag !== "Queued" && status?._tag !== "Paused") {
     return;
   }

   // ... existing alarm handling
 }
```

### 8. Update Client

```diff
 // packages/workflow/src/client/types.ts

+export interface CancelOptions {
+  readonly mode?: "graceful" | "immediate";
+  readonly reason?: string;
+}
+
+export interface CancelResult {
+  readonly cancelled: boolean;
+  readonly previousStatus?: WorkflowStatus;
+}

 export interface WorkflowClientInstance<W extends WorkflowRegistry> {
   run(...): Effect.Effect<WorkflowRunResult, WorkflowClientError>;
   runAsync(...): Effect.Effect<WorkflowRunResult, WorkflowClientError>;
+
+  /**
+   * Cancel a workflow by instance ID.
+   */
+  cancel(
+    instanceId: string,
+    options?: CancelOptions,
+  ): Effect.Effect<CancelResult, WorkflowClientError>;
+
   status(...): Effect.Effect<WorkflowStatus | undefined, WorkflowClientError>;
   // ...
 }
```

```diff
 // packages/workflow/src/client/instance.ts

+cancel(instanceId: string, options?: CancelOptions) {
+  return Effect.tryPromise({
+    try: async () => {
+      const stub = getStub(instanceId);
+      return stub.cancel(options);
+    },
+    catch: (e) => new WorkflowClientError("cancel", e),
+  });
+},
```

## Files Changed

| File | Change |
|------|--------|
| `types.ts` | Add `Cancelled` status, `CancelOptions`, `CancelResult` |
| `errors.ts` | Add `WorkflowCancelledError` |
| `transitions.ts` | Add `Cancel` transition type and handler |
| `engine.ts` | Add `cancel()` method, update `alarm()`, update `handleWorkflowResult()` |
| `workflow.ts` | Add `checkCancellation` to `step()` |
| `client/types.ts` | Add `cancel()` to client interface |
| `client/instance.ts` | Implement `cancel()` |
| `index.ts` | Export new types |

## Test Cases

### 1. Cancel Paused Workflow

```typescript
it("cancels a paused workflow", async () => {
  const workflow = Workflow.make((_: void) =>
    Effect.gen(function* () {
      yield* Workflow.step("step1", Effect.succeed("done"));
      yield* Workflow.sleep("1 hour");  // Pauses here
      yield* Workflow.step("step2", Effect.succeed("never reached"));
    }),
  );

  const harness = createWorkflowHarness(workflow, { eventCapture });
  await harness.run(undefined);

  expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

  // Cancel
  const result = await harness.cancel({ reason: "user request" });

  expect(result.cancelled).toBe(true);
  expect(await harness.getStatus()).toMatchObject({
    _tag: "Cancelled",
    reason: "user request",
  });

  // Verify event emitted
  expect(eventCapture.events).toContainEqual(
    expect.objectContaining({
      type: "workflow.cancelled",
      reason: "user request",
    }),
  );
});
```

### 2. Cancel Queued Workflow

```typescript
it("cancels a queued workflow before execution", async () => {
  const workflow = Workflow.make((_: void) =>
    Effect.gen(function* () {
      yield* Workflow.step("step1", Effect.succeed("done"));
    }),
  );

  const harness = createWorkflowHarness(workflow);
  await harness.runAsync(undefined);

  expect(await harness.getStatus()).toMatchObject({ _tag: "Queued" });

  // Cancel before alarm fires
  const result = await harness.cancel();

  expect(result.cancelled).toBe(true);
  expect(await harness.getStatus()).toMatchObject({ _tag: "Cancelled" });

  // Trigger alarm - should be no-op
  await harness.triggerAlarm();
  expect(await harness.getStatus()).toMatchObject({ _tag: "Cancelled" });
});
```

### 3. Graceful Cancel Running Workflow

```typescript
it("gracefully cancels running workflow after current step", async () => {
  let step2Started = false;
  const workflow = Workflow.make((_: void) =>
    Effect.gen(function* () {
      yield* Workflow.step("step1", Effect.succeed("done"));
      step2Started = true;
      yield* Workflow.step("step2", Effect.succeed("done"));
    }),
  );

  // This test requires a more sophisticated harness that can
  // simulate concurrent cancel during execution
  // ...
});
```

### 4. Cancel Idempotency

```typescript
it("cancel is idempotent", async () => {
  const workflow = Workflow.make((_: void) =>
    Workflow.step("step1", Effect.succeed("done")),
  );

  const harness = createWorkflowHarness(workflow);
  await harness.run(undefined);

  expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });

  // Cancel completed workflow - should be no-op
  const result = await harness.cancel();

  expect(result.cancelled).toBe(false);
  expect(result.previousStatus).toMatchObject({ _tag: "Completed" });
});
```

### 5. Cancel with Completed Steps Preserved

```typescript
it("preserves completed steps in cancel event", async () => {
  const workflow = Workflow.make((_: void) =>
    Effect.gen(function* () {
      yield* Workflow.step("step1", Effect.succeed("done"));
      yield* Workflow.step("step2", Effect.succeed("done"));
      yield* Workflow.sleep("1 hour");
      yield* Workflow.step("step3", Effect.succeed("never"));
    }),
  );

  const harness = createWorkflowHarness(workflow, { eventCapture });
  await harness.run(undefined);

  await harness.cancel();

  const cancelEvent = eventCapture.events.find(e => e.type === "workflow.cancelled");
  expect(cancelEvent?.completedSteps).toEqual(["step1", "step2"]);
});
```

## Usage Example

```typescript
// Start a workflow
const { id } = await client.run({
  workflow: "processOrder",
  input: { orderId: "123" },
});

// Later, cancel it
const result = await Effect.runPromise(
  client.cancel(id, { reason: "Order was cancelled by customer" }),
);

if (result.cancelled) {
  console.log(`Workflow cancelled (was ${result.previousStatus?._tag})`);
} else {
  console.log(`Workflow already finished: ${result.previousStatus?._tag}`);
}
```

## Future Enhancements

1. **Cancellation Handlers**: Allow workflows to define cleanup logic on cancel
   ```typescript
   Workflow.make({
     definition: ...,
     onCancel: (ctx) => Effect.gen(function* () {
       yield* refundPayment(ctx.getMeta("paymentId"));
     }),
   })
   ```

2. **Timeout-based Cancellation**: Auto-cancel after duration
   ```typescript
   client.run({
     workflow: "process",
     input: data,
     execution: { timeout: "1 hour" },
   })
   ```

3. **Bulk Cancellation**: Cancel multiple workflows
   ```typescript
   client.cancelMany({ workflow: "processOrder", before: Date.now() - 86400000 })
   ```
