import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  createInMemoryRuntime,
  StorageAdapter,
  SchedulerAdapter,
  RuntimeAdapter,
} from "../../src";

describe("InMemoryRuntime", () => {
  it("should create a complete runtime layer", async () => {
    const result = await Effect.gen(function* () {
      const { layer } = yield* createInMemoryRuntime();

      return yield* Effect.gen(function* () {
        const storage = yield* StorageAdapter;
        const scheduler = yield* SchedulerAdapter;
        const runtime = yield* RuntimeAdapter;

        yield* storage.put("test", "value");
        yield* scheduler.schedule(1000);

        return {
          value: yield* storage.get("test"),
          scheduled: yield* scheduler.getScheduled(),
          instanceId: runtime.instanceId,
        };
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.runPromise);

    expect(result.value).toBe("value");
    expect(result.scheduled).toBe(1000);
    expect(result.instanceId).toBeDefined();
  });

  it("should allow time control via handle", async () => {
    const result = await Effect.gen(function* () {
      const { handle } = yield* createInMemoryRuntime({
        initialTime: 1000,
      });

      const t1 = yield* handle.getCurrentTime();
      yield* handle.advanceTime(500);
      const t2 = yield* handle.getCurrentTime();
      yield* handle.setTime(5000);
      const t3 = yield* handle.getCurrentTime();

      return { t1, t2, t3 };
    }).pipe(Effect.runPromise);

    expect(result.t1).toBe(1000);
    expect(result.t2).toBe(1500);
    expect(result.t3).toBe(5000);
  });

  it("should detect when alarm should fire", async () => {
    const result = await Effect.gen(function* () {
      const { layer, handle } = yield* createInMemoryRuntime({
        initialTime: 1000,
      });

      yield* Effect.gen(function* () {
        const scheduler = yield* SchedulerAdapter;
        yield* scheduler.schedule(1500);
      }).pipe(Effect.provide(layer));

      const before = yield* handle.shouldAlarmFire();
      yield* handle.advanceTime(600);
      const after = yield* handle.shouldAlarmFire();

      return { before, after };
    }).pipe(Effect.runPromise);

    expect(result.before).toBe(false);
    expect(result.after).toBe(true);
  });

  it("should allow state inspection", async () => {
    const result = await Effect.gen(function* () {
      const { layer, handle } = yield* createInMemoryRuntime();

      yield* Effect.gen(function* () {
        const storage = yield* StorageAdapter;
        yield* storage.put("key1", "value1");
        yield* storage.put("key2", "value2");
      }).pipe(Effect.provide(layer));

      const state = yield* handle.getStorageState();
      return state.data.size;
    }).pipe(Effect.runPromise);

    expect(result).toBe(2);
  });
});
