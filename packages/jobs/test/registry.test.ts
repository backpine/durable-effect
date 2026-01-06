// packages/jobs/test/registry.test.ts

import { describe, it, expect } from "vitest";
import { Schema, Effect } from "effect";
import {
  createJobRegistry,
  getContinuousDefinition,
  getDebounceDefinition,
  getWorkerPoolDefinition,
  getJobDefinition,
  getAllJobNames,
} from "../src/registry";
import type {
  UnregisteredContinuousDefinition,
  UnregisteredDebounceDefinition,
  UnregisteredWorkerPoolDefinition,
} from "../src/registry/types";

// =============================================================================
// Test Definitions
// =============================================================================

const TokenState = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
});

const testContinuous: UnregisteredContinuousDefinition<
  typeof TokenState.Type,
  never
> = {
  _tag: "ContinuousDefinition",
  stateSchema: TokenState,
  schedule: { _tag: "Every", interval: "30 minutes" },
  startImmediately: true,
  execute: () => Effect.void,
};

const WebhookEvent = Schema.Struct({
  type: Schema.String,
  data: Schema.Unknown,
});

const DebounceState = Schema.Struct({
  events: Schema.Array(WebhookEvent),
});

const testDebounce: UnregisteredDebounceDefinition<
  typeof WebhookEvent.Type,
  typeof DebounceState.Type,
  never
> = {
  _tag: "DebounceDefinition",
  eventSchema: WebhookEvent,
  stateSchema: DebounceState,
  flushAfter: "5 minutes",
  maxEvents: 100,
  execute: () => Effect.void,
};

const EmailEvent = Schema.Struct({
  to: Schema.String,
  template: Schema.String,
});

