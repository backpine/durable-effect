# Phase 10: Durable Object Integration - Runtime Adapter

## Overview

This is the final phase - integrating all components into a Cloudflare Durable Object runtime. This phase creates the Durable Object adapter implementation and the thin engine shell that exposes the workflow API as RPC methods.

**Duration**: ~3-4 hours
**Dependencies**: Phase 1-9 (all previous phases)
**Risk Level**: Medium (runtime integration, production-facing)

---

## Goals

1. Create `DurableObjectStorageAdapter` implementation
2. Create `DurableObjectSchedulerAdapter` implementation
3. Create `DurableObjectRuntimeAdapter` implementation
4. Implement thin `DurableWorkflowEngine` shell
5. Add constructor recovery integration
6. Create `createDurableWorkflows()` factory function

---

## Background: Durable Object Runtime

Cloudflare Durable Objects provide:

1. **Persistent storage** - Key-value storage that survives restarts
2. **Alarms** - Single-fire timers for scheduled execution
3. **Instance isolation** - Each workflow gets its own DO
4. **Consistency** - Strong consistency within an instance
5. **Constructor hook** - Runs on instance creation/wake

---

## File Structure

```
packages/workflow/src/
├── adapters/
│   └── durable-object/
│       ├── index.ts           # DO adapter exports
│       ├── storage.ts         # DO storage adapter
│       ├── scheduler.ts       # DO scheduler adapter
│       └── runtime.ts         # DO runtime layer factory
├── engine/
│   ├── index.ts               # Engine exports
│   ├── types.ts               # Engine types
│   └── engine.ts              # DurableWorkflowEngine class
└── test/
    └── engine/
        └── engine.test.ts     # Integration tests (miniflare)
```

---

## Implementation Details

### 1. DO Storage Adapter (`adapters/durable-object/storage.ts`)

```typescript
// packages/workflow/src/adapters/durable-object/storage.ts

import { Effect, Schedule, Duration } from "effect";
import { StorageError } from "../../errors";
import type { StorageAdapterService } from "../storage";

/**
 * Retry schedule for storage operations.
 * Cloudflare storage can have transient failures.
 */
const STORAGE_RETRY_SCHEDULE = Schedule.exponential(Duration.millis(10)).pipe(
  Schedule.compose(Schedule.recurs(3)),
  Schedule.jittered
);

/**
 * Check if an error is retryable.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("network") ||
      msg.includes("timeout") ||
      msg.includes("temporarily") ||
      msg.includes("rate limit")
    );
  }
  return false;
}

/**
 * Create a Durable Object storage adapter.
 *
 * Wraps DurableObjectStorage with Effect error handling and retries.
 */
export function createDOStorageAdapter(
  storage: DurableObjectStorage
): StorageAdapterService {
  return {
    get: <T>(key: string) =>
      Effect.tryPromise({
        try: () => storage.get<T>(key),
        catch: (e) =>
          new StorageError({ operation: "get", key, cause: e }),
      }).pipe(
        Effect.retry({
          schedule: STORAGE_RETRY_SCHEDULE,
          while: (e) => isRetryableError(e.cause),
        })
      ),

    put: <T>(key: string, value: T) =>
      Effect.tryPromise({
        try: () => storage.put(key, value),
        catch: (e) =>
          new StorageError({ operation: "put", key, cause: e }),
      }).pipe(
        Effect.retry({
          schedule: STORAGE_RETRY_SCHEDULE,
          while: (e) => isRetryableError(e.cause),
        })
      ),

    putBatch: (entries: Record<string, unknown>) =>
      Effect.tryPromise({
        try: () => storage.put(entries),
        catch: (e) =>
          new StorageError({ operation: "put", cause: e }),
      }).pipe(
        Effect.retry({
          schedule: STORAGE_RETRY_SCHEDULE,
          while: (e) => isRetryableError(e.cause),
        })
      ),

    delete: (key: string) =>
      Effect.tryPromise({
        try: async () => {
          const existed = (await storage.get(key)) !== undefined;
          await storage.delete(key);
          return existed;
        },
        catch: (e) =>
          new StorageError({ operation: "delete", key, cause: e }),
      }).pipe(
        Effect.retry({
          schedule: STORAGE_RETRY_SCHEDULE,
          while: (e) => isRetryableError(e.cause),
        })
      ),

    deleteAll: () =>
      Effect.tryPromise({
        try: () => storage.deleteAll(),
        catch: (e) =>
          new StorageError({ operation: "deleteAll", cause: e }),
      }),

    list: <T = unknown>(prefix: string) =>
      Effect.tryPromise({
        try: async () => {
          const result = await storage.list<T>({ prefix });
          return result;
        },
        catch: (e) =>
          new StorageError({ operation: "list", cause: e }),
      }).pipe(
        Effect.retry({
          schedule: STORAGE_RETRY_SCHEDULE,
          while: (e) => isRetryableError(e.cause),
        })
      ),
  };
}
```

