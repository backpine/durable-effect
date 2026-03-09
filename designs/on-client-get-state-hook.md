# Design: `onClientGetState` Hook

## Problem

Currently, `getState` reads raw state from storage and returns it directly. There's no way for a task author to intercept, transform, or enrich the state before it reaches the external client.

Use cases:
- Compute derived fields (e.g. `progress` from `completedSteps / totalSteps`)
- Redact sensitive fields before returning to the client
- Merge state with external data sources
- Return a projection/view of the internal state

## Key Constraint

`recall()` inside handler code must **not** trigger this hook. It only fires when the external client calls `getState()` via the DO fetch path.

## Design

### 1. Add `onClientGetState` to `TaskDefineConfig` and `TaskDefinition`

The hook is optional. It receives a `TaskContext<S>` (so it can call `recall()`, `nextAlarm()`, etc.) and the current raw state (`S | null`). It returns `S | null` — same shape, optionally transformed.

It gets its own error type parameter `GErr` following the existing pattern where each handler has an independent error type (`EErr`, `AErr`, `OErr`).

```typescript
// TaskDefinition.ts

export interface TaskDefineConfig<S, E, EErr, AErr, R, OErr = never, GErr = never> {
  readonly state: PureSchema<S>
  readonly event: PureSchema<E>
  readonly onEvent: (ctx: TaskContext<S>, event: E) => Effect.Effect<void, EErr, R>
  readonly onAlarm: (ctx: TaskContext<S>) => Effect.Effect<void, AErr, R>
  readonly onError?: (ctx: TaskContext<S>, error: unknown) => Effect.Effect<void, OErr, R>
  readonly onClientGetState?: (ctx: TaskContext<S>, state: S | null) => Effect.Effect<S | null, GErr, R>
}

export interface TaskDefinition<S, E, Err, R> {
  readonly _tag: "TaskDefinition"
  readonly state: PureSchema<S>
  readonly event: PureSchema<E>
  readonly onEvent: (ctx: TaskContext<S>, event: E) => Effect.Effect<void, Err, R>
  readonly onAlarm: (ctx: TaskContext<S>) => Effect.Effect<void, Err, R>
  readonly onError?: (ctx: TaskContext<S>, error: unknown) => Effect.Effect<void, Err, R>
  readonly onClientGetState?: (ctx: TaskContext<S>, state: S | null) => Effect.Effect<S | null, Err, R>
}
```

The error union in `Task.define()` becomes `EErr | AErr | OErr | GErr`.

### 2. Update `Task.define()`

```typescript
// Task.ts

export const Task = {
  define<S, E, EErr, AErr, R, OErr = never, GErr = never>(
    config: TaskDefineConfig<S, E, EErr, AErr, R, OErr, GErr>,
  ): TaskDefinition<S, E, EErr | AErr | OErr | GErr, R> {
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

### 3. Update `withServices`

Follow the same pattern as `onError` — wrap with `Effect.provide` if present, otherwise `undefined`:

```typescript
// TaskDefinition.ts

export function withServices<S, E, Err, R>(
  definition: TaskDefinition<S, E, Err, R>,
  layer: Layer.Layer<R>,
): TaskDefinition<S, E, Err, never> {
  return {
    _tag: "TaskDefinition",
    state: definition.state,
    event: definition.event,
    onEvent: (ctx, event) => Effect.provide(definition.onEvent(ctx, event), layer),
    onAlarm: (ctx) => Effect.provide(definition.onAlarm(ctx), layer),
    onError: definition.onError
      ? (ctx, error) => Effect.provide(definition.onError!(ctx, error), layer)
      : undefined,
    onClientGetState: definition.onClientGetState
      ? (ctx, state) => Effect.provide(definition.onClientGetState!(ctx, state), layer)
      : undefined,
  }
}
```

### 4. Update `RegisteredTask` and `buildRegisteredTask`

Add a `handleGetState` closure to `RegisteredTask`:

```typescript
// TaskRegistry.ts

export interface RegisteredTask {
  readonly handleEvent: (
    storage: Storage["Service"],
    alarm: Alarm["Service"],
    id: string,
    name: string,
    event: unknown,
  ) => Effect.Effect<void, TaskValidationError | TaskExecutionError>
  readonly handleAlarm: (
    storage: Storage["Service"],
    alarm: Alarm["Service"],
    id: string,
    name: string,
  ) => Effect.Effect<void, TaskExecutionError>
  readonly handleGetState: (
    storage: Storage["Service"],
    alarm: Alarm["Service"],
    id: string,
    name: string,
  ) => Effect.Effect<unknown, TaskExecutionError>
}
```

In `buildRegisteredTask`:

```typescript
const handleGetState = (
  storage: Storage["Service"],
  alarm: Alarm["Service"],
  id: string,
  name: string,
): Effect.Effect<unknown, TaskExecutionError> =>
  Effect.gen(function* () {
    const ctx = buildTaskContext(storage, alarm, id, name, decodeState, encodeState)
    const raw = yield* ctx.recall().pipe(
      Effect.mapError((e) => new TaskExecutionError({ cause: e })),
    )

    // If no hook, return raw state
    if (!definition.onClientGetState) return raw

    const result = yield* definition.onClientGetState(ctx, raw).pipe(
      Effect.mapError((e) => new TaskExecutionError({ cause: e })),
    )

    // Encode back through the state schema for safe serialization
    if (result === null) return null
    return yield* encodeState(result).pipe(
      Effect.mapError((e) => new TaskExecutionError({ cause: e })),
    )
  })