const testWorkerPool: UnregisteredWorkerPoolDefinition<typeof EmailEvent.Type, Error> = {
  _tag: "WorkerPoolDefinition",
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

describe("createJobRegistry", () => {
  it("creates empty maps for each primitive type", () => {
    const registry = createJobRegistry({});

    expect(registry.continuous.size).toBe(0);
    expect(registry.debounce.size).toBe(0);
    expect(registry.workerPool.size).toBe(0);
  });

  it("registers continuous definitions by key name", () => {
    const registry = createJobRegistry({
      tokenRefresher: testContinuous,
    });

    expect(registry.continuous.size).toBe(1);
    expect(registry.continuous.has("tokenRefresher")).toBe(true);

    const def = registry.continuous.get("tokenRefresher");
    expect(def?._tag).toBe("ContinuousDefinition");
    expect(def?.name).toBe("tokenRefresher");
    expect(def?.schedule._tag).toBe("Every");
  });

  it("registers debounce definitions by key name", () => {
    const registry = createJobRegistry({
      webhookDebounce: testDebounce,
    });

    expect(registry.debounce.size).toBe(1);
    expect(registry.debounce.has("webhookDebounce")).toBe(true);

    const def = registry.debounce.get("webhookDebounce");
    expect(def?._tag).toBe("DebounceDefinition");
    expect(def?.name).toBe("webhookDebounce");
    expect(def?.maxEvents).toBe(100);
  });

  it("registers workerPool definitions by key name", () => {
    const registry = createJobRegistry({
      emailWorkerPool: testWorkerPool,
    });

    expect(registry.workerPool.size).toBe(1);
    expect(registry.workerPool.has("emailWorkerPool")).toBe(true);

    const def = registry.workerPool.get("emailWorkerPool");
    expect(def?._tag).toBe("WorkerPoolDefinition");
    expect(def?.name).toBe("emailWorkerPool");
    expect(def?.concurrency).toBe(5);
  });

  it("registers mixed primitive types correctly", () => {
    const registry = createJobRegistry({
      tokenRefresher: testContinuous,
      webhookDebounce: testDebounce,
      emailWorkerPool: testWorkerPool,
    });

    expect(registry.continuous.size).toBe(1);
    expect(registry.debounce.size).toBe(1);
    expect(registry.workerPool.size).toBe(1);

    expect(registry.continuous.has("tokenRefresher")).toBe(true);
    expect(registry.debounce.has("webhookDebounce")).toBe(true);
    expect(registry.workerPool.has("emailWorkerPool")).toBe(true);
  });

  it("assigns name from key even if different from definition name", () => {
    const registry = createJobRegistry({
      myCustomName: { ...testContinuous, name: "originalName" },
    });

    const def = registry.continuous.get("myCustomName");
    expect(def?.name).toBe("myCustomName");
  });
});

describe("getContinuousDefinition", () => {
  const registry = createJobRegistry({
    tokenRefresher: testContinuous,
    webhookDebounce: testDebounce,
  });

  it("returns definition when found", () => {
    const def = getContinuousDefinition(registry, "tokenRefresher");
    expect(def).toBeDefined();
    expect(def?._tag).toBe("ContinuousDefinition");
    expect(def?.name).toBe("tokenRefresher");
  });

  it("returns undefined when not found", () => {
    const def = getContinuousDefinition(registry, "nonexistent");
    expect(def).toBeUndefined();
  });
});

describe("getDebounceDefinition", () => {
  const registry = createJobRegistry({
    webhookDebounce: testDebounce,
  });

  it("returns definition when found", () => {
    const def = getDebounceDefinition(registry, "webhookDebounce");
    expect(def).toBeDefined();
    expect(def?._tag).toBe("DebounceDefinition");
    expect(def?.name).toBe("webhookDebounce");
  });

  it("returns undefined when not found", () => {
    const def = getDebounceDefinition(registry, "nonexistent");
    expect(def).toBeUndefined();
  });
});

describe("getWorkerPoolDefinition", () => {
  const registry = createJobRegistry({
    emailWorkerPool: testWorkerPool,
  });

  it("returns definition when found", () => {
    const def = getWorkerPoolDefinition(registry, "emailWorkerPool");
    expect(def).toBeDefined();
    expect(def?._tag).toBe("WorkerPoolDefinition");
    expect(def?.name).toBe("emailWorkerPool");
  });

  it("returns undefined when not found", () => {
    const def = getWorkerPoolDefinition(registry, "nonexistent");
    expect(def).toBeUndefined();
  });
});

describe("getJobDefinition", () => {
  const registry = createJobRegistry({
    tokenRefresher: testContinuous,
    webhookDebounce: testDebounce,
    emailWorkerPool: testWorkerPool,
  });

  it("returns continuous definition by type", () => {
    const def = getJobDefinition(registry, "continuous", "tokenRefresher");
    expect(def?._tag).toBe("ContinuousDefinition");
  });

  it("returns debounce definition by type", () => {
    const def = getJobDefinition(registry, "debounce", "webhookDebounce");
    expect(def?._tag).toBe("DebounceDefinition");
  });

  it("returns workerPool definition by type", () => {
    const def = getJobDefinition(registry, "workerPool", "emailWorkerPool");
    expect(def?._tag).toBe("WorkerPoolDefinition");
  });

  it("returns undefined for wrong type", () => {
    const def = getJobDefinition(registry, "debounce", "tokenRefresher");
    expect(def).toBeUndefined();
  });
});

describe("getAllJobNames", () => {
  it("returns all primitive names by type", () => {
    const registry = createJobRegistry({
      tokenRefresher: testContinuous,
      webhookDebounce: testDebounce,
      emailWorkerPool: testWorkerPool,
    });

    const names = getAllJobNames(registry);

    expect(names.continuous).toEqual(["tokenRefresher"]);
    expect(names.debounce).toEqual(["webhookDebounce"]);
    expect(names.workerPool).toEqual(["emailWorkerPool"]);
  });

  it("returns empty arrays for empty registry", () => {
    const registry = createJobRegistry({});
    const names = getAllJobNames(registry);

    expect(names.continuous).toEqual([]);
    expect(names.debounce).toEqual([]);
    expect(names.workerPool).toEqual([]);
  });

  it("handles multiple definitions per type", () => {
    const secondContinuous: UnregisteredContinuousDefinition<unknown, never> = {
      _tag: "ContinuousDefinition",
      stateSchema: Schema.Unknown,
      schedule: { _tag: "Every", interval: "1 minute" },
      execute: () => Effect.void,
    };

    const registry = createJobRegistry({
      tokenRefresher: testContinuous,
      healthCheck: secondContinuous,
    });

    const names = getAllJobNames(registry);
    expect(names.continuous).toHaveLength(2);
    expect(names.continuous).toContain("tokenRefresher");
    expect(names.continuous).toContain("healthCheck");
  });
});
