# Handler Testing Strategy

This document defines a minimal, high-value testing strategy for job handlers in `packages/jobs`. The goal is comprehensive coverage of critical behaviors while avoiding test bloat that makes maintenance difficult.

## Design Principles

1. **Test handler-specific logic, not shared infrastructure** - Services like MetadataService, AlarmService, and RetryExecutor have their own tests. Handler tests should focus on how handlers orchestrate these services, not re-test the services themselves.

2. **Focus on state machine transitions** - Each handler is fundamentally a state machine. Test valid transitions and ensure invalid transitions are rejected.

3. **Test integration seams** - The points where handlers call services are where bugs hide. Test that handlers pass correct arguments and handle responses properly.

4. **Prioritize edge cases over happy paths** - Happy paths are usually simple. Edge cases (races, missing data, retry scenarios) are where complexity lives.

5. **One test per behavior** - Avoid testing the same behavior multiple ways. If `start` creates metadata, one test is enough.

---

## Handler Architecture Summary

| Handler | Execution Model | Unique Complexity |
|---------|-----------------|-------------------|
| **Continuous** | Schedule-driven loop | runCount tracking, startImmediately flag, schedule-after-execute |
| **Debounce** | Event accumulation → flush | onEvent reducer, maxEvents trigger, timeout flush, purge-on-success |
| **Task** | Dual-mode (event + execute) | Three context types, scheduling API, onIdle re-arming |

### Shared Infrastructure (tested elsewhere)
- `JobExecutionService` - Handles state loading, retry signals, event emission
- `RetryExecutor` - Attempt tracking, delay scheduling, exhaustion detection
- `MetadataService` - CRUD for job metadata
- `AlarmService` - Schedule/cancel alarms
- `CleanupService` - Atomic termination

---

## Continuous Handler Tests

### What Makes Continuous Unique
- `runCount` increments each execution (not on retry)
- `startImmediately` flag controls first execution
- Automatic scheduling after each execution
- Alarm-driven execution loop

### Critical Test Cases

#### 1. Start Action (3 tests)
```
✓ start creates metadata and executes immediately (default)
✓ start with startImmediately:false schedules without executing
✓ start on existing instance returns existing (idempotent)
```

#### 2. Execution Loop (3 tests)
```
✓ handleAlarm increments runCount and schedules next
✓ handleAlarm skips if job is terminated (no error)
✓ trigger forces immediate execution and schedules next
```

#### 3. Termination (2 tests)
```
✓ terminate action purges all storage and cancels alarm
✓ ctx.terminate() from execute triggers cleanup
```

#### 4. State & Status (2 tests)
```
✓ getState returns current state after mutations
✓ status returns running/terminated correctly
```

#### 5. Error Handling (1 test)
```
✓ execution failure without retry config propagates error
```

**Total: 11 tests**

### What NOT to Test
- Retry scheduling/exhaustion (tested in RetryExecutor tests)
- Metadata persistence details (tested in MetadataService tests)
- Alarm scheduling mechanics (tested in AlarmService tests)
- Event emission (tested in tracking.test.ts)

---

## Debounce Handler Tests

### What Makes Debounce Unique
- `onEvent` reducer accumulates state
- Three flush triggers: maxEvents, timeout, manual
- Purges state on successful flush
- eventCount tracking

### Critical Test Cases

#### 1. Event Accumulation (3 tests)
```
✓ first add creates metadata, sets startedAt, schedules timeout
✓ add calls onEvent reducer and persists updated state
✓ eventCount increments correctly across adds
```

#### 2. Flush Triggers (3 tests)
```
✓ maxEvents triggers immediate flush (no waiting for timeout)
✓ handleAlarm flushes when timeout fires
✓ manual flush executes regardless of eventCount
```

#### 3. Flush Behavior (2 tests)
```
✓ successful flush purges all state
✓ flush on empty buffer purges without executing
```

#### 4. Clear & Status (2 tests)
```
✓ clear discards buffered events without executing
✓ status returns eventCount and scheduled flush time
```

**Total: 10 tests**

### What NOT to Test
- onEvent reducer logic in isolation (user code)
- Exact timing of flushAfter (AlarmService concern)
- Retry during flush (JobExecutionService concern)

---

## Task Handler Tests

### What Makes Task Unique
- Two entry points: `send` (event) and `trigger` (no event)
- Three execution handlers: `onEvent`, `execute`, `onIdle`
- Scheduling API available in context
- eventCount vs executeCount tracking

