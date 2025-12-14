# Durable Jobs: Continuous & Buffer Deep Dive

## Executive Summary

This report explores two fundamental durable jobs:

1. **Continuous** - Long-running processes that execute on a schedule, maintain state, and run until a termination condition
2. **Buffer** - Event accumulators that collect items over time, aggregate them, and flush based on triggers

Both jobs share common concerns around durability, state management, error handling, and developer experience, but have distinct lifecycle and execution models.

---

## Part 1: Continuous Process

### 1.1 Core Mental Model

A Continuous process is a **durable loop** that:
- Executes some work
- Determines when to run next
- Persists state between executions
- Continues until explicitly stopped or a condition is met

Think of it as a durable `setInterval` with state, intelligence, and resilience.

### 1.2 Lifecycle States

```
                    ┌─────────┐
                    │  INIT   │
                    └────┬────┘
                         │ start()
                         ▼
    ┌──────────────►┌─────────┐
    │               │ WAITING │◄──────────────┐
    │               └────┬────┘               │
    │                    │ timer fires        │
    │                    ▼                    │
    │               ┌─────────┐               │
    │    resume()   │ RUNNING │───────────────┤ continue(delay)
    │               └────┬────┘               │
    │                    │                    │
    │         ┌──────────┼──────────┐         │
    │         │          │          │         │
    │         ▼          ▼          ▼         │
    │    ┌────────┐ ┌────────┐ ┌────────┐     │
    │    │ PAUSED │ │ FAILED │ │STOPPED │     │
    │    └────────┘ └────────┘ └────────┘     │
    │         │                               │
    └─────────┘                               │
                                              │
    External trigger ─────────────────────────┘
```

**States:**
- **INIT** - Created but never started
- **WAITING** - Sleeping until next scheduled execution
- **RUNNING** - Currently executing work
- **PAUSED** - Manually paused, can be resumed
- **FAILED** - Error state (configurable: auto-retry or terminal)
- **STOPPED** - Terminal state, process complete

### 1.3 Scheduling Models

#### Fixed Interval
```ts
// Run every 30 minutes
interval: "30 minutes"
```

Simple, predictable. Good for: heartbeats, periodic cleanup, fixed-schedule polling.

#### Dynamic Interval (Result-Based)
```ts
// Execute returns when to run next
execute: (state) => Effect.succeed({
  nextRun: state.tokenExpiresAt.minus("5 minutes"),
  state: { ...state, lastRefresh: Date.now() }
})
```

Schedule determined by execution result. Good for: token refresh (based on expiry), adaptive polling, event-driven timing.

#### Cron-Based
```ts
// Run at specific times
cron: "0 9 * * MON-FRI"  // 9am weekdays
```

Calendar-aware scheduling. Good for: reports, daily digests, business-hours operations.

#### Hybrid: Scheduled + External Trigger
```ts
// Both scheduled and externally triggerable
interval: "1 hour",
allowExternalTrigger: true
```

Allows `client.trigger("tokenRefresher")` to force immediate execution. Good for: on-demand refresh, webhook-triggered processing.

### 1.4 State Management

#### State Shape
```ts
Continuous.make<State>({
  initialState: { refreshCount: 0, lastToken: null },
  execute: (state) => ...
})
```

**Considerations:**
- State must be JSON-serializable (for durability)
- State should be immutable in user code (copy-on-write)
- Large state has performance implications

#### State Updates
```ts
// Option A: Return new state from execute
execute: (state) => Effect.succeed({
  continue: "30 minutes",
  state: { ...state, refreshCount: state.refreshCount + 1 }
})

// Option B: Provide state updater
execute: (state, ctx) => Effect.gen(function* () {
  yield* ctx.updateState(s => ({ ...s, refreshCount: s.refreshCount + 1 }))
  return { continue: "30 minutes" }
})
```

**Trade-offs:**
- Option A: Pure, easy to test, but forces full state return
- Option B: More flexible, supports partial updates, but less pure

#### External State Access
```ts
// Client can read state
const state = await client.getState("tokenRefresher")

// Client can update state (careful!)
await client.updateState("tokenRefresher", s => ({ ...s, forceRefresh: true }))
```

**Question:** Should external state updates trigger immediate execution?

### 1.5 Execution Return Types

What can `execute` return to control flow?

