// packages/jobs/src/client/client.ts

import { Effect } from "effect";
import type { JobRegistry } from "../registry/types";
import type { DurableJobsEngineInterface } from "../engine/types";
import type {
  JobsClient,
  ContinuousClient,
  DebounceClient,
  WorkerPoolClient,
  WorkerPoolAggregatedStatus,
  ClientError,
} from "./types";
import { narrowResponseEffect } from "./response";

// =============================================================================
// Instance ID Resolution
// =============================================================================

/**
 * Create instance ID for a job.
 *
 * Format: {jobType}:{jobName}:{userProvidedId}
 */
function createInstanceId(
  type: "continuous" | "debounce" | "workerPool",
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
): DurableJobsEngineInterface {
  const id = binding.idFromName(instanceId);
  // The DO stub implements our interface; we validate responses at runtime
  return binding.get(id) as unknown as DurableJobsEngineInterface;
}

// =============================================================================
// Client Factory
// =============================================================================

/**
 * Create a jobs client from a Durable Object binding.
 *
 * The client provides typed access to all registered jobs and
 * handles instance ID resolution and routing.
 *
 * @example
 * ```ts
 * const client = createJobsClient(env.JOBS, registry);
 *
 * // Access continuous job
 * await client.continuous("tokenRefresher").start({
 *   id: "user-123",
 *   input: { refreshToken: "rt_abc" },
 * });
 *
 * // Access debounce job
 * await client.debounce("webhookDebounce").add({
 *   id: "contact-456",
 *   event: { type: "contact.updated", data: {...} },
 * });
 *
 * // Access workerPool job (auto-routes to instance)
 * await client.workerPool("emailWorkerPool").enqueue({
 *   id: "email-789",
 *   event: { to: "user@example.com", template: "welcome" },
 * });
 * ```
 */
