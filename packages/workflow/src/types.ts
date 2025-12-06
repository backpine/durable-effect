import type { Duration, Effect, Schema } from "effect";
import type { WorkflowContext } from "@/services/workflow-context";
import type { WorkflowScope } from "@/services/workflow-scope";
import type { ExecutionContext } from "@durable-effect/core";
import type { BackoffConfig } from "@/backoff";

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Retry configuration options.
 *
 * @example
 * ```typescript
 * // Fixed delay
 * Workflow.retry({ maxAttempts: 3, delay: "5 seconds" })
 *
 * // Custom function
 * Workflow.retry({
 *   maxAttempts: 5,
 *   delay: (attempt) => Duration.millis(1000 * Math.pow(2, attempt))
 * })
 *
 * // Exponential backoff with preset
 * Workflow.retry({ maxAttempts: 5, delay: Backoff.presets.standard() })
 *
 * // Custom exponential with jitter
 * Workflow.retry({
 *   maxAttempts: 5,
 *   delay: Backoff.exponential({
 *     base: "1 second",
 *     factor: 2,
 *     max: "30 seconds",
 *     jitter: true
 *   })
 * })
 *
 * // With max total duration
 * Workflow.retry({
 *   maxAttempts: 10,
 *   delay: Backoff.exponential({ base: "1 second" }),
 *   maxDuration: "5 minutes"
 * })
 * ```
 */
export interface RetryOptions {
  /** Maximum number of retries (not including the initial attempt) */
  readonly maxAttempts: number;

  /**
   * Delay strategy between retries. Defaults to 1 second if not specified.
   *
   * Accepts:
   * - `Duration.DurationInput`: Fixed delay (e.g., "5 seconds", Duration.minutes(1))
   * - `(attempt: number) => Duration.DurationInput`: Custom delay function
   * - `BackoffConfig`: Structured backoff via Backoff.exponential/linear/constant/presets
   *
   * @example
   * ```typescript
   * // Fixed delay
   * delay: "5 seconds"
   *
   * // Custom function
   * delay: (attempt) => Duration.seconds(Math.pow(2, attempt))
   *
   * // Exponential backoff
   * delay: Backoff.exponential({ base: "1 second", max: "30 seconds" })
   *
   * // Preset
   * delay: Backoff.presets.standard()
   * ```
   */
  readonly delay?:
    | Duration.DurationInput
    | ((attempt: number) => Duration.DurationInput)
    | BackoffConfig;

  /**
   * Maximum total time across all retry attempts.
   * If the next retry would exceed this duration from the first attempt,
   * retries are exhausted early.
   */
  readonly maxDuration?: Duration.DurationInput;
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
  | { readonly _tag: "Queued"; readonly queuedAt: number }
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
    }
  | {
      readonly _tag: "Cancelled";
      readonly cancelledAt: number;
      readonly reason?: string;
    };

/**
 * Options for cancelling a workflow.
 */
export interface CancelOptions {
  /**
   * Cancellation mode:
   * - "graceful": Wait for current step to complete, then cancel
   * - "immediate": Cancel immediately (default)
   */
  readonly mode?: "graceful" | "immediate";

  /**
   * Reason for cancellation (included in event).
   */
  readonly reason?: string;
}

/**
 * Result of a cancellation request.
 */
export interface CancelResult {
  /** Whether the workflow was cancelled (false if already completed/failed/cancelled) */
  readonly cancelled: boolean;
  /** Previous status before cancellation */
  readonly previousStatus?: WorkflowStatus;
}

// =============================================================================
// Workflow Definition Types
// =============================================================================

/**
 * Context requirements provided by the workflow engine.
 */
export type ProvidedContext =
  | WorkflowScope
  | WorkflowContext
  | ExecutionContext;

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
 * // | { workflow: 'processOrder'; input: string; executionId?: string }
 * // | { workflow: 'sendEmail'; input: { to: string }; executionId?: string }
 * ```
 */
export type WorkflowCall<W extends WorkflowRegistry> = {
  [K in keyof W & string]: {
    workflow: K;
    input: WorkflowInput<W[K]>;
    /** Optional user-provided execution ID for event correlation */
    executionId?: string;
  };
}[keyof W & string];

// =============================================================================
// Serialization Types
// =============================================================================

/**
 * Symbol used to brand serializable types.
 * This is a compile-time hint - actual validation happens at runtime.
 */
declare const SerializableBrand: unique symbol;

/**
 * Branded type indicating a value should be JSON/structured-clone serializable.
 *
 * This is a compile-time documentation hint. The actual serialization
 * validation happens at runtime when the step result is cached.
 *
 * Use this to annotate step return types for better documentation:
 *
 * @example
 * ```typescript
 * interface UserData {
 *   id: string;
 *   name: string;
 *   email: string;
 * }
 *
 * // Type hints that the return value should be serializable
 * const fetchUser = (id: string): Effect.Effect<Serializable<UserData>, Error> =>
 *   Effect.tryPromise(() => db.users.findOne(id)).pipe(
 *     Effect.map(user => ({
 *       id: user.id,
 *       name: user.name,
 *       email: user.email,
 *     }) as Serializable<UserData>)
 *   );
 * ```
 */
export type Serializable<T> = T & { readonly [SerializableBrand]: true };

/**
 * Types that are known to NOT be serializable by structured clone.
 * Used for compile-time documentation and type checking.
 */
export type NonSerializable =
  | ((...args: unknown[]) => unknown) // Functions
  | symbol
  | WeakMap<object, unknown>
  | WeakSet<object>;

/**
 * Primitive types that are always serializable.
 */
export type SerializablePrimitive =
  | string
  | number
  | boolean
  | null
  | undefined;

/**
 * JSON-compatible value type.
 * Use this to constrain step return types at compile time.
 *
 * Note: This is stricter than structured clone (which supports Date, Map, Set, etc.)
 * but provides better compile-time safety.
 */
export type JsonValue =
  | SerializablePrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

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
  runAsync(call: WorkflowCall<W>): Promise<{ id: string }>;
  cancel(options?: CancelOptions): Promise<CancelResult>;
  getStatus(): Promise<WorkflowStatus | undefined>;
  getCompletedSteps(): Promise<ReadonlyArray<string>>;
  getMeta<T>(key: string): Promise<T | undefined>;
}
