import { DurableObject } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "@effect/platform";
import {
  ExecutionContext,
  PauseSignal,
  createExecutionContext,
  createBaseEvent,
} from "@durable-effect/core";
import {
  WorkflowContext,
  createWorkflowContext,
  setWorkflowStatus,
  storeWorkflowMeta,
  loadWorkflowMeta,
} from "@/services/workflow-context";
import {
  EventTracker,
  emitEvent,
  createHttpBatchTracker,
  type EventTrackerConfig,
} from "@/tracker";
import { StepError } from "@/errors";
import type {
  DurableWorkflowInstance,
  WorkflowCall,
  WorkflowRegistry,
  WorkflowStatus,
} from "@/types";

/**
 * Options for creating a durable workflow engine.
 */
export interface CreateDurableWorkflowsOptions {
  /**
   * Optional event tracker configuration.
   * If provided, workflow events will be sent to the specified endpoint.
   */
  readonly tracker?: EventTrackerConfig;
}

/**
 * Result returned when starting a workflow.
 */
export interface WorkflowRunResult {
  /** Unique identifier for this workflow instance */
  readonly id: string;
}

/**
 * Interface for type-safe workflow execution.
 * Uses discriminated unions for type safety through RPC proxies.
 */
export interface TypedWorkflowEngine<W extends WorkflowRegistry> {
  /**
   * Run a workflow with type-safe input.
   *
   * Uses a discriminated union where `workflow` determines the `input` type.
   * This pattern works reliably through Cloudflare RPC proxies.
   *
   * @example
   * ```typescript
   * // TypeScript enforces correct input type
   * await stub.run({ workflow: 'processOrder', input: 'order-123' }); // ✅
   * await stub.run({ workflow: 'processOrder', input: { wrong: true } }); // ❌
   * await stub.run({ workflow: 'sendEmail', input: { to: 'a@b.com' } }); // ✅
   * ```
   */
  run(call: WorkflowCall<W>): Promise<WorkflowRunResult>;

  /**
   * Get the current workflow status.
   */
  getStatus(): Promise<WorkflowStatus | undefined>;

  /**
   * Get list of completed step names.
   */
  getCompletedSteps(): Promise<ReadonlyArray<string>>;

  /**
   * Get workflow-level metadata.
   */
  getMeta<T>(key: string): Promise<T | undefined>;
}

/**
 * Creates a Durable Object class that executes Effect-based workflows.
 *
 * @example
 * ```typescript
 * const workflows = {
 *   processOrder: Workflow.make('processOrder', (orderId: string) =>
 *     Effect.gen(function* () {
 *       const order = yield* Workflow.step('Fetch', fetchOrder(orderId));
 *       yield* Workflow.step('Process',
 *         process(order).pipe(Workflow.retry({ maxAttempts: 3 }))
 *       );
 *     })
 *   ),
 *   sendEmail: Workflow.make('sendEmail', (input: { to: string }) =>
 *     Effect.gen(function* () {
 *       yield* Workflow.step('Send', sendEmail(input.to));
 *     })
 *   ),
 * } as const;
 *
 * // Create the Durable Object class (without tracking)
 * export const MyWorkflows = createDurableWorkflows(workflows);
 *
 * // Create with event tracking
 * export const TrackedWorkflows = createDurableWorkflows(workflows, {
 *   tracker: {
 *     url: "https://tracker.example.com/api/events",
 *     accessToken: "your-token",
 *   },
 * });
 *
 * // Usage from Worker
 * const id = env.MY_WORKFLOWS.idFromName('order-123');
 * const stub = env.MY_WORKFLOWS.get(id);
 *
 * // Type-safe dispatch
 * await stub.run({ workflow: 'processOrder', input: 'order-123' }); // ✅
 * await stub.run({ workflow: 'sendEmail', input: { to: 'a@b.com' } }); // ✅
 *
 * // Check status
 * const status = await stub.getStatus();
 * const steps = await stub.getCompletedSteps();
 * ```
 */
