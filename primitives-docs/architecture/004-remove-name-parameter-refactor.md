# Refactor: Remove Name Parameter from Primitive Definitions

## Problem

The current implementation requires a `name` as the first parameter to `Continuous.make()`:

```ts
// Current (WRONG)
const TokenRefresher = Continuous.make("token-refresher", {
  stateSchema: ...,
  schedule: ...,
  execute: ...
});

const { Jobs, JobsClient } = createDurableJobs({
  jobs: {
    TokenRefresher,  // Wrapped in "jobs" object
  },
});
```

This design has problems:
1. **Redundant** - The name is specified twice (in `make()` and as the object key)
2. **Inconsistent** - The name in `make()` could differ from the object key
3. **Verbose** - Extra `jobs: {}` wrapper is unnecessary
4. **Poor DX** - Refactoring a name requires changes in multiple places

---

## Target Design

The name should come from the object key in `createDurableJobs()`:

```ts
// Target (CORRECT)
const tokenRefresher = Continuous.make({
  stateSchema: Schema.Struct({
    accessToken: Schema.NullOr(Schema.String),
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
  }),
  schedule: Continuous.every("30 minutes"),
  execute: (ctx) => Effect.gen(function* () {
    // ...
  }),
});

// Name comes from key - no wrapper object
const { Jobs, JobsClient } = createDurableJobs({
  tokenRefresher,
  anotherPrimitive,
});

// Client uses the key as the name
client.continuous("tokenRefresher").start({ ... });
```

---

## Files to Modify

### 1. Definition Types (`src/registry/types.ts`)

**Current:**
```ts
interface ContinuousDefinition<S, E, R> {
  readonly _tag: "ContinuousDefinition";
  readonly name: string;  // ← Remove this
  readonly stateSchema: Schema.Schema<S, unknown>;
  readonly schedule: ContinuousSchedule;
  // ...
}
```

**Target:**
```ts
// Definition without name (what user creates)
interface ContinuousConfig<S, E, R> {
  readonly stateSchema: Schema.Schema<S, unknown>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;
  readonly execute: (ctx: ContinuousContext<S>) => Effect.Effect<void, E, R>;
  readonly onError?: (error: E, ctx: ContinuousContext<S>) => Effect.Effect<void, never, R>;
}

// Definition with name (after registration)
interface ContinuousDefinition<S, E, R> extends ContinuousConfig<S, E, R> {
  readonly _tag: "ContinuousDefinition";
  readonly name: string;  // Added by createDurableJobs
}
```

### 2. Make Functions (`src/definitions/continuous.ts`)

**Current:**
```ts
export const Continuous = {
  make: <S, E, R>(
    name: string,
    config: ContinuousConfig<S, E, R>
  ): ContinuousDefinition<S, E, R> => ({
    _tag: "ContinuousDefinition",
    name,
    ...config,
  }),
  // ...
};
```

**Target:**
```ts
// Type for unregistered definition (no name yet)
interface UnregisteredContinuousDefinition<S, E, R> {
  readonly _tag: "ContinuousDefinition";
  readonly stateSchema: Schema.Schema<S, unknown>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;
  readonly execute: (ctx: ContinuousContext<S>) => Effect.Effect<void, E, R>;
  readonly onError?: (error: E, ctx: ContinuousContext<S>) => Effect.Effect<void, never, R>;
}

export const Continuous = {
  make: <S extends Schema.Schema.AnyNoContext, E, R>(
    config: ContinuousConfig<Schema.Schema.Type<S>, E, R>
  ): UnregisteredContinuousDefinition<Schema.Schema.Type<S>, E, R> => ({
    _tag: "ContinuousDefinition",
    ...config,
  }),

  every: (interval: Duration.DurationInput): ContinuousSchedule => ({
    _tag: "Every",
    interval,
  }),

  cron: (expression: string): ContinuousSchedule => ({
    _tag: "Cron",
    expression,
  }),
};
```

### 3. Factory (`src/factory.ts`)

**Current:**
```ts
interface CreateDurableJobsOptions<T> {
  jobs: T;  // ← Remove wrapper
  tracker?: TrackerConfig;
}

export function createDurableJobs<
  T extends Record<string, AnyPrimitiveDefinition>
>(options: CreateDurableJobsOptions<T>) {
  const { jobs: definitions } = options;
  // ...
}
```

**Target:**
```ts
// Unregistered definition types (no name)
type AnyUnregisteredDefinition =
  | UnregisteredContinuousDefinition<any, any, any>
  | UnregisteredDebounceDefinition<any, any, any, any>
  | UnregisteredWorkerPoolDefinition<any, any, any>;

interface CreateDurableJobsOptions {
  readonly tracker?: TrackerConfig;
}

export function createDurableJobs<
  T extends Record<string, AnyUnregisteredDefinition>
>(
  definitions: T,
  options?: CreateDurableJobsOptions
) {
  // Create registry
  const registry = createEmptyRegistry();

  // Register each definition with its key as the name
  for (const [name, definition] of Object.entries(definitions)) {
    const registeredDef = { ...definition, name };

    switch (definition._tag) {
      case "ContinuousDefinition":
        registry.continuous.set(name, registeredDef as ContinuousDefinition<any, any, any>);
        break;
      case "DebounceDefinition":
        registry.debounce.set(name, registeredDef as DebounceDefinition<any, any, any, any>);
        break;
      case "WorkerPoolDefinition":
        registry.workerPool.set(name, registeredDef as WorkerPoolDefinition<any, any, any>);
        break;
    }
  }

  // Store registry in typed form for client type inference
  const typedRegistry = registry as InferRegistryFromDefinitions<T>;

  // ... rest of factory
}
```

