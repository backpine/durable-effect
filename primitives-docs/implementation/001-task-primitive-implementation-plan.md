# Task Primitive Implementation Plan

## Executive Summary

This document provides a detailed, multi-phase implementation plan for the Task primitive in `@packages/jobs/`. The plan is structured to establish type-safe foundations first, avoiding typecasting by building proper type inference chains from the ground up.

**Key Principle**: Each phase builds complete type-safe foundations before moving to the next. No `as any` or `as unknown` casts except at runtime registry boundaries (following existing patterns).

---

## Architecture Analysis

### Existing Patterns to Follow

Based on analysis of the current `@packages/jobs/` architecture:

#### 1. Registry Type Chain
```
UnregisteredXxxDefinition<S, E, R>  →  XxxDefinition<S, E, R>  →  StoredXxxDefinition<S, R>
      (no name, user creates)              (has name)                (error widened to unknown)
```

#### 2. Key Extraction Types
```ts
XxxKeysOf<T>      // Extract definition keys from definitions object
XxxStateOf<T, K>  // Extract state type for a specific key
XxxEventOf<T, K>  // Extract event type for a specific key
```

#### 3. Context Typing
```ts
XxxEventContext<S, E>    // onEvent handler context
XxxExecuteContext<S>     // execute handler context
XxxIdleContext<S>        // onIdle handler context
XxxErrorContext<S>       // onError handler context
```

#### 4. Handler Architecture
```
Handler Interface (XxxHandlerI)
    └── handle(request): Effect<Response, JobError>
    └── handleAlarm(): Effect<void, JobError>

Handler Tag (Context.Tag)

Handler Layer (Layer.effect)
    └── Dependencies: Storage, Runtime, Metadata, Alarm, Retry, Registry
```

#### 5. Storage Key Convention
```ts
KEYS.TASK = {
  EVENT_COUNT: "task:eventCount",
  EXECUTE_COUNT: "task:executeCount",
  CREATED_AT: "task:createdAt",
  SCHEDULED_AT: "task:scheduledAt",
}
```

---

## Phase 1: Type Foundations

**Goal**: Establish all type definitions with proper inference chains. Zero runtime code - pure types.

### 1.1 Define Unregistered Task Definition

**File**: `packages/jobs/src/registry/types.ts`

Add to existing types:

```ts
// =============================================================================
// Task Definition Types
// =============================================================================

/**
 * Unregistered task job definition.
 * Created by Task.make() - does not have a name yet.
 *
 * Type Parameters:
 * - S: State schema type (decoded)
 * - E: Event schema type (decoded)
 * - Err: Error type from handlers
 * - R: Effect requirements (context)
 */
export interface UnregisteredTaskDefinition<
  S = unknown,
  E = unknown,
  Err = unknown,
  R = never,
> {
  readonly _tag: "TaskDefinition";
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly eventSchema: Schema.Schema<E, any, never>;

  /**
   * Handler called for each incoming event.
   * Updates state and optionally schedules execution.
   */
  onEvent(ctx: TaskEventContext<S, E>): Effect.Effect<void, Err, R>;

  /**
   * Handler called when alarm fires.
   * Processes state and optionally schedules next execution.
   */
  execute(ctx: TaskExecuteContext<S>): Effect.Effect<void, Err, R>;

  /**
   * Optional handler called when execution completes with no alarm scheduled.
   */
  onIdle?(ctx: TaskIdleContext<S>): Effect.Effect<void, never, R>;

  /**
   * Optional error handler for onEvent/execute failures.
   */
  onError?(error: Err, ctx: TaskErrorContext<S>): Effect.Effect<void, never, R>;
}
```

### 1.2 Define Stored Task Definition

**File**: `packages/jobs/src/registry/types.ts`

```ts
/**
 * Stored task job definition (error type widened to unknown).
 * Used in RuntimeJobRegistry for handler consumption.
 */
export interface StoredTaskDefinition<S = unknown, E = unknown, R = never> {
  readonly _tag: "TaskDefinition";
  readonly name: string;
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly eventSchema: Schema.Schema<E, any, never>;
  execute(ctx: TaskExecuteContext<S>): Effect.Effect<void, unknown, R>;
  onEvent(ctx: TaskEventContext<S, E>): Effect.Effect<void, unknown, R>;
  onIdle?(ctx: TaskIdleContext<S>): Effect.Effect<void, never, R>;
  onError?(error: unknown, ctx: TaskErrorContext<S>): Effect.Effect<void, never, R>;
}
```

### 1.3 Define Registered Task Definition

**File**: `packages/jobs/src/registry/types.ts`

```ts
/**
 * Task job definition with name (after registration).
 */
export interface TaskDefinition<
  S = unknown,
  E = unknown,
  Err = unknown,
  R = never,
> extends UnregisteredTaskDefinition<S, E, Err, R> {
  readonly name: string;
}
```

### 1.4 Update Union Types

**File**: `packages/jobs/src/registry/types.ts`

Update `AnyUnregisteredDefinition`:

```ts
export type AnyUnregisteredDefinition =
  | UnregisteredContinuousDefinition<any, unknown, any>
  | UnregisteredDebounceDefinition<any, any, unknown, any>
  | UnregisteredWorkerPoolDefinition<any, unknown, any>
  | UnregisteredTaskDefinition<any, any, unknown, any>;  // ADD THIS

export type AnyJobDefinition =
  | ContinuousDefinition<any, any, any>
  | DebounceDefinition<any, any, any, any>
  | WorkerPoolDefinition<any, any, any>
  | TaskDefinition<any, any, any, any>;  // ADD THIS
```

### 1.5 Define Context Types

**File**: `packages/jobs/src/registry/types.ts`

```ts
// =============================================================================
// Task Context Types
// =============================================================================

/**
 * Context provided to task onEvent handler.
 */
export interface TaskEventContext<S, E> {
  // Event access (synchronous - already decoded)
  readonly event: E;

  // State access (synchronous - already loaded)
  readonly state: S | null;

  // State mutations
  readonly setState: (state: S) => Effect.Effect<void, never, never>;
  readonly updateState: (fn: (current: S) => S) => Effect.Effect<void, never, never>;

  // Scheduling
  readonly schedule: (when: Duration.DurationInput | number | Date) => Effect.Effect<void, never, never>;
  readonly cancelSchedule: () => Effect.Effect<void, never, never>;
  readonly getScheduledTime: () => Effect.Effect<number | null, never, never>;

  // Cleanup
  readonly clear: () => Effect.Effect<never, never, never>;

  // Metadata (synchronous)
  readonly instanceId: string;
  readonly jobName: string;
  readonly executionStartedAt: number;
  readonly isFirstEvent: boolean;

  // Metadata (Effects)
  readonly eventCount: Effect.Effect<number, never, never>;
  readonly createdAt: Effect.Effect<number, never, never>;
}

/**
 * Context provided to task execute handler.
 */
export interface TaskExecuteContext<S> {
  // State access (Effect - loaded on demand)
  readonly state: Effect.Effect<S | null, never, never>;

  // State mutations
  readonly setState: (state: S) => Effect.Effect<void, never, never>;
  readonly updateState: (fn: (current: S) => S) => Effect.Effect<void, never, never>;

  // Scheduling
  readonly schedule: (when: Duration.DurationInput | number | Date) => Effect.Effect<void, never, never>;
  readonly cancelSchedule: () => Effect.Effect<void, never, never>;
  readonly getScheduledTime: () => Effect.Effect<number | null, never, never>;

  // Cleanup
  readonly clear: () => Effect.Effect<never, never, never>;

  // Metadata
  readonly instanceId: string;
  readonly jobName: string;
  readonly executionStartedAt: number;

  // Metadata (Effects)
  readonly eventCount: Effect.Effect<number, never, never>;
  readonly createdAt: Effect.Effect<number, never, never>;
  readonly executeCount: Effect.Effect<number, never, never>;
}

/**
 * Context provided to task onIdle handler.
 */
export interface TaskIdleContext<S> {
  readonly state: Effect.Effect<S | null, never, never>;
  readonly schedule: (when: Duration.DurationInput | number | Date) => Effect.Effect<void, never, never>;
  readonly clear: () => Effect.Effect<never, never, never>;

  readonly instanceId: string;
  readonly jobName: string;
  readonly idleReason: "onEvent" | "execute";
}

/**
 * Context provided to task onError handler.
 */
export interface TaskErrorContext<S> {
  readonly state: Effect.Effect<S | null, never, never>;
  readonly updateState: (fn: (current: S) => S) => Effect.Effect<void, never, never>;
  readonly schedule: (when: Duration.DurationInput | number | Date) => Effect.Effect<void, never, never>;
  readonly clear: () => Effect.Effect<never, never, never>;

  readonly instanceId: string;
  readonly jobName: string;
  readonly errorSource: "onEvent" | "execute";
}
```

