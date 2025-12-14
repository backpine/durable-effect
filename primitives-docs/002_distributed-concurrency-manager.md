# Distributed Concurrency Manager Architecture Report

**Date**: 2024-12-08
**Package**: `@durable-effect/primitives`
**Focus**: Distributed processing with bounded concurrency across Durable Object instances

---

## Executive Summary

This report analyzes the architecture for a **Distributed Concurrency Manager** - a system that processes a high-throughput event stream with bounded parallelism (e.g., max 4 concurrent) distributed across multiple Durable Object instances.

```
                    ┌─────────────────────────────────────────────────┐
                    │           Event Stream (thousands/sec)           │
                    └─────────────────────────┬───────────────────────┘
                                              │
                                              ▼
                    ┌─────────────────────────────────────────────────┐
                    │              Router / Distributor                │
                    │         (assigns events to DO instances)         │
                    └───────┬─────────┬─────────┬─────────┬───────────┘
                            │         │         │         │
                            ▼         ▼         ▼         ▼
                    ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐
                    │  DO #1    │ │  DO #2    │ │  DO #3    │ │  DO #4    │
                    │ (1 slot)  │ │ (1 slot)  │ │ (1 slot)  │ │ (1 slot)  │
                    │ + queue   │ │ + queue   │ │ + queue   │ │ + queue   │
                    └───────────┘ └───────────┘ └───────────┘ └───────────┘
                            │         │         │         │
                            └─────────┴─────────┴─────────┴─────────────┐
                                              │                         │
                                              ▼                         │
                    ┌─────────────────────────────────────────────────┐ │
                    │         Max 4 concurrent processors              │◄┘
                    │              (global guarantee)                  │
                    └─────────────────────────────────────────────────┘
```