### 4. Registry Types (`src/registry/types.ts`)

**Current:**
```ts
interface PrimitiveRegistry {
  readonly continuous: Map<string, ContinuousDefinition<any, any, any>>;
  readonly debounce: Map<string, DebounceDefinition<any, any, any, any>>;
  readonly workerPool: Map<string, WorkerPoolDefinition<any, any, any>>;
}
```

**Target:**
```ts
// Empty registry for building
function createEmptyRegistry(): PrimitiveRegistry {
  return {
    continuous: new Map(),
    debounce: new Map(),
    workerPool: new Map(),
  };
}

// Type helper to infer registry from definitions
type InferRegistryFromDefinitions<T extends Record<string, AnyUnregisteredDefinition>> = {
  readonly continuous: Map<
    Extract<{ [K in keyof T]: T[K] extends UnregisteredContinuousDefinition<any, any, any> ? K : never }[keyof T], string>,
    ContinuousDefinition<any, any, any>
  >;
  readonly debounce: Map<
    Extract<{ [K in keyof T]: T[K] extends UnregisteredDebounceDefinition<any, any, any, any> ? K : never }[keyof T], string>,
    DebounceDefinition<any, any, any, any>
  >;
  readonly workerPool: Map<
    Extract<{ [K in keyof T]: T[K] extends UnregisteredWorkerPoolDefinition<any, any, any> ? K : never }[keyof T], string>,
    WorkerPoolDefinition<any, any, any>
  >;
  readonly __definitions: T;
};
```

### 5. Client Types (`src/client/types.ts`)

Update type helpers to infer from `__definitions`:

```ts
// Extract continuous primitive keys from definitions
type ContinuousKeys<R> = R extends { __definitions: infer D }
  ? D extends Record<string, unknown>
    ? Extract<{
        [K in keyof D]: D[K] extends UnregisteredContinuousDefinition<any, any, any> ? K : never
      }[keyof D], string>
    : never
  : never;

// Extract state type for a specific continuous primitive
type ContinuousStateType<R, K extends string> = R extends { __definitions: infer D }
  ? D extends Record<string, unknown>
    ? K extends keyof D
      ? D[K] extends UnregisteredContinuousDefinition<infer S, any, any>
        ? S
        : unknown
      : unknown
    : unknown
  : unknown;
```

### 6. Context (`src/handlers/continuous/context.ts`)

The `primitiveName` in context now comes from the registered definition, not the original:

```ts
// No change needed - name is already read from registered definition
const ctx = createContinuousContext(
  stateHolder,
  runtime.instanceId,
  runCount,
  def.name  // This is the name assigned during registration
);
```

### 7. Handler (`src/handlers/continuous/handler.ts`)

No changes needed - handler already reads `def.name` from the registered definition.

---

## Type Flow

```
User defines:
  const tokenRefresher = Continuous.make({ ... })
  → UnregisteredContinuousDefinition<S, E, R>  (no name)

User registers:
  createDurableJobs({ tokenRefresher, ... })
  → Factory adds name from key
  → ContinuousDefinition<S, E, R>  (has name: "tokenRefresher")
  → Registry stores it

Client uses:
  client.continuous("tokenRefresher")
  → TypeScript autocompletes from keys of definitions object
  → Returns typed client for that primitive's state type
```

---

## Migration Steps

### Step 1: Add Unregistered Types

Create new types for definitions without names:

```ts
// src/registry/types.ts
export interface UnregisteredContinuousDefinition<S, E, R> {
  readonly _tag: "ContinuousDefinition";
  readonly stateSchema: Schema.Schema<S, unknown>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately?: boolean;
  readonly execute: (ctx: ContinuousContext<S>) => Effect.Effect<void, E, R>;
  readonly onError?: (error: E, ctx: ContinuousContext<S>) => Effect.Effect<void, never, R>;
}

// Registered version adds name
export interface ContinuousDefinition<S, E, R> extends UnregisteredContinuousDefinition<S, E, R> {
  readonly name: string;
}
```

### Step 2: Update `Continuous.make()`

Remove name parameter:

