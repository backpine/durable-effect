import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  StoreError,
  SchedulerError,
  ValidationError,
  TaskNotFoundError,
  ClientError,
  PurgeSignal,
} from "../src/index.js";

describe("Error types", () => {
  it("StoreError has correct tag and fields", () => {
    const err = new StoreError({ message: "store failed", cause: "db down" });
    expect(err._tag).toBe("StoreError");
    expect(err.message).toBe("store failed");
    expect(err.cause).toBe("db down");
  });

  it("SchedulerError has correct tag and fields", () => {
    const err = new SchedulerError({ message: "schedule failed" });
    expect(err._tag).toBe("SchedulerError");
    expect(err.message).toBe("schedule failed");
  });

  it("ValidationError has correct tag and fields", () => {
    const err = new ValidationError({ message: "invalid input" });
    expect(err._tag).toBe("ValidationError");
    expect(err.message).toBe("invalid input");
  });

  it("TaskNotFoundError has correct tag and name", () => {
    const err = new TaskNotFoundError({ name: "myTask" });
    expect(err._tag).toBe("TaskNotFoundError");
    expect(err.name).toBe("myTask");
  });

  it("ClientError has correct tag and fields", () => {
    const err = new ClientError({ message: "rpc failed", cause: new Error("timeout") });
    expect(err._tag).toBe("ClientError");
    expect(err.message).toBe("rpc failed");
  });

  it("PurgeSignal has correct tag", () => {
    const err = new PurgeSignal();
    expect(err._tag).toBe("PurgeSignal");
  });

  it("errors can be caught with Effect.catchTag", async () => {
    const program = Effect.gen(function* () {
      yield* Effect.fail(new StoreError({ message: "boom" }));
      return "never";
    }).pipe(
      Effect.catchTag("StoreError", (e) => Effect.succeed(`caught: ${e.message}`)),
    );

    const result = await Effect.runPromise(program);
    expect(result).toBe("caught: boom");
  });

  it("PurgeSignal can be caught by tag", async () => {
    const program = Effect.gen(function* () {
      yield* Effect.fail(new PurgeSignal());
      return "never" as never;
    }).pipe(
      Effect.catchTag("PurgeSignal", () => Effect.succeed("purged")),
    );

    const result = await Effect.runPromise(program);
    expect(result).toBe("purged");
  });
});
