# Report 043: Step Configuration API Design

**Date**: 2024-12-10
**Package**: `@durable-effect/workflow`
**Scope**: Explore unified step configuration API with top-level retry, timeout, and input validation

---

## Executive Summary

This report explores a new API design for `Workflow.step()` that moves retry, timeout, and potentially input validation from piped operators to a declarative top-level configuration. The goal is to provide a more intuitive, discoverable DX while maintaining backward compatibility.

### The Vision

```typescript
// Current: Piping approach
const payment = yield* Workflow.step(
  "Process payment",
  processPayment(order).pipe(
    Workflow.timeout("30 seconds"),
    Workflow.retry({
      maxAttempts: 3,
      delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
    }),
  ),
);

// Proposed: Configuration approach
const payment = yield* Workflow.step("Process payment", {
  execute: processPayment(order),
  timeout: "30 seconds",
  retry: {
    maxAttempts: 3,
    delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
  },
});
```

---

## Part 1: Current API Analysis

### 1.1 Current Step API

```typescript
export function step<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StorageError | StepCancelledError | WorkflowScopeError, ...>
```

The current API requires piping operators:

```typescript
// Retry only
yield* Workflow.step("fetch", fetchData().pipe(
  Workflow.retry({ maxAttempts: 3 })
));

// Timeout only
yield* Workflow.step("fetch", fetchData().pipe(
  Workflow.timeout("30 seconds")
));

// Both (order matters!)
yield* Workflow.step("fetch", fetchData().pipe(
  Workflow.timeout("30 seconds"),  // Must be BEFORE retry
  Workflow.retry({ maxAttempts: 3 })
));
```

### 1.2 Problems with Current Approach

| Problem | Impact | Severity |
|---------|--------|----------|
| **Order dependence** | Timeout must be piped before retry, but nothing enforces this | High |
| **Discoverability** | Users must know about `Workflow.retry()` and `Workflow.timeout()` | Medium |
| **Verbosity** | Adding retry+timeout requires understanding Effect's pipe pattern | Medium |
| **Consistency** | Some frameworks use config objects (Temporal), others use decorators | Low |

### 1.3 Current Operator Order Issue

The order of piped operators is crucial but not obvious:

```typescript
// CORRECT: Timeout applies to each attempt
fetchData().pipe(
  Workflow.timeout("10 seconds"),  // First: wraps the inner effect
  Workflow.retry({ maxAttempts: 3 })  // Second: retries timeout failures
)

// WRONG: Timeout applies to all attempts combined
fetchData().pipe(
  Workflow.retry({ maxAttempts: 3 }),  // First: handles failures
  Workflow.timeout("10 seconds")  // Second: wraps the retry loop
)
```

A config-based API can enforce the correct semantic.

---

## Part 2: Proposed API Design

### 2.1 Core Overloaded Signatures

```typescript
// Signature 1: Simple (current API, unchanged)
function step<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ...>;

// Signature 2: With config object
function step<A, E, R>(
  name: string,
  config: StepConfig<A, E, R>,
): Effect.Effect<A, ...>;
```

### 2.2 StepConfig Interface

```typescript
export interface StepConfig<A, E, R> {
  /**
   * The effect to execute.
   * Can be an Effect or a generator function returning an Effect.
   */
  readonly execute:
    | Effect.Effect<A, E, R>
    | (() => Generator<Effect.Effect<unknown, unknown, unknown>, A, unknown>);

  /**
   * Retry configuration.
   * Automatically wraps the effect with durable retry logic.
   */
  readonly retry?: RetryConfig;

  /**
   * Timeout for each execution attempt.
   * Applied BEFORE retry (timeout per attempt, not total).
   */
  readonly timeout?: DurationInput;

  /**
   * Maximum total time across all retry attempts.
   * This is a ceiling on the entire step, including all retries.
   */
  readonly maxDuration?: DurationInput;

  /**
   * Optional input schema for runtime validation.
   * If provided, validates the step's input at execution time.
   */
  readonly input?: Schema.Schema<unknown>;

  /**
   * Optional output schema for runtime validation.
   * If provided, validates the step's output before caching.
   */
  readonly output?: Schema.Schema<A>;
}
```

### 2.3 RetryConfig (Streamlined)

Building on report 033, consolidate delay options:

