# Event Enrichment at Tracker Service Level

## Problem

The current approach passes `env` and `serviceKey` through the call chain:

```
EventTrackerConfig → DurableWorkflowEngine → WorkflowContext → every createBaseEvent() call
```

This results in:
1. Every `createBaseEvent()` call requires 4 arguments: `(workflowId, workflowName, env, serviceKey)`
2. WorkflowContext must store and expose `env` and `serviceKey`
3. All call sites must remember to pass these values
4. Repetitive, error-prone code

## Proposed Solution

Capture `env` and `serviceKey` at the `EventTrackerService` level. The tracker service enriches events automatically when they are emitted.

### Key Insight

`env` and `serviceKey` are:
- Configuration values that never change during runtime
- Already present in `EventTrackerConfig`
- Only relevant when events are actually sent (i.e., when tracker is configured)

The tracker service is the natural place to inject these fields.

## Implementation

### 1. Keep EventTrackerConfig as-is

```typescript
// packages/workflow/src/tracker/types.ts
export interface EventTrackerConfig {
  readonly url: string;
  readonly accessToken: string;
  readonly env: string;        // Required
  readonly serviceKey: string; // Required
  readonly batch?: { ... };
  readonly retry?: { ... };
  readonly timeoutMs?: number;
}
```

### 2. Split Event Types: Internal vs Wire Format

```typescript
// packages/core/src/events.ts

// Internal event (what workflow code creates)
const InternalBaseEventFields = {
  eventId: Schema.String,
  timestamp: Schema.String,
  workflowId: Schema.String,
  workflowName: Schema.String,
};

// Wire format (what gets sent to the tracking service)
const WireBaseEventFields = {
  ...InternalBaseEventFields,
  env: Schema.String,
  serviceKey: Schema.String,
};

// Internal types (used by workflow code)
export type InternalWorkflowEvent = Schema.Schema.Type<typeof InternalWorkflowEventSchema>;

// Wire types (used by tracker when sending)
export type WorkflowEvent = Schema.Schema.Type<typeof WorkflowEventSchema>;
```

### 3. Update EventTrackerService Interface

```typescript
// packages/workflow/src/tracker/service.ts

export interface EventTrackerService {
  /**
   * Emit a single event.
   * The tracker automatically enriches with env and serviceKey.
   */
  readonly emit: (event: InternalWorkflowEvent) => Effect.Effect<void>;

  readonly flush: Effect.Effect<void>;
  readonly pendingCount: Effect.Effect<number>;
}
```

### 4. Enrich Events in the Tracker

```typescript
// packages/workflow/src/tracker/service.ts

export const createHttpBatchTracker = (
  config: EventTrackerConfig,
): Effect.Effect<EventTrackerService, never, Scope.Scope | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { env, serviceKey } = config;

    // ... queue setup ...

    /**
     * Enrich an internal event with env and serviceKey.
     */
    const enrichEvent = (event: InternalWorkflowEvent): WorkflowEvent => ({
      ...event,
      env,
      serviceKey,
    });

    /**
     * Send a batch of events via HTTP POST.
     */
    const sendBatch = (events: ReadonlyArray<InternalWorkflowEvent>): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (events.length === 0) return;

        // Enrich all events before sending
        const enrichedEvents = events.map(enrichEvent);

        yield* HttpClientRequest.post(config.url).pipe(
          HttpClientRequest.bodyJson({ events: enrichedEvents }),
          // ... rest of HTTP logic
        );
      });

    // Queue stores InternalWorkflowEvent, enrichment happens at send time
    const eventQueue = yield* Queue.sliding<InternalWorkflowEvent>(1000);

    // ... consumer logic uses sendBatch which enriches ...

    return {
      emit: (event: InternalWorkflowEvent): Effect.Effect<void> =>
        Queue.offer(eventQueue, event).pipe(Effect.asVoid),
      flush: Queue.offer(flushSignal, undefined).pipe(Effect.asVoid),
      pendingCount: Queue.size(eventQueue),
    };
  });
```

### 5. Simplify createBaseEvent

```typescript
// packages/core/src/events.ts

/**
 * Create the base fields for an internal event.
 * env and serviceKey are NOT included - the tracker adds them.
 */
export function createBaseEvent(
  workflowId: string,
  workflowName: string,
): InternalBaseEvent {
  return {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    workflowId,
    workflowName,
  };
}
```

### 6. Remove env/serviceKey from WorkflowContext

```typescript
// packages/workflow/src/services/workflow-context.ts

export interface WorkflowContextService {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly input: unknown;
  // NO env or serviceKey needed!
  // ...
}
```

### 7. Clean Up Engine

```typescript
// packages/workflow/src/engine.ts

export function createDurableWorkflows<const T extends WorkflowRegistry>(
  workflows: T,
  options?: CreateDurableWorkflowsOptions,
) {
  const trackerConfig = options?.tracker;
  // NO need to extract env/serviceKey here

  return class DurableWorkflowEngine extends DurableObject {
    // NO #env or #serviceKey fields needed

    readonly #trackerLayer = trackerConfig
      ? Layer.scoped(EventTracker, createHttpBatchTracker(trackerConfig))
          .pipe(Layer.provide(FetchHttpClient.layer))
      : undefined;

    // createWorkflowContext no longer needs env/serviceKey
    const workflowCtx = createWorkflowContext(
      workflowId,
      workflowName,
      input,
      this.ctx.storage,
    );
  };
}
```

## Benefits

1. **Simpler call sites**: `createBaseEvent(workflowId, workflowName)` - just 2 args
2. **No prop drilling**: `env`/`serviceKey` don't flow through WorkflowContext
3. **Single source of truth**: Config values stay in the tracker where they belong
4. **Separation of concerns**:
   - Workflow code creates events with workflow-specific data
   - Tracker enriches with service-level metadata
5. **Easier testing**: Mock events don't need env/serviceKey
6. **Type safety**: Internal events vs wire events are distinct types

## Migration Path

1. Create `InternalWorkflowEvent` type (subset without env/serviceKey)
2. Update `createBaseEvent` to return `InternalBaseEvent`
3. Update `EventTrackerService.emit` to accept `InternalWorkflowEvent`
4. Add `enrichEvent` function in tracker implementation
5. Remove `env`/`serviceKey` from `WorkflowContextService`
6. Remove `env`/`serviceKey` from `createWorkflowContext`
7. Clean up engine.ts - remove instance fields and captured variables
8. Update tests

## File Changes Summary

| File | Change |
|------|--------|
| `packages/core/src/events.ts` | Add InternalBaseEvent/InternalWorkflowEvent types, simplify createBaseEvent |
| `packages/workflow/src/tracker/service.ts` | Add enrichEvent, update emit signature |
| `packages/workflow/src/services/workflow-context.ts` | Remove env/serviceKey from interface and createWorkflowContext |
| `packages/workflow/src/engine.ts` | Remove env/serviceKey handling |
| `packages/workflow/src/workflow.ts` | Simplify createBaseEvent calls (2 args) |
| `packages/workflow/test/*.ts` | Update event fixtures |
