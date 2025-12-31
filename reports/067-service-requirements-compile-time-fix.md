# Service Requirements Compile-Time Enforcement

## Problem Statement

When a job uses a custom service (like `Random`), TypeScript **correctly infers** the requirement:

```ts
// Hovering over execute shows:
// Effect.Effect<void, string | UnknownException, Random>
```

But `pnpm build` produces no error about the missing service. The user only discovers the problem at runtime.

## Root Cause

The type is correctly inferred at the definition level, but **erased at the constraint level**.

### The Culprit: `AnyUnregisteredDefinition`

```ts
// packages/jobs/src/registry/types.ts:207-211
export type AnyUnregisteredDefinition =
  | UnregisteredContinuousDefinition<any, unknown, any>   // R = any
  | UnregisteredDebounceDefinition<any, any, unknown, any> // R = any
  | ...
```

The R parameter is `any`, not `never`. This means the constraint `T extends Record<string, AnyUnregisteredDefinition>` accepts **any** R value without complaint.

### Why `any` Allows Everything

```ts
// This constraint:
const T extends Record<string, AnyUnregisteredDefinition>

// Accepts this definition where R = Random:
UnregisteredDebounceDefinition<Input, State, Error, Random>

// Because Random is assignable to `any` (any accepts everything)
```

## The Fix: Enforce R at Registration Time

### Approach: Conditional Type Constraint on `createDurableJobs`

We need to:
1. Extract the combined R requirements from all definitions
2. Make TypeScript error if R ≠ never AND no services layer is provided

### Implementation Plan

#### Step 1: Add Type Utilities

Create type-level helpers to extract and validate requirements:

```ts
// packages/jobs/src/registry/types.ts

/**
 * Extract the R (requirements) type from a definition.
 */
export type ExtractRequirements<T> =
  T extends UnregisteredContinuousDefinition<any, any, infer R> ? R :
  T extends UnregisteredDebounceDefinition<any, any, any, infer R> ? R :
  T extends UnregisteredWorkerPoolDefinition<any, any, infer R> ? R :
  T extends UnregisteredTaskDefinition<any, any, any, infer R> ? R :
  never;

/**
 * Extract combined requirements from all definitions in a record.
 */
export type ExtractAllRequirements<T extends Record<string, AnyUnregisteredDefinition>> =
  { [K in keyof T]: ExtractRequirements<T[K]> }[keyof T];

/**
 * Check if any requirements exist (R is not just `never`).
 */
export type HasRequirements<R> = [R] extends [never] ? false : true;
```

#### Step 2: Add Services Option to Factory

Modify `CreateDurableJobsOptions` to accept a services layer:

```ts
// packages/jobs/src/factory.ts

import { Layer } from "effect";
import type { ExtractAllRequirements } from "./registry/types";

export interface CreateDurableJobsOptions<R = never> {
  readonly tracker?: HttpBatchTrackerConfig;
  /**
   * Custom services layer to provide to job execute functions.
   * Required if any job uses custom Effect services (R ≠ never).
   */
  readonly services?: Layer.Layer<R>;
}
```

#### Step 3: Add Conditional Type Constraint

This is the key enforcement mechanism:

```ts
// packages/jobs/src/factory.ts

/**
 * Constraint that forces services to be provided when jobs have requirements.
 */
type RequireServicesIfNeeded<
  T extends Record<string, AnyUnregisteredDefinition>,
  Options extends CreateDurableJobsOptions<any> | undefined
> = ExtractAllRequirements<T> extends never
  ? {} // No requirements, options can omit services
  : Options extends { services: Layer.Layer<infer R> }
    ? ExtractAllRequirements<T> extends R
      ? {} // Services provided and satisfy requirements
      : { __error: `Missing services. Jobs require: ${string}` }
    : { __error: `Jobs have service requirements but no services layer provided` };

export function createDurableJobs<
  const T extends Record<string, AnyUnregisteredDefinition>,
  const Options extends CreateDurableJobsOptions<any> | undefined = undefined,
>(
  definitions: T,
  options?: Options & RequireServicesIfNeeded<T, Options>
): CreateDurableJobsResult<T>
```

#### Step 4: Provide Services at Runtime

Modify the runtime layer composition to include user services:

```ts
// packages/jobs/src/runtime/runtime.ts

function createDispatcherLayer(
  coreLayer: RuntimeLayer,
  registry: RuntimeJobRegistry,
  trackerConfig?: HttpBatchTrackerConfig,
  servicesLayer?: Layer.Layer<any> // Add this parameter
): Layer.Layer<Dispatcher> {
  // ... existing code ...

  const baseLayer = Layer.provideMerge(coreLayer, trackerLayer);

  // Add user services if provided
  const withUserServices = servicesLayer
    ? Layer.provideMerge(baseLayer, servicesLayer)
    : baseLayer;

  const servicesLayer = RuntimeServicesLayer.pipe(Layer.provideMerge(withUserServices));
  // ... rest of layer composition
}
```

## Your Specific Case

### Current Code (No Compile Error)