**Key Insight**: Distributing concurrency across DOs is fundamentally different from single-process concurrency. You're trading coordination overhead for horizontal scalability, and the architecture must account for the CAP theorem implications.

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Architecture Options](#architecture-options)
- [Recommended Architecture: Partitioned Slots](#recommended-architecture-partitioned-slots)
- [Scale Considerations & Bottlenecks](#scale-considerations--bottlenecks)
- [Failure Modes & Recovery](#failure-modes--recovery)
- [Implementation Details](#implementation-details)
- [Alternative Approaches](#alternative-approaches)
- [Trade-off Matrix](#trade-off-matrix)
- [Recommendations](#recommendations)

---

## Problem Statement

### Requirements

1. **Input**: High-throughput event stream (potentially thousands of events/second)
2. **Constraint**: Maximum N concurrent processors (e.g., N=4)
3. **Durability**: Events must not be lost; processing must be reliable
4. **Distribution**: Work distributed across multiple DO instances
5. **Ordering**: May or may not require ordering guarantees (configurable)

### Why This Is Hard

Distributed concurrency control is a classic distributed systems problem. The challenges:

| Challenge | Description |
|-----------|-------------|
| **Coordination Overhead** | DOs can't share memory; any coordination requires network calls |
| **Split Brain** | Without a coordinator, DOs might exceed the concurrency limit |
| **Hot Spots** | Poor distribution creates load imbalance |
| **Backpressure** | What happens when all slots are busy? |
| **Failure Recovery** | What if a DO crashes mid-processing? |
| **Ordering** | Global ordering across distributed processors is expensive |

---

## Architecture Options

### Option A: Central Coordinator (Semaphore DO)

A single "coordinator" DO manages permits; workers request permits before processing.

```
Events ─────┬──────────────────────────────────────────────────┐
            │                                                  │
            ▼                                                  ▼
     ┌────────────┐                                    ┌────────────┐
     │  Worker 1  │◄─── acquire() ────►┌────────────┐  │  Worker N  │
     └────────────┘                    │ Coordinator│  └────────────┘
                                       │  (permits) │
     ┌────────────┐◄─── release() ────►└────────────┘  ┌────────────┐
     │  Worker 2  │                                    │  Worker M  │
     └────────────┘                                    └────────────┘
```

**Pros:**
- Exact concurrency guarantee
- Simple mental model
- Clear permit accounting

**Cons:**
- **Single point of failure**: Coordinator DO down = no processing
- **Bottleneck**: All workers contend on one DO
- **Latency**: Every process requires coordinator roundtrip
- **Thundering herd**: When permits released, many workers wake up

### Option B: Partitioned Slots (Recommended)

Divide concurrency limit across fixed partitions. Each DO owns a fixed number of slots.

```
Global limit: 4 concurrent

┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Partition 0 │  │ Partition 1 │  │ Partition 2 │  │ Partition 3 │
│  (1 slot)   │  │  (1 slot)   │  │  (1 slot)   │  │  (1 slot)   │
│             │  │             │  │             │  │             │
│  ┌───────┐  │  │  ┌───────┐  │  │  ┌───────┐  │  │  ┌───────┐  │
│  │ Queue │  │  │  │ Queue │  │  │  │ Queue │  │  │  │ Queue │  │
│  └───┬───┘  │  │  └───┬───┘  │  │  └───┬───┘  │  │  └───┬───┘  │
│      │      │  │      │      │  │      │      │  │      │      │
│  ┌───▼───┐  │  │  ┌───▼───┐  │  │  ┌───▼───┐  │  │  ┌───▼───┐  │
│  │Process│  │  │  │Process│  │  │  │Process│  │  │  │Process│  │
│  └───────┘  │  │  └───────┘  │  │  └───────┘  │  │  └───────┘  │
└─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
```

**Pros:**
- No coordination between DOs (fully independent)
- Linear scalability
- No single point of failure
- Each partition processes independently

**Cons:**
- Static slot allocation (can't rebalance)
- Uneven load if routing is poor
- Concurrency limit is approximate (N ± processing overlap)

### Option C: Work Stealing

Workers process their own queue but can "steal" from neighbors when idle.

**Pros:**
- Better load balancing than static partitioning
- Adaptive to uneven workloads

**Cons:**
- Complex coordination
- Race conditions on stealing
- Hard to implement with DO constraints

### Option D: Central Queue + Worker Pool

Single queue DO, multiple worker DOs pull work.

```
Events ──► ┌────────────┐ ◄── pull() ── ┌────────────┐
           │   Queue    │               │  Worker 1  │
           │    DO      │ ◄── pull() ── ├────────────┤
           │            │               │  Worker 2  │
           │            │ ◄── pull() ── ├────────────┤
           └────────────┘               │  Worker N  │
                                        └────────────┘
```

**Pros:**
- Natural work distribution
- Workers self-regulate

**Cons:**
- Queue becomes bottleneck
- Pull latency adds overhead
- Queue DO memory limits

---

## Recommended Architecture: Partitioned Slots

For most use cases, **Partitioned Slots** provides the best balance of simplicity, scalability, and reliability.

### Core Design

```typescript
interface ConcurrencyManagerConfig {
  /** Total concurrent processors allowed */
  readonly concurrency: number;

  /** Number of partitions (DOs) to distribute across */
  readonly partitions: number;

  /** How to route events to partitions */
  readonly routing: "round-robin" | "hash" | "affinity";

  /** Max queue depth per partition before backpressure */
  readonly maxQueueDepth: number;

  /** Processing timeout per item */
  readonly timeout: Duration;

  /** Retry configuration */
  readonly retry: {
    maxAttempts: number;
    backoff: "fixed" | "exponential";
    baseDelay: Duration;
  };
}
```

### Slot Calculation

```
slotsPerPartition = ceil(concurrency / partitions)

Example:
  concurrency = 4
  partitions = 4
  slotsPerPartition = 1  (each DO processes 1 at a time)

Example:
  concurrency = 10
  partitions = 4
  slotsPerPartition = 3  (some DOs get 3, some get 2)
```

### Architecture Diagram

```
                          ┌──────────────────────────────────────────────────────┐
                          │                    Event Source                       │
                          │        (Kafka, HTTP webhook, Cloudflare Queue)        │
                          └──────────────────────────┬───────────────────────────┘
                                                     │
                                                     ▼
                          ┌──────────────────────────────────────────────────────┐
                          │                    Router Worker                      │
                          │                                                       │
                          │   routing = hash(event.key) % partitions              │
                          │   OR                                                  │
                          │   routing = roundRobinCounter++ % partitions          │
                          │                                                       │
                          └───────┬─────────────┬─────────────┬─────────────┬────┘
                                  │             │             │             │
                                  │ partition=0 │ partition=1 │ partition=2 │ partition=3
                                  ▼             ▼             ▼             ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                               Durable Object Partitions                                      │
│                                                                                             │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│  │    Partition 0      │  │    Partition 1      │  │    Partition 2      │  │    Partition 3      │
│  │    (DO instance)    │  │    (DO instance)    │  │    (DO instance)    │  │    (DO instance)    │
│  │                     │  │                     │  │                     │  │                     │
│  │  ┌───────────────┐  │  │  ┌───────────────┐  │  │  ┌───────────────┐  │  │  ┌───────────────┐  │
│  │  │ Pending Queue │  │  │  │ Pending Queue │  │  │  │ Pending Queue │  │  │  │ Pending Queue │  │
│  │  │  [e1,e2,e3]   │  │  │  │  [e4,e5]      │  │  │  │  [e6,e7,e8]   │  │  │  │  []           │  │
│  │  └───────┬───────┘  │  │  └───────┬───────┘  │  │  └───────┬───────┘  │  │  └───────┬───────┘  │
│  │          │          │  │          │          │  │          │          │  │          │          │
│  │          ▼          │  │          ▼          │  │          ▼          │  │          ▼          │
│  │  ┌───────────────┐  │  │  ┌───────────────┐  │  │  ┌───────────────┐  │  │  ┌───────────────┐  │
│  │  │  Processing   │  │  │  │  Processing   │  │  │  │  Processing   │  │  │  │  Processing   │  │
│  │  │  (1 slot)     │  │  │  │  (1 slot)     │  │  │  │  (1 slot)     │  │  │  │  (1 slot)     │  │
│  │  │  [e0]         │  │  │  │  [e3]         │  │  │  │  []           │  │  │  │  []           │  │
│  │  └───────────────┘  │  │  └───────────────┘  │  │  └───────────────┘  │  │  └───────────────┘  │
│  │                     │  │                     │  │                     │  │                     │
│  │  State:             │  │  State:             │  │  State:             │  │  State:             │
│  │  - slots: 1         │  │  - slots: 1         │  │  - slots: 1         │  │  - slots: 1         │
│  │  - active: 1        │  │  - active: 1        │  │  - active: 0        │  │  - active: 0        │
│  │  - queued: 3        │  │  - queued: 2        │  │  - queued: 3        │  │  - queued: 0        │
│  └─────────────────────┘  └─────────────────────┘  └─────────────────────┘  └─────────────────────┘
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
                                                     │
                                                     ▼
                          ┌──────────────────────────────────────────────────────┐
                          │                  Processing Target                    │
                          │            (External API, database, etc.)             │
                          └──────────────────────────────────────────────────────┘
```

### State Machine Per Partition

```
                                    enqueue(event)
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              PARTITION STATE MACHINE                          │
│                                                                              │
│   ┌─────────┐  queue.length > 0   ┌────────────┐  slot available  ┌────────┐│
│   │  IDLE   │ ─────────────────► │  QUEUED    │ ───────────────► │PROCESS ││
│   │         │ ◄───────────────── │            │ ◄─────────────── │   ING  ││
│   └─────────┘    queue empty     └────────────┘   slot released  └────────┘│
│        │                               │                              │     │
│        │                               │                              │     │
│        │         Alarm fires           │                              │     │
│        └───────────────────────────────┴──────────────────────────────┘     │
│                                                                              │
│   Events:                                                                    │
│   - enqueue(event): Add to queue, start processing if slot available        │
│   - processComplete(id): Release slot, dequeue next                          │
│   - alarm(): Check for stuck items, retry failures                          │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Scale Considerations & Bottlenecks

### Bottleneck Analysis

| Component | Bottleneck Risk | Symptoms | Mitigation |
|-----------|-----------------|----------|------------|
| **Router** | Medium | High latency, dropped events | Use Cloudflare Queue as buffer |
| **Partition DO** | Low-Medium | Queue overflow, memory pressure | Max queue depth, backpressure |
| **Storage writes** | Medium | Slow enqueue, high latency | Batch writes, write coalescing |
| **Processing target** | High | Timeout errors, retry storms | Circuit breaker, backoff |
| **Single partition** | High | One hot partition | Better hash function, rebalancing |

### Scale Limits by Component

#### 1. Router/Distributor Throughput

```
┌─────────────────────────────────────────────────────────────────┐
│                    ROUTER SCALING                                │
│                                                                  │
│  Single Cloudflare Worker: ~1000 RPS per instance               │
│  With Queue buffer: 10,000+ events/sec (batched)                │
│                                                                  │
│  Recommendation:                                                 │
│  ┌─────────┐      ┌──────────────┐      ┌─────────────────┐     │
│  │ Events  │─────►│ CF Queue     │─────►│ Consumer Worker │     │
│  │         │      │ (buffer)     │      │ (batch dispatch)│     │
│  └─────────┘      └──────────────┘      └─────────────────┘     │
│                                                                  │
│  Benefits:                                                       │
│  - Absorbs spikes                                                │
│  - Guarantees delivery                                           │
│  - Batches writes to DOs                                         │
└─────────────────────────────────────────────────────────────────┘
```

#### 2. DO Instance Limits

```
┌─────────────────────────────────────────────────────────────────┐
│                    DO INSTANCE LIMITS                            │
│                                                                  │
│  Memory: 128MB per DO                                            │
│  Storage: 10GB per DO (but charged per operation)               │
│  Concurrent requests: 1 (single-threaded)                       │
│  Subrequests: 1000 per request                                  │
│                                                                  │
│  Queue sizing:                                                   │
│  - 10,000 events × 1KB each = 10MB (safe)                       │
│  - 100,000 events × 1KB each = 100MB (risky)                    │
│                                                                  │
│  Recommendation: maxQueueDepth = 10,000                          │
│  With backpressure at 8,000                                      │
└─────────────────────────────────────────────────────────────────┘
```

#### 3. Storage Operation Costs

```
┌─────────────────────────────────────────────────────────────────┐
│                    STORAGE OPERATIONS                            │
│                                                                  │
│  Per-event cost (naive implementation):                          │
│  - 1 write to enqueue                                           │
│  - 1 read to dequeue                                            │
│  - 1 write to update state                                      │
│  - 1 write on complete                                          │
│  Total: 4 operations per event = $0.0000032 per event           │
│                                                                  │
│  Optimized (batching):                                           │
│  - Batch 100 events per storage operation                       │
│  - Use list() instead of individual gets                        │
│  Total: 0.04 operations per event = $0.000000032 per event      │
│                                                                  │
│  100x cost reduction with batching!                              │
└─────────────────────────────────────────────────────────────────┘
```

### Hot Partition Problem

The most common scaling issue is uneven load distribution:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         HOT PARTITION SCENARIO                              │
│                                                                            │
│  hash("user:123") = 0                                                      │
│  hash("user:456") = 0                                                      │
│  hash("user:789") = 0    <── All route to partition 0!                     │
│                                                                            │
│  Partition 0: [████████████████████] 95% load                              │
│  Partition 1: [██                  ]  5% load                              │
│  Partition 2: [                    ]  0% load                              │
│  Partition 3: [                    ]  0% load                              │
│                                                                            │
│  Result: Effective concurrency = 1 (not 4!)                                │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

Solutions:

1. Better hash function:
   - Use cryptographic hash (SHA-256) for uniform distribution
   - Include high-cardinality fields in hash key

2. Virtual partitions:
   - 4 logical partitions, but 64 virtual partitions
   - Map virtual → physical dynamically
   - Allows rebalancing

3. Random routing (if ordering not required):
   - Round-robin or random selection
   - Perfect distribution, no ordering

4. Adaptive routing:
   - Track partition depths
   - Route to least-loaded partition
   - Requires coordination (adds latency)
```

### Throughput Calculations

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    THROUGHPUT ESTIMATION                                    │
│                                                                            │
│  Variables:                                                                 │
│  - P = number of partitions (4)                                            │
│  - S = slots per partition (1)                                             │
│  - T = average processing time (100ms)                                     │
│  - Q = max queue depth per partition (10,000)                              │
│                                                                            │
│  Maximum throughput:                                                        │
│  throughput = (P × S) / T = (4 × 1) / 0.1 = 40 events/sec                 │
│                                                                            │
│  With processing time 10ms:                                                │
│  throughput = (4 × 1) / 0.01 = 400 events/sec                             │
│                                                                            │
│  Queue drain time at max depth:                                            │
│  drain_time = (P × Q) / throughput = (4 × 10000) / 40 = 1000 sec          │
│                                                                            │
│  Backpressure trigger:                                                      │
│  If input_rate > throughput for extended period, queues grow               │
│  Must reject or slow incoming events                                        │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Failure Modes & Recovery

### Failure Scenarios

#### 1. Processing Failure (Exception)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    PROCESSING FAILURE                                       │
│                                                                            │
│  Timeline:                                                                  │
│  t=0    Event dequeued, processing started                                 │
│  t=50ms Processing throws exception                                        │
│  t=50ms Catch error, increment retry count                                 │
│  t=50ms If retries < max: re-enqueue with backoff                         │
│  t=50ms Else: move to dead-letter queue                                    │
│                                                                            │
│  State transitions:                                                         │
│  ┌─────────┐     ┌────────────┐     ┌─────────┐                            │
│  │ QUEUED  │────►│ PROCESSING │────►│ FAILED  │                            │
│  └─────────┘     └────────────┘     └────┬────┘                            │
│       ▲                                  │                                  │
│       │          retries < max           │                                  │
│       └──────────────────────────────────┘                                  │
│                                                                            │
│  Implementation:                                                            │
│  - Store attempt count with event                                          │
│  - Calculate next attempt time: now + backoff(attempt)                     │
│  - Re-insert at calculated time (priority queue)                           │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

#### 2. Processing Timeout (Stuck)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    STUCK PROCESSING DETECTION                               │
│                                                                            │
│  Problem: Process started but never completed                              │
│  Cause: External API hung, infinite loop, DO crashed                       │
│                                                                            │
│  Detection mechanism:                                                       │
│  - Store `processingStartedAt` when dequeuing                              │
│  - Alarm checks: if (now - processingStartedAt > timeout)                  │
│  - Mark as timed out, trigger retry logic                                  │
│                                                                            │
│  State:                                                                     │
│  {                                                                          │
│    processing: {                                                           │
│      eventId: "evt_123",                                                   │
│      startedAt: 1702000000000,                                             │
│      timeout: 30000  // 30 seconds                                         │
│    }                                                                        │
│  }                                                                          │
│                                                                            │
│  Alarm schedule:                                                            │
│  nextAlarm = min(                                                          │
│    processingStartedAt + timeout,    // Check for stuck                    │
│    nextQueuedEventTime,              // Process next                       │
│    nextRetryTime                     // Retry failed                       │
│  )                                                                          │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

#### 3. DO Instance Restart

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    DO RESTART RECOVERY                                      │
│                                                                            │
│  Scenario: DO evicted from memory, restarted on next request               │
│                                                                            │
│  What's preserved:                                                          │
│  ✓ Storage (queue, state)                                                  │
│  ✓ Scheduled alarms                                                        │
│                                                                            │
│  What's lost:                                                               │
│  ✗ In-memory state (variables)                                             │
│  ✗ In-flight processing (must be re-detected)                              │
│                                                                            │
│  Recovery on restart:                                                       │
│  1. Constructor loads state from storage                                    │
│  2. Check for in-flight processing (processingStartedAt set)               │
│  3. If processing was in-flight:                                           │
│     - If within timeout: assume still running (external)                    │
│     - If past timeout: mark as failed, retry                               │
│  4. Schedule alarm for next action                                         │
│                                                                            │
│  Key insight:                                                               │
│  - Storage is the source of truth                                          │
│  - Never trust in-memory state across requests                             │
│  - Design for restart at any moment                                        │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

#### 4. Poison Message

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    POISON MESSAGE HANDLING                                  │
│                                                                            │
│  Definition: Message that always fails processing                          │
│  Danger: Blocks the queue, consumes all retries                            │
│                                                                            │
│  Detection:                                                                 │
│  - Track failure count per event                                           │
│  - After N failures, move to dead-letter                                   │
│                                                                            │
│  Dead-letter handling:                                                      │
│  Option A: Separate DLQ partition                                          │
│  Option B: External storage (R2, Queue)                                    │
│  Option C: Emit event for manual handling                                  │
│                                                                            │
│  State schema:                                                              │
│  {                                                                          │
│    deadLetter: [                                                           │
│      {                                                                      │
│        event: { ... },                                                     │
│        failedAt: 1702000000000,                                            │
│        attempts: 5,                                                        │
│        lastError: "Connection refused"                                     │
│      }                                                                      │
│    ]                                                                        │
│  }                                                                          │
│                                                                            │
│  Important: DLQ should have separate depth limit                           │
│  to prevent memory exhaustion from repeated failures                       │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### Recovery Matrix

| Failure Type | Detection | Recovery | Data Loss Risk |
|--------------|-----------|----------|----------------|
| Processing exception | Immediate (catch) | Retry with backoff | None |
| Processing timeout | Alarm check | Retry | Possible duplicate processing |
| DO restart | On constructor | Re-check in-flight | None (storage persisted) |
| Poison message | Retry count | Dead-letter | None |
| Router crash | CF auto-restart | Retry from Queue | None (Queue persisted) |
| Storage failure | Effect error | Fail request, retry | Possible (rare) |

---

## Implementation Details

### Partition State Schema

```typescript
interface PartitionState {
  /** Partition configuration */
  readonly config: {
    readonly partitionId: number;
    readonly totalPartitions: number;
    readonly slotsPerPartition: number;
    readonly maxQueueDepth: number;
    readonly processingTimeout: number;
    readonly maxRetries: number;
  };

  /** Queue of pending events */
  readonly queue: ReadonlyArray<QueuedEvent>;

  /** Currently processing events (one per slot) */
  readonly processing: ReadonlyArray<ProcessingEvent>;

  /** Dead-letter queue for failed events */
  readonly deadLetter: ReadonlyArray<DeadLetterEvent>;

  /** Metrics */
  readonly metrics: {
    readonly totalEnqueued: number;
    readonly totalProcessed: number;
    readonly totalFailed: number;
    readonly totalDeadLettered: number;
  };
}

interface QueuedEvent {
  readonly id: string;
  readonly payload: unknown;
  readonly enqueuedAt: number;
  readonly attempts: number;
  readonly nextAttemptAt?: number;  // For delayed retries
}

interface ProcessingEvent {
  readonly id: string;
  readonly payload: unknown;
  readonly startedAt: number;
  readonly attempts: number;
}

interface DeadLetterEvent {
  readonly id: string;
  readonly payload: unknown;
  readonly failedAt: number;
  readonly attempts: number;
  readonly lastError: string;
}
```

### Handler Implementation

```typescript
const ConcurrencyPartitionHandler: PrimitiveHandler<
  PartitionConfig,
  PartitionState,
  {
    enqueue: (events: unknown[]) => { queued: number; rejected: number };
    getStatus: () => PartitionStatus;
    drain: () => { drained: number };
  }
> = {
  type: "concurrency-partition",

  initialize: (config) =>
    Effect.succeed({
      config,
      queue: [],
      processing: [],
      deadLetter: [],
      metrics: {
        totalEnqueued: 0,
        totalProcessed: 0,
        totalFailed: 0,
        totalDeadLettered: 0,
      },
    }),

  onAlarm: (state, config) =>
    Effect.gen(function* () {
      const ctx = yield* PrimitiveContext;
      const now = yield* ctx.now;

      let newState = state;

      // 1. Check for timed-out processing
      for (const proc of state.processing) {
        if (now - proc.startedAt > config.processingTimeout) {
          // Timed out - treat as failure
          newState = handleProcessingFailure(
            newState,
            proc.id,
            "Processing timeout",
            now
          );
        }
      }

      // 2. Process ready items if slots available
      while (
        newState.processing.length < config.slotsPerPartition &&
        newState.queue.length > 0
      ) {
        const next = getNextReadyEvent(newState.queue, now);
        if (!next) break;

        // Move from queue to processing
        newState = {
          ...newState,
          queue: newState.queue.filter((e) => e.id !== next.id),
          processing: [
            ...newState.processing,
            {
              id: next.id,
              payload: next.payload,
              startedAt: now,
              attempts: next.attempts + 1,
            },
          ],
        };

        // Execute processing (fire-and-forget with callback)
        yield* executeProcessing(next, config);
      }

      // 3. Calculate next alarm
      const nextAlarm = calculateNextAlarm(newState, config, now);

      return { newState, nextAlarm };
    }),

  actions: {
    enqueue: (state, config, events) =>
      Effect.gen(function* () {
        const ctx = yield* PrimitiveContext;
        const now = yield* ctx.now;

        const availableCapacity = config.maxQueueDepth - state.queue.length;
        const toEnqueue = events.slice(0, availableCapacity);
        const rejected = events.length - toEnqueue.length;

        const newQueue = [
          ...state.queue,
          ...toEnqueue.map((payload, i) => ({
            id: `${now}-${i}-${Math.random().toString(36).slice(2)}`,
            payload,
            enqueuedAt: now,
            attempts: 0,
          })),
        ];

        // Try to start processing immediately if slots available
        let processing = state.processing;
        let queue = newQueue;

        while (
          processing.length < config.slotsPerPartition &&
          queue.length > 0
        ) {
          const next = queue[0];
          queue = queue.slice(1);
          processing = [
            ...processing,
            {
              id: next.id,
              payload: next.payload,
              startedAt: now,
              attempts: 1,
            },
          ];

          // Trigger processing
          yield* executeProcessing(next, config);
        }

        const newState = {
          ...state,
          queue,
          processing,
          metrics: {
            ...state.metrics,
            totalEnqueued: state.metrics.totalEnqueued + toEnqueue.length,
          },
        };

        // Schedule alarm for timeout checking
        const nextAlarm = processing.length > 0
          ? now + config.processingTimeout
          : undefined;

        return {
          newState,
          result: { queued: toEnqueue.length, rejected },
          nextAlarm,
        };
      }),

    getStatus: (state, _config) =>
      Effect.succeed({
        newState: state,
        result: {
          queueDepth: state.queue.length,
          processing: state.processing.length,
          deadLetterCount: state.deadLetter.length,
          metrics: state.metrics,
        },
      }),

    drain: (state, _config) =>
      Effect.succeed({
        newState: {
          ...state,
          queue: [],
          metrics: {
            ...state.metrics,
            totalFailed: state.metrics.totalFailed + state.queue.length,
          },
        },
        result: { drained: state.queue.length },
      }),
  },
};
```

### Router Implementation

```typescript
/**
 * Routes events to partitions based on configured strategy.
 */
class ConcurrencyRouter {
  constructor(
    private readonly client: PrimitiveClient,
    private readonly config: {
      partitions: number;
      routing: "round-robin" | "hash" | "random";
      hashKey?: (event: unknown) => string;
    }
  ) {}

  private roundRobinCounter = 0;

  /**
   * Route a batch of events to appropriate partitions.
   * Returns map of partition -> events for efficient batching.
   */
  async routeBatch(events: unknown[]): Promise<Map<number, unknown[]>> {
    const partitioned = new Map<number, unknown[]>();

    for (const event of events) {
      const partition = this.selectPartition(event);

      if (!partitioned.has(partition)) {
        partitioned.set(partition, []);
      }
      partitioned.get(partition)!.push(event);
    }

    return partitioned;
  }

  /**
   * Dispatch events to partitions.
   * Uses parallel dispatch for efficiency.
   */
  async dispatch(events: unknown[]): Promise<{
    queued: number;
    rejected: number;
    byPartition: Map<number, { queued: number; rejected: number }>;
  }> {
    const partitioned = await this.routeBatch(events);

    const results = await Promise.all(
      Array.from(partitioned.entries()).map(async ([partition, batch]) => {
        const result = await this.client
          .concurrencyPartition(`partition-${partition}`)
          .enqueue(batch);
        return { partition, result };
      })
    );

    let totalQueued = 0;
    let totalRejected = 0;
    const byPartition = new Map<number, { queued: number; rejected: number }>();

    for (const { partition, result } of results) {
      totalQueued += result.queued;
      totalRejected += result.rejected;
      byPartition.set(partition, result);
    }

    return { queued: totalQueued, rejected: totalRejected, byPartition };
  }

  private selectPartition(event: unknown): number {
    switch (this.config.routing) {
      case "round-robin":
        return this.roundRobinCounter++ % this.config.partitions;

      case "hash":
        if (!this.config.hashKey) {
          throw new Error("hashKey required for hash routing");
        }
        const key = this.config.hashKey(event);
        return this.hashToPartition(key);

      case "random":
        return Math.floor(Math.random() * this.config.partitions);
    }
  }

  private hashToPartition(key: string): number {
    // Simple hash - use crypto for production
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash) % this.config.partitions;
  }
}
```

### Backpressure Handling

```typescript
/**
 * Backpressure strategies when partitions are full.
 */
type BackpressureStrategy =
  | { type: "reject"; reason: string }
  | { type: "queue-external"; target: "cloudflare-queue" | "r2" }
  | { type: "throttle"; delayMs: number }
  | { type: "shed-load"; dropPercent: number };

/**
 * Router with backpressure awareness.
 */
class BackpressureAwareRouter extends ConcurrencyRouter {
  private partitionStatus = new Map<number, PartitionStatus>();
  private statusRefreshInterval = 5000; // 5 seconds
  private lastStatusRefresh = 0;

  async dispatch(events: unknown[]): Promise<DispatchResult> {
    // Refresh partition status if stale
    await this.maybeRefreshStatus();

    // Check for backpressure
    const backpressure = this.detectBackpressure();
    if (backpressure) {
      return this.handleBackpressure(events, backpressure);
    }

    // Normal dispatch
    return super.dispatch(events);
  }

  private detectBackpressure(): BackpressureStrategy | null {
    // Check if all partitions are near capacity
    const thresholdPercent = 0.8; // 80% full

    let totalCapacity = 0;
    let totalUsed = 0;

    for (const status of this.partitionStatus.values()) {
      totalCapacity += status.maxQueueDepth;
      totalUsed += status.queueDepth;
    }

    const utilizationPercent = totalUsed / totalCapacity;

    if (utilizationPercent > 0.95) {
      // Critical - reject
      return { type: "reject", reason: "Queue capacity exceeded" };
    }

    if (utilizationPercent > 0.8) {
      // Warning - throttle
      return { type: "throttle", delayMs: 100 };
    }

    return null;
  }

  private async handleBackpressure(
    events: unknown[],
    strategy: BackpressureStrategy
  ): Promise<DispatchResult> {
    switch (strategy.type) {
      case "reject":
        return {
          queued: 0,
          rejected: events.length,
          byPartition: new Map(),
          backpressure: strategy,
        };

      case "throttle":
        await sleep(strategy.delayMs);
        return super.dispatch(events);

      case "queue-external":
        // Send to external queue for later processing
        await this.sendToExternalQueue(events, strategy.target);
        return {
          queued: events.length,
          rejected: 0,
          byPartition: new Map(),
          backpressure: strategy,
        };

      case "shed-load":
        // Drop a percentage of events
        const keep = events.filter(
          () => Math.random() > strategy.dropPercent / 100
        );
        const dropped = events.length - keep.length;
        const result = await super.dispatch(keep);
        return {
          ...result,
          rejected: result.rejected + dropped,
          backpressure: strategy,
        };
    }
  }
}
```

---

## Alternative Approaches

### Alternative A: Cloudflare Queue Native

Use Cloudflare Queues' built-in concurrency control instead of building with DOs.

```typescript
// wrangler.toml
[[queues.consumers]]
queue = "events"
max_batch_size = 10
max_retries = 3
max_concurrency = 4  // <-- Native concurrency limit!

// worker
export default {
  async queue(batch, env) {
    // Process batch - CF guarantees max 4 concurrent
    for (const msg of batch.messages) {
      await processEvent(msg.body);
      msg.ack();
    }
  }
}
```

**Pros:**
- Zero coordination code
- Built-in retry/DLQ
- Managed scaling

**Cons:**
- Less control over routing
- Can't do priority queuing
- Limited to Queue semantics

**When to use:** If you don't need custom routing, ordering, or priority, use CF Queues directly.

### Alternative B: Hybrid (Queue + DO for State)

Use Queue for distribution, DO for processing state.

```
┌─────────┐     ┌─────────────┐     ┌────────────┐
│ Events  │────►│ CF Queue    │────►│ Worker     │
└─────────┘     │ (buffer)    │     │ (dispatch) │
                └─────────────┘     └──────┬─────┘
                                           │
                      ┌────────────────────┼────────────────────┐
                      │                    │                    │
                      ▼                    ▼                    ▼
              ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
              │ Processor   │      │ Processor   │      │ Processor   │
              │ DO (state)  │      │ DO (state)  │      │ DO (state)  │
              └─────────────┘      └─────────────┘      └─────────────┘
```

**Pros:**
- Queue handles distribution
- DOs handle stateful processing
- Clear separation of concerns

**Cons:**
- Two systems to manage
- Coordination between Queue and DOs

### Alternative C: Single Queue DO + Worker Pool

```typescript
// Central queue DO
class QueueDO {
  private queue: Event[] = [];

  async enqueue(events: Event[]) {
    this.queue.push(...events);
  }

  async pull(count: number): Promise<Event[]> {
    const batch = this.queue.splice(0, count);
    return batch;
  }
}

// Worker DO
class WorkerDO {
  async process() {
    // Pull from queue
    const events = await queueDO.pull(1);
    // Process
    await processEvent(events[0]);
    // Schedule next pull
    this.alarm(Date.now() + 10); // 10ms
  }
}
```

**Pros:**
- Simple mental model
- Natural work distribution

**Cons:**
- Queue is single point of failure
- Pull latency overhead
- Queue DO becomes bottleneck at scale

---

## Trade-off Matrix

| Approach | Throughput | Latency | Complexity | Reliability | Cost |
|----------|------------|---------|------------|-------------|------|
| **Partitioned Slots** | High | Low | Medium | High | Low |
| **Central Coordinator** | Medium | High | Low | Medium | Low |
| **CF Queue Native** | High | Medium | Very Low | Very High | Low |
| **Hybrid Queue+DO** | High | Medium | High | High | Medium |
| **Work Stealing** | High | Low | Very High | Medium | Low |

### Decision Guide

```
START
  │
  ├─► Need ordering guarantees?
  │     │
  │     ├─► Yes: Use Partitioned Slots with hash routing
  │     │        (events with same key go to same partition)
  │     │
  │     └─► No: Do you need custom processing logic?
  │               │
  │               ├─► Yes: Use Partitioned Slots with round-robin
  │               │
  │               └─► No: Use CF Queue Native
  │
  ├─► Processing time > 30 seconds?
  │     │
  │     └─► Yes: Use Hybrid (Queue buffers, DO tracks long-running)
  │
  ├─► Need priority queuing?
  │     │
  │     └─► Yes: Use Partitioned Slots with priority queue implementation
  │
  └─► Simple use case, minimal requirements?
        │
        └─► Yes: Use CF Queue Native
```

---

## Recommendations

### For Your Use Case (4 concurrent, stream processing)

**Recommended: Partitioned Slots with CF Queue Buffer**

```
┌──────────────────────────────────────────────────────────────────┐
│                      RECOMMENDED ARCHITECTURE                     │
│                                                                  │
│   ┌─────────┐     ┌──────────────┐     ┌─────────────────────┐  │
│   │ Events  │────►│ CF Queue     │────►│ Consumer Worker     │  │
│   │ (HTTP)  │     │ (buffer)     │     │ (batch router)      │  │
│   └─────────┘     └──────────────┘     └──────────┬──────────┘  │
│                                                   │              │
│                    ┌──────────────────────────────┼──────────────┤
│                    │              │               │              │
│                    ▼              ▼               ▼              ▼
│             ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│             │ Part. 0  │  │ Part. 1  │  │ Part. 2  │  │ Part. 3  │
│             │ (1 slot) │  │ (1 slot) │  │ (1 slot) │  │ (1 slot) │
│             │ DO       │  │ DO       │  │ DO       │  │ DO       │
│             └──────────┘  └──────────┘  └──────────┘  └──────────┘
│                                                                  │
│   Properties:                                                    │
│   - Max 4 concurrent (1 per partition)                          │
│   - CF Queue absorbs spikes                                      │
│   - Each DO manages its queue + processing                       │
│   - Failure isolated to partition                                │
│   - Linear scaling (add partitions = add concurrency)            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Implementation Checklist

1. **Phase 1: Core Partition Primitive**
   - [ ] Define `ConcurrencyPartitionHandler`
   - [ ] Implement queue management (enqueue, dequeue)
   - [ ] Implement slot-based processing control
   - [ ] Add timeout detection via alarms
   - [ ] Add retry logic with exponential backoff
   - [ ] Add dead-letter handling

2. **Phase 2: Router**
   - [ ] Implement partition selection (hash, round-robin)
   - [ ] Add batch routing for efficiency
   - [ ] Add backpressure detection
   - [ ] Add metrics/observability

3. **Phase 3: Integration**
   - [ ] CF Queue consumer setup
   - [ ] Batch dispatch from Queue to DOs
   - [ ] End-to-end monitoring
   - [ ] Load testing

4. **Phase 4: Hardening**
   - [ ] Chaos testing (DO restarts, timeouts)
   - [ ] Hot partition detection
   - [ ] Adaptive routing based on load
   - [ ] Alerting on queue depth, DLQ growth

### Key Metrics to Monitor

| Metric | Warning Threshold | Critical Threshold |
|--------|-------------------|-------------------|
| Queue depth per partition | > 1000 | > 5000 |
| Processing latency P99 | > 5s | > 30s |
| Dead-letter rate | > 1% | > 5% |
| Retry rate | > 10% | > 25% |
| Partition imbalance ratio | > 2:1 | > 5:1 |

### Cost Estimation

```
Assumptions:
- 1M events/day
- 4 partitions
- 100ms avg processing time
- 1KB avg event size

DO Requests:
- Enqueue: 1M / 100 (batched) = 10,000 requests
- Alarm: ~10,000 requests (one per batch)
- Total: ~20,000 requests/day = $0.30/day

DO Storage:
- ~10,000 operations/day = $0.01/day

CF Queue:
- 1M messages = $0.40/day

Total: ~$0.71/day = ~$21/month

Note: This scales linearly with volume.
At 10M events/day: ~$210/month
```

---

## Summary

Building a distributed concurrency manager on Durable Objects requires careful consideration of:

1. **Work Distribution**: How events are routed to partitions affects load balance
2. **Concurrency Control**: Slot-based processing within each partition
3. **Failure Handling**: Timeouts, retries, and dead-letter queues
4. **Backpressure**: What happens when demand exceeds capacity
5. **Scaling**: How to add capacity without redesign

The **Partitioned Slots** architecture provides the best balance of simplicity and scalability for most use cases. Combined with Cloudflare Queues for buffering, it handles high-throughput event streams while maintaining strict concurrency limits.

Key insight: Don't fight against the distributed nature of DOs - embrace it by partitioning work and avoiding coordination where possible. Each partition should be fully independent, with the router being the only component that needs global awareness.
