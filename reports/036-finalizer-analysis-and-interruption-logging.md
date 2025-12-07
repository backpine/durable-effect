# Finalizer Analysis and Interruption Logging

## Overview

This report analyzes Effect's finalizer mechanisms as used in durable-effect, their limitations when a Durable Object (DO) resets due to code deployment, and provides implementation for enhanced interruption logging.

## Effect Finalizer Mechanisms

Effect provides several mechanisms for cleanup and resource management:

### 1. `Effect.addFinalizer(finalizer)`

Registers a finalizer that runs when the current scope closes:

```typescript
Effect.gen(function* () {
  yield* Effect.addFinalizer((exit) =>
    Effect.gen(function* () {
      if (Exit.isInterrupted(exit)) {
        yield* Effect.log("Effect was interrupted");
      } else if (Exit.isFailure(exit)) {
        yield* Effect.log("Effect failed");
      } else {
        yield* Effect.log("Effect succeeded");
      }
    })
  );

  // ... rest of effect
});
```

**Key behavior**: The finalizer receives an `Exit` value indicating how the effect completed (success, failure, or interruption).

### 2. `Effect.acquireRelease(acquire, release)`

Creates a scoped resource with guaranteed cleanup:

```typescript
const resource = Effect.acquireRelease(
  Effect.sync(() => openConnection()),      // Acquire
  (conn, exit) => Effect.sync(() => {       // Release
    console.log(`Closing due to: ${exit._tag}`);
    conn.close();
  })
);
```

### 3. `Effect.ensuring(effect, finalizer)`

Ensures a finalizer runs after an effect, regardless of outcome:

```typescript
effect.pipe(
  Effect.ensuring(Effect.log("Always runs"))
);
```

### 4. `Effect.onExit(effect, handler)`

Runs a handler based on the exit value:

```typescript
effect.pipe(
  Effect.onExit((exit) =>
    Exit.isSuccess(exit)
      ? Effect.log("Success!")
      : Effect.log("Failed or interrupted")
  )
);
```

### 5. `Layer.scoped`

Creates a scoped layer with automatic resource management:

```typescript
Layer.scoped(
  MyService,
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.log("Layer closing"));
    return myServiceImpl;
  })
);
```

## Existing Finalizers in durable-effect

### Tracker Service Finalizer (`tracker/service.ts:231-236`)

```typescript
// Cleanup on scope close - flush any remaining events
yield* Effect.addFinalizer(() =>
  Effect.gen(function* () {
    yield* flush;
    yield* Effect.logDebug("Event tracker shutdown complete");
  }),
);
```

**Purpose**: Flushes any queued events when the tracker scope closes.

**Limitation**: This only runs if the Effect completes normally within Effect's runtime.

### Step Failure Handler (`workflow.ts:385-441`)

```typescript
return yield* stepLogic.pipe(
  Effect.onExit((exit) =>
    Effect.gen(function* () {
      // Emit step.failed if not already emitted
      if (Exit.isFailure(exit) && !state.stepFailedEmitted && ...) {
        yield* emitEvent({ type: "step.failed", ... });
      }
    }),
  ),
);
```

**Purpose**: Ensures `step.failed` events are emitted even when unexpected errors occur.

## The Fundamental Problem: DO Resets

When a Durable Object resets due to code deployment:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Normal Effect Lifecycle                       │
│                                                                  │
│   Effect.runPromise(program)                                     │
│         │                                                        │
│         ▼                                                        │
│   ┌─────────────┐                                                │
│   │ Execute     │──success──▶ Scope closes ──▶ Finalizers run   │
│   │ Program     │                                                │
│   └─────────────┘                                                │
│         │                                                        │
│         │──failure──▶ Scope closes ──▶ Finalizers run           │
│         │                                                        │
│         │──interrupt─▶ Scope closes ──▶ Finalizers run          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────┐
│                    DO Reset (Code Deployment)                    │
│                                                                  │
│   Effect.runPromise(program)                                     │
│         │                                                        │
│         ▼                                                        │
│   ┌─────────────┐                                                │
│   │ Execute     │                                                │
│   │ Program     │──────────▶ PROCESS KILLED ────▶ Nothing runs  │
│   └─────────────┘            (isolate dies)                      │
│                                                                  │
│   Finalizers NEVER run because:                                  │
│   - Effect runtime doesn't exist anymore                         │
│   - JavaScript heap is destroyed                                 │
│   - There's no graceful shutdown signal                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight**: Effect finalizers only work within Effect's runtime. A DO reset is an external process kill that completely bypasses JavaScript execution.

