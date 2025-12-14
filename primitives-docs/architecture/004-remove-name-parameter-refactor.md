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

const { Primitives, PrimitivesClient } = createDurablePrimitives({
  primitives: {
    TokenRefresher,  // Wrapped in "primitives" object
  },
});
```

This design has problems:
1. **Redundant** - The name is specified twice (in `make()` and as the object key)
2. **Inconsistent** - The name in `make()` could differ from the object key
3. **Verbose** - Extra `primitives: {}` wrapper is unnecessary
4. **Poor DX** - Refactoring a name requires changes in multiple places

---

## Target Design

The name should come from the object key in `createDurablePrimitives()`:

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
const { Primitives, PrimitivesClient } = createDurablePrimitives({
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
  readonly name: string;  // Added by createDurablePrimitives
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
interface CreateDurablePrimitivesOptions<T> {
  primitives: T;  // ← Remove wrapper
  tracker?: TrackerConfig;
}

export function createDurablePrimitives<
  T extends Record<string, AnyPrimitiveDefinition>
>(options: CreateDurablePrimitivesOptions<T>) {
  const { primitives: definitions } = options;
  // ...
}
```

**Target:**
```ts
// Unregistered definition types (no name)
type AnyUnregisteredDefinition =
  | UnregisteredContinuousDefinition<any, any, any>
  | UnregisteredBufferDefinition<any, any, any, any>
  | UnregisteredQueueDefinition<any, any, any>;

interface CreateDurablePrimitivesOptions {
  readonly tracker?: TrackerConfig;
}

export function createDurablePrimitives<
  T extends Record<string, AnyUnregisteredDefinition>
>(
  definitions: T,
  options?: CreateDurablePrimitivesOptions
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
      case "BufferDefinition":
        registry.buffer.set(name, registeredDef as BufferDefinition<any, any, any, any>);
        break;
      case "QueueDefinition":
        registry.queue.set(name, registeredDef as QueueDefinition<any, any, any>);
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
  readonly buffer: Map<string, BufferDefinition<any, any, any, any>>;
  readonly queue: Map<string, QueueDefinition<any, any, any>>;
}
```

**Target:**
```ts
// Empty registry for building
function createEmptyRegistry(): PrimitiveRegistry {
  return {
    continuous: new Map(),
    buffer: new Map(),
    queue: new Map(),
  };
}

// Type helper to infer registry from definitions
type InferRegistryFromDefinitions<T extends Record<string, AnyUnregisteredDefinition>> = {
  readonly continuous: Map<
    Extract<{ [K in keyof T]: T[K] extends UnregisteredContinuousDefinition<any, any, any> ? K : never }[keyof T], string>,
    ContinuousDefinition<any, any, any>
  >;
  readonly buffer: Map<
    Extract<{ [K in keyof T]: T[K] extends UnregisteredBufferDefinition<any, any, any, any> ? K : never }[keyof T], string>,
    BufferDefinition<any, any, any, any>
  >;
  readonly queue: Map<
    Extract<{ [K in keyof T]: T[K] extends UnregisteredQueueDefinition<any, any, any> ? K : never }[keyof T], string>,
    QueueDefinition<any, any, any>
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
  createDurablePrimitives({ tokenRefresher, ... })
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
export function createDurablePrimitives<
  T extends Record<string, AnyUnregisteredDefinition>
>(
  definitions: T,
  options?: { tracker?: TrackerConfig }
): CreateDurablePrimitivesResult<T> {
  const registry = createEmptyRegistry();

  // Register with names from keys
  for (const [name, def] of Object.entries(definitions)) {
    const registered = { ...def, name };
    switch (def._tag) {
      case "ContinuousDefinition":
        registry.continuous.set(name, registered);
        break;
      case "BufferDefinition":
        registry.buffer.set(name, registered);
        break;
      case "QueueDefinition":
        registry.queue.set(name, registered);
        break;
    }
  }

  // ... rest unchanged
}
```

### Step 4: Update Buffer and Queue

Apply same pattern:

```ts
// src/definitions/buffer.ts
export const Buffer = {
  make: <I, S, E, R>(config: {
    stateSchema: Schema.Schema<S, unknown>;
    eventSchema: Schema.Schema<I, unknown>;
    maxEvents?: number;
    maxWait?: Duration.DurationInput;
    execute: (ctx: BufferExecuteContext<I, S>) => Effect.Effect<void, E, R>;
  }): UnregisteredBufferDefinition<I, S, E, R> => ({
    _tag: "BufferDefinition",
    ...config,
  }),
  // ...
};

// src/definitions/queue.ts
export const Queue = {
  make: <E, Err, R>(config: {
    eventSchema: Schema.Schema<E, unknown>;
    concurrency?: number;
    execute: (ctx: QueueExecuteContext<E>) => Effect.Effect<void, Err, R>;
    retry?: QueueRetryConfig;
    onDeadLetter?: (ctx: QueueDeadLetterContext<E, Err>) => Effect.Effect<void, never, R>;
  }): UnregisteredQueueDefinition<E, Err, R> => ({
    _tag: "QueueDefinition",
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
// examples/effect-worker/src/primitives.ts

// Before
const TokenRefresher = Continuous.make("token-refresher", { ... });
const { Primitives, PrimitivesClient } = createDurablePrimitives({
  primitives: { TokenRefresher },
});

// After
const tokenRefresher = Continuous.make({ ... });
const { Primitives, PrimitivesClient } = createDurablePrimitives({
  tokenRefresher,
});
```

---

## Implementation Checklist

- [ ] Add `UnregisteredContinuousDefinition` type
- [ ] Add `UnregisteredBufferDefinition` type
- [ ] Add `UnregisteredQueueDefinition` type
- [ ] Update `Continuous.make()` to remove name param
- [ ] Update `Buffer.make()` to remove name param
- [ ] Update `Queue.make()` to remove name param
- [ ] Update `createDurablePrimitives()` signature (remove `primitives` wrapper)
- [ ] Update `createDurablePrimitives()` to assign names from keys
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
