
import { describe, it, expect, vi } from "vitest";
import { createJobsClient } from "../src/client/client";
import { createTypedJobRegistry } from "../src/registry/registry";
import { Task } from "../src/definitions/task";
import { Schema, Effect } from "effect";

describe("Task Client", () => {
  it("should provide type-safe access to task methods", () => {
    const taskDef = Task.make({
      stateSchema: Schema.Struct({ value: Schema.Number }),
      eventSchema: Schema.Struct({ _tag: Schema.Literal("Increment") }),
      onEvent: (ctx) => Effect.void,
      execute: (ctx) => Effect.void,
    });

    const registry = createTypedJobRegistry({ myTask: taskDef });

    // Mock binding
    const binding = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: any) => ({
        call: async (req: any) => {
          if (req.action === "send") {
            return {
              _type: "task.send",
              instanceId: "id",
              created: true,
              scheduledAt: null,
            };
          }
          throw new Error("Unexpected call");
        },
      }),
    } as any;

    const client = createJobsClient(binding, registry);

    const taskClient = client.task("myTask");
    expect(taskClient).toBeDefined();
    expect(taskClient.send).toBeDefined();
    
    // Type check (will fail compilation if types are wrong)
    const effect = taskClient.send({
      id: "123",
      event: { _tag: "Increment" }
    });
    
    expect(Effect.isEffect(effect)).toBe(true);
  });
});
