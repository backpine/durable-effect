import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "effect";
import { Workflow } from "@/workflow";
import { Backoff } from "@/backoff";
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
      const workflow = Workflow.make((_: void) =>
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

      const workflow = Workflow.make((_: void) =>
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
      const workflow = Workflow.make((_: void) =>
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

  describe("delay calculation", () => {
    it("uses default 1 second delay when not specified", async () => {
      const workflow = Workflow.make((_: void) =>
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
      const workflow = Workflow.make((_: void) =>
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

      const workflow = Workflow.make((_: void) =>
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

  describe("backoff configuration", () => {
    it("uses exponential backoff with automatic delay progression", async () => {
      const delays: number[] = [];

      const workflow = Workflow.make((_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "exponential",
            Effect.fail(new Error("fail")).pipe(
              Workflow.retry({
                maxAttempts: 4,
                delay: Backoff.exponential({ base: "1 second" }),
              }),
            ),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Attempt 0 -> delay = 1s * 2^0 = 1000ms
      await harness.run(undefined);
      delays.push((await harness.storage.getAlarm()) ?? 0);

      // Attempt 1 -> delay = 1s * 2^1 = 2000ms
      vi.setSystemTime(1000);
      await harness.triggerAlarm();
      delays.push((await harness.storage.getAlarm()) ?? 0);

      // Attempt 2 -> delay = 1s * 2^2 = 4000ms
      vi.setSystemTime(3000);
      await harness.triggerAlarm();
      delays.push((await harness.storage.getAlarm()) ?? 0);

      // Absolute times: 0+1000, 1000+2000, 3000+4000
      expect(delays).toEqual([1000, 3000, 7000]);
    });

    it("uses linear backoff with increment", async () => {
      const delays: number[] = [];

      const workflow = Workflow.make((_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "linear",
            Effect.fail(new Error("fail")).pipe(
              Workflow.retry({
                maxAttempts: 4,
                delay: Backoff.linear({
                  initial: "1 second",
                  increment: "1 second",
                }),
              }),
            ),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Attempt 0 -> delay = 1s + (0 * 1s) = 1000ms
      await harness.run(undefined);
      delays.push((await harness.storage.getAlarm()) ?? 0);

      // Attempt 1 -> delay = 1s + (1 * 1s) = 2000ms
      vi.setSystemTime(1000);
      await harness.triggerAlarm();
      delays.push((await harness.storage.getAlarm()) ?? 0);

      // Attempt 2 -> delay = 1s + (2 * 1s) = 3000ms
      vi.setSystemTime(3000);
      await harness.triggerAlarm();
      delays.push((await harness.storage.getAlarm()) ?? 0);

      // Absolute times: 0+1000, 1000+2000, 3000+3000
      expect(delays).toEqual([1000, 3000, 6000]);
    });

    it("respects max cap on exponential backoff", async () => {
      const workflow = Workflow.make((_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "capped",
            Effect.fail(new Error("fail")).pipe(
              Workflow.retry({
                maxAttempts: 10,
                delay: Backoff.exponential({
                  base: "1 second",
                  max: "3 seconds",
                }),
              }),
            ),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Run through several attempts
      await harness.run(undefined);
      let alarm = await harness.storage.getAlarm();
      expect(alarm).toBe(1000); // 1s

      vi.setSystemTime(1000);
      await harness.triggerAlarm();
      alarm = await harness.storage.getAlarm();
      expect(alarm).toBe(3000); // 1000 + 2000 = 3000

      vi.setSystemTime(3000);
      await harness.triggerAlarm();
      alarm = await harness.storage.getAlarm();
      expect(alarm).toBe(6000); // 3000 + 3000 (capped)

      vi.setSystemTime(6000);
      await harness.triggerAlarm();
      alarm = await harness.storage.getAlarm();
      expect(alarm).toBe(9000); // 6000 + 3000 (capped)
    });

    it("uses preset backoff configuration", async () => {
      let attempts = 0;

      const workflow = Workflow.make((_: void) =>
        Effect.gen(function* () {
          const result = yield* Workflow.step(
            "preset",
            Effect.gen(function* () {
              attempts++;
              if (attempts < 2) {
                return yield* Effect.fail(new Error("temporary"));
              }
              return "success";
            }).pipe(
              Workflow.retry({
                maxAttempts: 5,
                // Use aggressive preset without jitter for deterministic test
                delay: { ...Backoff.presets.aggressive(), jitter: undefined },
              }),
            ),
          );
          return result;
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // First run - fails, pauses for retry with 100ms delay
      await harness.run(undefined);
      expect(attempts).toBe(1);
      expect(await harness.storage.getAlarm()).toBe(100);

      // Second run - succeeds
      vi.setSystemTime(100);
      await harness.triggerAlarm();
      expect(attempts).toBe(2);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Completed" });
    });
  });

  describe("maxDuration", () => {
    it("exhausts retries when maxDuration would be exceeded", async () => {
      let attempts = 0;

      const workflow = Workflow.make((_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "maxDuration",
            Effect.gen(function* () {
              attempts++;
              return yield* Effect.fail(new Error("permanent failure"));
            }).pipe(
              Workflow.retry({
                maxAttempts: 100, // High max attempts
                delay: "5 seconds",
                maxDuration: "12 seconds", // Will exhaust after ~2-3 retries
              }),
            ),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Attempt 0 (initial) - fail, retry scheduled
      await harness.run(undefined);
      expect(attempts).toBe(1);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

      // Attempt 1 - fail, retry scheduled (5s elapsed)
      vi.setSystemTime(5000);
      await harness.triggerAlarm();
      expect(attempts).toBe(2);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

      // Attempt 2 - fail, but next retry would exceed 12s maxDuration
      // elapsed (10s) + delay (5s) = 15s > 12s
      vi.setSystemTime(10000);
      await harness.triggerAlarm();
      expect(attempts).toBe(3);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Failed" });
    });

    it("maxDuration works with exponential backoff", async () => {
      let attempts = 0;

      const workflow = Workflow.make((_: void) =>
        Effect.gen(function* () {
          yield* Workflow.step(
            "maxDurationBackoff",
            Effect.gen(function* () {
              attempts++;
              return yield* Effect.fail(new Error("permanent failure"));
            }).pipe(
              Workflow.retry({
                maxAttempts: 100,
                delay: Backoff.exponential({ base: "2 seconds" }),
                maxDuration: "10 seconds",
              }),
            ),
          );
        }),
      );

      const harness = createWorkflowHarness(workflow);

      // Attempt 0 - delay = 2s
      await harness.run(undefined);
      expect(attempts).toBe(1);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

      // Attempt 1 - delay = 4s (2s elapsed)
      vi.setSystemTime(2000);
      await harness.triggerAlarm();
      expect(attempts).toBe(2);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Paused" });

      // Attempt 2 - delay would be 8s (6s elapsed)
      // 6s + 8s = 14s > 10s maxDuration
      vi.setSystemTime(6000);
      await harness.triggerAlarm();
      expect(attempts).toBe(3);
      expect(await harness.getStatus()).toMatchObject({ _tag: "Failed" });
    });
  });
});
