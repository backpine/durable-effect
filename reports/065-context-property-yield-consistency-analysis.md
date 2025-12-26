# Report 065: Context Property Yield Consistency Analysis

## Summary

The jobs package has inconsistent DX around which context properties require `yield*` (Effect-based) vs direct access (synchronous values). This creates confusion for users who must remember the access pattern for each property.

## Current State Analysis

### Legend
- **Effect** = Requires `yield*` to access
- **Direct** = Synchronous value, no `yield*` needed

---

### ContinuousContext\<S\>

| Property | Type | Access |
|----------|------|--------|
| `state` | `Effect<S>` | Effect |
| `setState(s)` | `Effect<void>` | Effect |
| `updateState(fn)` | `Effect<void>` | Effect |
| `terminate(opts)` | `Effect<never>` | Effect |
| `instanceId` | `string` | Direct |
| `runCount` | `number` | Direct |
| `jobName` | `string` | Direct |
| `attempt` | `number` | Direct |
| `isRetry` | `boolean` | Direct |

---

### DebounceEventContext\<I, S\>

| Property | Type | Access |
|----------|------|--------|
| `event` | `I` | Direct |
| `state` | `S` | Direct |
| `eventCount` | `number` | Direct |
| `instanceId` | `string` | Direct |

**Note:** This context is fully synchronous - all properties are direct values.

---

### DebounceExecuteContext\<S\>

| Property | Type | Access |
|----------|------|--------|
| `state` | `Effect<S>` | Effect |
| `eventCount` | `Effect<number>` | Effect |
| `debounceStartedAt` | `Effect<number>` | Effect |
| `instanceId` | `string` | Direct |
| `executionStartedAt` | `number` | Direct |
| `flushReason` | `"maxEvents" \| "flushAfter" \| "manual"` | Direct |
| `attempt` | `number` | Direct |
| `isRetry` | `boolean` | Direct |

---

### TaskEventContext\<S\>

| Property | Type | Access |
|----------|------|--------|
| `state` | `Effect<S \| null>` | Effect |
| `setState(s)` | `Effect<void>` | Effect |
| `updateState(fn)` | `Effect<void>` | Effect |
| `schedule(when)` | `Effect<void>` | Effect |
| `cancelSchedule()` | `Effect<void>` | Effect |
| `getScheduledTime()` | `Effect<number \| null>` | Effect |
| `terminate()` | `Effect<never>` | Effect |
| `eventCount` | `Effect<number>` | Effect |
| `createdAt` | `Effect<number>` | Effect |
| `instanceId` | `string` | Direct |
| `jobName` | `string` | Direct |
| `executionStartedAt` | `number` | Direct |
| `isFirstEvent` | `boolean` | Direct |

---

### TaskExecuteContext\<S\>

| Property | Type | Access |
|----------|------|--------|
| `state` | `Effect<S \| null>` | Effect |
| `setState(s)` | `Effect<void>` | Effect |
| `updateState(fn)` | `Effect<void>` | Effect |
| `schedule(when)` | `Effect<void>` | Effect |
| `cancelSchedule()` | `Effect<void>` | Effect |
| `getScheduledTime()` | `Effect<number \| null>` | Effect |
| `terminate()` | `Effect<never>` | Effect |
| `eventCount` | `Effect<number>` | Effect |
| `createdAt` | `Effect<number>` | Effect |
| `executeCount` | `Effect<number>` | Effect |
| `instanceId` | `string` | Direct |
| `jobName` | `string` | Direct |
| `executionStartedAt` | `number` | Direct |

---

### TaskIdleContext\<S\>

| Property | Type | Access |
|----------|------|--------|
| `state` | `Effect<S \| null>` | Effect |
| `schedule(when)` | `Effect<void>` | Effect |
| `terminate()` | `Effect<never>` | Effect |
| `instanceId` | `string` | Direct |
| `jobName` | `string` | Direct |
| `idleReason` | `"onEvent" \| "execute"` | Direct |

---

### TaskErrorContext\<S\>

| Property | Type | Access |
|----------|------|--------|
| `state` | `Effect<S \| null>` | Effect |
| `updateState(fn)` | `Effect<void>` | Effect |
| `schedule(when)` | `Effect<void>` | Effect |
| `terminate()` | `Effect<never>` | Effect |
| `instanceId` | `string` | Direct |
| `jobName` | `string` | Direct |
| `errorSource` | `"onEvent" \| "execute"` | Direct |

---

### WorkerPoolExecuteContext\<E\>

| Property | Type | Access |
|----------|------|--------|
| `event` | `E` | Direct |
| `eventId` | `string` | Direct |
| `attempt` | `number` | Direct |
| `instanceId` | `string` | Direct |
| `instanceIndex` | `number` | Direct |
| `jobName` | `string` | Direct |

