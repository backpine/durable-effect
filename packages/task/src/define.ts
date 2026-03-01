import type { Layer } from "effect";
import type { TaskDefineConfig, TaskDefinition } from "./types.js";

function makeDefinition<S, E, EErr, AErr, R, OErr>(
  config: TaskDefineConfig<S, E, EErr, AErr, R, OErr>,
  layers: ReadonlyArray<Layer.Layer<any, any, any>>,
): TaskDefinition<S, E, EErr | AErr | OErr, R> {
  return {
    _tag: "TaskDefinition" as const,
    state: config.state,
    event: config.event,
    onEvent: config.onEvent,
    onAlarm: config.onAlarm,
    onError: config.onError,
    layers,
    provide<ROut>(
      layer: Layer.Layer<ROut, any, any>,
    ): TaskDefinition<S, E, EErr | AErr | OErr, Exclude<R, ROut>> {
      // Layers are accumulated and applied at execution time by the executor.
      // The R → Exclude<R, ROut> narrowing is a runtime guarantee, not
      // statically verifiable, so we widen the return type here.
      return makeDefinition(config, [...layers, layer]) as TaskDefinition<
        S, E, EErr | AErr | OErr, Exclude<R, ROut>
      >;
    },
  };
}

export const Task = {
  define<S, E, EErr, AErr, R, OErr = never>(
    config: TaskDefineConfig<S, E, EErr, AErr, R, OErr>,
  ): TaskDefinition<S, E, EErr | AErr | OErr, R> {
    return makeDefinition(config, []);
  },
};
