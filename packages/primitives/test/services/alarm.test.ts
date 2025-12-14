// packages/jobs/test/services/alarm.test.ts

import { describe, it, expect } from "vitest";
import { Effect, Layer, Duration } from "effect";
import { createTestRuntime } from "@durable-effect/core";
import { AlarmService, AlarmServiceLayer } from "../../src/services/alarm";

describe("AlarmService", () => {
  const createTestLayer = (initialTime = 1000000) => {
    const { layer: coreLayer, time, handles } = createTestRuntime(
      "test-instance",
      initialTime
    );
    const testLayer = AlarmServiceLayer.pipe(Layer.provideMerge(coreLayer));
    return { layer: testLayer, time, handles };
  };

  it("schedules alarm with absolute timestamp", async () => {
    const { layer, handles } = createTestLayer(1000000);

    await Effect.runPromise(
      Effect.gen(function* () {
        const alarm = yield* AlarmService;
        yield* alarm.schedule(1500000);
      }).pipe(Effect.provide(layer))
    );

    expect(handles.scheduler.getScheduledTime()).toBe(1500000);
  });

  it("schedules alarm with Date", async () => {
    const { layer, handles } = createTestLayer(1000000);
    const targetDate = new Date(2000000);

    await Effect.runPromise(
      Effect.gen(function* () {
        const alarm = yield* AlarmService;
        yield* alarm.schedule(targetDate);
      }).pipe(Effect.provide(layer))
    );

    expect(handles.scheduler.getScheduledTime()).toBe(2000000);
  });

  it("schedules alarm with Duration (string)", async () => {
    const { layer, handles } = createTestLayer(1000000);

    await Effect.runPromise(
      Effect.gen(function* () {
        const alarm = yield* AlarmService;
        yield* alarm.schedule("30 minutes");
      }).pipe(Effect.provide(layer))
    );

    // 1000000 + 30 minutes (1800000ms) = 2800000
    expect(handles.scheduler.getScheduledTime()).toBe(
      1000000 + Duration.toMillis("30 minutes")
    );
  });

  it("schedules alarm with Duration object", async () => {
    const { layer, handles } = createTestLayer(1000000);

    await Effect.runPromise(
      Effect.gen(function* () {
        const alarm = yield* AlarmService;
        yield* alarm.schedule(Duration.minutes(5));
      }).pipe(Effect.provide(layer))
    );

    // 1000000 + 5 minutes (300000ms) = 1300000
    expect(handles.scheduler.getScheduledTime()).toBe(1000000 + 300000);
  });

  it("cancels scheduled alarm", async () => {
    const { layer, handles } = createTestLayer(1000000);

    await Effect.runPromise(
      Effect.gen(function* () {
        const alarm = yield* AlarmService;
        yield* alarm.schedule(2000000);
        yield* alarm.cancel();
      }).pipe(Effect.provide(layer))
    );

    expect(handles.scheduler.getScheduledTime()).toBeUndefined();
  });

  it("gets scheduled alarm time", async () => {
    const { layer } = createTestLayer(1000000);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alarm = yield* AlarmService;

        const before = yield* alarm.getScheduled();
        yield* alarm.schedule(1500000);
        const after = yield* alarm.getScheduled();

        return { before, after };
      }).pipe(Effect.provide(layer))
    );

    expect(result.before).toBeUndefined();
    expect(result.after).toBe(1500000);
  });

  it("handles multiple schedule calls (overwrites)", async () => {
    const { layer, handles } = createTestLayer(1000000);

    await Effect.runPromise(
      Effect.gen(function* () {
        const alarm = yield* AlarmService;
        yield* alarm.schedule(1500000);
        yield* alarm.schedule(2000000);
        yield* alarm.schedule(1200000);
      }).pipe(Effect.provide(layer))
    );

    // Last schedule wins
    expect(handles.scheduler.getScheduledTime()).toBe(1200000);
  });

  it("uses current time for Duration scheduling", async () => {
    const { layer, handles, time } = createTestLayer(1000000);

    await Effect.runPromise(
      Effect.gen(function* () {
        const alarm = yield* AlarmService;

        // First schedule at time 1000000
        yield* alarm.schedule("1 minute");
        const first = yield* alarm.getScheduled();

        // Advance time and schedule again
        time.advance(30000); // +30 seconds
        yield* alarm.schedule("1 minute");
        const second = yield* alarm.getScheduled();

        return { first, second };
      }).pipe(Effect.provide(layer))
    );

    // First: 1000000 + 60000 = 1060000
    // Second: 1030000 + 60000 = 1090000
    // Only second remains because it overwrote first
    expect(handles.scheduler.getScheduledTime()).toBe(1030000 + 60000);
  });
});
