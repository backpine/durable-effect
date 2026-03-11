# Design: Type-Safe `onError` Handler

## Problem

The `onError` handler in `TaskDefineConfig` receives `error: unknown`:

```typescript
readonly onError?: (
  ctx: TaskContext<S>,
  error: unknown,  // <-- loses type information
) => Effect.Effect<void, OErr, R>
```

We already have the error types from the other handlers (`EErr` from `onEvent`, `AErr` from `onAlarm`). The error flowing into `onError` will always be one of those types. There's no reason it should be `unknown`.

## Root Cause

The type information is lost in two places:

1. **`TaskDefineConfig`** — has `EErr` and `AErr` as separate type params but doesn't use them in the `onError` signature
2. **`TaskDefinition`** — collapses all error types into a single `Err` union (`EErr | AErr | OErr | GErr`), so the distinction between "errors I catch" and "errors I throw" is erased

## Design

Preserve separate error type parameters through `TaskDefinition` instead of collapsing them into a single `Err`.

### `TaskDefineConfig` (user-facing)

The only change is the `onError` parameter type — `unknown` becomes `EErr | AErr`:

```typescript
export interface TaskDefineConfig<S, E, EErr, AErr, R, OErr = never, GErr = never> {
  readonly state: PureSchema<S>
  readonly event: PureSchema<E>
  readonly onEvent: (ctx: TaskContext<S>, event: E) => Effect.Effect<void, EErr, R>
  readonly onAlarm: (ctx: TaskContext<S>) => Effect.Effect<void, AErr, R>
  readonly onError?: (
    ctx: TaskContext<S>,
    error: EErr | AErr,           // <-- was `unknown`
  ) => Effect.Effect<void, OErr, R>
  readonly onClientGetState?: (ctx: TaskContext<S>, state: S | null) => Effect.Effect<S | null, GErr, R>
}
```

Same change for `TaskDefineConfigVoid` (replace `unknown` with `EErr | AErr`).

### `TaskDefinition` (internal)

Split the single `Err` param into the individual handler error types:

```typescript
export interface TaskDefinition<S, E, EErr, AErr, R, OErr = never, GErr = never> {
  readonly _tag: "TaskDefinition"
  readonly state: PureSchema<S>
  readonly event: PureSchema<E>
  readonly onEvent: (ctx: TaskContext<S>, event: E) => Effect.Effect<void, EErr, R>
  readonly onAlarm: (ctx: TaskContext<S>) => Effect.Effect<void, AErr, R>
  readonly onError?: (
    ctx: TaskContext<S>,
    error: EErr | AErr,
  ) => Effect.Effect<void, OErr, R>
  readonly onClientGetState?: (ctx: TaskContext<S>, state: S | null) => Effect.Effect<S | null, GErr, R>
}
```

Add a utility type for extracting the full error union when needed:

```typescript
export type TaskErrors<D> =
  D extends TaskDefinition<any, any, infer EErr, infer AErr, any, infer OErr, infer GErr>
    ? EErr | AErr | OErr | GErr
    : never
```

### `Task.define()`

Becomes a direct pass-through — no union collapsing needed:

```typescript
export const Task = {
  define<S, E, EErr, AErr, R, OErr = never, GErr = never>(
    config: TaskDefineConfig<S, E, EErr, AErr, R, OErr, GErr>,
  ): TaskDefinition<S, E, EErr, AErr, R, OErr, GErr> {
    return {
      _tag: "TaskDefinition",
      state: config.state,
      event: config.event,
      onEvent: config.onEvent,
      onAlarm: config.onAlarm,
      onError: config.onError,
      onClientGetState: config.onClientGetState,
    }
  },
}
```

### `withServices`

Update signature to preserve the split types:

```typescript
export function withServices<S, E, EErr, AErr, R, OErr, GErr>(
  definition: TaskDefinition<S, E, EErr, AErr, R, OErr, GErr>,
  layer: Layer.Layer<R>,
): TaskDefinition<S, E, EErr, AErr, never, OErr, GErr> {
  // body unchanged — just wraps each handler with Effect.provide
}
```

### `buildRegisteredTask` / `registerTask`

Update the generic params from `<S, E, Err>` to `<S, E, EErr, AErr, OErr, GErr>`:

