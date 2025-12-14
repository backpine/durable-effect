// packages/primitives/test/services/metadata.test.ts

import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { createTestRuntime } from "@durable-effect/core";
import {
  MetadataService,
  MetadataServiceLayer,
  type PrimitiveMetadata,
} from "../../src/services/metadata";

describe("MetadataService", () => {
  const createTestLayer = (initialTime = 1000000) => {
    const { layer: coreLayer, time } = createTestRuntime("test-instance", initialTime);
    const testLayer = MetadataServiceLayer.pipe(Layer.provideMerge(coreLayer));
    return { layer: testLayer, time };
  };

  it("returns undefined for uninitialized instance", async () => {
    const { layer } = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const metadata = yield* MetadataService;
        return yield* metadata.get();
      }).pipe(Effect.provide(layer))
    );

    expect(result).toBeUndefined();
  });

  it("initializes metadata correctly", async () => {
    const { layer, time } = createTestLayer(1000000);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const metadata = yield* MetadataService;
        yield* metadata.initialize("continuous", "tokenRefresher");
        return yield* metadata.get();
      }).pipe(Effect.provide(layer))
    );

    expect(result).toEqual({
      type: "continuous",
      name: "tokenRefresher",
      status: "initializing",
      createdAt: 1000000,
      updatedAt: 1000000,
    } satisfies PrimitiveMetadata);
  });

  it("updates status", async () => {
    const { layer, time } = createTestLayer(1000000);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const metadata = yield* MetadataService;
        yield* metadata.initialize("buffer", "webhookBuffer");

        // Advance time
        time.advance(5000);

        yield* metadata.updateStatus("running");
        return yield* metadata.get();
      }).pipe(Effect.provide(layer))
    );

    expect(result).toEqual({
      type: "buffer",
      name: "webhookBuffer",
      status: "running",
      createdAt: 1000000,
      updatedAt: 1005000,
    } satisfies PrimitiveMetadata);
  });

  it("does not update status if not initialized", async () => {
    const { layer } = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const metadata = yield* MetadataService;
        yield* metadata.updateStatus("running");
        return yield* metadata.get();
      }).pipe(Effect.provide(layer))
    );

    expect(result).toBeUndefined();
  });

  it("deletes metadata", async () => {
    const { layer } = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const metadata = yield* MetadataService;
        yield* metadata.initialize("queue", "emailQueue");

        const before = yield* metadata.get();
        yield* metadata.delete();
        const after = yield* metadata.get();

        return { before, after };
      }).pipe(Effect.provide(layer))
    );

    expect(result.before).toBeDefined();
    expect(result.after).toBeUndefined();
  });

  it("supports all primitive types", async () => {
    const types = ["continuous", "buffer", "queue"] as const;

    for (const type of types) {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const metadata = yield* MetadataService;
          yield* metadata.initialize(type, `test-${type}`);
          return yield* metadata.get();
        }).pipe(Effect.provide(layer))
      );

      expect(result?.type).toBe(type);
      expect(result?.name).toBe(`test-${type}`);
    }
  });
});
