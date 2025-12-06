# Report 030: Storage Transient Error Retry

## Problem

Storage operations (`storage.get()`, `storage.put()`, `storage.delete()`) can fail transiently due to:
- Network issues between Worker and Durable Object
- Durable Object migration/relocation
- Temporary Cloudflare infrastructure hiccups

Currently, any storage failure immediately crashes the workflow with `UnknownException`:

```typescript
// step-context.ts:112-116
setMeta: <T>(key: string, value: T) =>
  Effect.tryPromise({
    try: () => storage.put(stepKey(stepName, `meta:${key}`), value),
    catch: (e) => new UnknownException(e),  // No retry!
  }),
```

A transient error causes permanent workflow failure when a simple retry would succeed.

## Goal

Add automatic retry with exponential backoff for transient storage errors without changing the public API.

## Design Decisions

### 1. Retry Policy

```typescript
// Conservative policy for storage operations
const STORAGE_RETRY_POLICY = {
  maxRetries: 3,
  initialDelay: 50,    // 50ms
  maxDelay: 500,       // 500ms cap
  factor: 2,           // Exponential: 50ms → 100ms → 200ms
};
```

**Rationale:**
- 3 retries covers most transient issues
- 50ms initial delay is fast enough to not block
- 500ms cap prevents runaway delays
- Total max delay: ~350ms (50 + 100 + 200)

### 2. Error Classification

Not all storage errors should be retried:

| Error Type | Retry? | Example |
|------------|--------|---------|
| Network timeout | Yes | `NetworkError` |
| Connection reset | Yes | `ECONNRESET` |
| Service unavailable | Yes | HTTP 503 |
| DataCloneError | No | Non-serializable value |
| QuotaExceededError | No | Storage full |
| Invalid key | No | Programmer error |

### 3. New Error Type

Create `StorageError` to wrap storage failures with context:

```typescript
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: "get" | "put" | "delete" | "deleteAll";
  readonly key: string | undefined;
  readonly cause: unknown;
  readonly retriesAttempted: number;
}> {}
```

### 4. Shared Retry Utility

Create a single utility used by all storage operations:

```typescript
// packages/workflow/src/services/storage-utils.ts

import { Effect, Schedule, Duration } from "effect";
import { StorageError } from "@/errors";

const retrySchedule = Schedule.exponential(Duration.millis(50), 2).pipe(
  Schedule.intersect(Schedule.recurs(3)),
  Schedule.upTo(Duration.millis(500)),
);

/**
 * Check if an error is retryable.
 */
function isRetryableStorageError(error: unknown): boolean {
  // DataCloneError - not retryable (serialization issue)
  if (error instanceof DOMException && error.name === "DataCloneError") {
    return false;
  }

  // QuotaExceededError - not retryable (storage full)
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return false;
  }

  // Network and transient errors - retryable
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("econnreset") ||
      message.includes("unavailable") ||
      message.includes("connection")
    ) {
      return true;
    }
  }

  // Default: retry unknown errors (conservative)
  return true;
}

/**
 * Execute a storage operation with retry.
 */
export function withStorageRetry<T>(
  operation: "get" | "put" | "delete" | "deleteAll",
  key: string | undefined,
  fn: () => Promise<T>,
): Effect.Effect<T, StorageError> {
  let retriesAttempted = 0;

  return Effect.tryPromise({
    try: fn,
    catch: (e) => new StorageError({ operation, key, cause: e, retriesAttempted }),
  }).pipe(
    Effect.retry(
      retrySchedule.pipe(
        Schedule.whileInput((error: StorageError) => {
          if (!isRetryableStorageError(error.cause)) {
            return false;
          }
          retriesAttempted++;
          return true;
        }),
      ),
    ),
    Effect.mapError(
      (e) => new StorageError({ operation, key, cause: e.cause, retriesAttempted }),
    ),
  );
}

/**
 * Storage get with retry.
 */
export function storageGet<T>(
  storage: DurableObjectStorage,
  key: string,
): Effect.Effect<T | undefined, StorageError> {
  return withStorageRetry("get", key, () => storage.get<T>(key));
}

/**
 * Storage put with retry.
 */
export function storagePut<T>(
  storage: DurableObjectStorage,
  key: string,
  value: T,
): Effect.Effect<void, StorageError> {
  return withStorageRetry("put", key, () => storage.put(key, value));
}

/**
 * Storage put batch with retry.
 */
export function storagePutBatch(
  storage: DurableObjectStorage,
  entries: Record<string, unknown>,
): Effect.Effect<void, StorageError> {
  return withStorageRetry("put", undefined, () => storage.put(entries));
}

/**
 * Storage delete with retry.
 */
export function storageDelete(
  storage: DurableObjectStorage,
  key: string,
): Effect.Effect<boolean, StorageError> {
  return withStorageRetry("delete", key, () => storage.delete(key));
}

/**
 * Storage deleteAll with retry.
 */
export function storageDeleteAll(
  storage: DurableObjectStorage,
): Effect.Effect<void, StorageError> {
  return withStorageRetry("deleteAll", undefined, () => storage.deleteAll());
}
```

