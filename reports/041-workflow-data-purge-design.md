# Report 041: Workflow Data Purge Design

## Overview

Design for automatically purging workflow data after completion or failure to prevent storage bloat in Durable Objects.

## Problem Statement

When workflows complete or fail:
- Step results, attempt counters, workflow state remain in storage
- Over time, this bloats DO storage
- No automatic cleanup mechanism exists
- Current `cleanup()` in orchestrator only cancels alarms, explicitly notes: "We don't delete storage - keep for history/queries"

## Requirements

1. **Configurable purge delay** - User specifies delay before purging (default: 60 seconds)
2. **Trigger on terminal states** - Purge after Completed, Failed, or Cancelled
3. **General adapter pattern** - Works with any storage adapter, not just Cloudflare DOs
4. **Query window** - Delay allows external systems to query final state before purge
5. **Clean integration** - Fits existing layer/service architecture
6. **Logging** - Log when purge is executed for observability

---

## API Design

### Configuration

```typescript
// engine/types.ts
export interface PurgeConfig {
  /**
   * Delay before purging data after terminal state.
   * Allows time for external systems to query final results.
   *
   * Accepts duration string (e.g., "60 seconds", "5 minutes") or number in ms.
   * Default: "60 seconds"
   */
  readonly delay?: string | number;
}

export interface CreateDurableWorkflowsOptions {
  readonly tracker?: HttpBatchTrackerConfig;
  readonly recovery?: Partial<RecoveryConfig>;

  /**
   * Automatic data purging configuration.
   * When provided, workflow data is deleted after terminal states (completed, failed, cancelled).
   * Omit to retain data indefinitely.
   */
  readonly purge?: PurgeConfig;
}
```

### Usage

```typescript
const { Workflows, WorkflowClient } = createDurableWorkflows(myWorkflows, {
  tracker: { endpoint: "..." },

  // Enable purge - data deleted 60 seconds after completion/failure/cancel
  purge: {
    delay: "60 seconds",  // or 60000 (ms), or "5 minutes", etc.
  },
});

// Or with default delay (60 seconds)
const { Workflows } = createDurableWorkflows(myWorkflows, {
  purge: {},  // enabled with default 60 second delay
});

// Purge disabled (default - omit purge entirely)
const { Workflows } = createDurableWorkflows(myWorkflows, {
  // no purge config = data retained indefinitely
});
```

---

## Architecture

### Data Flow (Top to Bottom)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        createDurableWorkflows()                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ options.purge → PurgeConfig                                           │  │
│  │   { delay: "60 seconds" }                                             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         PurgeManagerLayer                             │  │
│  │  - Receives PurgeConfig (or disabled if purge not provided)           │  │
│  │  - Provides PurgeManager service to orchestrator                      │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          WorkflowOrchestrator                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ On terminal state (Completed/Failed/Cancelled):                       │  │
│  │   1. Emit workflow.completed/failed/cancelled event                   │  │
│  │   2. Call purgeManager.schedulePurge(terminalState)                   │  │
│  │      - No-op if purge disabled                                        │  │
│  │      - Calculates purgeAt = now + delay                               │  │
│  │      - Stores purge metadata: { purgeAt, reason }                     │  │
│  │      - Schedules alarm via SchedulerAdapter                           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DurableWorkflowEngine                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ alarm() handler:                                                      │  │
│  │   1. Check for purge metadata in storage                              │  │
│  │   2. If purge is due:                                                 │  │
│  │      - Log: "[Workflow] Purging data for {workflowId} ({reason})"     │  │
│  │      - Call storage.deleteAll()                                       │  │
│  │   3. Else: delegate to orchestrator.handleAlarm() (resume/recovery)   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           StorageAdapter                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ deleteAll():                                                          │  │
│  │   - Cloudflare DO: ctx.storage.deleteAll()                            │  │
│  │   - In-memory: map.clear()                                            │  │
│  │   - Future adapters: implementation-specific bulk delete              │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Alarm Multiplexing

Since DOs have a single alarm, we need to distinguish between:
1. **Workflow alarms** - Resume from pause, retry, recovery
2. **Purge alarms** - Delete all data

**Solution:** Store alarm type in metadata:

```typescript
// Storage keys
"workflow:alarm:type" → "workflow" | "purge"
"workflow:purge:purgeAt" → number
"workflow:purge:reason" → "completed" | "failed" | "cancelled"
```