### 2. DO Scheduler Adapter (`adapters/durable-object/scheduler.ts`)

```typescript
// packages/workflow/src/adapters/durable-object/scheduler.ts

import { Effect } from "effect";
import { SchedulerError } from "../../errors";
import type { SchedulerAdapterService } from "../scheduler";

/**
 * Create a Durable Object scheduler adapter.
 *
 * Wraps DO alarm methods with Effect error handling.
 */
export function createDOSchedulerAdapter(
  storage: DurableObjectStorage
): SchedulerAdapterService {
  return {
    schedule: (time: number) =>
      Effect.tryPromise({
        try: () => storage.setAlarm(time),
        catch: (e) =>
          new SchedulerError({ operation: "schedule", cause: e }),
      }),

    cancel: () =>
      Effect.tryPromise({
        try: () => storage.deleteAlarm(),
        catch: (e) =>
          new SchedulerError({ operation: "cancel", cause: e }),
      }),

    getScheduled: () =>
      Effect.tryPromise({
        try: () => storage.getAlarm(),
        catch: (e) =>
          new SchedulerError({ operation: "get", cause: e }),
      }).pipe(
        Effect.map((time) => (time === null ? undefined : time))
      ),
  };
}
```

### 3. DO Runtime Layer (`adapters/durable-object/runtime.ts`)

```typescript
// packages/workflow/src/adapters/durable-object/runtime.ts

import { Effect, Layer } from "effect";
import { StorageAdapter } from "../storage";
import { SchedulerAdapter } from "../scheduler";
import { RuntimeAdapter, type RuntimeLayer } from "../runtime";
import { createDOStorageAdapter } from "./storage";
import { createDOSchedulerAdapter } from "./scheduler";

/**
 * Create a complete Durable Object runtime layer.
 *
 * This is the adapter that connects the workflow system to Cloudflare DOs.
 */
export function createDurableObjectRuntime(
  state: DurableObjectState
): RuntimeLayer {
  const storageService = createDOStorageAdapter(state.storage);
  const schedulerService = createDOSchedulerAdapter(state.storage);

  const runtimeService = {
    instanceId: state.id.toString(),
    now: () => Effect.sync(() => Date.now()),
  };

  return Layer.mergeAll(
    Layer.succeed(StorageAdapter, storageService),
    Layer.succeed(SchedulerAdapter, schedulerService),
    Layer.succeed(RuntimeAdapter, runtimeService)
  );
}
```

### 4. DO Adapter Exports (`adapters/durable-object/index.ts`)

```typescript
// packages/workflow/src/adapters/durable-object/index.ts

export { createDOStorageAdapter } from "./storage";
export { createDOSchedulerAdapter } from "./scheduler";
export { createDurableObjectRuntime } from "./runtime";
```

### 5. Engine Types (`engine/types.ts`)