### 1.6 Add Key Extraction Types

**File**: `packages/jobs/src/registry/typed.ts`

```ts
// =============================================================================
// Task Key Extraction Types
// =============================================================================

/**
 * Extract keys from T that are task definitions.
 */
export type TaskKeysOf<T extends Record<string, AnyUnregisteredDefinition>> = {
  [K in keyof T]: T[K] extends UnregisteredTaskDefinition<any, any, unknown, any> ? K : never;
}[keyof T] & string;

/**
 * Extract the state type from a task definition.
 */
export type TaskStateOf<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends TaskKeysOf<T>,
> = T[K] extends UnregisteredTaskDefinition<infer S, any, unknown, any> ? S : never;

/**
 * Extract the event type from a task definition.
 */
export type TaskEventOf<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends TaskKeysOf<T>,
> = T[K] extends UnregisteredTaskDefinition<any, infer E, unknown, any> ? E : never;

/**
 * Register a task definition with a name.
 */
type RegisterTask<
  D extends UnregisteredTaskDefinition<any, any, unknown, any>,
  N extends string,
> = D extends UnregisteredTaskDefinition<infer S, infer E, infer Err, infer R>
  ? TaskDefinition<S, E, Err, R> & { readonly name: N }
  : never;
```

### 1.7 Update TypedJobRegistry

**File**: `packages/jobs/src/registry/typed.ts`

```ts
export interface TypedJobRegistry<T extends Record<string, AnyUnregisteredDefinition>> {
  readonly continuous: { /* existing */ };
  readonly debounce: { /* existing */ };
  readonly workerPool: { /* existing */ };

  /**
   * Task job definitions indexed by name.
   */
  readonly task: {
    [K in TaskKeysOf<T>]: RegisterTask<
      Extract<T[K], UnregisteredTaskDefinition<any, any, unknown, any>>,
      K
    >;
  };

  readonly __definitions: T;
}
```

### 1.8 Update RuntimeJobRegistry

**File**: `packages/jobs/src/registry/typed.ts`

```ts
export interface RuntimeJobRegistry {
  readonly continuous: Record<string, StoredContinuousDefinition<any, any>>;
  readonly debounce: Record<string, StoredDebounceDefinition<any, any, any>>;
  readonly workerPool: Record<string, StoredWorkerPoolDefinition<any, any>>;
  readonly task: Record<string, StoredTaskDefinition<any, any, any>>;  // ADD THIS
}
```

### 1.9 Add Type Guard

**File**: `packages/jobs/src/registry/typed.ts`

```ts
/**
 * Check if a registry has a specific task job.
 */
export function hasTaskJob<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends string,
>(
  registry: TypedJobRegistry<T>,
  name: K,
): name is K & TaskKeysOf<T> {
  return name in registry.task;
}
```

### Phase 1 Validation

Run type checking to ensure all type definitions are correct:

```bash
pnpm typecheck
```

**Expected**: No type errors. Types should compile cleanly without runtime code.

---

## Phase 2: Definition Factory

**Goal**: Create `Task.make()` factory that produces type-safe definitions.

### 2.1 Create Task Definition Module

**File**: `packages/jobs/src/definitions/task.ts`

```ts
// packages/jobs/src/definitions/task.ts

import type { Effect, Schema } from "effect";
import type {
  UnregisteredTaskDefinition,
  TaskEventContext,
  TaskExecuteContext,
  TaskIdleContext,
  TaskErrorContext,
} from "../registry/types";

// =============================================================================
// Task Factory
// =============================================================================

/**
 * Input config for creating a task job definition.
 *
 * Generic Parameters:
 * - S: State type (inferred from stateSchema)
 * - E: Event type (inferred from eventSchema)
 * - Err: Error type (inferred from handlers)
 * - R: Effect requirements (inferred from handlers)
 */
export interface TaskMakeConfig<S, E, Err, R> {
  /**
   * Schema for validating and serializing state.
   */
  readonly stateSchema: Schema.Schema<S, any, never>;

  /**
   * Schema for validating incoming events.
   */
  readonly eventSchema: Schema.Schema<E, any, never>;

  /**
   * Handler called for each incoming event.
   *
   * Responsibilities:
   * - Update state based on event
   * - Schedule next execution (if needed)
   */
  onEvent(ctx: TaskEventContext<S, E>): Effect.Effect<void, Err, R>;

  /**
   * Handler called when alarm fires.
   *
   * Responsibilities:
   * - Process state
   * - Schedule next execution (if needed)
   * - Clear state (if task is complete)
   */
  execute(ctx: TaskExecuteContext<S>): Effect.Effect<void, Err, R>;

  /**
   * Optional handler called when either `onEvent` or `execute` completes
   * and no alarm is scheduled.
   */
  readonly onIdle?: (ctx: TaskIdleContext<S>) => Effect.Effect<void, never, R>;

  /**
   * Optional error handler for execute/onEvent failures.
   */
  readonly onError?: (
    error: Err,
    ctx: TaskErrorContext<S>
  ) => Effect.Effect<void, never, R>;
}

/**
 * Namespace for creating task job definitions.
 *
 * @example
 * ```ts
 * import { Task } from "@durable-effect/jobs";
 * import { Schema, Effect } from "effect";
 *
 * const orderProcessor = Task.make({
 *   stateSchema: Schema.Struct({
 *     orderId: Schema.String,
 *     status: Schema.Literal("pending", "shipped", "delivered"),
 *   }),
 *   eventSchema: Schema.Union(
 *     Schema.Struct({ _tag: Schema.Literal("OrderPlaced"), orderId: Schema.String }),
 *     Schema.Struct({ _tag: Schema.Literal("Shipped") }),
 *   ),
 *   onEvent: (ctx) => Effect.gen(function* () {
 *     // Handle events
 *   }),
 *   execute: (ctx) => Effect.gen(function* () {
 *     // Process on alarm
 *   }),
 * });
 * ```
 */
export const Task = {
  /**
   * Create a task job definition.
   *
   * The name is NOT provided here - it comes from the key when you
   * register the job via createDurableJobs().
   */
  make: <S, E, Err = never, R = never>(
    config: TaskMakeConfig<S, E, Err, R>
  ): UnregisteredTaskDefinition<S, E, Err, R> => ({
    _tag: "TaskDefinition",
    stateSchema: config.stateSchema,
    eventSchema: config.eventSchema,
    onEvent: config.onEvent,
    execute: config.execute,
    onIdle: config.onIdle,
    onError: config.onError,
  }),
} as const;

/**
 * Type alias for the Task namespace.
 */
export type TaskNamespace = typeof Task;
```

### 2.2 Export from Definitions Index

**File**: `packages/jobs/src/definitions/index.ts`

```ts
export {
  Continuous,
  type ContinuousMakeConfig,
  type ContinuousNamespace,
} from "./continuous";

export {
  Debounce,
  type DebounceMakeConfig,
  type DebounceNamespace,
} from "./debounce";

// ADD THIS
export {
  Task,
  type TaskMakeConfig,
  type TaskNamespace,
} from "./task";
```

### 2.3 Export from Package Index

**File**: `packages/jobs/src/index.ts`

```ts
// Add Task to exports
export { Task, type TaskMakeConfig, type TaskNamespace } from "./definitions";
```

### Phase 2 Validation

Create a test file to validate type inference:

```ts
// packages/jobs/test/task-types.test.ts
import { Task } from "../src/definitions/task";
import { Schema, Effect, Duration } from "effect";

// Test: Type inference works correctly
const taskDef = Task.make({
  stateSchema: Schema.Struct({
    count: Schema.Number,
    items: Schema.Array(Schema.String),
  }),
  eventSchema: Schema.Union(
    Schema.Struct({ _tag: Schema.Literal("Add"), item: Schema.String }),
    Schema.Struct({ _tag: Schema.Literal("Clear") }),
  ),
  onEvent: (ctx) =>
    Effect.gen(function* () {
      // ctx.state should be { count: number; items: string[] } | null
      // ctx.event should be { _tag: "Add"; item: string } | { _tag: "Clear" }
      if (ctx.state === null) {
        yield* ctx.setState({ count: 0, items: [] });
      }
      yield* ctx.schedule(Duration.seconds(5));
    }),
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      if (state === null) return;
      // state should be { count: number; items: string[] }
      if (state.count > 10) {
        return yield* ctx.clear();
      }
    }),
});

// Type assertion: Should be UnregisteredTaskDefinition
taskDef._tag satisfies "TaskDefinition";
```

---

## Phase 3: Registry Integration

**Goal**: Wire Task definitions into the registry system for registration and lookup.

### 3.1 Update createTypedJobRegistry

**File**: `packages/jobs/src/registry/registry.ts`

