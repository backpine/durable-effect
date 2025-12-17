
import { describe, it, expect } from "vitest";
import { createTypedJobRegistry, toRuntimeRegistry } from "../src/registry";
import { Task } from "../src/definitions";
import { Schema, Effect } from "effect";

describe("Task Registry", () => {
  it("should register task definitions correctly", () => {
    const taskDef = Task.make({
      stateSchema: Schema.Struct({ value: Schema.Number }),
      eventSchema: Schema.Struct({ _tag: Schema.Literal("Increment") }),
      onEvent: (ctx) => Effect.void,
      execute: (ctx) => Effect.void,
    });

    const registry = createTypedJobRegistry({ myTask: taskDef });

    // Type check: registry.task.myTask should exist
    // @ts-expect-error
    registry.task.otherTask;
    
    expect(registry.task.myTask).toBeDefined();
    expect(registry.task.myTask.name).toBe("myTask");
    expect(registry.task.myTask._tag).toBe("TaskDefinition");

    // Runtime check
    const runtime = toRuntimeRegistry(registry);
    expect(runtime.task.myTask).toBeDefined();
    expect(runtime.task.myTask.name).toBe("myTask");
  });
});
