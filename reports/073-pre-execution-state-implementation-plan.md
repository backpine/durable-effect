# Pre-Execution State Tracking Implementation Plan

Based on the design in `reports/071-pre-execution-state-tracking-design.md`, this document provides a step-by-step implementation plan with exact file locations, code changes, and verification steps.

## Executive Summary

Add `preExecutionState` field to `job.executed` and `job.failed` events to capture the state that existed before user code ran. This enables tracking systems to understand what data jobs operated on and debug failures effectively.

**Scope of Changes:**
- 2 files in `@packages/core/` (schema + types)
- 1 file in `@packages/jobs/` (execution service)
- Optional: 1 file consistency fix (task context)

**Estimated LOC Changes:** ~60 lines added/modified

---

## Pre-Implementation Analysis

### Current Event Emission Points

All job events are emitted from `packages/jobs/src/services/execution.ts`:

| Event Type | Line | Trigger | Current Fields |
|------------|------|---------|----------------|
| `job.failed` (willRetry=true) | 209-223 | RetryScheduledSignal | error, runCount, attempt, willRetry |
| `job.failed` (willRetry=false) | 269-285 | Unhandled error | error, runCount, attempt, willRetry |
| `job.executed` | 300-311 | Successful execution | runCount, durationMs, attempt |

### State Loading Point

```typescript
// execution.ts:116-127
const loadedState = yield* stateService.get().pipe(
  withStorage,
  Effect.mapError((e) => new ExecutionError({ ... }))
);
```

This is the **only** storage read for state. The `loadedState` captured here represents the pre-execution snapshot.

### Context State Access Verification

Verified that all context types read state from the in-memory holder, NOT from storage:

| Context Type | File:Line | State Access | IO Impact |
|--------------|-----------|--------------|-----------|
| `ContinuousContext` | continuous/context.ts:42 | `Effect.sync(() => stateHolder.current)` | None |
| `TaskEventContext` | task/context.ts:104 | `Effect.sync(() => stateHolder.current)` | None |
| `TaskExecuteContext` | task/context.ts:159-161 | `stateHolder.dirty ? Effect.succeed(...) : getState()` | None* |
| `TaskIdleContext` | task/context.ts:215-217 | Same pattern as TaskExecuteContext | None* |
| `TaskErrorContext` | task/context.ts:245-247 | Same pattern as TaskExecuteContext | None* |
| `DebounceExecuteContext` | debounce/handler.ts:108 | `Effect.succeed(base.getState())` | None |

*Note: The `getState()` fallback in TaskExecuteContext is passed as `() => Effect.succeed(base.getState())` from the handler, which reads from the holder - NOT storage.

**Conclusion:** No redundant IO exists in current implementation. The original design concern was based on a hypothetical scenario that doesn't occur in practice.

---

## Implementation Steps

### Step 1: Update Internal Event Schemas (core/events.ts)

**File:** `packages/core/src/events.ts`

**Change 1a:** Add `preExecutionState` to `InternalJobExecutedEventSchema` (around line 582-592)

```typescript
// BEFORE:
export const InternalJobExecutedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.executed"),
  /** Run number (1-indexed) */
  runCount: Schema.Number,
  /** Execution duration in milliseconds */
  durationMs: Schema.Number,
  /** Current retry attempt (1 = first attempt) */
  attempt: Schema.Number,
});

// AFTER:
export const InternalJobExecutedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.executed"),
  /** Run number (1-indexed) */
  runCount: Schema.Number,
  /** Execution duration in milliseconds */
  durationMs: Schema.Number,
  /** Current retry attempt (1 = first attempt) */
  attempt: Schema.Number,
  /** State snapshot before execution (for tracking/debugging) */
  preExecutionState: Schema.optional(Schema.Unknown),
});
```

**Change 1b:** Add `preExecutionState` to `InternalJobFailedEventSchema` (around line 597-608)