export function createJobsClient<R extends JobRegistry>(
  binding: DurableObjectNamespace,
  registry: R
): JobsClient<R> {
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
    // Debounce Client
    // -------------------------------------------------------------------------
    debounce: (name: string) => {
      const client: DebounceClient<unknown, unknown> = {
        add: ({ id, event, eventId }) => {
          const instanceId = createInstanceId("debounce", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "debounce",
              action: "add",
              name,
              id,
              event,
              eventId,
            }),
            "debounce.add"
          );
        },

        flush: (id) => {
          const instanceId = createInstanceId("debounce", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "debounce",
              action: "flush",
              name,
              id,
            }),
            "debounce.flush"
          );
        },

        clear: (id) => {
          const instanceId = createInstanceId("debounce", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "debounce",
              action: "clear",
              name,
              id,
            }),
            "debounce.clear"
          );
        },

        status: (id) => {
          const instanceId = createInstanceId("debounce", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "debounce",
              action: "status",
              name,
              id,
            }),
            "debounce.status"
          );
        },

        getState: (id) => {
          const instanceId = createInstanceId("debounce", name, id);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "debounce",
              action: "getState",
              name,
              id,
            }),
            "debounce.getState"
          );
        },
      };

      return client;
    },

    // -------------------------------------------------------------------------
    // WorkerPool Client
    // -------------------------------------------------------------------------
    workerPool: (name: string) => {
      const def = registry.workerPool.get(name);
      const concurrency = def?.concurrency ?? 1;

      // Round-robin counter for load distribution
      let roundRobinCounter = 0;

      const client: WorkerPoolClient<unknown> = {
        enqueue: ({ id, event, partitionKey, priority }) => {
          // Route to specific instance based on partitionKey or round-robin
          const instanceIndex = partitionKey
            ? consistentHash(partitionKey, concurrency)
            : roundRobinCounter++ % concurrency;

          const instanceId = createInstanceId("workerPool", name, instanceIndex);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "workerPool",
              action: "enqueue",
              name,
              instanceIndex,
              eventId: id,
              event,
              partitionKey,
              priority,
            }),
            "workerPool.enqueue"
          );
        },

        pause: (instanceIndex) => {
          if (instanceIndex !== undefined) {
            const instanceId = createInstanceId("workerPool", name, instanceIndex);
            const stub = getStub(binding, instanceId);
            return narrowResponseEffect(
              stub.call({
                type: "workerPool",
                action: "pause",
                name,
                instanceIndex,
              }),
              "workerPool.pause"
            );
          }

          // Pause all instances
          return Effect.gen(function* () {
            const results = yield* Effect.all(
              Array.from({ length: concurrency }, (_, i) => {
                const instanceId = createInstanceId("workerPool", name, i);
                const stub = getStub(binding, instanceId);
                return narrowResponseEffect(
                  stub.call({
                    type: "workerPool",
                    action: "pause",
                    name,
                    instanceIndex: i,
                  }),
                  "workerPool.pause"
                );
              }),
              { concurrency: "unbounded" }
            );

            return {
              _type: "workerPool.pause" as const,
              paused: results.every((r) => r.paused),
            };
          });
        },

        resume: (instanceIndex) => {
          if (instanceIndex !== undefined) {
            const instanceId = createInstanceId("workerPool", name, instanceIndex);
            const stub = getStub(binding, instanceId);
            return narrowResponseEffect(
              stub.call({
                type: "workerPool",
                action: "resume",
                name,
                instanceIndex,
              }),
              "workerPool.resume"
            );
          }

          // Resume all instances
          return Effect.gen(function* () {
            const results = yield* Effect.all(
              Array.from({ length: concurrency }, (_, i) => {
                const instanceId = createInstanceId("workerPool", name, i);
                const stub = getStub(binding, instanceId);
                return narrowResponseEffect(
                  stub.call({
                    type: "workerPool",
                    action: "resume",
                    name,
                    instanceIndex: i,
                  }),
                  "workerPool.resume"
                );
              }),
              { concurrency: "unbounded" }
            );

            return {
              _type: "workerPool.resume" as const,
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
                const instanceId = createInstanceId("workerPool", name, i);
                const stub = getStub(binding, instanceId);
                return narrowResponseEffect(
                  stub.call({
                    type: "workerPool",
                    action: "cancel",
                    name,
                    instanceIndex: i,
                    eventId,
                  }),
                  "workerPool.cancel"
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
                const instanceId = createInstanceId("workerPool", name, i);
                const stub = getStub(binding, instanceId);
                return narrowResponseEffect(
                  stub.call({
                    type: "workerPool",
                    action: "status",
                    name,
                    instanceIndex: i,
                  }),
                  "workerPool.status"
                );
              }),
              { concurrency: "unbounded" }
            );

            const aggregated: WorkerPoolAggregatedStatus = {
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
          const instanceId = createInstanceId("workerPool", name, instanceIndex);
          const stub = getStub(binding, instanceId);
          return narrowResponseEffect(
            stub.call({
              type: "workerPool",
              action: "status",
              name,
              instanceIndex,
            }),
            "workerPool.status"
          );
        },

        drain: (instanceIndex) => {
          if (instanceIndex !== undefined) {
            const instanceId = createInstanceId("workerPool", name, instanceIndex);
            const stub = getStub(binding, instanceId);
            return narrowResponseEffect(
              stub.call({
                type: "workerPool",
                action: "drain",
                name,
                instanceIndex,
              }),
              "workerPool.drain"
            );
          }

          // Drain all instances
          return Effect.gen(function* () {
            const results = yield* Effect.all(
              Array.from({ length: concurrency }, (_, i) => {
                const instanceId = createInstanceId("workerPool", name, i);
                const stub = getStub(binding, instanceId);
                return narrowResponseEffect(
                  stub.call({
                    type: "workerPool",
                    action: "drain",
                    name,
                    instanceIndex: i,
                  }),
                  "workerPool.drain"
                );
              }),
              { concurrency: "unbounded" }
            );

            return {
              _type: "workerPool.drain" as const,
              drained: results.every((r) => r.drained),
            };
          });
        },
      };

      return client;
    },
  } as JobsClient<R>;
}
