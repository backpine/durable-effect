# Design: Durable Object Crash Recovery Detection

## Problem

When a Durable Object (DO) is re-instantiated after a crash, system failure, or redeploy, the constructor runs identically to a fresh startup. Cloudflare provides **no built-in signal** to distinguish between:

- First-ever instantiation
- Recovery from hibernation
- Eviction after idle (70–140s)
- Recovery after a crash or unclean shutdown
- Recovery after a redeploy

This means if a task was mid-execution when the DO went down, there's no native mechanism to detect that and resume or clean up.

## Cloudflare's Position

From the [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) docs:

> "Shutdown hooks or lifecycle callbacks that run before shutdown are not provided because Cloudflare cannot guarantee these hooks would execute in all cases."

There are **no startup-side recovery indicators** either. The constructor signature is always:

```typescript
constructor(ctx: DurableObjectState, env: Env)
```

`DurableObjectState` exposes `id`, `storage`, `blockConcurrencyWhile`, `waitUntil`, `abort`, `acceptWebSocket`, `getWebSockets`, `getTags`, and `exports`. None carry crash/recovery metadata.

### Alarm Retry Info (Partial Exception)

The alarm handler receives an optional `AlarmInvocationInfo`:

```typescript
alarm(alarmInfo?: AlarmInvocationInfo): void | Promise<void>
```

Where `AlarmInvocationInfo` has:
- `retryCount: number` — how many times this alarm has been retried
- `isRetry: boolean` — whether this invocation is a retry

This only tells you if the *alarm itself* is being retried (because the handler threw or the DO crashed during alarm execution). It does **not** provide general crash recovery information at the constructor level. Alarms retry up to 6 times with exponential backoff starting at 2 seconds.

## Strategy: Dirty Flag Pattern

Since storage survives crashes but in-memory state does not, we can use a persistent "dirty flag" to infer whether the previous instance shut down cleanly.

### Core Idea

1. On startup, check storage for a dirty flag
2. If present → previous instance didn't clean up → this is a crash recovery
3. Write the dirty flag to storage
4. After successfully completing critical work, clear the flag

Since Cloudflare provides **no shutdown hooks**, a crashed instance will never clear the flag — which is exactly the signal we need.

### Implementation

```typescript
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  ctx.blockConcurrencyWhile(async () => {
    const wasRunning = await ctx.storage.get("_dirty");
    if (wasRunning) {
      // This is a recovery — previous instance didn't clear the flag
      await this.handleCrashRecovery();
    }
    await ctx.storage.put("_dirty", true);
  });
}
```

### Key Properties

| Property | Detail |
|----------|--------|
| **False negatives** | None — a crash always leaves the flag set |
| **False positives** | Possible if the DO is evicted mid-operation before clearing the flag. Eviction after idle (70–140s) won't false-positive if the flag is cleared after initialization. Redeploys will also leave the flag set, which is arguably correct since they are also non-graceful shutdowns. |
| **Storage cost** | One additional KV read + write per instantiation |
| **Concurrency safety** | `blockConcurrencyWhile` ensures no requests are processed until recovery completes |

### When to Clear the Flag

The flag should be cleared when the DO reaches a known-good state. Options:

1. **After constructor initialization** — if recovery only needs to detect "was I mid-startup?"
2. **After completing a unit of work** — if recovery needs to detect "was I mid-task?"
3. **Never explicitly** — if you always want to run recovery logic on every non-first startup (simplest, but runs recovery unnecessarily after idle eviction)

For task-based systems, option 2 is usually correct: set the flag before processing an event, clear it after the event handler completes and state is persisted.

## Application to durable-effect Tasks

### Per-Task Dirty Tracking

Rather than a single global flag, each task instance can track its own dirty state using a scoped storage key:

```typescript
// Storage key: `_dirty:{taskName}:{taskId}`
const dirtyKey = `_dirty:${name}:${id}`
```

