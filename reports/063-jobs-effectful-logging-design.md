# Report 063: Jobs Package Effectful Logging Design

## Overview

Design for adding an Effect-based logging system to `@durable-effect/jobs` that:
- Is **disabled by default** (zero overhead when not enabled)
- Can be **enabled per-job** via configuration
- Uses **Effect's native logging** with proper log levels
- Provides **rich context** via annotations (instanceId, jobName, jobType, etc.)
- Uses **log spans** for timing measurements

## Effect Logging Patterns

Based on the [Effect Logging Documentation](https://effect.website/docs/observability/logging/):

### Log Levels

```typescript
// Log levels (severity order) - DEBUG is hidden by default
Effect.logDebug("...")   // Hidden by default, enable with Logger.withMinimumLogLevel
Effect.logInfo("...")    // Visible by default
Effect.logWarning("...") // Visible by default
Effect.logError("...")   // Visible by default
Effect.logFatal("...")   // Visible by default

// Multiple messages at once
Effect.log("msg1", "msg2", "msg3")

// Include error causes for detailed context
Effect.log("message", Cause.die("Oh no!"))
```

### Control Log Level

```typescript
import { Effect, Logger, LogLevel } from "effect"

// Per-effect control - enable DEBUG for specific operations
const task = Effect.gen(function* () {
  yield* Effect.logDebug("diagnostic info")
}).pipe(Logger.withMinimumLogLevel(LogLevel.Debug))

// Disable all logging
effect.pipe(Logger.withMinimumLogLevel(LogLevel.None))

// As a Layer (for broader application)
const layer = Logger.minimumLogLevel(LogLevel.Debug)
Effect.provide(program, layer)
```

### Annotations (Add Context to Logs)

```typescript
// Single annotation
Effect.log("message").pipe(
  Effect.annotateLogs("userId", "12345")
)

// Multiple annotations at once (preferred)
Effect.log("message").pipe(
  Effect.annotateLogs({
    jobType: "continuous",
    jobName: "tokenRefresher",
    instanceId: "abc123"
  })
)

// Annotations propagate to ALL nested effects
const program = Effect.gen(function* () {
  yield* Effect.log("message1")      // Has annotations
  yield* someNestedEffect            // Also has annotations!
}).pipe(
  Effect.annotateLogs({ key: "value" })
)
```

### Log Spans (Measure Duration)

```typescript
// Wrap an operation to measure its duration
const program = Effect.gen(function* () {
  yield* Effect.sleep("1 second")
  yield* Effect.log("The job is finished!")
}).pipe(
  Effect.withLogSpan("execution")  // Adds execution=1011ms to logs
)

// Output:
// timestamp=... level=INFO message="The job is finished!" execution=1011ms
```

### Built-in Loggers

```typescript
// Default: stringLogger (human-readable key-value)
// timestamp=... level=INFO fiber=#0 message=...

// JSON format (useful for log aggregation)
Effect.provide(program, Logger.json)

// Pretty format (colorized, good for development)
Effect.provide(program, Logger.pretty)

// Structured format (object-based, for programmatic access)
Effect.provide(program, Logger.structured)
```

### Recommended Pattern for Jobs

```typescript
// Wrap job execution with log level control and annotations
const withJobLogging = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  config: {
    logging?: boolean;
    jobType: string;
    jobName: string;
    instanceId: string;
  }
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.annotateLogs({
      jobType: config.jobType,
      jobName: config.jobName,
      instanceId: config.instanceId,
    }),
    config.logging
      ? Logger.withMinimumLogLevel(LogLevel.Debug)
      : Logger.withMinimumLogLevel(LogLevel.None)
  )
```

## Job Configuration Changes

### Add `logging` Option to Each Job Type

```typescript
// In ContinuousMakeConfig
export interface ContinuousMakeConfig<S, E, R> {
  readonly stateSchema: Schema.Schema<S, any, never>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;
  readonly retry?: JobRetryConfig;
  /**
   * Enable debug logging for this job.
   * @default false
   */
  readonly logging?: boolean;
  execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, R>;
}

// Same for DebounceMakeConfig, TaskMakeConfig
```

### Stored Definition Types

```typescript
// In StoredContinuousDefinition
export interface StoredContinuousDefinition<S = unknown, R = never> {
  readonly _tag: "ContinuousDefinition";
  readonly name: string;
  // ... existing fields ...
  readonly logging?: boolean;  // NEW
}
```

## Log Points by Component

### 1. Dispatcher (`dispatcher.ts`)

| Log Level | When | Message | Annotations |
|-----------|------|---------|-------------|
| DEBUG | Request received | `"Dispatching request"` | type, action, name |
| DEBUG | Request completed | `"Request completed"` | type, action, durationMs |
| DEBUG | Alarm received | `"Handling alarm"` | jobType, jobName |
| WARN | Unknown job type | `"Unknown job type in alarm"` | type |

### 2. Continuous Handler (`continuous/handler.ts`)

| Log Level | When | Message | Annotations |
|-----------|------|---------|-------------|
| INFO | Job started | `"Continuous job started"` | instanceId, runCount: 0 |
| DEBUG | Execution starting | `"Starting execution"` | runCount, attempt, isRetry |
| DEBUG | Execution completed | `"Execution completed"` | runCount, durationMs, success |
| DEBUG | Schedule set | `"Next execution scheduled"` | nextRunAt |
| INFO | Job terminated | `"Continuous job terminated"` | reason, finalRunCount |
| WARN | Retry scheduled | `"Execution failed, retry scheduled"` | attempt, nextAttemptAt |
| ERROR | Retry exhausted | `"All retries exhausted"` | attempts, totalDurationMs |

### 3. Debounce Handler (`debounce/handler.ts`)

| Log Level | When | Message | Annotations |
|-----------|------|---------|-------------|
| INFO | First event | `"Debounce started"` | instanceId, flushAt |
| DEBUG | Event added | `"Event added"` | eventCount, willFlushAt |
| DEBUG | MaxEvents hit | `"Max events reached, flushing"` | eventCount |
| INFO | Flush executed | `"Debounce flushed"` | eventCount, reason, durationMs |
| DEBUG | State purged | `"Debounce state purged"` | - |
| WARN | Flush failed | `"Flush execution failed"` | error, willRetry |

### 4. Task Handler (`task/handler.ts`)

| Log Level | When | Message | Annotations |
|-----------|------|---------|-------------|
| INFO | Task created | `"Task created"` | instanceId |
| DEBUG | Event received | `"Event received"` | eventCount, isFirstEvent |
| DEBUG | Schedule set | `"Execution scheduled"` | scheduledAt, trigger |
| DEBUG | Execute started | `"Execute started"` | executeCount |
| DEBUG | Execute completed | `"Execute completed"` | executeCount, durationMs |
| DEBUG | Idle triggered | `"Task idle"` | idleReason |
| INFO | Task terminated | `"Task terminated"` | - |
| WARN | Error handled | `"Error in handler"` | errorSource, error |

### 5. Execution Service (`services/execution.ts`)

| Log Level | When | Message | Annotations |
|-----------|------|---------|-------------|
| DEBUG | Execute starting | `"User function starting"` | jobType, jobName, attempt |
| DEBUG | Execute succeeded | `"User function succeeded"` | durationMs |
| WARN | Execute failed | `"User function failed"` | error, willRetry |
| WARN | Retry scheduled | `"Retry scheduled"` | nextAttempt, delayMs |
| ERROR | Retry exhausted | `"Retries exhausted"` | attempts, reason |
| INFO | Job terminated | `"Job terminated via signal"` | reason |

### 6. Retry Executor (`retry/executor.ts`)

| Log Level | When | Message | Annotations |
|-----------|------|---------|-------------|
| DEBUG | Attempt starting | `"Retry attempt starting"` | attempt, maxAttempts |
| DEBUG | Delay calculated | `"Retry delay calculated"` | delayMs, jitter |
| WARN | Attempt failed | `"Attempt failed"` | attempt, error |

## Implementation Architecture

### Core Helper: `withJobLogging`

Use Effect's built-in log level control with annotations in object form:

```typescript
// packages/jobs/src/services/job-logging.ts

import { Effect, Logger, LogLevel } from "effect";

/**
 * Wrap an effect with job-scoped logging.
 *
 * - Adds job context as annotations (propagates to all nested logs)
 * - Controls log level based on job's logging config
 * - When logging is disabled, sets level to None (zero overhead)
 */
export const withJobLogging = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  config: {
    logging?: boolean;
    jobType: string;
    jobName: string;
    instanceId: string;
  }
): Effect.Effect<A, E, R> =>
  effect.pipe(
    // Add all annotations at once using object form
    Effect.annotateLogs({
      jobType: config.jobType,
      jobName: config.jobName,
      instanceId: config.instanceId,
    }),
    // Control log level - None disables all logging (zero overhead)
    config.logging
      ? Logger.withMinimumLogLevel(LogLevel.Debug)
      : Logger.withMinimumLogLevel(LogLevel.None)
  );

/**
 * Wrap an execution with a log span to measure duration.
 * Duration is automatically added to all logs within the span.
 */
export const withExecutionSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  spanName: string
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.withLogSpan(spanName));
```

### Usage Pattern in Handlers

```typescript
// In continuous/handler.ts
const handleStart = (def, request) =>
  withJobLogging(
    Effect.gen(function* () {
      yield* Effect.logInfo("Job started");

      // Execution with timing span
      yield* withExecutionSpan(
        Effect.gen(function* () {
          yield* Effect.logDebug("Execution starting", { runCount, attempt });
          const result = yield* runExecution(def, runCount);
          yield* Effect.logDebug("Execution completed");
          return result;
        }),
        "execution"
      );

      yield* Effect.logDebug("Next execution scheduled", { nextRunAt });
    }),
    {
      logging: def.logging,
      jobType: "continuous",
      jobName: def.name,
      instanceId: runtime.instanceId,
    }
  );
```

### Adding Dynamic Annotations

For logs that need additional context beyond the base job annotations:

```typescript
// Add extra annotations for specific log statements
yield* Effect.logDebug("Event added").pipe(
  Effect.annotateLogs({ eventCount: 5, willFlushAt: "2024-01-15T10:35:00Z" })
);

// Or for a block of operations
yield* Effect.gen(function* () {
  yield* Effect.logDebug("Processing retry");
  yield* someRetryLogic;
  yield* Effect.logDebug("Retry complete");
}).pipe(
  Effect.annotateLogs({ attempt: 2, maxAttempts: 3 })
);
```

## Implementation Steps

### Step 1: Add `logging` to Definition Types

```typescript
// registry/types.ts
export interface UnregisteredContinuousDefinition<S, E, R> {
  // ... existing fields ...
  readonly logging?: boolean;
}

// Same for UnregisteredDebounceDefinition, UnregisteredTaskDefinition
```

### Step 2: Create Job Logging Helper

```typescript
// services/job-logging.ts
import { Effect, Logger, LogLevel } from "effect";

export const withJobLogging = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  config: {
    logging?: boolean;
    jobType: string;
    jobName: string;
    instanceId: string;
  }
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.annotateLogs({
      jobType: config.jobType,
      jobName: config.jobName,
      instanceId: config.instanceId,
    }),
    config.logging
      ? Logger.withMinimumLogLevel(LogLevel.Debug)
      : Logger.withMinimumLogLevel(LogLevel.None)
  );

export const withExecutionSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  spanName: string
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.withLogSpan(spanName));
```

### Step 3: Update Definition Factories

```typescript
// definitions/continuous.ts
export interface ContinuousMakeConfig<S, E, R> {
  // ... existing fields ...
  /**
   * Enable debug logging for this job.
   * When enabled, logs job lifecycle, execution, and retry events.
   * @default false
   */
  readonly logging?: boolean;
}

export const Continuous = {
  make: <S, E = never, R = never>(
    config: ContinuousMakeConfig<S, E, R>
  ): UnregisteredContinuousDefinition<S, E, R> => ({
    // ... existing ...
    logging: config.logging,
  }),
};
```

### Step 4: Apply in Handlers

```typescript
// In handlers/continuous/handler.ts
import { withJobLogging, withExecutionSpan } from "../../services/job-logging";

const handleStart = (def, request) =>
  withJobLogging(
    Effect.gen(function* () {
      yield* Effect.logInfo("Job started");

      yield* withExecutionSpan(
        Effect.gen(function* () {
          yield* Effect.logDebug("Execution starting").pipe(
            Effect.annotateLogs({ runCount, attempt })
          );
          const result = yield* runExecution(def, runCount);
          yield* Effect.logDebug("Execution completed");
          return result;
        }),
        "execution"
      );

      yield* Effect.logDebug("Next execution scheduled").pipe(
        Effect.annotateLogs({ nextRunAt })
      );
    }),
    {
      logging: def.logging,
      jobType: "continuous",
      jobName: def.name,
      instanceId: runtime.instanceId,
    }
  );
```

## Context Available for Logging

### From Runtime Adapter
- `instanceId` - Unique DO instance ID

### From Job Definition
- `name` - Job name (from registry key)
- `logging` - Whether logging is enabled

### From Request
- `action` - The action being performed
- `id` - User-provided correlation ID

### From Execution Context
- `runCount` - Number of executions (continuous)
- `eventCount` - Number of events (debounce, task)
- `attempt` - Current retry attempt
- `isRetry` - Whether this is a retry

### From Execution Result
- `success` - Whether execution succeeded
- `retryScheduled` - Whether retry was scheduled
- `terminated` - Whether job was terminated
- `durationMs` - Execution duration

## Example: User Experience

```typescript
// User enables logging for a specific job
const tokenRefresher = Continuous.make({
  stateSchema: TokenState,
  schedule: Continuous.every("5 minutes"),
  logging: true,  // <-- Enable logging
  execute: (ctx) =>
    Effect.gen(function* () {
      const token = yield* refreshToken();
      yield* ctx.setState({ token, refreshedAt: Date.now() });
    }),
});
```

**Output when logging is enabled:**

```
timestamp=2024-01-15T10:30:00.000Z level=INFO fiber=#0 message="Job started" jobType=continuous jobName=tokenRefresher instanceId=abc123
timestamp=2024-01-15T10:30:00.005Z level=DEBUG fiber=#0 message="Execution starting" jobType=continuous jobName=tokenRefresher instanceId=abc123 runCount=1 attempt=1
timestamp=2024-01-15T10:30:00.150Z level=DEBUG fiber=#0 message="Execution completed" jobType=continuous jobName=tokenRefresher instanceId=abc123 execution=145ms
timestamp=2024-01-15T10:30:00.152Z level=DEBUG fiber=#0 message="Next execution scheduled" jobType=continuous jobName=tokenRefresher instanceId=abc123 nextRunAt=2024-01-15T10:35:00.000Z
```

Note: The `execution=145ms` is automatically added by `Effect.withLogSpan("execution")`.

**Debounce example:**

```
timestamp=... level=INFO fiber=#0 message="Debounce started" jobType=debounce jobName=webhookBatch instanceId=xyz789 flushAt=2024-01-15T10:35:00.000Z
timestamp=... level=DEBUG fiber=#0 message="Event added" jobType=debounce jobName=webhookBatch instanceId=xyz789 eventCount=5
timestamp=... level=DEBUG fiber=#0 message="Max events reached, flushing" jobType=debounce jobName=webhookBatch instanceId=xyz789 eventCount=10
timestamp=... level=INFO fiber=#0 message="Debounce flushed" jobType=debounce jobName=webhookBatch instanceId=xyz789 eventCount=10 reason=maxEvents flush=523ms
```

## Files to Modify

| File | Change |
|------|--------|
| `src/definitions/continuous.ts` | Add `logging?: boolean` to config |
| `src/definitions/debounce.ts` | Add `logging?: boolean` to config |
| `src/definitions/task.ts` | Add `logging?: boolean` to config |
| `src/registry/types.ts` | Add `logging?: boolean` to all definition types |
| `src/services/job-logging.ts` | NEW: Helper for log level control + annotations |
| `src/handlers/continuous/handler.ts` | Wrap with logging, add log statements |
| `src/handlers/debounce/handler.ts` | Wrap with logging, add log statements |
| `src/handlers/task/handler.ts` | Wrap with logging, add log statements |
| `src/services/execution.ts` | Add log statements for execution lifecycle |
| `src/runtime/dispatcher.ts` | Add log statements for routing |

## Implementation Order

1. **Phase 1: Infrastructure**
   - Add `logging` to definition types
   - Create `withJobLogging` helper
   - Update definition factories

2. **Phase 2: Handler Integration**
   - Add logging to Continuous handler
   - Add logging to Debounce handler
   - Add logging to Task handler

3. **Phase 3: Service Integration**
   - Add logging to Execution service
   - Add logging to Dispatcher

4. **Phase 4: Testing**
   - Verify logging disabled by default
   - Test log output when enabled
   - Ensure no performance impact when disabled

## Performance Considerations

- When `logging: false` (default), `Logger.withMinimumLogLevel(LogLevel.None)` ensures zero logging overhead
- Effect's logging is lazy - message strings are not constructed if log level is filtered
- Annotations are only applied when logging is enabled

Sources:
- [Effect Logging Documentation](https://effect.website/docs/observability/logging/)
- [Logger API Reference](https://effect-ts.github.io/effect/effect/Logger.ts.html)
