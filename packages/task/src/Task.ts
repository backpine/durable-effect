import type { TaskDefineConfig, TaskDefinition } from "./TaskDefinition.js"

// ---------------------------------------------------------------------------
// Task.define() — creates a pure TaskDefinition from a config
// ---------------------------------------------------------------------------

export const Task = {
  define<S, E, EErr, AErr, R, OErr = never, GErr = never>(
    config: TaskDefineConfig<S, E, EErr, AErr, R, OErr, GErr>,
  ): TaskDefinition<S, E, EErr | AErr | OErr | GErr, R> {
    return {
      _tag: "TaskDefinition",
      state: config.state,
      event: config.event,
      onEvent: config.onEvent,
      onAlarm: config.onAlarm,
      onError: config.onError,
      onClientGetState: config.onClientGetState,
    }
  },
}
