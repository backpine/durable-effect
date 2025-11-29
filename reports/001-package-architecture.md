# Package Architecture Design

## Overview

This document outlines how to structure the durable-effect library into composable packages. The design prioritizes:

1. **Simplicity** - No premature abstractions; Cloudflare is the target platform
2. **Extensibility** - Easy to add new durable patterns (workflows, entities, queues, etc.)
3. **Composability** - Core primitives shared across patterns

---

## Proposed Package Structure

```
packages/
├── core/                      # @durable-effect/core
└── workflow/                  # @durable-effect/workflow
```

Future patterns would add packages like:
- `@durable-effect/entity` - Durable entity/actor pattern
- `@durable-effect/queue` - Durable queue pattern
- `@durable-effect/saga` - Saga/compensation pattern

---

## Package Details

### 1. `@durable-effect/core`

Shared primitives across all durable patterns. Cloudflare-specific but pattern-agnostic.

```
packages/core/src/
├── errors.ts           # Base error types
├── types.ts            # Shared types (storage helpers, etc.)
└── index.ts
```

#### `errors.ts` - Base Errors

```typescript
/**
 * Base class for all durable-effect errors.
 */
export abstract class DurableEffectError extends Error {
  abstract readonly _tag: string;
}

/**
 * Signals that execution should pause and resume later (via alarm).
 */
export class ExecutionPaused extends DurableEffectError {
  readonly _tag = "ExecutionPaused";
  constructor(
    readonly reason: string,
    readonly resumeAt?: number
  ) {
    super(`Execution paused: ${reason}`);
  }
}
```

#### `types.ts` - Shared Types

```typescript
import { Effect } from "effect";
import { UnknownException } from "effect/Cause";

/**
 * Effectful wrapper around DurableObjectStorage.
 * Shared utility for all patterns.
 */
export const storageGet = <T>(storage: DurableObjectStorage, key: string) =>
  Effect.tryPromise(() => storage.get<T>(key));

export const storagePut = <T>(storage: DurableObjectStorage, key: string, value: T) =>
  Effect.tryPromise(() => storage.put(key, value));

export const storageDelete = (storage: DurableObjectStorage, key: string) =>
  Effect.tryPromise(() => storage.delete(key));
```

#### Dependencies
- `effect` (peer)
- `@cloudflare/workers-types` (peer)

---

### 2. `@durable-effect/workflow`

The workflow pattern - steps with caching, retry, timeout, and the DO engine.

```
packages/workflow/src/
├── services.ts         # DurableExecutionService, StepExecutionContext
├── step.ts             # step() function
├── operators/
│   ├── retry.ts        # durableRetry
│   ├── timeout.ts      # durableTimeout
│   └── index.ts
├── errors.ts           # RetryScheduled, StepTimeoutError
├── engine.ts           # createDurableWorkflows() factory
├── types.ts            # WorkflowDefinition
└── index.ts
```

#### `services.ts` - Effect Services

```typescript
import { Context, Effect } from "effect";
import { UnknownException } from "effect/Cause";

/**
 * Workflow execution context - provided once per workflow run.
 */
export class DurableExecutionService extends Context.Tag("DurableExecutionService")<
  DurableExecutionService,
  {
    readonly storage: DurableObjectStorage;
    readonly setAlarm: (time: number) => Effect.Effect<void, UnknownException>;
    readonly workflowId: string;
  }
>() {}

/**
 * Step execution context - provided fresh for each step.
 */
export class StepExecutionContext extends Context.Tag("StepExecutionContext")<
  StepExecutionContext,
  {
    readonly stepName: string;
    readonly attempt: number;
    readonly getMeta: <T>(key: string) => Effect.Effect<T | undefined, UnknownException>;
    readonly setMeta: <T>(key: string, value: T) => Effect.Effect<void, UnknownException>;
    readonly deleteMeta: (key: string) => Effect.Effect<void, UnknownException>;
  }
>() {}
```

#### `step.ts` - Step Function

```typescript
export function step<T, E, R>(
  name: string,
  handler: Effect.Effect<T, E, R>
): Effect.Effect<
  T,
  E | UnknownException,
  Exclude<R, StepExecutionContext> | DurableExecutionService
>
```

#### `operators/retry.ts`

```typescript
export interface RetryOptions {
  readonly maxAttempts: number;
  readonly delayMs?: number;
}

export const durableRetry = <T, E>(options: RetryOptions) =>
  <R>(effect: Effect.Effect<T, E, R>): Effect.Effect<
    T,
    E,
    R | StepExecutionContext | DurableExecutionService
  >
```

#### `operators/timeout.ts`

```typescript
export const durableTimeout = <T, E>(durationMs: number) =>
  <R>(effect: Effect.Effect<T, E, R>): Effect.Effect<
    T,
    E | StepTimeoutError,
    R | StepExecutionContext
  >
```