```ts
type ContinuousResult<S> =
  | { action: "continue"; delay?: Duration; state?: S }
  | { action: "stop"; reason?: string; state?: S }
  | { action: "pause"; resumeAt?: Date; state?: S }
  | { action: "retry"; delay?: Duration }  // Retry THIS execution
```

**DX Sugar:**
```ts
// Fluent API
return Continuous.continue("30 minutes").withState(newState)
return Continuous.stop("Token revoked")
return Continuous.pause().until(nextBusinessDay)
return Continuous.retry("5 seconds")
```

### 1.6 Error Handling

#### Error Scenarios
1. **Transient failures** - Network timeout, rate limit → should retry
2. **Permanent failures** - Invalid credentials, resource deleted → should stop
3. **Partial failures** - Work partially complete → complex recovery

#### Configuration
```ts
Continuous.make({
  execute: ...,

  // Retry policy for transient errors
  retry: {
    maxAttempts: 5,
    delay: Backoff.exponential({ base: "1 second" }),
    isRetryable: (error) => error._tag !== "AuthError"
  },

  // What to do after retries exhausted
  onRetriesExhausted: "pause" | "stop" | "continue-with-backoff",

  // Max consecutive failures before circuit break
  maxConsecutiveFailures: 10,

  // Custom error handler
  onError: (error, state, ctx) => Effect.gen(function* () {
    yield* ctx.alert("Process failing", { error })
    return { action: "pause", resumeAt: "1 hour" }
  })
})
```

#### Recovery Pattern
```ts
// State can track failures for custom recovery
execute: (state) => Effect.gen(function* () {
  try {
    const result = yield* doWork()
    return Continuous.continue("30 minutes").withState({
      ...state,
      consecutiveFailures: 0,
      lastSuccess: Date.now()
    })
  } catch (error) {
    const failures = state.consecutiveFailures + 1
    if (failures > 5) {
      return Continuous.stop("Too many failures")
    }
    // Exponential backoff based on failure count
    const delay = Math.min(30 * 60 * 1000, 1000 * Math.pow(2, failures))
    return Continuous.continue(delay).withState({
      ...state,
      consecutiveFailures: failures
    })
  }
})
```

### 1.7 Execution Context

What context is available during execution?

```ts
execute: (state, ctx) => Effect.gen(function* () {
  // Identity
  const processName = ctx.name           // "tokenRefresher"
  const instanceId = ctx.instanceId      // Unique per DO instance

  // Timing
  const executionId = ctx.executionId    // Unique per execution
  const scheduledAt = ctx.scheduledAt    // When this was supposed to run
  const startedAt = ctx.startedAt        // When it actually started
  const attempt = ctx.attempt            // Retry attempt number

  // State operations
  yield* ctx.updateState(...)

  // Observability
  yield* ctx.log("info", "Refreshing token", { userId: state.userId })
  yield* ctx.metric("token_refresh_duration", duration)

  // External communication
  yield* ctx.emit("token.refreshed", { userId: state.userId })
})
```

### 1.8 External Control (Client API)

```ts
// Get a client for a specific process instance
const client = PrimitiveClient.continuous("tokenRefresher", { userId: "123" })

// Lifecycle control
await client.start()
await client.stop("User requested")
await client.pause()
await client.resume()

// Force immediate execution (skip wait)
await client.trigger()

// State access
const state = await client.getState()
await client.updateState(s => ({ ...s, forceRefresh: true }))

// Status
const status = await client.getStatus()
// { state: "waiting", nextRunAt: Date, lastRunAt: Date, ... }

// History
const runs = await client.getHistory({ limit: 10 })
// [{ executionId, startedAt, completedAt, result, ... }]
```

### 1.9 Use Case: Token Refresher