---

## Service Design

### PurgeManager Service

```typescript
// src/purge/manager.ts

export interface PurgeManagerService {
  /**
   * Schedule a purge after terminal state.
   * No-op if purge not enabled.
   */
  readonly schedulePurge: (
    terminalState: "completed" | "failed" | "cancelled"
  ) => Effect.Effect<void, StorageError | SchedulerError>;

  /**
   * Execute pending purge if due.
   * Returns { purged: true, reason } if purge was executed, { purged: false } otherwise.
   */
  readonly executePurgeIfDue: () => Effect.Effect<
    { purged: true; reason: string } | { purged: false },
    StorageError
  >;

  /**
   * Check if a purge is scheduled.
   */
  readonly isPurgeScheduled: () => Effect.Effect<boolean, StorageError>;

  /**
   * Cancel scheduled purge (e.g., if workflow is restarted).
   */
  readonly cancelPurge: () => Effect.Effect<void, StorageError>;
}

export class PurgeManager extends Context.Tag("@durable-effect/PurgeManager")<
  PurgeManager,
  PurgeManagerService
>() {}
```

### Internal Config (Parsed)

```typescript
// src/purge/config.ts

export interface ParsedPurgeConfig {
  readonly enabled: boolean;
  readonly delayMs: number;
}

export const defaultPurgeDelayMs = 60_000; // 60 seconds
```

### Storage Keys

```typescript
const PURGE_KEYS = {
  scheduled: "workflow:purge:scheduled",      // boolean
  purgeAt: "workflow:purge:purgeAt",          // number (timestamp)
  reason: "workflow:purge:reason",            // "completed" | "failed" | "cancelled"
  alarmType: "workflow:alarm:type",           // "workflow" | "purge"
} as const;
```

---

## Implementation Plan

### Phase 1: Core Infrastructure

#### 1.1 Create PurgeConfig types

**File:** `src/purge/config.ts`

```typescript
import { parseDuration } from "../primitives/backoff";

/**
 * Internal parsed purge configuration.
 */
export interface ParsedPurgeConfig {
  readonly enabled: boolean;
  readonly delayMs: number;
}

export const defaultPurgeDelayMs = 60_000; // 60 seconds

/**
 * Parse user-provided purge config into internal format.
 */
export function parsePurgeConfig(
  options?: { delay?: string | number }
): ParsedPurgeConfig {
  // If options is undefined, purge is disabled
  if (options === undefined) {
    return { enabled: false, delayMs: defaultPurgeDelayMs };
  }

  // If options provided (even empty object), purge is enabled
  return {
    enabled: true,
    delayMs: options.delay !== undefined
      ? parseDuration(options.delay)
      : defaultPurgeDelayMs,
  };
}
```

#### 1.2 Create PurgeManager service

**File:** `src/purge/manager.ts`