```

Key points:
- Uses `ctx.recall()` internally (which does NOT re-trigger the hook — it's a direct storage read)
- If no hook is defined, returns the decoded state directly
- If hook is defined, passes decoded state to it, then re-encodes the result for serialization
- All errors become `TaskExecutionError`

### 5. Update `TaskRunner` service

Add `handleGetState` to the runner interface:

```typescript
// services/TaskRunner.ts

export class TaskRunner extends ServiceMap.Service<TaskRunner, {
  readonly handleEvent: (
    name: string, id: string, event: unknown,
  ) => Effect.Effect<void, TaskNotFoundError | TaskValidationError | TaskExecutionError>
  readonly handleAlarm: (
    name: string, id: string,
  ) => Effect.Effect<void, TaskNotFoundError | TaskExecutionError>
  readonly handleGetState: (
    name: string, id: string,
  ) => Effect.Effect<unknown, TaskNotFoundError | TaskExecutionError>
}>()("@task/Runner") {}
```

### 6. Update `TaskRunnerLive`

```typescript
// live/TaskRunnerLive.ts

handleGetState: (name, id) =>
  Effect.gen(function* () {
    const task = registry.get(name)
    if (task === undefined) {
      return yield* Effect.fail(new TaskNotFoundError({ name }))
    }
    return yield* task.handleGetState(storage, alarm, id, name)
  }),
```

### 7. Update `TaskEngine` fetch handler (server side)

Replace the current raw storage read with a call through the runner:

```typescript
// cloudflare/TaskEngine.ts

if (body.type === "state") {
  const result = await runWithRunner((runner) =>
    runner.handleGetState(taskName, taskId),
  )
  return new Response(JSON.stringify({ state: result ?? null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
```

This is the only server-side change — the hook is invoked through the existing runner pipeline.

### 8. Client side — no changes needed

The `TaskHandle.getState()` signature and implementation stay the same. The hook is transparent to the client — it just receives the (possibly transformed) state.

## Data Flow

```
Client                         DO (TaskEngine)               TaskRunner
  |                               |                              |
  |-- POST {type:"state"} ------->|                              |
  |                               |-- runner.handleGetState() -->|
  |                               |                              |-- registry.get(name)
  |                               |                              |-- task.handleGetState(storage, alarm, id, name)
  |                               |                              |     |
  |                               |                              |     |-- ctx.recall()  [raw storage read]
  |                               |                              |     |-- definition.onClientGetState(ctx, state)  [if defined]
  |                               |                              |     |-- encodeState(result)
  |                               |                              |     |
  |                               |<-- encoded state ------------|
  |<-- { state: ... } ------------|
```

When no hook is defined, the flow short-circuits after `ctx.recall()` and returns the raw state — same behavior as today.

## Example Usage

```typescript
const counter = Task.define({
  state: CounterState,
  event: StartEvent,

  onEvent: (ctx, _event) =>
    Effect.gen(function* () {
      yield* ctx.save({ count: 0, secret: "internal-token" })
      yield* ctx.scheduleIn("2 seconds")
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const current = yield* ctx.recall()
      // recall() returns full state — no hook involved
      yield* ctx.save({ ...current!, count: current!.count + 1 })
    }),

  // Only runs when external client calls getState()
  onClientGetState: (ctx, state) =>
    Effect.gen(function* () {
      if (state === null) return null
      // Redact sensitive fields, add computed fields
      return { ...state, secret: "[redacted]" }
    }),
})
```

## Files Changed

| File | Change |
|------|--------|
| `TaskDefinition.ts` | Add `onClientGetState` to `TaskDefineConfig` and `TaskDefinition`, add `GErr` type param |
| `Task.ts` | Pass through `onClientGetState`, include `GErr` in error union |
| `services/TaskRunner.ts` | Add `handleGetState` to service interface |
| `services/TaskRegistry.ts` | Add `handleGetState` to `RegisteredTask`, implement in `buildRegisteredTask` |
| `live/TaskRunnerLive.ts` | Add `handleGetState` delegation |
| `cloudflare/TaskEngine.ts` | Route `"state"` message through runner instead of raw storage read |

No changes needed in:
- `cloudflare/createTasks.ts` (client `TaskHandle` unchanged)
- `TaskContext.ts` (`recall()` unchanged)
- `errors.ts` (reuses existing `TaskExecutionError`)
