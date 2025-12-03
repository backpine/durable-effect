# Eliminating Type Casts with a No-Op Tracker Layer

## Problem

In `packages/workflow/src/engine.ts`, the `#withTracker` method has brittle type casts:

```typescript
#withTracker<A, E>(
  effect: Effect.Effect<A, E, EventTracker>,
): Effect.Effect<A, E, never> {
  if (this.#trackerLayer) {
    return effect.pipe(Effect.provide(this.#trackerLayer)) as Effect.Effect<
      A,
      E,
      never
    >;
  }
  // Without tracker, emitEvent is a no-op, so we can safely cast
  return effect as unknown as Effect.Effect<A, E, never>;
}
```

### Why the casts exist

1. **When tracker exists**: `Effect.provide(this.#trackerLayer)` returns a complex type that TypeScript can't verify fully satisfies `EventTracker` → requires `as Effect.Effect<A, E, never>`

2. **When tracker is undefined**: We're casting an effect that theoretically requires `EventTracker` to one that requires nothing → requires `as unknown as Effect.Effect<A, E, never>`

The second cast is particularly dangerous. It works only because `emitEvent` uses `Effect.serviceOption` internally, making it a silent no-op when the service is missing. But this safety is implicit and not enforced by types.

## Root Cause

The design mixes two concerns:
1. **Conditional layer provisioning** (runtime check for `this.#trackerLayer`)
2. **Type-level requirements** (effect requires `EventTracker`)

This creates a gap that type casts bridge unsafely.

## Solution: Always Provide a Tracker Layer

Instead of conditionally providing a tracker layer, **always provide one** - using a no-op implementation when tracking isn't configured.

### Implementation

**1. Add a no-op tracker to `service.ts`:**

```typescript
/**
 * No-op tracker implementation.
 * Used when tracking is disabled - all operations are silent no-ops.
 */
export const noopTracker: EventTrackerService = {
  emit: () => Effect.void,
  flush: Effect.void,
  pendingCount: Effect.succeed(0),
};

/**
 * Layer that provides the no-op tracker.
 * Use this when event tracking is disabled.
 */
export const NoopTrackerLayer: Layer.Layer<EventTracker> = Layer.succeed(
  EventTracker,
  noopTracker,
);
```

**2. Simplify `engine.ts`:**

```typescript
export function createDurableWorkflows<const T extends WorkflowRegistry>(
  workflows: T,
  options?: CreateDurableWorkflowsOptions,
): new (state: DurableObjectState, env: unknown) => DurableWorkflowInstance<T> {
  const trackerConfig = options?.tracker;

  // Always create a tracker layer - use no-op if not configured
  const trackerLayer: Layer.Layer<EventTracker> = trackerConfig
    ? Layer.scoped(EventTracker, createHttpBatchTracker(trackerConfig)).pipe(
        Layer.provide(FetchHttpClient.layer),
      )
    : NoopTrackerLayer;

  return class DurableWorkflowEngine
    extends DurableObject
    implements TypedWorkflowEngine<T>
  {
    readonly #workflows: T = workflows;

    // Always have a tracker layer (no more undefined)
    readonly #trackerLayer: Layer.Layer<EventTracker> = trackerLayer;

    // Method becomes trivial - no conditionals, no casts
    #withTracker<A, E>(
      effect: Effect.Effect<A, E, EventTracker>,
    ): Effect.Effect<A, E> {
      return effect.pipe(Effect.provide(this.#trackerLayer));
    }

    // ... rest of class
  };
}
```

### Before vs After

| Aspect | Before | After |
|--------|--------|-------|
| Type casts | 2 (`as Effect.Effect<...>`, `as unknown as...`) | 0 |
| Conditionals in `#withTracker` | `if (this.#trackerLayer)` | None |
| Layer type | `Layer<EventTracker> \| undefined` | `Layer<EventTracker>` |
| Return type | `Effect.Effect<A, E, never>` (cast) | `Effect.Effect<A, E>` (inferred) |
| Safety | Relies on implicit `serviceOption` behavior | Type-enforced at compile time |