```typescript
export interface RetryConfig {
  /**
   * Maximum number of retry attempts (not including initial attempt).
   */
  readonly maxAttempts: number;

  /**
   * Delay strategy between retries.
   * Accepts: string duration, number (ms), BackoffStrategy, or custom function.
   * Default: exponential backoff starting at 1 second.
   */
  readonly delay?:
    | DurationInput
    | BackoffStrategy
    | ((attempt: number) => number);

  /**
   * Whether to add jitter to delays.
   * Default: true
   */
  readonly jitter?: boolean;

  /**
   * Optional predicate to determine if error is retryable.
   * Default: all errors are retryable.
   */
  readonly isRetryable?: (error: unknown) => boolean;
}
```

### 2.4 Duration Input Types

```typescript
type DurationInput =
  | string           // "5 seconds", "1 minute", etc.
  | number           // milliseconds
  | Duration.Duration; // Effect Duration
```

---

## Part 3: API Usage Examples

### 3.1 Basic Usage (Backward Compatible)

```typescript
// Still works! No changes needed.
const user = yield* Workflow.step("Fetch user", fetchUser(userId));
```

### 3.2 Retry Only

```typescript
// Current
const data = yield* Workflow.step("Fetch data",
  fetchData().pipe(
    Workflow.retry({ maxAttempts: 3 })
  )
);

// Proposed
const data = yield* Workflow.step("Fetch data", {
  execute: fetchData(),
  retry: { maxAttempts: 3 },
});
```

### 3.3 Timeout Only

```typescript
// Current
const result = yield* Workflow.step("Process",
  heavyComputation().pipe(
    Workflow.timeout("30 seconds")
  )
);

// Proposed
const result = yield* Workflow.step("Process", {
  execute: heavyComputation(),
  timeout: "30 seconds",
});
```

### 3.4 Retry + Timeout (The Common Case)

```typescript
// Current (order matters!)
const payment = yield* Workflow.step("Process payment",
  processPayment(order).pipe(
    Workflow.timeout("10 seconds"),  // Per attempt
    Workflow.retry({
      maxAttempts: 3,
      delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
    }),
  )
);

// Proposed (order is enforced by design)
const payment = yield* Workflow.step("Process payment", {
  execute: processPayment(order),
  timeout: "10 seconds",  // Per attempt
  retry: {
    maxAttempts: 3,
    delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
  },
});
```

### 3.5 Using Generator Syntax

For inline step logic without creating separate functions:

```typescript
// Current: Must define effect inline or extract function
yield* Workflow.step("Process data",
  Effect.gen(function* () {
    const data = yield* readFile(path);
    return processData(data);
  })
);

// Proposed: Generator syntax option
yield* Workflow.step("Process data", {
  execute: function* () {
    const data = yield* readFile(path);
    return processData(data);
  },
  retry: { maxAttempts: 2 },
});
```

### 3.6 With Input/Output Validation

```typescript
import { Schema } from "@effect/schema";

const PaymentInputSchema = Schema.Struct({
  orderId: Schema.String,
  amount: Schema.Number.pipe(Schema.positive()),
});

const PaymentResultSchema = Schema.Struct({
  transactionId: Schema.String,
  status: Schema.Literal("success", "pending"),
});

yield* Workflow.step("Process payment", {
  execute: processPayment(order),
  input: PaymentInputSchema,   // Validates before execution
  output: PaymentResultSchema, // Validates before caching
  retry: { maxAttempts: 3 },
  timeout: "30 seconds",
});
```

### 3.7 With Max Duration (Total Time Budget)

```typescript
// Total budget of 5 minutes across all retries
yield* Workflow.step("External API call", {
  execute: callExternalAPI(request),
  timeout: "30 seconds",     // Per attempt
  maxDuration: "5 minutes",  // Total budget
  retry: {
    maxAttempts: 10,
    delay: Backoff.exponential({ base: "1 second", max: "1 minute" }),
  },
});
```

### 3.8 Using Backoff Presets

```typescript
// Standard preset: 1s -> 2s -> 4s -> 8s -> 16s (max 30s)
yield* Workflow.step("API call", {
  execute: callAPI(),
  retry: {
    maxAttempts: 5,
    delay: Backoff.presets.standard(),
  },
});

// Aggressive preset: 100ms -> 200ms -> 400ms (max 5s)
yield* Workflow.step("Fast retry", {
  execute: quickOperation(),
  retry: {
    maxAttempts: 3,
    delay: Backoff.presets.aggressive(),
  },
});

// Patient preset: 5s -> 10s -> 20s -> 40s (max 2min)
yield* Workflow.step("Rate limited API", {
  execute: rateLimitedAPI(),
  retry: {
    maxAttempts: 8,
    delay: Backoff.presets.patient(),
  },
});
```

