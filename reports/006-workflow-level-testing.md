# Workflow-Level Testing Strategy

## Overview

This document outlines the testing infrastructure and test cases for workflow-level behavior in `@durable-effect/workflow`. Unlike unit tests for individual functions (`step`, `sleep`, `retry`), workflow-level tests verify the complete execution cycle:

```
run() → pause → alarm() → resume → complete
```

---

## Test Infrastructure

### Challenge

The engine (`createDurableWorkflows`) creates a Durable Object class that:
1. Extends `DurableObject` from `cloudflare:workers`
2. Uses `this.ctx.storage` for persistence
3. Uses `this.ctx.id` for workflow ID
4. Handles `alarm()` for resumption

We can't use the real Durable Object infrastructure in tests, so we need a lightweight simulation.

### Solution: WorkflowTestHarness

Create a test harness that simulates the workflow execution cycle without the Durable Object class:

```typescript
// test/harness/workflow-harness.ts

export interface WorkflowTestHarness<T> {
  /** The mock storage instance */
  storage: MockStorage;

  /** Run the workflow (simulates initial run()) */
  run(input: T): Promise<WorkflowRunResult>;

  /** Simulate alarm firing (simulates alarm()) */
  triggerAlarm(): Promise<void>;

  /** Get current workflow status */
  getStatus(): Promise<WorkflowStatus | undefined>;

  /** Get completed steps */
  getCompletedSteps(): Promise<string[]>;

  /** Get completed pause index */
  getCompletedPauseIndex(): Promise<number>;

  /** Advance time and trigger alarm if pending */
  advanceTimeAndTrigger(ms: number): Promise<void>;

  /** Run workflow to completion (auto-triggering alarms) */
  runToCompletion(input: T, options?: { maxAlarms?: number }): Promise<void>;
}
```

### Implementation Approach

The harness extracts the core execution logic from the engine:

```typescript
export function createWorkflowHarness<Input, E>(
  workflow: DurableWorkflow<string, Input, E>,
): WorkflowTestHarness<Input> {
  const storage = new MockStorage();
  let workflowId = "test-workflow-id";

  async function executeWorkflow(input: Input): Promise<void> {
    // Create contexts with shared storage
    const execCtx = createMockExecutionContext(storage);
    const workflowCtx = createWorkflowContext(
      workflowId,
      workflow.name,
      input,
      storage as unknown as DurableObjectStorage,
    );

    // Execute workflow effect
    const effect = workflow.definition(input).pipe(
      Effect.provideService(ExecutionContext, execCtx),
      Effect.provideService(WorkflowContext, workflowCtx),
    );

    const result = await Effect.runPromiseExit(effect);

    // Handle result (same logic as engine)
    if (result._tag === "Success") {
      await storage.put("workflow:status", {
        _tag: "Completed",
        completedAt: Date.now(),
      });
    } else if (
      result.cause._tag === "Fail" &&
      result.cause.error instanceof PauseSignal
    ) {
      const signal = result.cause.error;
      await storage.put("workflow:status", {
        _tag: "Paused",
        reason: signal.reason,
        resumeAt: signal.resumeAt,
      });
    } else {
      await storage.put("workflow:status", {
        _tag: "Failed",
        error: result.cause,
        failedAt: Date.now(),
      });
    }
  }

  return {
    storage,

    async run(input: Input) {
      await storage.put("workflow:name", workflow.name);
      await storage.put("workflow:input", input);
      await storage.put("workflow:status", { _tag: "Running" });
      await executeWorkflow(input);
      return { id: workflowId };
    },

    async triggerAlarm() {
      const status = await storage.get<WorkflowStatus>("workflow:status");
      if (status?._tag !== "Paused") return;

      const input = await storage.get<Input>("workflow:input");
      await storage.put("workflow:status", { _tag: "Running" });
      await executeWorkflow(input!);
    },

    async getStatus() {
      return storage.get("workflow:status");
    },

    async getCompletedSteps() {
      return (await storage.get<string[]>("workflow:completedSteps")) ?? [];
    },

    async getCompletedPauseIndex() {
      return (await storage.get<number>("workflow:completedPauseIndex")) ?? 0;
    },

    async advanceTimeAndTrigger(ms: number) {
      vi.advanceTimersByTime(ms);
      const alarm = await storage.getAlarm();
      if (alarm && Date.now() >= alarm) {
        await storage.deleteAlarm();
        await this.triggerAlarm();
      }
    },

    async runToCompletion(input: Input, options = {}) {
      const maxAlarms = options.maxAlarms ?? 10;
      await this.run(input);

      for (let i = 0; i < maxAlarms; i++) {
        const status = await this.getStatus();
        if (status?._tag === "Completed" || status?._tag === "Failed") {
          return;
        }

        const alarm = await storage.getAlarm();
        if (!alarm) break;

        // Advance time to alarm
        vi.setSystemTime(alarm);
        await storage.deleteAlarm();
        await this.triggerAlarm();
      }
    },
  };
}
```

