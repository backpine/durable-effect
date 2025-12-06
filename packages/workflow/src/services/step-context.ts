import { Context, Effect, Option } from "effect";
import { UnknownException } from "effect/Cause";
import { StepSerializationError } from "@/errors";
import { storageGet, storagePut } from "./storage-utils";

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
      storageGet<T>(storage, stepKey(stepName, `meta:${key}`)).pipe(
        Effect.map((value) =>
          value !== undefined ? Option.some(value) : Option.none<T>(),
        ),
        Effect.mapError((e) => new UnknownException(e)),
      ),

    setMeta: <T>(key: string, value: T) =>
      storagePut(storage, stepKey(stepName, `meta:${key}`), value).pipe(
        Effect.mapError((e) => new UnknownException(e)),
      ),

    startedAt: storageGet<number>(storage, stepKey(stepName, "startedAt")).pipe(
      Effect.map((value) =>
        value !== undefined ? Option.some(value) : Option.none<number>(),
      ),
      Effect.mapError((e) => new UnknownException(e)),
    ),

    deadline: storageGet<number>(
      storage,
      stepKey(stepName, "meta:deadline"),
    ).pipe(
      Effect.map((value) =>
        value !== undefined ? Option.some(value) : Option.none<number>(),
      ),
      Effect.mapError((e) => new UnknownException(e)),
    ),

    getResult: <T>() =>
      storageGet<T>(storage, stepKey(stepName, "result")).pipe(
        Effect.map((value) =>
          value !== undefined ? Option.some(value) : Option.none<T>(),
        ),
        Effect.mapError((e) => new UnknownException(e)),
      ),

    setResult: <T>(value: T) =>
      Effect.gen(function* () {
        // Pre-validate that the value can be serialized
        yield* validateSerializable(stepName, value);

        // Store the validated value (with retry for transient errors)
        yield* storagePut(storage, stepKey(stepName, "result"), value).pipe(
          Effect.mapError((storageError) => {
            // Double-check for serialization errors from storage.put
            if (isDataCloneError(storageError.cause)) {
              return StepSerializationError.fromSerializationFailure(
                stepName,
                storageError.cause,
                value,
              );
            }
            return new UnknownException(storageError);
          }),
        );
      }),

    incrementAttempt: storagePut(
      storage,
      stepKey(stepName, "attempt"),
      attempt + 1,
    ).pipe(Effect.mapError((e) => new UnknownException(e))),

    recordStartTime: Effect.gen(function* () {
      const existing = yield* storageGet<number>(
        storage,
        stepKey(stepName, "startedAt"),
      ).pipe(Effect.mapError((e) => new UnknownException(e)));
      if (existing === undefined) {
        yield* storagePut(
          storage,
          stepKey(stepName, "startedAt"),
          Date.now(),
        ).pipe(Effect.mapError((e) => new UnknownException(e)));
      }
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
  return storageGet<number>(storage, stepKey(stepName, "attempt")).pipe(
    Effect.map((value) => value ?? 0),
    Effect.mapError((e) => new UnknownException(e)),
  );
}
