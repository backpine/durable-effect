import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  createInMemoryStorage,
  createInMemoryStorageWithErrors,
} from "../../src";

describe("InMemoryStorage", () => {
  describe("basic operations", () => {
    it("should store and retrieve values", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        yield* storage.put("key1", { value: 42 });
        return yield* storage.get<{ value: number }>("key1");
      }).pipe(Effect.runPromise);

      expect(result).toEqual({ value: 42 });
    });

    it("should return undefined for missing keys", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        return yield* storage.get("nonexistent");
      }).pipe(Effect.runPromise);

      expect(result).toBeUndefined();
    });

    it("should overwrite existing values", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        yield* storage.put("key1", "first");
        yield* storage.put("key1", "second");
        return yield* storage.get("key1");
      }).pipe(Effect.runPromise);

      expect(result).toBe("second");
    });

    it("should delete values", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        yield* storage.put("key1", "value");
        const existed = yield* storage.delete("key1");
        const after = yield* storage.get("key1");
        return { existed, after };
      }).pipe(Effect.runPromise);

      expect(result.existed).toBe(true);
      expect(result.after).toBeUndefined();
    });

    it("should return false when deleting nonexistent key", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        return yield* storage.delete("nonexistent");
      }).pipe(Effect.runPromise);

      expect(result).toBe(false);
    });

    it("should delete all values", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        yield* storage.put("key1", "value1");
        yield* storage.put("key2", "value2");
        yield* storage.deleteAll();
        const v1 = yield* storage.get("key1");
        const v2 = yield* storage.get("key2");
        return { v1, v2 };
      }).pipe(Effect.runPromise);

      expect(result.v1).toBeUndefined();
      expect(result.v2).toBeUndefined();
    });
  });

  describe("putBatch", () => {
    it("should store multiple values atomically", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        yield* storage.putBatch({
          key1: "value1",
          key2: "value2",
          key3: { nested: true },
        });
        return {
          v1: yield* storage.get("key1"),
          v2: yield* storage.get("key2"),
          v3: yield* storage.get("key3"),
        };
      }).pipe(Effect.runPromise);

      expect(result).toEqual({
        v1: "value1",
        v2: "value2",
        v3: { nested: true },
      });
    });
  });

  describe("list", () => {
    it("should list keys with prefix", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorage();
        yield* storage.put("workflow:status", "running");
        yield* storage.put("workflow:input", { x: 1 });
        yield* storage.put("step:fetch:result", "data");
        return yield* storage.list("workflow:");
      }).pipe(Effect.runPromise);

      expect(result.size).toBe(2);
      expect(result.get("workflow:status")).toBe("running");
      expect(result.get("workflow:input")).toEqual({ x: 1 });
    });
  });

  describe("error simulation", () => {
    it("should fail specified operations", async () => {
      const result = await Effect.gen(function* () {
        const storage = yield* createInMemoryStorageWithErrors({
          failOn: { get: ["secret"] },
        });
        yield* storage.put("normal", "value");
        const normal = yield* storage.get("normal");
        const secret = yield* storage.get("secret").pipe(Effect.either);
        return { normal, secret };
      }).pipe(Effect.runPromise);

      expect(result.normal).toBe("value");
      expect(result.secret._tag).toBe("Left");
    });
  });
});
