# Workflow Client Implementation Plan

## Proposed API

```typescript
// Definition
const workflows = {
  processOrder: Workflow.make("processOrder", (orderId: string) => ...),
  greet: Workflow.make("greet", (input: { name: string }) => ...),
} as const;

// Create both exports from single call
export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows);

// Usage in handlers
const client = WorkflowClient.fromBinding(env.WORKFLOWS);

// Type-safe: workflow determines input type
yield* client.run({ workflow: "processOrder", input: "order-123" });                    // ✅
yield* client.run({ workflow: "processOrder", input: { wrong: true } });                // ❌ Type error
yield* client.runAsync({ workflow: "greet", input: { name: "World" } });                // ✅

// With custom execution ID
yield* client.run({ workflow: "processOrder", input: "order-123", execution: { id: "order-123" } });
```

---

## 1. Feasibility Analysis

### Type Safety Without `env.WORKFLOWS` Inference

**Fully feasible.** The key insight:

```typescript
const { Workflows, WorkflowClient } = createDurableWorkflows(workflows);
//                 ^^^^^^^^^^^^^^
//                 This carries type T from workflows parameter
```

The `WorkflowClient` returned is already typed to `typeof workflows`. When we call `WorkflowClient.fromBinding(env.WORKFLOWS)`, the binding is only used at runtime for the actual Durable Object connection. The type information comes from the `WorkflowClient` factory itself.

```typescript
// Simplified type flow:
createDurableWorkflows<T>(workflows: T) => {
  Workflows: DurableObjectClass<T>,
  WorkflowClient: WorkflowClientFactory<T>  // <-- T is captured here
}

// WorkflowClientFactory<T>.fromBinding returns WorkflowClientInstance<T>
// WorkflowClientInstance<T>.run<K>("workflow", input) uses T to type input
```

### TypeScript Implementation

```typescript
// Discriminated union for type-safe requests
type WorkflowRunRequest<W extends WorkflowRegistry> = {
  [K in keyof W & string]: {
    workflow: K;
    input: WorkflowInput<W[K]>;
    execution?: ExecutionOptions;
  };
}[keyof W & string];

interface WorkflowClientInstance<W extends WorkflowRegistry> {
  run(request: WorkflowRunRequest<W>): Effect.Effect<WorkflowRunResult, WorkflowClientError>;
}
```

When calling `client.run({ workflow: "processOrder", input: ... })`:
1. TypeScript narrows the union based on `workflow: "processOrder"`
2. The narrowed type requires `input: WorkflowInput<W["processOrder"]>`
3. `WorkflowInput<W["processOrder"]>` extracts `string`
4. `input` must be `string`

---

## 2. API Improvements

### Recommended API

#### A. Simple client creation
```typescript
const client = WorkflowClient.fromBinding(env.WORKFLOWS);
```

#### B. Object-based run/runAsync with optional `execution` config

```typescript
// Auto-generated random ID (default when no execution config)
yield* client.run({
  workflow: "processOrder",
  input: "order-123",
});
// Returns { id: "processOrder:{random-uuid}" }

// Custom instance ID via execution config
const { id } = yield* client.run({
  workflow: "processOrder",
  input: "order-123",
  execution: { id: "order-123" },
});
// Returns { id: "processOrder:order-123" }

// Future: concurrency control, buffering, etc.
yield* client.run({
  workflow: "processOrder",
  input: "order-123",
  execution: {
    id: "order-123",
    concurrency: { key: "user:456", max: 5 },
    buffer: { strategy: "latest" },
  },
});
```

**Naming alternatives for `execution`:**
| Name | Pros | Cons |
|------|------|------|
| `execution` | Clear intent, extensible for execution-level config | Slightly verbose |
| `instance` | Simple, refers to workflow instance | Could be confused with class instances |
| `handle` | Short, implies a reference/control point | Less intuitive |
| `dispatch` | Action-oriented, fits concurrency/routing | More about "how" than "which" |

**Recommendation:** `execution` - it clearly communicates "configuration for this execution" and naturally extends to concurrency, buffering, timeouts, etc.

#### C. ID Namespacing
All IDs are automatically prefixed with the workflow name (`{workflow}:{id}`). This prevents collisions when different workflows use the same user-provided ID.

