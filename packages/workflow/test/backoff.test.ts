import { describe, it, expect } from "vitest";
import { Duration } from "effect";
import {
  Backoff,
  calculateDelay,
  isBackoffConfig,
  type BackoffConfig,
  type ExponentialBackoff,
  type LinearBackoff,
  type ConstantBackoff,
} from "@/backoff";

describe("Backoff", () => {
  describe("calculateDelay", () => {
    describe("exponential backoff", () => {
      it("calculates base delay correctly for attempt 0", () => {
        const config = Backoff.exponential({ base: "1 second" });
        const delay = calculateDelay(config, 0, () => 0.5);
        // No jitter configured, so 1000ms
        expect(Duration.toMillis(delay)).toBe(1000);
      });

      it("calculates exponential growth with default factor 2", () => {
        const config = Backoff.exponential({ base: "1 second" });
        expect(Duration.toMillis(calculateDelay(config, 0))).toBe(1000);
        expect(Duration.toMillis(calculateDelay(config, 1))).toBe(2000);
        expect(Duration.toMillis(calculateDelay(config, 2))).toBe(4000);
        expect(Duration.toMillis(calculateDelay(config, 3))).toBe(8000);
      });

      it("calculates exponential growth with custom factor", () => {
        const config = Backoff.exponential({ base: "1 second", factor: 3 });
        expect(Duration.toMillis(calculateDelay(config, 0))).toBe(1000);
        expect(Duration.toMillis(calculateDelay(config, 1))).toBe(3000);
        expect(Duration.toMillis(calculateDelay(config, 2))).toBe(9000);
        expect(Duration.toMillis(calculateDelay(config, 3))).toBe(27000);
      });

      it("respects max cap", () => {
        const config = Backoff.exponential({
          base: "1 second",
          factor: 2,
          max: "5 seconds",
        });
        // Without cap: 1s, 2s, 4s, 8s, 16s...
        // With cap: 1s, 2s, 4s, 5s, 5s...
        expect(Duration.toMillis(calculateDelay(config, 0))).toBe(1000);
        expect(Duration.toMillis(calculateDelay(config, 1))).toBe(2000);
        expect(Duration.toMillis(calculateDelay(config, 2))).toBe(4000);
        expect(Duration.toMillis(calculateDelay(config, 3))).toBe(5000); // Capped
        expect(Duration.toMillis(calculateDelay(config, 10))).toBe(5000); // Still capped
      });

      it("applies full jitter", () => {
        const config = Backoff.exponential({
          base: "1 second",
          jitter: true, // Defaults to full jitter
        });
        // With full jitter and random=0.5, delay = 0.5 * 1000 = 500
        const delay = calculateDelay(config, 0, () => 0.5);
        expect(Duration.toMillis(delay)).toBe(500);
      });

      it("applies equal jitter", () => {
        const config = Backoff.exponential({
          base: "1 second",
          jitter: { type: "equal" },
        });
        // With equal jitter: delay/2 + random * delay/2
        // = 500 + 0.5 * 500 = 750
        const delay = calculateDelay(config, 0, () => 0.5);
        expect(Duration.toMillis(delay)).toBe(750);
      });

      it("applies decorrelated jitter", () => {
        const config = Backoff.exponential({
          base: "1 second",
          jitter: { type: "decorrelated", factor: 3 },
        });
        // With decorrelated jitter: random * delay * factor
        // = 0.5 * 1000 * 3 = 1500
        const delay = calculateDelay(config, 0, () => 0.5);
        expect(Duration.toMillis(delay)).toBe(1500);
      });

      it("jitter produces varied delays", () => {
        const config = Backoff.exponential({
          base: "1 second",
          jitter: true,
        });
        // Generate 100 delays with Math.random
        const delays = Array.from({ length: 100 }, () =>
          Duration.toMillis(calculateDelay(config, 0)),
        );
        // All should be between 0 and 1000
        expect(delays.every((d) => d >= 0 && d <= 1000)).toBe(true);
        // Should have variance (not all the same)
        const unique = new Set(delays);
        expect(unique.size).toBeGreaterThan(1);
      });
    });

    describe("linear backoff", () => {
      it("calculates initial delay for attempt 0", () => {
        const config = Backoff.linear({
          initial: "1 second",
          increment: "2 seconds",
        });
        expect(Duration.toMillis(calculateDelay(config, 0))).toBe(1000);
      });

      it("calculates linear growth", () => {
        const config = Backoff.linear({
          initial: "1 second",
          increment: "2 seconds",
        });
        // 1s, 3s, 5s, 7s, 9s
        expect(Duration.toMillis(calculateDelay(config, 0))).toBe(1000);
        expect(Duration.toMillis(calculateDelay(config, 1))).toBe(3000);
        expect(Duration.toMillis(calculateDelay(config, 2))).toBe(5000);
        expect(Duration.toMillis(calculateDelay(config, 3))).toBe(7000);
        expect(Duration.toMillis(calculateDelay(config, 4))).toBe(9000);
      });

      it("respects max cap", () => {
        const config = Backoff.linear({
          initial: "1 second",
          increment: "2 seconds",
          max: "6 seconds",
        });
        // Without cap: 1s, 3s, 5s, 7s, 9s
        // With cap: 1s, 3s, 5s, 6s, 6s
        expect(Duration.toMillis(calculateDelay(config, 2))).toBe(5000);
        expect(Duration.toMillis(calculateDelay(config, 3))).toBe(6000); // Capped
        expect(Duration.toMillis(calculateDelay(config, 10))).toBe(6000); // Still capped
      });

      it("applies jitter", () => {
        const config = Backoff.linear({
          initial: "2 seconds",
          increment: "1 second",
          jitter: { type: "full" },
        });
        // At attempt 1: 2s + 1s = 3s, with full jitter = 0.5 * 3000 = 1500
        const delay = calculateDelay(config, 1, () => 0.5);
        expect(Duration.toMillis(delay)).toBe(1500);
      });
    });

    describe("constant backoff", () => {
      it("returns fixed delay for all attempts", () => {
        const config = Backoff.constant("5 seconds");
        expect(Duration.toMillis(calculateDelay(config, 0))).toBe(5000);
        expect(Duration.toMillis(calculateDelay(config, 1))).toBe(5000);
        expect(Duration.toMillis(calculateDelay(config, 10))).toBe(5000);
      });

      it("applies jitter", () => {
        const config = Backoff.constant("10 seconds", true);
        // With full jitter: 0.5 * 10000 = 5000
        const delay = calculateDelay(config, 0, () => 0.5);
        expect(Duration.toMillis(delay)).toBe(5000);
      });

      it("applies jitter config", () => {
        const config = Backoff.constant("10 seconds", { type: "equal" });
        // With equal jitter: 5000 + 0.5 * 5000 = 7500
        const delay = calculateDelay(config, 0, () => 0.5);
        expect(Duration.toMillis(delay)).toBe(7500);
      });
    });
  });

  describe("presets", () => {
    describe("standard", () => {
      it("has expected configuration", () => {
        const preset = Backoff.presets.standard();
        expect(preset._tag).toBe("Exponential");
        expect(Duration.toMillis(Duration.decode(preset.base))).toBe(1000);
        expect(preset.factor).toBe(2);
        expect(Duration.toMillis(Duration.decode(preset.max!))).toBe(30000);
        expect(preset.jitter).toBe(true);
      });

      it("produces expected delays without jitter", () => {
        const preset = Backoff.presets.standard();
        // Remove jitter for deterministic testing
        const config: ExponentialBackoff = { ...preset, jitter: undefined };
        expect(Duration.toMillis(calculateDelay(config, 0))).toBe(1000);
        expect(Duration.toMillis(calculateDelay(config, 1))).toBe(2000);
        expect(Duration.toMillis(calculateDelay(config, 2))).toBe(4000);
        expect(Duration.toMillis(calculateDelay(config, 3))).toBe(8000);
        expect(Duration.toMillis(calculateDelay(config, 4))).toBe(16000);
        expect(Duration.toMillis(calculateDelay(config, 5))).toBe(30000); // Capped
      });
    });

    describe("aggressive", () => {
      it("has expected configuration", () => {
        const preset = Backoff.presets.aggressive();
        expect(preset._tag).toBe("Exponential");
        expect(Duration.toMillis(Duration.decode(preset.base))).toBe(100);
        expect(preset.factor).toBe(2);
        expect(Duration.toMillis(Duration.decode(preset.max!))).toBe(5000);
        expect(preset.jitter).toBe(true);
      });

      it("produces expected delays without jitter", () => {
        const preset = Backoff.presets.aggressive();
        const config: ExponentialBackoff = { ...preset, jitter: undefined };
        expect(Duration.toMillis(calculateDelay(config, 0))).toBe(100);
        expect(Duration.toMillis(calculateDelay(config, 1))).toBe(200);
        expect(Duration.toMillis(calculateDelay(config, 2))).toBe(400);
        expect(Duration.toMillis(calculateDelay(config, 3))).toBe(800);
        expect(Duration.toMillis(calculateDelay(config, 4))).toBe(1600);
        expect(Duration.toMillis(calculateDelay(config, 5))).toBe(3200);
        expect(Duration.toMillis(calculateDelay(config, 6))).toBe(5000); // Capped
      });
    });

    describe("patient", () => {
      it("has expected configuration", () => {
        const preset = Backoff.presets.patient();
        expect(preset._tag).toBe("Exponential");
        expect(Duration.toMillis(Duration.decode(preset.base))).toBe(5000);
        expect(preset.factor).toBe(2);
        expect(Duration.toMillis(Duration.decode(preset.max!))).toBe(120000);
        expect(preset.jitter).toBe(true);
      });

      it("produces expected delays without jitter", () => {
        const preset = Backoff.presets.patient();
        const config: ExponentialBackoff = { ...preset, jitter: undefined };
        expect(Duration.toMillis(calculateDelay(config, 0))).toBe(5000);
        expect(Duration.toMillis(calculateDelay(config, 1))).toBe(10000);
        expect(Duration.toMillis(calculateDelay(config, 2))).toBe(20000);
        expect(Duration.toMillis(calculateDelay(config, 3))).toBe(40000);
        expect(Duration.toMillis(calculateDelay(config, 4))).toBe(80000);
        expect(Duration.toMillis(calculateDelay(config, 5))).toBe(120000); // Capped
      });
    });

    describe("simple", () => {
      it("has expected configuration", () => {
        const preset = Backoff.presets.simple();
        expect(preset._tag).toBe("Constant");
        expect(Duration.toMillis(Duration.decode(preset.duration))).toBe(1000);
        expect(preset.jitter).toBe(true);
      });

      it("produces constant delay without jitter", () => {
        const preset = Backoff.presets.simple();
        const config: ConstantBackoff = { ...preset, jitter: undefined };
        expect(Duration.toMillis(calculateDelay(config, 0))).toBe(1000);
        expect(Duration.toMillis(calculateDelay(config, 5))).toBe(1000);
        expect(Duration.toMillis(calculateDelay(config, 10))).toBe(1000);
      });
    });
  });

  describe("constructor functions", () => {
    it("exponential adds correct tag", () => {
      const config = Backoff.exponential({ base: "1 second" });
      expect(config._tag).toBe("Exponential");
      expect(config.base).toBe("1 second");
    });

    it("linear adds correct tag", () => {
      const config = Backoff.linear({
        initial: "1 second",
        increment: "500 millis",
      });
      expect(config._tag).toBe("Linear");
      expect(config.initial).toBe("1 second");
      expect(config.increment).toBe("500 millis");
    });

    it("constant adds correct tag", () => {
      const config = Backoff.constant("3 seconds", true);
      expect(config._tag).toBe("Constant");
      expect(config.duration).toBe("3 seconds");
      expect(config.jitter).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles zero delay base", () => {
      const config = Backoff.exponential({ base: "0 millis" });
      expect(Duration.toMillis(calculateDelay(config, 0))).toBe(0);
      expect(Duration.toMillis(calculateDelay(config, 5))).toBe(0);
    });

    it("handles very large attempts", () => {
      const config = Backoff.exponential({
        base: "1 second",
        max: "1 hour",
      });
      // Should be capped, not overflow
      const delay = calculateDelay(config, 100);
      expect(Duration.toMillis(delay)).toBe(3600000); // 1 hour in ms
    });

    it("handles Duration object inputs", () => {
      const config = Backoff.exponential({
        base: Duration.seconds(2),
        max: Duration.minutes(1),
      });
      expect(Duration.toMillis(calculateDelay(config, 0))).toBe(2000);
      expect(Duration.toMillis(calculateDelay(config, 10))).toBe(60000); // Capped
    });

    it("handles millisecond-level precision", () => {
      const config = Backoff.exponential({ base: "100 millis" });
      expect(Duration.toMillis(calculateDelay(config, 0))).toBe(100);
      expect(Duration.toMillis(calculateDelay(config, 1))).toBe(200);
      expect(Duration.toMillis(calculateDelay(config, 2))).toBe(400);
    });
  });

  describe("isBackoffConfig", () => {
    it("returns true for ExponentialBackoff", () => {
      const config = Backoff.exponential({ base: "1 second" });
      expect(isBackoffConfig(config)).toBe(true);
    });

    it("returns true for LinearBackoff", () => {
      const config = Backoff.linear({
        initial: "1 second",
        increment: "500 millis",
      });
      expect(isBackoffConfig(config)).toBe(true);
    });

    it("returns true for ConstantBackoff", () => {
      const config = Backoff.constant("3 seconds");
      expect(isBackoffConfig(config)).toBe(true);
    });

    it("returns true for preset configs", () => {
      expect(isBackoffConfig(Backoff.presets.standard())).toBe(true);
      expect(isBackoffConfig(Backoff.presets.aggressive())).toBe(true);
      expect(isBackoffConfig(Backoff.presets.patient())).toBe(true);
      expect(isBackoffConfig(Backoff.presets.simple())).toBe(true);
    });

    it("returns false for Duration strings", () => {
      expect(isBackoffConfig("5 seconds")).toBe(false);
      expect(isBackoffConfig("100 millis")).toBe(false);
    });

    it("returns false for Duration objects", () => {
      expect(isBackoffConfig(Duration.seconds(5))).toBe(false);
      expect(isBackoffConfig(Duration.millis(100))).toBe(false);
    });

    it("returns false for functions", () => {
      const fn = (attempt: number) => Duration.seconds(attempt);
      expect(isBackoffConfig(fn)).toBe(false);
    });

    it("returns false for numbers", () => {
      expect(isBackoffConfig(1000)).toBe(false);
      expect(isBackoffConfig(0)).toBe(false);
    });

    it("returns false for null and undefined", () => {
      expect(isBackoffConfig(null)).toBe(false);
      expect(isBackoffConfig(undefined)).toBe(false);
    });

    it("returns false for plain objects without _tag", () => {
      expect(isBackoffConfig({})).toBe(false);
      expect(isBackoffConfig({ base: "1 second" })).toBe(false);
    });

    it("returns false for objects with invalid _tag", () => {
      expect(isBackoffConfig({ _tag: "Unknown" })).toBe(false);
      expect(isBackoffConfig({ _tag: "exponential" })).toBe(false); // lowercase
      expect(isBackoffConfig({ _tag: 123 })).toBe(false);
    });
  });
});