```ts
export function createTypedJobRegistry<
  const T extends Record<string, AnyUnregisteredDefinition>,
>(definitions: T): TypedJobRegistry<T> {
  const continuous: Record<string, any> = {};
  const debounce: Record<string, any> = {};
  const workerPool: Record<string, any> = {};
  const task: Record<string, any> = {};  // ADD THIS

  for (const [name, def] of Object.entries(definitions)) {
    const withName = { ...def, name };

    switch (def._tag) {
      case "ContinuousDefinition":
        continuous[name] = withName;
        break;
      case "DebounceDefinition":
        debounce[name] = withName;
        break;
      case "WorkerPoolDefinition":
        workerPool[name] = withName;
        break;
      case "TaskDefinition":  // ADD THIS
        task[name] = withName;
        break;
    }
  }

  return {
    continuous,
    debounce,
    workerPool,
    task,  // ADD THIS
    __definitions: definitions,
  } as TypedJobRegistry<T>;
}
```

### 3.2 Update toRuntimeRegistry

**File**: `packages/jobs/src/registry/registry.ts`

```ts
export function toRuntimeRegistry<T extends Record<string, AnyUnregisteredDefinition>>(
  registry: TypedJobRegistry<T>,
): RuntimeJobRegistry {
  return {
    continuous: registry.continuous as Record<string, StoredContinuousDefinition<any, any>>,
    debounce: registry.debounce as Record<string, StoredDebounceDefinition<any, any, any>>,
    workerPool: registry.workerPool as Record<string, StoredWorkerPoolDefinition<any, any>>,
    task: registry.task as Record<string, StoredTaskDefinition<any, any, any>>,  // ADD THIS
  };
}
```

### 3.3 Add Storage Keys

**File**: `packages/jobs/src/storage-keys.ts`

```ts
export const KEYS = {
  META: "meta",
  STATE: "state",

  CONTINUOUS: { /* existing */ },
  DEBOUNCE: { /* existing */ },
  WORKER_POOL: { /* existing */ },

  // ADD THIS
  TASK: {
    EVENT_COUNT: "task:eventCount",
    EXECUTE_COUNT: "task:execCount",
    CREATED_AT: "task:createdAt",
    SCHEDULED_AT: "task:scheduledAt",
  },

  IDEMPOTENCY: "idem:",
  RETRY: { /* existing */ },
} as const;
```

### 3.4 Update Metadata Type

**File**: `packages/jobs/src/services/metadata.ts`

```ts
export type JobType = "continuous" | "debounce" | "workerPool" | "task";  // ADD task
```

### Phase 3 Validation

Test that task definitions are properly registered:

```ts
import { createTypedJobRegistry, toRuntimeRegistry } from "../src/registry";
import { Task } from "../src/definitions";
import { Schema, Effect } from "effect";

const taskDef = Task.make({
  stateSchema: Schema.Struct({ value: Schema.Number }),
  eventSchema: Schema.Struct({ _tag: Schema.Literal("Increment") }),
  onEvent: (ctx) => Effect.void,
  execute: (ctx) => Effect.void,
});

const registry = createTypedJobRegistry({ myTask: taskDef });

// Type check: registry.task.myTask should exist
registry.task.myTask.name satisfies "myTask";

// Runtime check
const runtime = toRuntimeRegistry(registry);
console.assert(runtime.task.myTask !== undefined);
```

---

## Phase 4: Request/Response Types

**Goal**: Define wire protocol types for Task operations.

### 4.1 Add Task Request Type

**File**: `packages/jobs/src/runtime/types.ts`

```ts
/**
 * Task job request.
 */
export interface TaskRequest {
  readonly type: "task";
  readonly action: "send" | "trigger" | "clear" | "status" | "getState";
  readonly name: string;
  readonly id: string;
  readonly event?: unknown;
}
```

### 4.2 Update JobRequest Union

**File**: `packages/jobs/src/runtime/types.ts`

```ts
export type JobRequest =
  | ContinuousRequest
  | DebounceRequest
  | WorkerPoolRequest
  | TaskRequest;  // ADD THIS
```

### 4.3 Add Task Response Types

**File**: `packages/jobs/src/runtime/types.ts`

```ts
// -----------------------------------------------------------------------------
// Task Responses
// -----------------------------------------------------------------------------

export interface TaskSendResponse {
  readonly _type: "task.send";
  readonly instanceId: string;
  readonly created: boolean;
  readonly scheduledAt: number | null;
}

export interface TaskTriggerResponse {
  readonly _type: "task.trigger";
  readonly instanceId: string;
  readonly triggered: boolean;
}

export interface TaskClearResponse {
  readonly _type: "task.clear";
  readonly instanceId: string;
  readonly cleared: boolean;
}

export interface TaskStatusResponse {
  readonly _type: "task.status";
  readonly status: "active" | "idle" | "not_found";
  readonly scheduledAt: number | null;
  readonly createdAt: number | undefined;
  readonly eventCount: number | undefined;
  readonly executeCount: number | undefined;
}

export interface TaskGetStateResponse {
  readonly _type: "task.getState";
  readonly instanceId: string;
  readonly state: unknown | null | undefined;
  readonly scheduledAt: number | null;
  readonly createdAt: number | undefined;
}
```

### 4.4 Update JobResponse Union

**File**: `packages/jobs/src/runtime/types.ts`

```ts
export type JobResponse =
  | ContinuousStartResponse
  // ... existing ...
  | TaskSendResponse       // ADD
  | TaskTriggerResponse    // ADD
  | TaskClearResponse      // ADD
  | TaskStatusResponse     // ADD
  | TaskGetStateResponse;  // ADD
```

---

## Phase 5: Context Factory

**Goal**: Create context factories for Task handlers, following the ContinuousContext pattern.

### 5.1 Create Task Context Module

**File**: `packages/jobs/src/handlers/task/context.ts`

