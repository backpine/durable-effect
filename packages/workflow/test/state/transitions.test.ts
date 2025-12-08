import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  getValidTransitions,
  isTerminalStatus,
  isRecoverableStatus,
  VALID_TRANSITIONS,
} from "../../src";

describe("Transition Validation", () => {
  describe("VALID_TRANSITIONS matrix", () => {
    it("should define transitions for all statuses", () => {
      const statuses = [
        "Pending",
        "Queued",
        "Running",
        "Paused",
        "Completed",
        "Failed",
        "Cancelled",
      ];

      for (const status of statuses) {
        expect(VALID_TRANSITIONS[status as keyof typeof VALID_TRANSITIONS]).toBeDefined();
      }
    });
  });

  describe("isValidTransition", () => {
    // Pending transitions
    it("should allow Start from Pending", () => {
      expect(isValidTransition("Pending", "Start")).toBe(true);
    });

    it("should allow Queue from Pending", () => {
      expect(isValidTransition("Pending", "Queue")).toBe(true);
    });

    it("should reject Resume from Pending", () => {
      expect(isValidTransition("Pending", "Resume")).toBe(false);
    });

    // Queued transitions
    it("should allow Start from Queued", () => {
      expect(isValidTransition("Queued", "Start")).toBe(true);
    });

    it("should allow Cancel from Queued", () => {
      expect(isValidTransition("Queued", "Cancel")).toBe(true);
    });

    it("should reject Complete from Queued", () => {
      expect(isValidTransition("Queued", "Complete")).toBe(false);
    });

    // Running transitions
    it("should allow Complete from Running", () => {
      expect(isValidTransition("Running", "Complete")).toBe(true);
    });

    it("should allow Pause from Running", () => {
      expect(isValidTransition("Running", "Pause")).toBe(true);
    });

    it("should allow Fail from Running", () => {
      expect(isValidTransition("Running", "Fail")).toBe(true);
    });

    it("should allow Cancel from Running", () => {
      expect(isValidTransition("Running", "Cancel")).toBe(true);
    });

    it("should allow Recover from Running", () => {
      expect(isValidTransition("Running", "Recover")).toBe(true);
    });

    it("should reject Start from Running", () => {
      expect(isValidTransition("Running", "Start")).toBe(false);
    });

    // Paused transitions
    it("should allow Resume from Paused", () => {
      expect(isValidTransition("Paused", "Resume")).toBe(true);
    });

    it("should allow Cancel from Paused", () => {
      expect(isValidTransition("Paused", "Cancel")).toBe(true);
    });

    it("should allow Recover from Paused", () => {
      expect(isValidTransition("Paused", "Recover")).toBe(true);
    });

    // Terminal states
    it("should reject all transitions from Completed", () => {
      expect(isValidTransition("Completed", "Start")).toBe(false);
      expect(isValidTransition("Completed", "Cancel")).toBe(false);
      expect(isValidTransition("Completed", "Recover")).toBe(false);
    });

    it("should reject all transitions from Failed", () => {
      expect(isValidTransition("Failed", "Start")).toBe(false);
      expect(isValidTransition("Failed", "Resume")).toBe(false);
    });

    it("should reject all transitions from Cancelled", () => {
      expect(isValidTransition("Cancelled", "Start")).toBe(false);
      expect(isValidTransition("Cancelled", "Resume")).toBe(false);
    });
  });

  describe("isTerminalStatus", () => {
    it("should return true for terminal states", () => {
      expect(isTerminalStatus("Completed")).toBe(true);
      expect(isTerminalStatus("Failed")).toBe(true);
      expect(isTerminalStatus("Cancelled")).toBe(true);
    });

    it("should return false for non-terminal states", () => {
      expect(isTerminalStatus("Pending")).toBe(false);
      expect(isTerminalStatus("Queued")).toBe(false);
      expect(isTerminalStatus("Running")).toBe(false);
      expect(isTerminalStatus("Paused")).toBe(false);
    });
  });

  describe("isRecoverableStatus", () => {
    it("should return true for Running and Paused", () => {
      expect(isRecoverableStatus("Running")).toBe(true);
      expect(isRecoverableStatus("Paused")).toBe(true);
    });

    it("should return false for non-recoverable states", () => {
      expect(isRecoverableStatus("Pending")).toBe(false);
      expect(isRecoverableStatus("Queued")).toBe(false);
      expect(isRecoverableStatus("Completed")).toBe(false);
    });
  });
});
