import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  PurgeManager,
  PurgeManagerLayer,
  DisabledPurgeManagerLayer,
  parsePurgeConfig,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("PurgeManager", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000 })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const createLayers = (purgeDelay?: string | number) => {
    const config = parsePurgeConfig(
      purgeDelay !== undefined ? { delay: purgeDelay } : {}
    );
    return PurgeManagerLayer(config).pipe(Layer.provide(runtimeLayer));
  };

  const runWithPurge = <A, E>(
    effect: Effect.Effect<A, E, PurgeManager>,
    purgeDelay?: string | number
  ) => effect.pipe(Effect.provide(createLayers(purgeDelay)), Effect.runPromise);

  describe("schedulePurge", () => {
    it("should schedule purge with default delay", async () => {
      await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          yield* purge.schedulePurge("completed");
        })
      );

      // Verify purge is scheduled
      const isPurgeScheduled = await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.isPurgeScheduled();
        })
      );

      expect(isPurgeScheduled).toBe(true);

      // Verify alarm was scheduled
      const schedulerState = await Effect.runPromise(handle.getSchedulerState());
      expect(schedulerState.scheduledTime).toBeDefined();
      // Default delay is 60 seconds, initial time is 1000
      expect(schedulerState.scheduledTime).toBe(1000 + 60_000);
    });

    it("should schedule purge with custom delay", async () => {
      await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          yield* purge.schedulePurge("failed");
        }),
        "30 seconds"
      );

      const schedulerState = await Effect.runPromise(handle.getSchedulerState());
      expect(schedulerState.scheduledTime).toBe(1000 + 30_000);
    });

    it("should store terminal state reason", async () => {
      // Complete a purge schedule
      await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          yield* purge.schedulePurge("cancelled");
        })
      );

      // Advance time past purge delay
      await Effect.runPromise(handle.advanceTime(60_001));

      // Execute and verify reason
      const result = await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.executePurgeIfDue();
        })
      );

      expect(result.purged).toBe(true);
      if (result.purged) {
        expect(result.reason).toBe("cancelled");
      }
    });
  });

  describe("executePurgeIfDue", () => {
    it("should return purged: false when no purge scheduled", async () => {
      const result = await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.executePurgeIfDue();
        })
      );

      expect(result.purged).toBe(false);
    });

    it("should return purged: false when purge is scheduled but not due yet", async () => {
      // Schedule purge
      await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          yield* purge.schedulePurge("completed");
        })
      );

      // Advance time but not past delay
      await Effect.runPromise(handle.advanceTime(30_000));

      const result = await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.executePurgeIfDue();
        })
      );

      expect(result.purged).toBe(false);
    });

    it("should execute purge when due", async () => {
      // Schedule purge
      await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          yield* purge.schedulePurge("completed");
        })
      );

      // Advance time past delay
      await Effect.runPromise(handle.advanceTime(60_001));

      const result = await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.executePurgeIfDue();
        })
      );

      expect(result.purged).toBe(true);
      if (result.purged) {
        expect(result.reason).toBe("completed");
      }
    });

    it("should delete all storage when purging", async () => {
      // Schedule purge and store some data
      await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          yield* purge.schedulePurge("completed");
        })
      );

      // Advance time past delay
      await Effect.runPromise(handle.advanceTime(60_001));

      // Execute purge
      await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.executePurgeIfDue();
        })
      );

      // Verify purge metadata is gone
      const isPurgeScheduled = await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.isPurgeScheduled();
        })
      );

      expect(isPurgeScheduled).toBe(false);
    });
  });

  describe("isPurgeScheduled", () => {
    it("should return false when no purge scheduled", async () => {
      const result = await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.isPurgeScheduled();
        })
      );

      expect(result).toBe(false);
    });

    it("should return true when purge is scheduled", async () => {
      await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          yield* purge.schedulePurge("completed");
        })
      );

      const result = await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.isPurgeScheduled();
        })
      );

      expect(result).toBe(true);
    });
  });

  describe("cancelPurge", () => {
    it("should cancel scheduled purge", async () => {
      // Schedule purge
      await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          yield* purge.schedulePurge("completed");
        })
      );

      // Verify it's scheduled
      const beforeCancel = await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.isPurgeScheduled();
        })
      );
      expect(beforeCancel).toBe(true);

      // Cancel
      await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          yield* purge.cancelPurge();
        })
      );

      // Verify it's cancelled
      const afterCancel = await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.isPurgeScheduled();
        })
      );
      expect(afterCancel).toBe(false);
    });

    it("should be idempotent when no purge scheduled", async () => {
      // Should not throw
      await runWithPurge(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          yield* purge.cancelPurge();
        })
      );
    });
  });

  describe("DisabledPurgeManagerLayer", () => {
    const runDisabled = <A, E>(effect: Effect.Effect<A, E, PurgeManager>) =>
      effect.pipe(Effect.provide(DisabledPurgeManagerLayer), Effect.runPromise);

    it("schedulePurge should be no-op", async () => {
      // Should not throw
      await runDisabled(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          yield* purge.schedulePurge("completed");
        })
      );
    });

    it("executePurgeIfDue should return purged: false", async () => {
      const result = await runDisabled(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.executePurgeIfDue();
        })
      );

      expect(result.purged).toBe(false);
    });

    it("isPurgeScheduled should return false", async () => {
      const result = await runDisabled(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          return yield* purge.isPurgeScheduled();
        })
      );

      expect(result).toBe(false);
    });

    it("cancelPurge should be no-op", async () => {
      // Should not throw
      await runDisabled(
        Effect.gen(function* () {
          const purge = yield* PurgeManager;
          yield* purge.cancelPurge();
        })
      );
    });
  });
});
