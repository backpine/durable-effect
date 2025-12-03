# Unifying Workflow Status and Event Emission

## Observation

In `engine.ts`, every `setWorkflowStatus` call is immediately followed by a corresponding `emitEvent` call. The pattern is consistent:

```typescript
// Pattern 1: Start workflow
yield* setWorkflowStatus(storage, { _tag: "Running" });
yield* emitEvent({ ...createBaseEvent(...), type: "workflow.started", input });

// Pattern 2: Resume workflow
yield* setWorkflowStatus(storage, { _tag: "Running" });
yield* emitEvent({ ...createBaseEvent(...), type: "workflow.resumed" });

// Pattern 3: Complete workflow
yield* setWorkflowStatus(storage, { _tag: "Completed", completedAt: Date.now() });
yield* emitEvent({ ...createBaseEvent(...), type: "workflow.completed", completedSteps, durationMs });

// Pattern 4: Pause workflow
yield* setWorkflowStatus(storage, { _tag: "Paused", reason, resumeAt });
yield* emitEvent({ ...createBaseEvent(...), type: "workflow.paused", reason, resumeAt, stepName });

// Pattern 5: Fail workflow
yield* setWorkflowStatus(storage, { _tag: "Failed", error, failedAt: Date.now() });
yield* emitEvent({ ...createBaseEvent(...), type: "workflow.failed", error: {...}, completedSteps });
```

## Problem

1. **Duplication**: Status and event carry overlapping information (reason, resumeAt, error, etc.)
2. **Coupling risk**: Forgetting to emit after status change breaks observability
3. **Scattered logic**: The relationship between status and event is implicit

## Proposed Solution: Workflow Transitions

Create a `WorkflowTransition` discriminated union that captures the semantic action, then derive both status and event from it.

### Type Definition

```typescript
// packages/workflow/src/transitions.ts

import type { InternalWorkflowEvent } from "@durable-effect/core";

/**
 * Represents a workflow state transition.
 * Each transition maps to both a status update and an event emission.
 */
export type WorkflowTransition =
  | { readonly _tag: "Start"; readonly input: unknown }
  | { readonly _tag: "Resume" }
  | {
      readonly _tag: "Complete";
      readonly completedSteps: ReadonlyArray<string>;
      readonly durationMs: number;
    }
  | {
      readonly _tag: "Pause";
      readonly reason: string;
      readonly resumeAt?: number;
      readonly stepName?: string;
    }
  | {
      readonly _tag: "Fail";
      readonly error: {
        readonly message: string;
        readonly stack?: string;
        readonly stepName?: string;
        readonly attempt?: number;
      };
      readonly completedSteps: ReadonlyArray<string>;
    };
```

### Transition Function

```typescript
import { Effect } from "effect";
import { createBaseEvent } from "@durable-effect/core";
import { setWorkflowStatus } from "@/services/workflow-context";
import { emitEvent } from "@/tracker";
import type { WorkflowStatus } from "@/types";

/**
 * Execute a workflow transition: update status AND emit event atomically.
 *
 * This ensures status and events are always in sync.
 */
export const transition = (
  storage: DurableObjectStorage,
  workflowId: string,
  workflowName: string,
  t: WorkflowTransition,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const base = createBaseEvent(workflowId, workflowName);
    const now = Date.now();

    switch (t._tag) {
      case "Start":
        yield* setWorkflowStatus(storage, { _tag: "Running" });
        yield* emitEvent({ ...base, type: "workflow.started", input: t.input });
        break;

      case "Resume":
        yield* setWorkflowStatus(storage, { _tag: "Running" });
        yield* emitEvent({ ...base, type: "workflow.resumed" });
        break;

      case "Complete":
        yield* setWorkflowStatus(storage, { _tag: "Completed", completedAt: now });
        yield* emitEvent({
          ...base,
          type: "workflow.completed",
          completedSteps: t.completedSteps,
          durationMs: t.durationMs,
        });
        break;

      case "Pause":
        yield* setWorkflowStatus(storage, {
          _tag: "Paused",
          reason: t.reason,
          resumeAt: t.resumeAt,
        });
        yield* emitEvent({
          ...base,
          type: "workflow.paused",
          reason: t.reason,
          resumeAt: t.resumeAt ? new Date(t.resumeAt).toISOString() : undefined,
          stepName: t.stepName,
        });
        break;

      case "Fail":
        yield* setWorkflowStatus(storage, {
          _tag: "Failed",
          error: t.error,
          failedAt: now,
        });
        yield* emitEvent({
          ...base,
          type: "workflow.failed",
          error: t.error,
          completedSteps: t.completedSteps,
        });
        break;
    }
  });
```

### Usage in engine.ts

**Before:**
```typescript
// In run()
yield* setWorkflowStatus(storage, { _tag: "Running" });
yield* emitEvent({
  ...createBaseEvent(workflowId, String(workflowName)),
  type: "workflow.started",
  input,
});
```

**After:**
```typescript
// In run()
yield* transition(storage, workflowId, workflowName, {
  _tag: "Start",
  input
});
```

**Before (handleWorkflowResult):**
```typescript
if (Exit.isSuccess(result)) {
  const completedSteps = yield* getCompletedStepsFromStorage(storage);
  yield* setWorkflowStatus(storage, { _tag: "Completed", completedAt: Date.now() });
  yield* emitEvent({
    ...createBaseEvent(workflowId, workflowName),
    type: "workflow.completed",
    completedSteps,
    durationMs: Date.now() - startTime,
  });
}
```

**After:**
```typescript
if (Exit.isSuccess(result)) {
  const completedSteps = yield* getCompletedStepsFromStorage(storage);
  yield* transition(storage, workflowId, workflowName, {
    _tag: "Complete",
    completedSteps,
    durationMs: Date.now() - startTime,
  });
}
```

## Benefits

1. **Single source of truth**: Transition type defines what happens
2. **Impossible to forget events**: Status and event are coupled by design
3. **Type safety**: Compiler ensures all required data is provided
4. **Cleaner engine.ts**: `handleWorkflowResult` becomes much simpler
5. **Testable**: Can unit test `transition` function in isolation
6. **Extensible**: Adding new transitions (e.g., "Cancel") is straightforward

## File Structure

```
packages/workflow/src/
├── transitions.ts       # WorkflowTransition type + transition function
├── engine.ts            # Uses transition() instead of manual status/event
└── ...
```

## Migration Impact

- **engine.ts**: Simplifies significantly (~30 fewer lines)
- **handleWorkflowResult**: Reduces to pattern matching on Exit and calling transition
- **Tests**: Existing tests continue to work (behavior unchanged)

## Alternative Considered: Keep Separate

We could keep `setWorkflowStatus` and `emitEvent` separate but document the coupling. However:
- Documentation doesn't prevent bugs
- The coupling is semantic, not accidental
- Unifying makes the code express intent more clearly

## Recommendation

Implement the `WorkflowTransition` pattern. It:
1. Eliminates a class of bugs (forgotten events)
2. Makes the code more declarative
3. Centralizes the status↔event mapping
4. Reduces engine.ts complexity