```ts
// packages/jobs/src/handlers/task/context.ts

import { Effect, Duration } from "effect";
import type {
  TaskEventContext,
  TaskExecuteContext,
  TaskIdleContext,
  TaskErrorContext,
} from "../../registry/types";
import { ClearSignal } from "../../errors";

// =============================================================================
// State Holder
// =============================================================================

/**
 * State holder for mutable state updates during execution.
 */
export interface TaskStateHolder<S> {
  current: S | null;
  dirty: boolean;
}

// =============================================================================
// Scheduling Holder
// =============================================================================

/**
 * Scheduling holder for tracking schedule operations during execution.
 */
export interface TaskScheduleHolder {
  scheduledAt: number | null;
  cancelled: boolean;
  dirty: boolean;
}

// =============================================================================
// Effect Factories
// =============================================================================

/**
 * Create the common scheduling effects.
 * Shared between onEvent and execute contexts.
 */
function createSchedulingEffects(
  scheduleHolder: TaskScheduleHolder,
  getScheduledFromStorage: () => Effect.Effect<number | null, never, never>,
) {
  return {
    schedule: (when: Duration.DurationInput | number | Date): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        let timestamp: number;
        if (when instanceof Date) {
          timestamp = when.getTime();
        } else if (typeof when === "number") {
          timestamp = when;
        } else {
          timestamp = Date.now() + Duration.toMillis(Duration.decode(when));
        }
        scheduleHolder.scheduledAt = timestamp;
        scheduleHolder.cancelled = false;
        scheduleHolder.dirty = true;
      }),

    cancelSchedule: (): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        scheduleHolder.scheduledAt = null;
        scheduleHolder.cancelled = true;
        scheduleHolder.dirty = true;
      }),

    getScheduledTime: (): Effect.Effect<number | null, never, never> =>
      scheduleHolder.dirty
        ? Effect.succeed(scheduleHolder.scheduledAt)
        : getScheduledFromStorage(),
  };
}

// =============================================================================
// Context Factories
// =============================================================================

/**
 * Create TaskEventContext for onEvent handler.
 */
export function createTaskEventContext<S, E>(
  stateHolder: TaskStateHolder<S>,
  scheduleHolder: TaskScheduleHolder,
  event: E,
  instanceId: string,
  jobName: string,
  executionStartedAt: number,
  getEventCount: () => Effect.Effect<number, never, never>,
  getCreatedAt: () => Effect.Effect<number, never, never>,
  getScheduledFromStorage: () => Effect.Effect<number | null, never, never>,
): TaskEventContext<S, E> {
  const scheduling = createSchedulingEffects(scheduleHolder, getScheduledFromStorage);

  return {
    // Event access
    event,

    // State access (synchronous - already loaded)
    get state() {
      return stateHolder.current;
    },

    // State mutations
    setState: (state: S): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        stateHolder.current = state;
        stateHolder.dirty = true;
      }),

    updateState: (fn: (current: S) => S): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        if (stateHolder.current !== null) {
          stateHolder.current = fn(stateHolder.current);
          stateHolder.dirty = true;
        }
      }),

    // Scheduling
    ...scheduling,

    // Cleanup
    clear: (): Effect.Effect<never, never, never> =>
      Effect.fail(new ClearSignal()) as Effect.Effect<never, never, never>,

    // Metadata
    instanceId,
    jobName,
    executionStartedAt,
    isFirstEvent: stateHolder.current === null,

    // Metadata (Effects)
    eventCount: getEventCount(),
    createdAt: getCreatedAt(),
  };
}

/**
 * Create TaskExecuteContext for execute handler.
 */
export function createTaskExecuteContext<S>(
  stateHolder: TaskStateHolder<S>,
  scheduleHolder: TaskScheduleHolder,
  instanceId: string,
  jobName: string,
  executionStartedAt: number,
  getState: () => Effect.Effect<S | null, never, never>,
  getEventCount: () => Effect.Effect<number, never, never>,
  getCreatedAt: () => Effect.Effect<number, never, never>,
  getExecuteCount: () => Effect.Effect<number, never, never>,
  getScheduledFromStorage: () => Effect.Effect<number | null, never, never>,
): TaskExecuteContext<S> {
  const scheduling = createSchedulingEffects(scheduleHolder, getScheduledFromStorage);

  return {
    // State access (Effect - loaded on demand, but uses holder if dirty)
    state: stateHolder.dirty
      ? Effect.succeed(stateHolder.current)
      : getState(),

    // State mutations
    setState: (state: S): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        stateHolder.current = state;
        stateHolder.dirty = true;
      }),

    updateState: (fn: (current: S) => S): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const current = stateHolder.dirty
          ? stateHolder.current
          : yield* getState();
        if (current !== null) {
          stateHolder.current = fn(current);
          stateHolder.dirty = true;
        }
      }),

    // Scheduling
    ...scheduling,

    // Cleanup
    clear: (): Effect.Effect<never, never, never> =>
      Effect.fail(new ClearSignal()) as Effect.Effect<never, never, never>,

    // Metadata
    instanceId,
    jobName,
    executionStartedAt,

    // Metadata (Effects)
    eventCount: getEventCount(),
    createdAt: getCreatedAt(),
    executeCount: getExecuteCount(),
  };
}

/**
 * Create TaskIdleContext for onIdle handler.
 */
export function createTaskIdleContext<S>(
  stateHolder: TaskStateHolder<S>,
  scheduleHolder: TaskScheduleHolder,
  instanceId: string,
  jobName: string,
  idleReason: "onEvent" | "execute",
  getState: () => Effect.Effect<S | null, never, never>,
  getScheduledFromStorage: () => Effect.Effect<number | null, never, never>,
): TaskIdleContext<S> {
  const scheduling = createSchedulingEffects(scheduleHolder, getScheduledFromStorage);

  return {
    state: stateHolder.dirty
      ? Effect.succeed(stateHolder.current)
      : getState(),

    schedule: scheduling.schedule,

    clear: (): Effect.Effect<never, never, never> =>
      Effect.fail(new ClearSignal()) as Effect.Effect<never, never, never>,

    instanceId,
    jobName,
    idleReason,
  };
}

/**
 * Create TaskErrorContext for onError handler.
 */
export function createTaskErrorContext<S>(
  stateHolder: TaskStateHolder<S>,
  scheduleHolder: TaskScheduleHolder,
  instanceId: string,
  jobName: string,
  errorSource: "onEvent" | "execute",
  getState: () => Effect.Effect<S | null, never, never>,
  getScheduledFromStorage: () => Effect.Effect<number | null, never, never>,
): TaskErrorContext<S> {
  const scheduling = createSchedulingEffects(scheduleHolder, getScheduledFromStorage);

  return {
    state: stateHolder.dirty
      ? Effect.succeed(stateHolder.current)
      : getState(),

    updateState: (fn: (current: S) => S): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const current = stateHolder.dirty
          ? stateHolder.current
          : yield* getState();
        if (current !== null) {
          stateHolder.current = fn(current);
          stateHolder.dirty = true;
        }
      }),

    schedule: scheduling.schedule,

    clear: (): Effect.Effect<never, never, never> =>
      Effect.fail(new ClearSignal()) as Effect.Effect<never, never, never>,

    instanceId,
    jobName,
    errorSource,
  };
}
```

### 5.2 Add ClearSignal Error

**File**: `packages/jobs/src/errors.ts`

```ts
import { Data } from "effect";

// Add to existing errors

/**
 * Signal that the task should clear all state and terminate.
 * Internal use only - caught by handler.
 */
export class ClearSignal extends Data.TaggedError("ClearSignal")<{}> {}
```

---

## Phase 6: Handler Implementation

**Goal**: Implement the TaskHandler with full lifecycle management.

### 6.1 Create Task Handler Types

**File**: `packages/jobs/src/handlers/task/types.ts`

```ts
// packages/jobs/src/handlers/task/types.ts

import type { Effect } from "effect";
import type { TaskRequest } from "../../runtime/types";
import type {
  TaskSendResponse,
  TaskTriggerResponse,
  TaskClearResponse,
  TaskStatusResponse,
  TaskGetStateResponse,
} from "../../runtime/types";
import type { JobError } from "../../errors";

export type TaskResponse =
  | TaskSendResponse
  | TaskTriggerResponse
  | TaskClearResponse
  | TaskStatusResponse
  | TaskGetStateResponse;

export interface TaskHandlerI {
  handle(request: TaskRequest): Effect.Effect<TaskResponse, JobError>;
  handleAlarm(): Effect.Effect<void, JobError>;
}
```

### 6.2 Create Task Handler Implementation

**File**: `packages/jobs/src/handlers/task/handler.ts`

This is a large file. Here's the structure:

```ts
// packages/jobs/src/handlers/task/handler.ts

import { Context, Effect, Layer, Schema } from "effect";
import {
  RuntimeAdapter,
  StorageAdapter,
  type StorageError,
  type SchedulerError,
} from "@durable-effect/core";
import { MetadataService } from "../../services/metadata";
import { AlarmService } from "../../services/alarm";
import { createEntityStateService, type EntityStateServiceI } from "../../services/entity-state";
import { RegistryService } from "../../services/registry";
import { KEYS } from "../../storage-keys";
import {
  JobNotFoundError,
  ExecutionError,
  ClearSignal,
  type JobError,
} from "../../errors";
import type { TaskRequest } from "../../runtime/types";
import type { StoredTaskDefinition } from "../../registry/types";
import type { TaskHandlerI, TaskResponse } from "./types";
import {
  createTaskEventContext,
  createTaskExecuteContext,
  createTaskIdleContext,
  createTaskErrorContext,
  type TaskStateHolder,
  type TaskScheduleHolder,
} from "./context";

// =============================================================================
// Service Tag
// =============================================================================

export class TaskHandler extends Context.Tag(
  "@durable-effect/jobs/TaskHandler"
)<TaskHandler, TaskHandlerI>() {}

// =============================================================================
// Layer Implementation
// =============================================================================

type HandlerError = JobError | StorageError | SchedulerError;

export const TaskHandlerLayer = Layer.effect(
  TaskHandler,
  Effect.gen(function* () {
    const registryService = yield* RegistryService;
    const metadata = yield* MetadataService;
    const alarm = yield* AlarmService;
    const runtime = yield* RuntimeAdapter;
    const storage = yield* StorageAdapter;

    // -------------------------------------------------------------------------
    // Helper: Provide storage to effects
    // -------------------------------------------------------------------------
    const withStorage = <A, E>(
      effect: Effect.Effect<A, E, StorageAdapter>
    ): Effect.Effect<A, E> =>
      Effect.provideService(effect, StorageAdapter, storage);

    // -------------------------------------------------------------------------
    // Helper: Get definition from registry
    // -------------------------------------------------------------------------
    const getDefinition = (
      name: string
    ): Effect.Effect<StoredTaskDefinition<any, any, any>, JobNotFoundError> => {
      const def = registryService.registry.task[name];
      if (!def) {
        return Effect.fail(new JobNotFoundError({ type: "task", name }));
      }
      return Effect.succeed(def);
    };

    // -------------------------------------------------------------------------
    // Storage Helpers
    // -------------------------------------------------------------------------
    const getEventCount = (): Effect.Effect<number, StorageError> =>
      storage.get<number>(KEYS.TASK.EVENT_COUNT).pipe(Effect.map((n) => n ?? 0));

    const incrementEventCount = (): Effect.Effect<number, StorageError> =>
      Effect.gen(function* () {
        const current = yield* getEventCount();
        const next = current + 1;
        yield* storage.put(KEYS.TASK.EVENT_COUNT, next);
        return next;
      });

    const getExecuteCount = (): Effect.Effect<number, StorageError> =>
      storage.get<number>(KEYS.TASK.EXECUTE_COUNT).pipe(Effect.map((n) => n ?? 0));

    const incrementExecuteCount = (): Effect.Effect<number, StorageError> =>
      Effect.gen(function* () {
        const current = yield* getExecuteCount();
        const next = current + 1;
        yield* storage.put(KEYS.TASK.EXECUTE_COUNT, next);
        return next;
      });

    const getCreatedAt = (): Effect.Effect<number | undefined, StorageError> =>
      storage.get<number>(KEYS.TASK.CREATED_AT);

    const setCreatedAt = (timestamp: number): Effect.Effect<void, StorageError> =>
      storage.put(KEYS.TASK.CREATED_AT, timestamp);

    const getScheduledAt = (): Effect.Effect<number | null, StorageError> =>
      storage.get<number>(KEYS.TASK.SCHEDULED_AT).pipe(
        Effect.map((t) => t ?? null)
      );

    const setScheduledAt = (timestamp: number | null): Effect.Effect<void, StorageError> =>
      timestamp === null
        ? storage.delete(KEYS.TASK.SCHEDULED_AT).pipe(Effect.asVoid)
        : storage.put(KEYS.TASK.SCHEDULED_AT, timestamp);

    // -------------------------------------------------------------------------
    // Purge: Clear all storage and cancel alarm
    // -------------------------------------------------------------------------
    const purge = (): Effect.Effect<void, StorageError | SchedulerError> =>
      Effect.gen(function* () {
        yield* alarm.cancel();
        yield* storage.deleteAll();
      });

    // -------------------------------------------------------------------------
    // Apply schedule holder changes
    // -------------------------------------------------------------------------
    const applyScheduleChanges = (
      holder: TaskScheduleHolder
    ): Effect.Effect<void, StorageError | SchedulerError> =>
      Effect.gen(function* () {
        if (!holder.dirty) return;

        if (holder.cancelled) {
          yield* alarm.cancel();
          yield* setScheduledAt(null);
        } else if (holder.scheduledAt !== null) {
          yield* alarm.scheduleAt(holder.scheduledAt);
          yield* setScheduledAt(holder.scheduledAt);
        }
      });

    // -------------------------------------------------------------------------
    // Run onIdle if no alarm scheduled
    // -------------------------------------------------------------------------
    const maybeRunOnIdle = <S>(
      def: StoredTaskDefinition<S, any, any>,
      stateHolder: TaskStateHolder<S>,
      scheduleHolder: TaskScheduleHolder,
      idleReason: "onEvent" | "execute",
      getState: () => Effect.Effect<S | null, never, never>,
    ): Effect.Effect<void, HandlerError | ClearSignal> =>
      Effect.gen(function* () {
        if (!def.onIdle) return;

        // Check if alarm is scheduled
        const scheduled = scheduleHolder.dirty
          ? scheduleHolder.scheduledAt
          : yield* getScheduledAt();

        if (scheduled !== null) return; // Not idle

        const ctx = createTaskIdleContext(
          stateHolder,
          scheduleHolder,
          runtime.instanceId,
          def.name,
          idleReason,
          getState,
          () => getScheduledAt().pipe(Effect.catchAll(() => Effect.succeed(null))),
        );

        yield* Effect.try({
          try: () => def.onIdle!(ctx),
          catch: (e) =>
            new ExecutionError({
              jobType: "task",
              jobName: def.name,
              instanceId: runtime.instanceId,
              cause: e,
            }),
        }).pipe(Effect.flatten);
      });

    // -------------------------------------------------------------------------
    // Handle: send
    // -------------------------------------------------------------------------
    const handleSend = (
      def: StoredTaskDefinition<any, any, any>,
      request: TaskRequest
    ): Effect.Effect<TaskResponse, HandlerError | ClearSignal> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        const created = !meta;
        const now = yield* runtime.now();

        // Initialize if new
        if (created) {
          yield* metadata.initialize("task", request.name);
          yield* metadata.updateStatus("running");
          yield* setCreatedAt(now);
          yield* storage.put(KEYS.TASK.EVENT_COUNT, 0);
          yield* storage.put(KEYS.TASK.EXECUTE_COUNT, 0);
        }

        // Increment event count
        yield* incrementEventCount();

        // Get state service and load current state
        const stateService = yield* withStorage(createEntityStateService(def.stateSchema));
        const currentState = yield* stateService.get();

        // Decode event
        const decodeEvent = Schema.decodeUnknown(def.eventSchema);
        const validatedEvent = yield* decodeEvent(request.event).pipe(
          Effect.mapError((e) =>
            new ExecutionError({
              jobType: "task",
              jobName: def.name,
              instanceId: runtime.instanceId,
              cause: e,
            })
          )
        );

        // Create holders
        const stateHolder: TaskStateHolder<any> = {
          current: currentState,
          dirty: false,
        };

        const scheduleHolder: TaskScheduleHolder = {
          scheduledAt: null,
          cancelled: false,
          dirty: false,
        };

        // Create context
        const ctx = createTaskEventContext(
          stateHolder,
          scheduleHolder,
          validatedEvent,
          runtime.instanceId,
          def.name,
          now,
          () => getEventCount().pipe(Effect.catchAll(() => Effect.succeed(0))),
          () => getCreatedAt().pipe(Effect.map((t) => t ?? now), Effect.catchAll(() => Effect.succeed(now))),
          () => getScheduledAt().pipe(Effect.catchAll(() => Effect.succeed(null))),
        );

        // Run onEvent
        const getState = () =>
          stateHolder.dirty
            ? Effect.succeed(stateHolder.current)
            : stateService.get().pipe(Effect.catchAll(() => Effect.succeed(null)));

        yield* Effect.try({
          try: () => def.onEvent(ctx),
          catch: (e) =>
            new ExecutionError({
              jobType: "task",
              jobName: def.name,
              instanceId: runtime.instanceId,
              cause: e,
            }),
        }).pipe(
          Effect.flatten,
          Effect.catchAll((error): Effect.Effect<void, HandlerError | ClearSignal> => {
            // Let ClearSignal propagate
            if (error instanceof ClearSignal) {
              return Effect.fail(error);
            }

            // Call onError if provided
            if (def.onError) {
              const errorCtx = createTaskErrorContext(
                stateHolder,
                scheduleHolder,
                runtime.instanceId,
                def.name,
                "onEvent",
                getState,
                () => getScheduledAt().pipe(Effect.catchAll(() => Effect.succeed(null))),
              );
              return Effect.try({
                try: () => def.onError!(error, errorCtx),
                catch: () => Effect.void,
              }).pipe(Effect.flatten, Effect.asVoid);
            }

            // Re-throw wrapped error
            return Effect.fail(
              error instanceof ExecutionError
                ? error
                : new ExecutionError({
                    jobType: "task",
                    jobName: def.name,
                    instanceId: runtime.instanceId,
                    cause: error,
                  })
            );
          })
        );

        // Persist state if dirty
        if (stateHolder.dirty && stateHolder.current !== null) {
          yield* stateService.set(stateHolder.current);
        }

        // Apply schedule changes
        yield* applyScheduleChanges(scheduleHolder);

        // Maybe run onIdle
        yield* maybeRunOnIdle(def, stateHolder, scheduleHolder, "onEvent", getState);

        // Re-apply schedule changes after onIdle
        yield* applyScheduleChanges(scheduleHolder);

        // Persist state again if onIdle modified it
        if (stateHolder.dirty && stateHolder.current !== null) {
          yield* stateService.set(stateHolder.current);
        }

        // Get final scheduled time
        const scheduledAt = scheduleHolder.dirty
          ? scheduleHolder.scheduledAt
          : yield* getScheduledAt();

        return {
          _type: "task.send" as const,
          instanceId: runtime.instanceId,
          created,
          scheduledAt,
        };
      });

    // -------------------------------------------------------------------------
    // Handle: trigger (manual execution)
    // -------------------------------------------------------------------------
    const handleTrigger = (
      def: StoredTaskDefinition<any, any, any>
    ): Effect.Effect<TaskResponse, HandlerError | ClearSignal> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "task.trigger" as const,
            instanceId: runtime.instanceId,
            triggered: false,
          };
        }

        yield* runExecute(def);

        return {
          _type: "task.trigger" as const,
          instanceId: runtime.instanceId,
          triggered: true,
        };
      });

    // -------------------------------------------------------------------------
    // Handle: clear
    // -------------------------------------------------------------------------
    const handleClear = (): Effect.Effect<TaskResponse, HandlerError> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "task.clear" as const,
            instanceId: runtime.instanceId,
            cleared: false,
          };
        }

        yield* purge();

        return {
          _type: "task.clear" as const,
          instanceId: runtime.instanceId,
          cleared: true,
        };
      });

    // -------------------------------------------------------------------------
    // Handle: status
    // -------------------------------------------------------------------------
    const handleStatus = (): Effect.Effect<TaskResponse, HandlerError> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "task.status" as const,
            status: "not_found" as const,
            scheduledAt: null,
            createdAt: undefined,
            eventCount: undefined,
            executeCount: undefined,
          };
        }

        const scheduledAt = yield* getScheduledAt();
        const createdAt = yield* getCreatedAt();
        const eventCount = yield* getEventCount();
        const executeCount = yield* getExecuteCount();

        return {
          _type: "task.status" as const,
          status: scheduledAt !== null ? "active" : "idle",
          scheduledAt,
          createdAt,
          eventCount,
          executeCount,
        };
      });

    // -------------------------------------------------------------------------
    // Handle: getState
    // -------------------------------------------------------------------------
    const handleGetState = (
      def: StoredTaskDefinition<any, any, any>
    ): Effect.Effect<TaskResponse, HandlerError> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "task.getState" as const,
            instanceId: runtime.instanceId,
            state: undefined,
            scheduledAt: null,
            createdAt: undefined,
          };
        }

        const stateService = yield* withStorage(createEntityStateService(def.stateSchema));
        const state = yield* stateService.get();
        const scheduledAt = yield* getScheduledAt();
        const createdAt = yield* getCreatedAt();

        return {
          _type: "task.getState" as const,
          instanceId: runtime.instanceId,
          state,
          scheduledAt,
          createdAt,
        };
      });

    // -------------------------------------------------------------------------
    // Run execute (shared by trigger and alarm)
    // -------------------------------------------------------------------------
    const runExecute = (
      def: StoredTaskDefinition<any, any, any>
    ): Effect.Effect<void, HandlerError | ClearSignal> =>
      Effect.gen(function* () {
        const now = yield* runtime.now();

        // Increment execute count
        yield* incrementExecuteCount();

        // Get state service
        const stateService = yield* withStorage(createEntityStateService(def.stateSchema));

        // Create holders
        const stateHolder: TaskStateHolder<any> = {
          current: null,
          dirty: false,
        };

        const scheduleHolder: TaskScheduleHolder = {
          scheduledAt: null,
          cancelled: false,
          dirty: false,
        };

        // Create context
        const getState = () =>
          stateHolder.dirty
            ? Effect.succeed(stateHolder.current)
            : stateService.get().pipe(Effect.catchAll(() => Effect.succeed(null)));

        const ctx = createTaskExecuteContext(
          stateHolder,
          scheduleHolder,
          runtime.instanceId,
          def.name,
          now,
          getState,
          () => getEventCount().pipe(Effect.catchAll(() => Effect.succeed(0))),
          () => getCreatedAt().pipe(Effect.map((t) => t ?? now), Effect.catchAll(() => Effect.succeed(now))),
          () => getExecuteCount().pipe(Effect.catchAll(() => Effect.succeed(0))),
          () => getScheduledAt().pipe(Effect.catchAll(() => Effect.succeed(null))),
        );

        // Run execute
        yield* Effect.try({
          try: () => def.execute(ctx),
          catch: (e) =>
            new ExecutionError({
              jobType: "task",
              jobName: def.name,
              instanceId: runtime.instanceId,
              cause: e,
            }),
        }).pipe(
          Effect.flatten,
          Effect.catchAll((error): Effect.Effect<void, HandlerError | ClearSignal> => {
            // Let ClearSignal propagate
            if (error instanceof ClearSignal) {
              return Effect.fail(error);
            }

            // Call onError if provided
            if (def.onError) {
              const errorCtx = createTaskErrorContext(
                stateHolder,
                scheduleHolder,
                runtime.instanceId,
                def.name,
                "execute",
                getState,
                () => getScheduledAt().pipe(Effect.catchAll(() => Effect.succeed(null))),
              );
              return Effect.try({
                try: () => def.onError!(error, errorCtx),
                catch: () => Effect.void,
              }).pipe(Effect.flatten, Effect.asVoid);
            }

            // Re-throw wrapped error
            return Effect.fail(
              error instanceof ExecutionError
                ? error
                : new ExecutionError({
                    jobType: "task",
                    jobName: def.name,
                    instanceId: runtime.instanceId,
                    cause: error,
                  })
            );
          })
        );

        // Persist state if dirty
        if (stateHolder.dirty && stateHolder.current !== null) {
          yield* stateService.set(stateHolder.current);
        }

        // Apply schedule changes
        yield* applyScheduleChanges(scheduleHolder);

        // Maybe run onIdle
        yield* maybeRunOnIdle(def, stateHolder, scheduleHolder, "execute", getState);

        // Re-apply schedule changes after onIdle
        yield* applyScheduleChanges(scheduleHolder);

        // Persist state again if onIdle modified it
        if (stateHolder.dirty && stateHolder.current !== null) {
          yield* stateService.set(stateHolder.current);
        }
      });

    // -------------------------------------------------------------------------
    // Return handler interface
    // -------------------------------------------------------------------------
    return {
      handle: (request: TaskRequest): Effect.Effect<TaskResponse, JobError> =>
        Effect.gen(function* () {
          const def = yield* getDefinition(request.name);

          switch (request.action) {
            case "send":
              return yield* handleSend(def, request).pipe(
                Effect.catchTag("ClearSignal", () =>
                  Effect.gen(function* () {
                    yield* purge();
                    return {
                      _type: "task.send" as const,
                      instanceId: runtime.instanceId,
                      created: false,
                      scheduledAt: null,
                    };
                  })
                )
              );

            case "trigger":
              return yield* handleTrigger(def).pipe(
                Effect.catchTag("ClearSignal", () =>
                  Effect.gen(function* () {
                    yield* purge();
                    return {
                      _type: "task.trigger" as const,
                      instanceId: runtime.instanceId,
                      triggered: true,
                    };
                  })
                )
              );

            case "clear":
              return yield* handleClear();

            case "status":
              return yield* handleStatus();

            case "getState":
              return yield* handleGetState(def);
          }
        }).pipe(
          Effect.catchTag("StorageError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "task",
                jobName: request.name,
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          ),
          Effect.catchTag("SchedulerError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "task",
                jobName: request.name,
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          )
        ),

      handleAlarm: (): Effect.Effect<void, JobError> =>
        Effect.gen(function* () {
          const meta = yield* metadata.get();
          if (!meta || meta.type !== "task") {
            return;
          }

          const def = yield* getDefinition(meta.name);

          yield* runExecute(def).pipe(
            Effect.catchTag("ClearSignal", () =>
              purge().pipe(Effect.catchAll(() => Effect.void))
            )
          );
        }).pipe(
          Effect.catchTag("StorageError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "task",
                jobName: "unknown",
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          ),
          Effect.catchTag("SchedulerError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "task",
                jobName: "unknown",
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          )
        ),
    };
  })
);
```

