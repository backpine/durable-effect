// packages/primitives/src/handlers/continuous/context.ts

import { Effect } from "effect";
import type { ContinuousContext, TerminateOptions } from "../../registry/types";
import { TerminateSignal } from "../../errors";

// =============================================================================
// Context Factory
// =============================================================================

/**
 * State holder for mutable state updates during execution.
 *
 * The context provides setState/updateState methods that modify this holder.
 * After execution, we read the final state from here.
 */
export interface StateHolder<S> {
  current: S;
  dirty: boolean;
}

/**
 * Create a ContinuousContext for user's execute function.
 *
 * The context provides:
 * - state: Current state (read-only reference)
 * - setState: Replace entire state
 * - updateState: Update state via function
 * - terminate: Terminate this primitive instance
 * - instanceId: DO instance identifier
 * - runCount: Number of times execute has been called
 * - primitiveName: Name of the primitive
 */
export function createContinuousContext<S>(
  stateHolder: StateHolder<S>,
  instanceId: string,
  runCount: number,
  primitiveName: string
): ContinuousContext<S> {
  return {
    get state() {
      return stateHolder.current;
    },

    setState: (newState: S) => {
      stateHolder.current = newState;
      stateHolder.dirty = true;
    },

    updateState: (fn: (current: S) => S) => {
      stateHolder.current = fn(stateHolder.current);
      stateHolder.dirty = true;
    },

    instanceId,
    runCount,
    primitiveName,

    terminate: (options?: TerminateOptions) =>
      Effect.fail(
        new TerminateSignal({
          reason: options?.reason,
          purgeState: options?.purgeState ?? true,
        })
      ) as Effect.Effect<never, never, never>,
  };
}
