# Jobs Package Type System Simplification Plan

## Executive Summary

The `@durable-effect/jobs` package has accumulated significant type complexity with ~80 instances of `any` types and numerous type casts. The core problem is that service requirements (R) are erased through `any` types, preventing compile-time enforcement.

**The solution is simple**: enforce `R = never` at the job definition level, and let users provide services using standard Effect patterns (`.pipe(Effect.provide(layer))`).

## Design Philosophy

### Principle 1: Effect-Native Patterns

Users should provide services the same way they would in any Effect code:

```typescript
export const myJob = Debounce.make({
  eventSchema: DebounceEvent,
  flushAfter: "5 seconds",

  execute: (ctx) =>
    Effect.gen(function* () {
      const random = yield* Random;
      const config = yield* Config;
      // ... job logic
    }).pipe(
      Effect.provide(Layer.mergeAll(RandomLive, ConfigLive))
    ),
});
```

### Principle 2: Compile-Time Enforcement

If user forgets to provide services:

```typescript
execute: (ctx) =>
  Effect.gen(function* () {
    const random = yield* Random;  // R = Random
  })
// ❌ Type error: Effect<void, E, Random> not assignable to Effect<void, E, never>
```

LSP shows `R = Random` on hover. Build fails. No runtime surprises.

### Principle 3: Abstract the Runtime

Users should never:
- Extend DO classes manually
- Know about `__JOB_REGISTRY__` or `__SERVICES_LAYER__`
- Deal with adapter internals

The package handles all durable runtime concerns internally.

---

## Current Problems

### Problem 1: `AnyUnregisteredDefinition` Uses `any` for R

**Location**: `packages/jobs/src/registry/types.ts:207-211`

```typescript
export type AnyUnregisteredDefinition =
  | UnregisteredContinuousDefinition<any, unknown, any>   // R = any ← PROBLEM
  | UnregisteredDebounceDefinition<any, any, unknown, any>
  | UnregisteredWorkerPoolDefinition<any, unknown, any>
  | UnregisteredTaskDefinition<any, any, unknown, any>;
```

**Impact**: Any R value is accepted without complaint.

### Problem 2: Execute Function Allows Any R

**Location**: `packages/jobs/src/registry/types.ts:70`

```typescript
execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, R>;
//                                                       ↑ R can be anything
```

**Impact**: User can return an effect with unmet requirements, and TypeScript doesn't complain.

### Problem 3: Runtime Never Checks R

The handlers call `def.execute(ctx)` and assume it works. If R ≠ never, it fails at runtime with "Service not found".

---

## Solution: Enforce R = never at Definition Level

### Core Change: Execute Must Return Fully-Provided Effect

```typescript
// packages/jobs/src/registry/types.ts

export interface UnregisteredContinuousDefinition<
  S = unknown,
  E = unknown,
  // R is removed from interface - execute must satisfy all requirements
> {
  readonly _tag: "ContinuousDefinition";
  readonly stateSchema: Schema.Schema<S, unknown, never>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;
  readonly retry?: JobRetryConfig;
  readonly logging?: LoggingOption;

  // Execute MUST return Effect with R = never
  // User provides services via .pipe(Effect.provide(...))
  execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, never>;
  //                                                       ↑ ENFORCED
}
```

### User Code Example

```typescript
// Define custom services
class Random extends Context.Tag("Random")<
  Random,
  { readonly next: Effect.Effect<number> }
>() {}

const RandomLive = Layer.succeed(Random, {
  next: Effect.sync(() => Math.random()),
});

class Config extends Context.Tag("Config")<
  Config,
  { readonly apiKey: string }
>() {}

const ConfigLive = Layer.succeed(Config, {
  apiKey: process.env.API_KEY ?? "default",
});

// Create job with services provided inline
export const debounceExample = Debounce.make({
  eventSchema: DebounceEvent,
  flushAfter: "5 seconds",
  maxEvents: 10,
  logging: true,

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const eventCount = yield* ctx.eventCount;

      // Use custom services
      const random = yield* Random;
      const config = yield* Config;

      const value = yield* random.next;
      yield* Effect.log(`API Key: ${config.apiKey}, Random: ${value}`);

      if (value < 0.1) {
        yield* Effect.fail("Random failure");
      }
    }).pipe(
      // Provide services - this makes R = never
      Effect.provide(Layer.mergeAll(RandomLive, ConfigLive))
    ),
});
```