---

## Part 4: Implementation Design

### 4.1 Function Overload Strategy

```typescript
// Detection logic
function step<A, E, R>(
  name: string,
  configOrEffect: StepConfig<A, E, R> | Effect.Effect<A, E, R>,
): Effect.Effect<A, ...> {
  // Detect config object vs Effect
  if (isStepConfig(configOrEffect)) {
    return stepWithConfig(name, configOrEffect);
  }
  return stepWithEffect(name, configOrEffect);
}

function isStepConfig<A, E, R>(
  value: StepConfig<A, E, R> | Effect.Effect<A, E, R>
): value is StepConfig<A, E, R> {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value
  );
}
```

### 4.2 Config-Based Step Implementation

```typescript
function stepWithConfig<A, E, R>(
  name: string,
  config: StepConfig<A, E, R>,
): Effect.Effect<A, ...> {
  return Effect.gen(function* () {
    // 1. Build the effect from execute
    let effect = normalizeExecute(config.execute);

    // 2. Apply input validation (if schema provided)
    if (config.input) {
      effect = withInputValidation(effect, config.input);
    }

    // 3. Apply timeout (before retry - per attempt)
    if (config.timeout) {
      effect = effect.pipe(Workflow.timeout(config.timeout));
    }

    // 4. Apply retry
    if (config.retry) {
      const retryOptions: RetryOptions = {
        maxAttempts: config.retry.maxAttempts,
        delay: config.retry.delay,
        jitter: config.retry.jitter ?? true,
        isRetryable: config.retry.isRetryable,
        maxDuration: config.maxDuration,
      };
      effect = effect.pipe(Workflow.retry(retryOptions));
    }

    // 5. Apply output validation (if schema provided)
    if (config.output) {
      effect = withOutputValidation(effect, config.output);
    }

    // 6. Execute through normal step
    return yield* stepWithEffect(name, effect);
  });
}

function normalizeExecute<A, E, R>(
  execute: StepConfig<A, E, R>["execute"]
): Effect.Effect<A, E, R> {
  if (typeof execute === "function") {
    // Generator function
    return Effect.gen(execute);
  }
  return execute;
}
```

### 4.3 Schema Validation Helpers

```typescript
import { Schema } from "@effect/schema";

function withInputValidation<A, E, R, I>(
  effect: Effect.Effect<A, E, R>,
  schema: Schema.Schema<I>,
): Effect.Effect<A, E | Schema.ParseError, R> {
  return Effect.gen(function* () {
    const stepCtx = yield* StepContext;
    const inputKey = `step:${stepCtx.stepName}:input`;
    const rawInput = yield* StorageAdapter.pipe(
      Effect.flatMap(s => s.get(inputKey))
    );

    // Validate input
    yield* Schema.decodeUnknown(schema)(rawInput).pipe(
      Effect.mapError(e => new InputValidationError({
        stepName: stepCtx.stepName,
        cause: e
      }))
    );

    return yield* effect;
  });
}

function withOutputValidation<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  schema: Schema.Schema<A>,
): Effect.Effect<A, E | Schema.ParseError, R> {
  return effect.pipe(
    Effect.flatMap(output =>
      Schema.decodeUnknown(schema)(output).pipe(
        Effect.mapError(e => new OutputValidationError({ cause: e }))
      )
    )
  );
}
```

---

## Part 5: Alternative API Considerations

### 5.1 Alternative A: Fluent Builder Pattern

```typescript
const payment = yield* Workflow.step("Process payment")
  .execute(processPayment(order))
  .timeout("30 seconds")
  .retry({ maxAttempts: 3, delay: Backoff.exponential({ base: "1s" }) })
  .run();
```

**Pros:**
- Highly discoverable via autocomplete
- Each call returns typed builder

**Cons:**
- More complex implementation
- `.run()` at the end is awkward
- Doesn't compose well with Effect patterns
- Not as concise as config object

**Verdict:** Rejected - too different from Effect idioms.

