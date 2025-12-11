# Primitives Architecture Design Report

**Date**: 2024-12-08
**Package**: `@durable-effect/primitives`
**Focus**: Layer design for Continuous and Buffer primitives

---

## Executive Summary

This report addresses the architectural challenge of designing a unified interface layer that:

1. **Bridges** multiple primitive types (Continuous, Buffer, Queue, etc.) to a durable compute engine
2. **One entity per DO instance** - each DO instance runs exactly one primitive, addressed by key
3. **Abstracts** the underlying platform (Cloudflare DO today, potentially others later)
4. **Dynamically dispatches** to the correct handler based on primitive type at call time

The key insight is that while the workflow package has a **single state machine** with deterministic replay, primitives have **multiple execution patterns** that require a **handler-based dispatch architecture**. However, like workflows, **each DO instance manages exactly one primitive entity** - the key/ID determines which instance you're talking to.

---

## Table of Contents

- [Problem Analysis](#problem-analysis)
- [Key Design Decisions](#key-design-decisions)
- [Proposed Architecture](#proposed-architecture)
- [Layer Hierarchy](#layer-hierarchy)
- [Primitive Handler Interface](#primitive-handler-interface)
- [Entity Dispatch System](#entity-dispatch-system)
- [Concrete Examples: Continuous & Buffer](#concrete-examples-continuous--buffer)
- [State Management Strategy](#state-management-strategy)
- [Alarm Routing Strategy](#alarm-routing-strategy)
- [Alternative Approaches Considered](#alternative-approaches-considered)
- [Implementation Roadmap](#implementation-roadmap)

---

## Problem Analysis

### Workflow vs Primitives: Key Differences

| Aspect | Workflow | Primitives |
|--------|----------|------------|
| State Machine | Single, well-defined lifecycle | Multiple primitive-specific lifecycles |
| Execution Model | Deterministic replay | Event-driven, pattern-specific |
| Alarm Handling | Resume from pause point | Varies: interval, deadline, flush |
| Entity Scope | One workflow per DO instance | One primitive per DO instance |
| Type Selection | `call.workflow` parameter | `call.primitive` parameter |
| State Namespace | `workflow:*` | `primitive:*` (type stored in state) |

### The Core Challenge

Both workflow and primitives follow the **one entity per DO instance** pattern. The key is addressed by the instance ID:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    createDurablePrimitives()                        │
│                                                                     │
│  Registers:                                                         │
│    - tokenRefresher: Continuous.make(...)                          │
│    - eventBuffer: Buffer.make(...)                                 │
│                                                                     │
│  Produces: Single DO class "Primitives"                            │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    DO Instances (one per key)                       │
│                                                                     │
│  Instance: "google-oauth-user-123"                                 │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Type: Continuous (tokenRefresher)                          │   │
│  │  State: Running                                              │   │
│  │  Next Alarm: +59 minutes                                     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Instance: "contact-sync-org-456"                                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Type: Buffer (eventBuffer)                                  │   │
│  │  State: Buffering (5 items)                                  │   │
│  │  Next Alarm: +3 seconds (flush deadline)                     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Questions to solve:**
1. How do we know which primitive handler to invoke for a given instance?
2. How do we support different alarm semantics (interval vs deadline)?
3. How do we allow the same DO class to handle different primitive types?
4. How do we provide type-safe client access per primitive definition?

---

## Key Design Decisions

### Decision 1: Handler-Based Dispatch

Each primitive type implements a `PrimitiveHandler` interface. The engine dispatches to the correct handler based on the primitive type stored in the instance's state.

**Rationale**: This mirrors how workflow has an Executor, but allows multiple execution patterns. The primitive type is determined at initialization time and stored in storage.

### Decision 2: Type Stored in Instance State

When a primitive is first initialized, we store its type in `primitive:type`. All subsequent calls and alarms look up this type to dispatch to the correct handler.

```
primitive:type    → "continuous"           # Which handler to use
primitive:name    → "tokenRefresher"       # Which definition (for config lookup)
primitive:state   → { status: "running" }  # Handler-specific state
primitive:config  → { interval: "59m" }    # Definition config
```

**Rationale**: Simple, one read to determine which handler. No registry needed since one entity per instance.

### Decision 3: Alarm Semantics Per Handler

Each handler type defines its own alarm behavior:
- **Continuous**: Interval-based, always schedules next alarm
- **Buffer**: Deadline-based, schedules when first item arrives, clears on flush

The handler's `onAlarm` returns the next alarm time (or undefined to clear).

**Rationale**: Alarm logic is primitive-specific, not a shared concern.

### Decision 4: Initialization on First Call

The primitive type is bound to the DO instance on the first RPC call. Subsequent calls must use the same primitive type or get an error.

```typescript
// First call to instance "user-123" - initializes as tokenRefresher
client.tokenRefresher("user-123").start({ tokens })

// Later call - must be same primitive type
client.tokenRefresher("user-123").refresh()  // ✓ OK
client.eventBuffer("user-123").add(item)     // ✗ Error: instance is tokenRefresher
```

**Rationale**: Matches workflow pattern where instance ID is tied to one workflow.

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        DurablePrimitivesEngine                               │
│                     (extends DurableObject)                                  │
│                     One instance per entity key                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      PrimitiveDispatcher                             │   │
│  │  - Looks up primitive type from storage                             │   │
│  │  - Routes RPC calls to correct handler                              │   │
│  │  - Routes alarms to handler's onAlarm                               │   │
│  │  - Initializes primitive on first call                              │   │
│  └──────────────────────────┬──────────────────────────────────────────┘   │
│                             │                                               │
│           ┌─────────────────┼─────────────────┐                            │
│           │                 │                 │                            │
│           ▼                 ▼                 ▼                            │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐                  │
│  │ContinuousHandler│ │ BufferHandler  │ │ QueueHandler   │                  │
│  │                │ │                │ │                │                  │
│  │ - start()     │ │ - add()        │ │ - enqueue()    │                  │
│  │ - stop()      │ │ - flush()      │ │ - process()    │                  │
│  │ - onAlarm()   │ │ - onAlarm()    │ │ - onAlarm()    │                  │
│  └────────────────┘ └────────────────┘ └────────────────┘                  │
│           │                 │                 │                            │
│           └─────────────────┼─────────────────┘                            │
│                             │                                               │
│  ┌──────────────────────────▼──────────────────────────────────────────┐   │
│  │                      PrimitiveContext                                │   │
│  │  - Storage access (primitive:* namespace)                           │   │
│  │  - Alarm scheduling                                                 │   │
│  │  - Event emission                                                   │   │
│  │  - Instance identity (key)                                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                             │                                               │
│  ┌──────────────────────────▼──────────────────────────────────────────┐   │
│  │                      RuntimeLayer                                    │   │
│  │  StorageAdapter | SchedulerAdapter | RuntimeAdapter                 │   │
│  │  (Same as workflow - platform abstraction)                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Comparison with Workflow Architecture

The structure mirrors the workflow package closely:

| Workflow | Primitives |
|----------|------------|
| `WorkflowOrchestrator` | `PrimitiveDispatcher` |
| `WorkflowExecutor` | `PrimitiveHandler` (per type) |
| `WorkflowStateMachine` | Handler-specific state |
| `WorkflowRegistry` | `PrimitiveRegistry` (handler lookup) |
| `WorkflowContext` | `PrimitiveContext` |

---

## Layer Hierarchy

### Effect Services Stack

```
┌─────────────────────────────────────────────────────────────────┐
│                   PrimitiveDispatcher                           │
│   - Routes RPC to correct handler action                        │
│   - Routes alarms to handler's onAlarm                          │
│   - Initializes primitive on first call                         │
│   - Provides: dispatch(), handleAlarm(), initialize()           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   PrimitiveRegistry                             │
│   - Maps definition names to handlers                           │
│   - get("tokenRefresher") → ContinuousHandler                  │
│   - Validates definition exists                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PrimitiveContext                             │
│   - Instance identity (key from DO)                             │
│   - Storage access (primitive:* namespace)                      │
│   - Alarm scheduling (single alarm per instance)                │
│   - Event emission                                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RuntimeLayer                               │
│   StorageAdapter + SchedulerAdapter + RuntimeAdapter            │
│   (Identical to workflow package - reuse!)                      │
└─────────────────────────────────────────────────────────────────┘
```

### Layer Definitions

```typescript
// Core runtime adapters (REUSE from workflow package)
class StorageAdapter extends Context.Tag("StorageAdapter")<...>() {}
class SchedulerAdapter extends Context.Tag("SchedulerAdapter")<...>() {}
class RuntimeAdapter extends Context.Tag("RuntimeAdapter")<...>() {}

// Primitive-specific services
class PrimitiveContext extends Context.Tag("PrimitiveContext")<
  PrimitiveContext,
  {
    readonly instanceId: string;                  // DO instance key
    readonly primitiveName: string | undefined;   // Set after initialization
    readonly primitiveType: string | undefined;   // "continuous" | "buffer" | etc.
    readonly storage: StorageAdapterService;      // Direct access, primitive:* namespace
    readonly scheduleAlarm: (time: number) => Effect<void>;
    readonly cancelAlarm: () => Effect<void>;
    readonly now: Effect<number>;
  }
>() {}

class PrimitiveRegistry extends Context.Tag("PrimitiveRegistry")<
  PrimitiveRegistry,
  {
    readonly get: (name: string) => Effect<{
      handler: PrimitiveHandler<any, any, any>;
      config: unknown;
    }, PrimitiveNotFoundError>;
    readonly getHandler: (type: string) => Effect<
      PrimitiveHandler<any, any, any>,
      PrimitiveNotFoundError
    >;
  }
>() {}

class PrimitiveDispatcher extends Context.Tag("PrimitiveDispatcher")<
  PrimitiveDispatcher,
  {
    /** Execute an action on this instance */
    readonly dispatch: <A>(
      primitiveName: string,
      action: string,
      args: unknown[],
    ) => Effect<A>;

    /** Handle the DO alarm */
    readonly handleAlarm: () => Effect<void>;

    /** Get current status */
    readonly getStatus: () => Effect<PrimitiveStatus | undefined>;

    /** Destroy this primitive instance */
    readonly destroy: () => Effect<void>;
  }
>() {}
```

---

## Primitive Handler Interface

Each primitive type must implement this interface:

```typescript
/**
 * Handler for a specific primitive type.
 *
 * Handlers are stateless - all state is stored via PrimitiveContext.
 * This allows the same handler to be used for multiple entities.
 */
interface PrimitiveHandler<
  Config,
  State,
  Actions extends Record<string, (...args: any[]) => any>,
> {
  /**
   * Unique type identifier for this primitive.
   */
  readonly type: string;

  /**
   * Schema for validating config at creation time.
   */
  readonly configSchema: Schema.Schema<Config>;

  /**
   * Schema for state serialization.
   */
  readonly stateSchema: Schema.Schema<State>;

  /**
   * Initialize state for a new entity.
   */
  readonly initialize: (
    config: Config,
  ) => Effect<State, never, PrimitiveContext>;

  /**
   * Handle an alarm for this entity.
   * Returns the next alarm time (if any).
   */
  readonly onAlarm: (
    state: State,
    config: Config,
  ) => Effect<
    { newState: State; nextAlarm?: number },
    unknown,
    PrimitiveContext
  >;

  /**
   * Available actions for this primitive type.
   */
  readonly actions: {
    [K in keyof Actions]: (
      state: State,
      config: Config,
      ...args: Parameters<Actions[K]>
    ) => Effect<
      { newState: State; result: ReturnType<Actions[K]>; nextAlarm?: number },
      unknown,
      PrimitiveContext
    >;
  };

  /**
   * Called when entity is being destroyed.
   * Cleanup any resources.
   */
  readonly destroy?: (
    state: State,
    config: Config,
  ) => Effect<void, unknown, PrimitiveContext>;
}
```

---

## Dispatch System

### How Dispatch Works (One Entity Per Instance)

```
┌─────────────────────────────────────────────────────────────────┐
│         Client call: client.tokenRefresher("user-123").start()  │
│                                                                 │
│         Routes to DO instance with key "user-123"               │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│             DurablePrimitivesEngine (instance: "user-123")      │
│                                                                 │
│  RPC method: dispatch("tokenRefresher", "start", [...args])     │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PrimitiveDispatcher                        │
│                                                                 │
│  1. Check if instance is initialized                            │
│     storage.get("primitive:type") → undefined (first call)      │
│                                                                 │
│  2. First call - initialize primitive                           │
│     registry.get("tokenRefresher") → { handler, config }        │
│     storage.put("primitive:type", "continuous")                 │
│     storage.put("primitive:name", "tokenRefresher")             │
│     storage.put("primitive:config", config)                     │
│     handler.initialize(config) → initialState                   │
│     storage.put("primitive:state", initialState)                │
│                                                                 │
│  3. Execute action                                              │
│     handler.actions["start"](state, config, ...args)            │
│     │                                                           │
│     └─► { newState, result, nextAlarm }                         │
│                                                                 │
│  4. Persist and schedule                                        │
│     storage.put("primitive:state", newState)                    │
│     scheduler.schedule(nextAlarm)                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Subsequent Calls (Instance Already Initialized)

```
┌─────────────────────────────────────────────────────────────────┐
│         Client call: client.tokenRefresher("user-123").stop()   │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PrimitiveDispatcher                        │
│                                                                 │
│  1. Check if instance is initialized                            │
│     storage.get("primitive:type") → "continuous" ✓              │
│     storage.get("primitive:name") → "tokenRefresher" ✓          │
│                                                                 │
│  2. Validate call matches instance type                         │
│     Request: "tokenRefresher" === stored "tokenRefresher" ✓     │
│     (If mismatch → PrimitiveTypeMismatchError)                  │
│                                                                 │
│  3. Load state and config                                       │
│     storage.get("primitive:state") → state                      │
│     storage.get("primitive:config") → config                    │
│                                                                 │
│  4. Get handler and execute                                     │
│     registry.getHandler("continuous") → ContinuousHandler       │
│     handler.actions["stop"](state, config)                      │
│                                                                 │
│  5. Persist and update alarm                                    │
│     storage.put("primitive:state", newState)                    │
│     scheduler.cancel()  // stop clears the alarm                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Alarm Flow (Simple - One Alarm Per Instance)

```
┌─────────────────────────────────────────────────────────────────┐
│              DO.alarm() fires for instance "user-123"           │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PrimitiveDispatcher                        │
│                                                                 │
│  1. Load instance metadata                                      │
│     storage.get("primitive:type") → "continuous"                │
│     storage.get("primitive:state") → state                      │
│     storage.get("primitive:config") → config                    │
│                                                                 │
│  2. Get handler and execute onAlarm                             │
│     registry.getHandler("continuous") → ContinuousHandler       │
│     handler.onAlarm(state, config)                              │
│     │                                                           │
│     └─► { newState, nextAlarm: now + 59min }                    │
│                                                                 │
│  3. Persist and schedule next                                   │
│     storage.put("primitive:state", newState)                    │
│     scheduler.schedule(nextAlarm)                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Concrete Examples: Continuous & Buffer

### Continuous Handler

```typescript
/**
 * Continuous primitive - runs at intervals indefinitely.
 *
 * Use cases:
 * - Token refresh
 * - Health checks
 * - Periodic sync
 */

interface ContinuousConfig {
  readonly interval: Duration;
  readonly maxRetries?: number;
  readonly retryDelay?: Duration;
}

interface ContinuousState {
  readonly status: "running" | "stopped" | "error";
  readonly lastRunAt?: number;
  readonly nextRunAt?: number;
  readonly consecutiveFailures: number;
  readonly error?: { message: string; stack?: string };
}

const ContinuousHandler: PrimitiveHandler<
  ContinuousConfig,
  ContinuousState,
  {
    start: () => void;
    stop: () => void;
    trigger: () => void;  // Run immediately
  }
> = {
  type: "continuous",

  configSchema: Schema.Struct({
    interval: DurationSchema,
    maxRetries: Schema.optional(Schema.Number),
    retryDelay: Schema.optional(DurationSchema),
  }),

  stateSchema: Schema.Struct({
    status: Schema.Literal("running", "stopped", "error"),
    lastRunAt: Schema.optional(Schema.Number),
    nextRunAt: Schema.optional(Schema.Number),
    consecutiveFailures: Schema.Number,
    error: Schema.optional(Schema.Struct({
      message: Schema.String,
      stack: Schema.optional(Schema.String),
    })),
  }),

  initialize: (config) =>
    Effect.gen(function* () {
      const ctx = yield* PrimitiveContext;
      const now = yield* ctx.now;
      const nextRunAt = now + parseDuration(config.interval);

      return {
        status: "running",
        lastRunAt: undefined,
        nextRunAt,
        consecutiveFailures: 0,
      };
    }),

  onAlarm: (state, config) =>
    Effect.gen(function* () {
      const ctx = yield* PrimitiveContext;
      const now = yield* ctx.now;

      if (state.status !== "running") {
        // Stopped - no next alarm
        return { newState: state };
      }

      // Execute the user's effect (stored in entity config)
      const executeEffect = yield* ctx.storage.get<Effect<void>>("execute");

      const result = yield* executeEffect.pipe(
        Effect.map(() => ({ success: true as const })),
        Effect.catchAll((error) =>
          Effect.succeed({ success: false as const, error })
        ),
      );

      if (result.success) {
        const nextRunAt = now + parseDuration(config.interval);
        return {
          newState: {
            ...state,
            lastRunAt: now,
            nextRunAt,
            consecutiveFailures: 0,
            error: undefined,
          },
          nextAlarm: nextRunAt,
        };
      }

      // Failure - check retry logic
      const newFailures = state.consecutiveFailures + 1;
      const maxRetries = config.maxRetries ?? 3;

      if (newFailures >= maxRetries) {
        // Max retries exceeded - stop with error
        return {
          newState: {
            ...state,
            status: "error",
            consecutiveFailures: newFailures,
            error: {
              message: result.error instanceof Error
                ? result.error.message
                : String(result.error),
            },
          },
          // No next alarm - stopped in error state
        };
      }

      // Schedule retry
      const retryDelay = config.retryDelay ?? "1 minute";
      const nextRunAt = now + parseDuration(retryDelay);

      return {
        newState: {
          ...state,
          lastRunAt: now,
          nextRunAt,
          consecutiveFailures: newFailures,
        },
        nextAlarm: nextRunAt,
      };
    }),

  actions: {
    start: (state, config) =>
      Effect.gen(function* () {
        const ctx = yield* PrimitiveContext;
        const now = yield* ctx.now;
        const nextRunAt = now + parseDuration(config.interval);

        return {
          newState: {
            ...state,
            status: "running",
            nextRunAt,
            consecutiveFailures: 0,
            error: undefined,
          },
          result: undefined,
          nextAlarm: nextRunAt,
        };
      }),

    stop: (state, _config) =>
      Effect.gen(function* () {
        return {
          newState: {
            ...state,
            status: "stopped",
            nextRunAt: undefined,
          },
          result: undefined,
          // No nextAlarm - clears scheduled alarm
        };
      }),

    trigger: (state, config) =>
      Effect.gen(function* () {
        const ctx = yield* PrimitiveContext;
        const now = yield* ctx.now;

        return {
          newState: {
            ...state,
            nextRunAt: now, // Run immediately on next tick
          },
          result: undefined,
          nextAlarm: now + 1, // Schedule alarm for immediate execution
        };
      }),
  },
};
```

### Buffer Handler

```typescript
/**
 * Buffer primitive - collects items and flushes on deadline or capacity.
 *
 * Use cases:
 * - Debouncing writes
 * - Batching analytics events
 * - Coalescing notifications
 */

interface BufferConfig {
  readonly maxItems: number;
  readonly maxWait: Duration;
  readonly flushOnEveryAdd?: boolean;  // Reset timer on each add
}

interface BufferState<T = unknown> {
  readonly status: "idle" | "buffering" | "flushing";
  readonly items: ReadonlyArray<T>;
  readonly firstItemAt?: number;
  readonly flushAt?: number;
}

const BufferHandler: PrimitiveHandler<
  BufferConfig,
  BufferState,
  {
    add: <T>(item: T) => { buffered: number };
    flush: () => { flushed: number };
    clear: () => void;
  }
> = {
  type: "buffer",

  configSchema: Schema.Struct({
    maxItems: Schema.Number.pipe(Schema.greaterThan(0)),
    maxWait: DurationSchema,
    flushOnEveryAdd: Schema.optional(Schema.Boolean),
  }),

  stateSchema: Schema.Struct({
    status: Schema.Literal("idle", "buffering", "flushing"),
    items: Schema.Array(Schema.Unknown),
    firstItemAt: Schema.optional(Schema.Number),
    flushAt: Schema.optional(Schema.Number),
  }),

  initialize: (_config) =>
    Effect.succeed({
      status: "idle",
      items: [],
      firstItemAt: undefined,
      flushAt: undefined,
    }),

  onAlarm: (state, config) =>
    Effect.gen(function* () {
      const ctx = yield* PrimitiveContext;

      if (state.items.length === 0) {
        // Nothing to flush
        return {
          newState: {
            status: "idle",
            items: [],
            firstItemAt: undefined,
            flushAt: undefined,
          },
        };
      }

      // Execute flush callback
      const flushCallback = yield* ctx.storage.get<
        (items: unknown[]) => Effect<void>
      >("flush");

      yield* flushCallback([...state.items]).pipe(
        Effect.catchAll((error) =>
          Effect.logError("Buffer flush failed", { error })
        ),
      );

      // Emit event
      yield* emitEvent({
        type: "buffer.flushed",
        entityId: ctx.entityId,
        itemCount: state.items.length,
        reason: "deadline",
      });

      return {
        newState: {
          status: "idle",
          items: [],
          firstItemAt: undefined,
          flushAt: undefined,
        },
        // No next alarm - buffer is empty
      };
    }),

  actions: {
    add: (state, config, item) =>
      Effect.gen(function* () {
        const ctx = yield* PrimitiveContext;
        const now = yield* ctx.now;

        const newItems = [...state.items, item];
        const isFirstItem = state.items.length === 0;
        const firstItemAt = state.firstItemAt ?? now;

        // Check if we should flush immediately (capacity reached)
        if (newItems.length >= config.maxItems) {
          // Flush now
          const flushCallback = yield* ctx.storage.get<
            (items: unknown[]) => Effect<void>
          >("flush");

          yield* flushCallback(newItems).pipe(
            Effect.catchAll((error) =>
              Effect.logError("Buffer flush failed", { error })
            ),
          );

          yield* emitEvent({
            type: "buffer.flushed",
            entityId: ctx.entityId,
            itemCount: newItems.length,
            reason: "capacity",
          });

          return {
            newState: {
              status: "idle",
              items: [],
              firstItemAt: undefined,
              flushAt: undefined,
            },
            result: { buffered: 0 },
            // No next alarm - buffer is empty
          };
        }

        // Buffer the item
        const maxWaitMs = parseDuration(config.maxWait);
        const flushAt = config.flushOnEveryAdd
          ? now + maxWaitMs  // Reset deadline on each add
          : firstItemAt + maxWaitMs;  // Deadline from first item

        return {
          newState: {
            status: "buffering",
            items: newItems,
            firstItemAt,
            flushAt,
          },
          result: { buffered: newItems.length },
          nextAlarm: flushAt,
        };
      }),

    flush: (state, _config) =>
      Effect.gen(function* () {
        const ctx = yield* PrimitiveContext;

        if (state.items.length === 0) {
          return {
            newState: state,
            result: { flushed: 0 },
          };
        }

        const flushCallback = yield* ctx.storage.get<
          (items: unknown[]) => Effect<void>
        >("flush");

        yield* flushCallback([...state.items]).pipe(
          Effect.catchAll((error) =>
            Effect.logError("Buffer flush failed", { error })
          ),
        );

        yield* emitEvent({
          type: "buffer.flushed",
          entityId: ctx.entityId,
          itemCount: state.items.length,
          reason: "manual",
        });

        return {
          newState: {
            status: "idle",
            items: [],
            firstItemAt: undefined,
            flushAt: undefined,
          },
          result: { flushed: state.items.length },
          // No next alarm - buffer is empty
        };
      }),

    clear: (state, _config) =>
      Effect.gen(function* () {
        yield* emitEvent({
          type: "buffer.cleared",
          entityId: (yield* PrimitiveContext).entityId,
          itemCount: state.items.length,
        });

        return {
          newState: {
            status: "idle",
            items: [],
            firstItemAt: undefined,
            flushAt: undefined,
          },
          result: undefined,
          // No next alarm
        };
      }),
  },
};
```

---

## State Management Strategy

### Storage Key Convention (Simple - One Entity Per Instance)

Since each DO instance manages exactly one primitive, storage keys are simple:

```
Storage Keys (per DO instance):
├── primitive:type       → "continuous"           # Handler type
├── primitive:name       → "tokenRefresher"       # Definition name
├── primitive:config     → { interval: "59m" }    # Definition config
├── primitive:state      → { status: "running" }  # Handler-specific state
├── primitive:meta       → { createdAt, updatedAt }
├── primitive:execute    → (serialized effect)    # For Continuous
└── primitive:flush      → (serialized callback)  # For Buffer
```

Compare to workflow:
```
workflow:status          → { _tag: "Running" }
workflow:name            → "processOrder"
workflow:input           → { orderId: "123" }
workflow:completedSteps  → ["fetch", "validate"]
```

### Instance Metadata Schema

```typescript
interface PrimitiveMeta {
  readonly type: string;              // "continuous" | "buffer" | etc.
  readonly name: string;              // Definition name
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: "active" | "stopped" | "error";
}

// Status is also stored in the handler-specific state
// but we keep a top-level status for quick queries
```

### No Scoped Storage Needed

Since each instance has its own storage, we don't need scoping:

```typescript
// In workflow
storage.get(`workflow:${key}`)

// In primitives - same pattern
storage.get(`primitive:${key}`)

// Both are already scoped by the DO instance
```

---

## Alarm Strategy

### Simple - One Alarm Per Instance

Since each DO instance manages exactly one primitive, alarm handling is straightforward:

```typescript
// Each instance has at most one alarm scheduled
// No coordination needed between entities

class PrimitiveDispatcherImpl {
  handleAlarm(): Effect<void> {
    return Effect.gen(function* () {
      const storage = yield* StorageAdapter;
      const scheduler = yield* SchedulerAdapter;
      const registry = yield* PrimitiveRegistry;

      // Load instance info
      const type = yield* storage.get<string>("primitive:type");
      if (!type) return; // Not initialized

      const state = yield* storage.get("primitive:state");
      const config = yield* storage.get("primitive:config");

      // Get handler and execute
      const handler = yield* registry.getHandler(type);
      const result = yield* handler.onAlarm(state, config);

      // Persist new state
      yield* storage.put("primitive:state", result.newState);

      // Schedule next alarm (or clear)
      if (result.nextAlarm !== undefined) {
        yield* scheduler.schedule(result.nextAlarm);
      } else {
        yield* scheduler.cancel();
      }
    });
  }
}
```

### Handler Alarm Patterns

Each handler type has its own alarm semantics:

| Handler | Alarm Pattern | Next Alarm |
|---------|---------------|------------|
| Continuous | Fixed interval | `now + interval` |
| Buffer | Deadline from first item | `firstItemAt + maxWait` |
| Queue | Process next item | `now + processingDelay` |
| Semaphore | Window reset | `windowStart + windowDuration` |

```typescript
// Continuous: Always schedules next
onAlarm: () => ({ newState, nextAlarm: now + interval })

// Buffer: Only schedules when items present
onAlarm: () => {
  flush(items);
  return { newState: { items: [] }, nextAlarm: undefined };
}

// On add():
return {
  newState: { items: [...items, item] },
  nextAlarm: items.length === 0 ? now + maxWait : state.flushAt,
};
```

---

## Alternative Approaches Considered

### Alternative 1: Multiple Entities Per DO (Rejected)

**Approach**: Pack multiple primitive instances into a single DO, with entity ID routing.

**Pros**:
- Fewer DO instances
- Potential memory sharing

**Cons**:
- Complex alarm coordination (priority queue for single alarm)
- State namespace collision risk
- Harder to reason about
- No real benefit since DOs are cheap

**Why rejected**: Added complexity without clear benefit. One entity per DO is simpler and matches the workflow pattern.

### Alternative 2: Type-Specific DO Classes (Rejected)

**Approach**: One DO class per primitive type (ContinuousDO, BufferDO).

**Pros**:
- Simpler per-type implementation
- Type-specific optimizations

**Cons**:
- User must export multiple DO classes
- Can't have a single `Primitives` binding
- Duplicated adapter code

**Why rejected**: The goal is a single `Primitives` export like `Workflows`.

### Alternative 3: External Scheduler (Rejected)

**Approach**: Use an external scheduling service (e.g., Cloudflare Queues) instead of DO alarms.

**Pros**:
- More flexible scheduling
- Better visibility

**Cons**:
- Additional infrastructure
- Latency between services
- Cost

**Why rejected**: Keeps everything self-contained in DOs.

### Chosen Approach: One Entity Per DO, Dynamic Handler

**Why this works**:
- Matches workflow pattern (familiar to users)
- Simple alarm handling (one alarm = one handler.onAlarm)
- DO instances are cheap and isolated
- Handler dispatch on first call, stored in instance state
- Single `Primitives` export for all primitive types

---

## Implementation Roadmap

### Phase 1: Core Infrastructure

```
┌──────────────────────────────────────────────────────┐
│  1.1 Runtime Layer (REUSE from @durable-effect/core)│
│      - StorageAdapter                                │
│      - SchedulerAdapter                              │
│      - RuntimeAdapter                                │
│      - createDurableObjectRuntime()                  │
├──────────────────────────────────────────────────────┤
│  1.2 PrimitiveContext                               │
│      - Instance identity                             │
│      - Storage access (primitive:* keys)             │
│      - Alarm scheduling wrapper                      │
└──────────────────────────────────────────────────────┘
```

### Phase 2: Handler System

```
┌──────────────────────────────────────────────────────┐
│  2.1 PrimitiveHandler interface                     │
│      - Type definition                               │
│      - Schema integration for config/state           │
│      - initialize(), onAlarm(), actions pattern      │
├──────────────────────────────────────────────────────┤
│  2.2 PrimitiveRegistry                              │
│      - Register definitions by name                  │
│      - Map names to handlers + configs               │
├──────────────────────────────────────────────────────┤
│  2.3 PrimitiveDispatcher                            │
│      - Initialize on first call                      │
│      - Route actions to handler                      │
│      - Handle alarms                                 │
│      - State persistence                             │
└──────────────────────────────────────────────────────┘
```

### Phase 3: Primitive Implementations

```
┌──────────────────────────────────────────────────────┐
│  3.1 Continuous Handler                             │
│      - Interval scheduling                           │
│      - Retry logic                                   │
│      - Error states                                  │
│      - Actions: start(), stop(), trigger()          │
├──────────────────────────────────────────────────────┤
│  3.2 Buffer Handler                                 │
│      - Item accumulation                             │
│      - Deadline and capacity triggers                │
│      - Flush callbacks                               │
│      - Actions: add(), flush(), clear()             │
└──────────────────────────────────────────────────────┘
```

### Phase 4: Engine & Client

```
┌──────────────────────────────────────────────────────┐
│  4.1 createDurablePrimitives() factory              │
│      - Layer assembly (like createDurableWorkflows) │
│      - DO class generation                           │
│      - Single export: { Primitives, PrimitiveClient }│
├──────────────────────────────────────────────────────┤
│  4.2 PrimitiveClient                                │
│      - client.tokenRefresher(key).start()           │
│      - client.eventBuffer(key).add(item)            │
│      - Type-safe per-primitive methods               │
├──────────────────────────────────────────────────────┤
│  4.3 Testing utilities                              │
│      - In-memory runtime (reuse from workflow)      │
│      - Time control                                  │
└──────────────────────────────────────────────────────┘
```

---

## Summary

The proposed architecture mirrors the workflow package with key adaptations for event-driven primitives:

### Core Principles

1. **One entity per DO instance** - Same pattern as workflows, addressed by key
2. **Handler-based dispatch** - Each primitive type (Continuous, Buffer) implements a standard interface
3. **Type bound on first call** - Instance becomes a specific primitive type when initialized
4. **Simple alarm handling** - One alarm per instance, handler decides next alarm

### Comparison with Workflow

| Aspect | Workflow | Primitives |
|--------|----------|------------|
| Instance scope | One workflow per DO | One primitive per DO |
| Type selection | `call.workflow` | `call.primitive` |
| Execution model | Deterministic replay | Event-driven actions |
| State management | Step-based caching | Handler-specific state |
| Alarm meaning | Resume from pause | Handler-specific (interval, deadline) |

### Benefits

- **Familiar pattern**: Users who know workflows will understand primitives
- **Shared infrastructure**: Reuse RuntimeLayer from workflow/core
- **Simple mental model**: One instance = one primitive
- **Type-safe client**: `client.tokenRefresher(key).start()` with full inference
- **Extensible**: Add new handlers without changing core

### Key Insight

While workflows have a **linear execution model** (start → steps → pause → resume → complete), primitives have an **event-driven model** (initialize → actions/alarms → actions/alarms → destroy). The handler pattern accommodates different event semantics while maintaining the one-entity-per-DO simplicity.
