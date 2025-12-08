import { describe, it, expect } from "vitest";
import { PauseSignal, isPauseSignal } from "../../src";

describe("PauseSignal", () => {
  describe("static constructors", () => {
    it("should create sleep PauseSignal", () => {
      const signal = PauseSignal.sleep(5000);

      expect(signal.reason).toBe("sleep");
      expect(signal.resumeAt).toBe(5000);
      expect(signal.stepName).toBeUndefined();
      expect(signal.attempt).toBeUndefined();
    });

    it("should create retry PauseSignal", () => {
      const signal = PauseSignal.retry(5000, "myStep", 3);

      expect(signal.reason).toBe("retry");
      expect(signal.resumeAt).toBe(5000);
      expect(signal.stepName).toBe("myStep");
      expect(signal.attempt).toBe(3);
    });
  });

  describe("isPauseSignal", () => {
    it("should return true for PauseSignal instances", () => {
      const sleepSignal = PauseSignal.sleep(1000);
      const retrySignal = PauseSignal.retry(1000, "step", 1);

      expect(isPauseSignal(sleepSignal)).toBe(true);
      expect(isPauseSignal(retrySignal)).toBe(true);
    });

    it("should return false for other errors", () => {
      expect(isPauseSignal(new Error("test"))).toBe(false);
      expect(isPauseSignal({ reason: "sleep", resumeAt: 1000 })).toBe(false);
      expect(isPauseSignal(null)).toBe(false);
      expect(isPauseSignal(undefined)).toBe(false);
    });
  });

  describe("_tag", () => {
    it("should have PauseSignal tag", () => {
      const signal = PauseSignal.sleep(1000);
      expect(signal._tag).toBe("PauseSignal");
    });
  });
});