```ts
// examples/effect-worker-v2/src/jobs/basic-debounce.ts
class Random extends Context.Tag("MyRandomService")<
  Random,
  { readonly next: Effect.Effect<number> }
>() {}

export const debounceExample = Debounce.make({
  // ...
  execute: (ctx) =>
    Effect.gen(function* () {
      const random = yield* Random;  // R = Random (LSP shows this!)
      // ...
    }),
});

// examples/effect-worker-v2/src/jobs/index.ts
export const { Jobs, JobsClient } = createDurableJobs({
  debounceExample2: debounceExample,  // R = Random - NO ERROR!
}, {
  tracker: { /* ... */ },
});
```

### After Fix (Compile Error!)

```ts
// Same definition - no changes needed

// At registration:
export const { Jobs, JobsClient } = createDurableJobs({
  debounceExample2: debounceExample,
}, {
  tracker: { /* ... */ },
});
// ❌ Type error: Jobs have service requirements but no services layer provided

// Fixed version:
export const { Jobs, JobsClient } = createDurableJobs({
  debounceExample2: debounceExample,
}, {
  tracker: { /* ... */ },
  services: Layer.succeed(Random, {
    next: Effect.succeed(Math.random()),
  }),
});
// ✅ Compiles - Random is provided
```

---

## Usage Examples

### Job Definition with Service Requirement

```ts
// Define a custom service
class Random extends Context.Tag("MyRandomService")<
  Random,
  { readonly next: Effect.Effect<number> }
>() {}

// Job that uses the service
const debounceExample = Debounce.make({
  eventSchema: Schema.Struct({ actionId: Schema.String }),
  flushAfter: "30 seconds",
  execute: (ctx) =>
    Effect.gen(function* () {
      const random = yield* Random;  // Requires Random service
      const chance = yield* random.next;
      // ...
    }),
});
```

### Registration WITHOUT Services (Compile Error)

```ts
// ERROR: Jobs have service requirements but no services layer provided
const { Jobs, JobsClient } = createDurableJobs({
  debounceExample,
});
```

The error message would be a compile-time error from TypeScript.

### Registration WITH Services (Compiles)

```ts
const { Jobs, JobsClient } = createDurableJobs(
  {
    debounceExample,
  },
  {
    services: Layer.succeed(Random, {
      next: Effect.succeed(Math.random()),
    }),
  }
);
```

### Multiple Services

```ts
// Define multiple services
class Logger extends Context.Tag("Logger")<Logger, { log: (msg: string) => Effect.Effect<void> }>() {}
class Config extends Context.Tag("Config")<Config, { apiKey: string }>() {}

// Jobs using different services
const jobA = Debounce.make({...}); // Uses Random
const jobB = Continuous.make({...}); // Uses Logger
const jobC = Task.make({...}); // Uses Config

// Must provide ALL required services
const { Jobs, JobsClient } = createDurableJobs(
  { jobA, jobB, jobC },
  {
    services: Layer.mergeAll(
      Layer.succeed(Random, { next: Effect.succeed(0.5) }),
      Layer.succeed(Logger, { log: (msg) => Effect.log(msg) }),
      Layer.succeed(Config, { apiKey: "secret" }),
    ),
  }
);
```

### Service from Environment

```ts
// Create service layer from worker environment
const createServicesLayer = (env: Env) =>
  Layer.mergeAll(
    Layer.succeed(Random, { next: Effect.succeed(Math.random()) }),
    Layer.succeed(Config, { apiKey: env.API_KEY }),
  );

// In worker
export default {
  async fetch(request: Request, env: Env) {
    // Services are initialized per-request if needed
  }
};

// At registration time - use placeholder/default values
const { Jobs, JobsClient } = createDurableJobs(
  { debounceExample },
  {
    services: Layer.succeed(Random, { next: Effect.succeed(0.5) }),
  }
);
```

## Alternative: Environment-Injected Services

If services need access to the worker `env`, we need a different pattern:

```ts
// Option A: Services factory function
export interface CreateDurableJobsOptions<R = never> {
  readonly services?: Layer.Layer<R> | ((env: unknown) => Layer.Layer<R>);
}

// Option B: Services via DO constructor
class BoundJobsEngine extends DurableJobsEngine {
  constructor(state: DurableObjectState, env: Env) {
    const enrichedEnv = {
      ...env,
      __JOB_REGISTRY__: runtimeRegistry,
      __SERVICES_LAYER__: createServicesLayer(env), // Dynamic services
    };
    super(state, enrichedEnv);
  }
}
```

## Implementation Steps

### Phase 1: Type-Level Enforcement

1. Add `ExtractRequirements` and `ExtractAllRequirements` types to `registry/types.ts`
2. Add `RequireServicesIfNeeded` conditional type to `factory.ts`
3. Modify `createDurableJobs` signature to include the constraint
4. Add `services` option to `CreateDurableJobsOptions`

### Phase 2: Runtime Integration

5. Thread `servicesLayer` through `createDispatcherLayer`
6. Provide services layer in `JobExecutionService.execute`
7. Update `BoundJobsEngine` to accept services from options

### Phase 3: Documentation & Testing

8. Add tests for compile-time error cases
9. Add tests for runtime service provision
10. Document the services API in README