```typescript
// BEFORE:
export const InternalJobFailedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.failed"),
  error: JobErrorSchema,
  /** Run number when failure occurred */
  runCount: Schema.Number,
  /** Retry attempt when failure occurred */
  attempt: Schema.Number,
  /** Whether a retry will be attempted */
  willRetry: Schema.Boolean,
});

// AFTER:
export const InternalJobFailedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.failed"),
  error: JobErrorSchema,
  /** Run number when failure occurred */
  runCount: Schema.Number,
  /** Retry attempt when failure occurred */
  attempt: Schema.Number,
  /** Whether a retry will be attempted */
  willRetry: Schema.Boolean,
  /** State snapshot before execution (for tracking/debugging) */
  preExecutionState: Schema.optional(Schema.Unknown),
});
```

### Step 2: Update Wire Event Schemas (core/events.ts)

**Change 2a:** Add `preExecutionState` to `JobExecutedEventSchema` (around line 725-732)

```typescript
// BEFORE:
export const JobExecutedEventSchema = Schema.Struct({
  ...WireJobBaseFields,
  type: Schema.Literal("job.executed"),
  runCount: Schema.Number,
  durationMs: Schema.Number,
  attempt: Schema.Number,
});

// AFTER:
export const JobExecutedEventSchema = Schema.Struct({
  ...WireJobBaseFields,
  type: Schema.Literal("job.executed"),
  runCount: Schema.Number,
  durationMs: Schema.Number,
  attempt: Schema.Number,
  preExecutionState: Schema.optional(Schema.Unknown),
});
```

**Change 2b:** Add `preExecutionState` to `JobFailedEventSchema` (around line 734-742)

```typescript
// BEFORE:
export const JobFailedEventSchema = Schema.Struct({
  ...WireJobBaseFields,
  type: Schema.Literal("job.failed"),
  error: JobErrorSchema,
  runCount: Schema.Number,
  attempt: Schema.Number,
  willRetry: Schema.Boolean,
});

// AFTER:
export const JobFailedEventSchema = Schema.Struct({
  ...WireJobBaseFields,
  type: Schema.Literal("job.failed"),
  error: JobErrorSchema,
  runCount: Schema.Number,
  attempt: Schema.Number,
  willRetry: Schema.Boolean,
  preExecutionState: Schema.optional(Schema.Unknown),
});
```

### Step 3: Update ExecuteOptions Interface (jobs/services/execution.ts)

**File:** `packages/jobs/src/services/execution.ts`

**Change 3:** Add `includeStateInEvents` option (around line 39-51)

```typescript
// BEFORE:
export interface ExecuteOptions<S, E, R, Ctx> {
  readonly jobType: "continuous" | "debounce" | "task" | "workerPool";
  readonly jobName: string;
  readonly schema: Schema.Schema<S, any, never>;
  readonly retryConfig?: JobRetryConfig;
  readonly runCount?: number;
  readonly allowNullState?: boolean;
  /** User-provided ID for business logic correlation (included in events) */
  readonly id?: string;

  readonly run: (ctx: Ctx) => Effect.Effect<void, E, R>;
  readonly createContext: (base: ExecutionContextBase<S>) => Ctx;
}

// AFTER:
export interface ExecuteOptions<S, E, R, Ctx> {
  readonly jobType: "continuous" | "debounce" | "task" | "workerPool";
  readonly jobName: string;
  readonly schema: Schema.Schema<S, any, never>;
  readonly retryConfig?: JobRetryConfig;
  readonly runCount?: number;
  readonly allowNullState?: boolean;
  /** User-provided ID for business logic correlation (included in events) */
  readonly id?: string;
  /** Include pre-execution state in tracking events (default: true) */
  readonly includeStateInEvents?: boolean;

  readonly run: (ctx: Ctx) => Effect.Effect<void, E, R>;
  readonly createContext: (base: ExecutionContextBase<S>) => Ctx;
}
```

### Step 4: Capture and Emit State in Events (jobs/services/execution.ts)

**Change 4a:** Extract `includeStateInEvents` from options (around line 99-107)

```typescript
// BEFORE:
const {
  jobType,
  jobName,
  schema,
  retryConfig,
  run,
  createContext,
  id,
} = options;

// AFTER:
const {
  jobType,
  jobName,
  schema,
  retryConfig,
  run,
  createContext,
  id,
  includeStateInEvents = true,
} = options;
```