```ts
interface TokenState {
  accessToken: string | null
  refreshToken: string
  expiresAt: number
  userId: string
  revoked: boolean
}

const tokenRefresher = Continuous.make<TokenState>({
  name: "tokenRefresher",

  initialState: (input: { userId: string; refreshToken: string }) => ({
    accessToken: null,
    refreshToken: input.refreshToken,
    expiresAt: 0,
    userId: input.userId,
    revoked: false
  }),

  execute: (state, ctx) => Effect.gen(function* () {
    // Check if should stop
    if (state.revoked) {
      return Continuous.stop("Token revoked")
    }

    // Refresh the token
    const result = yield* refreshAccessToken(state.refreshToken)

    // Store in database for other services to use
    yield* saveTokenToDatabase(state.userId, result.accessToken)

    // Calculate next refresh (5 minutes before expiry)
    const expiresAt = Date.now() + result.expiresIn * 1000
    const nextRefresh = expiresAt - 5 * 60 * 1000
    const delay = Math.max(nextRefresh - Date.now(), 60 * 1000) // Min 1 minute

    return Continuous.continue(delay).withState({
      ...state,
      accessToken: result.accessToken,
      expiresAt
    })
  }),

  // Handle auth errors specially
  onError: (error, state) => Effect.gen(function* () {
    if (error._tag === "TokenRevokedError") {
      return Continuous.stop("Token revoked by provider")
    }
    if (error._tag === "RateLimitError") {
      return Continuous.retry(error.retryAfter)
    }
    // Other errors: use default retry policy
    return Continuous.retry()
  }),

  retry: {
    maxAttempts: 5,
    delay: Backoff.exponential({ base: "30 seconds", max: "10 minutes" })
  }
})
```

### 1.10 Use Case: Event-Driven Messaging

```ts
interface ConversationState {
  userId: string
  stage: "welcome" | "onboarding" | "engaged" | "dormant"
  lastMessageSent: string | null
  lastUserAction: number
  messagesSent: number
  unsubscribed: boolean
}

const conversationManager = Continuous.make<ConversationState>({
  name: "conversationManager",

  initialState: (input: { userId: string }) => ({
    userId: input.userId,
    stage: "welcome",
    lastMessageSent: null,
    lastUserAction: Date.now(),
    messagesSent: 0,
    unsubscribed: false
  }),

  execute: (state, ctx) => Effect.gen(function* () {
    if (state.unsubscribed) {
      return Continuous.stop("User unsubscribed")
    }

    // Determine what message to send and when
    const decision = yield* determineNextAction(state)

    switch (decision.action) {
      case "send-message": {
        yield* sendMessage(state.userId, decision.message)
        return Continuous.continue(decision.nextCheckIn).withState({
          ...state,
          lastMessageSent: decision.message.id,
          messagesSent: state.messagesSent + 1
        })
      }

      case "wait": {
        // Check back later
        return Continuous.continue(decision.checkBackIn)
      }

      case "advance-stage": {
        return Continuous.continue("immediately").withState({
          ...state,
          stage: decision.newStage
        })
      }

      case "complete": {
        return Continuous.stop("Conversation complete")
      }
    }
  }),

  // Allow external events to trigger re-evaluation
  allowExternalTrigger: true,

  // When user takes action, update state and trigger
  // (from webhook handler):
  // await client.updateState(s => ({ ...s, lastUserAction: Date.now() }))
  // await client.trigger()
})
```

---

## Part 2: Buffer

### 2.1 Core Mental Model

A Buffer is a **durable accumulator** that:
- Receives events over time
- Aggregates them according to rules
- Flushes when trigger conditions are met
- Resets for the next batch

Think of it as a durable `reduce` with time-based flushing.

### 2.2 Lifecycle States

```
                    ┌─────────┐
                    │  EMPTY  │◄─────────────────┐
                    └────┬────┘                  │
                         │ first event           │
                         ▼                       │
                    ┌─────────┐                  │
        add(event)  │BUFFERING│◄────┐            │
              ┌────►└────┬────┘     │            │
              │          │          │            │
              │          │ trigger  │ add(event) │
              │          ▼          │            │
              │     ┌─────────┐     │            │
              │     │FLUSHING │─────┘            │
              │     └────┬────┘                  │
              │          │                       │
              │          │ flush complete        │
              │          ▼                       │
              │     ┌─────────┐                  │
              └─────│ DRAINED │──────────────────┘
                    └─────────┘    reset (or keep residual)
```

**States:**
- **EMPTY** - No events buffered, timer not started
- **BUFFERING** - Accumulating events, timer running
- **FLUSHING** - Processing accumulated events
- **DRAINED** - Flush complete, deciding whether to reset or keep

### 2.3 Accumulation Strategies

#### Keep All (Simple List)
```ts
Buffer.make({
  mode: "keep-all",
  flush: (events) => sendBatch(events)
})
// events: Event[]
```

Good for: analytics batching, audit logs, bulk operations.

#### Keep Latest (Replace)
```ts
Buffer.make({
  mode: "keep-latest",
  flush: (event) => processLatestEvent(event)
})
// Only the most recent event is kept
```

Good for: status updates where only final state matters.

