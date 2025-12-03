# Workflow Client API Design

This report explores different API design patterns for improving the developer experience when interacting with workflows from application code.

## Current Pain Points

Looking at the current usage in `examples/effect-worker/src/routes/workflows.ts`:

```typescript
// Current approach - lots of boilerplate
const id = env.WORKFLOWS.idFromName(orderId);
const stub = env.WORKFLOWS.get(id);
const result = yield* Effect.tryPromise({
  try: () => stub.run({ workflow: "processOrder", input: orderId }),
  catch: (e) => new Error(`Failed to start workflow: ${e}`),
});
```

**Issues:**
1. Manual ID generation from name
2. Manual stub retrieval
3. Wrapping promises in `Effect.tryPromise`
4. Workflow name passed as string (type-safe via discriminated union, but verbose)
5. Repeated boilerplate across all routes
6. No auto-generated IDs option

---

## Design Option 1: Service-Based Client

Create a `WorkflowClient` service that requires the Env binding.

### API Example

```typescript
import { WorkflowClient, makeWorkflowClient } from "@durable-effect/workflow";
import { workflows } from "./workflows";

// 1. Create the client service (typed to your workflows)
const MyWorkflowClient = makeWorkflowClient(workflows);
type MyWorkflowClient = WorkflowClient<typeof workflows>;

// 2. Create a Layer that provides it from Env
const WorkflowClientLive = Layer.effect(
  MyWorkflowClient,
  Effect.gen(function* () {
    const env = yield* EnvService; // User provides this
    return MyWorkflowClient.make(env.WORKFLOWS);
  })
);

// 3. Use in route handlers
const postProcessOrder = Effect.gen(function* () {
  const client = yield* MyWorkflowClient;

  // Type-safe, effectful, auto-generates ID
  const { id } = yield* client.processOrder.run("order-123");

  // Or with custom ID
  const { id } = yield* client.processOrder.run("order-123", { id: "custom-id" });

  // Async execution
  const { id } = yield* client.processOrder.runAsync("order-123");

  // Get status by ID
  const status = yield* client.processOrder.getStatus("workflow-id");

  // Get by ID for other operations
  const workflow = client.processOrder.get("workflow-id");
  const steps = yield* workflow.getCompletedSteps();
});
```

### Pros
- **Full Effect integration** - errors tracked in Effect's error channel
- **Service pattern** - familiar to Effect users, composable via Layers
- **Type-safe workflow access** - `client.processOrder` vs `client.run("processOrder", ...)`
- **Chainable workflow-specific API** - each workflow has its own typed methods
- **Clean separation** - client construction vs usage

### Cons
- **Layer setup required** - users must create and provide the Layer
- **Service boilerplate** - need to define the service, create Layer, etc.
- **Requires EnvService** - users need to also have their Env as a service

---

## Design Option 2: Direct Accessor Functions

Provide standalone functions that take the binding directly.

### API Example

```typescript
import { Workflows, run, runAsync, getStatus } from "@durable-effect/workflow";
import { workflows } from "./workflows";

// Type the binding in Env
type Env = { WORKFLOWS: Workflows<typeof workflows> };

// Use directly in handlers - pass binding each time
const postProcessOrder = (request: Request, env: Env) =>
  Effect.gen(function* () {
    // Type-safe, effectful, auto-generates ID
    const { id } = yield* run(env.WORKFLOWS, "processOrder", "order-123");

    // With options
    const { id } = yield* run(env.WORKFLOWS, "processOrder", "order-123", {
      id: "custom-id",
    });

    // Async
    const { id } = yield* runAsync(env.WORKFLOWS, "processOrder", "order-123");

    // Get status
    const status = yield* getStatus(env.WORKFLOWS, "workflow-id");
  });
```

### Pros
- **Zero setup** - just import and use
- **Simple mental model** - functions over services
- **No Layer complexity** - works in any Effect context
- **Explicit dependency** - binding passed to each call

