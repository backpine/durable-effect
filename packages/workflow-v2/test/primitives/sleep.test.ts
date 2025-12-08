import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  createInMemoryRuntime,
  StorageAdapter,
  WorkflowContext,
  WorkflowContextLayer,
  WorkflowScope,
  WorkflowScopeLayer,
  sleep,
  sleepUntil,
  PauseSignal,
  isPauseSignal,
  WorkflowScopeError,
  type TestRuntimeHandle,
  type RuntimeLayer,
} from "../../src";

describe("Workflow.sleep", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000 })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const createLayers = () =>
    WorkflowScopeLayer.pipe(
      Layer.provideMerge(WorkflowContextLayer),
      Layer.provideMerge(runtimeLayer)
    );

  const runSleep = <A, E>(effect: Effect.Effect<A, E, any>) =>
    effect.pipe(Effect.provide(createLayers()), Effect.runPromise);

  it("should throw PauseSignal with correct resumeAt", async () => {
    const result = await runSleep(
      Effect.gen(function* () {
        return yield* sleep("5 seconds").pipe(Effect.either);
      })
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(isPauseSignal(result.left)).toBe(true);
      const signal = result.left as PauseSignal;
      expect(signal.reason).toBe("sleep");
      expect(signal.resumeAt).toBe(1000 + 5000);
    }
  });

  it("should parse different duration formats", async () => {
    const durations = [
      { input: "1s", expected: 1000 },
      { input: "1 second", expected: 1000 },
      { input: "5m", expected: 300000 },
      { input: "1h", expected: 3600000 },
      { input: 2000, expected: 2000 },
    ];

    for (const { input, expected } of durations) {
      const result = await runSleep(
        Effect.gen(function* () {
          return yield* sleep(input).pipe(Effect.either);
        })
      );

      if (result._tag === "Left" && isPauseSignal(result.left)) {
        expect(result.left.resumeAt).toBe(1000 + expected);
      }
    }
  });

  it("should skip completed pause points on replay", async () => {
    // Manually set completed pause index to simulate completed sleep
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* StorageAdapter;
        yield* storage.put("workflow:completedPauseIndex", 1);
      }).pipe(Effect.provide(runtimeLayer))
    );

    // Sleep should skip since pause index 1 is already completed
    const result = await runSleep(
      Effect.gen(function* () {
        yield* sleep("5 seconds");
        return "completed";
      })
    );

    expect(result).toBe("completed");
  });

  it("should fail outside workflow scope", async () => {
    const result = await Effect.gen(function* () {
      return yield* sleep("5 seconds").pipe(Effect.either);
    }).pipe(
      // No WorkflowScopeLayer
      Effect.provide(WorkflowContextLayer),
      Effect.provide(runtimeLayer),
      Effect.runPromise
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(WorkflowScopeError);
    }
  });

  it("should increment pause index", async () => {
    await runSleep(
      Effect.gen(function* () {
        yield* sleep("1s").pipe(Effect.either);
      })
    );

    const pauseIndex = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* StorageAdapter;
        return yield* storage.get<number>("workflow:currentPauseIndex");
      }).pipe(Effect.provide(runtimeLayer))
    );

    expect(pauseIndex).toBe(1);
  });
});

describe("Workflow.sleepUntil", () => {
  let runtimeLayer: RuntimeLayer;
  let handle: TestRuntimeHandle;

  beforeEach(async () => {
    const result = await Effect.runPromise(
      createInMemoryRuntime({ initialTime: 1000 })
    );
    runtimeLayer = result.layer;
    handle = result.handle;
  });

  const createLayers = () =>
    WorkflowScopeLayer.pipe(
      Layer.provideMerge(WorkflowContextLayer),
      Layer.provideMerge(runtimeLayer)
    );

  it("should throw PauseSignal with exact timestamp", async () => {
    const result = await Effect.gen(function* () {
      return yield* sleepUntil(5000).pipe(Effect.either);
    }).pipe(Effect.provide(createLayers()), Effect.runPromise);

    expect(result._tag).toBe("Left");
    if (result._tag === "Left" && isPauseSignal(result.left)) {
      expect(result.left.resumeAt).toBe(5000);
    }
  });

  it("should not pause if timestamp is in the past", async () => {
    const result = await Effect.gen(function* () {
      yield* sleepUntil(500); // Past (current time is 1000)
      return "completed";
    }).pipe(Effect.provide(createLayers()), Effect.runPromise);

    expect(result).toBe("completed");
  });

  it("should not pause if timestamp equals current time", async () => {
    const result = await Effect.gen(function* () {
      yield* sleepUntil(1000); // Equal to current time
      return "completed";
    }).pipe(Effect.provide(createLayers()), Effect.runPromise);

    expect(result).toBe("completed");
  });
});
