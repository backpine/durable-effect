# WorkerPool Queue Management: Deep Technical Design

## Executive Summary

This document provides an exhaustive technical design for managing event queues inside Durable Object instances for the WorkerPool primitive. It addresses the critical constraints of Cloudflare Durable Objects and defines a safe, correct implementation for at-least-once event processing.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Durable Object Constraints](#durable-object-constraints)
3. [Storage Design](#storage-design)
4. [Queue Data Structures](#queue-data-structures)
5. [Processing Model](#processing-model)
6. [Atomic Operations](#atomic-operations)
7. [At-Least-Once Delivery](#at-least-once-delivery)
8. [High Throughput Handling](#high-throughput-handling)
9. [Failure Scenarios](#failure-scenarios)
10. [Handler Implementation](#handler-implementation)
11. [Testing Strategy](#testing-strategy)

---

## 1. Architecture Overview

### Instance Distribution

When a WorkerPool is defined with `concurrency: N`, the system creates N Durable Object instances:

```
WorkerPool "webhookProcessor" (concurrency: 3)
    │
    ├── DO Instance: workerPool:webhookProcessor:0
    ├── DO Instance: workerPool:webhookProcessor:1
    └── DO Instance: workerPool:webhookProcessor:2
```

**Key Points:**
- Each DO instance has its own independent storage namespace
- Each DO instance has ONE alarm slot
- Each DO instance processes events sequentially (one at a time)
- Client routes events to instances (round-robin or partition key)

### Data Flow

```
                           ┌─────────────────────────────┐
                           │         CLIENT              │
                           │  (runs in Worker request)   │
                           └──────────┬──────────────────┘
                                      │
                           ┌──────────▼──────────────┐
                           │     ROUTING LAYER       │
                           │  - Round-robin counter  │
                           │  - Partition key hash   │
                           └──────────┬──────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
              ▼                       ▼                       ▼
    ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
    │ DO Instance 0   │     │ DO Instance 1   │     │ DO Instance 2   │
    │                 │     │                 │     │                 │
    │ ┌─────────────┐ │     │ ┌─────────────┐ │     │ ┌─────────────┐ │
    │ │   Storage   │ │     │ │   Storage   │ │     │ │   Storage   │ │
    │ │  (Queue)    │ │     │ │  (Queue)    │ │     │ │  (Queue)    │ │
    │ └─────────────┘ │     │ └─────────────┘ │     │ └─────────────┘ │
    │                 │     │                 │     │                 │
    │ ┌─────────────┐ │     │ ┌─────────────┐ │     │ ┌─────────────┐ │
    │ │   Alarm     │ │     │ │   Alarm     │ │     │ │   Alarm     │ │
    │ │ (1 slot)    │ │     │ │ (1 slot)    │ │     │ │ (1 slot)    │ │
    │ └─────────────┘ │     │ └─────────────┘ │     │ └─────────────┘ │
    └─────────────────┘     └─────────────────┘     └─────────────────┘
```

---

## 2. Durable Object Constraints

Understanding DO constraints is critical for a correct implementation.

### 2.1 Single Alarm Constraint

**Constraint:** Each DO instance can have exactly ONE pending alarm at a time.

**Implications:**
- Cannot schedule separate alarms for each pending event
- Cannot have both a "process next" alarm and a "retry" alarm
- Must use the single alarm to drive all processing

**Solution:** Use the alarm as a "wake-up" mechanism. When the alarm fires:
1. Check current state (paused? queue empty? processing?)
2. Process the next event OR schedule a retry delay
3. Set next alarm (immediate or delayed)

### 2.2 Storage Characteristics

| Property | Value | Implication |
|----------|-------|-------------|
| Max key size | 2KB | Use compact key naming |
| Max value size | 128KB | Store events individually |
| Total storage | 10GB | Can store ~80,000 128KB events |
| Consistency | Strong | Single-threaded execution |
| Transactions | Atomic within request | Use putBatch for multi-key writes |

### 2.3 Execution Model

**Single-threaded:** Only one request or alarm handler runs at a time per DO instance.

**Implications:**
- No concurrent enqueue + process race conditions within an instance
- State mutations during execution are safe
- However, a request CAN start while an alarm is scheduled (interleaved)

### 2.4 Request vs Alarm Interleaving

```
Timeline:
─────────────────────────────────────────────────────────────►
     │           │                   │           │
   Alarm     Request            Request       Alarm
  (process)  (enqueue)          (enqueue)   (process)
     │           │                   │           │
     └───────────┴───────────────────┴───────────┘
                     │
        Requests can arrive while alarm is scheduled
        but execution is serialized
```

**Critical insight:** When a request (enqueue) completes, we must check if an alarm is needed. If the queue was empty and no alarm was set, we must set one.

---

## 3. Storage Design

### 3.1 Storage Key Schema

All WorkerPool storage keys use the `wp:` prefix for namespace isolation.

```typescript
const KEYS = {
  WORKER_POOL: {
    // Queue pointers
    HEAD: "wp:head",           // Sequence number of first pending event
    TAIL: "wp:tail",           // Sequence number for next enqueue

    // Event storage (prefix)
    EVENT_PREFIX: "wp:ev:",    // wp:ev:{sequence} = event data

    // Processing state
    PROCESSING: "wp:proc",     // boolean - currently processing?
    CURRENT_SEQ: "wp:curr",    // Sequence being processed
    ATTEMPT: "wp:attempt",     // Current attempt for current event

    // Counters
    PROCESSED_COUNT: "wp:done", // Total events processed (lifetime)

    // Control flags
    PAUSED: "wp:paused",       // boolean - processing paused?
  }
} as const;
```

### 3.2 Event Storage Structure

Each event is stored independently:

```typescript
interface StoredEvent<E> {
  /** The event data (validated against schema) */
  readonly data: E;

  /** Timestamp when enqueued */
  readonly enqueuedAt: number;

  /** Optional partition key (stored for debugging/inspection) */
  readonly partitionKey?: string;

  /** Priority (0 = normal, higher = sooner) */
  readonly priority: number;
}

// Key: wp:ev:{sequence}
// Example: wp:ev:42 → { data: {...}, enqueuedAt: 1703001234567, priority: 0 }
```

### 3.3 Why Individual Keys vs. Array

**Option A: Single array key**
```typescript
// wp:events = [event1, event2, event3, ...]
```
❌ Problems:
- 128KB limit = ~100-1000 events max
- Every operation reads/writes entire array
- No efficient way to get queue length
- Unbounded growth risk

**Option B: Individual keys with sequence numbers**
```typescript
// wp:ev:0 = event0
// wp:ev:1 = event1
// wp:ev:2 = event2
// wp:head = 0
// wp:tail = 3
```
✅ Benefits:
- Each event up to 128KB independently
- O(1) enqueue and dequeue
- Easy to calculate queue length: tail - head
- Can delete individual events
- Survives large queues

---

## 4. Queue Data Structures

### 4.1 FIFO Queue Model

The queue is a classic ring buffer / FIFO queue using sequence numbers:

```
             head=5              tail=10
                │                   │
                ▼                   ▼
   ┌───┬───┬───┬───┬───┬───┬───┬───┬───┐
   │   │   │   │ 5 │ 6 │ 7 │ 8 │ 9 │   │  ← logical positions
   └───┴───┴───┴───┴───┴───┴───┴───┴───┘
                │               │
                └───────────────┘
                  Pending events
                  (length = 10 - 5 = 5)
```

**Sequence numbers:**
- `head`: Next event to process (first pending)
- `tail`: Where next event will be stored
- `tail - head`: Number of pending events

**Invariants:**
- `head <= tail` always
- Events exist for all sequence numbers in `[head, tail)`
- After processing event at `head`, increment head and delete the event key

### 4.2 Priority Queue Extension

For priority support, we modify the dequeue logic:

```typescript
// Storage structure for priority
// wp:ev:{priority}:{sequence} = event

// Priority 10 events processed before priority 0
// Within same priority, FIFO order maintained
```

**Alternative: Priority in value, sort on dequeue**

For simplicity in initial implementation, we store priority in the event value and scan for highest priority when processing. This is O(n) but acceptable for queues < 1000 events.

For high-performance priority queues, we can add a priority index:

```typescript
// wp:pri:{priority}:{sequence} = true  // Index for fast lookup
// wp:ev:{sequence} = { data, priority, ... }
```

### 4.3 Initial Implementation: No Priority

For simplicity, the initial implementation uses pure FIFO without priority:

```typescript
// Enqueue: O(1)
// 1. Read tail
// 2. Store event at wp:ev:{tail}
// 3. Increment tail

// Dequeue: O(1)
// 1. Read head and tail
// 2. If head >= tail, queue empty
// 3. Read event at wp:ev:{head}
// 4. Return event
```

---

## 5. Processing Model

### 5.1 State Machine

Each DO instance follows this state machine:

```
                         ┌─────────────┐
                         │    IDLE     │
                         │ (no events) │
                         └──────┬──────┘
                                │
                     enqueue()  │
                                ▼
                         ┌─────────────┐
            ┌───────────►│  PROCESSING │◄─────────────┐
            │            │  (has work) │              │
            │            └──────┬──────┘              │
            │                   │                     │
            │        ┌──────────┴──────────┐          │
            │        │                     │          │
            │    success               failure        │
            │        │                     │          │
            │        ▼                     ▼          │
            │  ┌───────────┐        ┌───────────┐    │
            │  │   NEXT    │        │  RETRY    │    │
            │  │ (advance) │        │ (backoff) │    │
            │  └─────┬─────┘        └─────┬─────┘    │
            │        │                    │          │
            │        └────────┬───────────┘          │
            │                 │                      │
            │         more events?                   │
            │          yes/no                        │
            │            │                           │
            └────────────┘                           │
                         │                           │
                    queue empty                      │
                         │                           │
                         ▼                           │
                  ┌─────────────┐                    │
                  │    IDLE     │                    │
                  │ (no alarm)  │                    │
                  └──────┬──────┘                    │
                         │                           │
              enqueue()  │                           │
                         └───────────────────────────┘


    PAUSED state: No alarm set, enqueue() still works but no processing
```

### 5.2 Alarm Usage

The single alarm slot is used to:

1. **Trigger next event processing** (immediate alarm at current time)
2. **Schedule retry after failure** (alarm at `now + backoff delay`)

**Key rule:** Always set an alarm when:
- There are pending events AND not paused AND not currently processing
- A retry is scheduled

**Never set alarm when:**
- Queue is empty
- Processing is paused
- An alarm is already scheduled for the same purpose

### 5.3 Processing Flow (Alarm Handler)

```typescript
async function handleAlarm(): Promise<void> {
  // 1. Check if paused
  const paused = await storage.get<boolean>(KEYS.PAUSED);
  if (paused) {
    return; // No alarm rescheduled - will resume via resume() call
  }

  // 2. Get queue state
  const head = await storage.get<number>(KEYS.HEAD) ?? 0;
  const tail = await storage.get<number>(KEYS.TAIL) ?? 0;

  // 3. Check if queue is empty
  if (head >= tail) {
    await handleEmptyQueue();
    return; // No alarm - will be set on next enqueue
  }

  // 4. Get current event
  const eventKey = `${KEYS.EVENT_PREFIX}${head}`;
  const storedEvent = await storage.get<StoredEvent<unknown>>(eventKey);

  if (!storedEvent) {
    // Corrupted state - event missing. Skip and continue.
    await advanceHead(head);
    await scheduleNextProcessing();
    return;
  }

  // 5. Execute with retry tracking
  const attempt = await storage.get<number>(KEYS.ATTEMPT) ?? 1;

  try {
    await executeEvent(storedEvent, head, attempt);

    // Success - cleanup and advance
    await onEventSuccess(head);

  } catch (error) {
    // Failure - check retry
    await onEventFailure(head, storedEvent, error, attempt);
  }
}
```

---

## 6. Atomic Operations

### 6.1 Enqueue Operation

The enqueue must atomically:
1. Store the event
2. Increment tail
3. Optionally trigger processing

```typescript
async function enqueue(event: E): Promise<EnqueueResult> {
  // Read current state
  const head = await storage.get<number>(KEYS.HEAD) ?? 0;
  const tail = await storage.get<number>(KEYS.TAIL) ?? 0;
  const processing = await storage.get<boolean>(KEYS.PROCESSING) ?? false;
  const paused = await storage.get<boolean>(KEYS.PAUSED) ?? false;

  // Calculate sequence number
  const sequence = tail;

  // Create stored event
  const storedEvent: StoredEvent<E> = {
    data: event,
    enqueuedAt: Date.now(),
    priority: 0,
  };

  // Atomic write: event + tail update
  await storage.putBatch({
    [`${KEYS.EVENT_PREFIX}${sequence}`]: storedEvent,
    [KEYS.TAIL]: tail + 1,
  });

  // Trigger processing if needed
  const shouldTrigger = !processing && !paused && head >= tail;
  // (head >= tail means queue WAS empty before this enqueue)

  if (shouldTrigger || (head < tail && !processing && !paused)) {
    // Actually: always schedule if not processing and not paused
    // The alarm handler will figure out what to do
    const scheduledAlarm = await scheduler.getScheduled();
    if (scheduledAlarm === undefined) {
      await scheduler.schedule(Date.now()); // Immediate
    }
  }

  return {
    sequence,
    position: sequence - head, // 0 = next to process
    instanceIndex,
  };
}
```

### 6.2 Event Completion (Success)

```typescript
async function onEventSuccess(sequence: number): Promise<void> {
  const head = await storage.get<number>(KEYS.HEAD) ?? 0;
  const processedCount = await storage.get<number>(KEYS.PROCESSED_COUNT) ?? 0;

  // Atomic cleanup
  await storage.putBatch({
    [KEYS.HEAD]: head + 1,
    [KEYS.PROCESSED_COUNT]: processedCount + 1,
    [KEYS.PROCESSING]: false,
    [KEYS.ATTEMPT]: 1, // Reset attempt counter
  });

  // Delete the event
  await storage.delete(`${KEYS.EVENT_PREFIX}${sequence}`);

  // Delete retry state if any
  await storage.delete(KEYS.RETRY.SCHEDULED_AT);

  // Schedule next processing
  await scheduleNextProcessing();
}
```

### 6.3 Event Failure with Retry

```typescript
async function onEventFailure(
  sequence: number,
  event: StoredEvent<E>,
  error: unknown,
  attempt: number
): Promise<void> {
  const retryConfig = definition.retry;

  // Check if retryable
  if (!retryConfig || attempt >= retryConfig.maxAttempts) {
    // Exhausted - dead letter
    await handleDeadLetter(sequence, event, error, attempt);
    return;
  }

  // Calculate backoff delay
  const baseDelay = Duration.toMillis(Duration.decode(retryConfig.initialDelay));
  const multiplier = retryConfig.backoffMultiplier ?? 2;
  const maxDelay = retryConfig.maxDelay
    ? Duration.toMillis(Duration.decode(retryConfig.maxDelay))
    : baseDelay * Math.pow(multiplier, 10);

  const delay = Math.min(
    baseDelay * Math.pow(multiplier, attempt - 1),
    maxDelay
  );

  // Add jitter (±10%)
  const jitter = delay * 0.1 * (Math.random() * 2 - 1);
  const finalDelay = Math.round(delay + jitter);

  const resumeAt = Date.now() + finalDelay;

  // Store retry state
  await storage.putBatch({
    [KEYS.ATTEMPT]: attempt + 1,
    [KEYS.PROCESSING]: false,
    [KEYS.RETRY.LAST_ERROR]: String(error),
    [KEYS.RETRY.SCHEDULED_AT]: resumeAt,
  });

  // Schedule retry alarm
  await scheduler.schedule(resumeAt);
}
```

---

## 7. At-Least-Once Delivery

### 7.1 Delivery Guarantee

**At-least-once** means:
- Every successfully enqueued event will be processed at least once
- In failure scenarios, an event MAY be processed more than once
- Events are NEVER lost (unless explicitly drained)

### 7.2 How It's Achieved

**Durability before acknowledgment:**
```typescript
// Event is persisted BEFORE returning to client
await storage.putBatch({
  [`${KEYS.EVENT_PREFIX}${sequence}`]: storedEvent,
  [KEYS.TAIL]: tail + 1,
});

// Now return success to client
return { sequence, ... };
```

**Event deleted AFTER successful processing:**
```typescript
// 1. Process event
await executeEvent(event);

// 2. Only then delete
await storage.delete(`${KEYS.EVENT_PREFIX}${sequence}`);
await storage.put(KEYS.HEAD, head + 1);
```

**If DO crashes mid-processing:**
- Event is still in storage (not deleted)
- Alarm may or may not be set
- On DO restart, we detect incomplete state and re-process

### 7.3 Handling Partial Failures

**Scenario: DO crashes after execute but before delete**

```
Timeline:
1. Read event at head=5
2. Execute handler (success!)
3. ★ DO CRASH ★
4. (never reached) Delete event, increment head
```

**Recovery:**
- On next request or alarm, check state
- Event at head=5 still exists
- `processing` flag may be stale
- Re-execute the event (duplicate delivery)

**Mitigation:**
- User handlers should be idempotent
- OR use application-level deduplication (e.g., check if action already completed)

### 7.4 Exactly-Once Semantics (Not Supported)

True exactly-once requires:
- Transactional integration with downstream systems
- Two-phase commit or saga patterns

This is out of scope for the base WorkerPool. Users needing exactly-once should:
1. Make handlers idempotent
2. Use external deduplication (database unique constraints)
3. Implement application-level checks

---

## 8. High Throughput Handling

### 8.1 Hot Partition Problem

When partition key causes all events to route to one instance:

```
1000 events/sec → Single Instance → 1 event processed at a time
                                    ↓
                            Queue grows unboundedly
```

### 8.2 Backpressure Mechanisms

**Option A: Queue depth limit**
```typescript
const MAX_QUEUE_DEPTH = 10000;

async function enqueue(event: E): Promise<EnqueueResult> {
  const depth = (await storage.get<number>(KEYS.TAIL) ?? 0) -
                (await storage.get<number>(KEYS.HEAD) ?? 0);

  if (depth >= MAX_QUEUE_DEPTH) {
    throw new QueueFullError({
      instanceIndex,
      currentDepth: depth,
      maxDepth: MAX_QUEUE_DEPTH,
    });
  }

  // ... proceed with enqueue
}
```

**Option B: Return queue depth, let client decide**
```typescript
return {
  sequence,
  position: sequence - head,
  queueDepth: tail - head + 1,
  // Client can implement backpressure based on queueDepth
};
```

### 8.3 Batch Enqueue Optimization

For bulk inserts, batch writes are more efficient:

```typescript
async function enqueueMany(events: E[]): Promise<EnqueueManyResult> {
  const head = await storage.get<number>(KEYS.HEAD) ?? 0;
  const tail = await storage.get<number>(KEYS.TAIL) ?? 0;

  const batch: Record<string, unknown> = {};
  const results: EnqueueResult[] = [];

  for (let i = 0; i < events.length; i++) {
    const sequence = tail + i;
    batch[`${KEYS.EVENT_PREFIX}${sequence}`] = {
      data: events[i],
      enqueuedAt: Date.now(),
      priority: 0,
    };
    results.push({
      sequence,
      position: sequence - head,
      instanceIndex,
    });
  }

  // Add tail update to batch
  batch[KEYS.TAIL] = tail + events.length;

  // Single atomic write
  await storage.putBatch(batch);

  // Trigger processing
  await scheduleNextProcessingIfNeeded();

  return { enqueued: events.length, results };
}
```

### 8.4 Storage Growth Management

**Event cleanup:** Events are deleted immediately after successful processing.

**Sequence number overflow:** Use 64-bit integers (JavaScript safe integer limit is 2^53). At 1M events/second, this lasts 285 years.

**Compaction:** Not needed - we don't accumulate data. head increments, old keys are deleted.

---

## 9. Failure Scenarios

### 9.1 Scenario Matrix

| Scenario | Detection | Recovery |
|----------|-----------|----------|
| DO crash during enqueue | Request fails, client retries | Client retries, no duplicate (not yet committed) |
| DO crash after enqueue, before alarm | Alarm not set | On next enqueue, alarm is set |
| DO crash during processing | `processing=true`, alarm expired | Re-process event on next wake |
| DO crash during retry backoff | Alarm set for future time | Alarm fires, retry continues |
| Storage write failure | Effect returns error | Handler catches, retries or fails request |
| Alarm scheduling failure | Effect returns error | Handler catches, may miss processing |
| Event handler exception | Caught by try/catch | Retry or dead letter |
| Event handler timeout | DO auto-terminates at 30s | Treated as failure, retry |

### 9.2 Crash Recovery Protocol

On every alarm or request, run a consistency check:

```typescript
async function ensureConsistentState(): Promise<void> {
  const processing = await storage.get<boolean>(KEYS.PROCESSING);
  const head = await storage.get<number>(KEYS.HEAD) ?? 0;
  const tail = await storage.get<number>(KEYS.TAIL) ?? 0;
  const paused = await storage.get<boolean>(KEYS.PAUSED);

  // If processing flag is true but no alarm is scheduled, we crashed mid-process
  if (processing) {
    const scheduledAlarm = await scheduler.getScheduled();
    if (!scheduledAlarm) {
      // Reset processing flag and schedule immediate retry
      await storage.put(KEYS.PROCESSING, false);
      if (head < tail && !paused) {
        await scheduler.schedule(Date.now());
      }
    }
  }

  // If queue has events but no alarm and not paused, schedule processing
  if (head < tail && !paused && !processing) {
    const scheduledAlarm = await scheduler.getScheduled();
    if (!scheduledAlarm) {
      await scheduler.schedule(Date.now());
    }
  }
}
```

### 9.3 Dead Letter Flow

When all retries exhausted:

```typescript
async function handleDeadLetter(
  sequence: number,
  event: StoredEvent<E>,
  error: unknown,
  attempts: number
): Promise<void> {
  // 1. Call user's onDeadLetter handler
  if (definition.onDeadLetter) {
    try {
      await Effect.runPromise(
        definition.onDeadLetter(event.data, error, {
          sequence,
          attempts,
          enqueuedAt: event.enqueuedAt,
          failedAt: Date.now(),
          instanceIndex,
          instanceId,
          jobName: definition.name,
        })
      );
    } catch (dlError) {
      // Log but don't fail - we must advance the queue
      console.error("onDeadLetter handler failed:", dlError);
    }
  }

  // 2. Remove event from queue (don't let it block forever)
  await onEventSuccess(sequence); // Reuse success cleanup logic

  // 3. Log for observability
  console.warn(
    `Event ${sequence} dead-lettered after ${attempts} attempts`,
    { error, event: event.data }
  );
}
```

---

## 10. Handler Implementation

### 10.1 WorkerPoolHandler Service

```typescript
// packages/jobs/src/handlers/workerpool/handler.ts

import { Context, Effect, Layer, Schema } from "effect";
import {
  RuntimeAdapter,
  StorageAdapter,
  type StorageError,
  type SchedulerError,
} from "@durable-effect/core";
import { MetadataService } from "../../services/metadata";
import { AlarmService } from "../../services/alarm";
import { RegistryService } from "../../services/registry";
import { KEYS } from "../../storage-keys";
import { ExecutionError, JobNotFoundError, type JobError } from "../../errors";
import type { WorkerPoolRequest, WorkerPoolResponse } from "../../runtime/types";
import type { WorkerPoolDefinition, WorkerPoolExecuteContext } from "../../registry/types";

// Service Interface
export interface WorkerPoolHandlerI {
  readonly handle: (request: WorkerPoolRequest) => Effect.Effect<WorkerPoolResponse, JobError>;
  readonly handleAlarm: () => Effect.Effect<void, JobError>;
}

// Service Tag
export class WorkerPoolHandler extends Context.Tag(
  "@durable-effect/jobs/WorkerPoolHandler"
)<WorkerPoolHandler, WorkerPoolHandlerI>() {}

// Stored event structure
interface StoredEvent<E> {
  readonly data: E;
  readonly enqueuedAt: number;
  readonly partitionKey?: string;
  readonly priority: number;
}

// Layer Implementation
export const WorkerPoolHandlerLayer = Layer.effect(
  WorkerPoolHandler,
  Effect.gen(function* () {
    const registryService = yield* RegistryService;
    const metadata = yield* MetadataService;
    const alarm = yield* AlarmService;
    const runtime = yield* RuntimeAdapter;
    const storage = yield* StorageAdapter;

    // Helper to get definition
    const getDefinition = (name: string) => {
      const def = registryService.registry.workerPool[name];
      if (!def) {
        return Effect.fail(new JobNotFoundError({ type: "workerPool", name }));
      }
      return Effect.succeed(def);
    };

    // Storage helpers
    const getHead = () => storage.get<number>(KEYS.WORKER_POOL.HEAD).pipe(
      Effect.map(h => h ?? 0)
    );
    const getTail = () => storage.get<number>(KEYS.WORKER_POOL.TAIL).pipe(
      Effect.map(t => t ?? 0)
    );
    const getAttempt = () => storage.get<number>(KEYS.WORKER_POOL.ATTEMPT).pipe(
      Effect.map(a => a ?? 1)
    );
    const isPaused = () => storage.get<boolean>(KEYS.WORKER_POOL.PAUSED).pipe(
      Effect.map(p => p ?? false)
    );
    const isProcessing = () => storage.get<boolean>(KEYS.WORKER_POOL.PROCESSING).pipe(
      Effect.map(p => p ?? false)
    );
    const getProcessedCount = () => storage.get<number>(KEYS.WORKER_POOL.PROCESSED_COUNT).pipe(
      Effect.map(c => c ?? 0)
    );

    // Schedule next processing if needed
    const scheduleNextIfNeeded = () =>
      Effect.gen(function* () {
        const head = yield* getHead();
        const tail = yield* getTail();
        const paused = yield* isPaused();
        const processing = yield* isProcessing();

        if (head < tail && !paused && !processing) {
          const scheduled = yield* alarm.getScheduled();
          if (scheduled === undefined) {
            yield* alarm.schedule(yield* runtime.now());
          }
        }
      });

    // Enqueue handler
    const handleEnqueue = (
      def: WorkerPoolDefinition,
      request: WorkerPoolRequest
    ) =>
      Effect.gen(function* () {
        // Initialize metadata if first enqueue
        const meta = yield* metadata.get();
        if (!meta) {
          yield* metadata.initialize("workerPool", request.name);
          yield* metadata.updateStatus("running");
        }

        const head = yield* getHead();
        const tail = yield* getTail();
        const sequence = tail;

        // Validate event against schema
        const decode = Schema.decodeUnknown(def.eventSchema);
        const validatedEvent = yield* decode(request.event).pipe(
          Effect.mapError(e => new ExecutionError({
            jobType: "workerPool",
            jobName: def.name,
            instanceId: runtime.instanceId,
            cause: e,
          }))
        );

        // Create stored event
        const storedEvent: StoredEvent<unknown> = {
          data: validatedEvent,
          enqueuedAt: yield* runtime.now(),
          partitionKey: request.partitionKey,
          priority: request.priority ?? 0,
        };

        // Atomic write
        yield* storage.putBatch({
          [`${KEYS.WORKER_POOL.EVENT_PREFIX}${sequence}`]: storedEvent,
          [KEYS.WORKER_POOL.TAIL]: tail + 1,
        });

        // Trigger processing
        yield* scheduleNextIfNeeded();

        return {
          _type: "workerPool.enqueue" as const,
          sequence,
          instanceId: runtime.instanceId,
          instanceIndex: request.instanceIndex,
          position: sequence - head,
        };
      });

    // Process one event
    const processNextEvent = (def: WorkerPoolDefinition) =>
      Effect.gen(function* () {
        const head = yield* getHead();
        const tail = yield* getTail();

        if (head >= tail) {
          // Queue empty
          if (def.onEmpty) {
            const processedCount = yield* getProcessedCount();
            yield* def.onEmpty({
              instanceId: runtime.instanceId,
              instanceIndex: 0, // TODO: get from metadata
              jobName: def.name,
              processedCount,
            });
          }
          return;
        }

        // Mark as processing
        yield* storage.put(KEYS.WORKER_POOL.PROCESSING, true);

        // Get event
        const eventKey = `${KEYS.WORKER_POOL.EVENT_PREFIX}${head}`;
        const storedEvent = yield* storage.get<StoredEvent<unknown>>(eventKey);

        if (!storedEvent) {
          // Corrupted - skip
          yield* storage.putBatch({
            [KEYS.WORKER_POOL.HEAD]: head + 1,
            [KEYS.WORKER_POOL.PROCESSING]: false,
          });
          yield* scheduleNextIfNeeded();
          return;
        }

        const attempt = yield* getAttempt();
        const now = yield* runtime.now();

        // Build context
        const ctx: WorkerPoolExecuteContext<unknown> = {
          event: storedEvent.data,
          sequence: head,
          attempt,
          isRetry: attempt > 1,
          enqueuedAt: storedEvent.enqueuedAt,
          processingStartedAt: now,
          instanceIndex: 0, // TODO: get from metadata
          instanceId: runtime.instanceId,
          jobName: def.name,
        };

        // Execute
        const result = yield* Effect.either(
          Effect.try({
            try: () => def.execute(ctx),
            catch: (e) => e,
          }).pipe(Effect.flatten)
        );

        if (result._tag === "Right") {
          // Success
          const processedCount = yield* getProcessedCount();
          yield* storage.putBatch({
            [KEYS.WORKER_POOL.HEAD]: head + 1,
            [KEYS.WORKER_POOL.PROCESSED_COUNT]: processedCount + 1,
            [KEYS.WORKER_POOL.PROCESSING]: false,
            [KEYS.WORKER_POOL.ATTEMPT]: 1,
          });
          yield* storage.delete(eventKey);
          yield* scheduleNextIfNeeded();
        } else {
          // Failure
          const error = result.left;
          const retryConfig = def.retry;

          if (!retryConfig || attempt >= retryConfig.maxAttempts) {
            // Dead letter
            if (def.onDeadLetter) {
              yield* Effect.try({
                try: () => def.onDeadLetter!(storedEvent.data, error, {
                  sequence: head,
                  attempts: attempt,
                  enqueuedAt: storedEvent.enqueuedAt,
                  failedAt: now,
                  instanceIndex: 0,
                  instanceId: runtime.instanceId,
                  jobName: def.name,
                }),
                catch: () => undefined,
              }).pipe(Effect.flatten, Effect.ignore);
            }

            // Remove and continue
            const processedCount = yield* getProcessedCount();
            yield* storage.putBatch({
              [KEYS.WORKER_POOL.HEAD]: head + 1,
              [KEYS.WORKER_POOL.PROCESSED_COUNT]: processedCount + 1,
              [KEYS.WORKER_POOL.PROCESSING]: false,
              [KEYS.WORKER_POOL.ATTEMPT]: 1,
            });
            yield* storage.delete(eventKey);
            yield* scheduleNextIfNeeded();
          } else {
            // Schedule retry
            const baseDelay = Duration.toMillis(
              Duration.decode(retryConfig.initialDelay)
            );
            const multiplier = retryConfig.backoffMultiplier ?? 2;
            const delay = baseDelay * Math.pow(multiplier, attempt - 1);
            const maxDelay = retryConfig.maxDelay
              ? Duration.toMillis(Duration.decode(retryConfig.maxDelay))
              : delay * 10;
            const clampedDelay = Math.min(delay, maxDelay);
            const jitter = clampedDelay * 0.1 * (Math.random() * 2 - 1);
            const resumeAt = now + clampedDelay + jitter;

            yield* storage.putBatch({
              [KEYS.WORKER_POOL.ATTEMPT]: attempt + 1,
              [KEYS.WORKER_POOL.PROCESSING]: false,
            });
            yield* alarm.schedule(resumeAt);
          }
        }
      });

    return {
      handle: (request: WorkerPoolRequest) =>
        Effect.gen(function* () {
          const def = yield* getDefinition(request.name);

          switch (request.action) {
            case "enqueue":
              return yield* handleEnqueue(def, request);

            case "pause":
              yield* storage.put(KEYS.WORKER_POOL.PAUSED, true);
              yield* alarm.cancel();
              return { _type: "workerPool.pause" as const, paused: true };

            case "resume":
              yield* storage.put(KEYS.WORKER_POOL.PAUSED, false);
              yield* scheduleNextIfNeeded();
              return { _type: "workerPool.resume" as const, resumed: true };

            case "status":
              const head = yield* getHead();
              const tail = yield* getTail();
              const paused = yield* isPaused();
              const processing = yield* isProcessing();
              const processedCount = yield* getProcessedCount();
              return {
                _type: "workerPool.status" as const,
                status: paused ? "paused" : processing ? "processing" : "idle",
                pendingCount: tail - head,
                processedCount,
                currentSequence: processing ? head : null,
              };

            case "drain":
              const h = yield* getHead();
              const t = yield* getTail();
              const cleared = t - h;
              yield* storage.deleteAll();
              yield* alarm.cancel();
              return {
                _type: "workerPool.drain" as const,
                drained: true,
                eventsCleared: cleared,
              };

            default:
              throw new Error(`Unknown action: ${(request as any).action}`);
          }
        }),

      handleAlarm: () =>
        Effect.gen(function* () {
          const meta = yield* metadata.get();
          if (!meta) return;

          const paused = yield* isPaused();
          if (paused) return;

          const def = yield* getDefinition(meta.name);
          yield* processNextEvent(def);
        }),
    };
  })
);
```

### 10.2 Integration with Dispatcher

Update the dispatcher to route to WorkerPoolHandler:

```typescript
// In dispatcher.ts

case "workerPool":
  return yield* workerPool.handle(request);

// And in handleAlarm:
case "workerPool":
  yield* workerPool.handleAlarm();
  break;
```

---

## 11. Testing Strategy

### 11.1 Unit Tests

```typescript
describe("WorkerPool", () => {
  describe("enqueue", () => {
    it("stores event and increments tail");
    it("schedules alarm when queue was empty");
    it("validates event against schema");
    it("returns correct position in queue");
  });

  describe("processing", () => {
    it("processes events in FIFO order");
    it("deletes event after successful processing");
    it("increments processed count");
    it("schedules next alarm when more events pending");
    it("calls onEmpty when queue drains");
  });

  describe("retry", () => {
    it("retries on failure up to maxAttempts");
    it("applies exponential backoff");
    it("calls onDeadLetter after exhaustion");
    it("continues processing after dead letter");
  });

  describe("pause/resume", () => {
    it("stops processing when paused");
    it("resumes processing after resume");
    it("accepts enqueues while paused");
  });

  describe("crash recovery", () => {
    it("re-processes incomplete event after crash");
    it("schedules alarm if missing after crash");
  });
});
```

### 11.2 Integration Tests

```typescript
describe("WorkerPool Integration", () => {
  it("processes 1000 events correctly");
  it("handles concurrent enqueues from multiple clients");
  it("maintains FIFO order within partition");
  it("distributes evenly with round-robin");
  it("routes consistently with partition key");
});
```

### 11.3 Chaos Tests

```typescript
describe("WorkerPool Chaos", () => {
  it("recovers from simulated DO crashes");
  it("handles storage failures gracefully");
  it("handles alarm scheduling failures");
  it("handles slow handler execution");
});
```

---

## Summary

This design provides:

1. **Correct FIFO queue** using head/tail pointers with individual event storage
2. **At-least-once delivery** via persist-before-ack and delete-after-process
3. **Single alarm management** for all processing (next event + retries)
4. **Crash recovery** via state checking on every wake
5. **Retry with exponential backoff** and dead letter handling
6. **Pause/resume** for operational control
7. **High throughput** via efficient O(1) enqueue/dequeue
8. **Clear failure handling** with comprehensive error scenarios

The implementation integrates cleanly with the existing `@packages/jobs` architecture by following the same patterns as Continuous and Debounce handlers.
