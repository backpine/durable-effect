# Effect Patterns Audit: @durable-effect/workflow

**Date**: 2024-12-08
**Package**: `packages/workflow`
**Scope**: Identify non-idiomatic Effect patterns, anti-patterns, and design issues

---

## Executive Summary

The workflow package demonstrates **strong Effect fundamentals** with proper use of `Data.TaggedError`, `Context.Tag`, layer composition, and `Effect.gen`. However, there are several areas where the implementation deviates from idiomatic Effect patterns or uses unsafe type assertions.

**Issues Found**: 8 (2 Critical, 1 High, 3 Medium, 2 Low)

---

## Issues Ranked by Severity

### 1. CRITICAL: Unsafe `as any` Type Witnesses

**File**: `src/jobs/make.ts` (Lines 93-95)

```typescript
return {
  _tag: "WorkflowDefinition" as const,
  execute: fn as WorkflowDefinition<I, O, E, R>["execute"],
  _Input: undefined as any,    // ❌ Anti-pattern
  _Output: undefined as any,   // ❌ Anti-pattern
  _Error: undefined as any,    // ❌ Anti-pattern
};
```

**Problem**: Using `as any` defeats TypeScript's type safety. Type witnesses are used for type-level information but `any` allows anything to pass through, making the phantom types meaningless at the type level.

**Impact**: The workflow definition's input/output/error types could be incorrectly inferred or silently wrong.

**Recommended Fix**: Use Effect's `Types.Covariant` pattern correctly:

```typescript
import { Types } from "effect";

interface WorkflowDefinition<I, O, E, R> {
  readonly _tag: "WorkflowDefinition";
  readonly execute: (input: I) => Effect.Effect<O, E | PauseSignal, R>;
  readonly [Types.Covariant]: {
    readonly _I: (_: never) => I;
    readonly _O: (_: never) => O;
    readonly _E: (_: never) => E;
  };
}

// In make():
return {
  _tag: "WorkflowDefinition" as const,
  execute: fn,
  [Types.Covariant]: {
    _I: (_: never) => undefined as never as I,
    _O: (_: never) => undefined as never as O,
    _E: (_: never) => undefined as never as E,
  },
};
```

Or use the simpler `as never` pattern if covariance isn't needed:

```typescript
return {
  _tag: "WorkflowDefinition" as const,
  execute: fn,
  _Input: undefined as never,
  _Output: undefined as never,
  _Error: undefined as never,
};
```

---

### 2. CRITICAL: Schema Not Used for Input Validation

**File**: `src/executor/executor.ts` (Line 104)

```typescript
const result = yield* definition
  .execute(context.input as Input)  // ❌ Unsafe cast without validation
  .pipe(/* ... */);
```

**Problem**: `context.input` is typed as `unknown` and directly cast to `Input` without runtime validation. If the stored input is corrupted or doesn't match the expected type, this will cause runtime errors deep in the workflow.

**Impact**: Silent type mismatches can cause cryptic runtime failures. No validation means corrupted data goes undetected.

**Recommended Fix**: Use `@effect/schema` for runtime validation:

```typescript
import { Schema } from "@effect/schema";

// In WorkflowDefinition, add schema:
interface WorkflowDefinition<I, O, E, R> {
  readonly _tag: "WorkflowDefinition";
  readonly execute: (input: I) => Effect.Effect<O, E | PauseSignal, R>;
  readonly inputSchema?: Schema.Schema<I>;  // Optional for backward compat
}

// In executor:
const validatedInput = definition.inputSchema
  ? yield* Schema.decodeUnknown(definition.inputSchema)(context.input).pipe(
      Effect.mapError((e) => new InputValidationError({ cause: e }))
    )
  : context.input as Input;  // Fallback for schemas not provided

const result = yield* definition.execute(validatedInput);
```

Alternatively, at minimum add a type guard:

```typescript
// Validate at workflow registration time by storing schema hash
// Then validate on resume that schema hasn't changed
```

---

### 3. HIGH: Discriminated Unions Not Using Data Module

**File**: `src/state/types.ts` (Lines 13-52, 69-106)

```typescript
// Current: Plain union types
export type WorkflowStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Queued"; readonly queuedAt: number }
  | { readonly _tag: "Running"; readonly runningAt: number }
  // ...

export type WorkflowTransition =
  | { readonly _tag: "Start"; readonly input: unknown }
  | { readonly _tag: "Queue"; readonly input: unknown }
  // ...
```

**Problem**: These are plain objects without structural equality. In Effect, discriminated unions should typically use `Data.TaggedClass` or `Data.Case` for:
- Structural equality (`Equal.equals` works correctly)
- Proper hashing for use in `HashMap`/`HashSet`
- Better serialization characteristics
- Pattern matching with `Match` module

**Impact**: Cannot use these types reliably in Effect data structures that depend on equality. Harder to use with `Match.tag`.

