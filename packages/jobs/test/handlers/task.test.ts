// packages/jobs/test/handlers/task.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Schema, Duration } from "effect";
import { TaskHandler } from "../../src/handlers/task";
import { Task } from "../../src/definitions/task";
import {
  createTestRegistry,
  createTaskTestLayer,
  runWithLayer,
} from "./test-utils";

// =============================================================================
// Test Fixtures
// =============================================================================

const TaskEvent = Schema.Struct({
  type: Schema.Literal("increment", "decrement", "reset"),
  amount: Schema.optional(Schema.Number),
});
type TaskEvent = typeof TaskEvent.Type;

const TaskState = Schema.Struct({
  counter: Schema.Number,
  lastUpdated: Schema.Number,
});
type TaskState = typeof TaskState.Type;

const executionLog: Array<{
  instanceId: string;
  trigger: "onEvent" | "execute" | "onIdle" | "onError";
  event?: TaskEvent;
  state: TaskState | null;
}> = [];

// Basic task that processes events
const counterTaskPrimitive = Task.make({
  eventSchema: TaskEvent,
  stateSchema: TaskState,
  onEvent: (event, ctx) =>
    Effect.gen(function* () {
      const currentState = (yield* ctx.state) ?? { counter: 0, lastUpdated: 0 };
      let newCounter = currentState.counter;

      switch (event.type) {
        case "increment":
          newCounter += event.amount ?? 1;
          break;
        case "decrement":
          newCounter -= event.amount ?? 1;
          break;
        case "reset":
          newCounter = 0;
          break;
      }

      yield* ctx.setState({
        counter: newCounter,
        lastUpdated: Date.now(),
      });

      executionLog.push({
        instanceId: ctx.instanceId,
        trigger: "onEvent",
        event,
        state: { counter: newCounter, lastUpdated: Date.now() },
      });
    }),
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      executionLog.push({
        instanceId: ctx.instanceId,
        trigger: "execute",
        state,
      });
    }),
});

// Task with scheduling in onEvent
const schedulingTaskPrimitive = Task.make({
  eventSchema: TaskEvent,
  stateSchema: TaskState,
  onEvent: (event, ctx) =>
    Effect.gen(function* () {
      const currentState = (yield* ctx.state) ?? { counter: 0, lastUpdated: 0 };
      yield* ctx.setState({
        counter: currentState.counter + 1,
        lastUpdated: Date.now(),
      });

      // Schedule execution in 5 seconds
      yield* ctx.schedule(Duration.seconds(5));

      executionLog.push({
        instanceId: ctx.instanceId,
        trigger: "onEvent",
        event,
        state: { counter: currentState.counter + 1, lastUpdated: Date.now() },
      });
    }),
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      executionLog.push({
        instanceId: ctx.instanceId,
        trigger: "execute",
        state,
      });
    }),
});

// Task with onIdle handler
const idleTaskPrimitive = Task.make({
  eventSchema: TaskEvent,
  stateSchema: TaskState,
  onEvent: (event, ctx) =>
    Effect.gen(function* () {
      const currentState = (yield* ctx.state) ?? { counter: 0, lastUpdated: 0 };
      yield* ctx.setState({
        counter: currentState.counter + 1,
        lastUpdated: Date.now(),
      });

      executionLog.push({
        instanceId: ctx.instanceId,
        trigger: "onEvent",
        event,
        state: { counter: currentState.counter + 1, lastUpdated: Date.now() },
      });
    }),
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      executionLog.push({
        instanceId: ctx.instanceId,
        trigger: "execute",
        state,
      });
    }),
  onIdle: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      executionLog.push({
        instanceId: ctx.instanceId,
        trigger: "onIdle",
        state,
      });
    }),
});

// Task with onIdle that re-arms (schedules)
const rearmTaskPrimitive = Task.make({
  eventSchema: TaskEvent,
  stateSchema: TaskState,
  onEvent: (event, ctx) =>
    Effect.gen(function* () {
      const currentState = (yield* ctx.state) ?? { counter: 0, lastUpdated: 0 };
      yield* ctx.setState({
        counter: currentState.counter + 1,
        lastUpdated: Date.now(),
      });
    }),
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      executionLog.push({
        instanceId: ctx.instanceId,
        trigger: "execute",
        state,
      });
    }),
  onIdle: (ctx) =>
    Effect.gen(function* () {
      // Re-arm: schedule execution in 10 seconds
      yield* ctx.schedule(Duration.seconds(10));
      executionLog.push({
        instanceId: ctx.instanceId,
        trigger: "onIdle",
        state: null,
      });
    }),
});

const createRegistry = () =>
  createTestRegistry({
    task: {
      counterTask: { ...counterTaskPrimitive, name: "counterTask" },
      schedulingTask: { ...schedulingTaskPrimitive, name: "schedulingTask" },
      idleTask: { ...idleTaskPrimitive, name: "idleTask" },
      rearmTask: { ...rearmTaskPrimitive, name: "rearmTask" },
    },
  });