## Type Flow After Fix

```
User Definition                    Registration                     Runtime
─────────────────────────────────────────────────────────────────────────────
Debounce.make({                    createDurableJobs({              DebounceHandler
  execute: Effect<void, E, R>        definitions: T,                  .handle()
})                                   options: {                           │
     │                                 services: Layer<R>  ◄────────┐    │
     │ R = Random                    }                              │    │
     ▼                             })                               │    │
UnregisteredDebounceDefinition<        │                            │    ▼
  I, S, E, Random                      │                            │ execution
>                                      ▼                            │ .execute()
     │                          TypedJobRegistry<T>                 │    │
     │                               │                              │    │
     │                               ▼                              │    ▼
     │                          RequireServicesIfNeeded<T, Opts>    │ def.execute(ctx)
     │                               │                              │ returns Effect<
     │                               │                              │   void, E, Random
     │                               ▼                              │ >
     │                          ❌ Type Error if services           │    │
     │                             not provided!                    │    │
     │                                                              │    ▼
     │                                                              │ Effect.provide(
     │                                                              │   servicesLayer
     │                                                              └── )
     └──────────────────────────────────────────────────────────────────▶
                                                                         │
                                                                         ▼
                                                                    ✅ Random provided!
                                                                    Execution succeeds
```

## Trade-offs

### Pros
- Compile-time enforcement of service requirements
- Clear API for providing services
- Type-safe - if it compiles, services are satisfied
- Follows Effect's layer composition patterns

### Cons
- More complex type signatures
- Services must be statically defined (can't depend on per-request env without factory pattern)
- Breaking change if any existing code relies on current behavior

## Questions to Resolve

1. **Should services be static or dynamic?**
   - Static: Defined at registration time
   - Dynamic: Factory function receiving env at runtime

2. **Error message clarity:**
   - TypeScript's error for conditional types can be cryptic
   - May need branded types or custom error types for better DX

3. **Backwards compatibility:**
   - Jobs with R = never should continue to work unchanged
   - Only jobs with R ≠ never require the new `services` option

## Minimal Code Changes

Here are the actual file changes needed:

### 1. `packages/jobs/src/registry/types.ts` - Add type utilities

```ts
// Add at end of file:

/**
 * Extract the R (requirements) type from an unregistered definition.
 */
export type ExtractRequirements<T> =
  T extends UnregisteredContinuousDefinition<any, any, infer R> ? R :
  T extends UnregisteredDebounceDefinition<any, any, any, infer R> ? R :
  T extends UnregisteredWorkerPoolDefinition<any, any, infer R> ? R :
  T extends UnregisteredTaskDefinition<any, any, any, infer R> ? R :
  never;

/**
 * Extract combined requirements from all definitions.
 */
export type ExtractAllRequirements<T extends Record<string, AnyUnregisteredDefinition>> =
  { [K in keyof T]: ExtractRequirements<T[K]> }[keyof T];
```

### 2. `packages/jobs/src/factory.ts` - Add services option and constraint

```ts
import { Layer } from "effect";
import type { ExtractAllRequirements } from "./registry/types";

// Update CreateDurableJobsOptions:
export interface CreateDurableJobsOptions<R = never> {
  readonly tracker?: HttpBatchTrackerConfig;
  readonly services?: Layer.Layer<R>;
}

// Add constraint type:
type RequireServicesIfNeeded<
  T extends Record<string, AnyUnregisteredDefinition>,
  R
> = [R] extends [never]
  ? {}
  : { services: Layer.Layer<R> };

// Update function signature:
export function createDurableJobs<
  const T extends Record<string, AnyUnregisteredDefinition>,
>(
  definitions: T,
  options?: CreateDurableJobsOptions<ExtractAllRequirements<T>> &
    RequireServicesIfNeeded<T, ExtractAllRequirements<T>>
): CreateDurableJobsResult<T>
```

### 3. `packages/jobs/src/engine.ts` (or wherever runtime layers are composed)

```ts
// Thread services layer to execution:
const servicesLayer = options?.__SERVICES_LAYER__;

// In layer composition, merge user services:
const baseLayer = servicesLayer
  ? Layer.provideMerge(coreLayer, servicesLayer)
  : coreLayer;
```

## Summary

| What | Where | Change |
|------|-------|--------|
| Type extraction | `registry/types.ts` | Add `ExtractRequirements` and `ExtractAllRequirements` |
| Options type | `factory.ts` | Add `services?: Layer.Layer<R>` |
| Constraint | `factory.ts` | Add `RequireServicesIfNeeded` conditional type |
| Runtime | `engine.ts` | Merge user services into execution layer |

## Conclusion

The fix is achievable by:
1. Adding type-level extraction of R from definitions
2. Adding a conditional constraint that requires `services` when R ≠ never
3. Threading the services layer through to runtime execution

This preserves the current type inference (which already works!) while adding enforcement at the registration boundary.

The key insight is that **TypeScript already knows about the `Random` requirement** (you can see it on hover). The problem is just that `AnyUnregisteredDefinition` uses `any` for R, which accepts any value. By extracting R and requiring services when R ≠ never, we leverage the type information that's already there.