---

## Test Cases: Sleep Behavior

### 1. Single Sleep - Runs Once

**Scenario:** Workflow with one sleep should pause, resume, and complete without re-sleeping.

```typescript
describe("sleep runs once", () => {
  it("sleep executes once and is skipped on resume", async () => {
    let sleepExecutionCount = 0;

    const workflow = Workflow.make("test", (_: void) =>
      Effect.gen(function* () {
        sleepExecutionCount++;
        yield* Workflow.sleep("1 second");
        return "done";
      }),
    );

    const harness = createWorkflowHarness(workflow);
    vi.useFakeTimers();
    vi.setSystemTime(0);

    // Initial run - should pause at sleep
    await harness.run(undefined);
    expect(await harness.getStatus()).toMatchObject({ _tag: "Paused", reason: "sleep" });
    expect(sleepExecutionCount).toBe(1);

    // Trigger alarm - should complete without re-executing sleep body
    vi.setSystemTime(1000);
    await harness.triggerAlarm();
    expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });

    // Sleep was encountered twice (once per run) but only paused once
    expect(sleepExecutionCount).toBe(2); // Effect re-runs, but sleep skips
    expect(await harness.getCompletedPauseIndex()).toBe(1);
  });
});
```

### 2. Multiple Sleeps - Sequential

**Scenario:** Workflow with multiple sleeps should pause at each, resume, and continue.

```typescript
describe("multiple sleeps", () => {
  it("handles two sequential sleeps", async () => {
    const executionLog: string[] = [];

    const workflow = Workflow.make("test", (_: void) =>
      Effect.gen(function* () {
        executionLog.push("before-sleep-1");
        yield* Workflow.sleep("5 seconds");
        executionLog.push("after-sleep-1");
        yield* Workflow.sleep("10 seconds");
        executionLog.push("after-sleep-2");
        return "done";
      }),
    );

    const harness = createWorkflowHarness(workflow);
    vi.useFakeTimers();
    vi.setSystemTime(0);

    // Run 1: Pause at first sleep
    await harness.run(undefined);
    expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });
    expect(await harness.storage.getAlarm()).toBe(5000);
    expect(executionLog).toEqual(["before-sleep-1"]);

    // Run 2: Resume, skip sleep 1, pause at sleep 2
    vi.setSystemTime(5000);
    await harness.triggerAlarm();
    expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });
    expect(await harness.storage.getAlarm()).toBe(15000); // 5000 + 10000
    expect(executionLog).toEqual([
      "before-sleep-1",
      "before-sleep-1", // Re-executed
      "after-sleep-1",  // First sleep skipped, continued
    ]);

    // Run 3: Resume, skip both sleeps, complete
    vi.setSystemTime(15000);
    await harness.triggerAlarm();
    expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
    expect(executionLog).toEqual([
      "before-sleep-1",
      "before-sleep-1",
      "after-sleep-1",
      "before-sleep-1", // Re-executed again
      "after-sleep-1",  // Both sleeps skipped
      "after-sleep-2",
    ]);
    expect(await harness.getCompletedPauseIndex()).toBe(2);
  });
});
```

### 3. Sleep After Step

**Scenario:** Workflow with steps and sleeps should cache steps and track sleeps independently.

