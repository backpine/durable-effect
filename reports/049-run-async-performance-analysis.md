# `runAsync` Performance Analysis

## Problem Statement

When calling `client.runAsync()`, the operation takes several seconds before returning, even though `runAsync` is supposed to return immediately after queuing the workflow.

```ts
const { id } = yield* client.runAsync({
  workflow: "processOrder",
  input: orderId,
  execution: { id: orderId },
});
// Takes ~2-3+ seconds to return
```

## Root Cause Analysis

### Call Flow

```
client.runAsync()
    │
    ▼
binding.get(id)                     // 1. Get DO stub
    │
    ▼
stub.runAsync()                     // 2. RPC to Durable Object
    │
    ▼
DurableWorkflowEngine.constructor() // 3. ⚠️ BLOCKING: Recovery check
    │
    ▼
DurableWorkflowEngine.runAsync()    // 4. Queue workflow
    │
    ▼
flushEvents                         // 5. HTTP call to tracker
    │
    ▼
return { id }
```

### Identified Bottlenecks

#### 1. **Constructor Recovery Check (MAJOR)**

Location: `engine.ts:139-153`

```ts
constructor(state: DurableObjectState, env: unknown) {
  super(state, env as never);

  // ...layer setup...

  // ⚠️ BLOCKING OPERATION IN CONSTRUCTOR
  state.blockConcurrencyWhile(async () => {
    await this.#runEffect(
      Effect.gen(function* () {
        const recovery = yield* RecoveryManager;
        const result = yield* recovery.checkAndScheduleRecovery();
        // ...
      }),
    );
  });
}
```

**Problem:** `blockConcurrencyWhile` runs in the constructor and blocks ALL incoming requests until it completes. This includes:

1. Building the full Effect layer stack (multiple services)
2. Storage reads to check workflow state
3. Recoverability calculation

**Impact:** Every cold start pays this cost, even for simple status queries.

#### 2. **Effect Layer Construction (MODERATE)**

Location: `engine.ts:104-136`

```ts
this.#orchestratorLayer = WorkflowOrchestratorLayer<W>().pipe(
  Layer.provideMerge(WorkflowRegistryLayer(workflows)),
  Layer.provideMerge(WorkflowExecutorLayer),
  Layer.provideMerge(RecoveryManagerLayer(options?.recovery)),
  Layer.provideMerge(WorkflowStateMachineLayer),
  Layer.provideMerge(purgeLayer),
  Layer.provideMerge(trackerLayer),
  Layer.provideMerge(this.#runtimeLayer),
);
```

**Problem:** The layer is constructed on every DO instantiation. While Effect layers are efficient, composing 7+ layers has overhead.

**Impact:** ~50-100ms overhead per cold start.

#### 3. **Recovery Check Storage Reads (MODERATE)**

Location: `machine.ts:233-264` (in `getState`)

```ts
const [
  workflowName,
  input,
  executionId,
  completedSteps,
  completedPauseIndex,
  pendingResumeAt,
  recoveryAttempts,
  cancelled,
  cancelReason,
] = yield* Effect.all([
  storage.get<string>(KEYS.name),
  storage.get<unknown>(KEYS.input),
  storage.get<string>(KEYS.executionId),
  storage.get<string[]>(KEYS.completedSteps),
  // ... 5 more storage.get calls
]);
```

**Problem:** 9+ individual storage reads, even though `Effect.all` parallelizes them, there's still latency.

**Impact:** ~100-300ms depending on DO storage latency.

#### 4. **Event Flush HTTP Call (MODERATE)**

Location: `engine.ts:187`

```ts
async runAsync(call: WorkflowCall<W>): Promise<{ id: string }> {
  const result = await this.#runEffect(
    Effect.gen(function* () {
      const orchestrator = yield* WorkflowOrchestrator;
      const result = yield* orchestrator.queue(call);
      yield* flushEvents;  // ⚠️ HTTP call before returning
      return result;
    }),
  );
  return { id: result.id };
}
```

