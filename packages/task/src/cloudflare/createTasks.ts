import { Effect } from "effect"
import type { TaskDefinition } from "../TaskDefinition.js"
import { registerTask } from "../services/TaskRegistry.js"
import type { TaskRegistryConfig } from "../services/TaskRegistry.js"
import { makeTaskEngine } from "./TaskEngine.js"
import type { DurableObjectState } from "./TaskEngine.js"
import { TaskClientError } from "./errors.js"

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type EventOf<
  T extends Record<string, TaskDefinition<any, any, any, never>>,
  K extends keyof T,
> = T[K] extends TaskDefinition<any, infer E, any, any> ? E : never

// ---------------------------------------------------------------------------
// Structural types — avoids depending on CF ambient types
// ---------------------------------------------------------------------------

export interface DurableObjectNamespaceLike {
  idFromName(name: string): { toString(): string }
  get(id: { toString(): string }): {
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response>
  }
}

// ---------------------------------------------------------------------------
// TaskHandle — bound client for a single task type
// ---------------------------------------------------------------------------

export interface TaskHandle<E> {
  readonly send: (id: string, event: E) => Effect.Effect<void, TaskClientError>
  readonly alarm: (id: string) => Effect.Effect<void, TaskClientError>
}

// ---------------------------------------------------------------------------
// TasksAccessor — callable that returns a TaskHandle
// ---------------------------------------------------------------------------

export interface TasksAccessor<
  T extends Record<string, TaskDefinition<any, any, any, never>>,
> {
  <K extends keyof T & string>(
    doNamespace: DurableObjectNamespaceLike,
    name: K,
  ): TaskHandle<EventOf<T, K>>
}

// ---------------------------------------------------------------------------
// createTasks — factory that produces a DO class + typed accessor
// ---------------------------------------------------------------------------

export function createTasks<
  const T extends Record<string, TaskDefinition<any, any, any, never>>,
>(
  definitions: T,
): {
  TasksDO: {
    new (state: DurableObjectState): {
      fetch(request: Request): Promise<Response>
      alarm(): Promise<void>
    }
  }
  tasks: TasksAccessor<T>
} {
  // Build registry config from definitions
  const registryConfig: TaskRegistryConfig = {}
  for (const [name, def] of Object.entries(definitions)) {
    registryConfig[name] = registerTask(def)
  }

  // Generated DO class
  class TasksDO {
    private engine: ReturnType<typeof makeTaskEngine>

    constructor(state: DurableObjectState) {
      this.engine = makeTaskEngine(state, {
        name: "__multi__",
        tasks: registryConfig,
      })
    }

    fetch(request: Request): Promise<Response> {
      return this.engine.fetch(request)
    }

    alarm(): Promise<void> {
      return this.engine.alarm()
    }
  }

  // Build a TaskHandle bound to a specific DO namespace and task name
  const makeHandle = (
    doNamespace: DurableObjectNamespaceLike,
    name: string,
  ): TaskHandle<any> => ({
    send(id, event) {
      return Effect.tryPromise({
        try: async () => {
          const instanceId = `${name}:${id}`
          const doId = doNamespace.idFromName(instanceId)
          const stub = doNamespace.get(doId)
          const resp = await stub.fetch("http://task/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "event", name, id, event }),
          })
          if (!resp.ok) {
            const text = await resp.text()
            throw new Error(`DO error: ${resp.status} ${text}`)
          }
        },
        catch: (cause) =>
          new TaskClientError({
            message:
              cause instanceof Error
                ? cause.message
                : "Unknown error sending event",
            cause,
          }),
      })
    },
    alarm(id) {
      return Effect.tryPromise({
        try: async () => {
          const instanceId = `${name}:${id}`
          const doId = doNamespace.idFromName(instanceId)
          const stub = doNamespace.get(doId)
          const resp = await stub.fetch("http://task/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "alarm", name, id }),
          })
          if (!resp.ok) {
            const text = await resp.text()
            throw new Error(`DO error: ${resp.status} ${text}`)
          }
        },
        catch: (cause) =>
          new TaskClientError({
            message:
              cause instanceof Error
                ? cause.message
                : "Unknown error triggering alarm",
            cause,
          }),
      })
    },
  })

  const tasks: TasksAccessor<T> = (doNamespace, name) =>
    makeHandle(doNamespace, name)

  return { TasksDO, tasks }
}