```typescript
describe("sleep with steps", () => {
  it("steps are cached, sleeps are tracked by index", async () => {
    let stepExecutions = 0;

    const workflow = Workflow.make("test", (_: void) =>
      Effect.gen(function* () {
        const value = yield* Workflow.step("fetch", Effect.sync(() => {
          stepExecutions++;
          return 42;
        }));

        yield* Workflow.sleep("1 second");

        return value * 2;
      }),
    );

    const harness = createWorkflowHarness(workflow);
    vi.useFakeTimers();
    vi.setSystemTime(0);

    // Run 1: Execute step, pause at sleep
    await harness.run(undefined);
    expect(stepExecutions).toBe(1);
    expect(await harness.getCompletedSteps()).toEqual(["fetch"]);
    expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

    // Run 2: Step cached, sleep skipped, complete
    vi.setSystemTime(1000);
    await harness.triggerAlarm();
    expect(stepExecutions).toBe(1); // Step NOT re-executed
    expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
  });
});
```

### 4. Conditional Sleep (Deterministic)

**Scenario:** Sleep inside a conditional that's determined by a cached step result.

```typescript
describe("conditional sleep", () => {
  it("handles sleep in conditional branch (deterministic)", async () => {
    const workflow = Workflow.make("test", (shouldSleep: boolean) =>
      Effect.gen(function* () {
        const condition = yield* Workflow.step("check", Effect.succeed(shouldSleep));

        if (condition) {
          yield* Workflow.sleep("5 seconds");
        }

        yield* Workflow.sleep("1 second"); // Always runs

        return "done";
      }),
    );

    // Test with shouldSleep = true
    const harness1 = createWorkflowHarness(workflow);
    vi.useFakeTimers();
    vi.setSystemTime(0);

    await harness1.run(true);
    expect(await harness1.getStatus()).toMatchObject({ _tag: "Paused" });
    expect(await harness1.storage.getAlarm()).toBe(5000); // First sleep

    vi.setSystemTime(5000);
    await harness1.triggerAlarm();
    expect(await harness1.storage.getAlarm()).toBe(6000); // Second sleep

    vi.setSystemTime(6000);
    await harness1.triggerAlarm();
    expect(await harness1.getStatus()).toMatchObject({ _tag: "Completed" });
    expect(await harness1.getCompletedPauseIndex()).toBe(2);

    // Test with shouldSleep = false
    const harness2 = createWorkflowHarness(workflow);
    vi.setSystemTime(0);

    await harness2.run(false);
    expect(await harness2.getStatus()).toMatchObject({ _tag: "Paused" });
    expect(await harness2.storage.getAlarm()).toBe(1000); // Only second sleep

    vi.setSystemTime(1000);
    await harness2.triggerAlarm();
    expect(await harness2.getStatus()).toMatchObject({ _tag: "Completed" });
    expect(await harness2.getCompletedPauseIndex()).toBe(1); // Only one sleep
  });
});
```

### 5. runToCompletion Helper

**Scenario:** Convenience method to run workflow through all alarms.

```typescript
describe("runToCompletion", () => {
  it("automatically triggers all alarms until complete", async () => {
    const workflow = Workflow.make("test", (_: void) =>
      Effect.gen(function* () {
        yield* Workflow.sleep("1 second");
        yield* Workflow.sleep("2 seconds");
        yield* Workflow.sleep("3 seconds");
        return "done";
      }),
    );

    const harness = createWorkflowHarness(workflow);
    vi.useFakeTimers();
    vi.setSystemTime(0);

    await harness.runToCompletion(undefined);

    expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
    expect(await harness.getCompletedPauseIndex()).toBe(3);
  });

  it("respects maxAlarms limit", async () => {
    const workflow = Workflow.make("test", (_: void) =>
      Effect.gen(function* () {
        for (let i = 0; i < 100; i++) {
          yield* Workflow.sleep("1 second");
        }
        return "done";
      }),
    );

    const harness = createWorkflowHarness(workflow);
    vi.useFakeTimers();
    vi.setSystemTime(0);

    await harness.runToCompletion(undefined, { maxAlarms: 5 });

    // Should stop after 5 alarms, not complete
    expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });
    expect(await harness.getCompletedPauseIndex()).toBe(5);
  });
});
```

---

## Test Cases: Edge Cases

### 6. Zero Duration Sleep