### Why This Works

1. **Single code path**: Whether tracking is enabled or not, the same code executes. The difference is in what the layer provides.

2. **Type-safe by construction**: `Effect.provide(trackerLayer)` always satisfies the `EventTracker` requirement because `trackerLayer` always provides `EventTracker`.

3. **No behavioral change**: The no-op tracker does exactly what `serviceOption` fallback was doing - nothing. But now it's explicit and type-safe.

4. **Simpler mental model**: "Every workflow engine has a tracker. Some trackers send events, some don't."

### Full Diff

```diff
// packages/workflow/src/tracker/service.ts

+ /**
+  * No-op tracker implementation.
+  * Used when tracking is disabled - all operations are silent no-ops.
+  */
+ export const noopTracker: EventTrackerService = {
+   emit: () => Effect.void,
+   flush: Effect.void,
+   pendingCount: Effect.succeed(0),
+ };
+
+ /**
+  * Layer that provides the no-op tracker.
+  */
+ export const NoopTrackerLayer: Layer.Layer<EventTracker> = Layer.succeed(
+   EventTracker,
+   noopTracker,
+ );
```

```diff
// packages/workflow/src/engine.ts

  export function createDurableWorkflows<const T extends WorkflowRegistry>(
    workflows: T,
    options?: CreateDurableWorkflowsOptions,
  ): new (state: DurableObjectState, env: unknown) => DurableWorkflowInstance<T> {
    const trackerConfig = options?.tracker;

+   // Always create a tracker layer - use no-op if not configured
+   const trackerLayer: Layer.Layer<EventTracker> = trackerConfig
+     ? Layer.scoped(EventTracker, createHttpBatchTracker(trackerConfig)).pipe(
+         Layer.provide(FetchHttpClient.layer),
+       )
+     : NoopTrackerLayer;

    return class DurableWorkflowEngine
      extends DurableObject
      implements TypedWorkflowEngine<T>
    {
      readonly #workflows: T = workflows;

-     readonly #trackerLayer: Layer.Layer<EventTracker> | undefined =
-       trackerConfig
-         ? Layer.scoped(
-             EventTracker,
-             createHttpBatchTracker(trackerConfig),
-           ).pipe(Layer.provide(FetchHttpClient.layer))
-         : undefined;
+     readonly #trackerLayer: Layer.Layer<EventTracker> = trackerLayer;

-     #withTracker<A, E>(
-       effect: Effect.Effect<A, E, EventTracker>,
-     ): Effect.Effect<A, E, never> {
-       if (this.#trackerLayer) {
-         return effect.pipe(Effect.provide(this.#trackerLayer)) as Effect.Effect<
-           A,
-           E,
-           never
-         >;
-       }
-       return effect as unknown as Effect.Effect<A, E, never>;
-     }
+     #withTracker<A, E>(
+       effect: Effect.Effect<A, E, EventTracker>,
+     ): Effect.Effect<A, E> {
+       return effect.pipe(Effect.provide(this.#trackerLayer));
+     }

      // In #executeWorkflow, remove the conditional:
-     if (this.#trackerLayer) {
-       workflowEffect = workflowEffect.pipe(
-         Effect.provide(this.#trackerLayer),
-       );
-     }
+     workflowEffect = workflowEffect.pipe(
+       Effect.provide(this.#trackerLayer),
+     );

      // ... rest unchanged
    };
  }
```

## Recommendation

Implement the no-op tracker pattern. It:

1. **Eliminates all type casts** in `engine.ts`
2. **Removes conditional logic** from hot paths
3. **Makes the design explicit** - tracking is always "on", but may do nothing
4. **Follows Effect best practices** - services should always be provided, even if stubbed
5. **Simplifies testing** - can easily inject mock trackers