#### Custom Reducer
```ts
Buffer.make<WebhookEvent, ContactSummary>({
  initialValue: { events: [], mostImportant: null, count: 0 },

  reducer: (summary, event) => ({
    events: [...summary.events, event],
    mostImportant: pickMoreImportant(summary.mostImportant, event),
    count: summary.count + 1
  }),

  flush: (summary) => sendConsolidatedNotification(summary)
})
```

Good for: aggregation, deduplication, prioritization.

#### Keyed Accumulation
```ts
Buffer.make<Event, Map<string, Event[]>>({
  keyBy: (event) => event.contactId,

  reducer: (map, key, event) => {
    const existing = map.get(key) || []
    return map.set(key, [...existing, event])
  },

  flush: (map) => Effect.forEach(map.entries(), ([key, events]) =>
    processContactEvents(key, events)
  )
})
```

Good for: per-entity batching, grouped processing.

### 2.4 Flush Triggers

#### Time-Based (Max Wait)
```ts
Buffer.make({
  maxWait: "5 minutes",
  // Flush 5 minutes after first event
})
```

**Semantics:**
- Timer starts when first event arrives
- Timer resets after flush
- Timer does NOT reset on subsequent events

#### Size-Based (Max Items)
```ts
Buffer.make({
  maxItems: 100,
  // Flush when 100 items accumulated
})
```

#### Combined (First Trigger Wins)
```ts
Buffer.make({
  maxWait: "5 minutes",
  maxItems: 100,
  // Flush when EITHER condition is met
})
```

#### Event-Based (Specific Event Triggers)
```ts
Buffer.make({
  flushOn: (aggregate, newEvent) => newEvent.type === "FINAL",
  // Flush immediately when specific event arrives
})
```

#### Inactivity Window (Session-Style)
```ts
Buffer.make({
  inactivityTimeout: "30 seconds",
  // Flush after 30 seconds of no new events
  // Timer RESETS on each new event
})
```

Good for: session-based batching, "burst then quiet" patterns.

#### Hybrid Complex
```ts
Buffer.make({
  maxWait: "10 minutes",        // Absolute max wait
  inactivityTimeout: "1 minute", // Flush after quiet period
  maxItems: 1000,                // Size limit
  flushOn: (agg, e) => e.priority === "urgent",
  // First condition wins
})
```

### 2.5 Flush Behavior

#### Post-Flush Reset Strategy
```ts
Buffer.make({
  // Option A: Full reset (default)
  onFlushComplete: "reset",

  // Option B: Keep state (for running aggregates)
  onFlushComplete: "keep",

  // Option C: Custom (partial reset)
  onFlushComplete: (aggregate) => ({
    ...aggregate,
    events: [],  // Clear events
    runningTotal: aggregate.runningTotal  // Keep running total
  })
})
```

#### Concurrent Event Handling
What happens if events arrive during flush?

```ts
Buffer.make({
  // Option A: Block additions during flush
  concurrency: "block",

  // Option B: Buffer to secondary buffer, merge after flush
  concurrency: "double-buffer",

  // Option C: Add to current buffer (will be in next batch)
  concurrency: "continue-buffering"
})
```

**Recommendation:** Double-buffer is safest - no data loss, no blocking.

### 2.6 Error Handling

#### Flush Failure
```ts
Buffer.make({
  flush: (aggregate) => sendBatch(aggregate),

  // Retry policy
  retryFlush: {
    maxAttempts: 5,
    delay: Backoff.exponential({ base: "1 second" })
  },

  // What to do after retries exhausted
  onFlushFailed: (error, aggregate) => Effect.gen(function* () {
    // Option A: Keep data, alert, manual intervention
    yield* alertOps("Buffer flush failed", { error, itemCount: aggregate.count })
    return { action: "pause" }  // Stop flushing, keep data

    // Option B: Dead letter queue
    yield* sendToDeadLetter(aggregate)
    return { action: "reset" }  // Clear buffer, data is in DLQ

    // Option C: Partial retry (if flush is idempotent)
    return { action: "retry", delay: "1 hour" }
  })
})
```

#### Reducer Failure
```ts
Buffer.make({
  reducer: (agg, event) => {
    // What if this throws?
  },

  onReducerError: (error, event) => Effect.gen(function* () {
    // Option A: Skip event, log warning
    yield* logWarning("Failed to reduce event", { event, error })
    return { action: "skip" }

    // Option B: Reject event (caller gets error)
    return { action: "reject", error }

    // Option C: Dead letter the event
    yield* sendToDeadLetter(event)
    return { action: "skip" }
  })
})
```