```typescript
// Same user ID, different workflows = no collision
yield* client.run({ workflow: "processOrder", input: data, execution: { id: "123" } });
// → "processOrder:123"

yield* client.run({ workflow: "sendEmail", input: data, execution: { id: "123" } });
// → "sendEmail:123"
```

#### D. Query methods take the full namespaced ID
The ID returned from `run`/`runAsync` is passed directly to query methods:

```typescript
// Start workflow - get back namespaced ID
const { id } = yield* client.run({
  workflow: "processOrder",
  input: data,
  execution: { id: "order-123" },
});
// id = "processOrder:order-123"

// Query using the same ID
yield* client.status(id);
yield* client.completedSteps(id);
yield* client.meta(id, "key");
```

#### E. Effect Service Tag pattern (optional)
For apps that want dependency injection.

```typescript
// The returned WorkflowClient includes a Tag
const { Workflows, WorkflowClient } = createDurableWorkflows(workflows);

// Create layer easily
const WorkflowClientLive = (env: Env) =>
  Layer.succeed(WorkflowClient.Tag, WorkflowClient.fromBinding(env.WORKFLOWS));

// Use via service pattern
const handler = Effect.gen(function* () {
  const client = yield* WorkflowClient.Tag;
  yield* client.run({ workflow: "processOrder", input: "order-123" });
}).pipe(Effect.provide(WorkflowClientLive(env)));
```

### Final API Shape

```typescript
interface WorkflowClientFactory<W extends WorkflowRegistry> {
  /**
   * Create a client instance from a Durable Object binding.
   */
  fromBinding(
    binding: DurableObjectNamespace<DurableWorkflowInstance<W>>,
  ): WorkflowClientInstance<W>;

  /**
   * Effect Tag for service pattern usage.
   */
  Tag: Context.Tag<WorkflowClientInstance<W>, WorkflowClientInstance<W>>;
}

/**
 * Type-safe workflow run request.
 * Uses discriminated union so `workflow` determines the `input` type.
 */
type WorkflowRunRequest<W extends WorkflowRegistry> = {
  [K in keyof W & string]: {
    workflow: K;
    input: WorkflowInput<W[K]>;
    execution?: ExecutionOptions;
  };
}[keyof W & string];

interface WorkflowClientInstance<W extends WorkflowRegistry> {
  /**
   * Run workflow synchronously (blocks until complete/pause/fail).
   */
  run(
    request: WorkflowRunRequest<W>
  ): Effect.Effect<WorkflowRunResult, WorkflowClientError>;

  /**
   * Run workflow asynchronously (returns immediately).
   */
  runAsync(
    request: WorkflowRunRequest<W>
  ): Effect.Effect<WorkflowRunResult, WorkflowClientError>;

  /**
   * Get workflow status by instance ID.
   */
  status(
    instanceId: string
  ): Effect.Effect<WorkflowStatus | undefined, WorkflowClientError>;

  /**
   * Get completed steps by instance ID.
   */
  completedSteps(
    instanceId: string
  ): Effect.Effect<ReadonlyArray<string>, WorkflowClientError>;

  /**
   * Get workflow metadata by instance ID.
   */
  meta<T>(
    instanceId: string,
    key: string
  ): Effect.Effect<T | undefined, WorkflowClientError>;
}

interface ExecutionOptions {
  /**
   * Custom instance ID suffix. The final ID will be `{workflow}:{id}`.
   * If not provided, a random UUID is generated.
   *
   * Example: id: "order-123" with workflow "processOrder"
   *          → final ID: "processOrder:order-123"
   */
  id?: string;

  // Future options:
  // concurrency?: { key: string; max: number };
  // buffer?: { strategy: "latest" | "queue" };
  // timeout?: Duration;
}
```

---

## 3. Implementation Plan

### File Structure

```
packages/workflow/src/
├── client/
│   ├── index.ts           # Re-exports
│   ├── types.ts           # Client interfaces and types
│   ├── factory.ts         # createWorkflowClient factory
│   ├── instance.ts        # WorkflowClientInstance implementation
│   └── errors.ts          # WorkflowClientError class
├── engine.ts              # Modified to return { Workflows, WorkflowClient }
├── index.ts               # Updated exports
└── ...existing files
```

### Step-by-Step Implementation

#### Step 1: Create Client Types (`client/types.ts`)

