# Plan: Jobs Package Refactoring

This plan details the implementation of architectural improvements for `@durable-effect/jobs`, focusing on code deduplication, standardized retry logic, and type safety.

**Goals:**
1.  **Extract Job Runtime** (Refactor common logic).
2.  **Standardize Retry Logic** (Move complex signaling out of handlers).
3.  **Enhance Type Safety** (Fix unsafe casts in Debounce/Registry).
4.  **Unify Alarm Logic** (Standardize scheduling interactions).

---

## Phase 1: The `JobExecution` Abstraction

We will introduce a new service/layer `src/runtime/execution.ts` that abstracts the common lifecycle of a durable job execution.

### Responsibilities of `JobExecutionService`
1.  **Service Resolution**: Injects `Storage`, `Metadata`, `Alarm`, `Retry` automatically.
2.  **State Lifecycle**: Handles the `EntityStateService` "checkout/checkin" pattern (get state -> run -> save if dirty).
3.  **Error Boundary**:
    *   Catches user errors.
    *   Wraps them in `ExecutionError`.
    *   Invokes `onError` definition callbacks.
    *   Handles `TerminateSignal`.
4.  **Retry Orchestration**:
    *   Wraps the execution in `RetryExecutor`.
    *   Internally handles `RetryScheduledSignal` (swallowing it effectively, as it's a valid flow control).
    *   Internally handles `RetryExhaustedError` (triggering `onError`).

### Proposed Interface

```typescript
interface JobExecutionService {
  /**
   * Run a standard job execution cycle.
   */
  execute<S, E, R, Context>(options: {
    // Identity
    jobType: string;
    jobName: string;
    
    // Definition parts
    schema: Schema<S>;
    retryConfig?: JobRetryConfig;
    
    // User functions
    run: (state: S, ctx: Context) => Effect<void, E, R>;
    onError?: (error: E, ctx: Context) => Effect<void, never, R>;
    
    // Context Factory (State is loaded by the runner and passed here)
    createContext: (
      base: { 
        state: S; 
        instanceId: string; 
        runCount: number; 
        attempt: number 
      }
    ) => Context;

    // Optional: Should we save state after execution? (Default true)
    persistState?: boolean;
  }): Effect<
    { 
      success: boolean; 
      retryScheduled: boolean;
      terminated: boolean 
    }, 
    ExecutionError
  >;
}
```

## Phase 2: Refactor `ContinuousHandler`

Refactor `src/handlers/continuous/handler.ts` to use `JobExecutionService`.

**Changes:**
1.  Remove `EntityStateService`, `StorageAdapter`, `RetryExecutor` manual usage.
2.  Simplify `handleAlarm` to just call `execution.execute(...)` and then `scheduleNext`.
3.  The complex `Effect.catchTag("RetryScheduledSignal", ...)` logic will disappear from the handler, as `execution.execute` will return a status flag indicating if a retry was scheduled.

## Phase 3: Type Safety & Debounce Refactor

Refactor `src/handlers/debounce/handler.ts`.

**Type Safety Improvements:**
1.  **Debounce Generics**: Update `DebounceDefinition` to ensure Input `I` is assignable to State `S` if `onEvent` is not provided (auto-initialization).
    *   Currently: `S` defaults to `I`, but `onEvent` default implementation casts.
    *   Fix: Add constraint or improve default `onEvent` typing.
2.  **Registry Casts**: Review `src/registry/registry.ts` and remove `as any` where possible by strictly typing the mapping functions.

**Handler Refactor:**
1.  Use `JobExecutionService` for the `flush` operation.
2.  Note: `debounce.add` is unique (read-modify-write without full execution). It might stick to using `EntityStateService` directly or use a specialized `execution.updateState(...)` method if we decide to add one.

## Phase 4: Refactor `TaskHandler`

Refactor `src/handlers/task/handler.ts`.

**Challenges:**
*   `TaskHandler` has complex `onIdle` logic and explicit scheduling control (`TaskScheduleHolder`).
*   It supports `clear` and `trigger`.

**Approach:**
1.  Enhance `JobExecutionService` to support "Post-Execution Hooks" or ensure the `Context` passed to `run` allows mutating a `ScheduleHolder` that the runner inspects afterwards.
2.  Alternatively, keep `TaskHandler` slightly more manual but use the `JobExecutionService` for the *core execution* block to reuse the Error/Retry/State wrapping.

## Phase 5: Implementation Order

1.  **Create `src/runtime/execution.ts`**: Implement the `JobExecutionService`.
2.  **Refactor `ContinuousHandler`**: Prove the abstraction works for the simplest case.
3.  **Refactor `DebounceHandler`**: Address type safety and flush logic.
4.  **Refactor `TaskHandler`**: Handle the complex scheduling needs.
5.  **Cleanup**: Remove unused imports and legacy utils.
