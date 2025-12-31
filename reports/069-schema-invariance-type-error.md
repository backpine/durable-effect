# Report 069: Schema Invariance Type Error

## Summary

After the R = never type system changes (reports 067-068), the jobs package fails to compile when used in applications. The root cause is Effect's Schema type using **invariant** variance for its encoded type parameter.

## Error Examples

```
Type 'Struct<{ actionId: typeof String$; timestamp: typeof Number$; ... }>'
is not assignable to type 'Schema<{ readonly actionId: string; ... }, unknown, never>'.
  The types of '[TypeId]._I' are incompatible between these types.
    Type 'Invariant<{ readonly actionId: string; ... }>' is not assignable to type 'Invariant<unknown>'.
```

## Root Cause

Effect's Schema interface is defined as:
```typescript
export interface Schema<in out A, in out I = A, out R = never>
```

The `in out` modifier on both `A` and `I` makes them **invariant**:
- `A` (decoded type) - invariant
- `I` (encoded type) - invariant
- `R` (requirements) - covariant (out only)

In the recent type changes, the definition interfaces were updated to:
```typescript
export interface UnregisteredContinuousDefinition<S = unknown, E = unknown> {
  readonly stateSchema: Schema.Schema<S, unknown, never>;  // <-- Problem here
  // ...
}
```

When a user passes `Schema.Struct({...})`, the schema's encoded type is the struct's actual type, NOT `unknown`. For example:
- `Schema.Struct({ name: Schema.String })` has type `Schema<{ name: string }, { name: string }, never>`
- But the definition expects `Schema<{ name: string }, unknown, never>`

Since Schema's `I` parameter is invariant, `{ name: string }` is NOT assignable to `unknown` (and vice versa).

## Affected Files

- `packages/jobs/src/registry/types.ts` - All definition interfaces with `stateSchema`, `eventSchema`
- `packages/jobs/src/definitions/*.ts` - Factory config interfaces

## Affected Types

1. `UnregisteredContinuousDefinition` - `stateSchema: Schema.Schema<S, unknown, never>`
2. `UnregisteredDebounceDefinition` - `eventSchema`, `stateSchema`
3. `UnregisteredWorkerPoolDefinition` - `eventSchema`
4. `UnregisteredTaskDefinition` - `stateSchema`, `eventSchema`
5. Stored definition types
6. Factory config interfaces

## Secondary Issue: AnyUnregisteredDefinition

The `AnyUnregisteredDefinition` type also fails:
```typescript
export type AnyUnregisteredDefinition =
  | UnregisteredContinuousDefinition<unknown, unknown>
  | UnregisteredDebounceDefinition<unknown, unknown, unknown>
  | ...
```

When registering jobs:
```typescript
const jobs = { heartbeat, debounceExample };  // Type error!
```

The specific definition types are not assignable to `AnyUnregisteredDefinition` because the schema's invariant type parameter prevents widening.

## Solution

Change the encoded type parameter from `unknown` to `any`:

```typescript
// Before (broken)
readonly stateSchema: Schema.Schema<S, unknown, never>;

// After (working)
readonly stateSchema: Schema.Schema<S, any, never>;
```

Using `any` for the encoded type works because:
1. `any` is bivariant - assignable to and from any type
2. We don't actually care about the encoded type at runtime
3. The decoded type `S` is still preserved for type safety

## Files to Update

1. `packages/jobs/src/registry/types.ts`:
   - Update all schema type parameters from `unknown` to `any`
   - Approximately 8 occurrences

2. `packages/jobs/src/definitions/continuous.ts`
3. `packages/jobs/src/definitions/debounce.ts`
4. `packages/jobs/src/definitions/task.ts`
   - Update `stateSchema` and `eventSchema` type parameters

## Verification

After fixing, the example app should build without errors:
```bash
cd examples/effect-worker-v2 && pnpm build
```

All existing tests should continue to pass.

## Key Insight

Effect's Schema type is more strict than Effect's Effect type:
- `Effect<A, E, R>` has R as covariant, allowing `never` to work
- `Schema<A, I, R>` has I as invariant, requiring exact type matches

This explains why the R = never changes worked for Effect but broke Schema types.