## What Cloudflare Provides

| Mechanism | Purpose | Helps with Reset? |
|-----------|---------|-------------------|
| `ctx.storage` | Durable storage | Yes - survives reset |
| `ctx.storage.setAlarm()` | Scheduled callbacks | Yes - survives reset |
| `blockConcurrencyWhile()` | Init/recovery in constructor | Yes - runs after reset |
| `waitUntil()` | Keep isolate alive for async | No - doesn't prevent kills |
| No shutdown hook | - | No graceful shutdown |

## Wrapping the Alarm Handler in an Effect with Finalizers

**Yes, absolutely!** The entire `alarm()` handler can be wrapped in a single Effect with finalizers. This is the cleanest approach and provides structured resource management.

### Current State

The current `alarm()` method mixes raw async/await with scattered `Effect.runPromise` calls:

```typescript
async alarm(): Promise<void> {
  const storage = this.ctx.storage;
  const status = await storage.get<WorkflowStatus>("workflow:status");  // Raw await

  // ... various checks ...

  const meta = await Effect.runPromise(loadWorkflowMeta(storage));      // Effect.runPromise

  // ... more logic ...

  await this.#executeWorkflow(...);                                      // Raw await
}
```

### Refactored: Single Effect with Finalizer

We can wrap the entire alarm logic in one Effect, making it eligible for proper finalizer handling:

```typescript
/**
 * Handle alarm - execute queued or resume paused workflow.
 * Wrapped in Effect for proper finalizer/cleanup support.
 */
async alarm(): Promise<void> {
  const storage = this.ctx.storage;
  const doId = this.ctx.id.toString();
  const workflows = this.#workflows;
  const trackerLayer = this.#trackerLayer;
  const executeWorkflow = this.#executeWorkflow.bind(this);

  const alarmEffect = Effect.gen(function* () {
    // Load status
    const status = yield* Effect.tryPromise(() =>
      storage.get<WorkflowStatus>("workflow:status")
    );

    // Early exit if not actionable
    if (status?._tag !== "Queued" && status?._tag !== "Paused") {
      return;
    }

    // Check cancellation
    const cancelled = yield* Effect.tryPromise(() =>
      storage.get<boolean>("workflow:cancelled")
    );

    if (cancelled) {
      const cancelReason = yield* Effect.tryPromise(() =>
        storage.get<string>("workflow:cancelReason")
      );
      const completedSteps = yield* Effect.tryPromise(() =>
        storage.get<string[]>("workflow:completedSteps")
      ).pipe(Effect.map((s) => s ?? []));

      const meta = yield* loadWorkflowMeta(storage);

      yield* transitionWorkflow(
        storage,
        doId,
        meta.workflowName ?? "unknown",
        { _tag: "Cancel", reason: cancelReason, completedSteps },
        meta.executionId,
      );
      yield* flushEvents;

      yield* Effect.tryPromise(() => storage.deleteAll());
      return;
    }

    // Load metadata
    const meta = yield* loadWorkflowMeta(storage);

    if (!meta.workflowName) {
      yield* Effect.logError("Alarm fired but no workflow name found");
      return;
    }

    const workflowName = meta.workflowName;
    const input = meta.input;
    const executionId = meta.executionId;

    const workflowDef = workflows[workflowName as keyof T];
    if (!workflowDef) {
      yield* transitionWorkflow(
        storage,
        doId,
        workflowName,
        {
          _tag: "Fail",
          error: { message: `Unknown workflow: ${workflowName}` },
          completedSteps: [],
        },
        executionId,
      );
      return;
    }

    // Determine transition
    const transition: { _tag: "Start"; input: unknown } | { _tag: "Resume" } =
      status!._tag === "Queued"
        ? { _tag: "Start", input }
        : { _tag: "Resume" };

    // Execute workflow (this has its own Effect scope)
    yield* Effect.tryPromise(() =>
      executeWorkflow(workflowDef, input, doId, workflowName, transition, executionId)
    );
  });

  // Wrap with finalizer for interruption logging
  const alarmWithFinalizer = Effect.scoped(
    Effect.gen(function* () {
      // Log alarm entry
      console.log(
        JSON.stringify({
          level: "info",
          event: "alarm.started",
          doId,
          timestamp: new Date().toISOString(),
        })
      );

      // Add finalizer that logs exit information
      yield* Effect.addFinalizer((exit) =>
        Effect.sync(() => {
          const exitType = Exit.isSuccess(exit)
            ? "success"
            : Exit.isInterrupted(exit)
              ? "interrupted"
              : "failure";

          console.log(
            JSON.stringify({
              level: exitType === "success" ? "info" : "warn",
              event: "alarm.completed",
              doId,
              exitType,
              timestamp: new Date().toISOString(),
              ...(Exit.isFailure(exit) && !Exit.isInterrupted(exit) && {
                error: Cause.pretty(exit.cause),
              }),
            })
          );
        })
      );

      // Execute alarm logic
      yield* alarmEffect;
    })
  ).pipe(Effect.provide(trackerLayer));

  await Effect.runPromise(alarmWithFinalizer);
}
```

