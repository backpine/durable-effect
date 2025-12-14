// packages/primitives/test/services/entity-state.test.ts

import { describe, it, expect } from "vitest";
import { Effect, Layer, Schema } from "effect";
import { createTestRuntime, StorageAdapter } from "@durable-effect/core";
import { createEntityStateService } from "../../src/services/entity-state";
import { ValidationError } from "../../src/errors";

describe("EntityStateService", () => {
  // Test schema
  const TestState = Schema.Struct({
    count: Schema.Number,
    name: Schema.String,
    optional: Schema.optional(Schema.Boolean),
  });

  type TestState = typeof TestState.Type;

  const createTestLayer = () => {
    const { layer } = createTestRuntime("test-instance");
    return layer;
  };

  it("returns null for uninitialized state", async () => {
    const layer = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* createEntityStateService(TestState);
        return yield* state.get();
      }).pipe(Effect.provide(layer))
    );

    expect(result).toBeNull();
  });

  it("sets and gets state", async () => {
    const layer = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* createEntityStateService(TestState);

        yield* state.set({ count: 42, name: "test" });

        return yield* state.get();
      }).pipe(Effect.provide(layer))
    );

    expect(result).toEqual({ count: 42, name: "test" });
  });

  it("updates state atomically", async () => {
    const layer = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* createEntityStateService(TestState);

        yield* state.set({ count: 10, name: "original" });
        yield* state.update((s) => ({ ...s, count: s.count + 5 }));

        return yield* state.get();
      }).pipe(Effect.provide(layer))
    );

    expect(result).toEqual({ count: 15, name: "original" });
  });

  it("update is no-op if state doesn't exist", async () => {
    const layer = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* createEntityStateService(TestState);

        yield* state.update((s) => ({ ...s, count: 999 }));

        return yield* state.get();
      }).pipe(Effect.provide(layer))
    );

    expect(result).toBeNull();
  });

  it("deletes state", async () => {
    const layer = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* createEntityStateService(TestState);

        yield* state.set({ count: 42, name: "test" });
        const before = yield* state.get();

        yield* state.delete();
        const after = yield* state.get();

        return { before, after };
      }).pipe(Effect.provide(layer))
    );

    expect(result.before).toEqual({ count: 42, name: "test" });
    expect(result.after).toBeNull();
  });

  it("validates state against schema on get", async () => {
    const layer = createTestLayer();

    // Manually store invalid data
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* StorageAdapter;
        yield* storage.put("state", { invalid: "data" });
      }).pipe(Effect.provide(layer))
    );

    // Try to get with typed state service
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* createEntityStateService(TestState);
        return yield* state.get();
      }).pipe(
        Effect.provide(layer),
        Effect.either
      )
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ValidationError);
    }
  });

  it("handles optional fields", async () => {
    const layer = createTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* createEntityStateService(TestState);

        // Set without optional field
        yield* state.set({ count: 1, name: "test" });
        const without = yield* state.get();

        // Update with optional field
        yield* state.update((s) => ({ ...s, optional: true }));
        const with_ = yield* state.get();

        return { without, with: with_ };
      }).pipe(Effect.provide(layer))
    );

    expect(result.without).toEqual({ count: 1, name: "test" });
    expect(result.with).toEqual({ count: 1, name: "test", optional: true });
  });

  it("works with complex nested schema", async () => {
    const ComplexState = Schema.Struct({
      user: Schema.Struct({
        id: Schema.String,
        email: Schema.String,
      }),
      items: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          quantity: Schema.Number,
        })
      ),
      metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    });

    const layer = createTestLayer();

    const testData = {
      user: { id: "user-123", email: "test@example.com" },
      items: [
        { name: "Widget", quantity: 5 },
        { name: "Gadget", quantity: 3 },
      ],
      metadata: { key: "value", nested: { deep: true } },
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* createEntityStateService(ComplexState);

        yield* state.set(testData);
        return yield* state.get();
      }).pipe(Effect.provide(layer))
    );

    expect(result).toEqual(testData);
  });
});