### 2.7 Buffer Context

```ts
Buffer.make({
  flush: (aggregate, ctx) => Effect.gen(function* () {
    // Identity
    const bufferName = ctx.name         // "eventBuffer"
    const instanceId = ctx.instanceId   // Per-DO instance
    const flushId = ctx.flushId         // Unique per flush

    // Timing
    const firstEventAt = ctx.firstEventAt
    const lastEventAt = ctx.lastEventAt
    const bufferDuration = ctx.bufferDuration

    // Trigger info
    const trigger = ctx.trigger  // "maxWait" | "maxItems" | "flushOn" | "manual"

    // Stats
    const eventCount = ctx.eventCount
    const totalEventsEver = ctx.totalEventsEver
    const flushCount = ctx.flushCount

    // Operations
    yield* ctx.log("info", "Flushing buffer", { count: eventCount })
    yield* ctx.metric("buffer_flush_size", eventCount)
  })
})
```

### 2.8 External Control (Client API)

```ts
const client = PrimitiveClient.buffer("eventBuffer", { contactId: "123" })

// Add events
await client.add(event)
await client.addMany(events)

// Manual control
await client.flush()        // Force immediate flush
await client.clear()        // Discard without flush
await client.reset()        // Clear and reset to initial state

// Inspection
const state = await client.peek()      // View current aggregate
const size = await client.size()       // Number of items
const status = await client.getStatus()
// { state: "buffering", size: 42, firstEventAt: Date, nextFlushAt: Date }

// History
const flushes = await client.getFlushHistory({ limit: 10 })
// [{ flushId, triggeredBy, itemCount, duration, result }]
```

### 2.9 Use Case: Webhook Event Consolidation

```ts
interface WebhookEvent {
  type: "order.placed" | "order.shipped" | "order.delivered" | "order.cancelled"
  orderId: string
  timestamp: number
  data: unknown
}

interface ContactNotification {
  contactId: string
  events: WebhookEvent[]
  mostImportant: WebhookEvent
  summary: string
}

const eventPriority: Record<WebhookEvent["type"], number> = {
  "order.cancelled": 4,  // Highest priority
  "order.delivered": 3,
  "order.shipped": 2,
  "order.placed": 1
}

const webhookBuffer = Buffer.make<WebhookEvent, ContactNotification>({
  name: "webhookBuffer",

  initialValue: (input: { contactId: string }) => ({
    contactId: input.contactId,
    events: [],
    mostImportant: null!,
    summary: ""
  }),

  reducer: (notification, event) => {
    const events = [...notification.events, event]
    const mostImportant =
      !notification.mostImportant ||
      eventPriority[event.type] > eventPriority[notification.mostImportant.type]
        ? event
        : notification.mostImportant

    return {
      ...notification,
      events,
      mostImportant,
      summary: generateSummary(events, mostImportant)
    }
  },

  // Flush triggers
  maxWait: "5 minutes",           // Don't wait more than 5 minutes
  inactivityTimeout: "30 seconds", // Flush after 30s quiet
  maxItems: 50,                   // Don't accumulate too many

  // Immediate flush for cancellations
  flushOn: (notification, event) => event.type === "order.cancelled",

  // Processing
  flush: (notification, ctx) => Effect.gen(function* () {
    yield* sendConsolidatedEmail(notification)
    yield* ctx.log("info", "Sent consolidated notification", {
      contactId: notification.contactId,
      eventCount: notification.events.length,
      triggeredBy: ctx.trigger
    })
  }),

  // Reset after flush
  onFlushComplete: "reset",

  // Error handling
  retryFlush: {
    maxAttempts: 3,
    delay: Backoff.exponential({ base: "5 seconds" })
  },

  onFlushFailed: (error, notification) => Effect.gen(function* () {
    // Send to dead letter for manual processing
    yield* sendToDeadLetter("notification-failures", {
      notification,
      error: error.message
    })
    return { action: "reset" }  // Clear buffer, data preserved in DLQ
  })
})
```

### 2.10 Use Case: Analytics Batching

