# Phase 1: Foundation - Core Types & Adapter Interfaces

## Overview

This phase establishes the foundational abstractions that enable runtime-agnostic workflow execution. We create the adapter interfaces (Storage, Scheduler, Runtime) and an in-memory implementation for testing all subsequent phases.

**Duration**: ~2-3 hours
**Dependencies**: None (first phase)
**Risk Level**: Low

---

## Goals

1. Define core error types used throughout the system
2. Create abstract adapter interfaces for storage, scheduling, and runtime
3. Implement an in-memory adapter for testing
4. Establish the project structure and conventions

---

## File Structure

```
packages/workflow/src/
├── index.ts                    # Public exports
├── errors.ts                   # Core error types
├── adapters/
│   ├── index.ts               # Adapter exports
│   ├── storage.ts             # StorageAdapter interface
│   ├── scheduler.ts           # SchedulerAdapter interface
│   ├── runtime.ts             # RuntimeAdapter interface + types
│   └── in-memory/
│       ├── index.ts           # In-memory adapter exports
│       ├── storage.ts         # In-memory storage implementation
│       ├── scheduler.ts       # In-memory scheduler implementation
│       └── runtime.ts         # In-memory runtime layer factory
└── test/
    └── adapters/
        ├── storage.test.ts    # Storage adapter tests
        ├── scheduler.test.ts  # Scheduler adapter tests
        └── runtime.test.ts    # Runtime integration tests
```

---

## Implementation Details

### 1. Error Types (`errors.ts`)

```typescript
// packages/workflow/src/errors.ts

import { Data } from "effect";

/**
 * Storage operation failed.
 */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: "get" | "put" | "delete" | "deleteAll" | "list";
  readonly key?: string;
  readonly cause: unknown;
}> {
  get message(): string {
    const keyPart = this.key ? ` for key "${this.key}"` : "";
    return `Storage ${this.operation}${keyPart} failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}

/**
 * Scheduler operation failed.
 */
export class SchedulerError extends Data.TaggedError("SchedulerError")<{
  readonly operation: "schedule" | "cancel" | "get";
  readonly cause: unknown;
}> {
  get message(): string {
    return `Scheduler ${this.operation} failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}

/**
 * Invalid state transition attempted.
 */
export class InvalidTransitionError extends Data.TaggedError("InvalidTransitionError")<{
  readonly fromStatus: string;
  readonly toTransition: string;
  readonly validTransitions: ReadonlyArray<string>;
}> {
  get message(): string {
    return `Cannot apply "${this.toTransition}" from status "${this.fromStatus}". Valid transitions: [${this.validTransitions.join(", ")}]`;
  }
}

/**
 * Recovery operation failed.
 */
export class RecoveryError extends Data.TaggedError("RecoveryError")<{
  readonly reason: "max_attempts_exceeded" | "execution_failed" | "invalid_state";
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly cause?: unknown;
}> {
  get message(): string {
    switch (this.reason) {
      case "max_attempts_exceeded":
        return `Recovery failed: max attempts (${this.maxAttempts}) exceeded after ${this.attempts} attempts`;
      case "execution_failed":
        return `Recovery execution failed: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
      case "invalid_state":
        return `Recovery failed: workflow is in an invalid state for recovery`;
    }
  }
}

/**
 * Orchestrator-level operation failed.
 */
