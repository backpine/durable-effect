# Jobs Package - Code Quality Findings

This document catalogues code quality issues found in `@durable-effect/jobs`, ranked by severity.

---

## CRITICAL - Architectural Anti-Patterns

### 1. Excessive Type Casting Throughout Client (`client/client.ts`)

**Severity:** Critical
**Location:** `src/client/client.ts:100-166`, `176-232`, `248-431`

Every single DO RPC call uses `as Promise<...>` casts to force types:

```typescript
return stub.call({
  type: "continuous",
  action: "start",
  name,
  id,
  input,
}) as Promise<ContinuousStartResponse>;  // Line 120
```

This pattern repeats ~30+ times. The `call()` method returns `Promise<PrimitiveResponse>` (a union), but we cast each response to a specific type without runtime validation.

**Problems:**
- Runtime type mismatch won't be caught
- No way to know if the server returns wrong response type
- Defeats TypeScript's purpose
- Would be hidden bugs if server sends `WorkerPoolEnworkerPoolResponse` but client expects `ContinuousStartResponse`

**Fix:** Use discriminated union narrowing based on `_type` field, or use Effect's `Match` module.

---

### 2. `any` Type Proliferation in Handler (`handlers/continuous/handler.ts`)

**Severity:** Critical
**Location:** `src/handlers/continuous/handler.ts:46-51`, `89`, `172`, `219`, `256`, `298`, `323`

`ContinuousDefinition<any, any, any>` is used throughout instead of preserving generic types:

```typescript
const getDefinition = (
  name: string
): Effect.Effect<
  ContinuousDefinition<any, any, any>,  // Generic types lost
  PrimitiveNotFoundError
>
```

```typescript
function handleStart(
  def: ContinuousDefinition<any, any, any>,  // any everywhere
  request: ContinuousRequest
)
```

**Problems:**
- Type safety completely lost for state schema, error type, requirements
- User's typed definitions become `any` at runtime
- Can't catch schema mismatches at compile time
- Error handlers receive `any` instead of typed errors

**Fix:** Propagate generics properly or use branded types.

---

### 3. Unsafe Type Casting in Executor (`handlers/continuous/executor.ts:66, 75-78`)

**Severity:** Critical
**Location:** `src/handlers/continuous/executor.ts`

```typescript
// Line 66: Cast user's Effect to lose error/requirements info
const executeEffect = def.execute(ctx) as Effect.Effect<void, unknown>;

// Lines 75-78: Cast again to lose all type info
const onErrorEffect = def.onError(
  error,
  ctx
) as Effect.Effect<void>;
```

**Problems:**
- User's typed `Effect<void, E, R>` becomes `Effect<void, unknown>`
- Requirements (R) are completely erased - user's services won't be provided
- If user's execute function requires `R = HttpClient`, it will fail at runtime

**Fix:** Properly handle the requirements channel, possibly using `Effect.provide` or restricting to `R = never`.

---

### 4. Mutable State Anti-Pattern (`handlers/continuous/context.ts`)

**Severity:** Critical
**Location:** `src/handlers/continuous/context.ts:15-18`, `42-49`

```typescript
export interface StateHolder<S> {
  current: S;    // Mutable!
  dirty: boolean; // Mutable!
}

setState: (newState: S) => {
  stateHolder.current = newState;  // Direct mutation
  stateHolder.dirty = true;
},
```

**Problems:**
- Effect is built around immutability; this is antithetical
- Race conditions possible if context escapes closure
- Cannot be used with Effect's Ref for proper state management
- No transactional semantics - partial updates possible on error

**Fix:** Use `Ref<S>` from Effect for state management:
```typescript
const stateRef = yield* Ref.make(initialState);
const ctx = {
  state: () => Ref.get(stateRef),
  setState: (s) => Ref.set(stateRef, s),
};
```

---

### 5. `withStorageContext` Hack - Layer Anti-Pattern (`handlers/continuous/handler.ts:111-113`)

**Severity:** Critical
**Location:** `src/handlers/continuous/handler.ts`

```typescript
const withStorageContext = <A, E>(
  effect: Effect.Effect<A, E, StorageAdapter>
): Effect.Effect<A, E> => Effect.provideService(effect, StorageAdapter, storage);
```

Then used selectively:
```typescript
case "start":
  return yield* withStorageContext(handleStart(def, request));
case "stop":
  return yield* handleStop(def, request);  // No context wrapper
```

