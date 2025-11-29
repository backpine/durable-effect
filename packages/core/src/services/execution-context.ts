import { Context, Effect } from "effect";
import { UnknownException } from "effect/Cause";

/**
 * Internal execution context service.
 * Provides low-level access to durable storage and alarms.
 * @internal
 */
export interface ExecutionContextService {
  readonly storage: DurableObjectStorage;
  readonly setAlarm: (time: number) => Effect.Effect<void, UnknownException>;
}

/**
 * Internal execution context tag.
 * @internal
 */
export class ExecutionContext extends Context.Tag("Workflow/ExecutionContext")<
  ExecutionContext,
  ExecutionContextService
>() {}

/**
 * Create an ExecutionContext service from a DurableObjectState.
 * @internal
 */
export function createExecutionContext(
  ctx: DurableObjectState,
): ExecutionContextService {
  return {
    storage: ctx.storage,
    setAlarm: (time: number) =>
      Effect.tryPromise({
        try: () => ctx.storage.setAlarm(time),
        catch: (e) => new UnknownException(e),
      }),
  };
}