```typescript
// packages/workflow/src/engine/types.ts

import type { WorkflowRegistry, WorkflowCall } from "../orchestrator/types";
import type { WorkflowStatus } from "../state/types";
import type { HttpBatchTrackerConfig } from "../tracker/http-batch";
import type { RecoveryConfig } from "../recovery/config";

/**
 * Options for creating durable workflows.
 */
export interface CreateDurableWorkflowsOptions {
  /**
   * Event tracker configuration.
   * If not provided, no events are emitted.
   */
  readonly tracker?: HttpBatchTrackerConfig;

  /**
   * Recovery configuration.
   * Uses defaults if not provided.
   */
  readonly recovery?: Partial<RecoveryConfig>;
}

/**
 * Result of createDurableWorkflows factory.
 */
export interface CreateDurableWorkflowsResult<W extends WorkflowRegistry> {
  /**
   * The Durable Object class to export.
   */
  readonly Workflows: {
    new (state: DurableObjectState, env: unknown): DurableWorkflowEngineInterface<W>;
  };

  /**
   * Factory for creating type-safe workflow clients.
   */
  readonly WorkflowClient: WorkflowClientFactory<W>;
}

/**
 * Public interface of the Durable Workflow Engine.
 */
export interface DurableWorkflowEngineInterface<W extends WorkflowRegistry> {
  /**
   * Start a workflow synchronously.
   */
  run(call: WorkflowCall<W>): Promise<{ id: string }>;

  /**
   * Queue a workflow for async execution.
   */
  runAsync(call: WorkflowCall<W>): Promise<{ id: string }>;

  /**
   * Cancel a running workflow.
   */
  cancel(options?: { reason?: string }): Promise<{
    cancelled: boolean;
    reason?: string;
  }>;

  /**
   * Get current workflow status.
   */
  getStatus(): Promise<WorkflowStatus | undefined>;

  /**
   * Get completed step names.
   */
  getCompletedSteps(): Promise<readonly string[]>;

  /**
   * Get workflow metadata.
   */
  getMeta<T>(key: string): Promise<T | undefined>;
}

/**
 * Workflow client factory type.
 */
export interface WorkflowClientFactory<W extends WorkflowRegistry> {
  /**
   * Create a client from a Durable Object binding.
   */
  fromBinding(
    binding: DurableObjectNamespace,
    options?: { idFromName?: string; id?: DurableObjectId }
  ): WorkflowClientInstance<W>;
}

/**
 * Type-safe workflow client instance.
 */
export interface WorkflowClientInstance<W extends WorkflowRegistry> {
  /**
   * Start a workflow.
   */
  run(call: WorkflowCall<W>): Promise<{ id: string }>;

  /**
   * Queue a workflow.
   */
  runAsync(call: WorkflowCall<W>): Promise<{ id: string }>;

  /**
   * Cancel a workflow.
   */
  cancel(options?: { reason?: string }): Promise<{
    cancelled: boolean;
    reason?: string;
  }>;

  /**
   * Get status.
   */
  getStatus(): Promise<WorkflowStatus | undefined>;

  /**
   * Get the workflow instance ID.
   */
  readonly id: string;
}
```

### 6. Durable Workflow Engine (`engine/engine.ts`)

