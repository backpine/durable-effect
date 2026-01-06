# Pre-Execution State Tracking Design

## Problem Statement

The jobs package emits tracking events for `job.executed` and `job.failed`, but these events do not include the state that existed **before** the execute function ran. Since execute can mutate state, tracking systems need the pre-execution state to:

1. Understand what data the job was operating on
2. Debug failures by seeing the input state that caused them
3. Build audit trails showing state before/after execution

## Current Architecture Analysis

### State Loading Flow (execution.ts:116-127)

```typescript
const loadedState = yield* stateService.get().pipe(
  withStorage,
  Effect.mapError((e) => new ExecutionError({ ... }))
);
```

State is loaded **once** at the start of execution, then stored in a mutable holder:

```typescript
const stateHolder = {
  current: loadedState as S | null,
  dirty: false,
};
```

### Context State Access Patterns

**ContinuousContext** (continuous/context.ts:42):
```typescript
state: Effect.sync(() => stateHolder.current),
```
- Reads directly from holder (synchronous, no IO)

**TaskEventContext** (task/context.ts:104):
```typescript
state: Effect.sync(() => stateHolder.current),
```
- Same pattern - reads from holder

**TaskExecuteContext** (task/context.ts:159-161):
```typescript
state: stateHolder.dirty
  ? Effect.succeed(stateHolder.current)
  : getState(),
```
- If dirty (modified), reads from holder
- If not dirty, calls `getState()` which could hit storage

### Observation: Redundant IO Risk in TaskExecuteContext

The `getState()` fallback in TaskExecuteContext is concerning. If the user calls `yield* ctx.state` before any mutations, and `getState()` hits storage, this is redundant since state was already loaded into `stateHolder.current`.

However, examining how TaskHandler creates the context (handlers/task/handler.ts), the `getState` function passed may or may not be storage-backed depending on the flow.

### Current Event Schemas (core/events.ts)

```typescript
// job.executed - NO state field
export const InternalJobExecutedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.executed"),
  runCount: Schema.Number,
  durationMs: Schema.Number,
  attempt: Schema.Number,
});

// job.failed - NO state field
export const InternalJobFailedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.failed"),
  error: JobErrorSchema,
  runCount: Schema.Number,
  attempt: Schema.Number,
  willRetry: Schema.Boolean,
});
```

---

## Design Options

### Option A: Simple Capture (Recommended)

Capture `loadedState` right after loading and pass it through to event emission.

**Changes to execution.ts:**

```typescript
const loadedState = yield* stateService.get().pipe(...);

// Capture pre-execution state snapshot for tracking
const preExecutionState = loadedState;

// ... execution logic ...

// In job.executed emission (line 300-311):
yield* emitEvent({
  ...createJobBaseEvent(...),
  type: "job.executed" as const,
  runCount: options.runCount ?? 0,
  durationMs,
  attempt,
  preExecutionState,  // NEW
} satisfies InternalJobExecutedEvent);

// In job.failed emission (line 269-285):
return emitEvent({
  ...createJobBaseEvent(...),
  type: "job.failed" as const,
  error: { message: errorMessage, stack: errorStack },
  runCount: options.runCount ?? 0,
  attempt,
  willRetry: true,
  preExecutionState,  // NEW
} satisfies InternalJobFailedEvent);
```

**Pros:**
- Minimal code changes (< 20 lines)
- No new abstractions
- State already loaded, just capture reference
- Works with existing dirty tracking pattern