```typescript
import { Context, Effect } from "effect";
import type {
  WorkflowRegistry,
  WorkflowInput,
  WorkflowStatus,
  DurableWorkflowInstance,
} from "@/types";

/**
 * Error thrown by workflow client operations.
 */
export class WorkflowClientError extends Error {
  readonly _tag = "WorkflowClientError";

  constructor(
    readonly operation: string,
    readonly cause: unknown,
  ) {
    super(`Workflow client ${operation} failed: ${cause}`);
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
 * Extensible for future features like concurrency control, buffering, etc.
 */
export interface ExecutionOptions {
  /**
   * Custom instance ID suffix. The final ID will be `{workflow}:{id}`.
   * If not provided, a random UUID is generated.
   */
  readonly id?: string;

  // Future options:
  // readonly concurrency?: { key: string; max: number };
  // readonly buffer?: { strategy: "latest" | "queue" };
}

/**
 * Type-safe workflow run request.
 * Uses discriminated union so `workflow` determines the `input` type.
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
  run(
    request: WorkflowRunRequest<W>,
  ): Effect.Effect<WorkflowRunResult, WorkflowClientError>;

  runAsync(
    request: WorkflowRunRequest<W>,
  ): Effect.Effect<WorkflowRunResult, WorkflowClientError>;

  status(
    instanceId: string,
  ): Effect.Effect<WorkflowStatus | undefined, WorkflowClientError>;

  completedSteps(
    instanceId: string,
  ): Effect.Effect<ReadonlyArray<string>, WorkflowClientError>;

  meta<T>(
    instanceId: string,
    key: string,
  ): Effect.Effect<T | undefined, WorkflowClientError>;
}

/**
 * Factory for creating workflow client instances.
 */
export interface WorkflowClientFactory<W extends WorkflowRegistry> {
  fromBinding(
    binding: DurableObjectNamespace<DurableWorkflowInstance<W>>,
  ): WorkflowClientInstance<W>;

  Tag: Context.Tag<WorkflowClientInstance<W>, WorkflowClientInstance<W>>;
}
```

#### Step 2: Create Client Instance (`client/instance.ts`)

```typescript
import { Effect } from "effect";
import type { WorkflowRegistry, DurableWorkflowInstance } from "@/types";
import type {
  WorkflowClientInstance,
  WorkflowRunRequest,
  WorkflowRunResult,
  WorkflowClientError,
} from "./types";

/**
 * Create a workflow client instance from a binding.
 */
export function createClientInstance<W extends WorkflowRegistry>(
  binding: DurableObjectNamespace<DurableWorkflowInstance<W>>,
): WorkflowClientInstance<W> {
  /**
   * Resolve the full instance ID, always namespaced by workflow name.
   *
   * ID Format: `{workflow}:{identifier}`
   *
   * This namespacing ensures:
   * 1. Different workflows can use the same user-provided ID without collision
   * 2. IDs are always deterministic and predictable
   * 3. Query methods (status, completedSteps, meta) work with the same ID format
   */
  const resolveInstanceId = (workflow: string, providedId?: string): string => {
    // Always prepend workflow name for namespacing
    if (providedId) {
      return `${workflow}:${providedId}`;
    }

    // No ID provided - generate random UUID
    const uniqueId = crypto.randomUUID();
    return `${workflow}:${uniqueId}`;
  };

  /**
   * Get stub from instance ID string.
   * Always uses idFromName - the instanceId is the full namespaced string.
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
          await stub.run({ workflow, input } as any);
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
          await stub.runAsync({ workflow, input } as any);
          return { id: instanceId };
        },
        catch: (e) => new WorkflowClientError("runAsync", e),
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
          return stub.getMeta<T>(key);
        },
        catch: (e) => new WorkflowClientError("meta", e),
      });
    },
  };
}
```

**Key Design Decisions:**

1. **Workflow-namespaced IDs**: All instance IDs follow the format `{workflow}:{identifier}`. This means:
   - `client.run({ workflow: "processOrder", input: data, execution: { id: "order-123" } })` → ID is `processOrder:order-123`
   - `client.run({ workflow: "greet", input: data, execution: { id: "order-123" } })` → ID is `greet:order-123` (no collision!)

2. **Random ID by default**: If no `execution.id` is provided, a random UUID is generated. This ensures every workflow run gets a unique instance.

3. **Consistent ID handling**: `getStub` always uses `idFromName()`. The instanceId string passed to query methods is the same namespaced string returned from `run`/`runAsync`.