export class OrchestratorError extends Data.TaggedError("OrchestratorError")<{
  readonly operation: "start" | "queue" | "alarm" | "cancel" | "execute";
  readonly cause: unknown;
}> {
  get message(): string {
    return `Orchestrator ${this.operation} failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}
```

### 2. Storage Adapter (`adapters/storage.ts`)

```typescript
// packages/workflow/src/adapters/storage.ts

import { Context, Effect } from "effect";
import type { StorageError } from "../errors";

/**
 * Abstract storage interface for workflow state persistence.
 *
 * Implementations provide runtime-specific storage:
 * - Durable Objects: DurableObjectStorage
 * - Testing: In-memory Map
 * - Future: Redis, Postgres, etc.
 */
export interface StorageAdapterService {
  /**
   * Get a value by key.
   * Returns undefined if key doesn't exist.
   */
  readonly get: <T>(key: string) => Effect.Effect<T | undefined, StorageError>;

  /**
   * Store a value.
   * Overwrites if key already exists.
   */
  readonly put: <T>(key: string, value: T) => Effect.Effect<void, StorageError>;

  /**
   * Store multiple values atomically.
   * All writes succeed or all fail.
   */
  readonly putBatch: (
    entries: Record<string, unknown>
  ) => Effect.Effect<void, StorageError>;

  /**
   * Delete a key.
   * Returns true if key existed, false otherwise.
   */
  readonly delete: (key: string) => Effect.Effect<boolean, StorageError>;

  /**
   * Delete all keys.
   * Used for cleanup after workflow completion/failure.
   */
  readonly deleteAll: () => Effect.Effect<void, StorageError>;

  /**
   * List all keys with a given prefix.
   * Returns a Map of key -> value pairs.
   */
  readonly list: <T = unknown>(
    prefix: string
  ) => Effect.Effect<Map<string, T>, StorageError>;
}

/**
 * Effect service tag for StorageAdapter.
 */
export class StorageAdapter extends Context.Tag("@durable-effect/StorageAdapter")<
  StorageAdapter,
  StorageAdapterService
>() {}
```

### 3. Scheduler Adapter (`adapters/scheduler.ts`)

```typescript
// packages/workflow/src/adapters/scheduler.ts

import { Context, Effect } from "effect";
import type { SchedulerError } from "../errors";

/**
 * Abstract scheduler interface for delayed execution.
 *
 * Implementations provide runtime-specific scheduling:
 * - Durable Objects: storage.setAlarm()
 * - Testing: In-memory timer simulation
 * - Future: Redis queues, database polling, etc.
 */
export interface SchedulerAdapterService {
  /**
   * Schedule execution at a specific timestamp (ms since epoch).
   * Only one alarm can be scheduled at a time - overwrites previous.
   */
  readonly schedule: (time: number) => Effect.Effect<void, SchedulerError>;

  /**
   * Cancel any scheduled execution.
   * No-op if nothing scheduled.
   */
  readonly cancel: () => Effect.Effect<void, SchedulerError>;

  /**
   * Get the currently scheduled time (if any).
   * Returns undefined if nothing scheduled.
   */
  readonly getScheduled: () => Effect.Effect<number | undefined, SchedulerError>;
}

/**
 * Effect service tag for SchedulerAdapter.
 */
export class SchedulerAdapter extends Context.Tag("@durable-effect/SchedulerAdapter")<
  SchedulerAdapter,
  SchedulerAdapterService
>() {}
```

### 4. Runtime Adapter (`adapters/runtime.ts`)

```typescript
// packages/workflow/src/adapters/runtime.ts

import { Context, Effect, Layer } from "effect";
import type { StorageAdapter } from "./storage";
import type { SchedulerAdapter } from "./scheduler";

/**
 * Lifecycle events emitted by the runtime.
 * These enable the orchestrator to react to runtime-level events.
 */
export type LifecycleEvent =
  | { readonly _tag: "Initialized" }
  | { readonly _tag: "AlarmFired" }
  | { readonly _tag: "Shutdown" }
  | { readonly _tag: "Reset"; readonly reason?: string };

/**
 * Runtime-level adapter providing identity and lifecycle hooks.
 */
export interface RuntimeAdapterService {
  /**
   * Unique identifier for this workflow instance.
   * In DO: the Durable Object ID
   * In tests: a generated UUID
   */
  readonly instanceId: string;

  /**
   * Get the current time (for testing time control).
   * In production: Date.now()
   * In tests: controllable clock
   */
  readonly now: () => Effect.Effect<number>;
}

/**
 * Effect service tag for RuntimeAdapter.
 */
export class RuntimeAdapter extends Context.Tag("@durable-effect/RuntimeAdapter")<
  RuntimeAdapter,
  RuntimeAdapterService
>() {}

/**
 * Complete runtime layer type.
 * All runtime adapters combined into a single layer.
 */
export type RuntimeLayer = Layer.Layer<
  StorageAdapter | SchedulerAdapter | RuntimeAdapter
>;
```

### 5. In-Memory Storage (`adapters/in-memory/storage.ts`)

```typescript
// packages/workflow/src/adapters/in-memory/storage.ts

import { Effect, Ref } from "effect";
import { StorageError } from "../../errors";
import type { StorageAdapterService } from "../storage";

/**
 * In-memory storage state.
 */
export interface InMemoryStorageState {
  readonly data: Map<string, unknown>;
}

/**
 * Create an in-memory storage adapter.
 *
 * Used for testing - all data stored in a Map.
 * Optionally accepts a Ref for external state inspection.
 */
export function createInMemoryStorage(
  stateRef?: Ref.Ref<InMemoryStorageState>
): Effect.Effect<StorageAdapterService, never, never> {
  return Effect.gen(function* () {
    // Use provided ref or create new one
    const ref = stateRef ?? (yield* Ref.make<InMemoryStorageState>({ data: new Map() }));

    return {
      get: <T>(key: string) =>
        Ref.get(ref).pipe(
          Effect.map((state) => state.data.get(key) as T | undefined)
        ),

      put: <T>(key: string, value: T) =>
        Ref.update(ref, (state) => ({
          data: new Map(state.data).set(key, value),
        })),

      putBatch: (entries: Record<string, unknown>) =>
        Ref.update(ref, (state) => {
          const newData = new Map(state.data);
          for (const [key, value] of Object.entries(entries)) {
            newData.set(key, value);
          }
          return { data: newData };
        }),

      delete: (key: string) =>
        Ref.modify(ref, (state) => {
          const existed = state.data.has(key);
          const newData = new Map(state.data);
          newData.delete(key);
          return [existed, { data: newData }];
        }),

      deleteAll: () =>
        Ref.set(ref, { data: new Map() }),

      list: <T = unknown>(prefix: string) =>
        Ref.get(ref).pipe(
          Effect.map((state) => {
            const result = new Map<string, T>();
            for (const [key, value] of state.data) {
              if (key.startsWith(prefix)) {
                result.set(key, value as T);
              }
            }
            return result;
          })
        ),
    };
  });
}

/**
 * Create in-memory storage with injectable error simulation.
 * Useful for testing error handling paths.
 */
export function createInMemoryStorageWithErrors(
  errorConfig: {
    failOn?: {
      get?: string[];      // Keys that should fail on get
      put?: string[];      // Keys that should fail on put
      delete?: string[];   // Keys that should fail on delete
    };
    failAll?: boolean;     // Fail all operations
  }
): Effect.Effect<StorageAdapterService, never, never> {
  return Effect.gen(function* () {
    const base = yield* createInMemoryStorage();

    const shouldFail = (op: "get" | "put" | "delete", key?: string): boolean => {
      if (errorConfig.failAll) return true;
      if (key && errorConfig.failOn?.[op]?.includes(key)) return true;
      return false;
    };

    return {
      get: <T>(key: string) =>
        shouldFail("get", key)
          ? Effect.fail(new StorageError({ operation: "get", key, cause: new Error("Simulated failure") }))
          : base.get<T>(key),

      put: <T>(key: string, value: T) =>
        shouldFail("put", key)
          ? Effect.fail(new StorageError({ operation: "put", key, cause: new Error("Simulated failure") }))
          : base.put(key, value),

      putBatch: (entries: Record<string, unknown>) =>
        errorConfig.failAll
          ? Effect.fail(new StorageError({ operation: "put", cause: new Error("Simulated failure") }))
          : base.putBatch(entries),

      delete: (key: string) =>
        shouldFail("delete", key)
          ? Effect.fail(new StorageError({ operation: "delete", key, cause: new Error("Simulated failure") }))
          : base.delete(key),

      deleteAll: () =>
        errorConfig.failAll
          ? Effect.fail(new StorageError({ operation: "deleteAll", cause: new Error("Simulated failure") }))
          : base.deleteAll(),

      list: <T = unknown>(prefix: string) =>
        errorConfig.failAll
          ? Effect.fail(new StorageError({ operation: "list", cause: new Error("Simulated failure") }))
          : base.list<T>(prefix),
    };
  });
}
```

### 6. In-Memory Scheduler (`adapters/in-memory/scheduler.ts`)

```typescript
// packages/workflow/src/adapters/in-memory/scheduler.ts

import { Effect, Ref } from "effect";
import type { SchedulerAdapterService } from "../scheduler";

/**
 * In-memory scheduler state.
 */
export interface InMemorySchedulerState {
  readonly scheduledTime: number | undefined;
}

/**
 * Create an in-memory scheduler adapter.
 *
 * Used for testing - stores scheduled time in a Ref.
 * Does NOT automatically fire - tests must manually trigger alarms.
 */
export function createInMemoryScheduler(
  stateRef?: Ref.Ref<InMemorySchedulerState>
): Effect.Effect<SchedulerAdapterService, never, never> {
  return Effect.gen(function* () {
    const ref = stateRef ?? (yield* Ref.make<InMemorySchedulerState>({ scheduledTime: undefined }));

    return {
      schedule: (time: number) =>
        Ref.set(ref, { scheduledTime: time }),

      cancel: () =>
        Ref.set(ref, { scheduledTime: undefined }),

      getScheduled: () =>
        Ref.get(ref).pipe(Effect.map((state) => state.scheduledTime)),
    };
  });
}

/**
 * Helper to check if an alarm should have fired given current time.
 */
export function shouldAlarmFire(
  scheduledTime: number | undefined,
  currentTime: number
): boolean {
  return scheduledTime !== undefined && currentTime >= scheduledTime;
}
```

### 7. In-Memory Runtime (`adapters/in-memory/runtime.ts`)

```typescript
// packages/workflow/src/adapters/in-memory/runtime.ts

import { Effect, Layer, Ref } from "effect";
import { StorageAdapter } from "../storage";
import { SchedulerAdapter } from "../scheduler";
import { RuntimeAdapter, type RuntimeLayer } from "../runtime";
import {
  createInMemoryStorage,
  type InMemoryStorageState,
} from "./storage";
import {
  createInMemoryScheduler,
  type InMemorySchedulerState,
} from "./scheduler";

/**
 * Combined state for the in-memory runtime.
 * Exposed for test inspection.
 */
export interface InMemoryRuntimeState {
  readonly storage: InMemoryStorageState;
  readonly scheduler: InMemorySchedulerState;
  readonly currentTime: number;
}

/**
 * Test runtime handle for controlling time and inspecting state.
 */
export interface TestRuntimeHandle {
  /**
   * Get current storage state for assertions.
   */
  readonly getStorageState: () => Effect.Effect<InMemoryStorageState>;

  /**
   * Get current scheduler state for assertions.
   */
  readonly getSchedulerState: () => Effect.Effect<InMemorySchedulerState>;

  /**
   * Get current simulated time.
   */
  readonly getCurrentTime: () => Effect.Effect<number>;

  /**
   * Advance simulated time by milliseconds.
   */
  readonly advanceTime: (ms: number) => Effect.Effect<void>;

  /**
   * Set simulated time to specific value.
   */
  readonly setTime: (time: number) => Effect.Effect<void>;

  /**
   * Check if alarm should fire at current time.
   */
  readonly shouldAlarmFire: () => Effect.Effect<boolean>;

  /**
   * Clear the scheduled alarm (simulates alarm firing).
   */
  readonly clearAlarm: () => Effect.Effect<void>;
}

/**
 * Create an in-memory runtime for testing.
 *
 * Returns both the Layer and a handle for test control.
 */
export function createInMemoryRuntime(options?: {
  instanceId?: string;
  initialTime?: number;
}): Effect.Effect<{
  layer: RuntimeLayer;
  handle: TestRuntimeHandle;
}> {
  return Effect.gen(function* () {
    const instanceId = options?.instanceId ?? crypto.randomUUID();
    const initialTime = options?.initialTime ?? Date.now();

    // Create shared refs for state inspection
    const storageRef = yield* Ref.make<InMemoryStorageState>({ data: new Map() });
    const schedulerRef = yield* Ref.make<InMemorySchedulerState>({ scheduledTime: undefined });
    const timeRef = yield* Ref.make<number>(initialTime);

    // Create adapters with shared refs
    const storageService = yield* createInMemoryStorage(storageRef);
    const schedulerService = yield* createInMemoryScheduler(schedulerRef);

    const runtimeService = {
      instanceId,
      now: () => Ref.get(timeRef),
    };

    // Create the layer
    const layer = Layer.mergeAll(
      Layer.succeed(StorageAdapter, storageService),
      Layer.succeed(SchedulerAdapter, schedulerService),
      Layer.succeed(RuntimeAdapter, runtimeService),
    );

    // Create test handle
    const handle: TestRuntimeHandle = {
      getStorageState: () => Ref.get(storageRef),
      getSchedulerState: () => Ref.get(schedulerRef),
      getCurrentTime: () => Ref.get(timeRef),
      advanceTime: (ms: number) => Ref.update(timeRef, (t) => t + ms),
      setTime: (time: number) => Ref.set(timeRef, time),
      shouldAlarmFire: () =>
        Effect.all([Ref.get(schedulerRef), Ref.get(timeRef)]).pipe(
          Effect.map(([scheduler, time]) =>
            scheduler.scheduledTime !== undefined && time >= scheduler.scheduledTime
          )
        ),
      clearAlarm: () => Ref.set(schedulerRef, { scheduledTime: undefined }),
    };

    return { layer, handle };
  });
}
```

### 8. Adapter Exports (`adapters/index.ts`)

```typescript
// packages/workflow/src/adapters/index.ts

// Storage
export { StorageAdapter, type StorageAdapterService } from "./storage";

// Scheduler
export { SchedulerAdapter, type SchedulerAdapterService } from "./scheduler";

// Runtime
export {
  RuntimeAdapter,
  type RuntimeAdapterService,
  type RuntimeLayer,
  type LifecycleEvent,
} from "./runtime";

// In-memory implementations (for testing)
export {
  createInMemoryStorage,
  createInMemoryStorageWithErrors,
  type InMemoryStorageState,
} from "./in-memory/storage";

export {
  createInMemoryScheduler,
  shouldAlarmFire,
  type InMemorySchedulerState,
} from "./in-memory/scheduler";

export {
  createInMemoryRuntime,
  type InMemoryRuntimeState,
  type TestRuntimeHandle,
} from "./in-memory/runtime";
```

### 9. Main Index (`index.ts`)

```typescript
// packages/workflow/src/index.ts

// Errors
export {
  StorageError,
  SchedulerError,
  InvalidTransitionError,
  RecoveryError,
  OrchestratorError,
} from "./errors";

// Adapters
export {
  // Core adapters
  StorageAdapter,
  SchedulerAdapter,
  RuntimeAdapter,
  // Types
  type StorageAdapterService,
  type SchedulerAdapterService,
  type RuntimeAdapterService,
  type RuntimeLayer,
  type LifecycleEvent,
  // In-memory (testing)
  createInMemoryRuntime,
  type TestRuntimeHandle,
} from "./adapters";
```

---

## Testing Strategy

### Test File: `test/adapters/storage.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { Effect, Ref } from "effect";
import {
  createInMemoryStorage,
  createInMemoryStorageWithErrors,
  StorageAdapter,
  StorageError,
} from "../../src";

describe("InMemoryStorage", () => {
  describe("basic operations", () => {
    it("should store and retrieve values", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        yield* storage.put("key1", { value: 42 });
        return yield* storage.get<{ value: number }>("key1");
      }).pipe(Effect.runPromise);

      expect(result).toEqual({ value: 42 });
    });

    it("should return undefined for missing keys", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        return yield* storage.get("nonexistent");
      }).pipe(Effect.runPromise);

      expect(result).toBeUndefined();
    });

    it("should overwrite existing values", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        yield* storage.put("key1", "first");
        yield* storage.put("key1", "second");
        return yield* storage.get("key1");
      }).pipe(Effect.runPromise);

      expect(result).toBe("second");
    });

    it("should delete values", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        yield* storage.put("key1", "value");
        const existed = yield* storage.delete("key1");
        const after = yield* storage.get("key1");
        return { existed, after };
      }).pipe(Effect.runPromise);

      expect(result.existed).toBe(true);
      expect(result.after).toBeUndefined();
    });

    it("should return false when deleting nonexistent key", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        return yield* storage.delete("nonexistent");
      }).pipe(Effect.runPromise);

      expect(result).toBe(false);
    });

    it("should delete all values", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        yield* storage.put("key1", "value1");
        yield* storage.put("key2", "value2");
        yield* storage.deleteAll();
        const v1 = yield* storage.get("key1");
        const v2 = yield* storage.get("key2");
        return { v1, v2 };
      }).pipe(Effect.runPromise);

      expect(result.v1).toBeUndefined();
      expect(result.v2).toBeUndefined();
    });
  });

  describe("putBatch", () => {
    it("should store multiple values atomically", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        yield* storage.putBatch({
          key1: "value1",
          key2: "value2",
          key3: { nested: true },
        });
        return {
          v1: yield* storage.get("key1"),
          v2: yield* storage.get("key2"),
          v3: yield* storage.get("key3"),
        };
      }).pipe(Effect.runPromise);

      expect(result).toEqual({
        v1: "value1",
        v2: "value2",
        v3: { nested: true },
      });
    });
  });

  describe("list", () => {
    it("should list keys with prefix", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        yield* storage.put("workflow:status", "running");
        yield* storage.put("workflow:input", { x: 1 });
        yield* storage.put("step:fetch:result", "data");
        return yield* storage.list("workflow:");
      }).pipe(Effect.runPromise);

      expect(result.size).toBe(2);
      expect(result.get("workflow:status")).toBe("running");
      expect(result.get("workflow:input")).toEqual({ x: 1 });
    });
  });

  describe("error simulation", () => {
    it("should fail specified operations", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorageWithErrors({
          failOn: { get: ["secret"] },
        });
        yield* storage.put("normal", "value");
        const normal = yield* storage.get("normal");
        const secret = yield* storage.get("secret").pipe(Effect.either);
        return { normal, secret };
      }).pipe(Effect.runPromise);

      expect(result.normal).toBe("value");
      expect(result.secret._tag).toBe("Left");
    });
  });
});
```

### Test File: `test/adapters/scheduler.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { createInMemoryScheduler, shouldAlarmFire } from "../../src";