## Implementation Plan

### 1. Add StorageError to errors.ts

```typescript
// packages/workflow/src/errors.ts

/**
 * A storage operation failed after retries.
 */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: "get" | "put" | "delete" | "deleteAll";
  readonly key: string | undefined;
  readonly cause: unknown;
  readonly retriesAttempted: number;
}> {
  get message(): string {
    const keyPart = this.key ? ` for key "${this.key}"` : "";
    const retryPart =
      this.retriesAttempted > 0
        ? ` after ${this.retriesAttempted} retries`
        : "";
    return `Storage ${this.operation}${keyPart} failed${retryPart}`;
  }
}
```

### 2. Create storage-utils.ts

Create `packages/workflow/src/services/storage-utils.ts` with the utility functions shown above.

### 3. Update step-context.ts

Replace direct `Effect.tryPromise` calls with retry utilities:

```diff
// packages/workflow/src/services/step-context.ts

+import { storageGet, storagePut } from "./storage-utils";

 export function createStepContext(
   stepName: string,
   storage: DurableObjectStorage,
   attempt: number,
 ): StepContextService {
   return {
     stepName,
     attempt,

     getMeta: <T>(key: string) =>
-      Effect.tryPromise({
-        try: () => storage.get<T>(stepKey(stepName, `meta:${key}`)),
-        catch: (e) => new UnknownException(e),
-      }).pipe(
+      storageGet<T>(storage, stepKey(stepName, `meta:${key}`)).pipe(
         Effect.map((value) =>
           value !== undefined ? Option.some(value) : Option.none<T>(),
         ),
+        Effect.mapError((e) => new UnknownException(e)),
       ),

     setMeta: <T>(key: string, value: T) =>
-      Effect.tryPromise({
-        try: () => storage.put(stepKey(stepName, `meta:${key}`), value),
-        catch: (e) => new UnknownException(e),
-      }),
+      storagePut(storage, stepKey(stepName, `meta:${key}`), value).pipe(
+        Effect.mapError((e) => new UnknownException(e)),
+      ),

     // ... apply same pattern to all storage operations
   };
 }
```

### 4. Update workflow-context.ts

Apply the same pattern:

```diff
// packages/workflow/src/services/workflow-context.ts

+import { storageGet, storagePut, storagePutBatch, storageDelete } from "./storage-utils";

 getMeta: <T>(key: string) =>
-  Effect.tryPromise({
-    try: () => storage.get<T>(workflowKey(`meta:${key}`)),
-    catch: (e) => new UnknownException(e),
-  }).pipe(
+  storageGet<T>(storage, workflowKey(`meta:${key}`)).pipe(
     Effect.map((value) =>
       value !== undefined ? Option.some(value) : Option.none<T>(),
     ),
+    Effect.mapError((e) => new UnknownException(e)),
   ),

 // ... apply to all operations
```