4. **No try-catch guessing**: We don't try to detect ID formats. The contract is simple: IDs are always name-based strings.

#### Step 3: Create Client Factory (`client/factory.ts`)

```typescript
import { Context } from "effect";
import type { WorkflowRegistry, DurableWorkflowInstance } from "@/types";
import type { WorkflowClientFactory, WorkflowClientInstance } from "./types";
import { createClientInstance } from "./instance";

/**
 * Create a workflow client factory for a specific workflow registry.
 */
export function createWorkflowClientFactory<W extends WorkflowRegistry>(): WorkflowClientFactory<W> {
  // Create the Effect Tag for service pattern
  const Tag = Context.GenericTag<WorkflowClientInstance<W>>("WorkflowClient");

  return {
    fromBinding(
      binding: DurableObjectNamespace<DurableWorkflowInstance<W>>,
    ): WorkflowClientInstance<W> {
      return createClientInstance(binding);
    },

    Tag,
  };
}
```

#### Step 4: Create Client Index (`client/index.ts`)

```typescript
export { createWorkflowClientFactory } from "./factory";
export { createClientInstance } from "./instance";
export { WorkflowClientError } from "./types";
export type {
  WorkflowClientFactory,
  WorkflowClientInstance,
  WorkflowRunRequest,
  WorkflowRunResult,
  ExecutionOptions,
} from "./types";
```

#### Step 5: Modify Engine (`engine.ts`)

Change `createDurableWorkflows` return type:

```typescript
import { createWorkflowClientFactory } from "@/client";
import type { WorkflowClientFactory } from "@/client";

/**
 * Result of creating durable workflows.
 */
export interface CreateDurableWorkflowsResult<T extends WorkflowRegistry> {
  /**
   * Durable Object class to export for Cloudflare Workers.
   */
  Workflows: new (state: DurableObjectState, env: unknown) => DurableWorkflowInstance<T>;

  /**
   * Type-safe client factory for interacting with workflows.
   */
  WorkflowClient: WorkflowClientFactory<T>;
}

/**
 * Creates a Durable Object class and type-safe client for Effect-based workflows.
 */
export function createDurableWorkflows<const T extends WorkflowRegistry>(
  workflows: T,
  options?: CreateDurableWorkflowsOptions,
): CreateDurableWorkflowsResult<T> {
  // ... existing DurableWorkflowEngine class definition ...

  return {
    Workflows: DurableWorkflowEngine,
    WorkflowClient: createWorkflowClientFactory<T>(),
  };
}
```

#### Step 6: Update Package Exports (`index.ts`)

```typescript
// Workflow namespace (primary API)
export { Workflow } from "@/workflow";

// Engine
export {
  createDurableWorkflows,
  type CreateDurableWorkflowsOptions,
  type CreateDurableWorkflowsResult,
  type TypedWorkflowEngine,
  type WorkflowRunResult,
} from "@/engine";

// Client
export {
  WorkflowClientError,
  type WorkflowClientFactory,
  type WorkflowClientInstance,
  type WorkflowRunRequest,
  type ExecutionOptions,
} from "@/client";

// ... rest of existing exports ...
```

#### Step 7: Update Example (`examples/effect-worker/`)

**workflows.ts:**
```typescript
const workflows = {
  processOrder: processOrderWorkflow,
  greet: greetWorkflow,
  scheduled: scheduledWorkflow,
} as const;

export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows);
```

**routes/workflows.ts:**
```typescript
import { WorkflowClient } from "../workflows";

export const postProcessOrder = (request: Request, env: Env) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId") ?? `order-${Date.now()}`;

    const client = WorkflowClient.fromBinding(env.WORKFLOWS);

    // Use orderId as the execution ID
    // Final ID will be "processOrder:order-123"
    const { id } = yield* client.runAsync({
      workflow: "processOrder",
      input: orderId,
      execution: { id: orderId },
    });

    return Response.json({ success: true, workflowId: id, orderId });
  });

export const postGreet = (request: Request, env: Env) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "World";

    const client = WorkflowClient.fromBinding(env.WORKFLOWS);

    // No execution config = random ID generated
    const { id } = yield* client.run({
      workflow: "greet",
      input: { name },
    });

    return Response.json({ success: true, workflowId: id, name });
  });

export const getWorkflowStatus = (_request: Request, env: Env, instanceId: string) =>
  Effect.gen(function* () {
    const client = WorkflowClient.fromBinding(env.WORKFLOWS);

    // instanceId should be the full namespaced ID (e.g., "processOrder:order-123")
    const status = yield* client.status(instanceId);
    const completedSteps = yield* client.completedSteps(instanceId);

    return Response.json({ instanceId, status, completedSteps });
  });
```