### What Happens Without `.pipe(Effect.provide(...))`

```typescript
export const brokenJob = Debounce.make({
  eventSchema: DebounceEvent,
  flushAfter: "5 seconds",

  execute: (ctx) =>
    Effect.gen(function* () {
      const random = yield* Random;  // R = Random
      yield* Effect.log(`Value: ${yield* random.next}`);
    }),
    // ❌ Missing .pipe(Effect.provide(...))
});

// TypeScript Error:
// Type 'Effect<void, never, Random>' is not assignable to type 'Effect<void, never, never>'
// Types of property '[TypeId]' are incompatible.
//   Type '{ _R: (_: Random) => Random; ... }' is not assignable to type '{ _R: (_: never) => never; ... }'
```

LSP shows:
- Hover over `execute`: `Effect<void, never, Random>`
- Error squiggle under the entire execute function
- Quick fix suggestion to add Effect.provide

---

## Implementation Plan

### Phase 1: Update Definition Types (Breaking Change)

#### Step 1.1: Remove R from Unregistered Definitions

```typescript
// packages/jobs/src/registry/types.ts

// BEFORE
export interface UnregisteredContinuousDefinition<S, E, R> {
  execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, R>;
}

// AFTER
export interface UnregisteredContinuousDefinition<S = unknown, E = unknown> {
  readonly _tag: "ContinuousDefinition";
  readonly stateSchema: Schema.Schema<S, unknown, never>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;
  readonly retry?: JobRetryConfig;
  readonly logging?: LoggingOption;
  execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, never>;
}

export interface UnregisteredDebounceDefinition<I = unknown, S = unknown, E = unknown> {
  readonly _tag: "DebounceDefinition";
  readonly eventSchema: Schema.Schema<I, unknown, never>;
  readonly stateSchema: Schema.Schema<S, unknown, never>;
  readonly flushAfter: Duration.DurationInput;
  readonly maxEvents?: number;
  readonly retry?: JobRetryConfig;
  readonly logging?: LoggingOption;
  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, E, never>;
  onEvent?(ctx: DebounceEventContext<I, S>): Effect.Effect<S, never, never>;
}

export interface UnregisteredWorkerPoolDefinition<E = unknown, Err = unknown> {
  readonly _tag: "WorkerPoolDefinition";
  readonly eventSchema: Schema.Schema<E, unknown, never>;
  readonly concurrency: number;
  readonly retry?: WorkerPoolRetryConfig;
  execute(ctx: WorkerPoolExecuteContext<E>): Effect.Effect<void, Err, never>;
  onDeadLetter?(event: E, error: Err, ctx: WorkerPoolDeadLetterContext): Effect.Effect<void, never, never>;
  onEmpty?(ctx: WorkerPoolEmptyContext): Effect.Effect<void, never, never>;
}

export interface UnregisteredTaskDefinition<S = unknown, E = unknown, Err = unknown> {
  readonly _tag: "TaskDefinition";
  readonly stateSchema: Schema.Schema<S, unknown, never>;
  readonly eventSchema: Schema.Schema<E, unknown, never>;
  readonly logging?: LoggingOption;
  onEvent(event: E, ctx: TaskEventContext<S>): Effect.Effect<void, Err, never>;
  execute(ctx: TaskExecuteContext<S>): Effect.Effect<void, Err, never>;
  onIdle?(ctx: TaskIdleContext<S>): Effect.Effect<void, never, never>;
  onError?(error: Err, ctx: TaskErrorContext<S>): Effect.Effect<void, never, never>;
}
```

#### Step 1.2: Update AnyUnregisteredDefinition

```typescript
// No more `any` for R since R doesn't exist
export type AnyUnregisteredDefinition =
  | UnregisteredContinuousDefinition<unknown, unknown>
  | UnregisteredDebounceDefinition<unknown, unknown, unknown>
  | UnregisteredWorkerPoolDefinition<unknown, unknown>
  | UnregisteredTaskDefinition<unknown, unknown, unknown>;
```

#### Step 1.3: Update Stored Definitions