### 5. Update engine.ts

Update `storage.deleteAll()` calls:

```diff
// packages/workflow/src/engine.ts

+import { storageDeleteAll } from "@/services/storage-utils";

 // In handleWorkflowResult
-yield* Effect.promise(() => storage.deleteAll());
+yield* storageDeleteAll(storage).pipe(
+  Effect.mapError((e) => new UnknownException(e)),
+);
```

### 6. Export StorageError

```typescript
// packages/workflow/src/index.ts
export { StepError, StepTimeoutError, StepSerializationError, StorageError } from "./errors";
```

## Files Changed

| File | Change |
|------|--------|
| `errors.ts` | Add `StorageError` class |
| `services/storage-utils.ts` | **New file** - retry utilities |
| `services/step-context.ts` | Use storage utilities |
| `services/workflow-context.ts` | Use storage utilities |
| `engine.ts` | Use `storageDeleteAll` |
| `services/index.ts` | Export storage utilities |
| `index.ts` | Export `StorageError` |

## Test Cases

### 1. Retry on Transient Error

```typescript
it("retries on transient network error", async () => {
  let attempts = 0;
  const mockStorage = {
    put: async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("NetworkError: connection reset");
      }
    },
  } as unknown as DurableObjectStorage;

  const result = await Effect.runPromise(
    storagePut(mockStorage, "test:key", "value"),
  );

  expect(attempts).toBe(3);
  expect(result).toBeUndefined(); // void success
});
```

### 2. No Retry on DataCloneError

```typescript
it("does not retry DataCloneError", async () => {
  let attempts = 0;
  const mockStorage = {
    put: async () => {
      attempts++;
      const error = new DOMException("Could not clone", "DataCloneError");
      throw error;
    },
  } as unknown as DurableObjectStorage;

  await expect(
    Effect.runPromise(storagePut(mockStorage, "test:key", () => {})),
  ).rejects.toThrow();

  expect(attempts).toBe(1); // No retry
});
```

### 3. Exhausted Retries

```typescript
it("fails after max retries", async () => {
  let attempts = 0;
  const mockStorage = {
    put: async () => {
      attempts++;
      throw new Error("NetworkError: timeout");
    },
  } as unknown as DurableObjectStorage;

  const result = await Effect.runPromiseExit(
    storagePut(mockStorage, "test:key", "value"),
  );

  expect(Exit.isFailure(result)).toBe(true);
  expect(attempts).toBe(4); // 1 initial + 3 retries
});
```

### 4. Integration with Step

```typescript
it("step survives transient storage error", async () => {
  let storageAttempts = 0;
  const workflow = Workflow.make((_: void) =>
    Effect.gen(function* () {
      yield* Workflow.step(
        "test",
        Effect.succeed("result"),
      );
    }),
  );

  // Inject flaky storage that fails twice then succeeds
  const harness = createWorkflowHarness(workflow, {
    storage: createFlakyStorage({ failuresBeforeSuccess: 2 }),
  });

  await harness.run(undefined);
  expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
});
```

## Observability

Add logging for retries (optional, can be controlled by config):

```typescript
Effect.retry(
  retrySchedule.pipe(
    Schedule.tapInput((error: StorageError) =>
      Effect.logWarning(`Storage ${error.operation} failed, retrying...`, {
        key: error.key,
        attempt: error.retriesAttempted + 1,
        error: error.cause,
      }),
    ),
  ),
)
```

## Rollback Strategy

If issues are discovered:

1. Storage utils wrap operations - can revert to direct calls
2. `StorageError` can be mapped to `UnknownException` for backward compatibility
3. Retry schedule can be adjusted or disabled via config

## Performance Impact

- **Best case**: No change (no retries needed)
- **Transient error case**: +50-350ms delay but workflow succeeds
- **Permanent error case**: +350ms delay before failure

The delay is acceptable because the alternative is workflow failure requiring manual intervention.
