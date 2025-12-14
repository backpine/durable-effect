// packages/primitives/src/runtime/runtime.ts

import { Effect, Layer } from "effect";
import {
  createDurableObjectRuntime,
  NoopTrackerLayer,
  flushEvents,
  type RuntimeLayer,
} from "@durable-effect/core";
import { RuntimeServicesLayer, RegistryServiceLayer } from "../services";
import { PrimitiveHandlersLayer } from "../handlers";
import { Dispatcher, DispatcherLayer } from "./dispatcher";
import type { PrimitiveRequest, PrimitiveResponse } from "./types";
import type { PrimitiveRegistry } from "../registry/types";

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for creating a primitives runtime.
 */
export interface PrimitivesRuntimeConfig {
  /**
   * Durable Object state (provides storage + alarm).
   */
  readonly doState: DurableObjectState;

  /**
   * Optional tracker configuration.
   * If not provided, uses NoopTrackerLayer.
   */
  readonly tracker?: unknown; // TODO: Define TrackerConfig type

  /**
   * Registry of primitive definitions.
   * Required for handlers to look up definitions.
   */
  readonly registry?: PrimitiveRegistry;
}

/**
 * The primitives runtime interface.
 *
 * This is what the DO shell delegates to. It's a simple interface
 * that hides all the Effect complexity from the DO class.
 */
export interface PrimitivesRuntime {
  /**
   * Handle a primitive request.
   */
  readonly handle: (request: PrimitiveRequest) => Promise<PrimitiveResponse>;

  /**
   * Handle an alarm.
   */
  readonly handleAlarm: () => Promise<void>;

  /**
   * Flush any pending events.
   * Should be called via waitUntil after handle/handleAlarm.
   */
  readonly flush: () => Promise<void>;
}

// =============================================================================
// Shared Layer Composition
// =============================================================================

/**
 * Create the full dispatcher layer from a core layer and registry.
 *
 * This is the shared layer composition logic used by both
 * createPrimitivesRuntime and createPrimitivesRuntimeFromLayer.
 */
function createDispatcherLayer(
  coreLayer: RuntimeLayer,
  registry: PrimitiveRegistry
): Layer.Layer<Dispatcher> {
  // Registry layer
  const registryLayer = RegistryServiceLayer(registry);

  // Runtime services layer (MetadataService, AlarmService, IdempotencyService)
  const servicesLayer = RuntimeServicesLayer.pipe(
    Layer.provideMerge(NoopTrackerLayer),
    Layer.provideMerge(coreLayer)
  );

  // Handlers layer (ContinuousHandler, etc.)
  const handlersLayer = PrimitiveHandlersLayer.pipe(
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(servicesLayer)
  );

  // Dispatcher layer (routes requests to handlers)
  return DispatcherLayer.pipe(Layer.provideMerge(handlersLayer));
}

/**
 * Create empty registry for backwards compatibility.
 */
function createEmptyRegistry(): PrimitiveRegistry {
  return {
    continuous: new Map(),
    buffer: new Map(),
    queue: new Map(),
  };
}

/**
 * Create runtime implementation from dispatcher layer.
 */
function createRuntimeFromDispatcherLayer(
  dispatcherLayer: Layer.Layer<Dispatcher>
): PrimitivesRuntime {
  // Helper to run effects with full layer stack
  const runEffect = <A, E>(
    effect: Effect.Effect<A, E, Dispatcher>
  ): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(dispatcherLayer)));

  return {
    handle: (request: PrimitiveRequest) =>
      runEffect(
        Effect.gen(function* () {
          const dispatcher = yield* Dispatcher;
          return yield* dispatcher.handle(request);
        })
      ),

    handleAlarm: () =>
      runEffect(
        Effect.gen(function* () {
          const dispatcher = yield* Dispatcher;
          yield* dispatcher.handleAlarm();
        })
      ),

    flush: () => runEffect(flushEvents),
  };
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Creates a primitives runtime from DO state.
 *
 * This is the main entry point for the runtime layer. The DO class
 * creates this once in its constructor and delegates all operations to it.
 *
 * @example
 * ```ts
 * class DurablePrimitivesEngine extends DurableObject {
 *   #runtime: PrimitivesRuntime;
 *
 *   constructor(state: DurableObjectState, env: Env) {
 *     super(state, env);
 *     this.#runtime = createPrimitivesRuntime({
 *       doState: state,
 *       registry: env.__PRIMITIVE_REGISTRY__,
 *     });
 *   }
 *
 *   async call(request: PrimitiveRequest): Promise<PrimitiveResponse> {
 *     const result = await this.#runtime.handle(request);
 *     this.ctx.waitUntil(this.#runtime.flush());
 *     return result;
 *   }
 *
 *   async alarm(): Promise<void> {
 *     await this.#runtime.handleAlarm();
 *     this.ctx.waitUntil(this.#runtime.flush());
 *   }
 * }
 * ```
 */
export function createPrimitivesRuntime(
  config: PrimitivesRuntimeConfig
): PrimitivesRuntime {
  const coreLayer = createDurableObjectRuntime(config.doState);
  const registry = config.registry ?? createEmptyRegistry();
  const dispatcherLayer = createDispatcherLayer(coreLayer, registry);

  return createRuntimeFromDispatcherLayer(dispatcherLayer);
}

// =============================================================================
// Test Runtime Factory
// =============================================================================

/**
 * Creates a primitives runtime from a provided layer with optional registry.
 *
 * Used for testing with in-memory adapters.
 *
 * @example
 * ```ts
 * const { layer, handles } = createTestRuntime("test-instance", 1000000);
 * const runtime = createPrimitivesRuntimeFromLayer(layer, registry);
 *
 * await runtime.handle({ type: "continuous", action: "start", ... });
 * handles.scheduler.fire();
 * await runtime.handleAlarm();
 * ```
 */
export function createPrimitivesRuntimeFromLayer(
  coreLayer: RuntimeLayer,
  registry?: PrimitiveRegistry
): PrimitivesRuntime {
  const actualRegistry = registry ?? createEmptyRegistry();
  const dispatcherLayer = createDispatcherLayer(coreLayer, actualRegistry);

  return createRuntimeFromDispatcherLayer(dispatcherLayer);
}
