import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { make } from "../../src";

describe("Workflow.make", () => {
  it("should create a workflow definition", () => {
    const workflow = make({ name: "testWorkflow" }, (input: { value: number }) =>
      Effect.succeed(input.value * 2)
    );

    expect(workflow.name).toBe("testWorkflow");
    expect(typeof workflow.execute).toBe("function");
  });

  it("should preserve type information", () => {
    const workflow = make(
      { name: "typedWorkflow" },
      (input: { name: string; count: number }) =>
        Effect.succeed({ result: `${input.name}-${input.count}` })
    );

    // Type checking - these should compile
    type Input = Parameters<typeof workflow.execute>[0];
    type _CheckInput = Input extends { name: string; count: number }
      ? true
      : false;

    expect(workflow.name).toBe("typedWorkflow");
  });

  it("should execute workflow effect", async () => {
    const workflow = make({ name: "executableWorkflow" }, (input: { x: number }) =>
      Effect.gen(function* () {
        return input.x + 10;
      })
    );

    const result = await Effect.runPromise(workflow.execute({ x: 5 }));
    expect(result).toBe(15);
  });

  it("should handle workflow errors", async () => {
    class CustomError {
      readonly _tag = "CustomError";
    }

    const workflow = make({ name: "failingWorkflow" }, (_input: {}) =>
      Effect.fail(new CustomError())
    );

    const result = await Effect.runPromise(
      workflow.execute({}).pipe(Effect.either)
    );

    expect(result._tag).toBe("Left");
  });

  it("should handle async workflows", async () => {
    const workflow = make({ name: "asyncWorkflow" }, (input: string) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Promise.resolve());
        return `processed: ${input}`;
      })
    );

    const result = await Effect.runPromise(workflow.execute("test"));
    expect(result).toBe("processed: test");
  });
});