### Benefits of This Approach

1. **Single Effect scope**: All alarm logic runs within one Effect, enabling proper resource management
2. **Finalizer guaranteed** (within Effect runtime): The finalizer will run on success, failure, or Effect-level interruption
3. **Structured error handling**: All errors flow through Effect's error channel
4. **Composable**: Can easily add more layers (logging, tracing, etc.)
5. **Clear entry/exit logging**: Always know when alarm started and how it ended

### Important Caveat

The finalizer will run for:
- Normal completion (success or failure)
- Effect-level interruption (e.g., `Fiber.interrupt`)

The finalizer will **NOT** run for:
- Hard DO reset (process killed)
- JavaScript exceptions that bypass Effect (rare)

For hard resets, use constructor-based recovery detection (see below).

## Recommended Approach: Proactive Logging + Recovery Detection

Since finalizers won't run on hard resets, we need a complementary strategy:

### Strategy 1: Proactive Logging (Before Operations)

Log critical state BEFORE operations, not after:

```typescript
// Instead of relying on finalizers...
yield* Effect.addFinalizer(() => logCleanup());

// Log proactively BEFORE the operation
yield* Effect.log(`Starting workflow ${workflowId} on DO ${doId}`);
yield* executeWorkflow();
```

### Strategy 2: Recovery Detection in Constructor

Detect interruption by checking state on restart:

```typescript
constructor(state: DurableObjectState, env: unknown) {
  super(state, env as never);

  state.blockConcurrencyWhile(async () => {
    const status = await state.storage.get("workflow:status");
    const doId = state.id.toString();

    if (status?._tag === "Running") {
      // This DO was interrupted mid-execution!
      console.log(`[RECOVERY] DO ${doId} detected interrupted workflow`);
      console.log(`[RECOVERY] Status was: ${JSON.stringify(status)}`);

      // Schedule recovery
      await state.storage.setAlarm(Date.now() + 100);
    }
  });
}
```

### Strategy 3: Best-Effort Finalizer (Still Useful)

Even though finalizers won't run on hard resets, they ARE useful for:
- Normal completion logging
- Graceful failures
- Effect interruptions (from within Effect)

## Implementation: Enhanced Interruption Logging

### 1. Create Interruption Logger Service

