import { Effect, Layer, ServiceMap } from "effect"
import type { TaskDefinition } from "../TaskDefinition.js"

// ---------------------------------------------------------------------------
// RegisteredTask — a task definition paired with its service layer
// ---------------------------------------------------------------------------

export interface RegisteredTask {
  readonly definition: TaskDefinition<unknown, unknown, unknown, unknown>
  readonly layer: Layer.Layer<never> | undefined
}

// ---------------------------------------------------------------------------
// TaskRegistry service — maps task names to registered tasks
// ---------------------------------------------------------------------------

export class TaskRegistry extends ServiceMap.Service<TaskRegistry, {
  readonly get: (name: string) => RegisteredTask | undefined
  readonly names: () => ReadonlyArray<string>
}>()("@task/Registry") {}

// ---------------------------------------------------------------------------
// Registration helpers — type-safe pairing of definitions with layers
// ---------------------------------------------------------------------------

export function registerTask<S, E, Err>(
  definition: TaskDefinition<S, E, Err, never>,
): RegisteredTask
export function registerTask<S, E, Err, R>(
  definition: TaskDefinition<S, E, Err, R>,
  layer: Layer.Layer<R>,
): RegisteredTask
export function registerTask(
  definition: TaskDefinition<unknown, unknown, unknown, unknown>,
  layer?: Layer.Layer<never>,
): RegisteredTask {
  return { definition, layer }
}

// ---------------------------------------------------------------------------
// TaskRegistry.from — builds a registry layer from a config object
// ---------------------------------------------------------------------------

export type TaskRegistryConfig = Record<string, RegisteredTask>

export function buildRegistryLayer(
  config: TaskRegistryConfig,
): Layer.Layer<TaskRegistry> {
  return Layer.succeed(TaskRegistry, {
    get: (name) => config[name],
    names: () => Object.keys(config),
  })
}