```typescript
// packages/jobs/src/registry/types.ts

// Stored definitions also don't need R
export interface StoredContinuousDefinition<S = unknown> {
  readonly _tag: "ContinuousDefinition";
  readonly name: string;
  readonly stateSchema: Schema.Schema<S, unknown, never>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;
  readonly retry?: StoredJobRetryConfig;
  readonly logging?: LoggingOption;
  execute(ctx: ContinuousContext<S>): Effect.Effect<void, unknown, never>;
}

export interface StoredDebounceDefinition<I = unknown, S = unknown> {
  readonly _tag: "DebounceDefinition";
  readonly name: string;
  readonly eventSchema: Schema.Schema<I, unknown, never>;
  readonly stateSchema: Schema.Schema<S, unknown, never>;
  readonly flushAfter: Duration.DurationInput;
  readonly maxEvents?: number;
  readonly retry?: StoredJobRetryConfig;
  readonly logging?: LoggingOption;
  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, unknown, never>;
  onEvent?(ctx: DebounceEventContext<I, S>): Effect.Effect<S, never, never>;
}

// Similar for WorkerPool and Task...
```

### Phase 2: Update Factory Functions

#### Step 2.1: Update Continuous.make

```typescript
// packages/jobs/src/definitions/continuous.ts

export interface ContinuousMakeConfig<S, E> {
  readonly stateSchema: Schema.Schema<S, unknown, never>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;
  readonly retry?: JobRetryConfig;
  readonly logging?: LoggingOption;

  // Execute must return Effect with R = never
  execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, never>;
}

export const Continuous = {
  make: <S, E = never>(
    config: ContinuousMakeConfig<S, E>
  ): UnregisteredContinuousDefinition<S, E> => ({
    _tag: "ContinuousDefinition",
    stateSchema: config.stateSchema,
    schedule: config.schedule,
    startImmediately: config.startImmediately,
    retry: config.retry,
    logging: config.logging,
    execute: config.execute,
  }),

  every: (interval: Duration.DurationInput): ContinuousSchedule => ({
    _tag: "Every",
    interval,
  }),

  cron: (expression: string, tz?: string): ContinuousSchedule => {
    const timezone = tz ? DateTime.zoneUnsafeMakeNamed(tz) : undefined;
    const cron = Cron.unsafeParse(expression, timezone);
    return { _tag: "Cron", cron };
  },
} as const;
```

#### Step 2.2: Update Debounce.make

```typescript
// packages/jobs/src/definitions/debounce.ts

export interface DebounceMakeConfig<I, S, E> {
  readonly eventSchema: Schema.Schema<I, unknown, never>;
  readonly stateSchema?: Schema.Schema<S, unknown, never>;
  readonly flushAfter: Duration.DurationInput;
  readonly maxEvents?: number;
  readonly retry?: JobRetryConfig;
  readonly logging?: LoggingOption;

  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, E, never>;
  onEvent?(ctx: DebounceEventContext<I, S>): Effect.Effect<S, never, never>;
}

export const Debounce = {
  make: <I, S = I, E = never>(
    config: DebounceMakeConfig<I, S, E>
  ): UnregisteredDebounceDefinition<I, S, E> => ({
    _tag: "DebounceDefinition",
    eventSchema: config.eventSchema,
    stateSchema: (config.stateSchema ?? config.eventSchema) as Schema.Schema<S, unknown, never>,
    flushAfter: config.flushAfter,
    maxEvents: config.maxEvents,
    retry: config.retry,
    logging: config.logging,
    execute: config.execute,
    onEvent: config.onEvent,
  }),
} as const;
```

### Phase 3: Simplify Registry Types

#### Step 3.1: Simplify TypedJobRegistry

```typescript
// packages/jobs/src/registry/typed.ts

// Key extraction - no more R parameter
export type ContinuousKeysOf<T extends Record<string, AnyUnregisteredDefinition>> = {
  [K in keyof T]: T[K] extends UnregisteredContinuousDefinition<unknown, unknown> ? K : never;
}[keyof T] & string;

export type DebounceKeysOf<T extends Record<string, AnyUnregisteredDefinition>> = {
  [K in keyof T]: T[K] extends UnregisteredDebounceDefinition<unknown, unknown, unknown> ? K : never;
}[keyof T] & string;

// ... similar for WorkerPool and Task

// Type extraction - simpler without R
export type ContinuousStateOf<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends ContinuousKeysOf<T>,
> = T[K] extends UnregisteredContinuousDefinition<infer S, unknown> ? S : never;

export type ContinuousErrorOf<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends ContinuousKeysOf<T>,
> = T[K] extends UnregisteredContinuousDefinition<unknown, infer E> ? E : never;
```

