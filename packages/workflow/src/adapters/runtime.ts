// packages/workflow/src/adapters/runtime.ts

import { Context, Effect, Layer } from "effect";
import type { StorageAdapter } from "./storage";
import type { SchedulerAdapter } from "./scheduler";

/**
 * Lifecycle events emitted by the runtime.
 * These enable the orchestrator to react to runtime-level events.
 */
export type LifecycleEvent =
  | { readonly _tag: "Initialized" }
  | { readonly _tag: "AlarmFired" }
  | { readonly _tag: "Shutdown" }
  | { readonly _tag: "Reset"; readonly reason?: string };

/**
 * Runtime-level adapter providing identity and lifecycle hooks.
 */
export interface RuntimeAdapterService {
  /**
   * Unique identifier for this workflow instance.
   * In DO: the Durable Object ID
   * In tests: a generated UUID
   */
  readonly instanceId: string;

  /**
   * Get the current time (for testing time control).
   * In production: Date.now()
   * In tests: controllable clock
   */
  readonly now: () => Effect.Effect<number>;
}

/**
 * Effect service tag for RuntimeAdapter.
 */
export class RuntimeAdapter extends Context.Tag(
  "@durable-effect/RuntimeAdapter",
)<RuntimeAdapter, RuntimeAdapterService>() {}

/**
 * Complete runtime layer type.
 * All runtime adapters combined into a single layer.
 */
export type RuntimeLayer = Layer.Layer<
  StorageAdapter | SchedulerAdapter | RuntimeAdapter
>;
