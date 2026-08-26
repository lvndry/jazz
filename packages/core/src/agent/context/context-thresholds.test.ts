import { describe, expect, it } from "bun:test";
import type { ContextConfig } from "@/core/types/config";
import { resolveContextThresholds } from "./context-thresholds";
import {
  CONTEXT_COMPACT_THRESHOLD_RATIO,
  CONTEXT_WARN_THRESHOLD_RATIO,
} from "./context-window-manager";

describe("resolveContextThresholds", () => {
  it("returns the defaults when no context config is present", () => {
    const resolved = resolveContextThresholds(undefined);
    expect(resolved.warnThresholdRatio).toBe(CONTEXT_WARN_THRESHOLD_RATIO);
    expect(resolved.compactThresholdRatio).toBe(CONTEXT_COMPACT_THRESHOLD_RATIO);
    expect(resolved.warnings).toEqual([]);
  });

  it("accepts an in-range compaction ratio", () => {
    const resolved = resolveContextThresholds({ compactThresholdRatio: 0.9 });
    expect(resolved.compactThresholdRatio).toBe(0.9);
    expect(resolved.warnings).toEqual([]);
  });

  it("accepts both ratios when they keep warn below compact", () => {
    const resolved = resolveContextThresholds({
      warnThresholdRatio: 0.5,
      compactThresholdRatio: 0.6,
    });
    expect(resolved.warnThresholdRatio).toBe(0.5);
    expect(resolved.compactThresholdRatio).toBe(0.6);
    expect(resolved.warnings).toEqual([]);
  });

  it("rejects a compaction ratio at or above the trim ratio", () => {
    const resolved = resolveContextThresholds({ compactThresholdRatio: 0.95 });
    expect(resolved.compactThresholdRatio).toBe(CONTEXT_COMPACT_THRESHOLD_RATIO);
    expect(resolved.warnings[0]).toContain("trim ratio");
  });

  it("rejects a warn ratio that does not precede compaction", () => {
    const resolved = resolveContextThresholds({
      warnThresholdRatio: 0.85,
      compactThresholdRatio: 0.8,
    });
    expect(resolved.warnThresholdRatio).toBe(CONTEXT_WARN_THRESHOLD_RATIO);
    expect(resolved.compactThresholdRatio).toBe(0.8);
    expect(resolved.warnings[0]).toContain("must stay below the compaction ratio");
  });

  it("lowers the default warn ratio to stay under a lower configured compaction ratio", () => {
    const resolved = resolveContextThresholds({ compactThresholdRatio: 0.6 });
    expect(resolved.compactThresholdRatio).toBe(0.6);
    expect(resolved.warnThresholdRatio).toBeLessThanOrEqual(0.6);
    expect(resolved.warnings).toEqual([]);
  });

  it("rejects out-of-range and non-numeric values", () => {
    for (const value of [0, 1, 1.5, -0.2, Number.NaN]) {
      const resolved = resolveContextThresholds({ compactThresholdRatio: value });
      expect(resolved.compactThresholdRatio).toBe(CONTEXT_COMPACT_THRESHOLD_RATIO);
      expect(resolved.warnings).toHaveLength(1);
    }

    const fromJson = resolveContextThresholds({
      compactThresholdRatio: "0.9",
    } as unknown as ContextConfig);
    expect(fromJson.compactThresholdRatio).toBe(CONTEXT_COMPACT_THRESHOLD_RATIO);
    expect(fromJson.warnings[0]).toContain("expected a number between 0 and 1");
  });
});
