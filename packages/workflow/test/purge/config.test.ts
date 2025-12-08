import { describe, it, expect } from "vitest";
import {
  defaultPurgeDelayMs,
  parsePurgeConfig,
  type PurgeConfig,
} from "../../src";

describe("PurgeConfig", () => {
  describe("defaultPurgeDelayMs", () => {
    it("should be 60 seconds", () => {
      expect(defaultPurgeDelayMs).toBe(60_000);
    });
  });

  describe("parsePurgeConfig", () => {
    it("should return disabled when no config provided", () => {
      const result = parsePurgeConfig(undefined);
      expect(result.enabled).toBe(false);
      expect(result.delayMs).toBe(defaultPurgeDelayMs);
    });

    it("should enable with default delay when empty object provided", () => {
      const result = parsePurgeConfig({});
      expect(result.enabled).toBe(true);
      expect(result.delayMs).toBe(defaultPurgeDelayMs);
    });

    it("should parse numeric delay in milliseconds", () => {
      const result = parsePurgeConfig({ delay: 30000 });
      expect(result.enabled).toBe(true);
      expect(result.delayMs).toBe(30000);
    });

    it("should parse string duration - seconds", () => {
      const result = parsePurgeConfig({ delay: "30 seconds" });
      expect(result.enabled).toBe(true);
      expect(result.delayMs).toBe(30_000);
    });

    it("should parse string duration - minutes", () => {
      const result = parsePurgeConfig({ delay: "5 minutes" });
      expect(result.enabled).toBe(true);
      expect(result.delayMs).toBe(5 * 60 * 1000);
    });

    it("should parse string duration - hours", () => {
      const result = parsePurgeConfig({ delay: "2 hours" });
      expect(result.enabled).toBe(true);
      expect(result.delayMs).toBe(2 * 60 * 60 * 1000);
    });

    it("should parse string duration - days", () => {
      const result = parsePurgeConfig({ delay: "1 day" });
      expect(result.enabled).toBe(true);
      expect(result.delayMs).toBe(24 * 60 * 60 * 1000);
    });

    it("should parse singular units", () => {
      expect(parsePurgeConfig({ delay: "1 second" }).delayMs).toBe(1000);
      expect(parsePurgeConfig({ delay: "1 minute" }).delayMs).toBe(60_000);
      expect(parsePurgeConfig({ delay: "1 hour" }).delayMs).toBe(3_600_000);
    });

    it("should handle shorthand durations", () => {
      expect(parsePurgeConfig({ delay: "30s" }).delayMs).toBe(30_000);
      expect(parsePurgeConfig({ delay: "5m" }).delayMs).toBe(300_000);
      expect(parsePurgeConfig({ delay: "2h" }).delayMs).toBe(7_200_000);
    });

    it("should throw on invalid duration string", () => {
      expect(() => parsePurgeConfig({ delay: "invalid" })).toThrow();
    });
  });
});