```typescript
it("handles zero duration sleep", async () => {
  const workflow = Workflow.make("test", (_: void) =>
    Effect.gen(function* () {
      yield* Workflow.sleep(0);
      return "done";
    }),
  );

  const harness = createWorkflowHarness(workflow);
  vi.useFakeTimers();
  vi.setSystemTime(1000);

  await harness.run(undefined);
  expect(await harness.storage.getAlarm()).toBe(1000); // Immediate

  await harness.triggerAlarm();
  expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
});
```

### 7. Very Long Sleep

```typescript
it("handles very long sleep (days)", async () => {
  const workflow = Workflow.make("test", (_: void) =>
    Effect.gen(function* () {
      yield* Workflow.sleep(Duration.days(7));
      return "done";
    }),
  );

  const harness = createWorkflowHarness(workflow);
  vi.useFakeTimers();
  vi.setSystemTime(0);

  await harness.run(undefined);
  const expectedAlarm = 7 * 24 * 60 * 60 * 1000;
  expect(await harness.storage.getAlarm()).toBe(expectedAlarm);

  vi.setSystemTime(expectedAlarm);
  await harness.triggerAlarm();
  expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
});
```

### 8. Sleep Index Persists Across Runs

```typescript
it("completedPauseIndex persists correctly", async () => {
  const workflow = Workflow.make("test", (_: void) =>
    Effect.gen(function* () {
      yield* Workflow.sleep("1 second");
      yield* Workflow.sleep("1 second");
      yield* Workflow.sleep("1 second");
      return "done";
    }),
  );

  const harness = createWorkflowHarness(workflow);
  vi.useFakeTimers();
  vi.setSystemTime(0);

  await harness.run(undefined);
  expect(await harness.getCompletedPauseIndex()).toBe(0); // Not yet completed

  vi.setSystemTime(1000);
  await harness.triggerAlarm();
  expect(await harness.getCompletedPauseIndex()).toBe(1);

  vi.setSystemTime(2000);
  await harness.triggerAlarm();
  expect(await harness.getCompletedPauseIndex()).toBe(2);

  vi.setSystemTime(3000);
  await harness.triggerAlarm();
  expect(await harness.getCompletedPauseIndex()).toBe(3);
  expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
});
```

---

## File Structure

```
packages/workflow/test/
├── mocks/
│   ├── storage.ts           # MockStorage (existing)
│   ├── contexts.ts          # Mock context factories (existing)
│   └── index.ts
├── harness/
│   ├── workflow-harness.ts  # WorkflowTestHarness implementation
│   └── index.ts
├── unit/
│   ├── step.test.ts         # Existing
│   └── sleep.test.ts        # Existing
└── workflow/
    ├── sleep-lifecycle.test.ts    # Sleep runs once, multiple sleeps
    ├── step-and-sleep.test.ts     # Steps + sleeps together
    └── edge-cases.test.ts         # Zero duration, long sleep, etc.
```

---

## Prerequisites

Before implementing these tests, the following changes are needed:

### 1. Update WorkflowContext Interface

Add pause tracking methods per `reports/005-pause-point-tracking.md`:

```typescript
export interface WorkflowContextService {
  // ... existing ...

  nextPauseIndex: Effect.Effect<number, never>;
  completedPauseIndex: Effect.Effect<number, UnknownException>;
  setCompletedPauseIndex: (index: number) => Effect.Effect<void, UnknownException>;
  pendingResumeAt: Effect.Effect<Option<number>, UnknownException>;
  setPendingResumeAt: (time: number) => Effect.Effect<void, UnknownException>;
  clearPendingResumeAt: Effect.Effect<void, UnknownException>;
}
```

### 2. Update createWorkflowContext Factory

Add the runtime pause counter and storage methods.

### 3. Update Workflow.sleep

Implement the pause index tracking logic.

### 4. Update Mock Contexts

Update `createMockWorkflowContext` to include the new pause tracking methods.

---

## Summary

The workflow-level testing strategy focuses on:

1. **WorkflowTestHarness** - Simulates the run → pause → alarm → resume cycle
2. **Sleep lifecycle tests** - Verify sleep runs once and is skipped on resume
3. **Multiple sleep tests** - Verify correct ordering with completedPauseIndex
4. **Integration tests** - Steps + sleeps working together
5. **Edge cases** - Zero duration, long duration, index persistence

This testing infrastructure will be reusable for future primitives like `wait` and `retry` workflow-level behavior.
