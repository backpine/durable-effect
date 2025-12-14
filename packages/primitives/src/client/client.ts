// packages/primitives/src/client/client.ts

import { Effect } from "effect";
import type { PrimitiveRegistry } from "../registry/types";
import type { DurablePrimitivesEngineInterface } from "../engine/types";
import type {
  PrimitivesClient,
  ContinuousClient,
  BufferClient,
  QueueClient,
  QueueAggregatedStatus,
  ClientError,
} from "./types";
import { narrowResponseEffect, primitiveCallError } from "./response";

// =============================================================================
// Instance ID Resolution
// =============================================================================

/**
 * Create instance ID for a primitive.
 *
 * Format: {primitiveType}:{primitiveName}:{userProvidedId}
 */
function createInstanceId(
  type: "continuous" | "buffer" | "queue",
  name: string,
  id: string | number
): string {
  return `${type}:${name}:${id}`;
}

/**
 * Consistent hash for partition key routing.
 */
function consistentHash(key: string, buckets: number): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash) % buckets;
}

// =============================================================================
// DO Stub Helper
// =============================================================================

/**
 * Get a typed DO stub for an instance.
 *
 * Note: We use a runtime cast here because Cloudflare's DurableObjectNamespace
 * generic typing doesn't work well with the DurableObjectBranded constraint.
 * The call() method signature is validated by our response narrowing.
 */
function getStub(
  binding: DurableObjectNamespace,
  instanceId: string
): DurablePrimitivesEngineInterface {
  const id = binding.idFromName(instanceId);
  // The DO stub implements our interface; we validate responses at runtime
  return binding.get(id) as unknown as DurablePrimitivesEngineInterface;
}

// =============================================================================
// Client Factory
// =============================================================================

/**
 * Create a primitives client from a Durable Object binding.
 *
 * The client provides typed access to all registered primitives and
 * handles instance ID resolution and routing.
 *
 * @example
 * ```ts
 * const client = createPrimitivesClient(env.PRIMITIVES, registry);
 *
 * // Access continuous primitive
 * await client.continuous("tokenRefresher").start({
 *   id: "user-123",
 *   input: { refreshToken: "rt_abc" },
 * });
 *
 * // Access buffer primitive
 * await client.buffer("webhookBuffer").add({
 *   id: "contact-456",
 *   event: { type: "contact.updated", data: {...} },
 * });
 *
 * // Access queue primitive (auto-routes to instance)
 * await client.queue("emailQueue").enqueue({
 *   id: "email-789",
 *   event: { to: "user@example.com", template: "welcome" },
 * });
 * ```
 */