**Problems:**
- Manual re-injection of services that should flow from layer
- Inconsistent application (some handlers need it, some don't)
- Indicates broken layer composition
- Should be fixed by proper layer architecture, not manual patching

**Fix:** Restructure layers so `StorageAdapter` is available to all nested effects without manual injection.

---

## HIGH - Type Safety Issues

### 6. Runtime Type Cast in Runtime Factory (`runtime/runtime.ts:144-146, 166`)

**Severity:** High
**Location:** `src/runtime/runtime.ts`

```typescript
const runEffect = <A, E>(
  effect: Effect.Effect<A, E, Dispatcher>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(dispatcherLayer))
  ) as Promise<A>;  // Cast to erase error type

flush: () =>
  runEffect(flushEvents as Effect.Effect<void, never, Dispatcher>),  // Cast to wrong type
```

**Problems:**
- Error type `E` is erased - exceptions become untyped
- `flushEvents` is cast instead of properly typed
- Promise rejection will have unknown error type

---

### 7. Type Assertions in Factory (`factory.ts:218, 242`)

**Severity:** High
**Location:** `src/factory.ts`

```typescript
const enrichedEnv: JobsEngineConfig = {
  ...(env as object),  // Cast env to object
  __PRIMITIVE_REGISTRY__: registry,
};

return {
  Jobs: BoundJobsEngine as typeof DurableJobsEngine,  // Cast class type
```

**Problems:**
- `env` type is `unknown`, cast to `object` loses any type info
- Class cast hides potential incompatibilities

---

### 8. Union Type Without Narrowing (`runtime/types.ts:116-118`)

**Severity:** High
**Location:** `src/runtime/types.ts`

```typescript
export interface ContinuousGetStateResponse {
  readonly _type: "continuous.getState";
  readonly state: unknown | null;  // Should be generic or branded
}
```

**Problems:**
- `unknown | null` means caller must cast to use the state
- No way to infer state type from definition
- All state access requires unsafe casts

---

### 9. DO Stub Cast Pattern (`client/client.ts:100-103`)

**Severity:** High
**Location:** `src/client/client.ts`

```typescript
const getStub = (instanceId: string): DurableJobsEngineInterface => {
  const id = binding.idFromName(instanceId);
  return binding.get(id) as unknown as DurableJobsEngineInterface;
};
```

Double cast `as unknown as` is a code smell indicating the type system is being bypassed entirely.

---

## MEDIUM - Effect Anti-Patterns

### 10. `matchEffect` Instead of Idiomatic Error Handling (`executor.ts:70-107`)

**Severity:** Medium
**Location:** `src/handlers/continuous/executor.ts`

```typescript
const result = yield* executeEffect.pipe(
  Effect.matchEffect({
    onSuccess: () => Effect.succeed(undefined),
    onFailure: (error) => {
      if (def.onError) {
        // ...nested matchEffect
      }
      return Effect.fail(new ExecutionError({...}));
    },
  })
);
```

**Problems:**
- Verbose and hard to follow
- `matchEffect` is low-level - should use `catchAll`, `catchTag`, or `tapError`
- Nesting `matchEffect` inside `matchEffect` creates callback hell

**Idiomatic Fix:**
```typescript
yield* executeEffect.pipe(
  Effect.catchAll((error) =>
    def.onError
      ? def.onError(error, ctx).pipe(Effect.ignoreLogged)
      : Effect.fail(new ExecutionError({ cause: error }))
  )
);
```

---

### 11. Console.log for Logging Instead of Effect Logging (`dispatcher.ts:111-125`)

**Severity:** Medium
**Location:** `src/runtime/dispatcher.ts`

```typescript
case "debounce":
  console.log(
    `[Dispatcher] Alarm for debounce/${meta.name} (handler not implemented)`
  );
  break;

default:
  console.warn(
    `[Dispatcher] Unknown primitive type in alarm: ${meta.type}`
  );
```

**Problems:**
- `console.log` bypasses Effect's logging infrastructure
- Not captured in traces or structured logs
- Can't be silenced in tests

**Fix:** Use `Effect.logWarning` or `Effect.logDebug`.

---

### 12. Duplicate Runtime Factory Code (`runtime/runtime.ts:104-168 vs 189-248`)

**Severity:** Medium
**Location:** `src/runtime/runtime.ts`

`createJobsRuntime` and `createJobsRuntimeFromLayer` share ~80% identical code:

```typescript
// Both have:
const servicesLayer = RuntimeServicesLayer.pipe(
  Layer.provideMerge(NoopTrackerLayer),
  Layer.provideMerge(coreLayer)
);

const handlersLayer = PrimitiveHandlersLayer.pipe(
  Layer.provideMerge(registryLayer),
  Layer.provideMerge(servicesLayer)
);
// ... and so on
```

**Fix:** Extract shared layer composition into a helper function.

---

### 13. Effect.sync for Side Effects (`handlers/continuous/executor.ts:31-49`)

**Severity:** Medium
**Location:** User-facing execute function pattern

The `StateHolder` mutation pattern forces users to use synchronous state updates:

```typescript
execute: (ctx) =>
  Effect.sync(() => {
    ctx.updateState((s) => ({ count: s.count + 1 }));
  })
```

This is awkward because:
- Users might want to derive new state from async operations
- Pattern doesn't compose well with other Effects

---

## LOW - Code Quality Issues

### 14. Unused Imports (`services/entity-state.ts:3`)

**Severity:** Low
**Location:** `src/services/entity-state.ts`

```typescript
import { Effect, Schema, ParseResult } from "effect";
//                        ^^^^^^^^^^^^ Unused
```

---

### 15. Unused Parameter in Handler Functions

**Severity:** Low
**Location:** `src/handlers/continuous/handler.ts:219, 298, 323`

```typescript
function handleStop(
  def: ContinuousDefinition<any, any, any>,  // def is unused
  request: ContinuousRequest
)

function handleStatus(
  def: ContinuousDefinition<any, any, any>,  // def is unused
  request: ContinuousRequest
)
```

Functions accept `def` but don't use it.

---

### 16. TODOs Scattered Throughout

**Severity:** Low
**Locations:**
- `runtime/runtime.ts:33` - `// TODO: Define TrackerConfig type`
- `runtime/runtime.ts:110` - `// TODO: Support custom tracker`
- `handler.ts:98` - `// TODO: Implement cron parsing`
- `dispatcher.ts:69` - `// TODO: Route to DebounceHandler in Phase 4`
- `dispatcher.ts:77` - `// TODO: Route to WorkerPoolHandler in Phase 5`
- `handlers/index.ts:30-31` - `// TODO: Add DebounceHandlerLayer/WorkerPoolHandlerLayer`

---

### 17. Type Alias That Does Nothing (`factory.ts:88-91`)

**Severity:** Low
**Location:** `src/factory.ts`

```typescript
type InferRegistryFromDefinitions<
  T extends Record<string, AnyPrimitiveDefinition>,
> = PrimitiveRegistry;  // Always returns PrimitiveRegistry, ignores T
```

The generic parameter `T` is completely ignored, defeating the purpose of type inference.

---

### 18. Inconsistent Error Construction

**Severity:** Low
**Location:** Various

Some errors use object shorthand, some don't:

```typescript
// In handler.ts:52-55
new PrimitiveNotFoundError({
  type: "continuous",
  name: name,  // Long form
})

// Could be:
new PrimitiveNotFoundError({ type: "continuous", name })
```

---

## Summary Priority Order

| Priority | Issue | Impact | Effort to Fix |
|----------|-------|--------|---------------|
| 1 | Type casting in client (30+ instances) | Silent runtime errors | High |
| 2 | `any` type proliferation | No type safety for definitions | High |
| 3 | Executor type erasure | User's requirements lost | High |
| 4 | Mutable StateHolder | Effect anti-pattern | Medium |
| 5 | withStorageContext hack | Broken layer architecture | Medium |
| 6 | Runtime type casts | Error types lost | Medium |
| 7 | matchEffect nesting | Code readability | Low |
| 8 | Console.log logging | Test/prod inconsistency | Low |
| 9 | Duplicate code | Maintainability | Low |
| 10 | Unused imports/params | Code cleanliness | Trivial |

---

## Recommended Action Plan

1. **Phase 1 - Type Safety Foundation**
   - Remove all `as` casts in client, use discriminated union narrowing
   - Preserve generic types through handler chain
   - Fix `InferRegistryFromDefinitions` to actually infer types

2. **Phase 2 - Effect Patterns**
   - Replace `StateHolder` with `Ref<S>`
   - Fix layer composition so `withStorageContext` isn't needed
   - Replace `matchEffect` with `catchAll`/`catchTag`

3. **Phase 3 - Cleanup**
   - Replace `console.log` with Effect logging
   - Extract shared runtime factory code
   - Remove unused code and TODOs