```typescript
import { Context, Effect, Layer } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { SchedulerAdapter } from "../adapters/scheduler";
import { RuntimeAdapter } from "../adapters/runtime";
import type { StorageError, SchedulerError } from "../errors";
import type { ParsedPurgeConfig } from "./config";

const PURGE_KEYS = {
  scheduled: "workflow:purge:scheduled",
  purgeAt: "workflow:purge:purgeAt",
  reason: "workflow:purge:reason",
  alarmType: "workflow:alarm:type",
} as const;

export interface PurgeManagerService {
  readonly schedulePurge: (
    terminalState: "completed" | "failed" | "cancelled"
  ) => Effect.Effect<void, StorageError | SchedulerError>;

  readonly executePurgeIfDue: () => Effect.Effect<
    { purged: true; reason: string } | { purged: false },
    StorageError
  >;

  readonly isPurgeScheduled: () => Effect.Effect<boolean, StorageError>;

  readonly cancelPurge: () => Effect.Effect<void, StorageError>;
}

export class PurgeManager extends Context.Tag("@durable-effect/PurgeManager")<
  PurgeManager,
  PurgeManagerService
>() {}

export const createPurgeManager = (config: ParsedPurgeConfig) =>
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const scheduler = yield* SchedulerAdapter;
    const runtime = yield* RuntimeAdapter;

    const service: PurgeManagerService = {
      schedulePurge: (terminalState) =>
        Effect.gen(function* () {
          // No-op if purge disabled
          if (!config.enabled) {
            return;
          }

          const now = yield* runtime.now();
          const purgeAt = now + config.delayMs;

          // Store purge metadata
          yield* storage.putBatch({
            [PURGE_KEYS.scheduled]: true,
            [PURGE_KEYS.purgeAt]: purgeAt,
            [PURGE_KEYS.reason]: terminalState,
            [PURGE_KEYS.alarmType]: "purge",
          });

          // Schedule alarm
          yield* scheduler.schedule(purgeAt);
        }),

      executePurgeIfDue: () =>
        Effect.gen(function* () {
          const scheduled = yield* storage.get<boolean>(PURGE_KEYS.scheduled);
          if (!scheduled) {
            return { purged: false as const };
          }

          const purgeAt = yield* storage.get<number>(PURGE_KEYS.purgeAt);
          const reason = yield* storage.get<string>(PURGE_KEYS.reason);
          const now = yield* runtime.now();

          if (purgeAt && now >= purgeAt) {
            // Execute purge - deleteAll removes everything including purge metadata
            yield* storage.deleteAll();
            return { purged: true as const, reason: reason ?? "unknown" };
          }

          return { purged: false as const };
        }),

      isPurgeScheduled: () =>
        storage.get<boolean>(PURGE_KEYS.scheduled).pipe(
          Effect.map((v) => v ?? false)
        ),

      cancelPurge: () =>
        Effect.gen(function* () {
          yield* storage.delete(PURGE_KEYS.scheduled);
          yield* storage.delete(PURGE_KEYS.purgeAt);
          yield* storage.delete(PURGE_KEYS.reason);
          yield* storage.delete(PURGE_KEYS.alarmType);
        }),
    };

    return service;
  });

export const PurgeManagerLayer = (config: ParsedPurgeConfig) =>
  Layer.effect(PurgeManager, createPurgeManager(config));

// Disabled purge manager (no-op) - used when purge config not provided
export const DisabledPurgeManagerLayer = Layer.succeed(PurgeManager, {
  schedulePurge: () => Effect.void,
  executePurgeIfDue: () => Effect.succeed({ purged: false as const }),
  isPurgeScheduled: () => Effect.succeed(false),
  cancelPurge: () => Effect.void,
});
```

### Phase 2: Orchestrator Integration

#### 2.1 Update orchestrator cleanup

**File:** `src/orchestrator/orchestrator.ts`

```typescript
// Add PurgeManager to dependencies
const purgeManager = yield* PurgeManager;

// Update cleanup helper to accept terminal state
const cleanup = (terminalState: "completed" | "failed" | "cancelled") =>
  Effect.gen(function* () {
    // Clear scheduled workflow alarm
    yield* scheduler.cancel();

    // Schedule purge (no-op if disabled)
    yield* purgeManager.schedulePurge(terminalState);
  });

// Update terminal state handlers
if (result._tag === "Completed") {
  yield* emitEvent({ ... });
  yield* cleanup("completed");
} else if (result._tag === "Failed") {
  yield* emitEvent({ ... });
  yield* cleanup("failed");
} else if (result._tag === "Cancelled") {
  yield* emitEvent({ ... });
  yield* cleanup("cancelled");
}
```

### Phase 3: Engine Alarm Handler

#### 3.1 Update engine alarm dispatch

**File:** `src/engine/engine.ts`

```typescript
async alarm(): Promise<void> {
  await this.#runEffect(
    Effect.gen(function* () {
      const purgeManager = yield* PurgeManager;
      const runtime = yield* RuntimeAdapter;

      // Check if this is a purge alarm
      const result = yield* purgeManager.executePurgeIfDue();
      if (result.purged) {
        // Log the purge
        console.log(
          `[Workflow] Purged data for ${runtime.instanceId} (${result.reason})`
        );
        // Note: All storage is deleted, nothing more to do
        return;
      }

      // Not a purge alarm - handle as workflow alarm (resume/recovery)
      const orchestrator = yield* WorkflowOrchestrator;
      yield* orchestrator.handleAlarm();
      yield* flushEvents;
    }),
  );
}
```

### Phase 4: Layer Composition

#### 4.1 Update engine layer composition

**File:** `src/engine/engine.ts`