#### `errors.ts` - Workflow Errors

```typescript
import { ExecutionPaused } from "@durable-effect/core";

/**
 * Signal that a retry has been scheduled.
 */
export class RetryScheduled extends ExecutionPaused {
  readonly _tag = "RetryScheduled";
  constructor(
    readonly stepName: string,
    readonly nextAttempt: number
  ) {
    super(`Retry scheduled for step "${stepName}"`, Date.now());
  }
}

/**
 * Step exceeded its timeout.
 */
export class StepTimeoutError extends Error {
  readonly _tag = "StepTimeoutError";
  constructor(readonly stepName: string) {
    super(`Step "${stepName}" timed out`);
  }
}
```

#### `engine.ts` - Durable Object Factory

```typescript
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { ExecutionPaused } from "@durable-effect/core";
import { DurableExecutionService } from "./services";
import type { WorkflowDefinition } from "./types";

export function createDurableWorkflows<
  Env,
  T extends Record<string, WorkflowDefinition<any>>
>(workflows: T) {
  return class DurableWorkflowEngine extends DurableObject<Env> {
    // ... implementation
  };
}
```

#### `types.ts`

```typescript
import type { Effect } from "effect";
import type { DurableExecutionService } from "./services";

export type WorkflowDefinition<Input = void> = (
  input: Input
) => Effect.Effect<void, unknown, DurableExecutionService>;
```

#### Dependencies
- `@durable-effect/core` (dependency)
- `effect` (peer)
- `@cloudflare/workers-types` (peer)

---

## File Breakdown from Current Code

Mapping current `durable-workflow.ts` to new structure:

| Current Location | New Package | New File |
|-----------------|-------------|----------|
| `DurableExecutionService` | workflow | `services.ts` |
| `StepExecutionContext` | workflow | `services.ts` |
| `step()` | workflow | `step.ts` |
| `RetryScheduled` | workflow | `errors.ts` (extends core's `ExecutionPaused`) |
| `durableRetry()` | workflow | `operators/retry.ts` |
| `StepTimeoutError` | workflow | `errors.ts` |
| `durableTimeout()` | workflow | `operators/timeout.ts` |
| `WorkflowDefinition` | workflow | `types.ts` |
| `createDurableWorkflows()` | workflow | `engine.ts` |

---

## Dependency Graph

```
@durable-effect/workflow
         │
         ▼
@durable-effect/core
         │
         ▼
      effect
```

---

## Export Structure

### `@durable-effect/core`

```typescript
// Errors
export { DurableEffectError, ExecutionPaused } from "./errors";

// Utilities (if needed)
export { storageGet, storagePut, storageDelete } from "./types";
```

### `@durable-effect/workflow`

```typescript
// Services
export { DurableExecutionService, StepExecutionContext } from "./services";

// Step
export { step } from "./step";

// Operators
export { durableRetry, type RetryOptions } from "./operators/retry";
export { durableTimeout } from "./operators/timeout";
export * from "./operators";

// Errors
export { RetryScheduled, StepTimeoutError } from "./errors";

// Engine
export { createDurableWorkflows } from "./engine";

// Types
export type { WorkflowDefinition } from "./types";
```

---

## Usage Example (End User)

```typescript
import {
  createDurableWorkflows,
  step,
  durableRetry,
  durableTimeout
} from "@durable-effect/workflow";
import { Effect } from "effect";

export const MyWorkflows = createDurableWorkflows({
  processOrder: (orderId: string) =>
    Effect.gen(function* () {
      const order = yield* step("Fetch order", fetchOrder(orderId));

      yield* step(
        "Process payment",
        processPayment(order).pipe(
          durableRetry({ maxAttempts: 3, delayMs: 5000 })
        )
      );

      yield* step(
        "Send confirmation",
        sendEmail(order.email).pipe(
          durableTimeout(30_000),
          durableRetry({ maxAttempts: 2 })
        )
      );
    }),
});
```

---

## Future Extensibility

### Adding a New Pattern (e.g., Durable Entity)

```
packages/entity/src/
├── services.ts         # EntityContext
├── entity.ts           # createDurableEntity() factory
├── state.ts            # State management utilities
├── errors.ts           # Entity-specific errors
└── index.ts
```

The entity package would:
- Depend on `@durable-effect/core` for shared errors
- Define its own services and DO factory
- Share the same Cloudflare platform target

---

## Summary

| Package | Purpose | Key Exports |
|---------|---------|-------------|
| `core` | Shared errors & utilities | `ExecutionPaused`, storage helpers |
| `workflow` | Workflow pattern | `step`, `durableRetry`, `durableTimeout`, `createDurableWorkflows` |

This keeps things simple: two packages, Cloudflare-native, with room to grow.
