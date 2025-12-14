// packages/primitives/test/registry.test.ts

import { describe, it, expect } from "vitest";
import { Schema, Effect } from "effect";
import {
  createPrimitiveRegistry,
  getContinuousDefinition,
  getBufferDefinition,
  getQueueDefinition,
  getPrimitiveDefinition,
  getAllPrimitiveNames,
} from "../src/registry";
import type {
  ContinuousDefinition,
  BufferDefinition,
  QueueDefinition,
} from "../src/registry/types";

// =============================================================================
// Test Definitions
// =============================================================================

const TokenState = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
});

const testContinuous: ContinuousDefinition<
  typeof TokenState.Type,
  never,
  never
> = {
  _tag: "continuous",
  name: "tokenRefresher",
  stateSchema: TokenState,
  schedule: { _tag: "Every", interval: "30 minutes" },
  startImmediately: true,
  execute: () => Effect.void,
};

const WebhookEvent = Schema.Struct({
  type: Schema.String,
  data: Schema.Unknown,
});

const testBuffer: BufferDefinition<
  typeof WebhookEvent.Type,
  { events: Array<typeof WebhookEvent.Type> },
  never,
  never
> = {
  _tag: "buffer",
  name: "webhookBuffer",
  eventSchema: WebhookEvent,
  flushAfter: "5 minutes",
  maxEvents: 100,
  execute: () => Effect.void,
};

const EmailEvent = Schema.Struct({
  to: Schema.String,
  template: Schema.String,
});

const testQueue: QueueDefinition<typeof EmailEvent.Type, Error, never> = {
  _tag: "queue",
  name: "emailQueue",
  eventSchema: EmailEvent,
  concurrency: 5,
  execute: () => Effect.void,
  retry: {
    maxAttempts: 3,
    initialDelay: "1 second",
  },
};

// =============================================================================
// Tests
// =============================================================================

describe("createPrimitiveRegistry", () => {
  it("creates empty maps for each primitive type", () => {
    const registry = createPrimitiveRegistry({});

    expect(registry.continuous.size).toBe(0);
    expect(registry.buffer.size).toBe(0);
    expect(registry.queue.size).toBe(0);
  });

  it("registers continuous definitions by key name", () => {
    const registry = createPrimitiveRegistry({
      tokenRefresher: testContinuous,
    });

    expect(registry.continuous.size).toBe(1);
    expect(registry.continuous.has("tokenRefresher")).toBe(true);

    const def = registry.continuous.get("tokenRefresher");
    expect(def?._tag).toBe("continuous");
    expect(def?.name).toBe("tokenRefresher");
    expect(def?.schedule._tag).toBe("Every");
  });

  it("registers buffer definitions by key name", () => {
    const registry = createPrimitiveRegistry({
      webhookBuffer: testBuffer,
    });

    expect(registry.buffer.size).toBe(1);
    expect(registry.buffer.has("webhookBuffer")).toBe(true);

    const def = registry.buffer.get("webhookBuffer");
    expect(def?._tag).toBe("buffer");
    expect(def?.name).toBe("webhookBuffer");
    expect(def?.maxEvents).toBe(100);
  });

  it("registers queue definitions by key name", () => {
    const registry = createPrimitiveRegistry({
      emailQueue: testQueue,
    });

    expect(registry.queue.size).toBe(1);
    expect(registry.queue.has("emailQueue")).toBe(true);

    const def = registry.queue.get("emailQueue");
    expect(def?._tag).toBe("queue");
    expect(def?.name).toBe("emailQueue");
    expect(def?.concurrency).toBe(5);
  });

  it("registers mixed primitive types correctly", () => {
    const registry = createPrimitiveRegistry({
      tokenRefresher: testContinuous,
      webhookBuffer: testBuffer,
      emailQueue: testQueue,
    });

    expect(registry.continuous.size).toBe(1);
    expect(registry.buffer.size).toBe(1);
    expect(registry.queue.size).toBe(1);

    expect(registry.continuous.has("tokenRefresher")).toBe(true);
    expect(registry.buffer.has("webhookBuffer")).toBe(true);
    expect(registry.queue.has("emailQueue")).toBe(true);
  });

  it("assigns name from key even if different from definition name", () => {
    const registry = createPrimitiveRegistry({
      myCustomName: { ...testContinuous, name: "originalName" },
    });

    const def = registry.continuous.get("myCustomName");
    expect(def?.name).toBe("myCustomName");
  });
});

