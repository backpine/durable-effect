# Plan: Make WorkflowClient Yieldable (Effect-based)

## Goal

Update `@packages/workflow-v2` WorkflowClient to return Effects instead of Promises, making it yieldable like v1:

```ts
// Current (Promise-based)
const result = await client.runAsync({ workflow: "processOrder", input: "order-123" });

// Target (Effect-based, yieldable)
const { id } = yield* client.runAsync({
  workflow: "processOrder",
  input: "order-123",
  execution: { id: "order-123" },
});
```

## Current State (v2)

```ts
// engine/types.ts
interface WorkflowClientInstance<W> {
  run(call: WorkflowCall<W>): Promise<{ id: string; completed: boolean }>;
  runAsync(call: WorkflowCall<W>): Promise<{ id: string }>;
  cancel(options?: { reason?: string }): Promise<{ cancelled: boolean; reason?: string }>;
  getStatus(): Promise<WorkflowStatus | undefined>;
  readonly id: string;
}
```

## Target State (like v1)

```ts
// client/types.ts
interface WorkflowClientInstance<W> {
  run(request: WorkflowRunRequest<W>): Effect.Effect<WorkflowRunResult, WorkflowClientError>;
  runAsync(request: WorkflowRunRequest<W>): Effect.Effect<WorkflowRunResult, WorkflowClientError>;
  cancel(instanceId: string, options?: CancelOptions): Effect.Effect<CancelResult, WorkflowClientError>;
  status(instanceId: string): Effect.Effect<WorkflowStatus | undefined, WorkflowClientError>;
  completedSteps(instanceId: string): Effect.Effect<ReadonlyArray<string>, WorkflowClientError>;
  meta<T>(instanceId: string, key: string): Effect.Effect<T | undefined, WorkflowClientError>;
}
```

## Changes Required

### 1. Create Client Module Structure

Create new directory: `packages/workflow-v2/src/client/`

Files to create:
- `client/types.ts` - Type definitions
- `client/instance.ts` - Client implementation
- `client/index.ts` - Exports

### 2. Create Type Definitions (`client/types.ts`)

```ts
import type { Context, Effect } from "effect";
import type { WorkflowRegistry, WorkflowStatus, CancelOptions, CancelResult } from "../orchestrator/types";
import type { WorkflowInput } from "../primitives/make";

/**
 * Error thrown by workflow client operations.
 */
export class WorkflowClientError extends Error {
  readonly _tag = "WorkflowClientError";

  constructor(
    readonly operation: string,
    readonly cause: unknown,
  ) {
    super(
      `Workflow client ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Result from starting a workflow.
 */
export interface WorkflowRunResult {
  readonly id: string;
}

/**
 * Execution options for controlling workflow instance behavior.
 */
export interface ExecutionOptions {
  /**
   * Custom instance ID suffix. The final ID will be `{workflow}:{id}`.
   * If not provided, a random UUID is generated.
   */
  readonly id?: string;
}

/**
 * Type-safe workflow run request.
 * The `workflow` field determines the `input` type.
 */
export type WorkflowRunRequest<W extends WorkflowRegistry> = {
  [K in keyof W & string]: {
    readonly workflow: K;
    readonly input: WorkflowInput<W[K]>;
    readonly execution?: ExecutionOptions;
  };
}[keyof W & string];

/**
 * A workflow client instance with type-safe operations.
 */
export interface WorkflowClientInstance<W extends WorkflowRegistry> {
  /**
   * Run workflow synchronously (blocks until complete/pause/fail).
   */
  run(request: WorkflowRunRequest<W>): Effect.Effect<WorkflowRunResult, WorkflowClientError>;

  /**
   * Run workflow asynchronously (returns immediately).
   */
  runAsync(request: WorkflowRunRequest<W>): Effect.Effect<WorkflowRunResult, WorkflowClientError>;

  /**
   * Cancel a workflow by instance ID.
   */
  cancel(instanceId: string, options?: CancelOptions): Effect.Effect<CancelResult, WorkflowClientError>;

  /**
   * Get workflow status by instance ID.
   */
  status(instanceId: string): Effect.Effect<WorkflowStatus | undefined, WorkflowClientError>;

  /**
   * Get completed steps by instance ID.
   */
  completedSteps(instanceId: string): Effect.Effect<ReadonlyArray<string>, WorkflowClientError>;

  /**
   * Get workflow metadata by instance ID.
   */
  meta<T>(instanceId: string, key: string): Effect.Effect<T | undefined, WorkflowClientError>;
}

/**
 * Factory for creating workflow client instances.
 */
export interface WorkflowClientFactory<W extends WorkflowRegistry> {
  /**
   * Create a client instance from a Durable Object binding.
   */
  fromBinding(binding: DurableObjectNamespace): WorkflowClientInstance<W>;

  /**
   * Effect Tag for service pattern usage.
   */
  Tag: Context.Tag<WorkflowClientInstance<W>, WorkflowClientInstance<W>>;
}
```

### 3. Implement Client Instance (`client/instance.ts`)

```ts
import { Effect } from "effect";
import type { WorkflowRegistry, DurableWorkflowEngineInterface } from "../engine/types";
import type { WorkflowClientInstance, WorkflowRunRequest, WorkflowRunResult } from "./types";
import { WorkflowClientError } from "./types";

