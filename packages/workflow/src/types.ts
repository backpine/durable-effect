import type { Duration, Effect, Schema } from "effect";
import type { WorkflowContext } from "@/services/workflow-context";
import type { ExecutionContext } from "@durable-effect/core";

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Retry configuration options.
 */
export interface RetryOptions {
  /** Maximum number of attempts (including first try) */
  readonly maxAttempts: number;

  /** Delay between retries - Duration or backoff function */
  readonly delay?:
    | Duration.DurationInput
    | ((attempt: number) => Duration.DurationInput);

  /** Only retry when this predicate returns true */
  readonly while?: (error: unknown) => boolean;
}

/**
 * Timeout configuration options.
 */
export interface TimeoutOptions {
  /** Timeout duration */
  readonly duration: Duration.DurationInput;
}

// =============================================================================
// Workflow Status
// =============================================================================

/**
 * Workflow execution status.
 */
export type WorkflowStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Running" }
  | {
      readonly _tag: "Paused";
      readonly reason: string;
      readonly resumeAt: number;
    }
  | { readonly _tag: "Completed"; readonly completedAt: number }
  | {
      readonly _tag: "Failed";
      readonly error: unknown;
      readonly failedAt: number;
    };

// =============================================================================
// Workflow Definition Types
// =============================================================================

/**
 * Context requirements provided by the workflow engine.
 */
export type ProvidedContext = WorkflowContext | ExecutionContext;

/**
 * A workflow definition function.
 * The effect can require WorkflowContext and ExecutionContext (provided by engine).
 */
export type WorkflowDefinition<Input, E = never> = (
  input: Input,
) => Effect.Effect<void, E, ProvidedContext>;

/**
 * A complete durable workflow with metadata.
 */
export interface DurableWorkflow<Name extends string, Input, E> {
  readonly _tag: "DurableWorkflow";
  readonly name: Name;
  readonly definition: WorkflowDefinition<Input, E>;
  readonly inputSchema?: Schema.Schema<Input, unknown>;
}

/**
 * Collection of workflows indexed by name.
 */
export type WorkflowRegistry = Record<
  string,
  DurableWorkflow<string, any, any>
>;

// =============================================================================
// Type Utilities
// =============================================================================

/**
 * Extract input type from a workflow.
 */
export type WorkflowInput<W> =
  W extends DurableWorkflow<any, infer I, any> ? I : never;

/**
 * Extract error type from a workflow.
 */
export type WorkflowError<W> =
  W extends DurableWorkflow<any, any, infer E> ? E : never;

/**
 * Map of workflow names to their input types.
 *
 * @example
 * ```typescript
 * type Inputs = WorkflowInputMap<typeof myWorkflows>;
 * // { processOrder: string; sendEmail: { to: string } }
 * ```
 */
export type WorkflowInputMap<W extends WorkflowRegistry> = {
  [K in keyof W]: WorkflowInput<W[K]>;
};

/**
 * Map of workflow names to their error types.
 */
export type WorkflowErrorMap<W extends WorkflowRegistry> = {
  [K in keyof W]: WorkflowError<W[K]>;
};

/**
 * Discriminated union of all workflow calls.
 * Enables type-safe dispatch through RPC proxies.
 *
 * @example
 * ```typescript
 * type Call = WorkflowCall<typeof myWorkflows>;
 * // | { workflow: 'processOrder'; input: string }
 * // | { workflow: 'sendEmail'; input: { to: string } }
 * ```
 */
export type WorkflowCall<W extends WorkflowRegistry> = {
  [K in keyof W & string]: { workflow: K; input: WorkflowInput<W[K]> };
}[keyof W & string];

// =============================================================================
// Durable Object Class Types
// =============================================================================

/**
 * The instance type for a Durable Workflow engine.
 * This is used to type DurableObjectNamespace generics without
 * exposing internal DurableObject properties that cause type recursion issues.
 *
 * Extends Rpc.DurableObjectBranded to satisfy Cloudflare's type requirements
 * for DurableObjectNamespace and DurableObjectStub.
 */
export interface DurableWorkflowInstance<W extends WorkflowRegistry>
  extends Rpc.DurableObjectBranded {
  run(call: WorkflowCall<W>): Promise<{ id: string }>;
  getStatus(): Promise<WorkflowStatus | undefined>;
  getCompletedSteps(): Promise<ReadonlyArray<string>>;
  getMeta<T>(key: string): Promise<T | undefined>;
}