```typescript
// packages/workflow/src/engine/engine.ts

import { DurableObject } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { createDurableObjectRuntime } from "../adapters/durable-object";
import {
  WorkflowStateMachine,
  WorkflowStateMachineLayer,
} from "../state/machine";
import {
  RecoveryManager,
  RecoveryManagerLayer,
  defaultRecoveryConfig,
} from "../recovery";
import {
  WorkflowExecutor,
  WorkflowExecutorLayer,
} from "../executor";
import {
  WorkflowOrchestrator,
  WorkflowOrchestratorLayer,
  WorkflowRegistryLayer,
  type WorkflowRegistry,
  type WorkflowCall,
} from "../orchestrator";
import {
  EventTracker,
  HttpBatchTrackerLayer,
  NoopTrackerLayer,
  flushEvents,
} from "../tracker";
import type {
  CreateDurableWorkflowsOptions,
  CreateDurableWorkflowsResult,
  DurableWorkflowEngineInterface,
  WorkflowClientFactory,
  WorkflowClientInstance,
} from "./types";

/**
 * Create a Durable Workflow engine for a set of workflows.
 *
 * This is the main factory function for creating production workflow engines.
 *
 * @example
 * ```ts
 * // Define workflows
 * const myWorkflows = {
 *   processOrder: Workflow.make({
 *     name: "processOrder"
 *   }, (input: { orderId: string }) =>
 *     Effect.gen(function* () {
 *       const order = yield* Workflow.step("fetch", () => fetchOrder(input.orderId));
 *       yield* Workflow.sleep("1 hour");
 *       return yield* Workflow.step("process", () => processOrder(order));
 *     })
 *   ),
 * };
 *
 * // Create engine
 * const { Workflows, WorkflowClient } = createDurableWorkflows(myWorkflows, {
 *   tracker: { endpoint: "https://events.example.com/ingest" },
 * });
 *
 * // Export for Cloudflare
 * export { Workflows };
 *
 * // Use client in worker
 * const client = WorkflowClient.fromBinding(env.WORKFLOWS, { idFromName: orderId });
 * await client.run({ workflow: "processOrder", input: { orderId } });
 * ```
 */
export function createDurableWorkflows<const W extends WorkflowRegistry>(
  workflows: W,
  options?: CreateDurableWorkflowsOptions
): CreateDurableWorkflowsResult<W> {
  // Create engine class
  class DurableWorkflowEngine
    extends DurableObject
    implements DurableWorkflowEngineInterface<W>
  {
    readonly #runtimeLayer: Layer.Layer<any>;
    readonly #orchestratorLayer: Layer.Layer<any>;

    constructor(state: DurableObjectState, env: unknown) {
      super(state, env as never);

      // Create runtime adapter layer
      this.#runtimeLayer = createDurableObjectRuntime(state);

      // Create tracker layer
      const trackerLayer = options?.tracker
        ? HttpBatchTrackerLayer(options.tracker)
        : NoopTrackerLayer;

      // Create full orchestrator layer
      this.#orchestratorLayer = WorkflowOrchestratorLayer<W>().pipe(
        Layer.provideMerge(WorkflowRegistryLayer(workflows)),
        Layer.provideMerge(WorkflowExecutorLayer),
        Layer.provideMerge(RecoveryManagerLayer(options?.recovery)),
        Layer.provideMerge(WorkflowStateMachineLayer),
        Layer.provideMerge(trackerLayer),
        Layer.provide(this.#runtimeLayer)
      );

      // Run recovery check in constructor
      state.blockConcurrencyWhile(async () => {
        await this.#runEffect(
          Effect.gen(function* () {
            const recovery = yield* RecoveryManager;
            const result = yield* recovery.checkAndScheduleRecovery();

            // Log recovery if needed
            if (result.scheduled) {
              console.log(
                `[Workflow] Recovery scheduled: ${result.reason} (attempt ${result.attempt})`
              );
            }
          })
        );
      });
    }

    // Helper to run effects with full layer stack
    #runEffect<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
      return Effect.runPromise(
        effect.pipe(Effect.provide(this.#orchestratorLayer))
      );
    }

    async run(call: WorkflowCall<W>): Promise<{ id: string }> {
      const result = await this.#runEffect(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<W>();
          const result = yield* orchestrator.start(call);
          yield* flushEvents;
          return result;
        })
      );

      return { id: result.id };
    }

    async runAsync(call: WorkflowCall<W>): Promise<{ id: string }> {
      const result = await this.#runEffect(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<W>();
          const result = yield* orchestrator.queue(call);
          yield* flushEvents;
          return result;
        })
      );

      return { id: result.id };
    }

    async alarm(): Promise<void> {
      await this.#runEffect(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<W>();
          yield* orchestrator.handleAlarm();
          yield* flushEvents;
        })
      );
    }

    async cancel(options?: { reason?: string }): Promise<{
      cancelled: boolean;
      reason?: string;
    }> {
      const result = await this.#runEffect(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<W>();
          return yield* orchestrator.cancel(options);
        })
      );

      return {
        cancelled: result.cancelled,
        reason: result.reason,
      };
    }

    async getStatus() {
      const result = await this.#runEffect(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<W>();
          return yield* orchestrator.getStatus();
        })
      );

      return result.status;
    }

    async getCompletedSteps(): Promise<readonly string[]> {
      const result = await this.#runEffect(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.getCompletedSteps();
        })
      );

      return result;
    }

    async getMeta<T>(key: string): Promise<T | undefined> {
      return this.#runEffect(
        Effect.gen(function* () {
          const { StorageAdapter } = yield* import("../adapters/storage");
          const storage = yield* StorageAdapter;
          return yield* storage.get<T>(`workflow:meta:${key}`);
        })
      );
    }
  }

  // Create client factory
  const WorkflowClient: WorkflowClientFactory<W> = {
    fromBinding(binding, options) {
      const id = options?.id ?? (options?.idFromName
        ? binding.idFromName(options.idFromName)
        : binding.newUniqueId());

      const stub = binding.get(id);

      return {
        id: id.toString(),

        run: (call) => stub.run(call),
        runAsync: (call) => stub.runAsync(call),
        cancel: (opts) => stub.cancel(opts),
        getStatus: () => stub.getStatus(),
      } as WorkflowClientInstance<W>;
    },
  };

  return {
    Workflows: DurableWorkflowEngine as any,
    WorkflowClient,
  };
}
```

### 7. Engine Exports (`engine/index.ts`)

