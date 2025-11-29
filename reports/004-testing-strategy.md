# Testing Strategy for @durable-effect/workflow

## Overview

This document outlines a comprehensive testing strategy for the workflow package. The package implements durable workflows using Effect-TS on Cloudflare Durable Objects, which presents unique testing challenges around state persistence, alarm scheduling, and workflow resumption.

---

## Core Components to Test

### 1. Workflow.step (`workflow.ts:75-134`)

The step function is the most critical piece - it handles:

- **Cache hit path**: Return cached result if step already completed
- **Cache miss path**: Execute effect, cache result, mark completed
- **PauseSignal handling**: Increment attempt counter and propagate
- **Error handling**: Wrap non-PauseSignal errors in StepError

**Test Cases:**

```
step/cache-hit
├── returns cached result when step already completed
├── does NOT re-execute effect when cached
└── works with different value types (primitives, objects, arrays)

step/first-execution
├── executes effect when step not completed
├── caches successful result to storage
├── adds step name to completedSteps list
├── records start time on first execution
├── provides StepContext to the effect

step/error-handling
├── wraps effect errors in StepError with stepName, cause, attempt
├── propagates PauseSignal without wrapping
├── increments attempt counter on PauseSignal
├── does NOT increment attempt on regular errors

step/idempotency
├── second call returns cached result
├── effect only runs once even with multiple calls
```

---

### 2. Workflow.retry (`workflow.ts:178-237`)

The retry operator handles durable retries across workflow restarts.

**Critical Logic:**

- Check if attempt < maxAttempts
- Apply `while` predicate if provided
- Calculate delay (fixed or backoff function)
- Set alarm for resumeAt time
- Raise PauseSignal to pause workflow

**Test Cases:**

```
retry/success
├── returns value when effect succeeds on first try
├── returns value when effect succeeds after retries

retry/max-attempts
├── fails with original error when maxAttempts reached
├── attempt counter correctly tracks retries
├── does NOT set alarm when maxAttempts reached

retry/while-predicate
├── retries when while() returns true
├── fails immediately when while() returns false
├── receives the actual error in while()

retry/delay-calculation
├── uses default 1 second delay when not specified
├── uses fixed delay when Duration provided
├── uses backoff function when function provided
├── backoff function receives current attempt number

retry/pause-signal
├── sets alarm at correct resumeAt time
├── raises PauseSignal with reason="retry"
├── includes stepName in PauseSignal
├── resumeAt = Date.now() + delayMs
```

---

### 3. Workflow.timeout (`workflow.ts:249-295`)

The timeout operator sets durable deadlines that persist across restarts.

**Critical Logic:**

- Get existing deadline from step metadata OR calculate new one
- Store deadline on first execution
- Check if deadline already passed → immediate failure
- Use Effect.timeoutFail with remaining time

**Test Cases:**

```
timeout/first-execution
├── calculates deadline as Date.now() + duration
├── stores deadline in step metadata
├── passes through to effect execution

timeout/resume-execution
├── uses existing deadline from metadata (NOT recalculating)
├── fails immediately if deadline already passed
├── calculates remaining time correctly

timeout/timeout-behavior
├── fails with StepTimeoutError when effect exceeds timeout
├── StepTimeoutError contains stepName and timeoutMs
├── returns value when effect completes within timeout

timeout/edge-cases
├── handles very short timeouts (< 100ms)
├── handles long timeouts (hours)
├── deadline persists across workflow restarts
```

---

### 4. Workflow.sleep (`workflow.ts:306-326`)

Durable sleep that survives workflow restarts.

**Test Cases:**

```
sleep/basic
├── sets alarm at Date.now() + duration
├── raises PauseSignal with reason="sleep"
├── resumeAt matches alarm time

sleep/duration-formats
├── handles string durations ("5 seconds")
├── handles Duration objects
├── handles millisecond numbers
```

---

### 5. Engine - run() (`engine.ts:130-174`)

The entry point for starting workflows.

**Critical Logic:**

- Check existing status for idempotency
- Store workflow metadata (name, input)
- Set status to "Running"
- Execute workflow with contexts provided

**Test Cases:**

```
run/idempotency
├── returns existing id when status is "Completed"
├── returns existing id when status is "Failed"
├── returns existing id when status is "Running"
├── returns existing id when status is "Paused"
├── only executes workflow when status is undefined/Pending

run/initialization
├── stores workflow name in storage
├── stores workflow input in storage
├── sets status to "Running" before execution

run/unknown-workflow
├── throws error for unknown workflow name
├── does NOT set status for unknown workflow
```

---

### 6. Engine - alarm() (`engine.ts:179-205`)

