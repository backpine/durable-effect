import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "effect";
import { Workflow } from "@/workflow";
import { StepError } from "@/errors";
import { createWorkflowHarness } from "../harness";

describe("Workflow Retry Lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("success scenarios", () => {
    it("returns value when effect succeeds on first try", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          const result = yield* Workflow.step(
            "fetch",
            Effect.succeed("data").pipe(
              Workflow.retry({ maxAttempts: 3, delay: "1 second" }),
            ),
          );
          return result;
        }),
      );

      const harness = createWorkflowHarness(workflow);
      await harness.run(undefined);

      expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
      expect(await harness.getCompletedSteps()).toEqual(["fetch"]);
    });

    it("retries and succeeds after failures", async () => {
      let attempts = 0;

      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          const result = yield* Workflow.step(
            "flaky",
            Effect.gen(function* () {
              attempts++;
              if (attempts < 3) {
                return yield* Effect.fail(new Error("temporary"));
              }
              return "success";
            }).pipe(Workflow.retry({ maxAttempts: 5, delay: "2 seconds" })),
          );
          return result;
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // First run - fails, pauses for retry
      await harness.run(undefined);
      expect(attempts).toBe(1);
      expect(await harness.getStatus()).toMatchObject({
        _tag: "Paused",
        reason: "retry",
      });

      // Second run - fails again, pauses
      vi.setSystemTime(2000);
      await harness.triggerAlarm();
      expect(attempts).toBe(2);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

      // Third run - succeeds
      vi.setSystemTime(4000);
      await harness.triggerAlarm();
      expect(attempts).toBe(3);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
    });
  });

  describe("failure scenarios", () => {
    it("fails with original error when maxAttempts reached", async () => {
      let attempts = 0;

      // maxAttempts: 2 means 2 retries allowed (3 total attempts: initial + 2 retries)
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "alwaysFails",
            Effect.gen(function* () {
              attempts++;
              return yield* Effect.fail(new Error("permanent failure"));
            }).pipe(Workflow.retry({ maxAttempts: 2, delay: "1 second" })),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Attempt 0 (initial) - fail, retry scheduled (0 < 2)
      await harness.run(undefined);
      expect(attempts).toBe(1);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

      // Attempt 1 (retry 1) - fail, retry scheduled (1 < 2)
      vi.setSystemTime(1000);
      await harness.triggerAlarm();
      expect(attempts).toBe(2);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

      // Attempt 2 (retry 2) - fail, exhausted (2 >= 2)
      vi.setSystemTime(2000);
      await harness.triggerAlarm();
      expect(attempts).toBe(3);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Failed" });
    });
  });

  describe("while predicate", () => {
    it("retries when while() returns true", async () => {
      let attempts = 0;

      class RetryableError extends Error {
        readonly _tag = "RetryableError";
      }

      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "conditional",
            Effect.gen(function* () {
              attempts++;
              if (attempts < 2) {
                return yield* Effect.fail(new RetryableError("retry me"));
              }
              return "done";
            }).pipe(
              Workflow.retry({
                maxAttempts: 5,
                delay: "1 second",
                while: (err) => err instanceof RetryableError,
              }),
            ),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow);

      await harness.run(undefined);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

      vi.setSystemTime(1000);
      await harness.triggerAlarm();
      expect(attempts).toBe(2);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
    });

    it("fails immediately when while() returns false", async () => {
      let attempts = 0;

      class NonRetryableError extends Error {
        readonly _tag = "NonRetryableError";
      }

      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "noRetry",
            Effect.gen(function* () {
              attempts++;
              return yield* Effect.fail(new NonRetryableError("don't retry"));
            }).pipe(
              Workflow.retry({
                maxAttempts: 5,
                delay: "1 second",
                while: () => false, // Never retry
              }),
            ),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow);

      await harness.run(undefined);
      expect(attempts).toBe(1);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Failed" });
    });
  });

  describe("delay calculation", () => {
    it("uses default 1 second delay when not specified", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "defaultDelay",
            Effect.fail(new Error("fail")).pipe(
              Workflow.retry({ maxAttempts: 3 }),
            ),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow);
      await harness.run(undefined);

      expect(await harness.storage.getAlarm()).toBe(1000); // 1 second default
    });

    it("uses fixed delay when Duration provided", async () => {
      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "fixedDelay",
            Effect.fail(new Error("fail")).pipe(
              Workflow.retry({ maxAttempts: 3, delay: "5 seconds" }),
            ),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow);
      await harness.run(undefined);

      expect(await harness.storage.getAlarm()).toBe(5000);
    });

    it("uses backoff function when function provided", async () => {
      const delays: number[] = [];

      const workflow = Workflow.make("test", (_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "backoff",
            Effect.fail(new Error("fail")).pipe(
              Workflow.retry({
                maxAttempts: 4,
                delay: (attempt) => {
                  const ms = 1000 * Math.pow(2, attempt);
                  return `${ms} millis`;
                },
              }),
            ),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Attempt 0 -> delay = 1000 * 2^0 = 1000
      await harness.run(undefined);
      delays.push((await harness.storage.getAlarm()) ?? 0);

      // Attempt 1 -> delay = 1000 * 2^1 = 2000
      vi.setSystemTime(1000);
      await harness.triggerAlarm();
      delays.push((await harness.storage.getAlarm()) ?? 0);

      // Attempt 2 -> delay = 1000 * 2^2 = 4000
      vi.setSystemTime(3000);
      await harness.triggerAlarm();
      delays.push((await harness.storage.getAlarm()) ?? 0);

      expect(delays).toEqual([1000, 3000, 7000]); // Absolute times: 0+1000, 1000+2000, 3000+4000
    });
  });
});