### 5.2 Alternative B: Separate Configured Step Function

```typescript
// New function instead of overload
const payment = yield* Workflow.configuredStep({
  name: "Process payment",
  execute: processPayment(order),
  timeout: "30 seconds",
  retry: { maxAttempts: 3 },
});
```

**Pros:**
- No type inference complexity from overloads
- Clear distinction between simple and configured steps

**Cons:**
- Two functions to learn
- More verbose for common case
- `configuredStep` is awkward naming

**Verdict:** Consider as fallback if overload inference proves problematic.

### 5.3 Alternative C: Second Argument as Options

```typescript
const payment = yield* Workflow.step(
  "Process payment",
  processPayment(order),
  {
    timeout: "30 seconds",
    retry: { maxAttempts: 3 },
  }
);
```

**Pros:**
- Effect stays in second position (familiar)
- Options are clearly separate

**Cons:**
- Three arguments feels heavy
- Can't use generator syntax for execute
- Harder to type (optional third arg)

**Verdict:** Viable alternative, but config object is cleaner.

### 5.4 Alternative D: Two Signatures with Explicit Names

```typescript
// Simple step (current)
const user = yield* Workflow.step("Fetch user", fetchUser(userId));

// Resilient step (new)
const payment = yield* Workflow.resilientStep("Process payment", {
  execute: processPayment(order),
  timeout: "30 seconds",
  retry: { maxAttempts: 3 },
});
```

**Pros:**
- No overload complexity
- "Resilient" conveys retry/timeout semantics

**Cons:**
- Users must learn two function names
- Naming (`resilientStep`) may not feel right

**Verdict:** Could work, but "resilient" is too specific.

---

## Part 6: Comparison with Other Frameworks

### 6.1 Temporal (TypeScript SDK)

```typescript
// Temporal uses decorators and activity options
const result = await workflow.executeActivity("processPayment", order, {
  startToCloseTimeout: "30s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1s",
    maximumInterval: "30s",
    backoffCoefficient: 2,
  },
});
```

**Similarities to our proposal:**
- Config object for options
- `startToCloseTimeout` ≈ our `timeout`
- `retry` nested config

**Differences:**
- Temporal has `scheduleToCloseTimeout` (total time) vs `startToCloseTimeout` (per attempt)
- We use `timeout` (per attempt) and `maxDuration` (total)

### 6.2 Inngest

```typescript
inngest.createFunction(
  { id: "process-payment", retries: 3 },
  { event: "payment/process" },
  async ({ event, step }) => {
    await step.run("charge-card", async () => {
      return chargeCard(event.data);
    });
  }
);
```

**Differences:**
- Retry at function level, not step level
- No timeout configuration per step
- Simpler but less granular

### 6.3 Hatchet

```typescript
@Workflow()
class PaymentWorkflow {
  @Step({ retries: 3, timeout: "30s" })
  async processPayment(input: PaymentInput) {
    return charge(input);
  }
}
```

**Similarities:**
- Decorator-based (class syntax)
- Per-step retry and timeout

**Differences:**
- Decorator syntax vs config object
- Class-based vs functional

### 6.4 Comparison Table

| Framework | Retry Config | Timeout Config | Backoff | Per-Step vs Per-Workflow |
|-----------|-------------|----------------|---------|--------------------------|
| **Our Proposal** | Step config | Step config | Flexible (presets/custom) | Per-step |
| **Temporal** | Activity options | Activity options | Built-in exponential | Per-activity |
| **Inngest** | Function level | Not per-step | Linear only | Per-function |
| **Hatchet** | Decorators | Decorators | Limited | Per-step |

Our proposal offers the most flexibility with backoff strategies and maintains the functional Effect style.

---

## Part 7: Type Safety Considerations

### 7.1 Overload Type Inference

TypeScript should correctly infer types for both signatures:

```typescript
// Effect signature - A is inferred from effect
const user = yield* Workflow.step("Fetch user", fetchUser(userId));
// typeof user = User

// Config signature - A is inferred from execute
const payment = yield* Workflow.step("Process payment", {
  execute: processPayment(order),
  retry: { maxAttempts: 3 },
});
// typeof payment = PaymentResult
```

### 7.2 Generator Function Typing

For the generator syntax, we need careful typing:

