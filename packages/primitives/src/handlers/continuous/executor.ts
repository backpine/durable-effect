// packages/primitives/src/handlers/continuous/executor.ts
//
// NOTE: The execution logic has been moved directly into handler.ts
// as the executeUserFunction helper. This file is kept for backwards
// compatibility with tests but the implementation is deprecated.
//
// The inline implementation in handler.ts:
// - Uses proper Effect patterns (catchAll, Effect.try)
// - Has better error handling
// - Avoids the matchEffect anti-pattern
//
// This file can be removed once tests are updated.

import { Effect } from "effect";
import type { ContinuousDefinition } from "../../registry/types";
import type { EntityStateServiceI } from "../../services/entity-state";
import { ExecutionError, type PrimitiveError } from "../../errors";
import { createContinuousContext, type StateHolder } from "./context";

/**
 * @deprecated Use the inline executeUserFunction in handler.ts instead.
 * This function is kept for backwards compatibility with existing tests.
 */
export function executeUserFunction<S>(
  def: ContinuousDefinition<S, unknown, never>,
  stateService: EntityStateServiceI<S>,
  instanceId: string,
  runCount: number
): Effect.Effect<S | null, PrimitiveError> {
  const primitiveName = def.name;

  return Effect.gen(function* () {
    // Get current state
    const currentState = yield* stateService.get().pipe(
      Effect.mapError(
        (e) =>
          new ExecutionError({
            primitiveType: "continuous",
            primitiveName,
            instanceId,
            cause: e,
          })
      )
    );

    if (currentState === null) {
      return null;
    }

    // Create mutable state holder
    const stateHolder: StateHolder<S> = {
      current: currentState,
      dirty: false,
    };

    // Create context for user function
    const ctx = createContinuousContext(stateHolder, instanceId, runCount, def.name);

    // Execute user function with error handling
    yield* Effect.try({
      try: () => def.execute(ctx),
      catch: (e) =>
        new ExecutionError({
          primitiveType: "continuous",
          primitiveName: def.name,
          instanceId,
          cause: e,
        }),
    }).pipe(
      Effect.flatten,
      Effect.catchAll((error) => {
        if (def.onError) {
          return Effect.try({
            try: () => def.onError!(error, ctx),
            catch: (e) =>
              new ExecutionError({
                primitiveType: "continuous",
                primitiveName: def.name,
                instanceId,
                cause: e,
              }),
          }).pipe(Effect.flatten, Effect.asVoid);
        }
        return Effect.fail(
          error instanceof ExecutionError
            ? error
            : new ExecutionError({
                primitiveType: "continuous",
                primitiveName: def.name,
                instanceId,
                cause: error,
              })
        );
      })
    );

    // Persist state if modified
    if (stateHolder.dirty) {
      yield* stateService.set(stateHolder.current).pipe(
        Effect.mapError(
          (e) =>
            new ExecutionError({
              primitiveType: "continuous",
              primitiveName: def.name,
              instanceId,
              cause: e,
            })
        )
      );
      return stateHolder.current;
    }

    return null;
  });
}
