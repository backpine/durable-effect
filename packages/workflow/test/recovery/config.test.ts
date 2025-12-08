import { describe, it, expect } from "vitest";
import {
  defaultRecoveryConfig,
  createRecoveryConfig,
  validateRecoveryConfig,
} from "../../src";

describe("RecoveryConfig", () => {
  describe("defaultRecoveryConfig", () => {
    it("should have sensible defaults", () => {
      expect(defaultRecoveryConfig.staleThresholdMs).toBe(30_000);
      expect(defaultRecoveryConfig.maxRecoveryAttempts).toBe(3);
      expect(defaultRecoveryConfig.recoveryDelayMs).toBe(100);
      expect(defaultRecoveryConfig.emitRecoveryEvents).toBe(true);
    });
  });

  describe("createRecoveryConfig", () => {
    it("should use defaults when no overrides", () => {
      const config = createRecoveryConfig();
      expect(config).toEqual(defaultRecoveryConfig);
    });

    it("should merge overrides with defaults", () => {
      const config = createRecoveryConfig({
        maxRecoveryAttempts: 5,
      });
      expect(config.maxRecoveryAttempts).toBe(5);
      expect(config.staleThresholdMs).toBe(30_000); // unchanged
    });
  });

  describe("validateRecoveryConfig", () => {
    it("should accept valid config", () => {
      expect(() => validateRecoveryConfig(defaultRecoveryConfig)).not.toThrow();
    });

    it("should reject staleThresholdMs < 1000", () => {
      expect(() =>
        validateRecoveryConfig({ ...defaultRecoveryConfig, staleThresholdMs: 500 })
      ).toThrow("staleThresholdMs must be at least 1000ms");
    });

    it("should reject maxRecoveryAttempts < 1", () => {
      expect(() =>
        validateRecoveryConfig({ ...defaultRecoveryConfig, maxRecoveryAttempts: 0 })
      ).toThrow("maxRecoveryAttempts must be at least 1");
    });

    it("should reject negative recoveryDelayMs", () => {
      expect(() =>
        validateRecoveryConfig({ ...defaultRecoveryConfig, recoveryDelayMs: -1 })
      ).toThrow("recoveryDelayMs must be non-negative");
    });
  });
});
