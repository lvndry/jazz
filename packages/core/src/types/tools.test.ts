import { describe, expect, it } from "bun:test";
import {
  MAX_TOOL_PROGRESS_SUMMARY,
  shouldAutoApprove,
  summarizeToolResult,
  type AutoApprovePolicy,
  type ToolRiskLevel,
} from "./tools";

describe("shouldAutoApprove", () => {
  describe("no policy (undefined)", () => {
    it("auto-approves read-only and low-risk when a prompt was the alternative", () => {
      const canPrompt = { canPrompt: true };
      expect(shouldAutoApprove("read-only", undefined, canPrompt)).toBe(true);
      expect(shouldAutoApprove("low-risk", undefined, canPrompt)).toBe(true);
      expect(shouldAutoApprove("high-risk", undefined, canPrompt)).toBe(false);
      expect(shouldAutoApprove("unknown", undefined, canPrompt)).toBe(false);
    });

    it("approves nothing where nobody can be asked", () => {
      for (const level of ["read-only", "low-risk", "high-risk", "unknown"] as const) {
        expect(shouldAutoApprove(level, undefined)).toBe(false);
        expect(shouldAutoApprove(level, undefined, { canPrompt: false })).toBe(false);
      }
    });
  });

  describe("policy: false", () => {
    it("auto-approves read-only and low-risk when a prompt was the alternative", () => {
      const canPrompt = { canPrompt: true };
      expect(shouldAutoApprove("read-only", false, canPrompt)).toBe(true);
      expect(shouldAutoApprove("low-risk", false, canPrompt)).toBe(true);
      expect(shouldAutoApprove("high-risk", false, canPrompt)).toBe(false);
      expect(shouldAutoApprove("unknown", false, canPrompt)).toBe(false);
    });

    it("approves nothing where nobody can be asked", () => {
      expect(shouldAutoApprove("read-only", false)).toBe(false);
      expect(shouldAutoApprove("low-risk", false)).toBe(false);
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

describe("summarizeToolResult", () => {
  it("keeps a short string result as it is", () => {
    expect(summarizeToolResult("8 results")).toBe("8 results");
  });

  it("folds a multi-line result onto one line", () => {
    expect(summarizeToolResult("first\n  second\n\nthird")).toBe("first second third");
  });

  it("clips a long result to the cap, ellipsis included", () => {
    const summary = summarizeToolResult("x".repeat(MAX_TOOL_PROGRESS_SUMMARY * 3));
    expect(summary).toHaveLength(MAX_TOOL_PROGRESS_SUMMARY);
    expect(summary?.endsWith("\u2026")).toBe(true);
  });

  it("renders a structured result as JSON", () => {
    expect(summarizeToolResult({ matches: 3 })).toBe('{"matches":3}');
  });

  it("says nothing rather than something empty", () => {
    expect(summarizeToolResult(undefined)).toBeUndefined();
    expect(summarizeToolResult(null)).toBeUndefined();
    expect(summarizeToolResult("   \n  ")).toBeUndefined();
  });

  it("survives a result that cannot be serialized", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(summarizeToolResult(cyclic)).toBeUndefined();
    expect(summarizeToolResult({ big: 1n })).toBeUndefined();
  });
});