### 6.3 Create Handler Index

**File**: `packages/jobs/src/handlers/task/index.ts`

```ts
export { TaskHandler, TaskHandlerLayer } from "./handler";
export type { TaskHandlerI, TaskResponse } from "./types";
```

### 6.4 Update Handlers Index

**File**: `packages/jobs/src/handlers/index.ts`

```ts
export { ContinuousHandler, ContinuousHandlerLayer } from "./continuous";
export { DebounceHandler, DebounceHandlerLayer } from "./debounce";
export { TaskHandler, TaskHandlerLayer } from "./task";  // ADD THIS
export { RetryExecutor, RetryExecutorLayer } from "../retry";

import { Layer } from "effect";
import { ContinuousHandlerLayer } from "./continuous";
import { DebounceHandlerLayer } from "./debounce";
import { TaskHandlerLayer } from "./task";  // ADD THIS

export const JobHandlersLayer = Layer.mergeAll(
  ContinuousHandlerLayer,
  DebounceHandlerLayer,
  TaskHandlerLayer,  // ADD THIS
);
```

---

## Phase 7: Dispatcher Integration

**Goal**: Wire TaskHandler into the dispatcher for request routing.

### 7.1 Update Dispatcher

**File**: `packages/jobs/src/runtime/dispatcher.ts`

