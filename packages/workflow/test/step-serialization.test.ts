import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import { ExecutionContext } from "@durable-effect/core";
import { Workflow } from "@/workflow";
import { WorkflowContext } from "@/services/workflow-context";
import { WorkflowScope } from "@/services/workflow-scope";
import { StepSerializationError } from "@/errors";
import { createTestContexts, testWorkflowScope, MockStorage } from "./mocks";

describe("Step Serialization Validation", () => {
  let storage: MockStorage;
  let executionContext: ReturnType<
    typeof createTestContexts
  >["executionContext"];
  let workflowContext: ReturnType<typeof createTestContexts>["workflowContext"];

  beforeEach(() => {
    const contexts = createTestContexts();
    storage = contexts.storage;
    executionContext = contexts.executionContext;
    workflowContext = contexts.workflowContext;
  });

  /**
   * Helper to run a step effect with contexts provided.
   */
  function runStep<T, E>(
    stepEffect: Effect.Effect<
      T,
      E,
      WorkflowScope | ExecutionContext | WorkflowContext
    >,
  ) {
    return stepEffect.pipe(
      Effect.provideService(ExecutionContext, executionContext),
      Effect.provideService(WorkflowContext, workflowContext),
      Effect.provideService(WorkflowScope, testWorkflowScope),
    );
  }

  describe("non-serializable values", () => {
    it("fails with StepSerializationError when step returns an object with function property", async () => {
      const step = Workflow.step(
        "bad-step",
        Effect.succeed({ callback: () => console.log("hello") }),
      );

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = exit.cause;
        // The error should be wrapped in a StepSerializationError
        expect(error._tag).toBe("Fail");
        if (error._tag === "Fail") {
          expect(error.error).toBeInstanceOf(StepSerializationError);
          expect((error.error as StepSerializationError).stepName).toBe(
            "bad-step",
          );
          expect((error.error as StepSerializationError).message).toContain(
            "cannot be serialized",
          );
          // The outer value is an object, but structuredClone will fail
          // because it contains a function property
        }
      }
    });

    it("fails with StepSerializationError when step returns a direct function", async () => {
      const step = Workflow.step(
        "fn-step",
        Effect.succeed(() => "hello"),
      );

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = exit.cause;
        expect(error._tag).toBe("Fail");
        if (error._tag === "Fail") {
          expect(error.error).toBeInstanceOf(StepSerializationError);
          expect((error.error as StepSerializationError).valueType).toBe(
            "function",
          );
        }
      }
    });

    it("fails with StepSerializationError when step returns a Symbol", async () => {
      const step = Workflow.step(
        "symbol-step",
        Effect.succeed(Symbol("test")),
      );

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = exit.cause;
        expect(error._tag).toBe("Fail");
        if (error._tag === "Fail") {
          expect(error.error).toBeInstanceOf(StepSerializationError);
          expect((error.error as StepSerializationError).message).toContain(
            "cannot be serialized",
          );
        }
      }
    });

    // Note: structuredClone DOES support circular references (unlike JSON.stringify)
    // So we don't test for circular reference rejection

    it("allows class instances without function properties (data-only)", async () => {
      // structuredClone can clone class instances - it just loses the prototype
      // This is fine if the class only has serializable data
      class DataOnly {
        constructor(
          public id: number,
          public name: string,
        ) {}
      }

      const step = Workflow.step(
        "data-class-step",
        Effect.succeed(new DataOnly(1, "test")),
      );

      // This should succeed because structuredClone can handle it
      const result = await Effect.runPromise(runStep(step));
      expect(result).toEqual({ id: 1, name: "test" });
    });
  });

  describe("serializable values", () => {
    it("allows primitive values", async () => {
      const stringStep = Workflow.step("string", Effect.succeed("hello"));
      const numberStep = Workflow.step("number", Effect.succeed(42));
      const booleanStep = Workflow.step("boolean", Effect.succeed(true));
      const nullStep = Workflow.step("null", Effect.succeed(null));

      expect(await Effect.runPromise(runStep(stringStep))).toBe("hello");
      expect(await Effect.runPromise(runStep(numberStep))).toBe(42);
      expect(await Effect.runPromise(runStep(booleanStep))).toBe(true);
      expect(await Effect.runPromise(runStep(nullStep))).toBe(null);
    });

    it("allows plain objects", async () => {
      const step = Workflow.step(
        "object",
        Effect.succeed({
          id: 1,
          name: "test",
          nested: { arr: [1, 2, 3] },
          tags: ["a", "b"],
        }),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toEqual({
        id: 1,
        name: "test",
        nested: { arr: [1, 2, 3] },
        tags: ["a", "b"],
      });
    });

    it("allows undefined return value", async () => {
      const step = Workflow.step("void", Effect.succeed(undefined));

      const result = await Effect.runPromise(runStep(step));

      expect(result).toBeUndefined();
    });

    it("allows arrays", async () => {
      const step = Workflow.step(
        "array",
        Effect.succeed([1, 2, { nested: true }]),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toEqual([1, 2, { nested: true }]);
    });

    it("allows Date objects", async () => {
      const now = new Date();
      const step = Workflow.step("date", Effect.succeed(now));

      const result = await Effect.runPromise(runStep(step));

      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(now.getTime());
    });
  });

  describe("error message quality", () => {
    it("includes step name in error message", async () => {
      const step = Workflow.step(
        "my-specific-step-name",
        Effect.succeed({ fn: () => {} }),
      );

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect((exit.cause.error as StepSerializationError).message).toContain(
          "my-specific-step-name",
        );
      }
    });

    it("includes actionable fix suggestions in error", async () => {
      const step = Workflow.step("bad", Effect.succeed({ fn: () => {} }));

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const message = (exit.cause.error as StepSerializationError).message;
        expect(message).toContain("Effect.asVoid");
      }
    });

    it("identifies function type when returning direct function", async () => {
      const step = Workflow.step(
        "fn-step",
        Effect.succeed(() => "hello"),
      );

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as StepSerializationError;
        expect(error.valueType).toBe("function");
      }
    });

    it("identifies object type when returning object with function property", async () => {
      const step = Workflow.step(
        "obj-step",
        Effect.succeed({ handler: () => {} }),
      );

      const exit = await Effect.runPromiseExit(runStep(step));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as StepSerializationError;
        // The outer value type is "object" even though it contains a function
        expect(error.valueType).toBe("object");
        expect(error.message).toContain("may contain non-serializable");
      }
    });
  });

  describe("workaround patterns", () => {
    it("Effect.asVoid discards non-serializable results", async () => {
      const step = Workflow.step(
        "with-void",
        Effect.succeed({ fn: () => {} }).pipe(Effect.asVoid),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toBeUndefined();
    });

    it("Effect.as replaces result with serializable value", async () => {
      const step = Workflow.step(
        "with-as",
        Effect.succeed({ fn: () => {} }).pipe(Effect.as({ success: true })),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toEqual({ success: true });
    });

    it("Effect.map extracts serializable fields", async () => {
      class FakeOrmResult {
        rows = [{ id: 1 }, { id: 2 }];
        command = "SELECT";
        // Non-serializable internal
        _internal = () => {};
      }

      const step = Workflow.step(
        "with-map",
        Effect.succeed(new FakeOrmResult()).pipe(
          Effect.map((r) => ({ rows: r.rows, command: r.command })),
        ),
      );

      const result = await Effect.runPromise(runStep(step));

      expect(result).toEqual({
        rows: [{ id: 1 }, { id: 2 }],
        command: "SELECT",
      });
    });
  });
});