describe("getContinuousDefinition", () => {
  const registry = createPrimitiveRegistry({
    tokenRefresher: testContinuous,
    webhookBuffer: testBuffer,
  });

  it("returns definition when found", () => {
    const def = getContinuousDefinition(registry, "tokenRefresher");
    expect(def).toBeDefined();
    expect(def?._tag).toBe("continuous");
    expect(def?.name).toBe("tokenRefresher");
  });

  it("returns undefined when not found", () => {
    const def = getContinuousDefinition(registry, "nonexistent");
    expect(def).toBeUndefined();
  });
});

describe("getBufferDefinition", () => {
  const registry = createPrimitiveRegistry({
    webhookBuffer: testBuffer,
  });

  it("returns definition when found", () => {
    const def = getBufferDefinition(registry, "webhookBuffer");
    expect(def).toBeDefined();
    expect(def?._tag).toBe("buffer");
    expect(def?.name).toBe("webhookBuffer");
  });

  it("returns undefined when not found", () => {
    const def = getBufferDefinition(registry, "nonexistent");
    expect(def).toBeUndefined();
  });
});

describe("getQueueDefinition", () => {
  const registry = createPrimitiveRegistry({
    emailQueue: testQueue,
  });

  it("returns definition when found", () => {
    const def = getQueueDefinition(registry, "emailQueue");
    expect(def).toBeDefined();
    expect(def?._tag).toBe("queue");
    expect(def?.name).toBe("emailQueue");
  });

  it("returns undefined when not found", () => {
    const def = getQueueDefinition(registry, "nonexistent");
    expect(def).toBeUndefined();
  });
});

describe("getPrimitiveDefinition", () => {
  const registry = createPrimitiveRegistry({
    tokenRefresher: testContinuous,
    webhookBuffer: testBuffer,
    emailQueue: testQueue,
  });

  it("returns continuous definition by type", () => {
    const def = getPrimitiveDefinition(registry, "continuous", "tokenRefresher");
    expect(def?._tag).toBe("continuous");
  });

  it("returns buffer definition by type", () => {
    const def = getPrimitiveDefinition(registry, "buffer", "webhookBuffer");
    expect(def?._tag).toBe("buffer");
  });

  it("returns queue definition by type", () => {
    const def = getPrimitiveDefinition(registry, "queue", "emailQueue");
    expect(def?._tag).toBe("queue");
  });

  it("returns undefined for wrong type", () => {
    const def = getPrimitiveDefinition(registry, "buffer", "tokenRefresher");
    expect(def).toBeUndefined();
  });
});

describe("getAllPrimitiveNames", () => {
  it("returns all primitive names by type", () => {
    const registry = createPrimitiveRegistry({
      tokenRefresher: testContinuous,
      webhookBuffer: testBuffer,
      emailQueue: testQueue,
    });

    const names = getAllPrimitiveNames(registry);

    expect(names.continuous).toEqual(["tokenRefresher"]);
    expect(names.buffer).toEqual(["webhookBuffer"]);
    expect(names.queue).toEqual(["emailQueue"]);
  });

  it("returns empty arrays for empty registry", () => {
    const registry = createPrimitiveRegistry({});
    const names = getAllPrimitiveNames(registry);

    expect(names.continuous).toEqual([]);
    expect(names.buffer).toEqual([]);
    expect(names.queue).toEqual([]);
  });

  it("handles multiple definitions per type", () => {
    const secondContinuous: ContinuousDefinition<unknown, never, never> = {
      _tag: "continuous",
      name: "healthCheck",
      stateSchema: Schema.Unknown,
      schedule: { _tag: "Every", interval: "1 minute" },
      execute: () => Effect.void,
    };

    const registry = createPrimitiveRegistry({
      tokenRefresher: testContinuous,
      healthCheck: secondContinuous,
    });

    const names = getAllPrimitiveNames(registry);
    expect(names.continuous).toHaveLength(2);
    expect(names.continuous).toContain("tokenRefresher");
    expect(names.continuous).toContain("healthCheck");
  });
});