**Problem:** `flushEvents` makes an HTTP call to the tracker endpoint before returning. This blocks the response.

**Impact:** ~200-500ms per HTTP call, with retry logic potentially adding more.

#### 5. **Queue Operation Storage Writes (MINOR)**

Location: `orchestrator.ts:269-291`

```ts
queue: (call) =>
  Effect.gen(function* () {
    // Validate workflow exists
    yield* registry.get(call.workflow);

    // Check for existing workflow (storage read)
    const existingStatus = yield* stateMachine.getStatus();

    // Initialize state (batch write: 9 keys)
    yield* stateMachine.initialize(...);

    // Transition to Queued (storage write)
    yield* stateMachine.applyTransition(new Queue({ input: call.input }));

    // Emit event (buffer write)
    yield* emitEvent({ type: "workflow.queued", ... });

    // Schedule alarm (DO alarm API)
    yield* scheduler.schedule(now + 1);
  }),
```

**Problem:** Multiple storage operations even for the "fast path" queue operation.

**Impact:** ~50-100ms total.

---

## Performance Breakdown (Estimated)

| Phase | Cold Start | Warm |
|-------|-----------|------|
| DO Stub Resolution | ~10ms | ~10ms |
| Constructor Layer Build | ~50ms | 0ms |
| Constructor Recovery Check | ~300-500ms | 0ms |
| Queue Operation | ~100ms | ~100ms |
| Event Flush HTTP | ~200-500ms | ~200-500ms |
| **Total** | **~700-1200ms** | **~300-600ms** |

With network latency, cold region routing, and retries, this can easily reach 2-3+ seconds.

---

## Recommendations

### 1. **Make Recovery Check Lazy (HIGH IMPACT)**

Don't run recovery check in the constructor. Instead, run it only when:
- An alarm fires
- A status query is made
- The workflow is actually executed

```ts
constructor(state: DurableObjectState, env: unknown) {
  super(state, env as never);
  this.#state = state;
  // DON'T run recovery check here
  // Layer construction can stay
}

async runAsync(call: WorkflowCall<W>): Promise<{ id: string }> {
  // Recovery check is NOT needed for queue operation
  // The alarm handler will check recovery when it fires
  return this.#runEffect(
    Effect.gen(function* () {
      const orchestrator = yield* WorkflowOrchestrator;
      return yield* orchestrator.queue(call);
    }),
  );
}
```

**Why this works:** For `runAsync`, we're creating a NEW workflow or returning early if it exists. Recovery only matters for workflows that were interrupted mid-execution.

### 2. **Fire-and-Forget Event Flushing (HIGH IMPACT)**

Don't wait for event flush before returning from `runAsync`:

```ts
async runAsync(call: WorkflowCall<W>): Promise<{ id: string }> {
  const result = await this.#runEffect(
    Effect.gen(function* () {
      const orchestrator = yield* WorkflowOrchestrator;
      return yield* orchestrator.queue(call);
    }),
  );

  // Fire and forget - don't await
  this.#runEffect(flushEvents).catch(() => {
    // Events will be retried on next operation or lost
    // This is acceptable for observability data
  });

  return { id: result.id };
}
```

**Alternative:** Use `waitUntil` if available:

```ts
async runAsync(call: WorkflowCall<W>): Promise<{ id: string }> {
  const result = await this.#runEffect(...);

  // Extend DO lifetime to flush events without blocking response
  this.ctx.waitUntil(this.#runEffect(flushEvents));

  return { id: result.id };
}
```

### 3. **Batch Storage Reads (MEDIUM IMPACT)**

Replace multiple `storage.get` calls with a single `storage.list` or batch get:

```ts
// Current: 9 individual reads
const [name, input, executionId, ...] = yield* Effect.all([
  storage.get(KEYS.name),
  storage.get(KEYS.input),
  // ...
]);

// Better: Single batch read
const keys = [KEYS.name, KEYS.input, KEYS.executionId, ...];
const values = yield* storage.getBatch(keys);
```

