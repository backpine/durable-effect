import { Data } from "effect";

/**
 * A storage operation failed after retries.
 */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: "get" | "put" | "delete" | "deleteAll";
  readonly key: string | undefined;
  readonly cause: unknown;
  readonly retriesAttempted: number;
}> {
  get message(): string {
    const keyPart = this.key ? ` for key "${this.key}"` : "";
    const retryPart =
      this.retriesAttempted > 0
        ? ` after ${this.retriesAttempted} retries`
        : "";
    return `Storage ${this.operation}${keyPart} failed${retryPart}`;
  }
}

/**
 * Workflow was cancelled by user request.
 * Used internally to signal cancellation through the Effect error channel.
 */
export class WorkflowCancelledError extends Data.TaggedError(
  "WorkflowCancelledError",
)<{
  readonly workflowId: string;
  readonly reason?: string;
}> {}

/**
 * Step execution failed after all retries exhausted.
 */
export class StepError extends Data.TaggedError("StepError")<{
  readonly stepName: string;
  readonly cause: unknown;
  readonly attempt: number;
}> {}

/**
 * Step exceeded its timeout deadline.
 */
export class StepTimeoutError extends Data.TaggedError("StepTimeoutError")<{
  readonly stepName: string;
  readonly timeoutMs: number;
}> {}

/**
 * Step result could not be serialized to Durable Object storage.
 *
 * This happens when the step returns a non-serializable value like
 * functions, Symbols, Proxy objects, class instances, or circular references.
 *
 * Durable Object storage uses the structured clone algorithm, which only
 * supports plain objects, arrays, and primitive types.
 *
 * @example
 * ```typescript
 * // Fix by discarding the result
 * yield* Workflow.step("update", updateDb(id).pipe(Effect.asVoid));
 *
 * // Or by mapping to a serializable value
 * yield* Workflow.step("update",
 *   updateDb(id).pipe(Effect.map(r => ({ rowCount: r.rowCount })))
 * );
 * ```
 */
export class StepSerializationError extends Data.TaggedError(
  "StepSerializationError",
)<{
  readonly stepName: string;
  readonly message: string;
  readonly cause: unknown;
  /** Hint about what type of value caused the issue */
  readonly valueType?: string;
}> {
  /**
   * Create a user-friendly error from a serialization failure.
   */
  static fromSerializationFailure(
    stepName: string,
    cause: unknown,
    value: unknown,
  ): StepSerializationError {
    const valueType = detectValueType(value);
    const hint = getSerializationHint(valueType);

    return new StepSerializationError({
      stepName,
      message:
        `Step "${stepName}" returned a value that cannot be serialized to storage. ` +
        `${hint} ` +
        `Use Effect.asVoid, Effect.as(), or Effect.map() to return a serializable value.`,
      cause,
      valueType,
    });
  }
}

/**
 * Detect the type of value for better error messages.
 */
function detectValueType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return "symbol";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "Date";
  if (value instanceof Map) return "Map";
  if (value instanceof Set) return "Set";
  if (value instanceof WeakMap) return "WeakMap";
  if (value instanceof WeakSet) return "WeakSet";
  if (value instanceof Promise) return "Promise";
  if (value instanceof Error) return "Error";
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto && proto.constructor && proto.constructor.name !== "Object") {
      return proto.constructor.name; // e.g., "NeonQueryResult", "DrizzleResult"
    }
    return "object";
  }
  return typeof value;
}

/**
 * Get a helpful hint based on the value type.
 */
function getSerializationHint(valueType: string): string {
  const hints: Record<string, string> = {
    function: "Functions cannot be serialized.",
    symbol: "Symbols cannot be serialized.",
    WeakMap: "WeakMap cannot be serialized.",
    WeakSet: "WeakSet cannot be serialized.",
    Promise: "Promises cannot be serialized. Did you forget to await?",
    Error: "Error objects may not serialize correctly.",
    Map: "Map objects need to be converted to plain objects or arrays.",
    Set: "Set objects need to be converted to arrays.",
    Date: "Date objects should be converted to ISO strings or timestamps.",
  };

  // Common ORM result types
  if (
    valueType.includes("Query") ||
    valueType.includes("Result") ||
    valueType.includes("Drizzle") ||
    valueType.includes("Neon") ||
    valueType.includes("Prisma") ||
    valueType.includes("Kysely")
  ) {
    return `ORM query results (${valueType}) often contain non-serializable properties like Proxies or internal metadata.`;
  }

  return (
    hints[valueType] ||
    `Value of type "${valueType}" may contain non-serializable properties.`
  );
}
