# Service Requirements Type Erasure Analysis

## Summary

This report analyzes why TypeScript/LSP fails to catch missing service dependencies (like `Random`) at the job/workflow definition level. The root cause is **systematic type erasure** of the `R` (Requirements) type parameter throughout the codebase, combined with the absence of a service injection mechanism.

## Problem Statement

Given this job definition:

```ts
class Random extends Context.Tag("MyRandomService")<
  Random,
  { readonly next: Effect.Effect<number> }
>() {}

export const debounceExample = Debounce.make({
  // ...
  execute: (ctx) =>
    Effect.gen(function* () {
      const random = yield* Random;  // Uses Random service
      // ...
    }),
});
```

**Expected behavior**: TypeScript should error that `Random` is required but never provided.

**Actual behavior**: No compile-time error. The only build error is an unrelated "unused variable" warning.

## Root Cause Analysis

### 1. Type Erasure at Factory Level

#### Jobs Package (`Debounce.make`)

```ts
// packages/jobs/src/definitions/debounce.ts:102
export const Debounce = {
  make: <I, S = I, E = never, R = never>(  // R defaults to `never`
    config: DebounceMakeConfig<I, S, E, R>
  ): UnregisteredDebounceDefinition<I, S, E, R> => ({...}),
};
```

**Issue 1**: The `R = never` default means if TypeScript fails to infer `R` from the config, it defaults to "no requirements."

**Issue 2**: The config interface does allow inference:
```ts
execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, E, R>;
```

TypeScript should infer `R` from the `execute` function's return type. However, inference can fail with complex nested generator functions.

### 2. Type Erasure in Union Types

```ts
// packages/jobs/src/registry/types.ts:207-211
export type AnyUnregisteredDefinition =
  | UnregisteredContinuousDefinition<any, unknown, any>  // R = any
  | UnregisteredDebounceDefinition<any, any, unknown, any>  // R = any
  | UnregisteredWorkerPoolDefinition<any, unknown, any>
  | UnregisteredTaskDefinition<any, any, unknown, any>;
```

When definitions are stored in the union type, `R` becomes `any`, completely erasing the actual requirements.

### 3. Type Erasure in Stored Definitions

```ts
// packages/jobs/src/registry/types.ts:245-256
export interface StoredDebounceDefinition<I = unknown, S = unknown, R = never> {
  // Note: R defaults to `never`, not tracked from source
  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, unknown, R>;
}
```

```ts
// packages/jobs/src/handlers/debounce/handler.ts:61-62
const getDefinition = (
  name: string,
): Effect.Effect<StoredDebounceDefinition<any, any, any>, JobNotFoundError>
```

Handlers receive `StoredDebounceDefinition<any, any, any>` - all type information is erased.

### 4. Type Erasure in Workflow Registry

```ts
// packages/workflow/src/orchestrator/types.ts:9-11
export type WorkflowRegistry = {
  readonly [name: string]: WorkflowDefinition<any, any, any, any>;
};
```

```ts
// packages/workflow/src/orchestrator/registry.ts:32-37
readonly get: (
  name: string,
) => Effect.Effect<
  WorkflowDefinition<any, any, any, any>,  // Requirements = any
  WorkflowNotFoundError
>;
```

The registry returns `WorkflowDefinition<any, any, any, any>`, erasing the `Requirements` type.

### 5. No Service Injection Mechanism

Even if types were preserved, there's no API for users to provide custom services:

```ts
// packages/workflow/src/executor/executor.ts:91-100
const adapterLayer = Layer.mergeAll(
  Layer.succeed(StorageAdapter, storage),
  Layer.succeed(RuntimeAdapter, runtime),
);

const executionLayer = WorkflowScopeLayer.pipe(
  Layer.provideMerge(WorkflowContextLayer),
  Layer.provideMerge(WorkflowLevelLayer),
  Layer.provideMerge(adapterLayer),
);

// No way to inject user-defined services like `Random`!
const exit = yield* definition
  .execute(context.input as Input)
  .pipe(Effect.provide(executionLayer), Effect.exit);
```

The same issue exists in the jobs package - `JobExecutionService.execute()` has no mechanism to accept user-provided layers.

## Type Flow Diagram