### Cons
- **Repetitive binding passing** - `env.WORKFLOWS` everywhere
- **Workflow name as string** - less discoverable than `client.processOrder`
- **No workflow-specific chaining** - can't do `processOrder.run(...)`
- **Less composable** - harder to mock/test without dependency injection

---

## Design Option 3: Binding Wrapper Class

Create a class that wraps the binding and provides typed methods.

### API Example

```typescript
import { WorkflowClient } from "@durable-effect/workflow";
import { workflows } from "./workflows";

// Extend Env to include the wrapper type
type Env = { WORKFLOWS: WorkflowClient<typeof workflows> };

// In handler setup (one-time wrapping)
const app = new Hono<{ Bindings: Env }>();

app.post("/process/:orderId", async (c) => {
  const client = new WorkflowClient(c.env.WORKFLOWS_BINDING, workflows);

  // Now effectful and type-safe
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { id } = yield* client.processOrder.run("order-123");
      return { id };
    })
  );
});

// OR: middleware that attaches client to context
const withWorkflows = (binding: DurableObjectNamespace) => {
  return new WorkflowClient(binding, workflows);
};
```

### Pros
- **Familiar OOP pattern** - class instantiation
- **No Layer setup** - simpler for non-Effect-heavy apps
- **Type-safe workflow access** - `client.processOrder`
- **Easy to understand** - wraps the binding, adds methods

### Cons
- **Class instantiation per request** - or middleware pattern needed
- **Mixes paradigms** - class usage in Effect context
- **No built-in dependency injection** - harder to test

---

## Design Option 4: Module Pattern with Currying

Provide a factory that creates typed accessors from the binding.

### API Example

```typescript
import { createWorkflowAccessors } from "@durable-effect/workflow";
import { workflows } from "./workflows";

// Create accessors once at module level
const workflowAccessors = createWorkflowAccessors(workflows);

// Usage in handlers
const postProcessOrder = (request: Request, env: Env) =>
  Effect.gen(function* () {
    // Get typed accessor bound to this request's env
    const { processOrder, greet, scheduled } = workflowAccessors(env.WORKFLOWS);

    // All methods are effectful
    const { id } = yield* processOrder.run("order-123");
    const status = yield* processOrder.getStatus(id);

    // With options
    yield* processOrder.run("order-123", {
      id: "custom-id",
      // Future: concurrency options
      concurrencyKey: "user:123",
      maxConcurrent: 5,
    });
  });
```

### Pros
- **Two-stage binding** - define workflows once, bind per-request
- **Type-safe with discovery** - destructure workflow names
- **Effectful throughout** - all methods return Effects
- **Future-proof options** - easy to add concurrency config

### Cons
- **Extra function call** - `accessors(env.WORKFLOWS)` per request
- **Module-level definition** - workflows must be importable
- **Middle ground complexity** - not as simple as Option 2, not as structured as Option 1

---

## Design Option 5: Hybrid - Effect Tag with Direct Access

Use Effect's Tag system but make it easy to construct from binding.

### API Example

```typescript
import { WorkflowEngine } from "@durable-effect/workflow";
import { workflows } from "./workflows";

// The engine is a tagged service
const MyEngine = WorkflowEngine.makeTag(workflows);

// Easy Layer construction from binding
const MyEngineLive = (env: Env) =>
  Layer.succeed(MyEngine, WorkflowEngine.fromBinding(env.WORKFLOWS, workflows));

// Usage in handlers - standard Effect pattern
const postProcessOrder = Effect.gen(function* () {
  const engine = yield* MyEngine;

  // Direct property access for each workflow
  const { id } = yield* engine.processOrder.run("order-123");

  // Status and other operations
  const status = yield* engine.processOrder.status(id);
  const steps = yield* engine.processOrder.completedSteps(id);

  // Future: batch operations
  yield* engine.runMany([
    { workflow: "processOrder", input: "order-1" },
    { workflow: "processOrder", input: "order-2" },
  ]);
}).pipe(Effect.provide(MyEngineLive(env)));

// Or with a request context layer
const handleRequest = (request: Request, env: Env) =>
  Effect.gen(function* () {
    const engine = yield* MyEngine;
    // ...
  }).pipe(Effect.provide(MyEngineLive(env)));
```

