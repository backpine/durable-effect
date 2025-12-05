import { Context, Effect, Option } from "effect";
import { UnknownException } from "effect/Cause";
import { StepSerializationError } from "@/errors";

/**
 * Step-level context service interface.
 */
export interface StepContextService {
  /** Name of the current step */
  readonly stepName: string;

  /** Current attempt number (0-indexed) */
  readonly attempt: number;

  /** Get step-level metadata */
  readonly getMeta: <T>(key: string) => Effect.Effect<Option.Option<T>, UnknownException>;

  /** Set step-level metadata */
  readonly setMeta: <T>(key: string, value: T) => Effect.Effect<void, UnknownException>;

  /** Get step start time */
  readonly startedAt: Effect.Effect<Option.Option<number>, UnknownException>;

  /** Get step deadline (if timeout applied) */
  readonly deadline: Effect.Effect<Option.Option<number>, UnknownException>;

  /** Get cached step result */
  readonly getResult: <T>() => Effect.Effect<Option.Option<T>, UnknownException>;

  /**
   * Cache step result.
   * @throws StepSerializationError if the value cannot be serialized
   */
  readonly setResult: <T>(
    value: T,
  ) => Effect.Effect<void, StepSerializationError | UnknownException>;

  /** Increment attempt counter for next retry */
  readonly incrementAttempt: Effect.Effect<void, UnknownException>;

  /** Record step start time (if not already set) */
  readonly recordStartTime: Effect.Effect<void, UnknownException>;
}

/**
 * Step-level context.
 * Fresh instance provided for each step execution.
 */
export class StepContext extends Context.Tag("Workflow/StepContext")<
  StepContext,
  StepContextService
>() {}

/**
 * Storage key prefix for a step.
 */
const stepKey = (stepName: string, suffix: string) =>
  `step:${stepName}:${suffix}`;

/**
 * Check if an error is a DataCloneError (serialization failure).
 */
function isDataCloneError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "DataCloneError" ||
      error.message.includes("could not be cloned"))
  );
}

/**
 * Validate that a value can be serialized using structured clone.
 * This pre-validates before storage.put() to provide better error messages.
 */
function validateSerializable<T>(
  stepName: string,
  value: T,
): Effect.Effect<T, StepSerializationError> {
  return Effect.try({
    try: () => {
      // structuredClone uses the same algorithm as Durable Object storage
      structuredClone(value);
      return value;
    },
    catch: (error) =>
      StepSerializationError.fromSerializationFailure(stepName, error, value),
  });
}

/**
 * Create a StepContext service for a specific step.
 */
export function createStepContext(
  stepName: string,
  storage: DurableObjectStorage,
  attempt: number,
): StepContextService {
  return {
    stepName,
    attempt,

    getMeta: <T>(key: string) =>
      Effect.tryPromise({
        try: () => storage.get<T>(stepKey(stepName, `meta:${key}`)),
        catch: (e) => new UnknownException(e),
      }).pipe(
        Effect.map((value) =>
          value !== undefined ? Option.some(value) : Option.none<T>(),
        ),
      ),

    setMeta: <T>(key: string, value: T) =>
      Effect.tryPromise({
        try: () => storage.put(stepKey(stepName, `meta:${key}`), value),
        catch: (e) => new UnknownException(e),
      }),

    startedAt: Effect.tryPromise({
      try: () => storage.get<number>(stepKey(stepName, "startedAt")),
      catch: (e) => new UnknownException(e),
    }).pipe(
      Effect.map((value) =>
        value !== undefined ? Option.some(value) : Option.none<number>(),
      ),
    ),

    deadline: Effect.tryPromise({
      try: () => storage.get<number>(stepKey(stepName, "meta:deadline")),
      catch: (e) => new UnknownException(e),
    }).pipe(
      Effect.map((value) =>
        value !== undefined ? Option.some(value) : Option.none<number>(),
      ),
    ),

    getResult: <T>() =>
      Effect.tryPromise({
        try: () => storage.get<T>(stepKey(stepName, "result")),
        catch: (e) => new UnknownException(e),
      }).pipe(
        Effect.map((value) =>
          value !== undefined ? Option.some(value) : Option.none<T>(),
        ),
      ),

    setResult: <T>(value: T) =>
      Effect.gen(function* () {
        // Pre-validate that the value can be serialized
        yield* validateSerializable(stepName, value);

        // Store the validated value
        yield* Effect.tryPromise({
          try: () => storage.put(stepKey(stepName, "result"), value),
          catch: (error) => {
            // Double-check for serialization errors from storage.put
            if (isDataCloneError(error)) {
              return StepSerializationError.fromSerializationFailure(
                stepName,
                error,
                value,
              );
            }
            return new UnknownException(error);
          },
        });
      }),

    incrementAttempt: Effect.tryPromise({
      try: () => storage.put(stepKey(stepName, "attempt"), attempt + 1),
      catch: (e) => new UnknownException(e),
    }),

    recordStartTime: Effect.tryPromise({
      try: async () => {
        const existing = await storage.get<number>(stepKey(stepName, "startedAt"));
        if (existing === undefined) {
          await storage.put(stepKey(stepName, "startedAt"), Date.now());
        }
      },
      catch: (e) => new UnknownException(e),
    }),
  };
}

/**
 * Load the current attempt number for a step from storage.
 */
export function loadStepAttempt(
  stepName: string,
  storage: DurableObjectStorage,
): Effect.Effect<number, UnknownException> {
  return Effect.tryPromise({
    try: () => storage.get<number>(stepKey(stepName, "attempt")),
    catch: (e) => new UnknownException(e),
  }).pipe(Effect.map((value) => value ?? 0));
}