**Change 4b:** Capture pre-execution state after loading (around line 127, after loadedState assignment)

```typescript
// ADD after line 127 (after the if block checking for null state):
// Capture pre-execution state snapshot for tracking events
// This is the state BEFORE user code runs
const preExecutionState = includeStateInEvents ? loadedState : undefined;
```

**Change 4c:** Include state in `job.failed` (willRetry=true) event (around line 209-223)

```typescript
// BEFORE:
return emitEvent({
  ...createJobBaseEvent(
    runtime.instanceId,
    jobType,
    jobName,
    id,
  ),
  type: "job.failed" as const,
  error: {
    message: `Retry scheduled for attempt ${error.attempt}`,
  },
  runCount: options.runCount ?? 0,
  attempt: failedAttempt,
  willRetry: true,
} satisfies InternalJobFailedEvent);

// AFTER:
return emitEvent({
  ...createJobBaseEvent(
    runtime.instanceId,
    jobType,
    jobName,
    id,
  ),
  type: "job.failed" as const,
  error: {
    message: `Retry scheduled for attempt ${error.attempt}`,
  },
  runCount: options.runCount ?? 0,
  attempt: failedAttempt,
  willRetry: true,
  ...(preExecutionState !== undefined && { preExecutionState }),
} satisfies InternalJobFailedEvent);
```

**Change 4d:** Include state in `job.failed` (willRetry=false) event (around line 269-285)

```typescript
// BEFORE:
return emitEvent({
  ...createJobBaseEvent(
    runtime.instanceId,
    jobType,
    jobName,
    id,
  ),
  type: "job.failed" as const,
  error: {
    message: errorMessage,
    stack: errorStack,
  },
  runCount: options.runCount ?? 0,
  attempt,
  willRetry: false,
} satisfies InternalJobFailedEvent).pipe(
  Effect.zipRight(Effect.fail(wrapError(error))),
);

// AFTER:
return emitEvent({
  ...createJobBaseEvent(
    runtime.instanceId,
    jobType,
    jobName,
    id,
  ),
  type: "job.failed" as const,
  error: {
    message: errorMessage,
    stack: errorStack,
  },
  runCount: options.runCount ?? 0,
  attempt,
  willRetry: false,
  ...(preExecutionState !== undefined && { preExecutionState }),
} satisfies InternalJobFailedEvent).pipe(
  Effect.zipRight(Effect.fail(wrapError(error))),
);
```

**Change 4e:** Include state in `job.executed` event (around line 300-311)

```typescript
// BEFORE:
yield* emitEvent({
  ...createJobBaseEvent(
    runtime.instanceId,
    jobType as JobType,
    jobName,
    id,
  ),
  type: "job.executed" as const,
  runCount: options.runCount ?? 0,
  durationMs,
  attempt,
} satisfies InternalJobExecutedEvent);

// AFTER:
yield* emitEvent({
  ...createJobBaseEvent(
    runtime.instanceId,
    jobType as JobType,
    jobName,
    id,
  ),
  type: "job.executed" as const,
  runCount: options.runCount ?? 0,
  durationMs,
  attempt,
  ...(preExecutionState !== undefined && { preExecutionState }),
} satisfies InternalJobExecutedEvent);
```

---

## Optional: Context Consistency Fix

While not strictly necessary (current implementation works correctly), you may want to standardize the state access pattern for consistency.

**File:** `packages/jobs/src/handlers/task/context.ts`

**Change (Optional):** Simplify `TaskExecuteContext.state` (lines 159-161)

```typescript
// BEFORE:
state: stateHolder.dirty
  ? Effect.succeed(stateHolder.current)
  : getState(),

// AFTER (more consistent with other contexts):
state: Effect.sync(() => stateHolder.current),
```

Same pattern can be applied to `TaskIdleContext.state` (lines 215-217) and `TaskErrorContext.state` (lines 245-247).

**Rationale:** This makes the code more consistent with `ContinuousContext` and `TaskEventContext`. However, since `getState()` is always holder-backed in practice, this change is purely cosmetic.

---

## Verification Steps

### Step 1: Build Core Package

```bash
cd packages/core
pnpm build
```