export function createDurableWorkflows<const T extends WorkflowRegistry>(
  workflows: T,
  options?: CreateDurableWorkflowsOptions,
): new (state: DurableObjectState, env: unknown) => DurableWorkflowInstance<T> {
  const trackerConfig = options?.tracker;

  return class DurableWorkflowEngine
    extends DurableObject
    implements TypedWorkflowEngine<T>
  {
    /** The workflows registry */
    readonly #workflows: T = workflows;

    /** Event tracker layer (if configured) */
    readonly #trackerLayer: Layer.Layer<EventTracker> | undefined =
      trackerConfig
        ? Layer.scoped(
            EventTracker,
            createHttpBatchTracker(trackerConfig),
          ).pipe(Layer.provide(FetchHttpClient.layer))
        : undefined;

    constructor(state: DurableObjectState, env: unknown) {
      super(state, env as never);
    }

    /**
     * Run a workflow with the given call.
     * Idempotent - if workflow already running/completed, returns existing state.
     */
    async run(call: WorkflowCall<T>): Promise<WorkflowRunResult> {
      const { workflow: workflowName, input } = call;
      const workflowId = this.ctx.id.toString();

      // Check if workflow already exists
      const existingStatus =
        await this.ctx.storage.get<WorkflowStatus>("workflow:status");

      // If already completed or failed, return the id
      if (
        existingStatus?._tag === "Completed" ||
        existingStatus?._tag === "Failed"
      ) {
        return { id: workflowId };
      }

      // If already running or paused, return (idempotent)
      if (
        existingStatus?._tag === "Running" ||
        existingStatus?._tag === "Paused"
      ) {
        return { id: workflowId };
      }

      // Get workflow definition
      const workflowDef = this.#workflows[workflowName];
      if (!workflowDef) {
        throw new Error(`Unknown workflow: ${String(workflowName)}`);
      }

      // Store workflow metadata and set initial status
      const storage = this.ctx.storage;
      const setupEffect = Effect.gen(function* () {
        yield* storeWorkflowMeta(storage, String(workflowName), input);
        yield* setWorkflowStatus(storage, { _tag: "Running" });

        // Emit workflow started event
        yield* emitEvent({
          ...createBaseEvent(workflowId, String(workflowName)),
          type: "workflow.started",
          input,
        });
      });

      await Effect.runPromise(setupEffect);

      // Execute the workflow
      await this.#executeWorkflow(workflowId, String(workflowName), input);

      return { id: workflowId };
    }

    /**
     * Handle alarm - resume paused workflow.
     */
    async alarm(): Promise<void> {
      const status =
        await this.ctx.storage.get<WorkflowStatus>("workflow:status");

      // Only resume if paused
      if (status?._tag !== "Paused") {
        return;
      }

      // Load workflow metadata
      const meta = await Effect.runPromise(loadWorkflowMeta(this.ctx.storage));

      if (!meta.workflowName) {
        console.error("Alarm fired but no workflow name found");
        return;
      }

      const workflowId = this.ctx.id.toString();
      const workflowName = meta.workflowName;
      const storage = this.ctx.storage;

      // Set status to running and emit resumed event
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* setWorkflowStatus(storage, { _tag: "Running" });

          // Emit workflow resumed event
          yield* emitEvent({
            ...createBaseEvent(workflowId, workflowName),
            type: "workflow.resumed",
          });
        }),
      );

      // Resume execution
      await this.#executeWorkflow(workflowId, workflowName, meta.input);
    }

    /**
     * Execute the workflow effect with all contexts provided.
     */
    async #executeWorkflow(
      workflowId: string,
      workflowName: string,
      input: unknown,
    ): Promise<void> {
      const workflowDef = this.#workflows[workflowName as keyof T];
      if (!workflowDef) {
        await Effect.runPromise(
          setWorkflowStatus(this.ctx.storage, {
            _tag: "Failed",
            error: `Unknown workflow: ${workflowName}`,
            failedAt: Date.now(),
          }),
        );
        return;
      }

      // Create the services
      const execCtx = createExecutionContext(this.ctx);
      const workflowCtx = createWorkflowContext(
        workflowId,
        workflowName,
        input,
        this.ctx.storage,
      );

      // Build the workflow effect with services provided
      let workflowEffect = workflowDef
        .definition(input)
        .pipe(
          Effect.provideService(ExecutionContext, execCtx),
          Effect.provideService(WorkflowContext, workflowCtx),
        );

      // Provide tracker layer if configured
      if (this.#trackerLayer) {
        workflowEffect = workflowEffect.pipe(
          Effect.provide(this.#trackerLayer),
        );
      }

      // Execute and handle results
      const startTime = Date.now();
      const result = await Effect.runPromiseExit(workflowEffect);
      const storage = this.ctx.storage;

      if (result._tag === "Success") {
        // Workflow completed successfully
        const completedSteps = await this.getCompletedSteps();

        await Effect.runPromise(
          Effect.gen(function* () {
            yield* setWorkflowStatus(storage, {
              _tag: "Completed",
              completedAt: Date.now(),
            });

            // Emit workflow completed event
            yield* emitEvent({
              ...createBaseEvent(workflowId, workflowName),
              type: "workflow.completed",
              completedSteps,
              durationMs: Date.now() - startTime,
            });
          }),
        );
      } else {
        // Check if it's a PauseSignal
        const failure = result.cause;

        if (failure._tag === "Fail" && failure.error instanceof PauseSignal) {
          const signal = failure.error;
          await Effect.runPromise(
            Effect.gen(function* () {
              yield* setWorkflowStatus(storage, {
                _tag: "Paused",
                reason: signal.reason,
                resumeAt: signal.resumeAt,
              });

              // Emit workflow paused event
              yield* emitEvent({
                ...createBaseEvent(workflowId, workflowName),
                type: "workflow.paused",
                reason: signal.reason,
                resumeAt: signal.resumeAt
                  ? new Date(signal.resumeAt).toISOString()
                  : undefined,
                stepName: signal.stepName,
              });
            }),
          );
          // Alarm should already be set by the step/sleep that raised PauseSignal
        } else {
          // Actual failure
          const error =
            failure._tag === "Fail"
              ? failure.error
              : failure._tag === "Die"
                ? failure.defect
                : failure;

          const completedSteps = await this.getCompletedSteps();

          // Extract error details
          const errorMessage =
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : JSON.stringify(error);

          const errorStack = error instanceof Error ? error.stack : undefined;

          // Extract step info if it's a StepError
          const stepName =
            error instanceof StepError ? error.stepName : undefined;
          const attempt =
            error instanceof StepError ? error.attempt : undefined;

          await Effect.runPromise(
            Effect.gen(function* () {
              yield* setWorkflowStatus(storage, {
                _tag: "Failed",
                error,
                failedAt: Date.now(),
              });

              // Emit workflow failed event
              yield* emitEvent({
                ...createBaseEvent(workflowId, workflowName),
                type: "workflow.failed",
                error: {
                  message: errorMessage,
                  stack: errorStack,
                  stepName,
                  attempt,
                },
                completedSteps,
              });
            }),
          );
        }
      }
    }

    async getStatus(): Promise<WorkflowStatus | undefined> {
      return this.ctx.storage.get("workflow:status");
    }

    async getCompletedSteps(): Promise<ReadonlyArray<string>> {
      const steps = await this.ctx.storage.get<string[]>(
        "workflow:completedSteps",
      );
      return steps ?? [];
    }

    async getMeta<M>(key: string): Promise<M | undefined> {
      return this.ctx.storage.get(`workflow:meta:${key}`);
    }
  };
}