Or use `storage.list({ prefix: "workflow:" })` since all keys share a prefix.

### 4. **Lazy Layer Construction (MEDIUM IMPACT)**

Build layers lazily on first use:

```ts
class DurableWorkflowEngine extends DurableObject {
  #orchestratorLayer: Layer.Layer<...> | null = null;

  get orchestratorLayer() {
    if (!this.#orchestratorLayer) {
      this.#orchestratorLayer = this.#buildLayer();
    }
    return this.#orchestratorLayer;
  }
}
```

Or use a memoized layer builder.

### 5. **Separate Read-Only vs Write Paths (MEDIUM IMPACT)**

For `runAsync`, we don't need the full layer stack. Create a minimal "queue-only" path:

```ts
async runAsync(call: WorkflowCall<W>): Promise<{ id: string }> {
  // Fast path: minimal dependencies
  const storage = createDOStorageAdapter(this.state.storage);

  // Check if exists (single read)
  const existing = await storage.get("workflow:status");
  if (existing) {
    return { id: this.state.id.toString() };
  }

  // Initialize (batch write)
  await this.state.storage.put({
    "workflow:status": new Queued({ queuedAt: Date.now() }),
    "workflow:name": call.workflow,
    "workflow:input": call.input,
    // ...
  });

  // Schedule alarm
  await this.state.storage.setAlarm(Date.now() + 1);

  return { id: this.state.id.toString() };
}
```

This bypasses the entire Effect layer for the critical path.

### 6. **Cache Layer Across Requests (LOW IMPACT)**

Effect layers are already fairly efficient, but consider caching at the module level:

```ts
// Module-level cache
let cachedLayer: Layer.Layer<...> | null = null;

function getLayer(options: CreateDurableWorkflowsOptions) {
  if (!cachedLayer) {
    cachedLayer = buildLayer(options);
  }
  return cachedLayer;
}
```

### 7. **Remove Recovery from Constructor Entirely (HIGH IMPACT)**

The recovery check can be moved to the alarm handler:

```ts
async alarm(): Promise<void> {
  await this.#runEffect(
    Effect.gen(function* () {
      const status = yield* stateMachine.getStatus();

      // If status is Running and alarm fired, this IS recovery
      if (status?._tag === "Running") {
        const recovery = yield* RecoveryManager;
        yield* recovery.executeRecovery();
      }

      // Normal alarm handling
      const orchestrator = yield* WorkflowOrchestrator;
      yield* orchestrator.handleAlarm();
    }),
  );
}
```

This way:
- `runAsync` is fast (no recovery check)
- `run` can optionally check recovery (for resuming)
- `alarm` handles recovery naturally

---

## Recommended Implementation Priority

1. **Remove recovery check from constructor** - Biggest impact, lowest risk
2. **Fire-and-forget event flushing** - Big impact, acceptable trade-off for observability
3. **Batch storage reads** - Medium impact, easy to implement
4. **Optimize queue path** - Medium impact, more invasive

## Expected Results

| Change | Cold Start Reduction | Warm Reduction |
|--------|---------------------|----------------|
| Lazy recovery | -300-500ms | 0ms |
| Fire-and-forget flush | -200-500ms | -200-500ms |
| Batch storage reads | -50-100ms | -50-100ms |
| **Total** | **-550-1100ms** | **-250-600ms** |

With these optimizations, `runAsync` should return in **~100-300ms** on cold start and **~50-100ms** warm.

---

## Additional Considerations

### Observability Trade-offs

Fire-and-forget event flushing means:
- Events may be lost if DO crashes immediately after returning
- Events will be delayed until next flush opportunity
- Consider: Buffer events and flush on alarm, or use `waitUntil`

### Recovery Correctness

Moving recovery out of constructor requires ensuring:
- Alarms are always scheduled for workflows in progress
- Recovery detection still works on alarm fire
- No race conditions between queue and recovery

### Testing Impact

These changes may affect tests that rely on synchronous event emission. Ensure test utilities account for async event delivery.
