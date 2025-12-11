# Report 045: Step Config-Only API Design

**Date**: 2024-12-11
**Package**: `@durable-effect/workflow`
**Scope**: Improve LSP autocomplete discoverability by making step config-only

---

## Problem Statement

The current `Workflow.step()` API has two overloads:

```typescript
// Overload 1: Simple step (name + effect)
step(name: string, effect: Effect.Effect<A, E, R>)

// Overload 2: Config-based step
step(name: string, config: StepConfig<A, E, R>)
```

**The Issue**: When a developer types:

```typescript
yield* Workflow.step("Process payment", {
  // LSP provides no autocomplete here
})
```

TypeScript's LSP cannot provide autocomplete suggestions for the config properties (`execute`, `retry`, `timeout`) because:

1. The second parameter is a union type (`StepConfig | Effect`)
2. Until `execute` is typed, TypeScript cannot disambiguate from an Effect object
3. Effects are also objects, so `{}` matches both overloads initially

This is a **DX footgun** - the config API is powerful but not discoverable.

---

## Proposed Solution

Make `step()` accept **only** a config object. The config always has `name` and `execute`, with optional `retry` and `timeout`.

### New API

```typescript
// Single signature - config only
export function step<A, E, R>(
  config: StepConfig<A, E, R>
): Effect.Effect<A, StepErrors<E>, StepRequirements<R>>;
```

### New StepConfig Interface

```typescript
export interface StepConfig<A, E, R> {
  /**
   * Unique name for this step within the workflow.
   * Used for caching, logging, and debugging.
   */
  readonly name: string;

  /**
   * The effect to execute.
   */
  readonly execute: Effect.Effect<A, E, R>;

  /**
   * Retry configuration.
   * If provided, failed executions will be retried with the specified options.
   */
  readonly retry?: RetryConfig;

  /**
   * Timeout for each execution attempt (not total time).
   * Applied before retry - each attempt gets the full timeout.
   */
  readonly timeout?: DurationInput;
}
```

---

## Usage Examples

### Before (Current API)

```typescript
// Simple step
const user = yield* Workflow.step("Fetch user", fetchUser(userId));

// With config (no autocomplete!)
const payment = yield* Workflow.step("Process payment", {
  execute: processPayment(order),
  retry: { maxAttempts: 3 },
});
```

### After (Proposed API)

```typescript
// Simple step - slightly more verbose but consistent
const user = yield* Workflow.step({
  name: "Fetch user",
  execute: fetchUser(userId),
});

// With config - full autocomplete!
const payment = yield* Workflow.step({
  name: "Process payment",
  execute: processPayment(order),
  retry: { maxAttempts: 3 },
});

// With all options - fully discoverable
const result = yield* Workflow.step({
  name: "Resilient API call",
  execute: callExternalAPI(),
  timeout: "30 seconds",
  retry: {
    maxAttempts: 5,
    delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
    jitter: true,
    isRetryable: (e) => !(e instanceof ValidationError),
    maxDuration: "5 minutes",
  },
});
```

---

## Trade-offs Analysis

### Advantages

| Benefit | Description |
|---------|-------------|
| **Full autocomplete** | LSP immediately suggests `name`, `execute`, `retry`, `timeout` |
| **Consistent API** | One way to call step, no overloads to understand |
| **Discoverability** | All options visible when typing `{` |
| **Simpler types** | No union types, easier for TypeScript to infer |
| **Future extensibility** | Easy to add new config options (e.g., `input`, `output` schemas) |
| **Better error messages** | TypeScript can pinpoint exactly which field is wrong |

### Disadvantages

| Drawback | Description |
|----------|-------------|
| **More verbose for simple steps** | `step({ name: "x", execute: e })` vs `step("x", e)` |
| **Breaking change** | All existing code needs migration |
| **Slightly more typing** | ~15 extra characters for simple steps |

### Verbosity Comparison

```typescript
// Current: 45 characters
Workflow.step("Fetch user", fetchUser(id))

// Proposed: 59 characters (+14)
Workflow.step({ name: "Fetch user", execute: fetchUser(id) })
```

For simple steps, it's 14 characters more. However:
- Most editors will autocomplete the `{}` and suggest fields
- The consistency benefit outweighs the verbosity cost
- Complex steps (with retry/timeout) become easier to write

---

## Alternative Considered: Named Config Helper

We could keep the current API but add a config helper:

```typescript
// Helper function for config
const stepConfig = <A, E, R>(config: StepConfig<A, E, R>) => config;

// Usage - autocomplete works!
yield* Workflow.step("Process payment", stepConfig({
  execute: processPayment(order),
  retry: { maxAttempts: 3 },
}));
```

**Why not this approach?**
- Adds cognitive overhead (two ways to do things)
- Extra import needed
- Doesn't solve the core inconsistency
- Users might not discover the helper

---

## Implementation Plan

### Files to Modify

| File | Changes |
|------|---------|
| `src/primitives/step.ts` | Update signature, move `name` into config |
| `src/primitives/index.ts` | No changes needed |
| `src/index.ts` | No changes needed |
| `test/primitives/step.test.ts` | Update all tests |
| `examples/effect-worker/src/workflows.ts` | Update to new API |

### Step 1: Update Types