**Cons:**
- `preExecutionState` is in scope throughout execute, could be accidentally modified (but it's not exposed to user code)

---

### Option B: Effect Ref Pattern

Use `Effect.Ref` to hold pre-execution state in a more isolated way.

**New Service:**
```typescript
// services/pre-execution-state.ts
export class PreExecutionStateRef extends Context.Tag(
  "@durable-effect/jobs/PreExecutionStateRef"
)<PreExecutionStateRef, Ref.Ref<unknown>>() {}

export const makePreExecutionStateRef = (state: unknown) =>
  Layer.effect(PreExecutionStateRef, Ref.make(state));
```

**Usage in execution.ts:**
```typescript
const loadedState = yield* stateService.get().pipe(...);

// Create scoped Ref for tracking
const preStateRef = yield* Ref.make(loadedState);

// ... later when emitting events ...
const preExecutionState = yield* Ref.get(preStateRef);
```

**Pros:**
- More "Effect-idiomatic" immutable pattern
- State is explicitly managed via Ref
- Clear separation of concerns

**Cons:**
- Adds complexity for minimal benefit
- Extra service/layer to manage
- Ref is overkill for simple read-once-use-later pattern

---

### Option C: Enhanced EntityStateService

Extend `EntityStateService` to track first-read state.

```typescript
interface EntityStateServiceI<S> {
  get: () => Effect.Effect<S | null, StorageError | ValidationError>;
  set: (state: S) => Effect.Effect<void, StorageError | ValidationError>;
  update: (fn: (s: S) => S) => Effect.Effect<void, ...>;
  delete: () => Effect.Effect<boolean, StorageError>;

  // NEW: Get the state as it was when first loaded
  getInitialSnapshot: () => Effect.Effect<S | null>;
}
```

**Implementation:**
```typescript
export function createEntityStateService<A, I>(
  schema: Schema.Schema<A, I, never>
): Effect.Effect<EntityStateServiceI<A>, never, StorageAdapter> {
  return Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const initialStateRef = yield* Ref.make<A | null>(null);
    let hasLoadedInitial = false;

    return {
      get: () => Effect.gen(function* () {
        const raw = yield* storage.get<I>(KEYS.STATE);
        if (raw === undefined) return null;

        const result = yield* decode(raw).pipe(...);

        // Capture first load as initial snapshot
        if (!hasLoadedInitial) {
          yield* Ref.set(initialStateRef, result);
          hasLoadedInitial = true;
        }

        return result;
      }),

      getInitialSnapshot: () => Ref.get(initialStateRef),
      // ... rest unchanged
    };
  });
}
```

**Pros:**
- Automatic capture on first read
- Service encapsulates the pattern
- Reusable across handlers

**Cons:**
- Changes service interface
- `hasLoadedInitial` mutable flag is somewhat awkward
- Over-engineered for this specific use case

---

### Option D: Tracking-Aware State Manager (User's Suggestion)

Create a state management layer that is tracking-aware.

**Concept:**
- If tracking is enabled, pre-load state and manage it in memory
- User's `yield* ctx.state` reads from managed state (no IO)
- `setState`/`updateState` update both in-memory and storage
- Pre-execution state is always available for events

**Analysis:**

Looking at the current implementation, this is **already happening** for most contexts:

1. `execution.ts` loads state once: `loadedState = yield* stateService.get()`
2. State is stored in `stateHolder.current = loadedState`
3. `ctx.state` for ContinuousContext and TaskEventContext reads from `stateHolder.current` via `Effect.sync()` - **no IO**
4. Mutations update `stateHolder`, mark dirty
5. After execution, dirty state is saved to storage

The only place this breaks down is `TaskExecuteContext.state` which has:
```typescript
state: stateHolder.dirty ? Effect.succeed(stateHolder.current) : getState()
```

This could hit storage if `!dirty` and `getState` is storage-backed. But examining the handler code, by the time we're in execute context, state should already be loaded.

**Recommendation:** The current pattern is mostly correct. The fix is:

1. Ensure `TaskExecuteContext.state` always reads from holder (not storage fallback)
2. Capture `loadedState` for tracking events

---

## Recommended Implementation: Option A with Context Fix

### Step 1: Fix TaskExecuteContext to Avoid Redundant IO

In `handlers/task/context.ts`, change:

```typescript
// BEFORE
state: stateHolder.dirty
  ? Effect.succeed(stateHolder.current)
  : getState(),

// AFTER - always read from holder since state is pre-loaded
state: Effect.sync(() => stateHolder.current),
```

This matches the pattern used in ContinuousContext and TaskEventContext.

**Why this is safe:** The handler always loads state before creating the context, so `stateHolder.current` is already populated.

### Step 2: Update Event Schemas (core/events.ts)

```typescript
export const InternalJobExecutedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.executed"),
  runCount: Schema.Number,
  durationMs: Schema.Number,
  attempt: Schema.Number,
  // NEW: Pre-execution state for tracking
  preExecutionState: Schema.optional(Schema.Unknown),
});

export const InternalJobFailedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.failed"),
  error: JobErrorSchema,
  runCount: Schema.Number,
  attempt: Schema.Number,
  willRetry: Schema.Boolean,
  // NEW: Pre-execution state for tracking
  preExecutionState: Schema.optional(Schema.Unknown),
});
```

Using `Schema.Unknown` because:
- The tracking service is schema-agnostic
- State will be serialized to JSON for transport
- Mirrors the pattern used for `input` in `job.started`

### Step 3: Update ExecuteOptions Interface (execution.ts)

Add a flag to control whether state should be included in events:

```typescript
export interface ExecuteOptions<S, E, R, Ctx> {
  readonly jobType: "continuous" | "debounce" | "task" | "workerPool";
  readonly jobName: string;
  readonly schema: Schema.Schema<S, any, never>;
  readonly retryConfig?: JobRetryConfig;
  readonly runCount?: number;
  readonly allowNullState?: boolean;
  readonly id?: string;

  // NEW: Include pre-execution state in tracking events
  readonly includeStateInEvents?: boolean;

  readonly run: (ctx: Ctx) => Effect.Effect<void, E, R>;
  readonly createContext: (base: ExecutionContextBase<S>) => Ctx;
}
```

### Step 4: Capture and Include State in Events (execution.ts)

```typescript
export const JobExecutionServiceLayer = Layer.effect(
  JobExecutionService,
  Effect.gen(function* () {
    // ... existing setup ...

    return {
      execute: <S, E, R, Ctx>(options: ExecuteOptions<S, E, R, Ctx>) =>
        withLogSpan(
          Effect.gen(function* () {
            const {
              jobType,
              jobName,
              schema,
              retryConfig,
              run,
              createContext,
              id,
              includeStateInEvents = true,  // Default to true
            } = options;

            const startTime = Date.now();
            const stateService = yield* withStorage(createEntityStateService(schema));
            const loadedState = yield* stateService.get().pipe(...);

            // Capture pre-execution state snapshot for tracking
            // This is safe to capture here since execute hasn't run yet
            const preExecutionState = includeStateInEvents ? loadedState : undefined;

            // ... rest of execution logic ...

            // In job.executed emission:
            yield* emitEvent({
              ...createJobBaseEvent(runtime.instanceId, jobType, jobName, id),
              type: "job.executed" as const,
              runCount: options.runCount ?? 0,
              durationMs,
              attempt,
              ...(preExecutionState !== undefined && { preExecutionState }),
            } satisfies InternalJobExecutedEvent);

            // In job.failed emissions (both retry and non-retry paths):
            return emitEvent({
              ...createJobBaseEvent(...),
              type: "job.failed" as const,
              error: { message, stack },
              runCount: options.runCount ?? 0,
              attempt,
              willRetry: true,  // or false
              ...(preExecutionState !== undefined && { preExecutionState }),
            } satisfies InternalJobFailedEvent);
          }),
          "execution",
        ),
    };
  }),
);
```

---

## IO Flow Analysis

### Before This Change

```
1. stateService.get() → Storage IO (load state)
2. stateHolder.current = loadedState
3. ctx.state (if TaskExecuteContext & !dirty) → Storage IO (redundant!)
4. User modifies state → stateHolder update
5. stateService.set() → Storage IO (save state)
6. emitEvent() → No state data in event
```

### After This Change

```
1. stateService.get() → Storage IO (load state)
2. stateHolder.current = loadedState
3. preExecutionState = loadedState (in-memory capture)
4. ctx.state → Effect.sync() → No IO (reads from holder)
5. User modifies state → stateHolder update
6. stateService.set() → Storage IO (save state)
7. emitEvent() → Includes preExecutionState from capture
```

**IO Reduction:** Eliminates potential redundant read in TaskExecuteContext when user calls `yield* ctx.state` before any modifications.

---

## Type Safety Considerations

### Why `Schema.Unknown` for preExecutionState?

1. **Schema Agnosticism**: The tracking service doesn't know the state schema. It receives events from many job types with different state shapes.

2. **JSON Serialization**: Events are serialized to JSON for HTTP transport. TypeScript types are erased at runtime. The actual serialization handles the conversion.

3. **Consistency**: Matches the pattern for `input` in `job.started` event which also uses `Schema.Unknown`.

4. **Optional Field**: Using `Schema.optional(Schema.Unknown)` means:
   - Events can omit state if `includeStateInEvents: false`
   - Old events (before this change) remain valid
   - Backward compatible schema evolution

### State Serialization Safety

The `loadedState` has already been decoded from storage using the schema's decode function. It's a valid instance of type `S`. When included in the event:

1. Event is created with `preExecutionState: loadedState`
2. Event tracker calls `emit(event)`
3. HTTP batch tracker serializes event to JSON via `JSON.stringify()`
4. State is serialized as part of the event payload

Since state was originally stored as JSON (via schema encode), it will round-trip correctly.

---

## Debounce Handler Consideration

The debounce handler has a unique flow where state accumulates events before flushing. The relevant events are:

- `debounce.started`: When first event received
- `debounce.flushed`: After flush execution

For debounce, we might want to include:
- **debounce.flushed**: The accumulated state before flush
- **job.failed**: The state that was being processed when failure occurred

The same pattern applies - capture state before flush execution.

---

## Migration Path

### Phase 1: Non-Breaking Addition
1. Add `preExecutionState` as optional field to event schemas
2. Update execution.ts to capture and include state
3. Existing consumers continue working (field is optional)

### Phase 2: Handler Updates
1. Update TaskExecuteContext to always read from holder
2. Verify debounce handler state capture
3. Add `includeStateInEvents` option for opt-out scenarios

### Phase 3: Wire Schema Update
1. Update wire event schemas in parallel with internal schemas
2. Tracking endpoints can start consuming state data
3. UI/analytics can display state information

---

## Alternative: Post-Execution State

Some use cases might also want the state **after** execution. This would be:

```typescript
export const InternalJobExecutedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.executed"),
  runCount: Schema.Number,
  durationMs: Schema.Number,
  attempt: Schema.Number,
  preExecutionState: Schema.optional(Schema.Unknown),
  postExecutionState: Schema.optional(Schema.Unknown),  // Also useful
});
```

To capture post-execution state:
```typescript
// After successful execution, before emitting event:
const postExecutionState = includeStateInEvents ? stateHolder.current : undefined;

yield* emitEvent({
  ...createJobBaseEvent(...),
  type: "job.executed" as const,
  runCount,
  durationMs,
  attempt,
  ...(preExecutionState !== undefined && { preExecutionState }),
  ...(postExecutionState !== undefined && { postExecutionState }),
});
```

This provides a complete before/after picture for audit and debugging.

---

## Summary

**Recommended approach:** Option A (Simple Capture) with the TaskExecuteContext fix.

**Changes required:**
1. `core/events.ts`: Add `preExecutionState: Schema.optional(Schema.Unknown)` to `job.executed` and `job.failed` schemas
2. `jobs/services/execution.ts`: Capture `loadedState` as `preExecutionState`, include in events
3. `jobs/handlers/task/context.ts`: Simplify `TaskExecuteContext.state` to always read from holder

**IO impact:** Reduces potential redundant storage reads, state captured in memory.

**Backward compatibility:** Fully backward compatible - new field is optional.