```typescript
import { parsePurgeConfig, PurgeManagerLayer, DisabledPurgeManagerLayer } from "../purge";

// In constructor:
constructor(state: DurableObjectState, env: unknown) {
  super(state, env as never);

  this.#runtimeLayer = createDurableObjectRuntime(state);

  const trackerLayer = options?.tracker
    ? HttpBatchTrackerLayer(options.tracker)
    : NoopTrackerLayer;

  // Parse purge config - enabled if options.purge is provided
  const purgeConfig = parsePurgeConfig(options?.purge);
  const purgeLayer = purgeConfig.enabled
    ? PurgeManagerLayer(purgeConfig)
    : DisabledPurgeManagerLayer;

  this.#orchestratorLayer = WorkflowOrchestratorLayer<W>().pipe(
    Layer.provideMerge(WorkflowRegistryLayer(workflows)),
    Layer.provideMerge(WorkflowExecutorLayer),
    Layer.provideMerge(RecoveryManagerLayer(options?.recovery)),
    Layer.provideMerge(WorkflowStateMachineLayer),
    Layer.provideMerge(purgeLayer),  // <-- Add purge layer
    Layer.provideMerge(trackerLayer),
    Layer.provideMerge(this.#runtimeLayer),
  );
}
```

---

## File Structure

```
src/
├── purge/
│   ├── index.ts           # Re-exports
│   ├── config.ts          # PurgeConfig types and factory
│   └── manager.ts         # PurgeManager service
├── engine/
│   ├── engine.ts          # Updated alarm handler
│   └── types.ts           # Updated CreateDurableWorkflowsOptions
├── orchestrator/
│   └── orchestrator.ts    # Updated cleanup helper
└── index.ts               # Export purge types
```

---

## Testing Strategy

### Unit Tests

```typescript
// test/purge/manager.test.ts
describe("PurgeManager", () => {
  it("should schedule purge on terminal state", async () => {
    // Setup with enabled purge
    // Call schedulePurge("completed")
    // Verify storage has purge metadata
    // Verify alarm scheduled
  });

  it("should not schedule purge when disabled", async () => {
    // Setup with disabled purge
    // Call schedulePurge("completed")
    // Verify no storage writes
  });

  it("should execute purge when due", async () => {
    // Setup with purge scheduled in past
    // Call executePurgeIfDue()
    // Verify storage.deleteAll() called
  });

  it("should not execute purge when not due", async () => {
    // Setup with purge scheduled in future
    // Call executePurgeIfDue()
    // Verify returns false
  });
});
```

### Integration Tests

```typescript
// test/engine/purge.test.ts
describe("Workflow purge integration", () => {
  it("should purge data after workflow completes", async () => {
    // Create engine with purge enabled (delay: 0)
    // Run workflow to completion
    // Trigger alarm
    // Verify storage is empty
  });

  it("should allow querying status during purge delay", async () => {
    // Create engine with purge enabled (delay: 5000)
    // Run workflow to completion
    // Query status immediately - should work
    // Advance time past delay
    // Trigger alarm
    // Query status - should return undefined
  });
});
```

---

## Edge Cases

### 1. Workflow Restarted Before Purge

If a workflow completes, schedules purge, but then is restarted:
- Current design: New workflow would fail because storage has stale data
- Solution: Check and cancel purge on workflow start

```typescript
// In orchestrator.start()
yield* purgeManager.cancelPurge();
```

### 2. Multiple Terminal States

Workflow completes → schedules purge → gets cancelled before purge:
- Current design: Cancel wouldn't work because workflow is already completed
- This is expected behavior - first terminal state wins

### 3. Alarm During Purge Delay

If workflow is paused and alarm fires during purge delay:
- Current design: `executePurgeIfDue()` checks timestamp, only executes if due
- Resume alarms would still work

---

## Future Considerations

### 1. Selective Purge

Keep some data (e.g., workflow output) while purging step data:

```typescript
purge: {
  delay: "60 seconds",
  keep: ["workflow:output", "workflow:status"],
}
```

### 2. Retention Policy by State

Different delays for different terminal states:

```typescript
purge: {
  retention: {
    completed: "1 minute",
    failed: "24 hours",    // Keep failed workflows longer for debugging
    cancelled: "5 minutes",
  },
}
```

### 3. Disable Purge for Specific States

Option to only purge on certain terminal states:

```typescript
purge: {
  delay: "60 seconds",
  only: ["completed"],  // Don't purge failed/cancelled for debugging
}
```