```ts
// src/definitions/continuous.ts
export const Continuous = {
  make: <S extends Schema.Schema.AnyNoContext, E, R>(
    config: {
      readonly stateSchema: S;
      readonly schedule: ContinuousSchedule;
      readonly startImmediately?: boolean;
      readonly execute: (ctx: ContinuousContext<Schema.Schema.Type<S>>) => Effect.Effect<void, E, R>;
      readonly onError?: (error: E, ctx: ContinuousContext<Schema.Schema.Type<S>>) => Effect.Effect<void, never, R>;
    }
  ): UnregisteredContinuousDefinition<Schema.Schema.Type<S>, E, R> => ({
    _tag: "ContinuousDefinition",
    stateSchema: config.stateSchema as Schema.Schema<Schema.Schema.Type<S>, unknown>,
    schedule: config.schedule,
    startImmediately: config.startImmediately,
    execute: config.execute,
    onError: config.onError,
  }),

  every: (interval: Duration.DurationInput): ContinuousSchedule => ({
    _tag: "Every",
    interval,
  }),

  cron: (expression: string): ContinuousSchedule => ({
    _tag: "Cron",
    expression,
  }),
};
```

### Step 3: Update Factory Signature

Flatten the API:

```ts
// src/factory.ts
export function createDurableJobs<
  T extends Record<string, AnyUnregisteredDefinition>
>(
  definitions: T,
  options?: { tracker?: TrackerConfig }
): CreateDurableJobsResult<T> {
  const registry = createEmptyRegistry();

  // Register with names from keys
  for (const [name, def] of Object.entries(definitions)) {
    const registered = { ...def, name };
    switch (def._tag) {
      case "ContinuousDefinition":
        registry.continuous.set(name, registered);
        break;
      case "DebounceDefinition":
        registry.debounce.set(name, registered);
        break;
      case "WorkerPoolDefinition":
        registry.workerPool.set(name, registered);
        break;
    }
  }

  // ... rest unchanged
}
```

### Step 4: Update Debounce and WorkerPool

Apply same pattern:

```ts
// src/definitions/debounce.ts
export const Debounce = {
  make: <I, S, E, R>(config: {
    stateSchema: Schema.Schema<S, unknown>;
    eventSchema: Schema.Schema<I, unknown>;
    maxEvents?: number;
    maxWait?: Duration.DurationInput;
    execute: (ctx: DebounceExecuteContext<I, S>) => Effect.Effect<void, E, R>;
  }): UnregisteredDebounceDefinition<I, S, E, R> => ({
    _tag: "DebounceDefinition",
    ...config,
  }),
  // ...
};

// src/definitions/workerPool.ts
export const WorkerPool = {
  make: <E, Err, R>(config: {
    eventSchema: Schema.Schema<E, unknown>;
    concurrency?: number;
    execute: (ctx: WorkerPoolExecuteContext<E>) => Effect.Effect<void, Err, R>;
    retry?: WorkerPoolRetryConfig;
    onDeadLetter?: (ctx: WorkerPoolDeadLetterContext<E, Err>) => Effect.Effect<void, never, R>;
  }): UnregisteredWorkerPoolDefinition<E, Err, R> => ({
    _tag: "WorkerPoolDefinition",
    ...config,
  }),
  // ...
};
```

### Step 5: Update Tests

```ts
// Before
const CounterPrimitive = Continuous.make("counter", {
  stateSchema: CounterState,
  schedule: Continuous.every("30 minutes"),
  execute: (ctx) => Effect.sync(() => { ... }),
});

const registry = {
  continuous: new Map([["counter", CounterPrimitive]]),
  // ...
};

// After
const counterPrimitive = Continuous.make({
  stateSchema: CounterState,
  schedule: Continuous.every("30 minutes"),
  execute: (ctx) => Effect.sync(() => { ... }),
});

// For handler tests, manually add name
const registry = {
  continuous: new Map([["counter", { ...counterPrimitive, name: "counter" }]]),
  // ...
};
```

### Step 6: Update Examples

```ts
// examples/effect-worker/src/jobs.ts

// Before
const TokenRefresher = Continuous.make("token-refresher", { ... });
const { Jobs, JobsClient } = createDurableJobs({
  jobs: { TokenRefresher },
});

// After
const tokenRefresher = Continuous.make({ ... });
const { Jobs, JobsClient } = createDurableJobs({
  tokenRefresher,
});
```

---

## Implementation Checklist

- [ ] Add `UnregisteredContinuousDefinition` type
- [ ] Add `UnregisteredDebounceDefinition` type
- [ ] Add `UnregisteredWorkerPoolDefinition` type
- [ ] Update `Continuous.make()` to remove name param
- [ ] Update `Debounce.make()` to remove name param
- [ ] Update `WorkerPool.make()` to remove name param
- [ ] Update `createDurableJobs()` signature (remove `jobs` wrapper)
- [ ] Update `createDurableJobs()` to assign names from keys
- [ ] Update `InferRegistryFromDefinitions` type helper
- [ ] Update client type helpers (`ContinuousKeys`, etc.)
- [ ] Update all tests
- [ ] Update example code
- [ ] Verify TypeScript autocomplete works for primitive names

---

## Benefits

1. **Simpler API** - One less parameter, flatter factory call
2. **No duplication** - Name defined once as object key
3. **Better refactoring** - Rename variable = rename primitive
4. **Type safety** - TypeScript infers available names from object keys
5. **Consistency** - Matches Effect ecosystem patterns
