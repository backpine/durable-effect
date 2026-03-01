import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { createTestScheduler } from "../../src/testing/scheduler.js";

describe("Scheduler (in-memory)", () => {
  it("schedule sets a timestamp", async () => {
    const { handle } = createTestScheduler();
    await Effect.runPromise(handle.schedule(1000));
    expect(handle.getScheduledTime()).toBe(1000);
    expect(handle.isScheduled()).toBe(true);
  });

  it("cancel clears the scheduled time", async () => {
    const { handle } = createTestScheduler();
    await Effect.runPromise(handle.schedule(1000));
    await Effect.runPromise(handle.cancel());
    expect(handle.getScheduledTime()).toBeNull();
    expect(handle.isScheduled()).toBe(false);
  });

  it("getNext returns null when nothing scheduled", async () => {
    const { handle } = createTestScheduler();
    const result = await Effect.runPromise(handle.getNext());
    expect(result).toBeNull();
  });

  it("scheduling overwrites previous timestamp", async () => {
    const { handle } = createTestScheduler();
    await Effect.runPromise(handle.schedule(1000));
    await Effect.runPromise(handle.schedule(2000));
    expect(handle.getScheduledTime()).toBe(2000);
  });
});
