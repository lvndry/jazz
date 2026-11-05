/** The PR lane must name every exceeded budget, scale only under --ci, and fail on missing rows. */
import { describe, expect, test } from "bun:test";
import { CI_TIME_SCALE, type LatencyBudget } from "./pr-perf-budgets";
import { effectiveLatencyBudgetMs, latencyFailures, sizeFailures } from "./pr-perf-check";

const budget: LatencyBudget = { suite: "stream", name: "frame", referenceP95Ms: 100 };
const row = (p95Ms: number) => [{ suite: "stream", name: "frame", p95Ms }];

describe("pull-request performance budgets", () => {
  test("passes at the limit and fails above it with the excess named", () => {
    expect(latencyFailures(row(100), [budget], false)).toEqual([]);
    const failures = latencyFailures(row(150), [budget], false);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("stream/frame");
    expect(failures[0]?.message).toContain("budget 100 ms");
    expect(failures[0]?.message).toContain("+50.00 (+50%)");
  });

  test("applies the CI time scale only when requested", () => {
    expect(effectiveLatencyBudgetMs(budget, false)).toBe(100);
    expect(effectiveLatencyBudgetMs(budget, true)).toBe(100 * CI_TIME_SCALE);
    expect(latencyFailures(row(100 * CI_TIME_SCALE), [budget], true)).toEqual([]);
    expect(latencyFailures(row(100 * CI_TIME_SCALE), [budget], false)).toHaveLength(1);
  });

  test("fails a budgeted workload that is absent or not a number", () => {
    expect(latencyFailures([], [budget], false)[0]?.message).toContain("missing");
    expect(latencyFailures(row(Number.NaN), [budget], false)).toHaveLength(1);
  });

  test("checks binary and gzip size independently", () => {
    const limits = { binaryBytes: 1000, gzipBytes: 400 };
    expect(sizeFailures({ binaryBytes: 1000, gzipBytes: 400 }, limits)).toEqual([]);
    const failures = sizeFailures({ binaryBytes: 1100, gzipBytes: 500 }, limits);
    expect(failures.map((failure) => failure.subject)).toEqual(["release binary", "gzip download"]);
    expect(failures[0]?.message).toContain("by +100.00 (+10%) bytes");
  });
});
