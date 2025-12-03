import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, Exit, Cause } from "effect";
import { UnknownException } from "effect/Cause";
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
  flushEvents,
  createHttpBatchTracker,
  NoopTrackerLayer,
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
 *     env: "production",
 *     serviceKey: "order-service",
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

  // Always create a tracker layer - use no-op if not configured
  const trackerLayer: Layer.Layer<EventTracker> = trackerConfig
    ? Layer.scoped(EventTracker, createHttpBatchTracker(trackerConfig)).pipe(
        Layer.provide(FetchHttpClient.layer),
      )
    : NoopTrackerLayer;

  return class DurableWorkflowEngine
    extends DurableObject
    implements TypedWorkflowEngine<T>
  {
    /** The workflows registry */
    readonly #workflows: T = workflows;

    /** Event tracker layer (always present - may be no-op) */
    readonly #trackerLayer: Layer.Layer<EventTracker> = trackerLayer;

    constructor(state: DurableObjectState, env: unknown) {
      super(state, env as never);
    }

    /**
     * Run a workflow with the given call.
     * Idempotent - if workflow already running/completed, returns existing state.
     *
     * Uses a single scoped execution to ensure all events (workflow.started,
     * step events, workflow.completed/failed/paused) go to the same tracker
     * instance and are properly batched and sent.
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

      const storage = this.ctx.storage;
      const execCtx = createExecutionContext(this.ctx);
      const workflowCtx = createWorkflowContext(
        workflowId,
        String(workflowName),
        input,
        storage,
      );

      // Single scoped execution: setup → workflow → completion
      // All events emitted within this scope go to the same tracker instance
      const fullExecution = Effect.gen(function* () {
        // Setup: store metadata, set status, emit started event
        yield* storeWorkflowMeta(storage, String(workflowName), input);
        yield* setWorkflowStatus(storage, { _tag: "Running" });
        yield* emitEvent({
          ...createBaseEvent(workflowId, String(workflowName)),
          type: "workflow.started",
          input,
        });

        // Execute workflow and capture exit
        const startTime = Date.now();
        const result = yield* workflowDef
          .definition(input)
          .pipe(
            Effect.provideService(ExecutionContext, execCtx),
            Effect.provideService(WorkflowContext, workflowCtx),
            Effect.exit,
          );

        // Handle result within the same scope
        yield* handleWorkflowResult(
          result,
          storage,
          workflowId,
          String(workflowName),
          startTime,
        );

        // Flush events before scope closes
        yield* flushEvents;
      }).pipe(Effect.provide(this.#trackerLayer));

      await Effect.runPromise(fullExecution);

      return { id: workflowId };
    }

    /**
     * Handle alarm - resume paused workflow.
     *
     * Uses a single scoped execution to ensure all events go to the same
     * tracker instance.
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
      const input = meta.input;
      const storage = this.ctx.storage;

      const workflowDef = this.#workflows[workflowName as keyof T];
      if (!workflowDef) {
        await Effect.runPromise(
          setWorkflowStatus(storage, {
            _tag: "Failed",
            error: `Unknown workflow: ${workflowName}`,
            failedAt: Date.now(),
          }),
        );
        return;
      }

      const execCtx = createExecutionContext(this.ctx);
      const workflowCtx = createWorkflowContext(
        workflowId,
        workflowName,
        input,
        storage,
      );

      // Single scoped execution: resume → workflow → completion
      const fullExecution = Effect.gen(function* () {
        // Set status to running and emit resumed event
        yield* setWorkflowStatus(storage, { _tag: "Running" });
        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName),
          type: "workflow.resumed",
        });

        // Execute workflow and capture exit
        const startTime = Date.now();
        const result = yield* workflowDef
          .definition(input)
          .pipe(
            Effect.provideService(ExecutionContext, execCtx),
            Effect.provideService(WorkflowContext, workflowCtx),
            Effect.exit,
          );

        // Handle result within the same scope
        yield* handleWorkflowResult(
          result,
          storage,
          workflowId,
          workflowName,
          startTime,
        );

        // Flush events before scope closes
        yield* flushEvents;
      }).pipe(Effect.provide(this.#trackerLayer));

      await Effect.runPromise(fullExecution);
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

/**
 * Get completed steps from storage.
 */
function getCompletedStepsFromStorage(
  storage: DurableObjectStorage,
): Effect.Effect<ReadonlyArray<string>> {
  return Effect.promise(async () => {
    const steps = await storage.get<string[]>("workflow:completedSteps");
    return steps ?? [];
  });
}

/**
 * Handle workflow execution result within the same Effect scope.
 * Emits appropriate lifecycle events based on success/pause/failure.
 */
function handleWorkflowResult<E>(
  result: Exit.Exit<unknown, E>,
  storage: DurableObjectStorage,
  workflowId: string,
  workflowName: string,
  startTime: number,
): Effect.Effect<void, UnknownException> {
  return Effect.gen(function* () {
    if (Exit.isSuccess(result)) {
      // Workflow completed successfully
      const completedSteps = yield* getCompletedStepsFromStorage(storage);

      yield* setWorkflowStatus(storage, {
        _tag: "Completed",
        completedAt: Date.now(),
      });

      yield* emitEvent({
        ...createBaseEvent(workflowId, workflowName),
        type: "workflow.completed",
        completedSteps,
        durationMs: Date.now() - startTime,
      });
    } else {
      // Check if it's a PauseSignal
      const cause = result.cause;
      const failureOption = Cause.failureOption(cause);

      if (
        failureOption._tag === "Some" &&
        failureOption.value instanceof PauseSignal
      ) {
        const signal = failureOption.value;

        yield* setWorkflowStatus(storage, {
          _tag: "Paused",
          reason: signal.reason,
          resumeAt: signal.resumeAt,
        });

        yield* emitEvent({
          ...createBaseEvent(workflowId, workflowName),
          type: "workflow.paused",
          reason: signal.reason,
          resumeAt: signal.resumeAt
            ? new Date(signal.resumeAt).toISOString()
            : undefined,
          stepName: signal.stepName,
        });
        return;
      }

      // Actual failure - extract error details
      const error =
        failureOption._tag === "Some"
          ? failureOption.value
          : Cause.isDie(cause)
            ? Cause.squash(cause)
            : cause;

      const completedSteps = yield* getCompletedStepsFromStorage(storage);

      const errorMessage =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);

      const errorStack = error instanceof Error ? error.stack : undefined;

      const stepName =
        error instanceof StepError ? error.stepName : undefined;
      const attempt = error instanceof StepError ? error.attempt : undefined;

      yield* setWorkflowStatus(storage, {
        _tag: "Failed",
        error,
        failedAt: Date.now(),
      });

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
    }
  });
}
