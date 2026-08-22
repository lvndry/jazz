import { describe, expect, it } from "bun:test";
import { shouldAutoApprove, type AutoApprovePolicy, type ToolRiskLevel } from "./tools";

describe("shouldAutoApprove", () => {
  describe("no policy (undefined)", () => {
    it("should auto-approve read-only and low-risk, and prompt for the rest", () => {
      expect(shouldAutoApprove("read-only", undefined)).toBe(true);
      expect(shouldAutoApprove("low-risk", undefined)).toBe(true);
      expect(shouldAutoApprove("high-risk", undefined)).toBe(false);
      expect(shouldAutoApprove("unknown", undefined)).toBe(false);
    });
  });

  describe("policy: false", () => {
    it("should auto-approve read-only and low-risk, and prompt for the rest", () => {
      expect(shouldAutoApprove("read-only", false)).toBe(true);
      expect(shouldAutoApprove("low-risk", false)).toBe(true);
      expect(shouldAutoApprove("high-risk", false)).toBe(false);
      expect(shouldAutoApprove("unknown", false)).toBe(false);
    });
  });

  describe("policy: true", () => {
    it("should auto-approve all risk levels", () => {
      expect(shouldAutoApprove("read-only", true)).toBe(true);
      expect(shouldAutoApprove("low-risk", true)).toBe(true);
      expect(shouldAutoApprove("high-risk", true)).toBe(true);
      expect(shouldAutoApprove("unknown", true)).toBe(true);
    });
  });

  describe('policy: "high-risk"', () => {
    it("should auto-approve all risk levels", () => {
      expect(shouldAutoApprove("read-only", "high-risk")).toBe(true);
      expect(shouldAutoApprove("low-risk", "high-risk")).toBe(true);
      expect(shouldAutoApprove("high-risk", "high-risk")).toBe(true);
      expect(shouldAutoApprove("unknown", "high-risk")).toBe(true);
    });
  });

  describe('policy: "low-risk"', () => {
    it("should auto-approve read-only and low-risk, but not high-risk or unknown", () => {
      expect(shouldAutoApprove("read-only", "low-risk")).toBe(true);
      expect(shouldAutoApprove("low-risk", "low-risk")).toBe(true);
      expect(shouldAutoApprove("high-risk", "low-risk")).toBe(false);
      expect(shouldAutoApprove("unknown", "low-risk")).toBe(false);
    });
  });

  describe('policy: "read-only"', () => {
    it("should only auto-approve read-only tools", () => {
      expect(shouldAutoApprove("read-only", "read-only")).toBe(true);
      expect(shouldAutoApprove("low-risk", "read-only")).toBe(false);
      expect(shouldAutoApprove("high-risk", "read-only")).toBe(false);
      expect(shouldAutoApprove("unknown", "read-only")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle all combinations correctly", () => {
      const policies: (AutoApprovePolicy | undefined)[] = [
        undefined,
        false,
        true,
        "read-only",
        "low-risk",
        "high-risk",
      ];
      const riskLevels: ToolRiskLevel[] = ["read-only", "low-risk", "high-risk", "unknown"];

      for (const policy of policies) {
        for (const riskLevel of riskLevels) {
          const result = shouldAutoApprove(riskLevel, policy);
          expect(typeof result).toBe("boolean");
        }
      }
    });
  });
});