### Pros
- **Best of both worlds** - Effect service pattern + easy construction
- **Clean Layer creation** - one-liner from binding
- **Type-safe workflow access** - `engine.processOrder`
- **Testable** - can provide mock engine easily
- **Standard Effect patterns** - familiar to Effect users

### Cons
- **Still requires Layer** - some ceremony involved
- **Per-request Layer** - unless using request context pattern

---

## Design Option 6: Namespace Pattern (Similar to Current Workflow.*)

Extend the existing `Workflow` namespace with client operations.

### API Example

```typescript
import { Workflow } from "@durable-effect/workflow";

// Registry definition (existing)
const workflows = {
  processOrder: Workflow.make("processOrder", (orderId: string) => ...),
  greet: Workflow.make("greet", (input: { name: string }) => ...),
} as const;

// Create engine (existing)
export const Workflows = Workflow.createEngine(workflows);

// NEW: Create client from binding
const client = Workflow.client(env.WORKFLOWS, workflows);

// Or with Tag pattern
const ClientTag = Workflow.ClientTag(workflows);
const ClientLive = Workflow.clientLayer(env.WORKFLOWS, workflows);

// Usage
const postProcessOrder = Effect.gen(function* () {
  const client = yield* ClientTag;

  // Consistent with workflow definition pattern
  const { id } = yield* client.processOrder.run("order-123");
});
```

### Pros
- **Consistent with existing API** - extends `Workflow` namespace
- **Single import** - everything from one place
- **Familiar patterns** - mirrors `Workflow.make`, `Workflow.step`, etc.

### Cons
- **Namespace can get large** - mixing definition and client APIs
- **Less flexible** - tightly coupled to the package structure

---

## Recommended Approach: Option 4 + Option 5 Hybrid

Combine the simplicity of curried accessors with optional Effect service integration.

### Final API Design

```typescript
import { Workflow, WorkflowEngine } from "@durable-effect/workflow";

// 1. Define workflows (existing API)
const workflows = {
  processOrder: Workflow.make("processOrder", (orderId: string) => ...),
  greet: Workflow.make("greet", (input: { name: string }) => ...),
} as const;

// 2. Create the Durable Object (existing API)
export const Workflows = Workflow.createEngine(workflows);

// 3. Create typed client factory
const Client = WorkflowEngine.client(workflows);

// =============================================================================
// Usage Option A: Direct (simple cases)
// =============================================================================

const handleSimple = (env: Env) =>
  Effect.gen(function* () {
    const client = Client.from(env.WORKFLOWS);

    // Auto-generated ID
    const { id } = yield* client.processOrder.run("order-123");

    // Custom ID
    const { id } = yield* client.processOrder.run("order-123", { id: "my-id" });

    // Background execution
    yield* client.processOrder.runAsync("order-123");

    // Query operations
    const status = yield* client.processOrder.status(id);
    const steps = yield* client.processOrder.completedSteps(id);
  });

// =============================================================================
// Usage Option B: Service Pattern (complex apps)
// =============================================================================

// Create service tag
const WorkflowService = Client.Tag;

// Create layer (could come from config, etc.)
const WorkflowServiceLive = (env: Env) =>
  Layer.succeed(WorkflowService, Client.from(env.WORKFLOWS));

// Use in deeply nested Effect code
const someDeepEffect = Effect.gen(function* () {
  const client = yield* WorkflowService;
  yield* client.greet.run({ name: "World" });
});

// Provide at edge
const handleRequest = (request: Request, env: Env) =>
  mainProgram.pipe(Effect.provide(WorkflowServiceLive(env)));

// =============================================================================
// Future: Concurrency Control
// =============================================================================

yield* client.processOrder.run("order-123", {
  // Control workflow instance identity
  id: "custom-id",
  // OR auto-generate: id: undefined (default)

  // Future: Concurrency limiting
  concurrency: {
    key: "user:456",      // Group workflows by this key
    maxConcurrent: 5,     // Max 5 running at once for this key
    queueBehavior: "fifo" // What to do when limit reached
  }
});
```