Handles workflow resumption after pause.

**Critical Logic:**

- Only resume if status is "Paused"
- Load workflow metadata from storage
- Set status to "Running"
- Re-execute workflow (will skip completed steps)

**Test Cases:**

```
alarm/resume
├── resumes workflow when status is "Paused"
├── sets status to "Running" before execution
├── loads correct workflow name from storage
├── loads correct input from storage

alarm/no-op
├── does nothing when status is "Running"
├── does nothing when status is "Completed"
├── does nothing when status is "Failed"
├── does nothing when status is undefined

alarm/error-handling
├── logs error when workflow name not found
├── handles missing input gracefully
```

---

### 7. Engine - #executeWorkflow() (`engine.ts:210-287`)

Core execution logic.

**Critical Logic:**

- Create ExecutionContext and WorkflowContext services
- Provide services to workflow effect
- Handle Success → set "Completed" status
- Handle PauseSignal → set "Paused" status with reason/resumeAt
- Handle other failures → set "Failed" status with error

**Test Cases:**

```
executeWorkflow/success
├── sets status to "Completed" with completedAt timestamp
├── workflow effect runs to completion

executeWorkflow/pause
├── sets status to "Paused" when PauseSignal raised
├── paused status includes reason ("retry" or "sleep")
├── paused status includes resumeAt timestamp
├── does NOT set "Failed" status for PauseSignal

executeWorkflow/failure
├── sets status to "Failed" with error
├── sets status to "Failed" with failedAt timestamp
├── handles Fail cause type
├── handles Die cause type (defects)
```

---

### 8. StepContext Service (`step-context.ts:56-130`)

Factory that creates StepContext with storage operations.

**Test Cases:**

```
createStepContext/basic
├── returns service with correct stepName
├── returns service with correct attempt number

createStepContext/getMeta
├── returns Some when value exists
├── returns None when value doesn't exist
├── uses correct storage key (step:{name}:meta:{key})

createStepContext/setMeta
├── stores value at correct key
├── overwrites existing value

createStepContext/getResult
├── returns Some when result cached
├── returns None when no result

createStepContext/setResult
├── stores result at correct key

createStepContext/incrementAttempt
├── stores attempt + 1 at correct key

createStepContext/recordStartTime
├── stores Date.now() on first call
├── does NOT overwrite existing start time
```

---

### 9. WorkflowContext Service (`workflow-context.ts:51-96`)

Factory that creates WorkflowContext with storage operations.

**Test Cases:**

```
createWorkflowContext/basic
├── returns service with correct workflowId
├── returns service with correct workflowName
├── returns service with correct input

createWorkflowContext/getMeta
├── returns Some when value exists
├── returns None when value doesn't exist

createWorkflowContext/setMeta
├── stores value at correct key

createWorkflowContext/completedSteps
├── returns empty array when no steps completed
├── returns array of completed step names

createWorkflowContext/hasCompleted
├── returns true when step in completedSteps
├── returns false when step not in completedSteps

createWorkflowContext/status
├── returns Pending when no status stored
├── returns stored status
```

---

## Testing Approach

### 1. Mock Storage

Create a mock `DurableObjectStorage` implementation:

```typescript
class MockStorage implements DurableObjectStorage {
  private data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void>;
  async put(entries: Record<string, unknown>): Promise<void>;
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrEntries === 'string') {
      this.data.set(keyOrEntries, value);
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) {
        this.data.set(k, v);
      }
    }
  }

  // ... other methods
}
```

### 2. Mock DurableObjectState

```typescript
class MockDurableObjectState implements DurableObjectState {
  storage: MockStorage;
  id: DurableObjectId;

  constructor() {
    this.storage = new MockStorage();
    this.id = { toString: () => 'test-id-123' } as DurableObjectId;
  }

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  // ... other methods
}
```

### 3. Testing Effect Code

Use Effect's testing utilities:

```typescript
import { Effect, Exit } from "effect";

// Run effect and get result
const result = await Effect.runPromise(effect);

// Run effect and get Exit (for testing failures)
const exit = await Effect.runPromiseExit(effect);
expect(exit._tag).toBe("Failure");

// Provide mock services
const testEffect = effect.pipe(
  Effect.provideService(ExecutionContext, mockExecCtx),
  Effect.provideService(WorkflowContext, mockWorkflowCtx),
);
```

### 4. Testing Workflow Resumption

The most complex scenario - testing that workflows correctly resume after pause:

