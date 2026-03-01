import type { TaskDefineConfig, TaskDefinition } from "./TaskDefinition.js"

// ---------------------------------------------------------------------------
// Task.define() — creates a pure TaskDefinition from a config
// ---------------------------------------------------------------------------

export const Task = {
  define<S, E, EErr, AErr, R, OErr = never>(
    config: TaskDefineConfig<S, E, EErr, AErr, R, OErr>,
  ): TaskDefinition<S, E, EErr | AErr | OErr, R> {
    return {
      _tag: "TaskDefinition",
      state: config.state,
      event: config.event,
      onEvent: config.onEvent,
      onAlarm: config.onAlarm,
      onError: config.onError,
    }
  },
}
