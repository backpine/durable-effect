import { describe, it, expect } from "vitest";
import {
  BackoffStrategies,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
} from "../../src";

describe("Backoff Utilities", () => {
  describe("calculateBackoffDelay", () => {
    it("should calculate constant delay", () => {
      const strategy = BackoffStrategies.constant(1000);

      expect(calculateBackoffDelay(strategy, 1)).toBe(1000);
      expect(calculateBackoffDelay(strategy, 2)).toBe(1000);
      expect(calculateBackoffDelay(strategy, 10)).toBe(1000);
    });

    it("should calculate linear delay", () => {
      const strategy = BackoffStrategies.linear(1000, 500);

      expect(calculateBackoffDelay(strategy, 1)).toBe(1000);
      expect(calculateBackoffDelay(strategy, 2)).toBe(1500);
      expect(calculateBackoffDelay(strategy, 3)).toBe(2000);
    });

    it("should respect linear max delay", () => {
      const strategy = BackoffStrategies.linear(1000, 500, 2000);

      expect(calculateBackoffDelay(strategy, 5)).toBe(2000);
    });

    it("should calculate exponential delay", () => {
      const strategy = BackoffStrategies.exponential(1000);

      expect(calculateBackoffDelay(strategy, 1)).toBe(1000);
      expect(calculateBackoffDelay(strategy, 2)).toBe(2000);
      expect(calculateBackoffDelay(strategy, 3)).toBe(4000);
      expect(calculateBackoffDelay(strategy, 4)).toBe(8000);
    });

    it("should respect exponential max delay", () => {
      const strategy = BackoffStrategies.exponential(1000, { maxDelayMs: 5000 });

      expect(calculateBackoffDelay(strategy, 10)).toBe(5000);
    });

    it("should use custom multiplier for exponential", () => {
      const strategy = BackoffStrategies.exponential(1000, { multiplier: 3 });

      expect(calculateBackoffDelay(strategy, 1)).toBe(1000);
      expect(calculateBackoffDelay(strategy, 2)).toBe(3000);
      expect(calculateBackoffDelay(strategy, 3)).toBe(9000);
    });
  });

  describe("addJitter", () => {
    it("should add jitter within bounds", () => {
      const base = 1000;
      const jitterFactor = 0.1;

      for (let i = 0; i < 100; i++) {
        const result = addJitter(base, jitterFactor);
        expect(result).toBeGreaterThanOrEqual(base * 0.9);
        expect(result).toBeLessThanOrEqual(base * 1.1);
      }
    });

    it("should use default jitter factor", () => {
      const base = 1000;

      for (let i = 0; i < 100; i++) {
        const result = addJitter(base);
        expect(result).toBeGreaterThanOrEqual(base * 0.9);
        expect(result).toBeLessThanOrEqual(base * 1.1);
      }
    });
  });

  describe("parseDuration", () => {
    it("should parse milliseconds", () => {
      expect(parseDuration("100ms")).toBe(100);
      expect(parseDuration("100 milliseconds")).toBe(100);
    });

    it("should parse seconds", () => {
      expect(parseDuration("5s")).toBe(5000);
      expect(parseDuration("5 seconds")).toBe(5000);
      expect(parseDuration("5 second")).toBe(5000);
      expect(parseDuration("5sec")).toBe(5000);
    });

    it("should parse minutes", () => {
      expect(parseDuration("5m")).toBe(300000);
      expect(parseDuration("5 minutes")).toBe(300000);
      expect(parseDuration("5 minute")).toBe(300000);
      expect(parseDuration("5min")).toBe(300000);
    });

    it("should parse hours", () => {
      expect(parseDuration("1h")).toBe(3600000);
      expect(parseDuration("1 hour")).toBe(3600000);
      expect(parseDuration("2 hours")).toBe(7200000);
      expect(parseDuration("1hr")).toBe(3600000);
    });

    it("should parse days", () => {
      expect(parseDuration("1d")).toBe(86400000);
      expect(parseDuration("1 day")).toBe(86400000);
      expect(parseDuration("2 days")).toBe(172800000);
    });

    it("should pass through numbers", () => {
      expect(parseDuration(5000)).toBe(5000);
    });

    it("should parse decimal values", () => {
      expect(parseDuration("1.5s")).toBe(1500);
      expect(parseDuration("0.5 hours")).toBe(1800000);
    });

    it("should throw on invalid format", () => {
      expect(() => parseDuration("invalid")).toThrow();
      expect(() => parseDuration("5x")).toThrow();
    });
  });
});