### Implementation Structure

```
packages/workflow/src/
├── client/
│   ├── index.ts          # Client factory and types
│   ├── accessor.ts       # Per-workflow accessor (run, status, etc.)
│   └── service.ts        # Effect Tag integration
├── engine.ts             # Existing Durable Object creation
├── workflow.ts           # Existing Workflow.make, step, etc.
└── index.ts              # Exports both
```

---

## Method Signatures

### Core Operations

```typescript
interface WorkflowAccessor<Input> {
  /**
   * Run workflow synchronously (blocks until complete/pause/fail)
   */
  run(
    input: Input,
    options?: RunOptions
  ): Effect.Effect<WorkflowRunResult, WorkflowError>;

  /**
   * Run workflow asynchronously (returns immediately, runs via alarm)
   */
  runAsync(
    input: Input,
    options?: RunOptions
  ): Effect.Effect<WorkflowRunResult, WorkflowError>;

  /**
   * Get workflow status by instance ID
   */
  status(
    instanceId: string
  ): Effect.Effect<WorkflowStatus | undefined, WorkflowError>;

  /**
   * Get completed steps by instance ID
   */
  completedSteps(
    instanceId: string
  ): Effect.Effect<ReadonlyArray<string>, WorkflowError>;

  /**
   * Get workflow metadata by instance ID
   */
  getMeta<T>(
    instanceId: string,
    key: string
  ): Effect.Effect<T | undefined, WorkflowError>;

  /**
   * Get raw stub for advanced operations
   */
  stub(instanceId: string): DurableObjectStub;
}

interface RunOptions {
  /** Custom instance ID (auto-generated if not provided) */
  id?: string;

  /** Future: Concurrency control */
  concurrency?: ConcurrencyOptions;
}

interface ConcurrencyOptions {
  /** Key for grouping concurrent workflows */
  key: string;

  /** Maximum concurrent workflows for this key */
  maxConcurrent: number;

  /** Behavior when limit reached: queue, reject, or replace oldest */
  onLimit?: "queue" | "reject" | "replace";
}
```

---

## Platform Abstraction

To support engines beyond Cloudflare, the client should work with an abstraction:

```typescript
// Platform-agnostic interface
interface WorkflowBinding<W extends WorkflowRegistry> {
  /**
   * Get or create workflow instance by ID
   */
  getInstance(id: string): WorkflowInstance<W>;

  /**
   * Generate a new unique ID
   */
  generateId(): string;

  /**
   * Generate ID from a name (deterministic)
   */
  idFromName(name: string): string;
}

// Cloudflare implementation
const cloudflareBinding = <W extends WorkflowRegistry>(
  namespace: DurableObjectNamespace<DurableWorkflowInstance<W>>
): WorkflowBinding<W> => ({
  getInstance: (id) => namespace.get(namespace.idFromString(id)),
  generateId: () => namespace.newUniqueId().toString(),
  idFromName: (name) => namespace.idFromName(name).toString(),
});

// Future: Other implementations
const inMemoryBinding = ...
const postgresBinding = ...
```

---

## Summary

| Option | Setup Complexity | Type Safety | Effect Integration | Testability | Platform Flexibility |
|--------|-----------------|-------------|-------------------|-------------|---------------------|
| 1. Service-Based | High | Excellent | Native | Excellent | Good |
| 2. Direct Functions | Low | Good | Manual | Moderate | Good |
| 3. Wrapper Class | Low | Excellent | Manual | Moderate | Moderate |
| 4. Curried Factory | Medium | Excellent | Native | Good | Good |
| 5. Hybrid Tag | Medium | Excellent | Native | Excellent | Good |
| 6. Namespace | Medium | Excellent | Native | Good | Good |

**Recommendation**: Option 4 + 5 Hybrid provides the best balance:
- Simple for basic usage (just `Client.from(binding)`)
- Full Effect service pattern for complex apps
- Type-safe workflow access via property names
- All methods return Effects with proper error typing
- Clean abstraction layer for future platform support
- Extensible for concurrency control and other features
