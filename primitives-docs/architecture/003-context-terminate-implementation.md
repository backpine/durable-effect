# Context Terminate Implementation Plan

## Overview

Add the ability to terminate a continuous primitive from within the `execute` function via `ctx.terminate()`. This allows the primitive to self-terminate when conditions are met (e.g., too many failures, token revoked, campaign complete).

## Current State

### ContinuousContext (registry/types.ts)
```ts
interface ContinuousContext<S> {
  readonly state: S;
  readonly setState: (state: S) => void;
  readonly updateState: (fn: (current: S) => S) => void;
  readonly instanceId: string;
  readonly runCount: number;
  readonly primitiveName: string;
}
```

### Context Implementation (handlers/continuous/context.ts)
- Creates a `StateHolder` for mutable state during execution
- Context provides synchronous state access and mutation
- After execution, dirty state is persisted

### Handler Flow (handlers/continuous/handler.ts)
1. Get definition from registry
2. Load current state
3. Create StateHolder and context
4. Execute user function
5. If state is dirty, persist it
6. Schedule next alarm

---

## Proposed Design

### API

```ts
interface ContinuousContext<S> {
  // ... existing fields ...

  /**
   * Terminate this primitive instance.
   *
   * Returns Effect<never> - short-circuits execution.
   */
  readonly terminate: (options?: {
    readonly reason?: string;
    readonly purgeState?: boolean; // default: true
  }) => Effect.Effect<never, never, never>;
}
```

### Implementation Options

#### Option A: Interrupt-based (Recommended)

Use Effect's fiber interruption to cleanly exit the execute function.

**Pros:**
- Clean short-circuit - no code after `yield* ctx.terminate()` runs
- Follows Effect patterns
- Can catch in handler to perform cleanup

**Cons:**
- Need to distinguish terminate interrupt from other errors
- Slightly more complex handler logic

**Implementation:**

```ts
// New error type for termination signal
class TerminateSignal {
  readonly _tag = "TerminateSignal";
  constructor(
    readonly reason?: string,
    readonly purgeState: boolean = true
  ) {}
}

// Context factory adds terminate method
function createContinuousContext<S>(
  stateHolder: StateHolder<S>,
  instanceId: string,
  runCount: number,
  primitiveName: string
): ContinuousContext<S> {
  return {
    // ... existing ...

    terminate: (options) =>
      Effect.fail(new TerminateSignal(
        options?.reason,
        options?.purgeState ?? true
      ))
  };
}

// Handler catches TerminateSignal
const executeUserFunction = (def, stateService, runCount) =>
  Effect.gen(function* () {
    // ... setup ...

    yield* Effect.try({
      try: () => def.execute(ctx),
      catch: (e) => new ExecutionError({ ... })
    }).pipe(
      Effect.flatten,
      Effect.catchAll((error) => {
        // Check if this is a terminate signal
        if (error instanceof TerminateSignal) {
          return Effect.fail(error); // Re-throw to handler
        }
        // ... normal error handling ...
      })
    );

    // ... persist state ...
  });
```

#### Option B: Flag-based

Set a flag on the StateHolder that handler checks after execution.

**Pros:**
- Simple implementation
- No special error handling

**Cons:**
- Code after `ctx.terminate()` still runs
- User must remember to `return` after terminate

**Implementation:**

```ts
interface StateHolder<S> {
  current: S;
  dirty: boolean;
  terminated: boolean;
  terminateReason?: string;
  purgeState: boolean;
}

// Context sets flag
terminate: (options) => {
  stateHolder.terminated = true;
  stateHolder.terminateReason = options?.reason;
  stateHolder.purgeState = options?.purgeState ?? true;
  return Effect.void;
}

// Handler checks flag after execution
if (stateHolder.terminated) {
  yield* performTermination(stateHolder);
}
```

---

## Recommended Approach: Option A (Interrupt-based)

### Step 1: Add TerminateSignal Error

**File:** `packages/jobs/src/errors.ts`

```ts
/**
 * Signal that the primitive should terminate.
 * Not a true error - used to short-circuit execution.
 */
export class TerminateSignal {
  readonly _tag = "TerminateSignal";

  constructor(
    readonly reason: string | undefined,
    readonly purgeState: boolean
  ) {}
}
```

### Step 2: Update ContinuousContext Type

**File:** `packages/jobs/src/registry/types.ts`