export function createClientInstance<W extends WorkflowRegistry>(
  binding: DurableObjectNamespace<DurableWorkflowEngineInterface<W>>,
): WorkflowClientInstance<W> {
  /**
   * Resolve instance ID with workflow namespace.
   * Format: `{workflow}:{identifier}`
   */
  const resolveInstanceId = (workflow: string, providedId?: string): string => {
    if (providedId) {
      return `${workflow}:${providedId}`;
    }
    return `${workflow}:${crypto.randomUUID()}`;
  };

  /**
   * Get stub from instance ID string.
   */
  const getStub = (instanceId: string) => {
    const id = binding.idFromName(instanceId);
    return binding.get(id);
  };

  return {
    run(request: WorkflowRunRequest<W>): Effect.Effect<WorkflowRunResult, WorkflowClientError> {
      return Effect.tryPromise({
        try: async () => {
          const { workflow, input, execution } = request;
          const instanceId = resolveInstanceId(workflow, execution?.id);
          const stub = getStub(instanceId);
          await stub.run({
            workflow,
            input,
            executionId: execution?.id,
          });
          return { id: instanceId };
        },
        catch: (e) => new WorkflowClientError("run", e),
      });
    },

    runAsync(request: WorkflowRunRequest<W>): Effect.Effect<WorkflowRunResult, WorkflowClientError> {
      return Effect.tryPromise({
        try: async () => {
          const { workflow, input, execution } = request;
          const instanceId = resolveInstanceId(workflow, execution?.id);
          const stub = getStub(instanceId);
          await stub.runAsync({
            workflow,
            input,
            executionId: execution?.id,
          });
          return { id: instanceId };
        },
        catch: (e) => new WorkflowClientError("runAsync", e),
      });
    },

    cancel(instanceId: string, options?) {
      return Effect.tryPromise({
        try: async () => {
          const stub = getStub(instanceId);
          return stub.cancel(options);
        },
        catch: (e) => new WorkflowClientError("cancel", e),
      });
    },

    status(instanceId: string) {
      return Effect.tryPromise({
        try: async () => {
          const stub = getStub(instanceId);
          return stub.getStatus();
        },
        catch: (e) => new WorkflowClientError("status", e),
      });
    },

    completedSteps(instanceId: string) {
      return Effect.tryPromise({
        try: async () => {
          const stub = getStub(instanceId);
          return stub.getCompletedSteps();
        },
        catch: (e) => new WorkflowClientError("completedSteps", e),
      });
    },

    meta<T>(instanceId: string, key: string) {
      return Effect.tryPromise({
        try: async () => {
          const stub = getStub(instanceId);
          return stub.getMeta(key) as Promise<T | undefined>;
        },
        catch: (e) => new WorkflowClientError("meta", e),
      });
    },
  };
}
```

### 4. Update Engine Factory (`engine/engine.ts`)

Update `createDurableWorkflows` to use the new client:

```ts
import { Context } from "effect";
import { createClientInstance } from "../client/instance";
import type { WorkflowClientFactory, WorkflowClientInstance } from "../client/types";

// In createDurableWorkflows function:
const WorkflowClient: WorkflowClientFactory<W> = {
  fromBinding(binding) {
    return createClientInstance(binding);
  },
  Tag: Context.GenericTag<WorkflowClientInstance<W>>("WorkflowClient"),
};
```

### 5. Update Exports (`index.ts`)

Add new client exports:

```ts
// Client
export {
  createClientInstance,
  WorkflowClientError,
  type WorkflowClientFactory,
  type WorkflowClientInstance,
  type WorkflowRunRequest,
  type WorkflowRunResult,
  type ExecutionOptions,
} from "./client";
```

### 6. Update Engine Types (`engine/types.ts`)

Remove old client types (moved to `client/types.ts`):
- Remove `WorkflowClientFactory`
- Remove `WorkflowClientInstance`
- Keep `DurableWorkflowEngineInterface` (still needed for DO)

Update `CreateDurableWorkflowsResult` to use new types.

## Migration for Users

Before:
```ts
const client = WorkflowClient.fromBinding(env.WORKFLOWS, { idFromName: orderId });
const result = await client.runAsync({ workflow: "processOrder", input: orderId });
```

After:
```ts
const client = WorkflowClient.fromBinding(env.WORKFLOWS);
const { id } = yield* client.runAsync({
  workflow: "processOrder",
  input: orderId,
  execution: { id: orderId },
});
```

Or with Effect.runPromise:
```ts
const client = WorkflowClient.fromBinding(env.WORKFLOWS);
const { id } = await Effect.runPromise(
  client.runAsync({
    workflow: "processOrder",
    input: orderId,
    execution: { id: orderId },
  })
);
```

## Key Differences from Current Design

1. **Instance ID handling**: Moved from `fromBinding` options to `execution.id` in request
2. **ID namespacing**: Automatic `{workflow}:{id}` format prevents collisions
3. **Query methods take instanceId**: `cancel`, `status`, `completedSteps`, `meta` now take instanceId as first arg
4. **Effect Tag**: Added for service pattern usage with Effect layers

## Files to Modify

1. Create `packages/workflow-v2/src/client/types.ts`
2. Create `packages/workflow-v2/src/client/instance.ts`
3. Create `packages/workflow-v2/src/client/index.ts`
4. Update `packages/workflow-v2/src/engine/types.ts`
5. Update `packages/workflow-v2/src/engine/engine.ts`
6. Update `packages/workflow-v2/src/index.ts`
7. Update `examples/effect-worker/src/workflows.ts` (usage example)