```typescript
// packages/workflow/src/services/interruption-logger.ts

import { Context, Effect, Layer, Exit, Cause } from "effect";

/**
 * Service for logging workflow interruption/completion state.
 */
export interface InterruptionLoggerService {
  readonly workflowId: string;
  readonly doId: string;
}

export class InterruptionLogger extends Context.Tag("InterruptionLogger")<
  InterruptionLogger,
  InterruptionLoggerService
>() {}

/**
 * Create an interruption logger with finalizer for a workflow execution.
 *
 * The finalizer logs detailed information about how the workflow exited.
 * Note: This will NOT run if the DO is hard-reset (process kill).
 */
export const createInterruptionLogger = (
  workflowId: string,
  doId: string,
  workflowName: string,
): Effect.Effect<InterruptionLoggerService, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Log on entry
    console.log(
      JSON.stringify({
        level: "info",
        event: "workflow.execution.started",
        doId,
        workflowId,
        workflowName,
        timestamp: new Date().toISOString(),
      })
    );

    // Add finalizer that logs exit information
    yield* Effect.addFinalizer((exit) =>
      Effect.sync(() => {
        const baseLog = {
          doId,
          workflowId,
          workflowName,
          timestamp: new Date().toISOString(),
        };

        if (Exit.isSuccess(exit)) {
          console.log(
            JSON.stringify({
              ...baseLog,
              level: "info",
              event: "workflow.execution.completed",
              exitType: "success",
            })
          );
        } else if (Exit.isInterrupted(exit)) {
          const interruptors = Cause.interruptors(exit.cause);
          console.log(
            JSON.stringify({
              ...baseLog,
              level: "warn",
              event: "workflow.execution.interrupted",
              exitType: "interrupted",
              interruptors: [...interruptors].map(String),
              cause: Cause.pretty(exit.cause),
            })
          );
        } else {
          const error = Cause.failureOption(exit.cause);
          console.log(
            JSON.stringify({
              ...baseLog,
              level: "error",
              event: "workflow.execution.failed",
              exitType: "failure",
              error: error._tag === "Some"
                ? (error.value instanceof Error
                    ? { message: error.value.message, stack: error.value.stack }
                    : String(error.value))
                : "unknown",
              cause: Cause.pretty(exit.cause),
            })
          );
        }
      })
    );

    return { workflowId, doId };
  });

/**
 * Layer for interruption logging.
 */
export const InterruptionLoggerLayer = (
  workflowId: string,
  doId: string,
  workflowName: string,
): Layer.Layer<InterruptionLogger> =>
  Layer.scoped(
    InterruptionLogger,
    createInterruptionLogger(workflowId, doId, workflowName)
  );
```

### 2. Integrate into Engine

```typescript
// In engine.ts #executeWorkflow method

async #executeWorkflow(
  workflowDef: T[keyof T],
  input: unknown,
  workflowId: string,
  workflowName: string,
  transition: { _tag: "Start"; input: unknown } | { _tag: "Resume" },
  executionId?: string,
): Promise<void> {
  const storage = this.ctx.storage;
  const doId = this.ctx.id.toString();
  const execCtx = createExecutionContext(this.ctx);
  const workflowCtx = createWorkflowContext(
    workflowId,
    workflowName,
    input,
    storage,
    executionId,
  );

  const execution = Effect.gen(function* () {
    yield* transitionWorkflow(
      storage,
      workflowId,
      workflowName,
      transition,
      executionId,
    );

    const startTime = Date.now();
    const result = yield* workflowDef.definition(input).pipe(
      Effect.provideService(ExecutionContext, execCtx),
      Effect.provideService(WorkflowContext, workflowCtx),
      Effect.provideService(WorkflowScope, {
        _brand: "WorkflowScope" as const,
      }),
      Effect.exit,
    );

    yield* handleWorkflowResult(
      result,
      storage,
      workflowId,
      workflowName,
      startTime,
      executionId,
    );

    yield* flushEvents;
  }).pipe(
    Effect.provide(this.#trackerLayer),
    // ADD: Interruption logging layer
    Effect.provide(InterruptionLoggerLayer(workflowId, doId, workflowName)),
  );

  await Effect.runPromise(execution);
}
```

### 3. Add Recovery Detection in Constructor