```
User Definition                    Registration                     Runtime
─────────────────────────────────────────────────────────────────────────────
Debounce.make({                    createDurableJobs({              DebounceHandler
  execute: Effect<void, E, R>        definitions: T                   .handle()
})                                 })                                    │
     │                                  │                                │
     │ R should be `Random`             │                                │
     ▼                                  ▼                                ▼
UnregisteredDebounceDefinition<   TypedJobRegistry<T>             StoredDebounce
  I, S, E, R                         │                            Definition<
>                                    │                              any, any, any
     │                               ▼                            >
     │                          AnyUnregisteredDefinition              │
     │                          (R = any)                              │
     │                               │                                 │
     │                               ▼                                 ▼
     │                          RuntimeJobRegistry              def.execute(ctx)
     │                          (R = any)                       returns Effect<
     │                                                            void, unknown, any
     └──────────────────────────────────────────────────────────────────────────▶
                                                                       │
                                                                       ▼
                                                                 No type error!
                                                                 R = any is
                                                                 compatible with
                                                                 everything
```

## Why LSP/TypeScript Doesn't Catch This

1. **Type erasure to `any`**: Once `R = any`, TypeScript allows any layer (or no layer) because `any` is compatible with everything.

2. **Default parameters**: `R = never` means uninferable requirements become "no requirements" - a type-safe but incorrect default.

3. **Complex inference failure**: Effect.gen with nested generators can cause TypeScript to fall back to defaults when inference is complex.

4. **No constraint propagation**: The factory functions don't constrain that `R` must be explicitly provided or verified.

## Impact

1. **Silent Runtime Failures**: Jobs/workflows using unprovided services will fail at runtime with cryptic "service not found" errors.

2. **False Sense of Type Safety**: Users expect Effect's powerful type system to catch these issues, but the type erasure defeats this.

3. **Difficult Debugging**: Runtime failures in distributed systems (Cloudflare Durable Objects) are harder to diagnose than compile-time errors.

## Recommendations

### Short-term Fixes

1. **Add Runtime Validation**: Validate at job/workflow registration that all required services can be satisfied:
   ```ts
   // Pseudo-code
   if (definition._requirements.includes(unsatisfiedServices)) {
     throw new Error(`Job "${name}" requires services: ${unsatisfiedServices}`);
   }
   ```

2. **Add Documentation**: Clearly document that custom services must be provided and show the pattern for doing so.

### Medium-term Fixes

1. **Add Service Injection API**: Allow users to provide custom layers:
   ```ts
   createDurableJobs(definitions, {
     services: Layer.mergeAll(
       Layer.succeed(Random, { next: Effect.succeed(Math.random()) }),
     ),
   });
   ```

2. **Preserve Types in Registry**: Use mapped types to preserve the `R` type:
   ```ts
   type TypedWorkflowRegistry<T> = {
     [K in keyof T]: T[K] extends WorkflowDefinition<infer I, infer O, infer E, infer R>
       ? WorkflowDefinition<I, O, E, R>
       : never;
   };
   ```

### Long-term Fixes

1. **Compile-time Service Validation**: Create a type-level check that ensures all requirements are satisfied:
   ```ts
   // Type-level assertion that R extends ProvidedServices
   type ValidateRequirements<R, Provided> =
     Exclude<R, Provided> extends never ? true : false;
   ```

2. **Factory Function Constraints**: Require explicit type annotation when services are needed:
   ```ts
   Debounce.make<Event, State, Error, Random>({
     // TypeScript now knows Random is required
   });
   ```

3. **Effect.Tag Registration**: Integrate with Effect's service registration pattern to track requirements at the type level throughout the pipeline.

## Appendix: Where Type Erasure Occurs

| Location | File | Line | Type Parameter | Issue |
|----------|------|------|----------------|-------|
| `Debounce.make` | `definitions/debounce.ts` | 102 | `R = never` | Default to no requirements |
| `AnyUnregisteredDefinition` | `registry/types.ts` | 207-211 | `R = any` | Union erases R |
| `StoredDebounceDefinition` | `registry/types.ts` | 245 | `R = never` | Stored without R |
| `DebounceHandler.getDefinition` | `handlers/debounce/handler.ts` | 61 | `<any, any, any>` | Handler uses any |
| `WorkflowRegistry` | `orchestrator/types.ts` | 9-11 | `<any, any, any, any>` | Registry uses any |
| `WorkflowRegistryService.get` | `orchestrator/registry.ts` | 32-37 | `<any, any, any, any>` | Get returns any |

## Conclusion

The missing compile-time error for unprovided services is caused by systematic type erasure of the `R` (Requirements) type parameter. This erasure occurs at multiple points:

1. Default type parameters (`R = never`)
2. Union types for storage (`R = any`)
3. Handler type annotations (`R = any`)
4. Registry lookups (`R = any`)

Combined with the absence of a service injection mechanism, users cannot currently provide custom services to jobs/workflows, and TypeScript cannot warn them about this limitation.

The fix requires both type-level changes (preserving `R` through the pipeline) and runtime changes (adding a service injection API).