```ts
interface AnalyticsEvent {
  eventId: string
  type: string
  properties: Record<string, unknown>
  timestamp: number
}

interface AnalyticsBatch {
  events: AnalyticsEvent[]
  totalSize: number  // Track payload size
}

const analyticsBuffer = Buffer.make<AnalyticsEvent, AnalyticsBatch>({
  name: "analyticsBuffer",

  initialValue: { events: [], totalSize: 0 },

  reducer: (batch, event) => {
    const eventSize = JSON.stringify(event).length
    return {
      events: [...batch.events, event],
      totalSize: batch.totalSize + eventSize
    }
  },

  // Flush triggers
  maxWait: "1 minute",
  maxItems: 1000,

  // Also flush if payload getting too large
  flushOn: (batch, event) => {
    const eventSize = JSON.stringify(event).length
    return batch.totalSize + eventSize > 1_000_000  // 1MB limit
  },

  flush: (batch) => Effect.gen(function* () {
    yield* sendToAnalyticsService(batch.events)
  }),

  // Handle high-throughput gracefully
  concurrency: "double-buffer",

  // Deduplication (in case of retries)
  deduplicateBy: (event) => event.eventId
})
```

---

## Part 3: Cross-Cutting Concerns

### 3.1 Durability Guarantees

#### What Gets Persisted?

**Continuous:**
- Current state
- Lifecycle status (running, paused, etc.)
- Next scheduled execution time
- Execution history (last N runs)
- Error state and retry count

**Buffer:**
- Current aggregate value
- Event count
- Timer state (when first event arrived)
- Flush history

#### When Does Persistence Happen?

```ts
// Option A: After every operation (safest, slowest)
persistOn: "every-operation"

// Option B: Periodic snapshots (balance)
persistOn: "periodic",
persistInterval: "10 seconds"

// Option C: On significant events (fastest, some data loss risk)
persistOn: "significant-events"  // state change, flush, error
```

#### Recovery After Crash

**Continuous:**
- Resume from last known state
- If was RUNNING, decide: re-execute or skip to next scheduled?
- Config: `onRecovery: "resume" | "restart-current" | "skip-to-next"`

**Buffer:**
- Restore aggregate from last checkpoint
- Events added after checkpoint are lost (acceptable?)
- Config: `onRecovery: "restore-and-resume" | "reset"`

### 3.2 Idempotency

#### Event Deduplication
```ts
Buffer.make({
  // Deduplicate by event ID
  deduplicateBy: (event) => event.id,

  // Deduplication window
  deduplicationWindow: "1 hour",

  // What to do with duplicate
  onDuplicate: "ignore" | "update" | "reject"
})
```

#### Flush Idempotency
```ts
Buffer.make({
  flush: (batch, ctx) => Effect.gen(function* () {
    // Include idempotency key for downstream services
    yield* sendBatch(batch, {
      idempotencyKey: ctx.flushId
    })
  })
})
```

### 3.3 Testing Support

#### Time Control
```ts
import { TestClock } from "@durable-effect/jobs/testing"

test("buffer flushes after maxWait", async () => {
  const clock = TestClock.make()
  const buffer = createTestBuffer({ clock })

  await buffer.add(event1)
  await buffer.add(event2)

  // Advance time
  await clock.advance("5 minutes")

  // Verify flush was called
  expect(flushSpy).toHaveBeenCalledWith(
    expect.objectContaining({ events: [event1, event2] })
  )
})
```

#### Execution Control
```ts
test("continuous stops on condition", async () => {
  const process = createTestContinuous({
    initialState: { count: 0 }
  })

  // Run one execution
  await process.tick()
  expect(process.state.count).toBe(1)

  // Set stop condition
  await process.updateState({ shouldStop: true })

  // Next execution should stop
  await process.tick()
  expect(process.status).toBe("stopped")
})
```

#### Snapshot Testing
```ts
test("reducer produces correct aggregate", () => {
  const events = [event1, event2, event3]
  const aggregate = events.reduce(bufferDefinition.reducer, initialValue)

  expect(aggregate).toMatchSnapshot()
})
```

### 3.4 Observability

#### Standard Events

**Continuous:**
```ts
"continuous.started"     // Process started
"continuous.executing"   // Execution began
"continuous.completed"   // Execution completed
"continuous.scheduled"   // Next execution scheduled
"continuous.paused"      // Process paused
"continuous.resumed"     // Process resumed
"continuous.stopped"     // Process stopped
"continuous.failed"      // Execution failed
"continuous.retrying"    // Retrying after failure
```

