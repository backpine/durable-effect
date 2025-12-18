# Report 056: Unified Termination & Error Handling Implementation Plan

## Summary

Simplify the jobs error handling model by:
1. **Remove `onError`** from all job types
2. **Remove `isRetryable` and `onRetryExhausted`** from retry config
3. **Add `onRetryExhausted`** to job definitions with typed error access
4. **Unify `terminate` naming** across all job types (rename Task's `clear`)
5. **Default to terminate on retry exhaustion** for cost control

---

## Design Goals

| Goal | Rationale |
|------|-----------|
| Remove `onError` | Simplifies API, reduces confusion about when it's called |
| All errors from `execute` are retryable | No need for `isRetryable` - infrastructure handles retries |
| Default terminate on exhaustion | Prevents orphaned state accumulating (cost control) |
| `onRetryExhausted` with typed error | Last-ditch control for users who need to preserve state |
| Unified `terminate` naming | Consistent API across all job types |

---

## New API Design

### Retry Config (Simplified)

```typescript
// packages/jobs/src/retry/types.ts

// BEFORE
interface JobRetryConfig<E> {
  maxAttempts: number;
  delay: DelayInput;
  maxDuration?: Duration.DurationInput;
  jitter?: boolean;
  isRetryable?(error: E): boolean;        // REMOVE
  onRetryExhausted?(info: RetryExhaustedInfo<E>): void;  // MOVE
}

// AFTER
interface JobRetryConfig {
  maxAttempts: number;
  delay: DelayInput;
  maxDuration?: Duration.DurationInput;
  jitter?: boolean;
  // That's it - simple and focused on retry timing only
}
```

### Job Definitions (with `onRetryExhausted`)

```typescript
// Continuous Job
Continuous.make({
  stateSchema: MyState,
  schedule: Continuous.every("10 seconds"),
  retry: {
    maxAttempts: 3,
    delay: "1 second",
  },

  // Required: main execution logic
  execute: (ctx) => Effect.gen(function* () {
    // Effect<void, E, R>
    // All errors from here are retryable
  }),

  // REMOVED: onError

  // NEW (optional): called when retries exhausted
  onRetryExhausted: (error, ctx) => Effect.gen(function* () {
    // error: E (typed!)
    // ctx: OnRetryExhaustedContext<S>

    // Options:
    // 1. Let it return - state preserved, job paused
    yield* Effect.log("Retries exhausted, preserving state for debugging");

    // 2. Terminate explicitly - state purged
    yield* ctx.terminate();

    // 3. Reschedule - reset retries, try again later
    yield* ctx.reschedule("1 hour");
  }),
});

// Task Job
Task.make({
  stateSchema: MyState,
  eventSchema: MyEvent,
  retry: { maxAttempts: 3, delay: "1 second" },

  onEvent: (event, ctx) => ...,
  execute: (ctx) => ...,

  // REMOVED: onError

  // NEW (optional)
  onRetryExhausted: (error, ctx) => Effect.gen(function* () {
    yield* ctx.terminate();
  }),
});

// Debounce Job
Debounce.make({
  stateSchema: MyState,
  eventSchema: MyEvent,
  flushAfter: "30 seconds",
  retry: { maxAttempts: 3, delay: "1 second" },

  onEvent: (ctx) => ...,
  execute: (ctx) => ...,

  // REMOVED: onError

  // NEW (optional)
  onRetryExhausted: (error, ctx) => Effect.gen(function* () {
    yield* ctx.terminate();
  }),
});
```

### Context Types

```typescript
// OnRetryExhaustedContext - provided to onRetryExhausted handler
interface OnRetryExhaustedContext<S> {
  // State access
  readonly state: S;  // Synchronous for Continuous
  // OR
  readonly state: Effect<S | null>;  // Effect for Task/Debounce

  // Metadata
  readonly instanceId: string;
  readonly jobName: string;
  readonly attempts: number;
  readonly totalDurationMs: number;

  // Actions
  /**
   * Terminate job - cancel alarm, delete all storage.
   * This is the default behavior if onRetryExhausted is not defined.
   */
  readonly terminate: () => Effect<void>;

  /**
   * Reschedule execution - reset retry state, schedule for later.
   * Use when you want to try again after a longer delay.
   */
  readonly reschedule: (delay: Duration.DurationInput) => Effect<void>;
}
```

### Unified `terminate` Naming

```typescript
// Task context - rename clear() to terminate()
interface TaskEventContext<S> {
  // ...

  // BEFORE
  readonly clear: () => Effect<never>;

  // AFTER
  readonly terminate: () => Effect<void>;
}

interface TaskExecuteContext<S> {
  // ...
  readonly terminate: () => Effect<void>;
}

interface TaskIdleContext<S> {
  // ...
  readonly terminate: () => Effect<void>;
}

// Client API changes
interface TaskClient<S, E> {
  // BEFORE
  clear(id: string): Effect<TaskClearResponse>;

  // AFTER
  terminate(id: string): Effect<TaskTerminateResponse>;
}
```

---

## Behavior Matrix

### Without `onRetryExhausted` (Default)

| Event | Behavior |
|-------|----------|
| Execute succeeds | Continue normally, schedule next (if applicable) |
| Execute fails, retries remaining | Schedule retry |
| Execute fails, retries exhausted | **TERMINATE** (cancel alarm, delete all storage) |
| User calls `ctx.terminate()` | Cancel alarm, delete all storage |

### With `onRetryExhausted` Defined

| Event | Behavior |
|-------|----------|
| Execute succeeds | Continue normally |
| Execute fails, retries remaining | Schedule retry |
| Execute fails, retries exhausted | Call `onRetryExhausted(error, ctx)` |
| `onRetryExhausted` calls `ctx.terminate()` | Cancel alarm, delete all storage |
| `onRetryExhausted` calls `ctx.reschedule()` | Reset retry state, schedule for later |
| `onRetryExhausted` returns without action | Cancel retry alarm, preserve state, job paused |

---

## Implementation Plan

### Phase 1: Create CleanupService

**Files:**
- `packages/jobs/src/services/cleanup.ts` (NEW)
- `packages/jobs/src/services/index.ts` (update exports)

```typescript
// packages/jobs/src/services/cleanup.ts

export interface CleanupServiceI {
  /**
   * Terminate the job instance completely.
   * Cancels alarm and deletes all storage.
   */
  readonly terminate: () => Effect<void, StorageError | SchedulerError>;
}

export class CleanupService extends Context.Tag(
  "@durable-effect/jobs/CleanupService"
)<CleanupService, CleanupServiceI>() {}

export const CleanupServiceLayer = Layer.effect(
  CleanupService,
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const alarm = yield* AlarmService;

    return {
      terminate: () => Effect.gen(function* () {
        yield* alarm.cancel();
        yield* storage.deleteAll();
      }),
    };
  })
);
```

### Phase 2: Simplify RetryConfig Types

**Files:**
- `packages/jobs/src/retry/types.ts`

```typescript
// BEFORE
export interface JobRetryConfig<E = unknown> extends BaseRetryConfig {
  isRetryable?(error: E): boolean;
  onRetryExhausted?(info: RetryExhaustedInfo<E>): void;
}

// AFTER
export interface JobRetryConfig extends BaseRetryConfig {
  // Only timing configuration
}

// Keep RetryExhaustedInfo but move to separate file for job definitions
export interface RetryExhaustedInfo {
  readonly jobType: "continuous" | "debounce" | "task" | "workerPool";
  readonly jobName: string;
  readonly instanceId: string;
  readonly attempts: number;
  readonly totalDurationMs: number;
}
```

### Phase 3: Update RetryExecutor

**Files:**
- `packages/jobs/src/retry/executor.ts`

Changes:
1. Remove `isRetryable` check - all errors are retryable
2. Remove `onRetryExhausted` callback
3. Add `TerminateSignal` bypass (don't treat as retryable)
4. Return new signal `RetryExhaustedSignal` instead of error

```typescript
executeWithRetry: <A, E, R>(
  effect: Effect<A, E, R>,
  config: JobRetryConfig,
  context: { jobType; jobName }
): Effect<A, E | RetryExhaustedSignal | RetryScheduledSignal, R> =>
  Effect.gen(function* () {
    const attempt = yield* getAttempt();

    // Check max duration first
    if (config.maxDuration && durationExceeded) {
      yield* reset();
      return yield* Effect.fail(new RetryExhaustedSignal({ ... }));
    }

    // Execute
    const result = yield* effect.pipe(
      Effect.map((a) => ({ _tag: "Success", value: a })),
      Effect.catchAll((e) => {
        // Let TerminateSignal bypass retry
        if (e instanceof TerminateSignal) {
          return Effect.fail(e);
        }
        return Effect.succeed({ _tag: "Failure", error: e });
      })
    );

    if (result._tag === "Success") {
      yield* reset();
      return result.value;
    }

    const error = result.error;

    // ALL errors are retryable (removed isRetryable check)

    if (attempt >= config.maxAttempts) {
      // Exhausted - return signal, let handler decide
      yield* reset();
      return yield* Effect.fail(
        new RetryExhaustedSignal({
          ...context,
          instanceId: runtime.instanceId,
          attempts: attempt,
          lastError: error,
          totalDurationMs: now - startedAt,
        })
      );
    }

    // Schedule retry
    yield* setAttempt(attempt + 1);
    yield* alarm.schedule(resumeAt);
    return yield* Effect.fail(new RetryScheduledSignal({ ... }));
  });
```

### Phase 4: Update JobExecutionService

**Files:**
- `packages/jobs/src/services/execution.ts`

Changes:
1. Remove `onError` handling
2. Add `onRetryExhausted` support
3. Use `CleanupService` for termination
4. Handle `TerminateSignal` uniformly

```typescript
export interface ExecuteOptions<S, E, R, Ctx> {
  // ... existing
  readonly onRetryExhausted?: (
    error: E,
    ctx: OnRetryExhaustedContext<S>
  ) => Effect<void, never, R>;
}

export interface ExecutionResult {
  readonly success: boolean;
  readonly retryScheduled: boolean;
  readonly terminated: boolean;
  readonly retryExhausted: boolean;
}

// In execute():
yield* executionEffect.pipe(
  Effect.catchAll((error) => {
    if (error instanceof TerminateSignal) {
      // User called terminate - clean up
      return cleanup.terminate().pipe(
        Effect.map(() => ({ terminated: true }))
      );
    }

    if (error instanceof RetryScheduledSignal) {
      return Effect.succeed({ retryScheduled: true });
    }

    if (error instanceof RetryExhaustedSignal) {
      if (options.onRetryExhausted) {
        // User has handler - call it
        const exhaustedCtx = createOnRetryExhaustedContext(...);
        return options.onRetryExhausted(error.lastError, exhaustedCtx).pipe(
          Effect.map(() => ({
            retryExhausted: true,
            terminated: exhaustedCtx._terminated,
          }))
        );
      }
      // No handler - default terminate
      return cleanup.terminate().pipe(
        Effect.map(() => ({ terminated: true, retryExhausted: true }))
      );
    }

    // Should not reach here with retry configured
    return Effect.fail(error);
  })
);
```

### Phase 5: Update Job Definition Types

**Files:**
- `packages/jobs/src/registry/types.ts`

```typescript
// Remove onError from all job types

// Add onRetryExhausted to Continuous
export interface UnregisteredContinuousDefinition<S, E, R> {
  readonly _tag: "ContinuousDefinition";
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;
  readonly retry?: JobRetryConfig;  // No longer generic
  execute(ctx: ContinuousContext<S>): Effect<void, E, R>;
  // REMOVED: onError
  onRetryExhausted?(error: E, ctx: OnRetryExhaustedContext<S>): Effect<void, never, R>;
}

// Add onRetryExhausted to Task
export interface UnregisteredTaskDefinition<S, E, Err, R> {
  // ...
  onEvent(event: E, ctx: TaskEventContext<S>): Effect<void, Err, R>;
  execute(ctx: TaskExecuteContext<S>): Effect<void, Err, R>;
  // REMOVED: onError
  onRetryExhausted?(error: Err, ctx: OnRetryExhaustedContext<S>): Effect<void, never, R>;
}

// Add onRetryExhausted to Debounce
export interface UnregisteredDebounceDefinition<I, S, E, R> {
  // ...
  execute(ctx: DebounceExecuteContext<S>): Effect<void, E, R>;
  // REMOVED: onError
  onRetryExhausted?(error: E, ctx: OnRetryExhaustedContext<S>): Effect<void, never, R>;
}

// Add OnRetryExhaustedContext
export interface OnRetryExhaustedContext<S> {
  /** Current state (synchronous for Continuous, may be null for others) */
  readonly state: S | null;
  readonly instanceId: string;
  readonly jobName: string;
  /** Number of attempts made before exhaustion */
  readonly attempts: number;
  /** Total time spent retrying */
  readonly totalDurationMs: number;

  /**
   * Terminate the job - cancel alarm, delete all storage.
   * This is the default behavior if onRetryExhausted is not defined.
   */
  readonly terminate: () => Effect<void, never, never>;

  /**
   * Reschedule execution - reset retry count, schedule for later.
   * Use for "try again tomorrow" patterns.
   */
  readonly reschedule: (delay: Duration.DurationInput) => Effect<void, never, never>;
}
```

### Phase 6: Rename Task `clear` to `terminate`

**Files:**
- `packages/jobs/src/registry/types.ts` (contexts)
- `packages/jobs/src/handlers/task/context.ts`
- `packages/jobs/src/handlers/task/handler.ts`
- `packages/jobs/src/runtime/types.ts` (request/response types)
- `packages/jobs/src/client/types.ts`
- `packages/jobs/src/client/client.ts`
- `packages/jobs/src/client/response.ts`

```typescript
// Context changes
interface TaskEventContext<S> {
  // BEFORE: readonly clear: () => Effect<never>;
  readonly terminate: () => Effect<void>;
}

// Response type changes
// BEFORE: TaskClearResponse
// AFTER: TaskTerminateResponse
export interface TaskTerminateResponse {
  readonly _type: "task.terminate";
  readonly instanceId: string;
  readonly terminated: boolean;
}

// Client changes
interface TaskClient<S, E> {
  // BEFORE: clear(id)
  terminate(id: string): Effect<TaskTerminateResponse>;
}
```

### Phase 7: Update Handlers

**Files:**
- `packages/jobs/src/handlers/continuous/handler.ts`
- `packages/jobs/src/handlers/task/handler.ts`
- `packages/jobs/src/handlers/debounce/handler.ts`

Changes for each handler:
1. Use `CleanupService` for termination
2. Pass `onRetryExhausted` to `JobExecutionService`
3. Remove `onError` handling code
4. Simplify result checking (no more manual alarm.cancel)

```typescript
// In ContinuousHandlerLayer
const runExecution = (def, runCount) =>
  execution.execute({
    jobType: "continuous",
    jobName: def.name,
    schema: def.stateSchema,
    retryConfig: def.retry,
    runCount,
    onRetryExhausted: def.onRetryExhausted,  // Pass through
    // REMOVED: onError
    run: (ctx) => def.execute(ctx),
    createContext: (base) => createContinuousContext(...),
  });

// In handleTrigger, handleAlarm, etc:
const result = yield* runExecution(def, runCount);

if (result.terminated) {
  // CleanupService already handled everything
  return { _type: "continuous.trigger", triggered: true, terminated: true };
}

if (result.retryScheduled) {
  return { _type: "continuous.trigger", triggered: true, retryScheduled: true };
}

// Success - schedule next
yield* scheduleNext(def);
return { _type: "continuous.trigger", triggered: true };
```

### Phase 8: Update Definition Factories

**Files:**
- `packages/jobs/src/definitions/continuous.ts`
- `packages/jobs/src/definitions/task.ts`
- `packages/jobs/src/definitions/debounce.ts`

```typescript
// Continuous.make
export interface ContinuousMakeConfig<S, E, R> {
  stateSchema: Schema.Schema<S, any, never>;
  schedule: ContinuousSchedule;
  startImmediately?: boolean;
  retry?: JobRetryConfig;  // No longer JobRetryConfig<E>
  execute: (ctx: ContinuousContext<S>) => Effect<void, E, R>;
  // REMOVED: onError
  onRetryExhausted?: (error: E, ctx: OnRetryExhaustedContext<S>) => Effect<void, never, R>;
}

// Task.make
export interface TaskMakeConfig<S, E, Err, R> {
  stateSchema: Schema.Schema<S, any, never>;
  eventSchema: Schema.Schema<E, any, never>;
  retry?: JobRetryConfig;
  onEvent: (event: E, ctx: TaskEventContext<S>) => Effect<void, Err, R>;
  execute: (ctx: TaskExecuteContext<S>) => Effect<void, Err, R>;
  onIdle?: (ctx: TaskIdleContext<S>) => Effect<void, never, R>;
  // REMOVED: onError
  onRetryExhausted?: (error: Err, ctx: OnRetryExhaustedContext<S>) => Effect<void, never, R>;
}
```

### Phase 9: Update Tests

**Files:**
- `packages/jobs/test/handlers/continuous.test.ts`
- `packages/jobs/test/handlers/task.test.ts`
- Other test files

Changes:
1. Remove tests for `onError`
2. Remove tests for `isRetryable`
3. Add tests for `onRetryExhausted` behavior
4. Update `clear` → `terminate` in Task tests
5. Test default termination on exhaustion

---

## Migration Guide

### For Users

```typescript
// BEFORE (v1)
Continuous.make({
  stateSchema: MyState,
  schedule: Continuous.every("10 seconds"),
  retry: {
    maxAttempts: 3,
    delay: "1 second",
    isRetryable: (e) => !(e instanceof FatalError),
    onRetryExhausted: (info) => console.log("Exhausted", info),
  },
  execute: (ctx) => ...,
  onError: (error, ctx) => Effect.gen(function* () {
    yield* Effect.log("Error", error);
    yield* ctx.terminate();
  }),
});

// AFTER (v2)
Continuous.make({
  stateSchema: MyState,
  schedule: Continuous.every("10 seconds"),
  retry: {
    maxAttempts: 3,
    delay: "1 second",
  },
  execute: (ctx) => Effect.gen(function* () {
    // Handle FatalError explicitly if needed
    const result = yield* dangerousOperation().pipe(
      Effect.catchTag("FatalError", (e) => ctx.terminate())
    );
  }),
  // Replace onError with onRetryExhausted
  onRetryExhausted: (error, ctx) => Effect.gen(function* () {
    yield* Effect.log("Retries exhausted", error);
    yield* ctx.terminate();
  }),
});

// Task: clear() → terminate()
// BEFORE
yield* ctx.clear();
// AFTER
yield* ctx.terminate();
```

---

## Files Summary

### New Files
- `packages/jobs/src/services/cleanup.ts`

### Modified Files (Core)
- `packages/jobs/src/retry/types.ts` - Simplify JobRetryConfig
- `packages/jobs/src/retry/executor.ts` - Remove isRetryable, add signal bypass
- `packages/jobs/src/retry/errors.ts` - Add RetryExhaustedSignal
- `packages/jobs/src/services/execution.ts` - Use CleanupService, add onRetryExhausted
- `packages/jobs/src/services/index.ts` - Export CleanupService
- `packages/jobs/src/errors.ts` - Simplify TerminateSignal (remove purgeState option)

### Modified Files (Types)
- `packages/jobs/src/registry/types.ts` - Add OnRetryExhaustedContext, remove onError, rename clear→terminate
- `packages/jobs/src/runtime/types.ts` - TaskClearRequest→TaskTerminateRequest, responses

### Modified Files (Handlers)
- `packages/jobs/src/handlers/continuous/handler.ts`
- `packages/jobs/src/handlers/continuous/context.ts`
- `packages/jobs/src/handlers/task/handler.ts`
- `packages/jobs/src/handlers/task/context.ts`
- `packages/jobs/src/handlers/debounce/handler.ts`

### Modified Files (Client)
- `packages/jobs/src/client/types.ts` - TaskClient.clear→terminate
- `packages/jobs/src/client/client.ts` - Implementation
- `packages/jobs/src/client/response.ts` - Response type map

### Modified Files (Definitions)
- `packages/jobs/src/definitions/continuous.ts`
- `packages/jobs/src/definitions/task.ts`
- `packages/jobs/src/definitions/debounce.ts`

### Modified Files (Tests)
- `packages/jobs/test/handlers/continuous.test.ts`
- `packages/jobs/test/handlers/task.test.ts`
- Other test files as needed

### Modified Files (Examples)
- `examples/effect-worker-v2/src/jobs/heartbeat.ts`
- `examples/effect-worker-v2/src/jobs/basic-task.ts`
- `examples/effect-worker-v2/src/routes/jobs/task.ts`

---

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| Error callbacks | `onError` at job level + `onRetryExhausted` in retry config | Only `onRetryExhausted` at job level |
| Retry decision | `isRetryable(error)` | All errors from execute are retryable |
| Exhaustion default | Depends on config | **Terminate** (cost control) |
| Exhaustion custom | Callback in retry config | `onRetryExhausted` on job definition |
| Error typing | `unknown` in many places | Typed `E` from execute signature |
| Cleanup naming | `clear` (Task) vs `terminate` (Continuous) | `terminate` everywhere |
| Cleanup behavior | Signal-based, split responsibilities | `CleanupService` handles all |
