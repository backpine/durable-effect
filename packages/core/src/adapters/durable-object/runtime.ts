// packages/core/src/adapters/durable-object/runtime.ts

import { Effect, Layer } from "effect";
import { StorageAdapter } from "../storage";
import { SchedulerAdapter } from "../scheduler";
import { RuntimeAdapter, type RuntimeLayer } from "../runtime";
import { createDOStorageAdapter } from "./storage";
import { createDOSchedulerAdapter } from "./scheduler";

/**
 * Create a complete Durable Object runtime layer.
 *
 * This is the adapter that connects the workflow system to Cloudflare DOs.
 */
export function createDurableObjectRuntime(
  state: DurableObjectState,
): RuntimeLayer {
  const storageService = createDOStorageAdapter(state.storage);
  const schedulerService = createDOSchedulerAdapter(state.storage);

  const runtimeService = {
    instanceId: state.id.toString(),
    now: () => Effect.sync(() => Date.now()),
  };

  return Layer.mergeAll(
    Layer.succeed(StorageAdapter, storageService),
    Layer.succeed(SchedulerAdapter, schedulerService),
    Layer.succeed(RuntimeAdapter, runtimeService),
  );
}