**Buffer:**
```ts
"buffer.created"         // Buffer initialized
"buffer.event_added"     // Event added
"buffer.flushing"        // Flush started
"buffer.flushed"         // Flush completed
"buffer.flush_failed"    // Flush failed
"buffer.reset"           // Buffer reset
"buffer.overflow"        // Max size reached
```

#### Metrics

**Continuous:**
- `continuous.execution_duration` (histogram)
- `continuous.executions_total` (counter)
- `continuous.failures_total` (counter)
- `continuous.schedule_drift` (histogram) - diff between scheduled and actual

**Buffer:**
- `buffer.size` (gauge)
- `buffer.flush_size` (histogram)
- `buffer.flush_duration` (histogram)
- `buffer.events_total` (counter)
- `buffer.flushes_total` (counter)
- `buffer.time_to_flush` (histogram) - time from first event to flush

### 3.5 Resource Management

#### Memory/Storage Limits
```ts
Buffer.make({
  // Hard limit on buffer size
  maxItems: 10000,

  // What to do when limit reached
  onOverflow: "drop-oldest" | "drop-newest" | "reject" | "force-flush",

  // Warn before hitting limit
  warnAt: 8000
})

Continuous.make({
  // Limit state size
  maxStateSize: "1 MB",

  // Limit history
  maxHistoryEntries: 100
})
```

#### Cleanup/Purge
```ts
// After process stops, how long to keep data?
Continuous.make({
  retentionAfterStop: "7 days"
})

// Periodic cleanup of old flush history
Buffer.make({
  flushHistoryRetention: "30 days"
})
```

### 3.6 Composability

#### Continuous Using Buffer
```ts
const metricsAggregator = Continuous.make({
  execute: (state, ctx) => Effect.gen(function* () {
    // Access buffer for this instance
    const buffer = yield* ctx.getBuffer("metricsBuffer")

    // Manually trigger flush
    yield* buffer.flush()

    return Continuous.continue("1 hour")
  })
})
```

#### Buffer Triggering Continuous
```ts
const eventBuffer = Buffer.make({
  flush: (events, ctx) => Effect.gen(function* () {
    // Process events
    yield* processEvents(events)

    // Trigger related continuous process
    const processor = yield* ctx.getContinuous("eventProcessor")
    yield* processor.trigger()
  })
})
```

### 3.7 Versioning and Migration

#### State Schema Evolution
```ts
Continuous.make({
  // Version for migration detection
  version: 2,

  // Migrate from old versions
  migrate: (oldState, oldVersion) => {
    if (oldVersion === 1) {
      return {
        ...oldState,
        newField: "default",
        // Transform old field
        updatedField: transformOldField(oldState.oldField)
      }
    }
    return oldState
  }
})
```

#### Behavior Changes
```ts
Buffer.make({
  // Feature flags for gradual rollout
  features: {
    newFlushLogic: env.ENABLE_NEW_FLUSH_LOGIC
  },

  flush: (aggregate, ctx) => {
    if (ctx.features.newFlushLogic) {
      return newFlush(aggregate)
    }
    return legacyFlush(aggregate)
  }
})
```

---

## Part 4: API Design Summary

### 4.1 Continuous API

```ts
interface ContinuousConfig<S, E, R> {
  // Identity
  name: string

  // State
  initialState: S | ((input: unknown) => S)
  version?: number
  migrate?: (oldState: unknown, oldVersion: number) => S

  // Core execution
  execute: (state: S, ctx: ContinuousContext) => Effect<ContinuousResult<S>, E, R>

  // Scheduling
  interval?: Duration | ((state: S) => Duration)
  cron?: string
  allowExternalTrigger?: boolean

  // Lifecycle
  shouldStop?: (state: S) => boolean
  onStart?: (state: S, ctx: ContinuousContext) => Effect<void, E, R>
  onStop?: (state: S, reason: string, ctx: ContinuousContext) => Effect<void, E, R>

  // Error handling
  retry?: RetryConfig<E>
  maxConsecutiveFailures?: number
  onError?: (error: E, state: S, ctx: ContinuousContext) => Effect<ErrorAction, never, R>
  onRetriesExhausted?: "pause" | "stop" | "continue-with-backoff"

  // Execution constraints
  timeout?: Duration

  // Recovery
  onRecovery?: "resume" | "restart-current" | "skip-to-next"

  // Resource management
  maxStateSize?: string
  maxHistoryEntries?: number
  retentionAfterStop?: Duration
}

type ContinuousResult<S> =
  | { action: "continue"; delay?: Duration; state?: S }
  | { action: "stop"; reason?: string; state?: S }
  | { action: "pause"; resumeAt?: Date; state?: S }
  | { action: "retry"; delay?: Duration }

// Fluent builders
const Continuous = {
  continue: (delay?: Duration) => ContinueBuilder,
  stop: (reason?: string) => StopBuilder,
  pause: () => PauseBuilder,
  retry: (delay?: Duration) => RetryBuilder
}
```

