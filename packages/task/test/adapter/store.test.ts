import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { createTestStore } from "../../src/testing/store.js";

describe("Store (in-memory)", () => {
  it("returns null for missing key", async () => {
    const { handle } = createTestStore();
    const result = await Effect.runPromise(handle.get("missing"));
    expect(result).toBeNull();
  });

  it("set then get returns the value", async () => {
    const { handle } = createTestStore();
    await Effect.runPromise(handle.set("key", { hello: "world" }));
    const result = await Effect.runPromise(handle.get("key"));
    expect(result).toEqual({ hello: "world" });
  });

  it("overwrites existing value", async () => {
    const { handle } = createTestStore();
    await Effect.runPromise(handle.set("key", 1));
    await Effect.runPromise(handle.set("key", 2));
    const result = await Effect.runPromise(handle.get("key"));
    expect(result).toBe(2);
  });

  it("delete removes a key", async () => {
    const { handle } = createTestStore();
    await Effect.runPromise(handle.set("key", "value"));
    await Effect.runPromise(handle.delete("key"));
    const result = await Effect.runPromise(handle.get("key"));
    expect(result).toBeNull();
  });

  it("deleteAll clears all keys", async () => {
    const { handle } = createTestStore();
    await Effect.runPromise(handle.set("a", 1));
    await Effect.runPromise(handle.set("b", 2));
    await Effect.runPromise(handle.deleteAll());
    expect(handle.keys()).toEqual([]);
  });
});