describe("InMemoryScheduler", () => {
  it("should schedule and retrieve alarm time", async () => {
    const result = await Effect.gen(function* () {
      const scheduler = yield* createInMemoryScheduler();
      yield* scheduler.schedule(1000);
      return yield* scheduler.getScheduled();
    }).pipe(Effect.runPromise);

    expect(result).toBe(1000);
  });

  it("should return undefined when nothing scheduled", async () => {
    const result = await Effect.gen(function* () {
      const scheduler = yield* createInMemoryScheduler();
      return yield* scheduler.getScheduled();
    }).pipe(Effect.runPromise);

    expect(result).toBeUndefined();
  });

  it("should cancel scheduled alarm", async () => {
    const result = await Effect.gen(function* () {
      const scheduler = yield* createInMemoryScheduler();
      yield* scheduler.schedule(1000);
      yield* scheduler.cancel();
      return yield* scheduler.getScheduled();
    }).pipe(Effect.runPromise);

    expect(result).toBeUndefined();
  });

  it("should overwrite previous alarm", async () => {
    const result = await Effect.gen(function* () {
      const scheduler = yield* createInMemoryScheduler();
      yield* scheduler.schedule(1000);
      yield* scheduler.schedule(2000);
      return yield* scheduler.getScheduled();
    }).pipe(Effect.runPromise);

    expect(result).toBe(2000);
  });

  describe("shouldAlarmFire", () => {
    it("should return true when time >= scheduled", () => {
      expect(shouldAlarmFire(1000, 1000)).toBe(true);
      expect(shouldAlarmFire(1000, 1500)).toBe(true);
    });

    it("should return false when time < scheduled", () => {
      expect(shouldAlarmFire(1000, 500)).toBe(false);
    });

    it("should return false when nothing scheduled", () => {
      expect(shouldAlarmFire(undefined, 1000)).toBe(false);
    });
  });
});
```

### Test File: `test/adapters/runtime.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  createInMemoryRuntime,
  StorageAdapter,
  SchedulerAdapter,
  RuntimeAdapter,
} from "../../src";