```typescript
// In engine.ts constructor

constructor(state: DurableObjectState, env: unknown) {
  super(state, env as never);

  const doId = state.id.toString();

  // Recovery detection
  state.blockConcurrencyWhile(async () => {
    const status = await state.storage.get<WorkflowStatus>("workflow:status");

    // Log constructor invocation
    console.log(
      JSON.stringify({
        level: "info",
        event: "do.constructor.called",
        doId,
        existingStatus: status?._tag ?? "none",
        timestamp: new Date().toISOString(),
      })
    );

    // Detect potential interrupted workflow
    if (status?._tag === "Running") {
      console.log(
        JSON.stringify({
          level: "warn",
          event: "do.recovery.detected",
          doId,
          message: "Workflow was in Running state - likely interrupted by reset",
          status,
          timestamp: new Date().toISOString(),
        })
      );

      // Schedule recovery alarm
      const existingAlarm = await state.storage.getAlarm();
      if (!existingAlarm) {
        await state.storage.setAlarm(Date.now() + 100);
        console.log(
          JSON.stringify({
            level: "info",
            event: "do.recovery.alarm.scheduled",
            doId,
            timestamp: new Date().toISOString(),
          })
        );
      }
    }
  });
}
```

## Dummy Finalizer for Testing/Verification

Here's a minimal implementation you can add immediately to verify the logging.

### Option A: Add to `#executeWorkflow` (Workflow-Level)

```typescript
// Add to engine.ts in #executeWorkflow, right after creating the execution Effect

const executionWithLogging = execution.pipe(
  Effect.tap(() =>
    Effect.sync(() => {
      console.log(`[FINALIZER-ENTRY] DO=${this.ctx.id.toString()} workflow=${workflowId} name=${workflowName}`);
    })
  ),
  Effect.ensuring(
    Effect.sync(() => {
      console.log(`[FINALIZER-ENSURING] DO=${this.ctx.id.toString()} workflow=${workflowId} - ensuring block ran`);
    })
  ),
  Effect.onExit((exit) =>
    Effect.sync(() => {
      const exitType = Exit.isSuccess(exit)
        ? "SUCCESS"
        : Exit.isInterrupted(exit)
          ? "INTERRUPTED"
          : "FAILURE";
      console.log(`[FINALIZER-EXIT] DO=${this.ctx.id.toString()} workflow=${workflowId} exitType=${exitType}`);
    })
  ),
);

await Effect.runPromise(executionWithLogging);
```

### Option B: Add to `alarm()` Handler (Alarm-Level)

This is the simplest way to wrap the entire alarm in an Effect with a finalizer:

```typescript
// Replace the alarm() method in engine.ts

async alarm(): Promise<void> {
  const doId = this.ctx.id.toString();
  const storage = this.ctx.storage;

  // Wrap EVERYTHING in a single Effect with finalizer
  const alarmWithFinalizer = Effect.gen(function* () {
    // Entry log - will ALWAYS appear if alarm starts
    console.log(`[ALARM-ENTRY] DO=${doId} timestamp=${new Date().toISOString()}`);

    // Original alarm logic here...
    const status = yield* Effect.tryPromise(() =>
      storage.get<WorkflowStatus>("workflow:status")
    );

    console.log(`[ALARM-STATUS] DO=${doId} status=${status?._tag ?? "none"}`);

    if (status?._tag !== "Queued" && status?._tag !== "Paused") {
      console.log(`[ALARM-SKIP] DO=${doId} - not actionable status`);
      return;
    }

    // ... rest of alarm logic ...

  }).pipe(
    // FINALIZER: This runs on success, failure, or Effect interruption
    Effect.onExit((exit) =>
      Effect.sync(() => {
        const exitType = Exit.isSuccess(exit)
          ? "SUCCESS"
          : Exit.isInterrupted(exit)
            ? "INTERRUPTED"
            : "FAILURE";

        console.log(`[ALARM-EXIT] DO=${doId} exitType=${exitType} timestamp=${new Date().toISOString()}`);

        if (Exit.isFailure(exit) && !Exit.isInterrupted(exit)) {
          console.log(`[ALARM-ERROR] DO=${doId} cause=${Cause.pretty(exit.cause)}`);
        }
      })
    ),
    Effect.provide(this.#trackerLayer),
  );

  await Effect.runPromise(alarmWithFinalizer);
}
```

### Option C: Minimal Wrapper (Quickest to Add)