```ts
import { TaskHandler } from "../handlers/task";  // ADD THIS

export const DispatcherLayer = Layer.effect(
  Dispatcher,
  Effect.gen(function* () {
    const metadata = yield* MetadataService;
    const continuous = yield* ContinuousHandler;
    const debounce = yield* DebounceHandler;
    const task = yield* TaskHandler;  // ADD THIS

    return {
      handle: (request: JobRequest) =>
        Effect.gen(function* () {
          switch (request.type) {
            case "continuous":
              return yield* continuous.handle(request);

            case "debounce":
              return yield* debounce.handle(request);

            case "task":  // ADD THIS
              return yield* task.handle(request);

            case "workerPool":
              return yield* Effect.fail(
                new UnknownJobTypeError({
                  type: `workerPool (handler not implemented)`,
                })
              );

            default:
              const _exhaustive: never = request;
              return yield* Effect.fail(
                new UnknownJobTypeError({
                  type: (request as JobRequest).type,
                })
              );
          }
        }),

      handleAlarm: () =>
        Effect.gen(function* () {
          const meta = yield* metadata.get();
          if (!meta) return;

          switch (meta.type) {
            case "continuous":
              yield* continuous.handleAlarm();
              break;

            case "debounce":
              yield* debounce.handleAlarm();
              break;

            case "task":  // ADD THIS
              yield* task.handleAlarm();
              break;

            case "workerPool":
              yield* Effect.logInfo(
                `Alarm for workerPool/${meta.name} (handler not implemented)`
              );
              break;

            default:
              yield* Effect.logWarning(
                `Unknown job type in alarm: ${meta.type}`
              );
          }
        }),
    };
  })
);
```

---

## Phase 8: Client Implementation

**Goal**: Implement type-safe client for Task operations.

### 8.1 Add Client Types

**File**: `packages/jobs/src/client/types.ts`

```ts
// Add to existing imports
import type {
  TaskSendResponse,
  TaskTriggerResponse,
  TaskClearResponse,
  TaskStatusResponse,
  TaskGetStateResponse,
} from "../runtime/types";
import type { TaskKeysOf, TaskStateOf, TaskEventOf } from "../registry/typed";

// Add TaskClient interface
/**
 * Type-safe client for task jobs.
 */
export interface TaskClient<S, E> {
  /**
   * Send an event to a task instance.
   * Creates the instance if it doesn't exist.
   */
  send(options: {
    readonly id: string;
    readonly event: E;
  }): Effect.Effect<TaskSendResponse, ClientError>;

  /**
   * Manually trigger execution.
   */
  trigger(id: string): Effect.Effect<TaskTriggerResponse, ClientError>;

  /**
   * Clear task immediately (delete all state + cancel alarms).
   */
  clear(id: string): Effect.Effect<TaskClearResponse, ClientError>;

  /**
   * Get current status.
   */
  status(id: string): Effect.Effect<TaskStatusResponse, ClientError>;

  /**
   * Get current state.
   */
  getState(id: string): Effect.Effect<TaskGetStateResponse, ClientError>;
}

// Add to JobsClient interface
export interface JobsClient<R extends TypedJobRegistry<any>> {
  continuous<K extends ContinuousKeys<R>>(name: K): ContinuousClient<ContinuousStateType<R, K>>;
  debounce<K extends DebounceKeys<R>>(name: K): DebounceClient<DebounceEventType<R, K>, DebounceStateType<R, K>>;
  workerPool<K extends WorkerPoolKeys<R>>(name: K): WorkerPoolClient<WorkerPoolEventType<R, K>>;
  task<K extends TaskKeys<R>>(name: K): TaskClient<TaskStateType<R, K>, TaskEventType<R, K>>;  // ADD THIS
}

// Add type helpers
export type TaskKeys<R extends TypedJobRegistry<any>> =
  TaskKeysOf<DefinitionsOf<R>>;

export type TaskStateType<
  R extends TypedJobRegistry<any>,
  K extends TaskKeys<R>,
> = TaskStateOf<DefinitionsOf<R>, K>;

export type TaskEventType<
  R extends TypedJobRegistry<any>,
  K extends TaskKeys<R>,
> = TaskEventOf<DefinitionsOf<R>, K>;
```

### 8.2 Update Client Implementation

**File**: `packages/jobs/src/client/client.ts`

```ts
// Add to createJobsClient function:

task: (name: string) => {
  const client: TaskClient<unknown, unknown> = {
    send: ({ id, event }) => {
      const instanceId = createInstanceId("task", name, id);
      const stub = getStub(binding, instanceId);
      return narrowResponseEffect(
        stub.call({
          type: "task",
          action: "send",
          name,
          id,
          event,
        }),
        "task.send",
      );
    },

    trigger: (id) => {
      const instanceId = createInstanceId("task", name, id);
      const stub = getStub(binding, instanceId);
      return narrowResponseEffect(
        stub.call({
          type: "task",
          action: "trigger",
          name,
          id,
        }),
        "task.trigger",
      );
    },

    clear: (id) => {
      const instanceId = createInstanceId("task", name, id);
      const stub = getStub(binding, instanceId);
      return narrowResponseEffect(
        stub.call({
          type: "task",
          action: "clear",
          name,
          id,
        }),
        "task.clear",
      );
    },

    status: (id) => {
      const instanceId = createInstanceId("task", name, id);
      const stub = getStub(binding, instanceId);
      return narrowResponseEffect(
        stub.call({
          type: "task",
          action: "status",
          name,
          id,
        }),
        "task.status",
      );
    },

    getState: (id) => {
      const instanceId = createInstanceId("task", name, id);
      const stub = getStub(binding, instanceId);
      return narrowResponseEffect(
        stub.call({
          type: "task",
          action: "getState",
          name,
          id,
        }),
        "task.getState",
      );
    },
  };

  return client;
},
```

### 8.3 Update Response Narrowing

**File**: `packages/jobs/src/client/response.ts`

Ensure the narrowResponseEffect function handles Task response types.

---

## Phase 9: Testing

**Goal**: Comprehensive test coverage for all Task functionality.

### 9.1 Type Tests

**File**: `packages/jobs/test/task/types.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { Task } from "../../src/definitions";
import { createTypedJobRegistry } from "../../src/registry";
import { Schema, Effect, Duration } from "effect";

describe("Task Types", () => {
  it("should infer state and event types correctly", () => {
    const task = Task.make({
      stateSchema: Schema.Struct({
        count: Schema.Number,
        items: Schema.Array(Schema.String),
      }),
      eventSchema: Schema.Union(
        Schema.Struct({ _tag: Schema.Literal("Add"), item: Schema.String }),
        Schema.Struct({ _tag: Schema.Literal("Clear") }),
      ),
      onEvent: (ctx) =>
        Effect.gen(function* () {
          // Type assertion: ctx.event should be union type
          if (ctx.event._tag === "Add") {
            const item: string = ctx.event.item;
            expect(typeof item).toBe("string");
          }
          // Type assertion: ctx.state should be State | null
          if (ctx.state !== null) {
            const count: number = ctx.state.count;
            expect(typeof count).toBe("number");
          }
        }),
      execute: (ctx) =>
        Effect.gen(function* () {
          const state = yield* ctx.state;
          if (state !== null) {
            const items: string[] = state.items;
            expect(Array.isArray(items)).toBe(true);
          }
        }),
    });

    expect(task._tag).toBe("TaskDefinition");
  });

  it("should register in typed registry", () => {
    const task = Task.make({
      stateSchema: Schema.Struct({ value: Schema.Number }),
      eventSchema: Schema.Struct({ _tag: Schema.Literal("Set"), value: Schema.Number }),
      onEvent: () => Effect.void,
      execute: () => Effect.void,
    });

    const registry = createTypedJobRegistry({ myTask: task });

    expect(registry.task.myTask).toBeDefined();
    expect(registry.task.myTask.name).toBe("myTask");
    expect(registry.task.myTask._tag).toBe("TaskDefinition");
  });
});
```

### 9.2 Handler Unit Tests