**Note:** This context is fully synchronous - all properties are direct values.

---

## Identified Inconsistencies

### 1. State Access Pattern Varies by Context

| Context | `state` Access |
|---------|----------------|
| `DebounceEventContext` | Direct (`S`) |
| `ContinuousContext` | Effect (`Effect<S>`) |
| `DebounceExecuteContext` | Effect (`Effect<S>`) |
| `TaskEventContext` | Effect (`Effect<S \| null>`) |
| `WorkerPoolExecuteContext` | N/A (uses `event` instead) |

**User confusion:** Same property name, different access patterns.

### 2. Count Properties Vary

| Context | Property | Access |
|---------|----------|--------|
| `ContinuousContext` | `runCount` | Direct |
| `DebounceEventContext` | `eventCount` | Direct |
| `DebounceExecuteContext` | `eventCount` | Effect |
| `TaskEventContext` | `eventCount` | Effect |
| `TaskExecuteContext` | `eventCount` | Effect |
| `TaskExecuteContext` | `executeCount` | Effect |

**User confusion:** `eventCount` is sometimes direct, sometimes Effect.

### 3. Timestamp Properties Vary

| Context | Property | Access |
|---------|----------|--------|
| `DebounceExecuteContext` | `debounceStartedAt` | Effect |
| `DebounceExecuteContext` | `executionStartedAt` | Direct |
| `TaskEventContext` | `executionStartedAt` | Direct |
| `TaskEventContext` | `createdAt` | Effect |

**User confusion:** Similar timestamp properties have different access patterns.

### 4. Naming Inconsistencies

| Concept | Continuous | Task |
|---------|------------|------|
| Execution count | `runCount` | `executeCount` |

### 5. README Shows Incorrect Sync Access

The README shows synchronous access:
```ts
// README example (WRONG)
readonly state: S;
readonly setState: (state: S) => void;
```

But actual types are Effect-based:
```ts
// Actual types
readonly state: Effect.Effect<S, never, never>;
readonly setState: (state: S) => Effect.Effect<void, never, never>;
```

---

## Design Principles for Consistency

### Principle 1: Categorize by Semantic Meaning

| Category | Examples | Should Be |
|----------|----------|-----------|
| **Identity** | `instanceId`, `jobName` | Direct (never changes) |
| **Execution Context** | `attempt`, `isRetry`, `flushReason` | Direct (known at start) |
| **Live Timestamps** | `executionStartedAt` | Direct (captured at start) |
| **State** | `state` | Effect (loaded from storage) |
| **Mutations** | `setState`, `updateState`, `terminate` | Effect (side effects) |
| **Lazy Metadata** | `eventCount`, `createdAt`, `executeCount` | Effect OR Direct |
| **Scheduling** | `schedule`, `cancelSchedule` | Effect (side effects) |

### Principle 2: Make Effects Obvious via Naming

Two options:

**Option A: Verb prefix for Effects**
```typescript
// Effects are verbs (actions)
readonly getState: () => Effect<S>;
readonly setState: (s: S) => Effect<void>;

// Direct values are nouns
readonly instanceId: string;
readonly attempt: number;
```

**Option B: Suffix for Effects**
```typescript
// Effects have Effect suffix
readonly stateEffect: Effect<S>;

// Direct values are plain
readonly instanceId: string;
```

### Principle 3: Consistent Access Within Category

If `eventCount` is Effect in one context, it should be Effect in all contexts (or have a clear reason for the difference).

---

## Recommendations

### Option A: Standardize on Effects (Most Consistent)

Convert all data access to Effects. Users always `yield*` for any data.

```typescript
interface ContinuousContext<S> {
  // All data access is Effect-based
  readonly state: Effect<S>;
  readonly runCount: Effect<number>;
  readonly eventCount: Effect<number>;
  readonly createdAt: Effect<number>;

  // Identity is still direct (truly immutable)
  readonly instanceId: string;
  readonly jobName: string;

  // Mutations are Effects
  readonly setState: (s: S) => Effect<void>;
  readonly terminate: () => Effect<never>;
}
```

**Pros:**
- Maximum consistency
- Users always know to `yield*` for any data
- Enables lazy loading of all values

**Cons:**
- More verbose for simple values
- Breaking change

---

### Option B: Standardize on Direct Access (Best DX)

Eagerly load all values before calling the handler. Users access everything directly.