```typescript
interface StepConfig<A, E, R> {
  readonly execute:
    | Effect.Effect<A, E, R>
    | (() => Generator<Effect.YieldWrap<Effect.Effect<any, any, any>>, A, any>);
  // ...
}
```

### 7.3 Schema Type Alignment

When output schema is provided, ensure return type matches:

```typescript
const PaymentResult = Schema.Struct({
  transactionId: Schema.String,
  status: Schema.Literal("success", "pending"),
});

type PaymentResultType = Schema.Schema.Type<typeof PaymentResult>;

yield* Workflow.step("Process payment", {
  execute: processPayment(order),  // Must return Effect<PaymentResultType, ...>
  output: PaymentResult,
});
```

TypeScript should error if `execute` doesn't produce a compatible type.

---

## Part 8: Migration & Backward Compatibility

### 8.1 Backward Compatibility

The current API remains fully supported:

```typescript
// All of these continue to work
yield* Workflow.step("simple", effect);
yield* Workflow.step("with retry", effect.pipe(Workflow.retry({ maxAttempts: 3 })));
yield* Workflow.step("with both", effect.pipe(
  Workflow.timeout("30s"),
  Workflow.retry({ maxAttempts: 3 })
));
```

### 8.2 Migration Guide

Users can migrate incrementally:

```typescript
// Before
yield* Workflow.step("Process payment",
  processPayment(order).pipe(
    Workflow.timeout("30 seconds"),
    Workflow.retry({
      maxAttempts: 3,
      delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
    }),
  )
);

// After (functionally equivalent)
yield* Workflow.step("Process payment", {
  execute: processPayment(order),
  timeout: "30 seconds",
  retry: {
    maxAttempts: 3,
    delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
  },
});
```

### 8.3 Codemods

A simple codemod could automate migration:

```typescript
// Pattern: step(name, effect.pipe(Workflow.timeout(t), Workflow.retry(r)))
// Transform: step(name, { execute: effect, timeout: t, retry: r })
```

---

## Part 9: Discarded Ideas

### 9.1 `execute` as Generator (Rejected First Draft)

Initial design allowed this:

```typescript
yield* Workflow.step("Process", {
  execute: function* () {
    yield* Workflow.step("nested", innerEffect);  // Nested step!
    return result;
  },
  retry: { maxAttempts: 3 },
});
```

**Rejected because:**
- Nested `Workflow.step` inside `execute` would bypass the outer retry
- `WorkflowLevel` guard wouldn't work inside generator
- Creates confusion about what's being retried

**Resolution:** Generator syntax only for Effect composition, not workflow primitives.

### 9.2 Automatic Schema Derivation

Considered deriving schemas from TypeScript types:

```typescript
yield* Workflow.step<PaymentInput, PaymentResult>("Process", {
  execute: processPayment(order),
  validateIO: true,  // Auto-derive schemas from type params
});
```

**Rejected because:**
- TypeScript types aren't available at runtime
- Would require a build step or type provider
- Explicit schemas are more predictable

### 9.3 Step Groups

Considered a way to share config across steps:

```typescript
const resilientSteps = Workflow.stepGroup({
  timeout: "30 seconds",
  retry: { maxAttempts: 3 },
});

yield* resilientSteps.step("A", effectA);
yield* resilientSteps.step("B", effectB);
```

**Deferred because:**
- Adds complexity without clear benefit
- Users can create their own helper functions
- Could be added later without breaking changes

---

## Part 10: Recommendations

### 10.1 Recommended API

Adopt the **config object overload** approach:

```typescript
// Signature 1: Simple (unchanged)
function step<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ...>;

// Signature 2: With config
function step<A, E, R>(
  name: string,
  config: StepConfig<A, E, R>,
): Effect.Effect<A, ...>;
```

### 10.2 Implementation Priority

| Phase | Feature | Effort | Impact |
|-------|---------|--------|--------|
| **Phase 1** | Basic overload with `execute`, `retry`, `timeout` | Medium | High |
| **Phase 2** | `maxDuration` support | Low | Medium |
| **Phase 3** | Input/output schema validation | Medium | Medium |
| **Phase 4** | Generator function syntax | Low | Low |

### 10.3 Design Principles

1. **Config enforces correct semantics** - Timeout is always per-attempt, not total
2. **Progressive disclosure** - Simple steps stay simple, complex steps get config
3. **Type safety** - Full inference for both signatures
4. **Backward compatible** - Current pipe-based API continues to work
5. **Effect-idiomatic** - Config object, not decorators or builders

