# Report 070: Effect.provideService Misuse in Job Handler

## Summary

The example in `basic-debounce.ts` incorrectly uses `Effect.provideService` to create what it assumes is a layer, but `Effect.provideService` is a **partial application function**, not a layer constructor. This causes the job handler to fail with `R = Random` instead of `R = never`.

## Error Messages

```
src/jobs/basic-debounce.ts(62,5): error TS2322: Type 'Effect<void, string | UnknownException, Random>'
is not assignable to type 'Effect<void, string | UnknownException, never>'.
  Type 'Random' is not assignable to type 'never'.

src/jobs/basic-debounce.ts(76,28): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Argument of type '<A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, Random>>'
    is not assignable to parameter of type 'ManagedRuntime<unknown, unknown>'.
```

## Root Cause

In `basic-debounce.ts`:

```typescript
// Line 9-11: INCORRECT usage
const RandomLive = Effect.provideService(Random, {
  next: Effect.sync(() => Math.random()),
});
```

`Effect.provideService(tag, service)` returns a **function** of type:
```typescript
<A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, Random>>
```

It does NOT return a Layer or Context. It's a curried/partial application meant to be used directly in a pipe:
```typescript
effect.pipe(Effect.provideService(Random, impl))
```

However, `Effect.provide()` expects one of:
- `Layer<A, E, R>`
- `Context<A>`
- `Runtime<A>`
- `ManagedRuntime<A, E>`

When `RandomLive` (a function) is passed to `Effect.provide()`, TypeScript cannot find a matching overload, and the service requirement `Random` is never satisfied.

## The Broken Pattern

```typescript
// This creates a function, not a layer
const RandomLive = Effect.provideService(Random, impl);

// This fails - RandomLive is not a Layer/Context/Runtime
effect.pipe(Effect.provide(RandomLive))
```

## Correct Patterns

### Option 1: Use Layer.succeed

```typescript
import { Layer } from "effect";

const RandomLive = Layer.succeed(Random, {
  next: Effect.sync(() => Math.random()),
});

// Now Effect.provide works correctly
effect.pipe(Effect.provide(RandomLive))
```

### Option 2: Use Effect.provideService directly in pipe

```typescript
// Don't store it - use directly
effect.pipe(
  Effect.provideService(Random, {
    next: Effect.sync(() => Math.random()),
  })
)
```

### Option 3: Use Layer.effect for effectful construction

```typescript
const RandomLive = Layer.effect(
  Random,
  Effect.succeed({
    next: Effect.sync(() => Math.random()),
  })
);
```

## Documentation Issue

The docstring in `packages/jobs/src/definitions/debounce.ts` (lines 92-96) shows:

```typescript
* @example
* ```ts
* execute: (ctx) =>
*   Effect.gen(function* () {
*     const random = yield* Random;
*     // ...
*   }).pipe(Effect.provide(RandomLive))
* ```
```

This example assumes `RandomLive` is a Layer, but doesn't show how to create it correctly. The example in `basic-debounce.ts` attempted to follow this pattern but used the wrong API.

## Affected Files

- `examples/effect-worker-v2/src/jobs/basic-debounce.ts` - Broken example
- `packages/jobs/src/definitions/debounce.ts` - Documentation could be clearer
- `packages/jobs/src/definitions/continuous.ts` - Same documentation pattern
- `packages/jobs/src/definitions/task.ts` - Same documentation pattern

## Fix Required

Change `basic-debounce.ts` from:

```typescript
const RandomLive = Effect.provideService(Random, {
  next: Effect.sync(() => Math.random()),
});
```

To:

```typescript
import { Layer } from "effect";

const RandomLive = Layer.succeed(Random, {
  next: Effect.sync(() => Math.random()),
});
```

## Key Insight

Effect-TS has two similar-sounding but different APIs:

| API | Returns | Usage |
|-----|---------|-------|
| `Effect.provideService(tag, impl)` | `(effect) => effect` (function) | Use directly in `.pipe()` |
| `Layer.succeed(tag, impl)` | `Layer<Tag, never, never>` | Pass to `Effect.provide()` |

The naming similarity can cause confusion. `Effect.provideService` is essentially a convenience wrapper for `Effect.provide(Context.make(tag, impl))` but as a pipeable function.

## Verification

After fixing, the example should build:
```bash
cd examples/effect-worker-v2 && pnpm build
```