```typescript
test("workflow resumes and skips completed steps", async () => {
  const storage = new MockStorage();

  // Simulate state after first run that paused
  await storage.put("workflow:status", { _tag: "Paused", reason: "retry", resumeAt: Date.now() });
  await storage.put("workflow:completedSteps", ["Step1"]);
  await storage.put("step:Step1:result", { data: "cached" });
  await storage.put("step:Step2:attempt", 1);

  // Create engine and call alarm()
  const engine = createTestEngine(storage);
  await engine.alarm();

  // Verify Step1 was skipped (cache hit)
  // Verify Step2 was retried (attempt incremented)
  // Verify final status
});
```

---

## Test Categories by Priority

### P0 - Critical (Must Have)

1. **Step caching** - Cache hits return cached values, cache misses execute and store
2. **Retry pause/resume** - PauseSignal raised, attempt incremented, alarm set
3. **Engine status transitions** - Running → Paused → Running → Completed/Failed
4. **Workflow resumption** - Completed steps skipped on resume

### P1 - High Priority

1. **Timeout deadline persistence** - Deadline survives restarts
2. **Retry max attempts** - Fails after maxAttempts
3. **Error wrapping** - StepError contains correct metadata
4. **Idempotency** - Multiple run() calls don't re-execute

### P2 - Medium Priority

1. **Retry backoff functions** - Custom delay calculation
2. **Retry while predicate** - Conditional retry
3. **Sleep durations** - Various duration formats
4. **Metadata operations** - getMeta/setMeta for steps and workflows

### P3 - Lower Priority

1. **Edge cases** - Very short/long timeouts, empty inputs
2. **Error scenarios** - Storage failures, invalid states
3. **Concurrent operations** - blockConcurrencyWhile behavior

---

## Recommended Test Structure

```
packages/workflow/
├── src/
└── test/
    ├── mocks/
    │   ├── storage.ts          # MockStorage implementation
    │   ├── durable-object.ts   # MockDurableObjectState
    │   └── contexts.ts         # Mock service factories
    ├── unit/
    │   ├── step.test.ts        # Workflow.step tests
    │   ├── retry.test.ts       # Workflow.retry tests
    │   ├── timeout.test.ts     # Workflow.timeout tests
    │   ├── sleep.test.ts       # Workflow.sleep tests
    │   ├── step-context.test.ts
    │   └── workflow-context.test.ts
    ├── integration/
    │   ├── engine.test.ts      # Full engine tests
    │   ├── workflow-lifecycle.test.ts  # run → pause → resume → complete
    │   └── multi-step.test.ts  # Workflows with multiple steps
    └── scenarios/
        ├── retry-success.test.ts
        ├── retry-failure.test.ts
        ├── timeout-success.test.ts
        ├── timeout-failure.test.ts
        └── complex-workflow.test.ts
```

---

## Key Testing Insights

### 1. State Machine Testing

The workflow engine is essentially a state machine:

```
Pending → Running → Paused → Running → Completed
                          ↘ Failed
```

Test all valid transitions and ensure invalid transitions are prevented.

### 2. Time-Dependent Behavior

Several components depend on `Date.now()`:
- Timeout deadline calculation
- Retry delay calculation
- Sleep duration

Consider using a mock clock or dependency injection for deterministic tests.

### 3. Storage Key Verification

Critical to verify correct storage keys are used:
- `workflow:status`
- `workflow:name`
- `workflow:input`
- `workflow:meta:{key}`
- `workflow:completedSteps`
- `step:{name}:result`
- `step:{name}:attempt`
- `step:{name}:startedAt`
- `step:{name}:meta:{key}`

### 4. Effect Service Provision

Ensure tests properly provide all required services:
- `ExecutionContext` (storage + setAlarm)
- `WorkflowContext` (workflow metadata + completed steps)
- `StepContext` (step metadata + attempt tracking)

---

## Testing Tools Recommendation

1. **Vitest** - Fast, ESM-native test runner
2. **Effect Testing Utilities** - `Effect.runPromise`, `Effect.runPromiseExit`
3. **Custom Mocks** - For DurableObjectStorage and related CF types
4. **Property-Based Testing** - For retry backoff functions, duration parsing

---

## Conclusion

The workflow package requires thorough testing at multiple levels:

1. **Unit tests** for individual functions (step, retry, timeout, sleep)
2. **Integration tests** for the engine (run, alarm, executeWorkflow)
3. **Scenario tests** for complete workflow lifecycles

The key challenge is properly mocking Cloudflare's Durable Object primitives while testing Effect-based code. The recommended approach uses custom mock implementations that track storage operations for verification.

Priority should be given to testing the critical path: step caching, retry pause/resume cycles, and workflow resumption - as these are the core durability guarantees the library provides.