### 10.4 Naming Conventions

| Config Field | Purpose | Type |
|--------------|---------|------|
| `execute` | The effect to run | Effect or Generator |
| `timeout` | Per-attempt timeout | DurationInput |
| `maxDuration` | Total time budget | DurationInput |
| `retry` | Retry configuration | RetryConfig |
| `retry.maxAttempts` | Max retries | number |
| `retry.delay` | Delay strategy | DurationInput \| BackoffStrategy |
| `retry.jitter` | Add randomization | boolean |
| `retry.isRetryable` | Error filter | (error) => boolean |
| `input` | Input schema | Schema |
| `output` | Output schema | Schema |

---

## Part 11: Open Questions

### Q1: Should `execute` accept raw functions?

```typescript
// Option A: Effect only
execute: processPayment(order)

// Option B: Also allow () => Promise
execute: () => processPayment(order)  // Creates Effect internally?
```

**Recommendation:** Effect only. Promises should be wrapped with `Effect.tryPromise()`.

### Q2: Should validation errors be retryable?

```typescript
yield* Workflow.step("Process", {
  execute: processPayment(order),
  input: PaymentInputSchema,
  retry: { maxAttempts: 3 },
});
// If input validation fails, should it retry?
```

**Recommendation:** No. Validation errors should fail immediately (programming error).

### Q3: Should we support `onRetry` callbacks?

```typescript
yield* Workflow.step("Process", {
  execute: processPayment(order),
  retry: {
    maxAttempts: 3,
    onRetry: (attempt, error) => Effect.log(`Retry ${attempt}: ${error}`),
  },
});
```

**Recommendation:** Defer. Users can use `Effect.tapError` in their execute effect.

### Q4: Should timeout include queue wait time?

When a step is retrying and waiting for the alarm, should that count against timeout?

**Recommendation:** No. Timeout should only count execution time, not wait time. Use `maxDuration` for total budget.

---

## Conclusion

The config-based `Workflow.step()` API provides:

1. **Better DX** - Discoverable options, no pipe order issues
2. **Correct semantics** - Timeout is always per-attempt by design
3. **Progressive complexity** - Simple cases stay simple
4. **Type safety** - Full inference for both overloads
5. **Future extensibility** - Easy to add validation, callbacks, etc.

The migration path is smooth: current pipe-based usage continues to work, and users can adopt config syntax incrementally.

---

## Appendix: Full Type Definitions

```typescript
// Duration input types
type DurationInput = string | number | Duration.Duration;

// Backoff strategies (from existing backoff.ts)
type BackoffStrategy =
  | { readonly type: "constant"; readonly delayMs: number }
  | { readonly type: "linear"; readonly initialDelayMs: number; readonly incrementMs: number; readonly maxDelayMs?: number }
  | { readonly type: "exponential"; readonly initialDelayMs: number; readonly multiplier?: number; readonly maxDelayMs?: number };

// Retry configuration
interface RetryConfig {
  readonly maxAttempts: number;
  readonly delay?: DurationInput | BackoffStrategy | ((attempt: number) => number);
  readonly jitter?: boolean;
  readonly isRetryable?: (error: unknown) => boolean;
}

// Step configuration
interface StepConfig<A, E, R> {
  readonly execute: Effect.Effect<A, E, R>;
  readonly retry?: RetryConfig;
  readonly timeout?: DurationInput;
  readonly maxDuration?: DurationInput;
  readonly input?: Schema.Schema<unknown>;
  readonly output?: Schema.Schema<A>;
}

// Overloaded step function
function step<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StorageError | StepCancelledError | WorkflowScopeError, WorkflowContext | StorageAdapter | RuntimeAdapter | WorkflowLevel | Exclude<R, StepContext | StorageAdapter | RuntimeAdapter | StepScope>>;

function step<A, E, R>(
  name: string,
  config: StepConfig<A, E, R>,
): Effect.Effect<A, E | StorageError | StepCancelledError | WorkflowScopeError | RetryExhaustedError | WorkflowTimeoutError, WorkflowContext | StorageAdapter | RuntimeAdapter | WorkflowLevel | Exclude<R, StepContext | StorageAdapter | RuntimeAdapter | StepScope>>;
```
