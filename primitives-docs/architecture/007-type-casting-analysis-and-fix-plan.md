# Type Casting Analysis and Fix Plan

## Overview

This document analyzes the type casting issues in `@packages/jobs/` that force unsafe type assertions (`as`) instead of relying on TypeScript's type inference. The primary symptom is client method calls like `client.continuous("tokenRefresher")` showing:

```
Argument of type "tokenRefresher" is not assignable to parameter of type never
```

## Executive Summary

The root cause is a **phantom type pattern** where type information exists only at the type level but not at runtime. The `__definitions` property is added via cast in `factory.ts` but doesn't exist on the actual `JobRegistry` interface. When this phantom type is lost (through type widening, variable assignment, etc.), the conditional types in `client/types.ts` fall through to `never`.

## Type Flow Analysis

### 1. Definition Creation (Works Correctly)

```typescript
// User creates definitions with full type information
const tokenRefresher = Continuous.make({
  stateSchema: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
  }),
  // ...
});
// Type: UnregisteredContinuousDefinition<{ accessToken: string; refreshToken: string }, ...>
```

### 2. Factory Function (Phantom Type Introduced)

```typescript
// factory.ts:149-192
export function createDurableJobs<
  const T extends Record<string, AnyUnregisteredDefinition>,
>(definitions: T): CreateDurableJobsResult<T> {
  // Creates runtime registry (loses type information)
  const registry = createJobRegistry(definitions); // Returns JobRegistry (no __definitions)

  // CAST: Forces phantom type onto registry
  const typedRegistry = registry as unknown as InferRegistryFromDefinitions<T>;
  //                    ^^^^^^^^^^^^^^^^
  //                    This is where type information is "injected"

  return {
    Jobs: BoundJobsEngine as typeof DurableJobsEngine,
    JobsClient: {
      fromBinding: (binding) => createJobsClient(binding, typedRegistry),
      Tag: ClientTag,
    },
    registry,
  };
}
```

**Problem**: `createJobRegistry` returns `JobRegistry` which has no `__definitions` property:

```typescript
// registry/types.ts:311-315
export interface JobRegistry {
  readonly continuous: Map<string, ContinuousDefinition<any, any, any>>;
  readonly debounce: Map<string, DebounceDefinition<any, any, any, any>>;
  readonly workerPool: Map<string, WorkerPoolDefinition<any, any, any>>;
}
```

But `InferRegistryFromDefinitions<T>` expects:

```typescript
// factory.ts:63-89
export type InferRegistryFromDefinitions<T> = {
  readonly continuous: Map<...>;
  readonly debounce: Map<...>;
  readonly workerPool: Map<...>;
  readonly __definitions: T;  // <-- This only exists at type level!
};
```

### 3. Client Type Extraction (Where It Breaks)

```typescript
// client/types.ts:246-266
export type ContinuousKeys<R extends JobRegistry> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? Extract<
          {
            [K in keyof R["__definitions"]]: R["__definitions"][K] extends
              UnregisteredContinuousDefinition<any, any, any>
              ? K
              : never;
          }[keyof R["__definitions"]],
          string
        >
      : R extends { continuous: Map<infer K, any> } ? K & string : never
    : R extends { continuous: Map<infer K, any> } ? K & string : never;
```

**Flow when types are preserved**:
1. `R = InferRegistryFromDefinitions<{ tokenRefresher: ..., webhookDebounce: ... }>`
2. `R["__definitions"]` = `{ tokenRefresher: ..., webhookDebounce: ... }`
3. Conditional extracts `"tokenRefresher"` for continuous definitions
4. Result: `"tokenRefresher"`

