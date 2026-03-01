import type { TaskDefinition } from "../types.js";

export interface TaskRegistry {
  readonly get: (name: string) => TaskDefinition<any, any, any, any> | undefined;
  readonly register: (name: string, definition: TaskDefinition<any, any, any, any>) => void;
}

export function createTaskRegistry(): TaskRegistry {
  const definitions = new Map<string, TaskDefinition<any, any, any, any>>();
  return {
    get: (name) => definitions.get(name),
    register: (name, def) => { definitions.set(name, def); },
  };
}