```ts
import type { Effect } from "effect";

interface ContinuousContext<S> {
  readonly state: S;
  readonly setState: (state: S) => void;
  readonly updateState: (fn: (current: S) => S) => void;
  readonly instanceId: string;
  readonly runCount: number;
  readonly primitiveName: string;

  /**
   * Terminate this primitive instance.
   *
   * @param options.reason - Optional reason for termination
   * @param options.purgeState - Whether to delete all state (default: true)
   * @returns Effect<never> - short-circuits execution
   */
  readonly terminate: (options?: {
    readonly reason?: string;
    readonly purgeState?: boolean;
  }) => Effect.Effect<never, never, never>;
}
```

### Step 3: Update Context Factory

**File:** `packages/jobs/src/handlers/continuous/context.ts`

```ts
import { Effect } from "effect";
import { TerminateSignal } from "../../errors";
import type { ContinuousContext } from "../../registry/types";

export interface StateHolder<S> {
  current: S;
  dirty: boolean;
}

export function createContinuousContext<S>(
  stateHolder: StateHolder<S>,
  instanceId: string,
  runCount: number,
  primitiveName: string
): ContinuousContext<S> {
  return {
    get state() {
      return stateHolder.current;
    },

    setState: (newState: S) => {
      stateHolder.current = newState;
      stateHolder.dirty = true;
    },

    updateState: (fn: (current: S) => S) => {
      stateHolder.current = fn(stateHolder.current);
      stateHolder.dirty = true;
    },

    instanceId,
    runCount,
    primitiveName,

    terminate: (options) =>
      Effect.fail(
        new TerminateSignal(
          options?.reason,
          options?.purgeState ?? true
        )
      ) as Effect.Effect<never, never, never>,
  };
}
```

### Step 4: Handle TerminateSignal in Handler

**File:** `packages/jobs/src/handlers/continuous/handler.ts`

```ts
import { TerminateSignal } from "../../errors";

// Add helper for termination
const performTermination = (
  signal: TerminateSignal
): Effect.Effect<void, StorageError | SchedulerError> =>
  Effect.gen(function* () {
    // 1. Cancel scheduled alarm
    yield* alarm.cancel();

    // 2. Update metadata status
    const newStatus = signal.purgeState ? "terminated" : "stopped";
    yield* metadata.updateStatus(newStatus);
    yield* metadata.setStopReason(signal.reason);

    // 3. Optionally purge state
    if (signal.purgeState) {
      yield* storage.delete(KEYS.CONTINUOUS.STATE);
      yield* storage.delete(KEYS.CONTINUOUS.RUN_COUNT);
      yield* storage.delete(KEYS.CONTINUOUS.LAST_EXECUTED_AT);
    }
  });

// Update executeUserFunction
const executeUserFunction = <S>(
  def: ContinuousDefinition<S, unknown, never>,
  stateService: EntityStateServiceI<S>,
  runCount: number
): Effect.Effect<void, PrimitiveError | TerminateSignal> =>
  Effect.gen(function* () {
    const currentState = yield* stateService.get().pipe(
      Effect.mapError((e) => new ExecutionError({ ... }))
    );

    if (currentState === null) {
      return;
    }

    const stateHolder: StateHolder<S> = {
      current: currentState,
      dirty: false,
    };

    const ctx = createContinuousContext(
      stateHolder,
      runtime.instanceId,
      runCount,
      def.name
    );

    // Execute - TerminateSignal will propagate up
    yield* Effect.try({
      try: () => def.execute(ctx),
      catch: (e) => new ExecutionError({ ... }),
    }).pipe(
      Effect.flatten,
      Effect.catchAll((error) => {
        // Let TerminateSignal propagate
        if (error instanceof TerminateSignal) {
          return Effect.fail(error);
        }
        // ... normal error handling ...
      })
    );

    // Persist state if modified (only reached if no terminate)
    if (stateHolder.dirty) {
      yield* stateService.set(stateHolder.current).pipe(
        Effect.mapError((e) => new ExecutionError({ ... }))
      );
    }
  });

// Update main handler
return {
  handle: (request: ContinuousRequest) =>
    Effect.gen(function* () {
      const def = yield* getDefinition(request.name);

      switch (request.action) {
        case "start":
          return yield* handleStart(def, request).pipe(
            Effect.catchTag("TerminateSignal", (signal) =>
              Effect.gen(function* () {
                yield* performTermination(signal);
                return {
                  _type: "continuous.start" as const,
                  instanceId: runtime.instanceId,
                  created: true,
                  status: signal.purgeState ? "terminated" : "stopped",
                };
              })
            )
          );
        // ... other actions ...
      }
    }),

  handleAlarm: () =>
    Effect.gen(function* () {
      const meta = yield* metadata.get();
      if (!meta || meta.status === "stopped" || meta.status === "terminated") {
        return;
      }

      const def = yield* getDefinition(meta.name);
      const stateService = yield* withStorage(createEntityStateService(def.stateSchema));
      const runCount = yield* incrementRunCount();

      yield* executeUserFunction(def, stateService, runCount).pipe(
        Effect.catchTag("TerminateSignal", (signal) =>
          performTermination(signal)
        )
      );

      // Only schedule next if not terminated
      const currentMeta = yield* metadata.get();
      if (currentMeta && currentMeta.status === "running") {
        yield* updateLastExecutedAt();
        yield* scheduleNext(def);
      }
    }),
};
```