#### Step 3.2: Simplify RuntimeJobRegistry

```typescript
// packages/jobs/src/registry/typed.ts

// Runtime registry - no more any for R
export interface RuntimeJobRegistry {
  readonly continuous: Record<string, StoredContinuousDefinition>;
  readonly debounce: Record<string, StoredDebounceDefinition>;
  readonly workerPool: Record<string, StoredWorkerPoolDefinition>;
  readonly task: Record<string, StoredTaskDefinition>;
}
```

### Phase 4: Simplify Handlers

#### Step 4.1: Update Handler Types

```typescript
// packages/jobs/src/handlers/continuous/handler.ts

const getDefinition = (
  name: string,
): Effect.Effect<StoredContinuousDefinition, JobNotFoundError> => {
  // No more <any, any> - just StoredContinuousDefinition
  const def = registryService.registry.continuous[name];
  if (!def) {
    return Effect.fail(new JobNotFoundError({ type: "continuous", name }));
  }
  return Effect.succeed(def);
};
```

#### Step 4.2: Simplify Execution

```typescript
// packages/jobs/src/handlers/continuous/handler.ts

const runExecution = (
  def: StoredContinuousDefinition,
  runCount: number,
  id?: string,
) =>
  execution.execute({
    jobType: "continuous",
    jobName: def.name,
    schema: def.stateSchema,
    retryConfig: def.retry,
    runCount,
    id,
    // No services layer needed - user already provided via Effect.provide
    run: (ctx: ContinuousContext<unknown>) => def.execute(ctx),
    createContext: (base) => createContinuousContext(/* ... */),
  });
```

### Phase 5: Remove Unnecessary Complexity

#### Step 5.1: Remove Services Layer from Factory

The `services` option is no longer needed:

```typescript
// packages/jobs/src/factory.ts

export interface CreateDurableJobsOptions {
  readonly tracker?: HttpBatchTrackerConfig;
  // No services option - provided at job level
}
```

#### Step 5.2: Clean Up Execution Service

```typescript
// packages/jobs/src/services/execution.ts

export interface ExecuteOptions<S, E, Ctx> {
  readonly jobType: "continuous" | "debounce" | "task" | "workerPool";
  readonly jobName: string;
  readonly schema: Schema.Schema<S, unknown, never>;
  readonly retryConfig?: JobRetryConfig;
  readonly runCount?: number;
  readonly allowNullState?: boolean;
  readonly id?: string;

  // Effect already has R = never (user provided services)
  readonly run: (ctx: Ctx) => Effect.Effect<void, E, never>;
  readonly createContext: (base: ExecutionContextBase<S>) => Ctx;
}
```

---

## Migration Guide

### Before (Current API)

```typescript
// Job with unmet service requirement - NO ERROR AT COMPILE TIME
export const myJob = Continuous.make({
  stateSchema: MyState,
  schedule: Continuous.every("1 minute"),
  execute: (ctx) =>
    Effect.gen(function* () {
      const random = yield* Random;  // R = Random
      // ...
    }),
    // No error - R = Random is silently accepted
});

// Fails at RUNTIME with "Service not found: Random"
```

### After (New API)

```typescript
// Job with unmet service requirement - ERROR AT COMPILE TIME
export const myJob = Continuous.make({
  stateSchema: MyState,
  schedule: Continuous.every("1 minute"),
  execute: (ctx) =>
    Effect.gen(function* () {
      const random = yield* Random;
      // ...
    }),
    // ❌ Type error: Effect<void, never, Random> not assignable to Effect<void, never, never>
});

// Fixed version - provide services inline
export const myJob = Continuous.make({
  stateSchema: MyState,
  schedule: Continuous.every("1 minute"),
  execute: (ctx) =>
    Effect.gen(function* () {
      const random = yield* Random;
      // ...
    }).pipe(
      Effect.provide(RandomLive)  // ✓ R = never
    ),
});
```

