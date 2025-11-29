import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import {
  ExecutionContext,
  PauseSignal,
  createExecutionContext,
} from "@durable-effect/core";
import {
  WorkflowContext,
  createWorkflowContext,
  setWorkflowStatus,
  storeWorkflowMeta,
  loadWorkflowMeta,
} from "@/services/workflow-context";
import type {
  DurableWorkflowInstance,
  WorkflowCall,
  WorkflowRegistry,
  WorkflowStatus,
} from "@/types";

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
 * // Create the Durable Object class
 * export const MyWorkflows = createDurableWorkflows(workflows);
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
): new (state: DurableObjectState, env: unknown) => DurableWorkflowInstance<T> {
  return class DurableWorkflowEngine
    extends DurableObject
    implements TypedWorkflowEngine<T>
  {
    /** The workflows registry */
    readonly #workflows: T = workflows;

    /** Currently active workflow name (if any) */
    #currentWorkflow: keyof T | undefined;

    constructor(state: DurableObjectState, env: unknown) {
      super(state, env as never);

      // Load current workflow from storage on initialization
      state.blockConcurrencyWhile(async () => {
        this.#currentWorkflow = await this.ctx.storage.get("workflow:name");
      });
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
      });

      await Effect.runPromise(setupEffect);
      this.#currentWorkflow = workflowName;

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

      // Set status to running
      await Effect.runPromise(
        setWorkflowStatus(this.ctx.storage, { _tag: "Running" }),
      );

      // Resume execution
      await this.#executeWorkflow(workflowId, meta.workflowName, meta.input);
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
      const workflowEffect = workflowDef
        .definition(input)
        .pipe(
          Effect.provideService(ExecutionContext, execCtx),
          Effect.provideService(WorkflowContext, workflowCtx),
        );

      // Execute and handle results
      const result = await Effect.runPromiseExit(workflowEffect);

      if (result._tag === "Success") {
        // Workflow completed successfully
        await Effect.runPromise(
          setWorkflowStatus(this.ctx.storage, {
            _tag: "Completed",
            completedAt: Date.now(),
          }),
        );
      } else {
        // Check if it's a PauseSignal
        const failure = result.cause;

        if (failure._tag === "Fail" && failure.error instanceof PauseSignal) {
          const signal = failure.error;
          await Effect.runPromise(
            setWorkflowStatus(this.ctx.storage, {
              _tag: "Paused",
              reason: signal.reason,
              resumeAt: signal.resumeAt,
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

          await Effect.runPromise(
            setWorkflowStatus(this.ctx.storage, {
              _tag: "Failed",
              error,
              failedAt: Date.now(),
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
