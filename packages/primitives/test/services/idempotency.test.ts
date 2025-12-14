// packages/jobs/test/services/idempotency.test.ts

import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { createTestRuntime } from "@durable-effect/core";
import {
  IdempotencyService,
  IdempotencyServiceLayer,
} from "../../src/services/idempotency";

describe("IdempotencyService", () => {
  const createTestLayer = (initialTime = 1000000) => {
    const { layer: coreLayer, time } = createTestRuntime(
      "test-instance",
      initialTime
    );
    const testLayer = IdempotencyServiceLayer.pipe(
      Layer.provideMerge(coreLayer)
    );
    return { layer: testLayer, time };
  };

  it("returns false for unprocessed event", async () => {
    const { layer } = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const idempotency = yield* IdempotencyService;
        return yield* idempotency.check("event-123");
      }).pipe(Effect.provide(layer))
    );

    expect(result).toBe(false);
  });

  it("returns true after marking event as processed", async () => {
    const { layer } = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const idempotency = yield* IdempotencyService;

        const before = yield* idempotency.check("event-123");
        yield* idempotency.mark("event-123");
        const after = yield* idempotency.check("event-123");

        return { before, after };
      }).pipe(Effect.provide(layer))
    );

    expect(result.before).toBe(false);
    expect(result.after).toBe(true);
  });

  it("checkAndMark returns false and marks on first call", async () => {
    const { layer } = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const idempotency = yield* IdempotencyService;

        const isDuplicate = yield* idempotency.checkAndMark("event-456");
        const wasMarked = yield* idempotency.check("event-456");

        return { isDuplicate, wasMarked };
      }).pipe(Effect.provide(layer))
    );

    expect(result.isDuplicate).toBe(false);
    expect(result.wasMarked).toBe(true);
  });

  it("checkAndMark returns true on subsequent calls", async () => {
    const { layer } = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const idempotency = yield* IdempotencyService;

        const first = yield* idempotency.checkAndMark("event-789");
        const second = yield* idempotency.checkAndMark("event-789");
        const third = yield* idempotency.checkAndMark("event-789");

        return { first, second, third };
      }).pipe(Effect.provide(layer))
    );

    expect(result.first).toBe(false); // Not a duplicate
    expect(result.second).toBe(true); // Duplicate
    expect(result.third).toBe(true); // Still a duplicate
  });

  it("tracks multiple events independently", async () => {
    const { layer } = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const idempotency = yield* IdempotencyService;

        yield* idempotency.mark("event-a");
        yield* idempotency.mark("event-b");

        const checkA = yield* idempotency.check("event-a");
        const checkB = yield* idempotency.check("event-b");
        const checkC = yield* idempotency.check("event-c");

        return { checkA, checkB, checkC };
      }).pipe(Effect.provide(layer))
    );

    expect(result.checkA).toBe(true);
    expect(result.checkB).toBe(true);
    expect(result.checkC).toBe(false);
  });

  it("clears idempotency record", async () => {
    const { layer } = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const idempotency = yield* IdempotencyService;

        yield* idempotency.mark("event-to-clear");
        const before = yield* idempotency.check("event-to-clear");

        yield* idempotency.clear("event-to-clear");
        const after = yield* idempotency.check("event-to-clear");

        return { before, after };
      }).pipe(Effect.provide(layer))
    );

    expect(result.before).toBe(true);
    expect(result.after).toBe(false);
  });

  it("handles special characters in event IDs", async () => {
    const { layer } = createTestLayer();
    const specialIds = [
      "event/with/slashes",
      "event:with:colons",
      "event-with-dashes",
      "event_with_underscores",
      "event.with.dots",
      "event with spaces",
      "event@with#special$chars",
    ];

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const idempotency = yield* IdempotencyService;

        // Mark all
        for (const id of specialIds) {
          yield* idempotency.mark(id);
        }

        // Check all
        const checks: boolean[] = [];
        for (const id of specialIds) {
          checks.push(yield* idempotency.check(id));
        }

        return checks;
      }).pipe(Effect.provide(layer))
    );

    // All should be marked as processed
    expect(results.every((r) => r === true)).toBe(true);
  });

  it("uses correct storage key prefix", async () => {
    const { layer } = createTestLayer();

    // This test verifies the storage key format indirectly
    // by checking that different event IDs don't collide
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const idempotency = yield* IdempotencyService;

        // Mark similar IDs that might collide without proper prefixing
        yield* idempotency.mark("123");
        yield* idempotency.mark("1234");
        yield* idempotency.mark("12345");

        return {
          check123: yield* idempotency.check("123"),
          check1234: yield* idempotency.check("1234"),
          check12345: yield* idempotency.check("12345"),
          check123456: yield* idempotency.check("123456"),
        };
      }).pipe(Effect.provide(layer))
    );

    expect(result.check123).toBe(true);
    expect(result.check1234).toBe(true);
    expect(result.check12345).toBe(true);
    expect(result.check123456).toBe(false);
  });
});