```typescript
function buildRegisteredTask<S, E, EErr, AErr, OErr, GErr>(
  definition: TaskDefinition<S, E, EErr, AErr, never, OErr, GErr>,
): RegisteredTask {
  // ...

  const handleEvent = (...): Effect.Effect<void, TaskValidationError | TaskExecutionError> =>
    Effect.gen(function* () {
      const event = yield* decodeEvent(rawEvent).pipe(
        Effect.mapError((e) => new TaskValidationError({ message: e.message, cause: e })),
      )
      const ctx = buildTaskContext(storage, alarm, id, name, decodeState, encodeState)

      // onEvent fails with EErr. Widen to include PurgeSignal for catchTag.
      const withPurge = definition.onEvent(ctx, event).pipe(
        Effect.mapError((e): EErr | PurgeSignal => e),
        Effect.catchTag("PurgeSignal", () => cleanup(storage, alarm)),
      )
      // After catchTag, error type is EErr | TaskExecutionError

      if (!definition.onError) {
        yield* withPurge.pipe(
          Effect.mapError((e) => new TaskExecutionError({ cause: e })),
        )
        return
      }

      // Effect.catch catches EErr, which is assignable to EErr | AErr
      yield* withPurge.pipe(
        Effect.catch((error) =>
          definition.onError!(ctx, error as EErr | AErr).pipe(
            Effect.mapError((e): OErr | PurgeSignal => e),
            Effect.catchTag("PurgeSignal", () => cleanup(storage, alarm)),
            Effect.mapError((e) => new TaskExecutionError({ cause: e })),
          )
        ),
      )
    })

  // handleAlarm — same pattern, catches AErr which is assignable to EErr | AErr
}
```

**Note on the `as EErr | AErr`**: The `Effect.catch` callback receives `EErr` (the error type from `onEvent`). The `onError` handler expects `EErr | AErr`. Since `EErr` is a subtype of `EErr | AErr`, this is a safe widening. Depending on how `Effect.catch` infers its callback parameter type, TypeScript may need the explicit annotation. If `Effect.catch` preserves the exact error type from the upstream effect, no cast is needed — `EErr` is assignable to `EErr | AErr` naturally. We should verify this during implementation and only add the annotation if the compiler requires it.

### `registerTask` / `registerTaskWithLayer`

```typescript
export function registerTask<S, E, EErr, AErr, OErr, GErr>(
  definition: TaskDefinition<S, E, EErr, AErr, never, OErr, GErr>,
): RegisteredTask {
  return buildRegisteredTask(definition)
}

export function registerTaskWithLayer<S, E, EErr, AErr, R, OErr, GErr>(
  definition: TaskDefinition<S, E, EErr, AErr, R, OErr, GErr>,
  layer: Layer.Layer<R>,
): RegisteredTask {
  const resolved = withServices(definition, layer)
  return buildRegisteredTask(resolved)
}
```

### Cloudflare `createTasks` type helpers

Any type helpers like `EventOf`, `StateOf` that extract types from `TaskDefinition` need their type parameter positions updated to match the new signature.

## What Does NOT Change

- `RegisteredTask` — stays the same (type-erased closures)
- `TaskRunner` — stays the same (works with `RegisteredTask`)
- `TaskContext` — stays the same
- Error classes (`TaskError`, `TaskExecutionError`, etc.) — stay the same
- Storage/Alarm services — stay the same
- Runtime behavior — no changes at all

## User Experience

Before:
```typescript
const myTask = Task.define({
  state: MyState,
  event: MyEvent,
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      // can fail with MyEventError
    }),
  onAlarm: (ctx) =>
    Effect.gen(function* () {
      // can fail with MyAlarmError
    }),
  onError: (ctx, error) => {
    // error: unknown — must manually narrow
    // no autocomplete, no exhaustiveness checking
  },
})
```

After:
```typescript
const myTask = Task.define({
  state: MyState,
  event: MyEvent,
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      // can fail with MyEventError
    }),
  onAlarm: (ctx) =>
    Effect.gen(function* () {
      // can fail with MyAlarmError
    }),
  onError: (ctx, error) => {
    // error: MyEventError | MyAlarmError — fully typed
    // can use Effect.catchTag, switch on _tag, exhaustive matching, etc.
  },
})
```

## Files to Modify

1. `src/TaskDefinition.ts` — split `Err` into `EErr, AErr, OErr, GErr`; change `onError` param type
2. `src/Task.ts` — update `define()` return type
3. `src/services/TaskRegistry.ts` — update `buildRegisteredTask`, `registerTask`, `registerTaskWithLayer` generics
4. `src/cloudflare/createTasks.ts` — update type helper positions if they reference `TaskDefinition` type params

## Why This Works Without Hacks

- Effect's type system already unions error types naturally via `flatMap`, `gen`, etc.
- The separate type params (`EErr`, `AErr`) are already inferred by TypeScript at the `Task.define()` call site — we just weren't threading them through
- `EErr` is naturally assignable to `EErr | AErr`, so `Effect.catch` in `handleEvent` can pass its caught `EErr` error directly to `onError` which expects `EErr | AErr`
- No type casts, no `as unknown as`, no runtime changes — purely a type-level refactor