Expected: No TypeScript errors. Schema changes compile successfully.

### Step 2: Build Jobs Package

```bash
cd packages/jobs
pnpm build
```

Expected: No TypeScript errors. The `satisfies InternalJobExecutedEvent` and `satisfies InternalJobFailedEvent` type assertions should pass since the new field is optional.

### Step 3: Run Tests

```bash
pnpm test
```

Expected: All existing tests pass. Events now include additional optional field.

### Step 4: Manual Verification

Create a simple test to verify events contain state:

```typescript
// In a test file
it("includes preExecutionState in job.executed event", async () => {
  // Setup job with initial state
  const initialState = { count: 5 };

  // Run job that modifies state
  // ...

  // Verify event
  const events = trackerHandle.getEventsByType("job.executed");
  expect(events[0].preExecutionState).toEqual(initialState);
});

it("includes preExecutionState in job.failed event", async () => {
  // Setup job with state that will cause failure
  const initialState = { value: "bad" };

  // Run job that throws
  // ...

  // Verify event
  const events = trackerHandle.getEventsByType("job.failed");
  expect(events[0].preExecutionState).toEqual(initialState);
});
```

---

## File Change Summary

| File | Changes | Lines Modified |
|------|---------|----------------|
| `packages/core/src/events.ts` | Add `preExecutionState` to 4 schemas | ~8 lines |
| `packages/jobs/src/services/execution.ts` | Add option, capture state, emit in events | ~25 lines |
| `packages/jobs/src/handlers/task/context.ts` | (Optional) Consistency fix | ~6 lines |

**Total:** ~33-39 lines of changes

---

## Backward Compatibility

### Schema Evolution
- `preExecutionState` is optional (`Schema.optional(Schema.Unknown)`)
- Old events (without this field) remain valid
- New events include additional data
- Tracking consumers can be updated independently

### API Stability
- `ExecuteOptions.includeStateInEvents` defaults to `true` for opt-out capability
- No handler code changes required (automatic inclusion)
- Existing tests continue to pass

### Wire Format
- Wire schemas mirror internal schemas
- HTTP batch tracker will serialize `preExecutionState` as JSON
- Receiving services must handle `undefined` gracefully

---

## Future Enhancements

### Post-Execution State

To also capture state AFTER execution:

```typescript
// After Step 4e, before returning ExecutionResult:
const postExecutionState = includeStateInEvents ? stateHolder.current : undefined;

yield* emitEvent({
  ...createJobBaseEvent(...),
  type: "job.executed" as const,
  runCount: options.runCount ?? 0,
  durationMs,
  attempt,
  ...(preExecutionState !== undefined && { preExecutionState }),
  ...(postExecutionState !== undefined && { postExecutionState }),
});
```

This provides before/after comparison for audit trails.

### State Diff

For large states, consider emitting a diff instead of full snapshots:

```typescript
preExecutionState: Schema.optional(Schema.Unknown),
stateDiff: Schema.optional(Schema.Unknown),  // JSON Patch format
```

### Selective State Inclusion

Add per-job-type configuration:

```typescript
// In job definition
export const myJob = Task.make({
  name: "my-job",
  trackingOptions: {
    includeStateInEvents: true,
    maxStateSize: 10000,  // Truncate if larger
  },
  // ...
});
```

---

## Implementation Checklist

- [ ] Update `InternalJobExecutedEventSchema` in `core/events.ts`
- [ ] Update `InternalJobFailedEventSchema` in `core/events.ts`
- [ ] Update `JobExecutedEventSchema` in `core/events.ts`
- [ ] Update `JobFailedEventSchema` in `core/events.ts`
- [ ] Add `includeStateInEvents` to `ExecuteOptions` in `execution.ts`
- [ ] Capture `preExecutionState` after loading state in `execution.ts`
- [ ] Include state in `job.failed` (retry) event in `execution.ts`
- [ ] Include state in `job.failed` (error) event in `execution.ts`
- [ ] Include state in `job.executed` event in `execution.ts`
- [ ] Build core package
- [ ] Build jobs package
- [ ] Run existing tests
- [ ] Add tests for new functionality
- [ ] (Optional) Apply context consistency fix