describe("InMemoryRuntime", () => {
  it("should create a complete runtime layer", async () => {
    const result = await Effect.gen(function* () {
      const { layer } = yield* createInMemoryRuntime();

      return yield* Effect.gen(function* () {
        const storage = yield* StorageAdapter;
        const scheduler = yield* SchedulerAdapter;
        const runtime = yield* RuntimeAdapter;

        yield* storage.put("test", "value");
        yield* scheduler.schedule(1000);

        return {
          value: yield* storage.get("test"),
          scheduled: yield* scheduler.getScheduled(),
          instanceId: runtime.instanceId,
        };
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.runPromise);

    expect(result.value).toBe("value");
    expect(result.scheduled).toBe(1000);
    expect(result.instanceId).toBeDefined();
  });

  it("should allow time control via handle", async () => {
    const result = await Effect.gen(function* () {
      const { layer, handle } = yield* createInMemoryRuntime({
        initialTime: 1000,
      });

      const t1 = yield* handle.getCurrentTime();
      yield* handle.advanceTime(500);
      const t2 = yield* handle.getCurrentTime();
      yield* handle.setTime(5000);
      const t3 = yield* handle.getCurrentTime();

      return { t1, t2, t3 };
    }).pipe(Effect.runPromise);

    expect(result.t1).toBe(1000);
    expect(result.t2).toBe(1500);
    expect(result.t3).toBe(5000);
  });

  it("should detect when alarm should fire", async () => {
    const result = await Effect.gen(function* () {
      const { layer, handle } = yield* createInMemoryRuntime({
        initialTime: 1000,
      });

      yield* Effect.gen(function* () {
        const scheduler = yield* SchedulerAdapter;
        yield* scheduler.schedule(1500);
      }).pipe(Effect.provide(layer));

      const before = yield* handle.shouldAlarmFire();
      yield* handle.advanceTime(600);
      const after = yield* handle.shouldAlarmFire();

      return { before, after };
    }).pipe(Effect.runPromise);

    expect(result.before).toBe(false);
    expect(result.after).toBe(true);
  });

  it("should allow state inspection", async () => {
    const result = await Effect.gen(function* () {
      const { layer, handle } = yield* createInMemoryRuntime();

      yield* Effect.gen(function* () {
        const storage = yield* StorageAdapter;
        yield* storage.put("key1", "value1");
        yield* storage.put("key2", "value2");
      }).pipe(Effect.provide(layer));

      const state = yield* handle.getStorageState();
      return state.data.size;
    }).pipe(Effect.runPromise);

    expect(result).toBe(2);
  });
});
```

---

## Definition of Done

- [ ] All error types created and exported
- [ ] StorageAdapter interface defined with full documentation
- [ ] SchedulerAdapter interface defined with full documentation
- [ ] RuntimeAdapter interface defined with lifecycle types
- [ ] In-memory storage implementation complete with error injection
- [ ] In-memory scheduler implementation complete
- [ ] In-memory runtime factory creates proper Layer
- [ ] TestRuntimeHandle provides time control and state inspection
- [ ] All tests passing
- [ ] Package builds without errors (`pnpm build`)
- [ ] TypeScript types are properly exported

---

## Notes for Implementation

1. **Start with errors.ts** - Other files depend on error types
2. **Build adapters bottom-up** - Storage → Scheduler → Runtime
3. **Test each adapter independently** before creating runtime layer
4. **The in-memory runtime is critical** - All future phases depend on it
5. **Keep interfaces minimal** - Only add methods when needed
