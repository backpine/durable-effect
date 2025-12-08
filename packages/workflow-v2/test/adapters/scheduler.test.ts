import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { createInMemoryScheduler, shouldAlarmFire } from "../../src";

describe("InMemoryScheduler", () => {
  it("should schedule and retrieve alarm time", async () => {
    const result = await Effect.gen(function* () {
      const scheduler = yield* createInMemoryScheduler();
      yield* scheduler.schedule(1000);
      return yield* scheduler.getScheduled();
    }).pipe(Effect.runPromise);

    expect(result).toBe(1000);
  });

  it("should return undefined when nothing scheduled", async () => {
    const result = await Effect.gen(function* () {
      const scheduler = yield* createInMemoryScheduler();
      return yield* scheduler.getScheduled();
    }).pipe(Effect.runPromise);

    expect(result).toBeUndefined();
  });

  it("should cancel scheduled alarm", async () => {
    const result = await Effect.gen(function* () {
      const scheduler = yield* createInMemoryScheduler();
      yield* scheduler.schedule(1000);
      yield* scheduler.cancel();
      return yield* scheduler.getScheduled();
    }).pipe(Effect.runPromise);

    expect(result).toBeUndefined();
  });

  it("should overwrite previous alarm", async () => {
    const result = await Effect.gen(function* () {
      const scheduler = yield* createInMemoryScheduler();
      yield* scheduler.schedule(1000);
      yield* scheduler.schedule(2000);
      return yield* scheduler.getScheduled();
    }).pipe(Effect.runPromise);

    expect(result).toBe(2000);
  });

  describe("shouldAlarmFire", () => {
    it("should return true when time >= scheduled", () => {
      expect(shouldAlarmFire(1000, 1000)).toBe(true);
      expect(shouldAlarmFire(1000, 1500)).toBe(true);
    });

    it("should return false when time < scheduled", () => {
      expect(shouldAlarmFire(1000, 500)).toBe(false);
    });

    it("should return false when nothing scheduled", () => {
      expect(shouldAlarmFire(undefined, 1000)).toBe(false);
    });
  });
});