**Recommended Fix**: Convert to `Data.TaggedClass`:

```typescript
import { Data } from "effect";

// Status variants
export class Pending extends Data.TaggedClass("Pending")<{}> {}

export class Queued extends Data.TaggedClass("Queued")<{
  readonly queuedAt: number;
}> {}

export class Running extends Data.TaggedClass("Running")<{
  readonly runningAt: number;
}> {}

export class Paused extends Data.TaggedClass("Paused")<{
  readonly reason: "sleep" | "retry";
  readonly resumeAt: number;
  readonly stepName?: string;
}> {}

export class Completed extends Data.TaggedClass("Completed")<{
  readonly completedAt: number;
}> {}

export class Failed extends Data.TaggedClass("Failed")<{
  readonly failedAt: number;
  readonly error: WorkflowError;
}> {}

export class Cancelled extends Data.TaggedClass("Cancelled")<{
  readonly cancelledAt: number;
  readonly reason?: string;
}> {}

export type WorkflowStatus =
  | Pending
  | Queued
  | Running
  | Paused
  | Completed
  | Failed
  | Cancelled;

// Then use with Match:
import { Match } from "effect";

const handler = Match.type<WorkflowStatus>().pipe(
  Match.tag("Pending", () => "pending"),
  Match.tag("Running", ({ runningAt }) => `running since ${runningAt}`),
  Match.exhaustive
);
```

---

### 4. MEDIUM: Redundant Type Assertions

**Files**: Multiple locations

**File 1**: `src/context/workflow-context.ts` (Line 187)
```typescript
input: <T>() => storage.get<T>(KEYS.input).pipe(Effect.map((i) => i as T)),
//                                                           ^^^^^^^^ redundant
```

**File 2**: `src/adapters/in-memory/storage.ts` (Line 31)
```typescript
Effect.map((state) => state.data.get(key) as T | undefined),
//                                        ^^^^^^^^^^^^^^^^ redundant
```

**Problem**: After calling `storage.get<T>()`, the result is already typed as `T | undefined`. The `as T` cast is redundant and suggests the type system isn't trusted.

**Impact**: Code clutter, potential for masking actual type issues.

**Recommended Fix**: Remove redundant casts:

```typescript
// workflow-context.ts
input: <T>() => storage.get<T>(KEYS.input),

// in-memory/storage.ts
Effect.map((state) => state.data.get(key)),
```

---

### 5. MEDIUM: Error Swallowing Without Logging

**File**: `src/recovery/manager.ts` (Lines 243-245)

```typescript
yield* stateMachine.applyTransition({
  _tag: "Fail",
  error: { message: "Max recovery attempts exceeded", code: "MAX_ATTEMPTS" },
  completedSteps,
}).pipe(
  Effect.catchTag("InvalidTransitionError", () => Effect.void),  // ❌ Silent swallow
);
```

**Problem**: `InvalidTransitionError` is caught and completely swallowed with no logging. While the intent is clear (recovery is already failing), this could mask unexpected transition failures.

**Impact**: Debugging difficulties if unexpected transition errors occur.

**Recommended Fix**: Add logging before swallowing:

```typescript
.pipe(
  Effect.catchTag("InvalidTransitionError", (error) =>
    Effect.logDebug("Transition error during recovery failure (expected)", { error }).pipe(
      Effect.zipRight(Effect.void)
    )
  ),
)
```

Or use `Effect.ignoreLogged`:

```typescript
.pipe(
  Effect.catchTag("InvalidTransitionError", () => Effect.void),
  Effect.tapError((e) => Effect.logDebug("Recovery transition failed", { error: e })),
)
```

---

### 6. MEDIUM: Configuration Not Using Schema

**Files**: `src/recovery/config.ts`, `src/purge/config.ts`

```typescript
// Current: Manual validation
export function validateRecoveryConfig(config: RecoveryConfig): void {
  if (config.staleThresholdMs < 1000) {
    throw new Error("staleThresholdMs must be at least 1000ms");
  }
  if (config.maxRecoveryAttempts < 1) {
    throw new Error("maxRecoveryAttempts must be at least 1");
  }
  // ...
}
```

**Problem**: Manual validation with thrown errors instead of Effect's `Schema` module. This:
- Throws synchronously instead of returning `Effect`
- Doesn't provide the rich error messages Schema offers
- Can't be composed with other validation

**Impact**: Less composable, harder to get detailed validation errors.

**Recommended Fix**: Use `@effect/schema`:

```typescript
import { Schema } from "@effect/schema";

export const RecoveryConfigSchema = Schema.Struct({
  staleThresholdMs: Schema.Number.pipe(
    Schema.greaterThanOrEqualTo(1000),
    Schema.annotations({ message: () => "staleThresholdMs must be at least 1000ms" })
  ),
  maxRecoveryAttempts: Schema.Number.pipe(
    Schema.greaterThanOrEqualTo(1),
    Schema.annotations({ message: () => "maxRecoveryAttempts must be at least 1" })
  ),
  recoveryDelayMs: Schema.Number.pipe(
    Schema.greaterThanOrEqualTo(0),
    Schema.annotations({ message: () => "recoveryDelayMs must be non-negative" })
  ),
  emitRecoveryEvents: Schema.Boolean,
});

export type RecoveryConfig = Schema.Schema.Type<typeof RecoveryConfigSchema>;

// Validation returns Effect
export const validateRecoveryConfig = (config: unknown) =>
  Schema.decodeUnknown(RecoveryConfigSchema)(config);
```

---

### 7. LOW: Mutable Variables in Pure Functions

**File 1**: `src/jobs/retry.ts` (Line 283-286)

```typescript
let delayMs = getDelay(delay, attempt);
if (jitter) {
  delayMs = addJitter(delayMs);
}
```

**File 2**: `src/jobs/timeout.ts` (Line 91-95)

```typescript
let startedAt = yield* stepCtx.startedAt;
if (startedAt === undefined) {
  startedAt = now;
  yield* stepCtx.setStartedAt(now);
}
```

**Problem**: Using `let` with reassignment in otherwise functional code. While not incorrect, it's not idiomatic Effect style.

**Impact**: Minor style inconsistency.

**Recommended Fix**:

```typescript
// retry.ts
const baseDelay = getDelay(delay, attempt);
const delayMs = jitter ? addJitter(baseDelay) : baseDelay;

// timeout.ts
const existingStartedAt = yield* stepCtx.startedAt;
const startedAt = existingStartedAt ?? now;
if (existingStartedAt === undefined) {
  yield* stepCtx.setStartedAt(now);
}
```

---

### 8. LOW: Inconsistent Use of `as const`

**File**: `src/context/step-scope.ts` (Line 42)

```typescript
export const StepScopeLayer = (stepName: string) =>
  Layer.succeed(StepScope, {
    _marker: "step-scope-active" as const,  // ❌ Unnecessary
    stepName,
  });
```

**Problem**: `as const` on a string literal in an object literal is redundant. TypeScript already infers the literal type in this context.

**Impact**: Minor code clutter.

**Recommended Fix**: Remove the `as const`:

```typescript
export const StepScopeLayer = (stepName: string) =>
  Layer.succeed(StepScope, {
    _marker: "step-scope-active",
    stepName,
  });
```

---

## Positive Findings

The codebase demonstrates excellent Effect patterns in several areas:

| Pattern | Status | Location |
|---------|--------|----------|
| `Data.TaggedError` for errors | ✅ Excellent | `src/errors.ts` |
| `Context.Tag` for services | ✅ Excellent | All service files |
| `Layer.provideMerge` composition | ✅ Excellent | `src/engine/engine.ts` |
| `Effect.all` for parallelism | ✅ Excellent | `src/state/machine.ts` |
| `Effect.tryPromise` (not deprecated `Effect.promise`) | ✅ Excellent | `src/tracker/http-batch.ts` |
| `Effect.gen` for composition | ✅ Excellent | Throughout |
| Scope guards for compile-time safety | ✅ Excellent | `src/context/*.ts` |
| Discriminated unions with `_tag` | ✅ Good | `src/state/types.ts` |
| `catchTag` vs `catchAll` usage | ✅ Correct | Throughout |

---

## Summary Table

| # | Severity | Issue | File | Recommended Fix |
|---|----------|-------|------|-----------------|
| 1 | CRITICAL | `as any` type witnesses | `jobs/make.ts:93-95` | Use `as never` or `Types.Covariant` |
| 2 | CRITICAL | No input validation | `executor/executor.ts:104` | Add Schema validation |
| 3 | HIGH | Plain unions not Data | `state/types.ts` | Convert to `Data.TaggedClass` |
| 4 | MEDIUM | Redundant type casts | Multiple | Remove redundant `as T` |
| 5 | MEDIUM | Silent error swallowing | `recovery/manager.ts:244` | Add logging before swallow |
| 6 | MEDIUM | Manual config validation | `recovery/config.ts` | Use Schema |
| 7 | LOW | Mutable variables | `retry.ts`, `timeout.ts` | Use const with ternary |
| 8 | LOW | Redundant `as const` | `step-scope.ts:42` | Remove |

---

## Recommendations

### Immediate Actions
1. Fix `as any` casts in `make.ts` - this is a type safety hole
2. Add input validation in executor - prevents silent data corruption

### Short-term Improvements
3. Convert `WorkflowStatus` and `WorkflowTransition` to `Data.TaggedClass`
4. Remove redundant type assertions
5. Add logging to error swallowing in recovery

### Long-term Enhancements
6. Migrate configuration to Schema-based validation
7. Consider using `Match` module for status/transition handling
8. Refactor mutable variables for style consistency