### Step 5: Add "terminated" Status

**File:** `packages/jobs/src/services/metadata.ts`

```ts
export type PrimitiveStatus =
  | "running"
  | "stopped"
  | "terminated"  // NEW: indicates state was purged
  | "error";

export interface PrimitiveMetadata {
  // ... existing fields ...
  readonly stopReason?: string;  // NEW
}
```

### Step 6: Update Metadata Service

Add `setStopReason` method:

```ts
interface MetadataServiceI {
  // ... existing ...
  readonly setStopReason: (reason?: string) => Effect.Effect<void, StorageError>;
}
```

---

## Storage Keys to Purge

When `purgeState: true`, delete these keys:

```ts
// packages/jobs/src/storage-keys.ts
export const KEYS = {
  CONTINUOUS: {
    STATE: "continuous:state",
    RUN_COUNT: "continuous:runCount",
    LAST_EXECUTED_AT: "continuous:lastExecutedAt",
  },
  METADATA: "primitive:metadata",  // Keep this - just update status
};
```

---

## Response Type Updates

Update response types to include new status:

```ts
// packages/jobs/src/runtime/types.ts
export interface ContinuousStatusResponse {
  readonly _type: "continuous.status";
  readonly status: "running" | "stopped" | "terminated" | "not_found";
  readonly nextRunAt?: number;
  readonly runCount?: number;
  readonly stopReason?: string;  // NEW
}
```

---

## Testing Plan

### Unit Tests

1. **Terminate with purge (default)**
   - Execute calls `ctx.terminate()`
   - Verify alarm cancelled
   - Verify state deleted
   - Verify status is "terminated"

2. **Terminate without purge**
   - Execute calls `ctx.terminate({ purgeState: false })`
   - Verify alarm cancelled
   - Verify state preserved
   - Verify status is "stopped"

3. **Terminate with reason**
   - Execute calls `ctx.terminate({ reason: "Token expired" })`
   - Verify reason stored in metadata
   - Verify reason returned in status response

4. **Code after terminate doesn't run**
   - Execute has code after terminate call
   - Verify that code is not executed

5. **Terminate in onError handler**
   - onError calls `ctx.terminate()`
   - Verify proper termination

### Integration Tests

1. **Token refresher scenario**
   - Start primitive
   - On third execution, terminate (simulating revoked token)
   - Verify no more alarms fire
   - Verify state is purged

---

## Migration / Backwards Compatibility

- Existing jobs without `ctx.terminate()` calls continue to work
- New `terminate` method is available on all ContinuousContext instances
- No breaking changes to existing API

---

## Implementation Checklist

- [x] Add `TerminateSignal` to `errors.ts`
- [x] Add `"terminated"` to `PrimitiveStatus` type
- [x] Add `stopReason` to `PrimitiveMetadata`
- [x] Update `MetadataService` with `setStopReason` method
- [x] Update `ContinuousContext` type with `terminate` method
- [x] Update `createContinuousContext` to provide `terminate`
- [x] Update `executeUserFunction` to handle `TerminateSignal`
- [x] Add `performTermination` helper
- [x] Update `handleAlarm` to catch `TerminateSignal`
- [x] Update `ContinuousStatusResponse` with `stopReason`
- [x] Add unit tests
- [ ] Add integration test (optional - unit tests cover the behavior)
- [x] Update API documentation examples

---

## Future Enhancements

### ctx.reschedule()

Override the next execution time:

```ts
readonly reschedule: (
  when: Duration.DurationInput | number
) => Effect.Effect<void, never, never>;
```

This would update the alarm without terminating.

### ctx.pause() / ctx.resume()

Temporarily pause execution without terminating:

```ts
readonly pause: () => Effect.Effect<void, never, never>;
```

Sets status to "paused", cancels alarm. Client can call `resume()` to restart.