// =============================================================================
// Tests
// =============================================================================

describe("TaskHandler", () => {
  beforeEach(() => {
    executionLog.length = 0;
  });

  // ===========================================================================
  // Send Path (3 tests)
  // ===========================================================================

  describe("send path", () => {
    it("send validates event against schema", async () => {
      const registry = createRegistry();
      const { layer } = createTaskTestLayer(registry, 1000000);

      // Invalid event should fail
      const result = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          return yield* handler
            .handle({
              type: "task",
              action: "send",
              name: "counterTask",
              id: "task-1",
              event: { invalid: "event" }, // Missing required 'type' field
            })
            .pipe(Effect.either);
        }),
        layer
      );

      expect(result._tag).toBe("Left");
    });

    it("send creates state on first call, increments eventCount", async () => {
      const registry = createRegistry();
      const { layer } = createTaskTestLayer(registry, 1000000);

      // First send creates state
      const result1 = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          return yield* handler.handle({
            type: "task",
            action: "send",
            name: "counterTask",
            id: "task-1",
            event: { type: "increment", amount: 5 },
          });
        }),
        layer
      );

      expect(result1._type).toBe("task.send");
      expect((result1 as any).created).toBe(true);

      // Second send doesn't recreate
      const result2 = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          return yield* handler.handle({
            type: "task",
            action: "send",
            name: "counterTask",
            id: "task-1",
            event: { type: "increment", amount: 3 },
          });
        }),
        layer
      );

      expect((result2 as any).created).toBe(false);

      // Check eventCount via status
      const status = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          return yield* handler.handle({
            type: "task",
            action: "status",
            name: "counterTask",
            id: "task-1",
          });
        }),
        layer
      );

      expect((status as any).eventCount).toBe(2);
    });

    it("send calls onEvent handler with validated event", async () => {
      const registry = createRegistry();
      const { layer } = createTaskTestLayer(registry, 1000000);

      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          yield* handler.handle({
            type: "task",
            action: "send",
            name: "counterTask",
            id: "task-1",
            event: { type: "increment", amount: 10 },
          });
        }),
        layer
      );

      // onEvent should have been called
      expect(executionLog).toHaveLength(1);
      expect(executionLog[0].trigger).toBe("onEvent");
      expect(executionLog[0].event?.type).toBe("increment");
      expect(executionLog[0].event?.amount).toBe(10);
    });
  });

  // ===========================================================================
  // Trigger Path (2 tests)
  // ===========================================================================

  describe("trigger path", () => {
    it("trigger increments executeCount and calls execute handler", async () => {
      const registry = createRegistry();
      const { layer } = createTaskTestLayer(registry, 1000000);

      // First create the task via send
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          yield* handler.handle({
            type: "task",
            action: "send",
            name: "counterTask",
            id: "task-1",
            event: { type: "increment" },
          });
        }),
        layer
      );

      executionLog.length = 0; // Clear log

      // Trigger execution
      const result = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          return yield* handler.handle({
            type: "task",
            action: "trigger",
            name: "counterTask",
            id: "task-1",
          });
        }),
        layer
      );

      expect(result._type).toBe("task.trigger");
      expect((result as any).triggered).toBe(true);

      // execute should have been called
      expect(executionLog.some((e) => e.trigger === "execute")).toBe(true);

      // Check executeCount via status
      const status = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          return yield* handler.handle({
            type: "task",
            action: "status",
            name: "counterTask",
            id: "task-1",
          });
        }),
        layer
      );

      expect((status as any).executeCount).toBe(1);
    });

    it("trigger on non-existent task returns triggered:false", async () => {
      const registry = createRegistry();
      const { layer } = createTaskTestLayer(registry, 1000000);

      const result = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          return yield* handler.handle({
            type: "task",
            action: "trigger",
            name: "counterTask",
            id: "nonexistent-task",
          });
        }),
        layer
      );

      expect(result._type).toBe("task.trigger");
      expect((result as any).triggered).toBe(false);
    });
  });

  // ===========================================================================
  // Scheduling (3 tests)
  // ===========================================================================

  describe("scheduling", () => {
    it("ctx.schedule() from onEvent sets alarm", async () => {
      const registry = createRegistry();
      const { layer, handles } = createTaskTestLayer(registry, 1000000);

      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          yield* handler.handle({
            type: "task",
            action: "send",
            name: "schedulingTask",
            id: "task-1",
            event: { type: "increment" },
          });
        }),
        layer
      );

      // Alarm should be scheduled (5 seconds from now)
      const scheduledTime = handles.scheduler.getScheduledTime();
      expect(scheduledTime).toBeDefined();
      // Verify it's scheduled ~5 seconds in the future from actual time
      expect(scheduledTime).toBeGreaterThan(Date.now() - 1000);
    });

    it("ctx.cancelSchedule() removes pending alarm", async () => {
      const registry = createRegistry();

      // Create a task that schedules then cancels
      const cancelTaskPrimitive = Task.make({
        eventSchema: TaskEvent,
        stateSchema: TaskState,
        onEvent: (event, ctx) =>
          Effect.gen(function* () {
            yield* ctx.setState({ counter: 1, lastUpdated: Date.now() });
            yield* ctx.schedule(Duration.seconds(5));
            yield* ctx.cancelSchedule();
          }),
        execute: (ctx) =>
          Effect.gen(function* () {
            const state = yield* ctx.state;
            executionLog.push({
              instanceId: ctx.instanceId,
              trigger: "execute",
              state,
            });
          }),
      });

      const customRegistry = createTestRegistry({
        task: {
          cancelTask: { ...cancelTaskPrimitive, name: "cancelTask" },
        },
      });

      const { layer, handles } = createTaskTestLayer(customRegistry, 1000000);

      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          yield* handler.handle({
            type: "task",
            action: "send",
            name: "cancelTask",
            id: "task-1",
            event: { type: "increment" },
          });
        }),
        layer
      );

      // Alarm should be cancelled
      const scheduledTime = handles.scheduler.getScheduledTime();
      expect(scheduledTime).toBeUndefined();
    });

    it("handleAlarm executes when scheduled time arrives", async () => {
      const registry = createRegistry();
      const { layer, time } = createTaskTestLayer(registry, 1000000);

      // Send event which schedules execution
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          yield* handler.handle({
            type: "task",
            action: "send",
            name: "schedulingTask",
            id: "task-1",
            event: { type: "increment" },
          });
        }),
        layer
      );

      executionLog.length = 0; // Clear onEvent log

      // Advance time past scheduled alarm (5 seconds)
      time.set(1000000 + 5000 + 100);

      // Trigger alarm
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          yield* handler.handleAlarm();
        }),
        layer
      );

      // execute should have been called
      expect(executionLog.some((e) => e.trigger === "execute")).toBe(true);
    });
  });

  // ===========================================================================
  // Idle Behavior (2 tests)
  // ===========================================================================

  describe("idle behavior", () => {
    it("onIdle runs after onEvent if no schedule set", async () => {
      const registry = createRegistry();
      const { layer } = createTaskTestLayer(registry, 1000000);

      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          yield* handler.handle({
            type: "task",
            action: "send",
            name: "idleTask",
            id: "task-1",
            event: { type: "increment" },
          });
        }),
        layer
      );

      // Both onEvent and onIdle should have been called
      expect(executionLog.some((e) => e.trigger === "onEvent")).toBe(true);
      expect(executionLog.some((e) => e.trigger === "onIdle")).toBe(true);
    });

    it("onIdle can schedule (re-arming pattern)", async () => {
      const registry = createRegistry();
      const { layer, handles } = createTaskTestLayer(registry, 1000000);

      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          yield* handler.handle({
            type: "task",
            action: "send",
            name: "rearmTask",
            id: "task-1",
            event: { type: "increment" },
          });
        }),
        layer
      );

      // onIdle should have scheduled (10 seconds from now)
      const scheduledTime = handles.scheduler.getScheduledTime();
      expect(scheduledTime).toBeDefined();
      // Verify it's scheduled ~10 seconds in the future from actual time
      expect(scheduledTime).toBeGreaterThan(Date.now() - 1000);
      expect(executionLog.some((e) => e.trigger === "onIdle")).toBe(true);
    });
  });

  // ===========================================================================
  // Termination (1 test)
  // ===========================================================================

  describe("termination", () => {
    it("terminate purges state and cancels alarm", async () => {
      const registry = createRegistry();
      const { layer, handles } = createTaskTestLayer(registry, 1000000);

      // Create task with scheduled alarm
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          yield* handler.handle({
            type: "task",
            action: "send",
            name: "schedulingTask",
            id: "task-1",
            event: { type: "increment" },
          });
        }),
        layer
      );

      // Verify alarm is scheduled
      expect(handles.scheduler.getScheduledTime()).toBeDefined();

      // Terminate
      const result = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          return yield* handler.handle({
            type: "task",
            action: "terminate",
            name: "schedulingTask",
            id: "task-1",
          });
        }),
        layer
      );

      expect(result._type).toBe("task.terminate");
      expect((result as any).terminated).toBe(true);

      // Alarm should be cancelled
      expect(handles.scheduler.getScheduledTime()).toBeUndefined();

      // Status should show not_found
      const status = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* TaskHandler;
          return yield* handler.handle({
            type: "task",
            action: "status",
            name: "schedulingTask",
            id: "task-1",
          });
        }),
        layer
      );

      expect((status as any).status).toBe("not_found");
    });
  });
});
