// packages/workflow-v2/src/engine/engine.ts

import { DurableObject } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { createDurableObjectRuntime } from "../adapters/durable-object";
import { StorageAdapter } from "../adapters/storage";
import { WorkflowStateMachine, WorkflowStateMachineLayer } from "../state/machine";
import { RecoveryManager, RecoveryManagerLayer } from "../recovery";
import { WorkflowExecutorLayer } from "../executor";
import {
  WorkflowOrchestrator,
  WorkflowOrchestratorLayer,
  WorkflowRegistryLayer,
  type WorkflowRegistry,
  type WorkflowCall,
} from "../orchestrator";
import {
  HttpBatchTrackerLayer,
  NoopTrackerLayer,
  flushEvents,
} from "../tracker";
import type {
  CreateDurableWorkflowsOptions,
  CreateDurableWorkflowsResult,
  DurableWorkflowEngineInterface,
  WorkflowClientFactory,
  WorkflowClientInstance,
} from "./types";

/**
 * Create a Durable Workflow engine for a set of workflows.
 *
 * This is the main factory function for creating production workflow engines.
 *
 * @example
 * ```ts
 * // Define workflows
 * const myWorkflows = {
 *   processOrder: Workflow.make(
 *     { name: "processOrder" },
 *     (input: { orderId: string }) =>
 *       Effect.gen(function* () {
 *         const order = yield* Workflow.step("fetch", fetchOrder(input.orderId));
 *         yield* Workflow.sleep("1 hour");
 *         return yield* Workflow.step("process", processOrder(order));
 *       })
 *   ),
 * };
 *
 * // Create engine
 * const { Workflows, WorkflowClient } = createDurableWorkflows(myWorkflows, {
 *   tracker: {
 *     endpoint: "https://events.example.com/ingest",
 *     env: "production",
 *     serviceKey: "my-service",
 *   },
 * });
 *
 * // Export for Cloudflare
 * export { Workflows };
 *
 * // Use client in worker
 * const client = WorkflowClient.fromBinding(env.WORKFLOWS, { idFromName: orderId });
 * await client.run({ workflow: "processOrder", input: { orderId } });
 * ```
 */
export function createDurableWorkflows<const W extends WorkflowRegistry>(
  workflows: W,
  options?: CreateDurableWorkflowsOptions
): CreateDurableWorkflowsResult<W> {
  // Create engine class
  class DurableWorkflowEngine
    extends DurableObject
    implements DurableWorkflowEngineInterface<W>
  {
    readonly #runtimeLayer: Layer.Layer<never, never, never>;
    readonly #orchestratorLayer: Layer.Layer<
      WorkflowOrchestrator | RecoveryManager | WorkflowStateMachine | StorageAdapter,
      never,
      never
    >;

    constructor(state: DurableObjectState, env: unknown) {
      super(state, env as never);

      // Create runtime adapter layer
      this.#runtimeLayer = createDurableObjectRuntime(state);

      // Create tracker layer
      const trackerLayer = options?.tracker
        ? HttpBatchTrackerLayer(options.tracker)
        : NoopTrackerLayer;

      // Create full orchestrator layer
      this.#orchestratorLayer = WorkflowOrchestratorLayer<W>().pipe(
        Layer.provideMerge(WorkflowRegistryLayer(workflows)),
        Layer.provideMerge(WorkflowExecutorLayer),
        Layer.provideMerge(RecoveryManagerLayer(options?.recovery)),
        Layer.provideMerge(WorkflowStateMachineLayer),
        Layer.provideMerge(trackerLayer),
        Layer.provideMerge(this.#runtimeLayer)
      ) as Layer.Layer<
        WorkflowOrchestrator | RecoveryManager | WorkflowStateMachine | StorageAdapter,
        never,
        never
      >;

      // Run recovery check in constructor
      state.blockConcurrencyWhile(async () => {
        await this.#runEffect(
          Effect.gen(function* () {
            const recovery = yield* RecoveryManager;
            const result = yield* recovery.checkAndScheduleRecovery();

            // Log recovery if needed
            if (result.scheduled) {
              console.log(
                `[Workflow] Recovery scheduled: ${result.reason} (stale for ${result.staleDurationMs}ms)`
              );
            }
          })
        );
      });
    }

    // Helper to run effects with full layer stack
    #runEffect<A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> {
      return Effect.runPromise(
        effect.pipe(
          Effect.provide(this.#orchestratorLayer as Layer.Layer<any, never, never>)
        )
      );
    }

    async run(call: WorkflowCall<W>): Promise<{ id: string; completed: boolean }> {
      const result = await this.#runEffect(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          const result = yield* orchestrator.start(call);
          yield* flushEvents;
          return result;
        })
      );

      return { id: result.id, completed: result.completed };
    }

    async runAsync(call: WorkflowCall<W>): Promise<{ id: string }> {
      const result = await this.#runEffect(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          const result = yield* orchestrator.queue(call);
          yield* flushEvents;
          return result;
        })
      );

      return { id: result.id };
    }

    async alarm(): Promise<void> {
      await this.#runEffect(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          yield* orchestrator.handleAlarm();
          yield* flushEvents;
        })
      );
    }

    async cancel(options?: { reason?: string }): Promise<{
      cancelled: boolean;
      reason?: string;
    }> {
      const result = await this.#runEffect(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.cancel(options);
        })
      );

      return {
        cancelled: result.cancelled,
        reason: result.reason,
      };
    }

    async getStatus() {
      const result = await this.#runEffect(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator;
          return yield* orchestrator.getStatus();
        })
      );

      return result.status;
    }

    async getCompletedSteps(): Promise<readonly string[]> {
      const result = await this.#runEffect(
        Effect.gen(function* () {
          const machine = yield* WorkflowStateMachine;
          return yield* machine.getCompletedSteps();
        })
      );

      return result;
    }

    async getMeta<T>(key: string): Promise<T | undefined> {
      return this.#runEffect(
        Effect.gen(function* () {
          const storage = yield* StorageAdapter;
          return yield* storage.get<T>(`workflow:meta:${key}`);
        })
      );
    }
  }

  // Create client factory
  const WorkflowClient: WorkflowClientFactory<W> = {
    fromBinding(binding, clientOptions) {
      const id =
        clientOptions?.id ??
        (clientOptions?.idFromName
          ? binding.idFromName(clientOptions.idFromName)
          : binding.newUniqueId());

      const stub = binding.get(id) as unknown as DurableWorkflowEngineInterface<W>;

      return {
        id: id.toString(),

        run: (call) => stub.run(call),
        runAsync: (call) => stub.runAsync(call),
        cancel: (opts) => stub.cancel(opts),
        getStatus: () => stub.getStatus(),
      } as WorkflowClientInstance<W>;
    },
  };

  return {
    Workflows: DurableWorkflowEngine as unknown as CreateDurableWorkflowsResult<W>["Workflows"],
    WorkflowClient,
  };
}
