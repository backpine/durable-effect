# Report 054: Continuous Job - Replace `stop` with `terminate` API

## Summary

Replace the Continuous job's `stop` client method with `terminate` that fully cleans up state, allowing the same instance ID to be restarted fresh.

---

## Current Behavior

### Client `stop` Method

```typescript
client.continuous("heartbeat").stop(id, { reason: "User stopped" });
```

**What it does** (`handleStop` in handler.ts:218-247):
1. Cancels the alarm
2. Updates metadata status to `"stopped"`
3. **Does NOT delete state** - all data persists

**Problem**: After `stop`, calling `start` with the same ID returns:
```typescript
{ created: false, status: "stopped" }
```
The instance can't be "restarted" fresh because metadata still exists.

### Internal `ctx.terminate()`

```typescript
// Inside execute handler
yield* ctx.terminate({ reason: "Done", purgeState: true });
```

**What it does** (via `TerminateSignal` + `JobExecutionService`):
1. Throws `TerminateSignal`
2. If `purgeState: true` (default): calls `storage.deleteAll()` - removes ALL data
3. If `purgeState: false`: updates status to `"stopped"` but keeps state
4. Alarm is cancelled in the handler

**This is the behavior we want externally.**

---

## Proposed Change

### Remove `stop`, Add `terminate`

**Client API Change:**

```typescript
// Before
client.continuous("heartbeat").stop(id, { reason?: string });

// After
client.continuous("heartbeat").terminate(id, { reason?: string });
```

**Behavior:**
1. Cancel the alarm
2. Delete ALL storage (`storage.deleteAll()`)
3. Return `{ terminated: true }`

After `terminate`, calling `start` with the same ID creates a fresh instance.

---

## Implementation Plan

### 1. Update Client Types (`src/client/types.ts`)

```typescript
// Before
export interface ContinuousClient<S> {
  start(...): Effect<ContinuousStartResponse, ClientError>;
  stop(id, options?): Effect<ContinuousStopResponse, ClientError>;  // Remove
  trigger(id): Effect<ContinuousTriggerResponse, ClientError>;
  status(id): Effect<ContinuousStatusResponse, ClientError>;
  getState(id): Effect<ContinuousGetStateResponse, ClientError>;
}

// After
export interface ContinuousClient<S> {
  start(...): Effect<ContinuousStartResponse, ClientError>;
  terminate(id, options?): Effect<ContinuousTerminateResponse, ClientError>;  // New
  trigger(id): Effect<ContinuousTriggerResponse, ClientError>;
  status(id): Effect<ContinuousStatusResponse, ClientError>;
  getState(id): Effect<ContinuousGetStateResponse, ClientError>;
}
```

### 2. Update Runtime Types (`src/runtime/types.ts`)

```typescript
// Remove
export interface ContinuousStopResponse {
  readonly _type: "continuous.stop";
  readonly stopped: boolean;
  readonly reason?: string;
}

// Add
export interface ContinuousTerminateResponse {
  readonly _type: "continuous.terminate";
  readonly terminated: boolean;
  readonly reason?: string;
}

// Update ContinuousRequest
export interface ContinuousRequest {
  readonly _type: "continuous";
  readonly name: string;
  readonly action: "start" | "terminate" | "trigger" | "status" | "getState";  // Changed
  readonly input?: unknown;
  readonly reason?: string;
}
```

### 3. Update Handler (`src/handlers/continuous/handler.ts`)

Replace `handleStop` with `handleTerminate`:

```typescript
const handleTerminate = (
  request: ContinuousRequest,
): Effect.Effect<ContinuousResponse, HandlerError> =>
  Effect.gen(function* () {
    const existing = yield* metadata.get();
    if (!existing) {
      return {
        _type: "continuous.terminate" as const,
        terminated: false,
        reason: "not_found",
      };
    }

    // Cancel alarm
    yield* alarm.cancel();

    // Delete ALL storage (state, metadata, run count, etc.)
    yield* storage.deleteAll();

    return {
      _type: "continuous.terminate" as const,
      terminated: true,
      reason: request.reason,
    };
  });
```

Update the `handle` switch:

```typescript
switch (request.action) {
  case "start":
    return yield* handleStart(def, request);
  case "terminate":  // Changed from "stop"
    return yield* handleTerminate(request);
  case "trigger":
    return yield* handleTrigger(def);
  // ...
}
```

### 4. Update Client Implementation (`src/client/client.ts`)

```typescript
// Before
stop: (id, options) => {
  return makeRequest({
    _type: "continuous",
    name,
    action: "stop",
    reason: options?.reason,
  }).pipe(/* ... */);
},

// After
terminate: (id, options) => {
  return makeRequest({
    _type: "continuous",
    name,
    action: "terminate",
    reason: options?.reason,
  }).pipe(/* ... */);
},
```

### 5. Update Response Mapping (`src/client/response.ts`)

```typescript
// Remove
"continuous.stop": ContinuousStopResponse;

// Add
"continuous.terminate": ContinuousTerminateResponse;
```

---

## API Comparison

| Operation | Old `stop` | New `terminate` |
|-----------|-----------|-----------------|
| Cancel alarm | ✓ | ✓ |
| Delete state | ✗ | ✓ |
| Delete metadata | ✗ | ✓ |
| Delete run count | ✗ | ✓ |
| Can restart same ID | ✗ (returns existing) | ✓ (fresh start) |

---

## Migration Notes

### Breaking Change

This is a **breaking change** for users of `stop`:

```typescript
// Before
await client.continuous("job").stop("id-123");

// After
await client.continuous("job").terminate("id-123");
```

### Behavioral Change

- **Before**: `stop` pauses the job but keeps state. Starting with same ID returns existing job.
- **After**: `terminate` fully removes the job. Starting with same ID creates fresh instance.

### If "Pause/Resume" Is Needed Later

If users need pause/resume functionality (stop without deleting state), we can add:

```typescript
client.continuous("job").pause(id);   // Stop alarm, keep state, status="paused"
client.continuous("job").resume(id);  // Resume from paused state
```

But this is a separate feature and should be designed carefully (what happens if `start` is called on a paused job?).

---

## Files to Modify

1. `packages/jobs/src/client/types.ts` - Update `ContinuousClient` interface
2. `packages/jobs/src/runtime/types.ts` - Replace `ContinuousStopResponse` with `ContinuousTerminateResponse`
3. `packages/jobs/src/handlers/continuous/handler.ts` - Replace `handleStop` with `handleTerminate`
4. `packages/jobs/src/handlers/continuous/types.ts` - Update response type union
5. `packages/jobs/src/client/client.ts` - Replace `stop` with `terminate`
6. `packages/jobs/src/client/response.ts` - Update response mapping
7. `examples/effect-worker-v2/src/routes/jobs/continuous.ts` - Update API endpoint
8. `examples/effect-worker-v2/src/routes/ui.ts` - Update UI button

---

## Summary

| Aspect | Current | Proposed |
|--------|---------|----------|
| Method name | `stop` | `terminate` |
| Alarm | Cancelled | Cancelled |
| State | Preserved | Deleted |
| Metadata | Preserved (status=stopped) | Deleted |
| Restart same ID | Returns existing | Creates fresh |
| Aligns with internal `ctx.terminate()` | No | Yes |
