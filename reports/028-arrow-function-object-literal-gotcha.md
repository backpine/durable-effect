# Report 028: Arrow Function Object Literal Gotcha

## Problem

The following code fails at runtime with `StepSerializationError` but produces no compile-time errors:

```typescript
const sendConfirmation = (email: string, orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Sending confirmation to ${email} for order ${orderId}`);
    yield* randomDelay();
    return () => {
      sent: true;
    };
  });
```

## Root Cause

This is a classic JavaScript/TypeScript gotcha involving arrow functions and object literals.

### What the code actually does

```typescript
return () => {
  sent: true;
};
```

This returns an **arrow function**, not an object. Breaking it down:

1. `() => { ... }` - Arrow function with a **block body** (curly braces)
2. `sent: true` - This is a **labeled statement**, not an object property
   - `sent` is a label (like for `break`/`continue`)
   - `true` is an expression statement (evaluated and discarded)
3. The arrow function implicitly returns `undefined`

The step effect returns **the function itself**, which cannot be serialized.

### What the code likely intended

To return an object `{ sent: true }`:

```typescript
// Option 1: Parentheses around object literal
return () => ({
  sent: true
});

// Option 2: Explicit return
return () => {
  return { sent: true };
};

// Option 3: Just return the object directly (most likely intent)
return {
  sent: true
};
```

## Why No Compile-Time Error?

TypeScript cannot know that `Workflow.step` requires serializable return types. The step function signature is:

```typescript
function step<T, E, R>(
  name: string,
  effect: Effect.Effect<T, E, ForbidWorkflowScope<R>>,
): Effect.Effect<T, E | StepError | StepSerializationError | ...>
```

The generic `T` accepts any type, including functions. TypeScript has no concept of "serializable" as a type constraint.

### Possible improvements (not currently implemented)

1. **ESLint rule**: Detect arrow functions returning arrow functions in step contexts
2. **Branded types**: Use `Serializable<T>` constraint (documentation only, not enforced)
3. **Schema validation**: Require an Effect Schema for step outputs

## The Runtime Error

With the serialization validation we implemented, this now fails with a clear error:

```
StepSerializationError: Step "send-confirmation" returned a value that
cannot be serialized to storage. Value of type "function" cannot be
serialized. Functions are not serializable. Use Effect.asVoid, Effect.as(),
or Effect.map() to return a serializable value.
```

## Fix

The most likely intended code:

```typescript
const sendConfirmation = (email: string, orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Sending confirmation to ${email} for order ${orderId}`);
    yield* randomDelay();
    return { sent: true };  // Return object directly, not a function
  });
```

Or if no return value is needed:

```typescript
const sendConfirmation = (email: string, orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Sending confirmation to ${email} for order ${orderId}`);
    yield* randomDelay();
    // No return - implicitly returns undefined, which is serializable
  });
```

## JavaScript Gotcha Reference

| Syntax | What it returns |
|--------|-----------------|
| `() => { sent: true }` | `undefined` (labeled statement) |
| `() => ({ sent: true })` | `{ sent: true }` (object literal) |
| `() => { return { sent: true } }` | `{ sent: true }` (explicit return) |
| `return () => { sent: true }` | The function `() => { sent: true }` |
| `return { sent: true }` | `{ sent: true }` (object literal) |

## Summary

The bug is a JavaScript arrow function syntax gotcha combined with an apparent typo (returning a function instead of calling it or returning the object directly). The new `StepSerializationError` correctly catches this at runtime with a helpful error message, but TypeScript cannot catch it at compile time due to the generic nature of the step function signature.
