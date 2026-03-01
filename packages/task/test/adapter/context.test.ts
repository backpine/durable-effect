import { describe, it, expect } from "vitest";
import { Effect, Schema } from "effect";
import { createTaskContext } from "../../src/adapter/context.js";
import { createTestStore } from "../../src/testing/store.js";
import { createTestScheduler } from "../../src/testing/scheduler.js";
import { KEYS } from "../../src/adapter/keys.js";

const TestState = Schema.Struct({ count: Schema.Number });
type TestState = typeof TestState.Type;

function setup(nowMs = 1000) {
  const { handle: store } = createTestStore();
  const { handle: scheduler } = createTestScheduler();
  const ctx = createTaskContext({
    store,
    scheduler,
    instance: { id: "inst-1", name: "test-task" },
    stateSchema: TestState,
    now: () => nowMs,
  });
  return { ctx, store, scheduler };
}

describe("createTaskContext", () => {
  it("recall returns null when no state saved", async () => {
    const { ctx } = setup();
    const result = await Effect.runPromise(ctx.recall());
    expect(result).toBeNull();
  });

  it("save then recall round-trips state", async () => {
    const { ctx } = setup();
    await Effect.runPromise(ctx.save({ count: 42 }));
    const result = await Effect.runPromise(ctx.recall());
    expect(result).toEqual({ count: 42 });
  });

  it("update modifies existing state", async () => {
    const { ctx } = setup();
    await Effect.runPromise(ctx.save({ count: 10 }));
    await Effect.runPromise(ctx.update((s) => ({ count: s.count + 5 })));
    const result = await Effect.runPromise(ctx.recall());
    expect(result).toEqual({ count: 15 });
  });

  it("update is a no-op when no state exists", async () => {
    const { ctx, store } = setup();
    await Effect.runPromise(ctx.update((s) => ({ count: s.count + 1 })));
    expect(store.has(KEYS.STATE)).toBe(false);
  });

  it("scheduleIn sets alarm relative to now", async () => {
    const { ctx, scheduler, store } = setup(5000);
    await Effect.runPromise(ctx.scheduleIn(3000));
    expect(scheduler.getScheduledTime()).toBe(8000);
    expect(store.has(KEYS.ALARM)).toBe(true);
  });

  it("scheduleAt sets absolute alarm", async () => {
    const { ctx, scheduler, store } = setup();
    await Effect.runPromise(ctx.scheduleAt(9999));
    expect(scheduler.getScheduledTime()).toBe(9999);
    expect(store.has(KEYS.ALARM)).toBe(true);
  });

  it("scheduleAt accepts a Date", async () => {
    const { ctx, scheduler } = setup();
    const date = new Date(12345);
    await Effect.runPromise(ctx.scheduleAt(date));
    expect(scheduler.getScheduledTime()).toBe(12345);
  });

  it("cancelSchedule removes alarm", async () => {
    const { ctx, scheduler, store } = setup();
    await Effect.runPromise(ctx.scheduleAt(5000));
    await Effect.runPromise(ctx.cancelSchedule());
    expect(scheduler.isScheduled()).toBe(false);
    expect(store.has(KEYS.ALARM)).toBe(false);
  });

  it("nextAlarm returns scheduled time", async () => {
    const { ctx } = setup();
    await Effect.runPromise(ctx.scheduleAt(7777));
    const result = await Effect.runPromise(ctx.nextAlarm());
    expect(result).toBe(7777);
  });

  it("nextAlarm returns null when no alarm", async () => {
    const { ctx } = setup();
    const result = await Effect.runPromise(ctx.nextAlarm());
    expect(result).toBeNull();
  });

  it("exposes id and name from instance", () => {
    const { ctx } = setup();
    expect(ctx.id).toBe("inst-1");
    expect(ctx.name).toBe("test-task");
  });
});