```typescript
interface ContinuousContext<S> {
  // All data is direct
  readonly state: S;
  readonly runCount: number;
  readonly eventCount: number;
  readonly createdAt: number;
  readonly instanceId: string;
  readonly jobName: string;

  // Only mutations return Effects
  readonly setState: (s: S) => Effect<void>;
  readonly updateState: (fn: (s: S) => S) => Effect<void>;
  readonly terminate: () => Effect<never>;
}
```

**Pros:**
- Best DX - minimal boilerplate
- Clear rule: "data is direct, actions are Effects"
- Matches `DebounceEventContext` pattern

**Cons:**
- Eager loading may be wasteful if values aren't used
- Breaking change

---

### Option C: Naming Convention (Incremental Fix)

Keep existing types but establish clear naming:
- `getX()` → Returns Effect, must yield
- `x` (noun) → Direct value

```typescript
interface TaskExecuteContext<S> {
  // Functions returning Effects
  readonly getState: () => Effect<S | null>;
  readonly getEventCount: () => Effect<number>;
  readonly getCreatedAt: () => Effect<number>;

  // Direct values (captured at context creation)
  readonly instanceId: string;
  readonly executionStartedAt: number;

  // Mutations (always Effects)
  readonly setState: (s: S) => Effect<void>;
  readonly schedule: (when: DurationInput) => Effect<void>;
}
```

**Pros:**
- Self-documenting via naming
- Incremental migration possible
- `get` prefix signals "this is an operation"

**Cons:**
- Breaking change for property names
- Longer property names

---

### Option D: Dual Access (Forward Compatible)

Provide both patterns, deprecate Effect-based over time:

```typescript
interface ContinuousContext<S> {
  // New: Direct access (sync snapshot)
  readonly snapshot: {
    readonly state: S;
    readonly runCount: number;
    readonly eventCount: number;
  };

  // Legacy: Effect-based (deprecated)
  /** @deprecated Use snapshot.state instead */
  readonly state: Effect<S>;

  // Mutations remain Effects
  readonly setState: (s: S) => Effect<void>;
}
```

**Pros:**
- Non-breaking migration path
- Users can adopt at their own pace

**Cons:**
- API surface doubles temporarily
- More complex implementation

---

## Recommended Approach

### Short Term: Fix Documentation
1. Update README to show actual Effect-based types
2. Add clear comments in type definitions explaining what needs `yield*`

### Medium Term: Option C (Naming Convention)
1. Rename Effect-returning properties to `getX()` pattern
2. Keep direct values as noun properties
3. Clear rule: "verbs need yield, nouns don't"

### Long Term: Option B (Direct Access)
1. Eagerly load all values before handler execution
2. Only mutations return Effects
3. Best possible DX

---

## Migration Path

### Phase 1: Documentation (No Breaking Changes)
- Add JSDoc comments with `@example` showing correct access
- Update README with actual types
- Add lint rule or type helper for common mistakes

### Phase 2: Introduce `get` Prefix (Deprecate Old Names)
```typescript
// Old (deprecated)
readonly state: Effect<S>;

// New
readonly getState: () => Effect<S>;
```

### Phase 3: Add Direct Access Options
```typescript
// For contexts where eager loading is acceptable
interface ContinuousContext<S> {
  readonly currentState: S;  // Direct (eagerly loaded)
  readonly getState: () => Effect<S>;  // Effect (lazy)
}
```

### Phase 4: Default to Direct Access
Make direct access the primary pattern, Effect-based becomes opt-in for lazy loading.

---

## Appendix: Full Type Comparison Table

| Context | Property | Current | Recommended |
|---------|----------|---------|-------------|
| Continuous | `state` | Effect | `getState()` or `currentState` |
| Continuous | `runCount` | Direct | Direct (no change) |
| Continuous | `setState` | Effect | Effect (no change) |
| DebounceEvent | `state` | Direct | Direct (no change) |
| DebounceEvent | `eventCount` | Direct | Direct (no change) |
| DebounceExecute | `state` | Effect | `getState()` |
| DebounceExecute | `eventCount` | Effect | `getEventCount()` or Direct |
| DebounceExecute | `debounceStartedAt` | Effect | `getDebounceStartedAt()` or Direct |
| DebounceExecute | `executionStartedAt` | Direct | Direct (no change) |
| TaskEvent | `state` | Effect | `getState()` |
| TaskEvent | `eventCount` | Effect | `getEventCount()` or Direct |
| TaskEvent | `createdAt` | Effect | `getCreatedAt()` or Direct |
| TaskExecute | `state` | Effect | `getState()` |
| TaskExecute | `eventCount` | Effect | `getEventCount()` or Direct |
| TaskExecute | `executeCount` | Effect | `getExecuteCount()` or Direct |
| WorkerPool | `event` | Direct | Direct (no change) |
| WorkerPool | `attempt` | Direct | Direct (no change) |