If you don't want to refactor the entire alarm, wrap just the call:

```typescript
async alarm(): Promise<void> {
  const doId = this.ctx.id.toString();

  console.log(`[ALARM-ENTRY] DO=${doId}`);

  const wrappedAlarm = Effect.tryPromise({
    try: () => this.#originalAlarmLogic(),
    catch: (e) => e,
  }).pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        const exitType = Exit.isSuccess(exit) ? "SUCCESS" : "FAILURE";
        console.log(`[ALARM-EXIT] DO=${doId} exitType=${exitType}`);
      })
    ),
  );

  await Effect.runPromise(wrappedAlarm);
}
```

## Expected Log Output

### Normal Alarm Completion (Option B)
```
[ALARM-ENTRY] DO=abc123 timestamp=2024-01-15T10:30:00.000Z
[ALARM-STATUS] DO=abc123 status=Paused
... workflow executes ...
[ALARM-EXIT] DO=abc123 exitType=SUCCESS timestamp=2024-01-15T10:30:05.000Z
```

### Alarm with Non-Actionable Status
```
[ALARM-ENTRY] DO=abc123 timestamp=2024-01-15T10:30:00.000Z
[ALARM-STATUS] DO=abc123 status=Completed
[ALARM-SKIP] DO=abc123 - not actionable status
[ALARM-EXIT] DO=abc123 exitType=SUCCESS timestamp=2024-01-15T10:30:00.050Z
```

### Alarm with Failure
```
[ALARM-ENTRY] DO=abc123 timestamp=2024-01-15T10:30:00.000Z
[ALARM-STATUS] DO=abc123 status=Paused
... workflow fails ...
[ALARM-EXIT] DO=abc123 exitType=FAILURE timestamp=2024-01-15T10:30:02.000Z
[ALARM-ERROR] DO=abc123 cause=Error: Something went wrong
```

### DO Reset During Alarm Execution
```
[ALARM-ENTRY] DO=abc123 timestamp=2024-01-15T10:30:00.000Z
[ALARM-STATUS] DO=abc123 status=Paused
<process killed - no more logs from this execution>

<after restart - constructor runs>
{"level":"info","event":"do.constructor.called","doId":"abc123",...}
{"level":"warn","event":"do.recovery.detected","doId":"abc123",...}
```

### Workflow-Level Logging (Option A)
```
[FINALIZER-ENTRY] DO=abc123 workflow=wf-456 name=processOrder
... workflow executes ...
[FINALIZER-EXIT] DO=abc123 workflow=wf-456 exitType=SUCCESS
[FINALIZER-ENSURING] DO=abc123 workflow=wf-456 - ensuring block ran
```

## Summary

| Mechanism | Runs on Normal Exit | Runs on DO Reset | Where to Add |
|-----------|---------------------|------------------|--------------|
| `Effect.addFinalizer` | Yes | No | Scoped effects |
| `Effect.ensuring` | Yes | No | Any effect |
| `Effect.onExit` | Yes | No | Any effect |
| Alarm wrapped in Effect | Yes | No | `alarm()` method |
| Constructor recovery check | N/A | Yes (after restart) | Constructor |
| Proactive logging (entry) | Yes | Yes (before kill) | Start of methods |

### Key Insight: Wrap `alarm()` in Effect

**Yes, you can wrap the alarm handler in an Effect with finalizers!** This gives you:

1. **Structured logging** - Entry and exit for every alarm invocation
2. **Error tracking** - Catch and log all failures
3. **Clean resource management** - Single Effect scope for the entire alarm

The finalizer will run for normal completion and Effect-level errors. For hard DO resets (process kill), the constructor-based recovery detection is your safety net.

### Recommended Implementation

1. **Alarm-level**: Wrap `alarm()` in `Effect.scoped` with `Effect.addFinalizer` (Option B above)
2. **Constructor**: Add recovery detection with `blockConcurrencyWhile`
3. **Proactive entry logs**: Log at the start of alarm/workflow execution

This combination ensures you have visibility into:
- Normal operations (finalizers run)
- Interrupted operations (entry log captured, recovery detection on restart)