**Flow when types are widened**:
1. `R = JobRegistry` (e.g., stored in variable typed as `JobsClient<JobRegistry>`)
2. `R["__definitions"]` = `undefined` (doesn't extend `Record<string, unknown>`)
3. Falls through to `Map<infer K, any>` branch
4. `Map<string, any>` infers `K = string`, but then...
5. The `K & string` still produces `string`, but if the entire conditional fails differently, it produces `never`

## All Type Casting Locations

### Critical Casts (Breaking Type Safety)

| File | Line | Cast | Issue |
|------|------|------|-------|
| `factory.ts` | 177 | `as unknown as InferRegistryFromDefinitions<T>` | Introduces phantom `__definitions` |
| `factory.ts` | 188 | `as typeof DurableJobsEngine` | Constructor injection pattern |
| `client/client.ts` | 63 | `as unknown as DurableJobsEngineInterface` | Cloudflare DO binding incompatibility |

### Handler Casts (Type Widening Recovery)

| File | Line | Cast | Issue |
|------|------|------|-------|
| `handlers/continuous/handler.ts` | 79 | `as ContinuousDefinition<unknown, unknown, never>` | Registry lookup returns `any` types |
| `handlers/debounce/handler.ts` | 67 | `as DebounceDefinition<any, any, any, never>` | Same issue |
| `handlers/debounce/handler.ts` | 161 | `error as never` | Type inference failure in onError |
| `handlers/debounce/handler.ts` | 322 | `as any` | Context typing issues |

### Registry Casts (Adding Name Property)

| File | Line | Cast | Issue |
|------|------|------|-------|
| `registry/registry.ts` | 50 | `as ContinuousDefinition<any, any, any>` | Adding `name` to unregistered definition |
| `registry/registry.ts` | 56 | `as DebounceDefinition<any, any, any, any>` | Same |
| `registry/registry.ts` | 60 | `as WorkerPoolDefinition<any, any, any>` | Same |

### Effect Type Inference Casts

| File | Line | Cast | Issue |
|------|------|------|-------|
| `retry/executor.ts` | 154 | `lastError as E` | Generic type recovery |
| `retry/executor.ts` | 246 | `as Effect.Effect<...>` | Complex union type inference failure |
| `handlers/continuous/handler.ts` | 334 | `as Effect.Effect<void, unknown, never>` | Retry executor type mismatch |
| `handlers/continuous/handler.ts` | 397 | `as Effect.Effect<...>` | Return type inference failure |
| `handlers/debounce/handler.ts` | 221 | `as Effect.Effect<void, unknown, never>` | Same |
| `handlers/debounce/handler.ts` | 264 | `as Effect.Effect<...>` | Same |

### Acceptable Casts (Literal Narrowing)

Multiple `as const` casts for response type literals - these are acceptable TypeScript patterns.

## Root Causes

### 1. Phantom Type Pattern Without Runtime Backing

The `__definitions` property only exists at the type level. TypeScript has no way to verify it exists at runtime, and the type is easily lost.

```typescript
// What we have (phantom type via cast):
interface InferredRegistry {
  continuous: Map<...>;
  __definitions: T;  // Doesn't exist at runtime
}

// What we should have (runtime-backed branding):
interface BrandedRegistry<T> extends JobRegistry {
  readonly __brand: { definitions: T };  // Could exist at runtime, or...
}

// Or better: object types instead of Maps
interface TypedRegistry<T> {
  readonly continuous: { [K in ContinuousKeysOf<T>]: ContinuousDefinition<...> };
  // ...
}
```

### 2. Map Types Don't Preserve Literal Keys

```typescript
Map<string, Definition>  // TypeScript only knows K = string
Map<"tokenRefresher" | "other", Definition>  // Better, but Map doesn't support this naturally
```

TypeScript's `Map` generic doesn't preserve literal key types. When you call `map.set("tokenRefresher", def)`, the type becomes `Map<string, ...>` not `Map<"tokenRefresher", ...>`.

### 3. Unregistered vs Registered Definition Split

The two-phase pattern (create without name, register with name) loses type information:

```typescript
// Phase 1: Full type information
const def: UnregisteredContinuousDefinition<State, Error, never> = Continuous.make({...});

// Phase 2: Name added, stored in Map, types widened to any
registry.continuous.set(name, { ...def, name } as ContinuousDefinition<any, any, any>);
```

### 4. Handler Layer Type Erasure

Handlers receive definitions from the registry with `any` types and must work generically:

```typescript
const def = registryService.registry.continuous.get(name);
// Type: ContinuousDefinition<any, any, any> | undefined
```

## Recommended Fix Strategy

### Phase 1: Replace Maps with Objects (High Impact)

**Goal**: Use object types that preserve literal keys instead of Maps.

```typescript
// Current (loses types):
interface JobRegistry {
  readonly continuous: Map<string, ContinuousDefinition<any, any, any>>;
}

// Proposed (preserves types):
interface TypedJobRegistry<T extends Record<string, AnyUnregisteredDefinition>> {
  readonly continuous: {
    [K in ContinuousKeysOf<T>]: RegisteredDefinition<T[K], K>
  };
  readonly debounce: {
    [K in DebounceKeysOf<T>]: RegisteredDefinition<T[K], K>
  };
  readonly workerPool: {
    [K in WorkerPoolKeysOf<T>]: RegisteredDefinition<T[K], K>
  };
}
```

**Benefits**:
- Literal keys preserved naturally
- No phantom types needed
- TypeScript can verify key existence at compile time

**Trade-offs**:
- Lookup syntax changes: `registry.continuous["tokenRefresher"]` instead of `registry.continuous.get("tokenRefresher")`
- Runtime iteration requires `Object.keys()` instead of `Map.keys()`

### Phase 2: Generic Registry Throughout Pipeline

**Goal**: Make services and layers generic over the registry type.

```typescript
// Current (type-erased):
export class RegistryService extends Context.Tag("RegistryService")<
  RegistryService,
  { registry: JobRegistry }
>() {}

// Proposed (type-preserving):
export class RegistryService<T extends Record<string, AnyUnregisteredDefinition>>
  extends Context.Tag("RegistryService")<
    RegistryService<T>,
    { registry: TypedJobRegistry<T> }
  >() {}
```

**Complexity**: This requires making all handlers generic, which significantly increases complexity. May want to keep handlers using `unknown` types internally and only preserve types at the client boundary.

### Phase 3: Type-Safe Definition Lookup Functions

**Goal**: Create helper functions that narrow types correctly.

```typescript
// Helper that preserves types through lookup
export function getContinuousDefinition<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends ContinuousKeysOf<T>
>(
  registry: TypedJobRegistry<T>,
  name: K
): ContinuousDefinition<StateOf<T, K>, ErrorOf<T, K>, RequirementsOf<T, K>> {
  return registry.continuous[name];
}
```

### Phase 4: Client Type Simplification

**Goal**: Simplify the conditional types in `client/types.ts`.

With object-based registry, the key extraction becomes trivial:

```typescript
// Current (complex conditional):
export type ContinuousKeys<R extends JobRegistry> =
  R extends RegistryWithDefinitions
    ? R["__definitions"] extends Record<string, unknown>
      ? Extract<{ [K in keyof R["__definitions"]]: ... }, string>
      : ...
    : ...;

// Proposed (simple keyof):
export type ContinuousKeys<T extends Record<string, AnyUnregisteredDefinition>> =
  keyof TypedJobRegistry<T>["continuous"];
```

## Implementation Plan

### Step 1: Create TypedJobRegistry Interface

```typescript
// registry/typed.ts

type ContinuousKeysOf<T> = {
  [K in keyof T]: T[K] extends UnregisteredContinuousDefinition<any, any, any> ? K : never
}[keyof T] & string;

type DebounceKeysOf<T> = {
  [K in keyof T]: T[K] extends UnregisteredDebounceDefinition<any, any, any, any> ? K : never
}[keyof T] & string;

type WorkerPoolKeysOf<T> = {
  [K in keyof T]: T[K] extends UnregisteredWorkerPoolDefinition<any, any, any> ? K : never
}[keyof T] & string;

// Add name to definition type
type Registered<D, N extends string> = D & { readonly name: N };

export interface TypedJobRegistry<T extends Record<string, AnyUnregisteredDefinition>> {
  readonly continuous: {
    [K in ContinuousKeysOf<T>]: Registered<T[K], K & string>
  };
  readonly debounce: {
    [K in DebounceKeysOf<T>]: Registered<T[K], K & string>
  };
  readonly workerPool: {
    [K in WorkerPoolKeysOf<T>]: Registered<T[K], K & string>
  };
}
```

### Step 2: Update createJobRegistry

```typescript
export function createTypedJobRegistry<
  const T extends Record<string, AnyUnregisteredDefinition>
>(definitions: T): TypedJobRegistry<T> {
  const continuous: Record<string, any> = {};
  const debounce: Record<string, any> = {};
  const workerPool: Record<string, any> = {};

  for (const [name, def] of Object.entries(definitions)) {
    const withName = { ...def, name };
    switch (def._tag) {
      case "ContinuousDefinition":
        continuous[name] = withName;
        break;
      case "DebounceDefinition":
        debounce[name] = withName;
        break;
      case "WorkerPoolDefinition":
        workerPool[name] = withName;
        break;
    }
  }

  // This cast is now safe because we're filling objects with matching keys
  return { continuous, debounce, workerPool } as TypedJobRegistry<T>;
}
```

### Step 3: Update Factory

```typescript
export function createDurableJobs<
  const T extends Record<string, AnyUnregisteredDefinition>,
>(definitions: T): CreateDurableJobsResult<T> {
  const registry = createTypedJobRegistry(definitions);
  // No phantom type cast needed!

  return {
    Jobs: BoundJobsEngine as typeof DurableJobsEngine,  // Still needed for constructor
    JobsClient: {
      fromBinding: (binding) => createJobsClientTyped(binding, registry),
      Tag: ClientTag,
    },
    registry,
  };
}
```

### Step 4: Simplify Client Types

```typescript
// Much simpler - direct key access
export type ContinuousKeys<T> = keyof TypedJobRegistry<T>["continuous"];
export type DebounceKeys<T> = keyof TypedJobRegistry<T>["debounce"];
export type WorkerPoolKeys<T> = keyof TypedJobRegistry<T>["workerPool"];

// State/Event type extraction also simplifies
export type ContinuousStateType<T, K extends ContinuousKeys<T>> =
  T[K] extends UnregisteredContinuousDefinition<infer S, any, any> ? S : never;
```

### Step 5: Update Handlers (Minimal Changes)

Handlers can continue using `unknown` types internally - the type safety is at the client boundary:

```typescript
const getDefinition = (name: string): Effect.Effect<
  ContinuousDefinition<unknown, unknown, never>,
  JobNotFoundError
> => {
  const def = registryService.registry.continuous[name];
  if (!def) {
    return Effect.fail(new JobNotFoundError({ type: "continuous", name }));
  }
  return Effect.succeed(def);
};
```

The cast is eliminated because we're now accessing an object property, and TypeScript knows the value type.

## Remaining Casts After Fix

Some casts will remain but are either necessary or low-risk:

1. **`BoundJobsEngine as typeof DurableJobsEngine`** - Required for constructor injection pattern
2. **DO binding cast** - Required due to Cloudflare types
3. **`as const` for response literals** - Standard TypeScript pattern
4. **Error type narrowing** - Required for Effect error handling

## Migration Path

1. Create new typed registry alongside existing (non-breaking)
2. Update factory to use typed registry
3. Update client to use new key extraction types
4. Update handlers to use object access
5. Remove old Map-based registry
6. Remove phantom type infrastructure

## Expected Outcome

After implementation:

```typescript
const { Jobs, JobsClient } = createDurableJobs({
  tokenRefresher: Continuous.make({...}),
  webhookDebounce: Debounce.make({...}),
});

const client = JobsClient.fromBinding(env.JOBS);

// These will work without "never" errors:
yield* client.continuous("tokenRefresher").start({...});  // Autocomplete works
yield* client.debounce("webhookDebounce").add({...});     // Type-safe

// TypeScript error for unknown job name:
yield* client.continuous("nonexistent").start({...});     // Error: "nonexistent" not assignable
```

## Appendix: Effect-Specific Type Handling

The Effect library type inference issues (retry executor, handler return types) are separate from the registry phantom type problem. These require:

1. Explicit generic type annotations on Effect.gen functions
2. Using Effect.andThen instead of nested Effect.flatMap in some cases
3. Explicit return type annotations on complex Effect chains

These are documented in Effect's best practices and are inherent to TypeScript's limitations with higher-kinded types.