```typescript
// src/primitives/step.ts

export interface StepConfig<A, E, R> {
  /**
   * Unique name for this step within the workflow.
   */
  readonly name: string;

  /**
   * The effect to execute.
   */
  readonly execute: Effect.Effect<A, E, R>;

  /**
   * Retry configuration.
   */
  readonly retry?: RetryConfig;

  /**
   * Timeout for each execution attempt.
   */
  readonly timeout?: DurationInput;
}
```

### Step 2: Update Function Signature

```typescript
// src/primitives/step.ts

/**
 * Execute a durable step within a workflow.
 *
 * Steps are the fundamental building blocks of durable workflows:
 * - Results are cached and returned on replay
 * - Each step has a unique name for identification
 * - Steps check for cancellation before executing
 * - Retry and timeout can be configured
 *
 * @param config - Step configuration
 *
 * @example
 * ```ts
 * // Simple step
 * const user = yield* Workflow.step({
 *   name: "Fetch user",
 *   execute: fetchUser(userId),
 * });
 *
 * // Step with retry and timeout
 * const payment = yield* Workflow.step({
 *   name: "Process payment",
 *   execute: processPayment(order),
 *   timeout: "30 seconds",
 *   retry: {
 *     maxAttempts: 3,
 *     delay: Backoff.exponential({ base: "1s", max: "30s" }),
 *   },
 * });
 * ```
 */
export function step<A, E, R>(
  config: StepConfig<A, E, R>,
): Effect.Effect<A, StepErrors<E>, StepRequirements<R>> {
  const { name, ...rest } = config;

  return Effect.gen(function* () {
    // ... existing implementation using `name` from config
  });
}
```

### Step 3: Remove Type Guard

```typescript
// DELETE this function - no longer needed
function isStepConfig<A, E, R>(
  value: StepConfig<A, E, R> | Effect.Effect<A, E, R>,
): value is StepConfig<A, E, R> {
  // ...
}
```

### Step 4: Update Tests

```typescript
// Before
const result = await runStep(
  Effect.gen(function* () {
    return yield* step("myStep", Effect.succeed(42));
  })
);

// After
const result = await runStep(
  Effect.gen(function* () {
    return yield* step({ name: "myStep", execute: Effect.succeed(42) });
  })
);
```

### Step 5: Update Examples

```typescript
// Before
const order = yield* Workflow.step("Fetch order", fetchOrder(orderId));

// After
const order = yield* Workflow.step({
  name: "Fetch order",
  execute: fetchOrder(orderId),
});
```

---

## Migration Guide

### Find and Replace Patterns

**Pattern 1: Simple step**
```typescript
// Before
Workflow.step("Step name", effect)

// After
Workflow.step({ name: "Step name", execute: effect })
```

**Pattern 2: Config step**
```typescript
// Before
Workflow.step("Step name", {
  execute: effect,
  retry: { ... },
})

// After
Workflow.step({
  name: "Step name",
  execute: effect,
  retry: { ... },
})
```

### Regex for Finding Usages

```regex
Workflow\.step\s*\(\s*"([^"]+)"\s*,\s*([^{][^)]+)\)
```

This matches `Workflow.step("name", effect)` patterns.

---

## Comparison with Other Libraries

### Temporal (TypeScript SDK)

```typescript
// Temporal uses function name as step identifier
const result = await myActivity(params);
```

### Inngest

```typescript
// Inngest uses config-style
const result = await step.run("step-name", async () => {
  return doWork();
});
```

### Durable Functions (Azure)

```typescript
// Azure uses config-style
const result = yield context.df.callActivity("ActivityName", input);
```

Our proposed API aligns more with Inngest's approach, which has excellent DX.

---

## Conclusion

The config-only API provides:

1. **Immediate autocomplete** - All options discoverable when typing `{`
2. **Consistent mental model** - One way to define steps
3. **Better TypeScript inference** - No union types to confuse the compiler
4. **Future-proof** - Easy to add schema validation, labels, etc.

The trade-off of slightly more verbosity for simple steps is worth the improved discoverability and consistency. Most real-world workflows will have at least some steps with retry/timeout, making the config format the common case anyway.

**Recommendation**: Implement the config-only API.

---

## Appendix: Full Implementation Diff

```typescript
// packages/workflow/src/primitives/step.ts

// BEFORE: Types
export interface StepConfig<A, E, R> {
  readonly execute: Effect.Effect<A, E, R>;
  readonly retry?: RetryConfig;
  readonly timeout?: DurationInput;
}

// AFTER: Types
export interface StepConfig<A, E, R> {
  readonly name: string;
  readonly execute: Effect.Effect<A, E, R>;
  readonly retry?: RetryConfig;
  readonly timeout?: DurationInput;
}

// BEFORE: Function
export function step<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, StepErrors<E>, StepRequirements<R>>;

export function step<A, E, R>(
  name: string,
  config: StepConfig<A, E, R>,
): Effect.Effect<A, StepErrors<E>, StepRequirements<R>>;

export function step<A, E, R>(
  name: string,
  configOrEffect: StepConfig<A, E, R> | Effect.Effect<A, E, R>,
): Effect.Effect<A, StepErrors<E>, StepRequirements<R>> {
  const config: StepConfig<A, E, R> = isStepConfig(configOrEffect)
    ? configOrEffect
    : { execute: configOrEffect };
  // ...
}

// AFTER: Function
export function step<A, E, R>(
  config: StepConfig<A, E, R>,
): Effect.Effect<A, StepErrors<E>, StepRequirements<R>> {
  // ... implementation using config.name directly
}
```