```typescript
// packages/workflow/src/engine/index.ts

export type {
  CreateDurableWorkflowsOptions,
  CreateDurableWorkflowsResult,
  DurableWorkflowEngineInterface,
  WorkflowClientFactory,
  WorkflowClientInstance,
} from "./types";

export { createDurableWorkflows } from "./engine";
```

### 8. Update Main Index

```typescript
// packages/workflow/src/index.ts

// ... existing exports ...

// DO Adapter
export { createDurableObjectRuntime } from "./adapters/durable-object";

// Engine
export {
  createDurableWorkflows,
  type CreateDurableWorkflowsOptions,
  type CreateDurableWorkflowsResult,
  type DurableWorkflowEngineInterface,
  type WorkflowClientFactory,
  type WorkflowClientInstance,
} from "./engine";
```

---

## Testing Strategy

### Integration Test File: `test/engine/engine.test.ts`

```typescript
/**
 * Note: These tests require miniflare or similar DO testing environment.
 * This is a template for integration tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { unstable_dev } from "wrangler";
import type { UnstableDevWorker } from "wrangler";

describe("DurableWorkflowEngine (Integration)", () => {
  let worker: UnstableDevWorker;

  beforeEach(async () => {
    worker = await unstable_dev("./test/fixtures/worker.ts", {
      experimental: { disableExperimentalWarning: true },
    });
  });

  afterEach(async () => {
    await worker.stop();
  });

  describe("run", () => {
    it("should start and complete simple workflow", async () => {
      const response = await worker.fetch("/workflow/simple", {
        method: "POST",
        body: JSON.stringify({ value: 21 }),
      });

      const result = await response.json();
      expect(result.completed).toBe(true);
      expect(result.output).toBe(42);
    });

    it("should handle workflow that pauses", async () => {
      const response = await worker.fetch("/workflow/sleeping", {
        method: "POST",
        body: JSON.stringify({}),
      });

      const result = await response.json();
      expect(result.completed).toBe(false);

      // Check status
      const statusResponse = await worker.fetch("/workflow/sleeping/status");
      const status = await statusResponse.json();
      expect(status.status._tag).toBe("Paused");
    });
  });

  describe("recovery", () => {
    it("should recover from simulated infrastructure restart", async () => {
      // Start workflow
      await worker.fetch("/workflow/steps", {
        method: "POST",
        body: JSON.stringify({ items: ["a", "b"] }),
      });

      // Simulate restart (in real test, would restart worker)
      // For now, just verify the recovery system is integrated
      const statusResponse = await worker.fetch("/workflow/steps/status");
      const status = await statusResponse.json();

      expect(status.exists).toBe(true);
    });
  });

  describe("cancellation", () => {
    it("should cancel queued workflow", async () => {
      // Queue workflow
      await worker.fetch("/workflow/slow?async=true", {
        method: "POST",
        body: JSON.stringify({}),
      });

      // Cancel
      const cancelResponse = await worker.fetch("/workflow/slow/cancel", {
        method: "POST",
      });
      const result = await cancelResponse.json();

      expect(result.cancelled).toBe(true);
    });
  });
});
```

### Test Fixture Worker: `test/fixtures/worker.ts`