### 4.2 Buffer API

```ts
interface BufferConfig<E, A, Err, R> {
  // Identity
  name: string

  // Accumulation
  initialValue: A | ((input: unknown) => A)
  reducer: (aggregate: A, event: E) => A
  // OR simple modes:
  mode?: "keep-all" | "keep-latest"

  // Optional keyed accumulation
  keyBy?: (event: E) => string

  // Flush triggers
  maxWait?: Duration
  maxItems?: number
  inactivityTimeout?: Duration
  flushOn?: (aggregate: A, event: E) => boolean

  // Flush processing
  flush: (aggregate: A, ctx: BufferContext) => Effect<void, Err, R>

  // Post-flush behavior
  onFlushComplete?: "reset" | "keep" | ((aggregate: A) => A)

  // Error handling
  retryFlush?: RetryConfig<Err>
  onFlushFailed?: (error: Err, aggregate: A, ctx: BufferContext) => Effect<FlushErrorAction, never, R>
  onReducerError?: (error: unknown, event: E) => Effect<ReducerErrorAction, never, R>

  // Concurrency
  concurrency?: "block" | "double-buffer" | "continue-buffering"

  // Deduplication
  deduplicateBy?: (event: E) => string
  deduplicationWindow?: Duration
  onDuplicate?: "ignore" | "update" | "reject"

  // Resource management
  maxItems?: number
  onOverflow?: "drop-oldest" | "drop-newest" | "reject" | "force-flush"
  warnAt?: number
  flushHistoryRetention?: Duration

  // Versioning
  version?: number
  migrate?: (oldAggregate: unknown, oldVersion: number) => A
}

type FlushErrorAction =
  | { action: "reset" }
  | { action: "pause" }
  | { action: "retry"; delay?: Duration }

type ReducerErrorAction =
  | { action: "skip" }
  | { action: "reject"; error: unknown }
```

---

## Part 5: Open Questions

### For Continuous

1. **Overlapping Executions**: What if execution takes longer than interval? Options: skip, queue, allow parallel?

2. **External State Modifications**: Should updating state externally trigger immediate execution? Or just wait for next scheduled?

3. **Pause vs Stop**: Is PAUSED necessary, or is STOPPED + restart sufficient?

4. **Cron + Dynamic Interval**: Can these coexist? What takes precedence?

### For Buffer

1. **Partial Flush Failure**: If flushing 100 items and fails at item 50, what happens to the 50 already processed?

2. **Buffer Isolation**: Should each entity (e.g., contactId) have its own buffer, or one buffer with keyed sub-buffers?

3. **Backpressure**: If flush is slow and events keep arriving, how to handle? Queue unboundedly? Drop? Block producer?

4. **Ordering Guarantees**: Are events guaranteed to be flushed in order? What about with double-buffering?

### Cross-Cutting

1. **DO Limits**: Durable Objects have limits (128MB, execution time). How do these jobs surface/handle these?

2. **Multi-Region**: How do these jobs behave with DO's single-region primary nature?

3. **Cost Model**: How to help users understand/optimize DO cost implications?

---

## Conclusion

Continuous and Buffer are complementary jobs that address different temporal patterns:

| Aspect | Continuous | Buffer |
|--------|------------|--------|
| **Primary Pattern** | Scheduled execution | Event accumulation |
| **Time Model** | Execute → Wait → Execute | Receive → Accumulate → Flush |
| **State** | Persistent across runs | Reset after flush (usually) |
| **Trigger** | Time-based + external | Time + size + event + inactivity |
| **Use Cases** | Token refresh, polling, drip campaigns | Batching, consolidation, debounce |

Both share infrastructure concerns: durability, error handling, observability, testing, and resource management.

The key to good DX is:
1. **Sensible defaults** that work for common cases
2. **Escape hatches** for advanced customization
3. **Clear mental models** for lifecycle and data flow
4. **Excellent testing support** with time control
5. **Rich observability** out of the box