This allows the recovery handler to know *which* task instances were mid-execution when the crash occurred, rather than just "something was running."

### Recovery Flow

```
DO Constructor
  │
  ├─ blockConcurrencyWhile
  │    │
  │    ├─ storage.list({ prefix: "_dirty:" })
  │    │
  │    ├─ For each dirty task instance:
  │    │    ├─ Read last persisted state
  │    │    ├─ Determine recovery action (re-schedule alarm, emit error, etc.)
  │    │    └─ Clear dirty flag
  │    │
  │    └─ Ready to accept requests
  │
  └─ fetch() / alarm() proceed normally
```

### Integration Points

| Component | Change |
|-----------|--------|
| `TaskEngine` constructor | Add dirty-flag scan in `blockConcurrencyWhile` |
| `TaskRunner.handleEvent` | Set dirty flag before running handler, clear after |
| `TaskRunner.handleAlarm` | Set dirty flag before running handler, clear after |
| `TaskDefinition` | Add optional `onRecover` hook |
| `Task.define()` | Accept `onRecover` in config |

### `onRecover` Hook

```typescript
export interface TaskDefineConfig<S, E, EErr, AErr, R, OErr = never, RErr = never> {
  // ... existing fields ...
  readonly onRecover?: (ctx: TaskContext<S>) => Effect.Effect<void, RErr, R>
}
```

The hook receives a `TaskContext<S>` so it can:
- `recall()` the last persisted state
- `save()` corrected state
- `scheduleIn()` to re-arm a lost alarm
- `complete()` if the task should be considered done

If no `onRecover` hook is defined, the default behavior should be to re-schedule the alarm (since the most common crash scenario is a lost alarm timer).

### Example

```typescript
const counter = Task.define({
  state: CounterState,
  event: CounterEvent,

  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      yield* ctx.save({ count: 0 })
      yield* ctx.scheduleIn("2 seconds")
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state || state.count >= 10) return yield* ctx.complete()
      yield* ctx.save({ ...state, count: state.count + 1 })
      yield* ctx.scheduleIn("2 seconds")
    }),

  // Called when this task instance is found dirty after a crash
  onRecover: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.recall()
      if (!state) return // Nothing to recover
      // Re-arm the alarm that was lost in the crash
      yield* ctx.scheduleIn("1 second")
    }),
})
```

## Design Decisions

### Why a dirty flag instead of heartbeats

A heartbeat pattern (periodically writing a timestamp, detecting staleness) adds ongoing storage writes during normal operation. The dirty flag only writes twice per event/alarm cycle (set + clear) and requires no polling or timers.

### Why per-task-instance flags instead of a single global flag

A single flag tells you "something crashed" but not what. Per-instance flags let the recovery handler target only the affected task instances. The storage cost is negligible — one extra key per in-flight operation.

### Why `blockConcurrencyWhile` for recovery

Recovery must complete before the DO accepts new requests. Otherwise, a new event for a dirty task instance could race with the recovery handler. `blockConcurrencyWhile` is the standard Cloudflare mechanism for this — it's already used for constructor initialization.

### Why default to re-scheduling the alarm

The most common failure mode is: alarm fires → handler starts → DO crashes → alarm is consumed but work is incomplete. Re-scheduling the alarm restarts the task's progression loop. If the handler is idempotent (which task handlers should be), replaying the alarm is safe.

## Open Questions

1. **Should `onRecover` receive crash metadata?** We could store a timestamp when setting the dirty flag and pass the elapsed time to the recovery hook. This would let handlers make decisions like "if it's been more than 5 minutes, skip ahead."

2. **Should recovery errors go through `onError`?** If `onRecover` fails, should it be routed to the task's `onError` handler, or should it be a fatal error that prevents the DO from starting?

3. **Stage-aware recovery** — If the task has a `stage` concept (see `getStage`), the dirty flag could also store which stage the task was in, allowing more targeted recovery.
