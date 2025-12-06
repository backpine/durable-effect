import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, Exit, Cause } from "effect";
import { UnknownException } from "effect/Cause";
import { FetchHttpClient } from "@effect/platform";
import {
  ExecutionContext,
  PauseSignal,
  createExecutionContext,
} from "@durable-effect/core";
import {
  WorkflowContext,
  createWorkflowContext,
  storeWorkflowMeta,
  loadWorkflowMeta,
} from "@/services/workflow-context";
import { storageDeleteAll } from "@/services/storage-utils";
import { WorkflowScope } from "@/services/workflow-scope";
import {
  EventTracker,
  flushEvents,
  createHttpBatchTracker,
  NoopTrackerLayer,
  type EventTrackerConfig,
} from "@/tracker";
import { transitionWorkflow } from "@/transitions";
import { StepError, StepInfrastructureError, WorkflowCancelledError } from "@/errors";
import { storageGet, storagePut } from "@/services/storage-utils";
import {
  createWorkflowClientFactory,
  type WorkflowClientFactory,
} from "@/client";
import type {
  DurableWorkflowInstance,
  WorkflowCall,
  WorkflowRegistry,
  WorkflowStatus,
  CancelOptions,
  CancelResult,
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
 * Result of creating durable workflows.
 */
export interface CreateDurableWorkflowsResult<T extends WorkflowRegistry> {
  /**
   * Durable Object class to export for Cloudflare Workers.
   */
  Workflows: new (
    state: DurableObjectState,
    env: unknown,
  ) => DurableWorkflowInstance<T>;

  /**
   * Type-safe client factory for interacting with workflows.
   */
  WorkflowClient: WorkflowClientFactory<T>;
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
   * Run a workflow synchronously with type-safe input.
   *
   * Blocks until the workflow completes, fails, or pauses.
   * Uses a discriminated union where `workflow` determines the `input` type.
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
   * Run a workflow asynchronously with type-safe input.
   *
   * Returns immediately after queueing the workflow. The workflow executes
   * via alarm after a short delay (300ms). Use this when you want to offload
   * work without blocking the client.
   *
   * @example
   * ```typescript
   * // Returns immediately - workflow runs in background
   * const { id } = await stub.runAsync({ workflow: 'processOrder', input: 'order-123' });
   *
   * // Check status later
   * const status = await stub.getStatus();
   * ```
   */
  runAsync(call: WorkflowCall<W>): Promise<WorkflowRunResult>;

  /**
   * Cancel a workflow.
   *
   * For paused/queued workflows: Immediately cancels and cleans up.
   * For running workflows: Sets cancel flag (checked before next step).
   *
   * Idempotent - calling cancel on an already cancelled workflow returns success.
   *
   * @example
   * ```typescript
   * await stub.cancel({ reason: "User requested cancellation" });
   * ```
   */
  cancel(options?: CancelOptions): Promise<CancelResult>;

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
 *
 * // Or use the type-safe client
 * const client = WorkflowClient.fromBinding(env.MY_WORKFLOWS);
 * yield* client.run({ workflow: 'processOrder', input: 'order-123' });
 * ```
 */
export function createDurableWorkflows<const T extends WorkflowRegistry>(
  workflows: T,
  options?: CreateDurableWorkflowsOptions,
): CreateDurableWorkflowsResult<T> {
  const trackerConfig = options?.tracker;

  // Always create a tracker layer - use no-op if not configured
  const trackerLayer: Layer.Layer<EventTracker> = trackerConfig
    ? Layer.scoped(EventTracker, createHttpBatchTracker(trackerConfig)).pipe(
        Layer.provide(FetchHttpClient.layer),
      )
    : NoopTrackerLayer;

  class DurableWorkflowEngine
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
     * Run a workflow synchronously.
     * Idempotent - if workflow already running/completed, returns existing state.
     */
    async run(call: WorkflowCall<T>): Promise<WorkflowRunResult> {
      const { workflow: workflowName, input, executionId } = call;
      const workflowId = this.ctx.id.toString();

      // Check if workflow already exists (idempotent)
      const existingStatus =
        await this.ctx.storage.get<WorkflowStatus>("workflow:status");

      if (
        existingStatus?._tag === "Completed" ||
        existingStatus?._tag === "Failed" ||
        existingStatus?._tag === "Running" ||
        existingStatus?._tag === "Paused" ||
        existingStatus?._tag === "Queued"
      ) {
        return { id: workflowId };
      }

      // Get workflow definition
      const workflowDef = this.#workflows[workflowName];
      if (!workflowDef) {
        throw new Error(`Unknown workflow: ${String(workflowName)}`);
      }

      // Store metadata first (including executionId for persistence across lifecycle)
      await Effect.runPromise(
        storeWorkflowMeta(
          this.ctx.storage,
          String(workflowName),
          input,
          executionId,
        ),
      );

      // Execute workflow with Start transition
      await this.#executeWorkflow(
        workflowDef,
        input,
        workflowId,
        String(workflowName),
        { _tag: "Start", input },
        executionId,
      );

      return { id: workflowId };
    }

    /**
     * Run a workflow asynchronously.
     * Returns immediately after queueing - workflow executes via alarm.
     */
    async runAsync(call: WorkflowCall<T>): Promise<WorkflowRunResult> {
      const { workflow: workflowName, input, executionId } = call;
      const workflowId = this.ctx.id.toString();
      const storage = this.ctx.storage;

      // Check if workflow already exists (idempotent)
      const existingStatus =
        await storage.get<WorkflowStatus>("workflow:status");

      if (existingStatus) {
        return { id: workflowId };
      }

      // Get workflow definition (validate early)
      const workflowDef = this.#workflows[workflowName];
      if (!workflowDef) {
        throw new Error(`Unknown workflow: ${String(workflowName)}`);
      }

      const name = String(workflowName);

      // Store metadata and transition to queued (executionId persisted for alarm handler)
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* storeWorkflowMeta(storage, name, input, executionId);
          yield* transitionWorkflow(
            storage,
            workflowId,
            name,
            {
              _tag: "Queue",
              input,
            },
            executionId,
          );
        }).pipe(Effect.provide(this.#trackerLayer)),
      );

      // Schedule alarm 300ms from now
      await storage.setAlarm(Date.now() + 300);

      return { id: workflowId };
    }

    /**
     * Handle alarm - execute queued or resume paused workflow.
     */
    async alarm(): Promise<void> {
      const storage = this.ctx.storage;
      const status = await storage.get<WorkflowStatus>("workflow:status");

      // Determine transition based on status
      if (status?._tag !== "Queued" && status?._tag !== "Paused") {
        return;
      }

      // Check if cancelled while paused/queued
      const cancelled = await storage.get<boolean>("workflow:cancelled");
      if (cancelled) {
        const cancelReason = await storage.get<string>("workflow:cancelReason");
        const completedSteps =
          (await storage.get<string[]>("workflow:completedSteps")) ?? [];
        const meta = await Effect.runPromise(loadWorkflowMeta(storage));
        const workflowId = this.ctx.id.toString();
        const trackerLayer = this.#trackerLayer;

        await Effect.runPromise(
          Effect.gen(function* () {
            yield* transitionWorkflow(
              storage,
              workflowId,
              meta.workflowName ?? "unknown",
              { _tag: "Cancel", reason: cancelReason, completedSteps },
              meta.executionId,
            );
            yield* flushEvents;
          }).pipe(Effect.provide(trackerLayer)),
        );

        await storage.deleteAll();
        return;
      }

      // Load workflow metadata (includes executionId for event correlation)
      const meta = await Effect.runPromise(loadWorkflowMeta(storage));

      if (!meta.workflowName) {
        console.error("Alarm fired but no workflow name found");
        return;
      }

      const workflowId = this.ctx.id.toString();
      const workflowName = meta.workflowName;
      const input = meta.input;
      const executionId = meta.executionId;

      const workflowDef = this.#workflows[workflowName as keyof T];
      if (!workflowDef) {
        await Effect.runPromise(
          transitionWorkflow(
            storage,
            workflowId,
            workflowName,
            {
              _tag: "Fail",
              error: { message: `Unknown workflow: ${workflowName}` },
              completedSteps: [],
            },
            executionId,
          ).pipe(Effect.provide(this.#trackerLayer)),
        );
        return;
      }

      // Determine transition: Queued → Start, Paused → Resume
      const transition: { _tag: "Start"; input: unknown } | { _tag: "Resume" } =
        status._tag === "Queued"
          ? { _tag: "Start", input }
          : { _tag: "Resume" };

      await this.#executeWorkflow(
        workflowDef,
        input,
        workflowId,
        workflowName,
        transition,
        executionId,
      );
    }

    /**
     * Core workflow execution logic.
     * Handles transition → execute → result → flush in a single scoped execution.
     */
    async #executeWorkflow(
      workflowDef: T[keyof T],
      input: unknown,
      workflowId: string,
      workflowName: string,
      transition: { _tag: "Start"; input: unknown } | { _tag: "Resume" },
      executionId?: string,
    ): Promise<void> {
      const storage = this.ctx.storage;
      const execCtx = createExecutionContext(this.ctx);
      const workflowCtx = createWorkflowContext(
        workflowId,
        workflowName,
        input,
        storage,
        executionId,
      );

      const execution = Effect.gen(function* () {
        yield* transitionWorkflow(
          storage,
          workflowId,
          workflowName,
          transition,
          executionId,
        );

        const startTime = Date.now();
        const result = yield* workflowDef.definition(input).pipe(
          Effect.provideService(ExecutionContext, execCtx),
          Effect.provideService(WorkflowContext, workflowCtx),
          Effect.provideService(WorkflowScope, {
            _brand: "WorkflowScope" as const,
          }),
          Effect.exit,
        );

        yield* handleWorkflowResult(
          result,
          storage,
          workflowId,
          workflowName,
          startTime,
          executionId,
        );

        yield* flushEvents;
      }).pipe(Effect.provide(this.#trackerLayer));

      await Effect.runPromise(execution);
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

    /**
     * Cancel a workflow.
     *
     * For paused/queued workflows: Immediately cancels and cleans up.
     * For running workflows: Sets cancel flag (checked before next step).
     *
     * Idempotent - calling cancel on an already cancelled workflow returns success.
     */
    async cancel(options?: CancelOptions): Promise<CancelResult> {
      const reason = options?.reason;
      const storage = this.ctx.storage;
      const workflowId = this.ctx.id.toString();

      // Get current status
      const status = await storage.get<WorkflowStatus>("workflow:status");

      // Already in terminal state - no-op
      if (
        status?._tag === "Completed" ||
        status?._tag === "Failed" ||
        status?._tag === "Cancelled"
      ) {
        return { cancelled: false, previousStatus: status };
      }

      // Load workflow metadata for event emission
      const meta = await Effect.runPromise(loadWorkflowMeta(storage));
      const workflowName = meta.workflowName ?? "unknown";
      const executionId = meta.executionId;
      const completedSteps =
        (await storage.get<string[]>("workflow:completedSteps")) ?? [];

      if (status?._tag === "Paused" || status?._tag === "Queued") {
        // Paused or queued - can cancel immediately
        // Delete pending alarm
        await storage.deleteAlarm();

        // Transition to Cancelled
        const trackerLayer = this.#trackerLayer;
        await Effect.runPromise(
          Effect.gen(function* () {
            yield* transitionWorkflow(
              storage,
              workflowId,
              workflowName,
              { _tag: "Cancel", reason, completedSteps },
              executionId,
            );
            yield* flushEvents;
          }).pipe(Effect.provide(trackerLayer)),
        );

        // Clear storage
        await storage.deleteAll();

        return { cancelled: true, previousStatus: status };
      }

      if (status?._tag === "Running") {
        // Running - set cancel flag for next step to check
        await storage.put("workflow:cancelled", true);
        if (reason) {
          await storage.put("workflow:cancelReason", reason);
        }

        return { cancelled: true, previousStatus: status };
      }

      // Pending or unknown - just cancel
      const trackerLayer = this.#trackerLayer;
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* transitionWorkflow(
            storage,
            workflowId,
            workflowName,
            { _tag: "Cancel", reason, completedSteps },
            executionId,
          );
          yield* flushEvents;
        }).pipe(Effect.provide(trackerLayer)),
      );

      await storage.deleteAll();

      return { cancelled: true, previousStatus: status };
    }
  }

  return {
    Workflows: DurableWorkflowEngine,
    WorkflowClient: createWorkflowClientFactory<T>(),
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
 * Uses transitionWorkflow to update status and emit events atomically.
 */
function handleWorkflowResult<E>(
  result: Exit.Exit<unknown, E>,
  storage: DurableObjectStorage,
  workflowId: string,
  workflowName: string,
  startTime: number,
  executionId?: string,
): Effect.Effect<void, UnknownException> {
  return Effect.gen(function* () {
    if (Exit.isSuccess(result)) {
      const completedSteps = yield* getCompletedStepsFromStorage(storage);
      yield* transitionWorkflow(
        storage,
        workflowId,
        workflowName,
        {
          _tag: "Complete",
          completedSteps,
          durationMs: Date.now() - startTime,
        },
        executionId,
      );

      yield* storageDeleteAll(storage).pipe(
        Effect.mapError((e) => new UnknownException(e)),
      );
      return;
    }

    // Check if it's a PauseSignal
    const cause = result.cause;
    const failureOption = Cause.failureOption(cause);

    if (
      failureOption._tag === "Some" &&
      failureOption.value instanceof PauseSignal
    ) {
      const signal = failureOption.value;
      yield* transitionWorkflow(
        storage,
        workflowId,
        workflowName,
        {
          _tag: "Pause",
          reason: signal.reason,
          resumeAt: signal.resumeAt,
          stepName: signal.stepName,
        },
        executionId,
      );
      return;
    }

    // Check if it's a WorkflowCancelledError
    if (
      failureOption._tag === "Some" &&
      failureOption.value instanceof WorkflowCancelledError
    ) {
      const cancelledError = failureOption.value;
      const completedSteps = yield* getCompletedStepsFromStorage(storage);
      yield* transitionWorkflow(
        storage,
        workflowId,
        workflowName,
        {
          _tag: "Cancel",
          reason: cancelledError.reason,
          completedSteps,
        },
        executionId,
      );
      yield* storageDeleteAll(storage).pipe(
        Effect.mapError((e) => new UnknownException(e)),
      );
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

    // Extract step context from StepError or StepInfrastructureError
    const stepName =
      error instanceof StepError
        ? error.stepName
        : error instanceof StepInfrastructureError
          ? error.stepName
          : undefined;

    const attempt =
      error instanceof StepError
        ? error.attempt
        : error instanceof StepInfrastructureError
          ? error.attempt
          : undefined;

    yield* transitionWorkflow(
      storage,
      workflowId,
      workflowName,
      {
        _tag: "Fail",
        error: {
          message: errorMessage,
          stack: errorStack,
          stepName,
          attempt,
        },
        completedSteps,
      },
      executionId,
    );

    // Clear all storage after permanent failure
    yield* storageDeleteAll(storage).pipe(
      Effect.mapError((e) => new UnknownException(e)),
    );
  });
}

/**
 * Extract step context from various error types.
 * @internal
 */
function extractStepContext(error: unknown): {
  stepName?: string;
  attempt?: number;
} {
  if (error instanceof StepError) {
    return { stepName: error.stepName, attempt: error.attempt };
  }
  if (error instanceof StepInfrastructureError) {
    return { stepName: error.stepName, attempt: error.attempt };
  }
  return {};
}