**File**: `packages/jobs/test/task/handler.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Duration, Schema } from "effect";
import { Task } from "../../src/definitions";
import { createTypedJobRegistry, toRuntimeRegistry } from "../../src/registry";
import { createJobsRuntimeFromLayer } from "../../src/runtime/runtime";
import { createTestRuntime } from "@durable-effect/core/test";

describe("TaskHandler", () => {
  let runtime: ReturnType<typeof createJobsRuntimeFromLayer>;
  let handles: ReturnType<typeof createTestRuntime>["handles"];

  const counterTask = Task.make({
    stateSchema: Schema.Struct({
      count: Schema.Number,
      lastUpdated: Schema.Number,
    }),
    eventSchema: Schema.Union(
      Schema.Struct({ _tag: Schema.Literal("Increment") }),
      Schema.Struct({ _tag: Schema.Literal("Decrement") }),
      Schema.Struct({ _tag: Schema.Literal("Reset") }),
    ),
    onEvent: (ctx) =>
      Effect.gen(function* () {
        const now = Date.now();

        if (ctx.state === null) {
          yield* ctx.setState({ count: 0, lastUpdated: now });
        }

        switch (ctx.event._tag) {
          case "Increment":
            yield* ctx.updateState((s) => ({
              ...s,
              count: s.count + 1,
              lastUpdated: now,
            }));
            break;
          case "Decrement":
            yield* ctx.updateState((s) => ({
              ...s,
              count: s.count - 1,
              lastUpdated: now,
            }));
            break;
          case "Reset":
            yield* ctx.setState({ count: 0, lastUpdated: now });
            break;
        }

        yield* ctx.schedule(Duration.seconds(60));
      }),
    execute: (ctx) =>
      Effect.gen(function* () {
        const state = yield* ctx.state;
        if (state === null) return;

        if (state.count <= 0) {
          return yield* ctx.clear();
        }

        yield* ctx.schedule(Duration.seconds(60));
      }),
  });

  beforeEach(() => {
    const registry = createTypedJobRegistry({ counterTask });
    const runtimeRegistry = toRuntimeRegistry(registry);
    const { layer, handles: h } = createTestRuntime("test-instance", 1000000);
    handles = h;
    runtime = createJobsRuntimeFromLayer(layer, runtimeRegistry);
  });

  describe("send", () => {
    it("should create instance on first send", async () => {
      const response = await runtime.handle({
        type: "task",
        action: "send",
        name: "counterTask",
        id: "test-1",
        event: { _tag: "Increment" },
      });

      expect(response._type).toBe("task.send");
      if (response._type === "task.send") {
        expect(response.created).toBe(true);
        expect(response.scheduledAt).not.toBeNull();
      }
    });

    it("should not create on subsequent sends", async () => {
      await runtime.handle({
        type: "task",
        action: "send",
        name: "counterTask",
        id: "test-1",
        event: { _tag: "Increment" },
      });

      const response = await runtime.handle({
        type: "task",
        action: "send",
        name: "counterTask",
        id: "test-1",
        event: { _tag: "Increment" },
      });

      expect(response._type).toBe("task.send");
      if (response._type === "task.send") {
        expect(response.created).toBe(false);
      }
    });
  });

  describe("alarm (execute)", () => {
    it("should run execute on alarm", async () => {
      await runtime.handle({
        type: "task",
        action: "send",
        name: "counterTask",
        id: "test-1",
        event: { _tag: "Increment" },
      });

      // Fire alarm
      handles.scheduler.fire();
      await runtime.handleAlarm();

      // Check state
      const stateResponse = await runtime.handle({
        type: "task",
        action: "getState",
        name: "counterTask",
        id: "test-1",
      });

      expect(stateResponse._type).toBe("task.getState");
    });

    it("should clear on execute when count <= 0", async () => {
      // Send reset (sets count to 0)
      await runtime.handle({
        type: "task",
        action: "send",
        name: "counterTask",
        id: "test-1",
        event: { _tag: "Reset" },
      });

      // Fire alarm - should clear
      handles.scheduler.fire();
      await runtime.handleAlarm();

      // Check status - should be not_found
      const statusResponse = await runtime.handle({
        type: "task",
        action: "status",
        name: "counterTask",
        id: "test-1",
      });

      expect(statusResponse._type).toBe("task.status");
      if (statusResponse._type === "task.status") {
        expect(statusResponse.status).toBe("not_found");
      }
    });
  });

  describe("clear", () => {
    it("should clear existing task", async () => {
      await runtime.handle({
        type: "task",
        action: "send",
        name: "counterTask",
        id: "test-1",
        event: { _tag: "Increment" },
      });

      const clearResponse = await runtime.handle({
        type: "task",
        action: "clear",
        name: "counterTask",
        id: "test-1",
      });

      expect(clearResponse._type).toBe("task.clear");
      if (clearResponse._type === "task.clear") {
        expect(clearResponse.cleared).toBe(true);
      }

      // Verify cleared
      const statusResponse = await runtime.handle({
        type: "task",
        action: "status",
        name: "counterTask",
        id: "test-1",
      });

      if (statusResponse._type === "task.status") {
        expect(statusResponse.status).toBe("not_found");
      }
    });
  });

  describe("trigger", () => {
    it("should manually trigger execution", async () => {
      await runtime.handle({
        type: "task",
        action: "send",
        name: "counterTask",
        id: "test-1",
        event: { _tag: "Increment" },
      });

      const triggerResponse = await runtime.handle({
        type: "task",
        action: "trigger",
        name: "counterTask",
        id: "test-1",
      });

      expect(triggerResponse._type).toBe("task.trigger");
      if (triggerResponse._type === "task.trigger") {
        expect(triggerResponse.triggered).toBe(true);
      }
    });
  });
});
```

### 9.3 Integration Tests

**File**: `packages/jobs/test/task/integration.test.ts`

Test full lifecycle scenarios including complex state machines.

---

## Phase 10: Documentation & Examples

**Goal**: Complete documentation for Task primitive usage.

### 10.1 Update Package README

Add Task examples to `packages/jobs/README.md`.

### 10.2 Create Example Files

**File**: `packages/jobs/examples/task-reminder.ts`

```ts
import { Task } from "@durable-effect/jobs";
import { Schema, Effect, Duration } from "effect";

/**
 * Example: Reminder Task
 *
 * A user can schedule a reminder that fires at a specific time.
 * They can also cancel or reschedule before it fires.
 */
export const reminderTask = Task.make({
  stateSchema: Schema.Struct({
    userId: Schema.String,
    message: Schema.String,
    scheduledFor: Schema.Number,
    cancelled: Schema.Boolean,
  }),

  eventSchema: Schema.Union(
    Schema.Struct({
      _tag: Schema.Literal("Schedule"),
      userId: Schema.String,
      message: Schema.String,
      delayMinutes: Schema.Number,
    }),
    Schema.Struct({
      _tag: Schema.Literal("Cancel"),
    }),
    Schema.Struct({
      _tag: Schema.Literal("Reschedule"),
      delayMinutes: Schema.Number,
    }),
  ),

  onEvent: (ctx) =>
    Effect.gen(function* () {
      const event = ctx.event;

      switch (event._tag) {
        case "Schedule": {
          const scheduledFor = Date.now() + event.delayMinutes * 60 * 1000;
          yield* ctx.setState({
            userId: event.userId,
            message: event.message,
            scheduledFor,
            cancelled: false,
          });
          yield* ctx.schedule(scheduledFor);
          break;
        }

        case "Cancel": {
          if (ctx.state === null) return;
          yield* ctx.updateState((s) => ({ ...s, cancelled: true }));
          yield* ctx.cancelSchedule();
          yield* ctx.schedule(Duration.hours(1)); // Cleanup later
          break;
        }

        case "Reschedule": {
          if (ctx.state === null) return;
          const newTime = Date.now() + event.delayMinutes * 60 * 1000;
          yield* ctx.updateState((s) => ({
            ...s,
            scheduledFor: newTime,
            cancelled: false,
          }));
          yield* ctx.schedule(newTime);
          break;
        }
      }
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      if (state === null) return;

      if (state.cancelled) {
        return yield* ctx.clear();
      }

      // Send the reminder
      yield* Effect.log(`Sending reminder to ${state.userId}: ${state.message}`);

      // Done - clear
      return yield* ctx.clear();
    }),
});
```

---

## Summary: Phase Dependencies

```
Phase 1: Type Foundations
    ↓
Phase 2: Definition Factory
    ↓
Phase 3: Registry Integration
    ↓
Phase 4: Request/Response Types
    ↓
Phase 5: Context Factory
    ↓
Phase 6: Handler Implementation
    ↓
Phase 7: Dispatcher Integration
    ↓
Phase 8: Client Implementation
    ↓
Phase 9: Testing
    ↓
Phase 10: Documentation
```

Each phase can be validated independently:
- Phases 1-4: Type checking (`pnpm typecheck`)
- Phases 5-8: Unit tests (`pnpm test`)
- Phase 9: Full test suite
- Phase 10: Documentation review

---

## Estimated File Changes

| Phase | Files Modified | Files Created |
|-------|---------------|---------------|
| 1 | 2 | 0 |
| 2 | 2 | 1 |
| 3 | 3 | 0 |
| 4 | 1 | 0 |
| 5 | 1 | 1 |
| 6 | 1 | 3 |
| 7 | 1 | 0 |
| 8 | 2 | 0 |
| 9 | 0 | 3 |
| 10 | 1 | 2 |

**Total**: ~14 files modified, ~10 files created

---

## Type Safety Guarantees

This implementation plan ensures:

1. **No typecasting in user code** - Task.make() infers all types
2. **Proper type narrowing** - Event union types work correctly in switch statements
3. **Schema validation** - State and events are validated at runtime boundaries
4. **Effect-native patterns** - All async operations are Effects
5. **Type-safe client** - Client methods enforce correct event types
6. **Minimal `any` usage** - Only at registry storage boundaries (following existing patterns)

The key insight is building the type chain from bottom-up:
`UnregisteredTaskDefinition` → `TaskKeysOf` → `TaskStateOf/TaskEventOf` → `TaskClient<S, E>`

Each step preserves type information, flowing from schema definitions to client usage.