---

## 4. Implementation Checklist

### Phase 1: Core Client
- [ ] Create `packages/workflow/src/client/` directory
- [ ] Create `client/types.ts` with interfaces and error class
- [ ] Create `client/instance.ts` with `createClientInstance`
- [ ] Create `client/factory.ts` with `createWorkflowClientFactory`
- [ ] Create `client/index.ts` with re-exports

### Phase 2: Engine Integration
- [ ] Add `CreateDurableWorkflowsResult` interface to `engine.ts`
- [ ] Modify `createDurableWorkflows` to return `{ Workflows, WorkflowClient }`
- [ ] Update package `index.ts` exports

### Phase 3: Example Update
- [ ] Update `examples/effect-worker/src/workflows.ts` to use new API
- [ ] Update `examples/effect-worker/src/routes/workflows.ts` to use client
- [ ] Test that type inference works correctly

### Phase 4: Tests
- [ ] Add unit tests for `WorkflowClientInstance` methods
- [ ] Add integration tests for full workflow lifecycle via client
- [ ] Test type inference (compile-time checks)

### Phase 5: Documentation
- [ ] Update JSDoc comments
- [ ] Update README with new usage pattern

---

## 5. Type Safety Verification

The implementation achieves full type safety through TypeScript's discriminated union:

```typescript
// 1. workflows is typed
const workflows = {
  processOrder: Workflow.make("processOrder", (orderId: string) => ...),
  greet: Workflow.make("greet", (input: { name: string }) => ...),
} as const;
// typeof workflows = { processOrder: DurableWorkflow<"processOrder", string, ...>, ... }

// 2. createDurableWorkflows captures the type
const { WorkflowClient } = createDurableWorkflows(workflows);
// WorkflowClient: WorkflowClientFactory<typeof workflows>

// 3. fromBinding preserves the type (binding is runtime-only)
const client = WorkflowClient.fromBinding(env.WORKFLOWS);
// client: WorkflowClientInstance<typeof workflows>

// 4. WorkflowRunRequest uses discriminated union
client.run({ workflow: "processOrder", input: "order-123" });
// workflow: "processOrder" → input must be string ✅

client.run({ workflow: "greet", input: { name: "World" } });
// workflow: "greet" → input must be { name: string } ✅

client.run({ workflow: "greet", input: "wrong" });
// ❌ Type error: string not assignable to { name: string }

client.run({ workflow: "unknown", input: "data" });
// ❌ Type error: "unknown" not assignable to "processOrder" | "greet"
```

---

## 6. Migration Path

For existing users:

**Before:**
```typescript
export const Workflows = createDurableWorkflows(workflows);

// Usage
const id = env.WORKFLOWS.idFromName(orderId);
const stub = env.WORKFLOWS.get(id);
await stub.run({ workflow: "processOrder", input: orderId });
```

**After:**
```typescript
export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows);

// Usage
const client = WorkflowClient.fromBinding(env.WORKFLOWS);
const { id } = yield* client.run({
  workflow: "processOrder",
  input: orderId,
  execution: { id: orderId },
});
// id = "processOrder:order-123" (namespaced)

// Query later using the full namespaced ID
const status = yield* client.status(id);
```

The Durable Object class (`Workflows`) works identically - only the export pattern changes. Existing direct stub usage still works.

---

## 7. ID Namespacing Summary

| Scenario | `execution.id` | Final ID |
|----------|----------------|----------|
| Custom ID | `"order-123"` | `"processOrder:order-123"` |
| No execution config | not provided | `"processOrder:{random-uuid}"` |

**Benefits:**
- No collisions between workflows using the same user ID
- Predictable ID format for debugging
- Simple contract: always use `idFromName()` internally
- Query methods work with the exact ID returned from `run`/`runAsync`
- Random UUID default ensures unique instances when no ID specified

**Future extensibility via `execution` config:**
```typescript
execution: {
  id: "order-123",
  concurrency: { key: "user:456", max: 5 },
  buffer: { strategy: "latest" },
  timeout: "5 minutes",
}
```