### Critical Test Cases

#### 1. Send Path (3 tests)
```
✓ send validates event against schema
✓ send creates state on first call, increments eventCount
✓ send calls onEvent handler with validated event
```

#### 2. Trigger Path (2 tests)
```
✓ trigger increments executeCount and calls execute handler
✓ trigger on non-existent task returns not-found error
```

#### 3. Scheduling (3 tests)
```
✓ ctx.schedule() from onEvent sets alarm
✓ ctx.cancelSchedule() removes pending alarm
✓ handleAlarm executes when scheduled time arrives
```

#### 4. Idle Behavior (2 tests)
```
✓ onIdle runs after onEvent/execute if no schedule set
✓ onIdle can schedule (re-arming pattern)
```

#### 5. Termination (1 test)
```
✓ terminate purges state and cancels alarm
```

**Total: 11 tests**

### What NOT to Test
- Schema validation mechanics (Effect Schema concern)
- Context creation details (implementation detail)
- Multiple context types separately (same underlying machinery)

---

## Cross-Cutting Tests (tracking.test.ts)

Event tracking tests apply to all handlers. Keep in a single file.

### Critical Test Cases (6 tests)
```
✓ job.executed event emitted on success with preExecutionState
✓ job.failed event emitted on error with preExecutionState
✓ job.failed with willRetry:true when retry scheduled
✓ job.retryExhausted event when retries exhausted
✓ events include correct jobType, jobName, instanceId
✓ durationMs calculated correctly in executed events
```

---

## Test Infrastructure

### Shared Test Setup
Create a `test/handlers/test-utils.ts` with:

```typescript
// Minimal registry factory
export const createTestRegistry = (overrides?: Partial<RuntimeJobRegistry>) => ({
  continuous: {},
  debounce: {},
  task: {},
  workerPool: {},
  ...overrides,
});

// Layer factory for each handler type
export const createContinuousTestLayer = (registry: RuntimeJobRegistry, initialTime?: number) => {...};
export const createDebounceTestLayer = (registry: RuntimeJobRegistry, initialTime?: number) => {...};
export const createTaskTestLayer = (registry: RuntimeJobRegistry, initialTime?: number) => {...};

// Run helper to handle type casting
export const runWithLayer = <A, E>(
  effect: Effect.Effect<A, E, any>,
  layer: Layer.Layer<any>
): Promise<A> => {...};
```

### Test File Organization
```
test/handlers/
├── test-utils.ts           # Shared factories and helpers
├── continuous.test.ts      # 11 tests
├── debounce.test.ts        # 10 tests
├── task.test.ts            # 11 tests
└── tracking.test.ts        # 6 tests (cross-cutting)
```

---

## Test Count Summary

| File | Tests | Coverage Focus |
|------|-------|----------------|
| continuous.test.ts | 11 | State machine, scheduling loop |
| debounce.test.ts | 10 | Accumulation, flush triggers |
| task.test.ts | 11 | Dual-mode, scheduling API |
| tracking.test.ts | 6 | Event emission |
| **Total** | **38** | |

This is a 50% reduction from testing every permutation while maintaining coverage of all critical behaviors.

---

## What This Strategy Explicitly Excludes

1. **Service unit tests** - MetadataService, AlarmService, etc. have separate test files
2. **Retry logic tests** - RetryExecutor has its own tests
3. **Schema validation** - Effect Schema is well-tested upstream
4. **Permutation testing** - Don't test start→trigger→terminate AND start→terminate→trigger separately
5. **Internal implementation** - Don't test private helpers or intermediate states
6. **Timing edge cases** - Handled at scheduler/alarm level

---

## Implementation Priority

1. **Phase 1**: Create `test-utils.ts` with shared infrastructure
2. **Phase 2**: Implement `debounce.test.ts` (currently missing)
3. **Phase 3**: Implement `task.test.ts` (currently missing)
4. **Phase 4**: Refactor `continuous.test.ts` to use shared utils and remove redundant tests
5. **Phase 5**: Consolidate tracking tests if split across files

---

## Maintenance Guidelines

### When to Add Tests
- New handler action added
- Bug fix reveals untested edge case
- New service integration point

### When NOT to Add Tests
- Refactoring internals (behavior unchanged)
- Adding logging/tracing
- Performance improvements

### Test Smell Indicators
- Test name includes "and" (testing multiple things)
- Test requires more than 3 setup steps
- Test duplicates another test with different input values
- Test mocks more than 2 services