---

## Complete Example

```typescript
// src/services.ts
import { Context, Effect, Layer } from "effect";

export class Random extends Context.Tag("Random")<
  Random,
  { readonly next: Effect.Effect<number> }
>() {}

export const RandomLive = Layer.succeed(Random, {
  next: Effect.sync(() => Math.random()),
});

export class Logger extends Context.Tag("Logger")<
  Logger,
  { readonly info: (msg: string) => Effect.Effect<void> }
>() {}

export const LoggerLive = Layer.succeed(Logger, {
  info: (msg) => Effect.log(msg),
});

// Combined layer for convenience
export const AllServicesLive = Layer.mergeAll(RandomLive, LoggerLive);
```

```typescript
// src/jobs/debounce-example.ts
import { Effect, Schema } from "effect";
import { Debounce } from "@durable-effect/jobs";
import { Random, Logger, AllServicesLive } from "../services";

const DebounceEvent = Schema.Struct({
  actionId: Schema.String,
});

export const debounceExample = Debounce.make({
  eventSchema: DebounceEvent,
  flushAfter: "5 seconds",
  maxEvents: 10,
  logging: true,

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const eventCount = yield* ctx.eventCount;

      // Use custom services
      const random = yield* Random;
      const logger = yield* Logger;

      const failChance = yield* random.next;
      if (failChance < 0.1) {
        yield* Effect.fail("Random failure!");
      }

      yield* logger.info(
        `Debounce flushed! Events: ${eventCount}, Last action: ${state?.actionId}`
      );
    }).pipe(
      // Provide all services - makes R = never
      Effect.provide(AllServicesLive)
    ),
});
```

```typescript
// src/jobs/index.ts
import { createDurableJobs } from "@durable-effect/jobs";
import { debounceExample } from "./debounce-example";

export const { Jobs, JobsClient } = createDurableJobs({
  debounceExample,
});
```

```typescript
// src/index.ts (worker entry)
export { Jobs } from "./jobs";

export default {
  async fetch(request: Request, env: Env) {
    const client = JobsClient.fromBinding(env.JOBS);

    await Effect.runPromise(
      client.debounce("debounceExample").add({
        id: "user-123",
        event: { actionId: "click-button" },
      })
    );

    return new Response("Event added!");
  },
};
```

---

## Files to Change

| File | Change |
|------|--------|
| `registry/types.ts` | Remove R from all definition interfaces, enforce `R = never` on execute |
| `registry/typed.ts` | Simplify key/type extraction, remove R from RuntimeJobRegistry |
| `definitions/continuous.ts` | Update ContinuousMakeConfig to require `R = never` |
| `definitions/debounce.ts` | Update DebounceMakeConfig to require `R = never` |
| `definitions/task.ts` | Update TaskMakeConfig to require `R = never` |
| `handlers/continuous/handler.ts` | Remove `<any, any>` from StoredDefinition types |
| `handlers/debounce/handler.ts` | Remove `<any, any>` from StoredDefinition types |
| `handlers/task/handler.ts` | Remove `<any, any>` from StoredDefinition types |
| `services/execution.ts` | Remove servicesLayer parameter |
| `factory.ts` | Remove services option |
| `client/types.ts` | Simplify client types without R |

---

## Benefits

1. **Effect-Native**: Users use standard `.pipe(Effect.provide(...))` patterns
2. **Compile-Time Safety**: Missing services = build error
3. **LSP Support**: Hover shows exact requirements
4. **Simpler Types**: No R parameter threading through entire codebase
5. **No Runtime Surprises**: If it compiles, services are satisfied
6. **Flexible**: Users can compose layers however they want
7. **Testable**: Easy to provide test implementations via layers

---

## Breaking Changes

This is a **breaking change** for any user with jobs that have unmet service requirements. However:

1. Jobs with `R = never` (most jobs) are unaffected
2. Jobs with unmet requirements were already broken (runtime failures)
3. Migration path is clear: add `.pipe(Effect.provide(...))`

The fix makes previously-hidden bugs into compile-time errors - a net positive.