```typescript
// Test fixture worker for integration tests

import { Effect } from "effect";
import { createDurableWorkflows, Workflow } from "../../src";

// Define test workflows
const workflows = {
  simple: Workflow.make(
    { name: "simple" },
    (input: { value: number }) => Effect.succeed(input.value * 2)
  ),

  sleeping: Workflow.make(
    { name: "sleeping" },
    (_input: {}) =>
      Effect.gen(function* () {
        yield* Workflow.sleep("5 seconds");
        return "done";
      })
  ),

  steps: Workflow.make(
    { name: "steps" },
    (input: { items: string[] }) =>
      Effect.gen(function* () {
        const results: string[] = [];
        for (const item of input.items) {
          const result = yield* Workflow.step(`process-${item}`, () =>
            Effect.succeed(item.toUpperCase())
          );
          results.push(result);
        }
        return results;
      })
  ),

  slow: Workflow.make(
    { name: "slow" },
    (_input: {}) =>
      Effect.gen(function* () {
        yield* Workflow.sleep("1 hour");
        return "completed";
      })
  ),
};

// Create engine
export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows);

// Worker handler
export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route: POST /workflow/:name
    const startMatch = path.match(/^\/workflow\/(\w+)$/);
    if (startMatch && request.method === "POST") {
      const workflowName = startMatch[1];
      const input = await request.json();
      const isAsync = url.searchParams.get("async") === "true";

      const client = WorkflowClient.fromBinding(env.WORKFLOWS, {
        idFromName: `${workflowName}-test`,
      });

      const result = isAsync
        ? await client.runAsync({ workflow: workflowName as any, input })
        : await client.run({ workflow: workflowName as any, input });

      return Response.json(result);
    }

    // Route: GET /workflow/:name/status
    const statusMatch = path.match(/^\/workflow\/(\w+)\/status$/);
    if (statusMatch && request.method === "GET") {
      const workflowName = statusMatch[1];

      const client = WorkflowClient.fromBinding(env.WORKFLOWS, {
        idFromName: `${workflowName}-test`,
      });

      const status = await client.getStatus();
      return Response.json({ status, exists: status !== undefined });
    }

    // Route: POST /workflow/:name/cancel
    const cancelMatch = path.match(/^\/workflow\/(\w+)\/cancel$/);
    if (cancelMatch && request.method === "POST") {
      const workflowName = cancelMatch[1];

      const client = WorkflowClient.fromBinding(env.WORKFLOWS, {
        idFromName: `${workflowName}-test`,
      });

      const result = await client.cancel();
      return Response.json(result);
    }

    return new Response("Not Found", { status: 404 });
  },
};
```

---

## Definition of Done

- [ ] DO storage adapter with retry logic
- [ ] DO scheduler adapter wrapping alarms
- [ ] Runtime layer factory for DO state
- [ ] DurableWorkflowEngine class with all methods
- [ ] Constructor recovery integration
- [ ] createDurableWorkflows() factory works
- [ ] WorkflowClient factory creates type-safe clients
- [ ] Alarm handler routes to orchestrator
- [ ] Event flushing after operations
- [ ] Integration tests pass with miniflare
- [ ] Package builds without errors

---

## Usage Example

```typescript
// workflows.ts
import { Effect } from "effect";
import { createDurableWorkflows, Workflow } from "@durable-effect/workflow";

// Define your workflows
const workflows = {
  processOrder: Workflow.make(
    { name: "processOrder" },
    (input: { orderId: string; items: string[] }) =>
      Effect.gen(function* () {
        // Fetch order (cached on replay)
        const order = yield* Workflow.step("fetchOrder", () =>
          Effect.tryPromise(() => fetch(`/api/orders/${input.orderId}`))
        );

        // Wait for payment confirmation
        yield* Workflow.sleep("1 hour");

        // Process each item with retry
        for (const item of input.items) {
          yield* Workflow.retry(
            `process-${item}`,
            () => Effect.tryPromise(() => processItem(item)),
            { maxAttempts: 3 }
          );
        }

        // Final step
        yield* Workflow.step("complete", () =>
          Effect.tryPromise(() => markOrderComplete(input.orderId))
        );

        return { status: "completed", orderId: input.orderId };
      })
  ),
};

// Create the engine
export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows, {
  tracker: {
    endpoint: "https://events.example.com/ingest",
    headers: { Authorization: "Bearer token" },
  },
  recovery: {
    maxRecoveryAttempts: 5,
    staleThresholdMs: 60_000,
  },
});

// worker.ts
import { Workflows, WorkflowClient } from "./workflows";

export { Workflows };

export default {
  async fetch(request: Request, env: { WORKFLOWS: DurableObjectNamespace }) {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId")!;

    const client = WorkflowClient.fromBinding(env.WORKFLOWS, {
      idFromName: orderId, // Use orderId as workflow instance ID
    });

    if (request.method === "POST") {
      const { items } = await request.json();
      const { id } = await client.run({
        workflow: "processOrder",
        input: { orderId, items },
      });
      return Response.json({ workflowId: id });
    }

    if (request.method === "GET") {
      const status = await client.getStatus();
      return Response.json({ status });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

// wrangler.toml
// [durable_objects]
// bindings = [{ name = "WORKFLOWS", class_name = "Workflows" }]
```

---

## Notes for Implementation

1. **blockConcurrencyWhile is crucial** - Recovery must complete before requests
2. **Retry logic for storage** - CF storage can have transient failures
3. **Event flushing** - Don't lose events on completion
4. **Type safety end-to-end** - WorkflowClient enforces correct call types
5. **Client uses stubs** - RPC calls through DO stubs