export function createPrimitivesClient<R extends PrimitiveRegistry>(
  binding: DurableObjectNamespace,
  registry: R
): PrimitivesClient<R> {
  return {
    // -------------------------------------------------------------------------
    // Continuous Client
    // -------------------------------------------------------------------------
    continuous: (name: string) => {
      const client: ContinuousClient<unknown> = {
        start: ({ id, input }) => {
          const instanceId = createInstanceId("continuous", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "continuous",
              action: "start",
              name,
              id,
              input,
            }),
            "continuous.start"
          );
        },

        stop: (id, options) => {
          const instanceId = createInstanceId("continuous", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "continuous",
              action: "stop",
              name,
              id,
              reason: options?.reason,
            }),
            "continuous.stop"
          );
        },

        trigger: (id) => {
          const instanceId = createInstanceId("continuous", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "continuous",
              action: "trigger",
              name,
              id,
            }),
            "continuous.trigger"
          );
        },

        status: (id) => {
          const instanceId = createInstanceId("continuous", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "continuous",
              action: "status",
              name,
              id,
            }),
            "continuous.status"
          );
        },

        getState: (id) => {
          const instanceId = createInstanceId("continuous", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "continuous",
              action: "getState",
              name,
              id,
            }),
            "continuous.getState"
          );
        },
      };

      return client;
    },

    // -------------------------------------------------------------------------
    // Buffer Client
    // -------------------------------------------------------------------------
    buffer: (name: string) => {
      const client: BufferClient<unknown, unknown> = {
        add: ({ id, event, eventId }) => {
          const instanceId = createInstanceId("buffer", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "buffer",
              action: "add",
              name,
              id,
              event,
              eventId,
            }),
            "buffer.add"
          );
        },

        flush: (id) => {
          const instanceId = createInstanceId("buffer", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "buffer",
              action: "flush",
              name,
              id,
            }),
            "buffer.flush"
          );
        },

        clear: (id) => {
          const instanceId = createInstanceId("buffer", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "buffer",
              action: "clear",
              name,
              id,
            }),
            "buffer.clear"
          );
        },

        status: (id) => {
          const instanceId = createInstanceId("buffer", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "buffer",
              action: "status",
              name,
              id,
            }),
            "buffer.status"
          );
        },

        getState: (id) => {
          const instanceId = createInstanceId("buffer", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "buffer",
              action: "getState",
              name,
              id,
            }),
            "buffer.getState"
          );
        },
      };

      return client;
    },

    // -------------------------------------------------------------------------
    // Queue Client
    // -------------------------------------------------------------------------
    queue: (name: string) => {
      const def = registry.queue.get(name);
      const concurrency = def?.concurrency ?? 1;

      // Round-robin counter for load distribution
      let roundRobinCounter = 0;

      const client: QueueClient<unknown> = {
        enqueue: ({ id, event, partitionKey, priority }) => {
          // Route to specific instance based on partitionKey or round-robin
          const instanceIndex = partitionKey
            ? consistentHash(partitionKey, concurrency)
            : roundRobinCounter++ % concurrency;

          const instanceId = createInstanceId("queue", name, instanceIndex);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "queue",
              action: "enqueue",
              name,
              instanceIndex,
              eventId: id,
              event,
              partitionKey,
              priority,
            }),
            "queue.enqueue"
          );
        },

        pause: (instanceIndex) => {
          if (instanceIndex !== undefined) {
            const instanceId = createInstanceId("queue", name, instanceIndex);
            const stub = getStub(binding, instanceId);
            return narrowResponseEffect(
              stub.call({
                type: "queue",
                action: "pause",
                name,
                instanceIndex,
              }),
              "queue.pause"
            );
          }

          // Pause all instances
          return Effect.gen(function* () {
            const results = yield* Effect.all(
              Array.from({ length: concurrency }, (_, i) => {
                const instanceId = createInstanceId("queue", name, i);
                const stub = getStub(binding, instanceId);
                return narrowResponseEffect(
                  stub.call({
                    type: "queue",
                    action: "pause",
                    name,
                    instanceIndex: i,
                  }),
                  "queue.pause"
                );
              }),
              { concurrency: "unbounded" }
            );

            return {
              _type: "queue.pause" as const,
              paused: results.every((r) => r.paused),
            };
          });
        },

        resume: (instanceIndex) => {
          if (instanceIndex !== undefined) {
            const instanceId = createInstanceId("queue", name, instanceIndex);
            const stub = getStub(binding, instanceId);
            return narrowResponseEffect(
              stub.call({
                type: "queue",
                action: "resume",
                name,
                instanceIndex,
              }),
              "queue.resume"
            );
          }

          // Resume all instances
          return Effect.gen(function* () {
            const results = yield* Effect.all(
              Array.from({ length: concurrency }, (_, i) => {
                const instanceId = createInstanceId("queue", name, i);
                const stub = getStub(binding, instanceId);
                return narrowResponseEffect(
                  stub.call({
                    type: "queue",
                    action: "resume",
                    name,
                    instanceIndex: i,
                  }),
                  "queue.resume"
                );
              }),
              { concurrency: "unbounded" }
            );

            return {
              _type: "queue.resume" as const,
              resumed: results.every((r) => r.resumed),
            };
          });
        },

        cancel: (eventId) => {
          // Cancel needs to find the right instance
          // For now, broadcast to all instances
          return Effect.gen(function* () {
            const results = yield* Effect.all(
              Array.from({ length: concurrency }, (_, i) => {
                const instanceId = createInstanceId("queue", name, i);
                const stub = getStub(binding, instanceId);
                return narrowResponseEffect(
                  stub.call({
                    type: "queue",
                    action: "cancel",
                    name,
                    instanceIndex: i,
                    eventId,
                  }),
                  "queue.cancel"
                );
              }),
              { concurrency: "unbounded" }
            );

            // Return first success or last result
            const success = results.find((r) => r.cancelled);
            return success ?? results[results.length - 1];
          });
        },

        status: () => {
          // Aggregate status from all instances
          return Effect.gen(function* () {
            const instances = yield* Effect.all(
              Array.from({ length: concurrency }, (_, i) => {
                const instanceId = createInstanceId("queue", name, i);
                const stub = getStub(binding, instanceId);
                return narrowResponseEffect(
                  stub.call({
                    type: "queue",
                    action: "status",
                    name,
                    instanceIndex: i,
                  }),
                  "queue.status"
                );
              }),
              { concurrency: "unbounded" }
            );

            const aggregated: QueueAggregatedStatus = {
              instances,
              totalPending: instances.reduce(
                (sum, i) => sum + (i.pendingCount ?? 0),
                0
              ),
              totalProcessed: instances.reduce(
                (sum, i) => sum + (i.processedCount ?? 0),
                0
              ),
              activeInstances: instances.filter(
                (i) => i.status === "processing" || i.status === "idle"
              ).length,
              pausedInstances: instances.filter((i) => i.status === "paused")
                .length,
            };

            return aggregated;
          });
        },

        instanceStatus: (instanceIndex) => {
          const instanceId = createInstanceId("queue", name, instanceIndex);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "queue",
              action: "status",
              name,
              instanceIndex,
            }),
            "queue.status"
          );
        },

        drain: (instanceIndex) => {
          if (instanceIndex !== undefined) {
            const instanceId = createInstanceId("queue", name, instanceIndex);
            const stub = getStub(binding, instanceId);
            return narrowResponseEffect(
              stub.call({
                type: "queue",
                action: "drain",
                name,
                instanceIndex,
              }),
              "queue.drain"
            );
          }

          // Drain all instances
          return Effect.gen(function* () {
            const results = yield* Effect.all(
              Array.from({ length: concurrency }, (_, i) => {
                const instanceId = createInstanceId("queue", name, i);
                const stub = getStub(binding, instanceId);
                return narrowResponseEffect(
                  stub.call({
                    type: "queue",
                    action: "drain",
                    name,
                    instanceIndex: i,
                  }),
                  "queue.drain"
                );
              }),
              { concurrency: "unbounded" }
            );

            return {
              _type: "queue.drain" as const,
              drained: results.every((r) => r.drained),
            };
          });
        },
      };

      return client;
    },
  } as PrimitivesClient<R>;
}
