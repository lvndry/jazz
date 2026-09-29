/** Regression gates must reject real slowdowns, incompatible runs and oversized releases. */
import { describe, expect, test } from "bun:test";
import {
  absoluteRegressions,
  regressions,
  sizeRegressions,
  type PerformanceReport,
} from "./performance-check";

function report(p50Ms: number, p95Ms = p50Ms): PerformanceReport {
  return {
    version: 1,
    runtime: { platform: "linux", arch: "x64", bun: "1.4.0" },
    results: [{ suite: "stream", name: "frame", meanMs: p50Ms, p50Ms, p95Ms }],
  };
}
describe("performance regression gate", () => {
  test("allows runner noise and detects latency regressions including tail-only regressions", () => {
    expect(regressions(report(2), report(2.5))).toEqual([]);
    expect(regressions(report(0.01), report(0.03))).toEqual([]);
    expect(regressions(report(2), report(3))).toHaveLength(2);
    expect(regressions(report(2), report(2, 4))).toHaveLength(1);
  });
  test("rejects comparisons with incompatible runtimes or no shared workload", () => {
    expect(() =>
      regressions(report(2), { ...report(2), runtime: { ...report(2).runtime, arch: "arm64" } }),
    ).toThrow("runtime identities");
    expect(() =>
      regressions(report(2), {
        ...report(2),
        results: [
          {
            ...report(2).results[0]!,
            name: "different",
            meanMs: 2,
            p50Ms: 2,
            p95Ms: 2,
            suite: "stream",
          },
        ],
      }),
    ).toThrow("no comparable");
  });
  test("enforces absolute latency ceilings and requires budgeted workloads", () => {
    const fixture = (p95Ms: number): PerformanceReport => ({
      ...report(p95Ms),
      results: [
        {
          suite: "filesystem-config-models",
          name: "approval scan",
          meanMs: p95Ms,
          p50Ms: p95Ms,
          p95Ms,
        },
      ],
    });
    const rules = [{ suite: "filesystem-config-models", maxP95Ms: 1000 }];
    expect(absoluteRegressions(fixture(500), rules)).toEqual([]);
    expect(absoluteRegressions(fixture(1001), rules)).toHaveLength(1);
    expect(absoluteRegressions(report(2), rules)).toHaveLength(1);
  });
  test("exempts only named delayed cases and still requires their separate ceilings", () => {
    const fences = ["ink open fence buffer -> terminal", "opentui open fence buffer -> terminal"];
    const rules = [
      { suite: "ui-pipeline", maxP95Ms: 250, excludeNames: fences },
      ...fences.map((name) => ({ suite: "ui-pipeline", name, maxP95Ms: 2500 })),
    ];
    const row = (name: string, p95Ms: number) => ({
      suite: "ui-pipeline",
      name,
      meanMs: p95Ms,
      p50Ms: p95Ms,
      p95Ms,
    });
    const fixture: PerformanceReport = {
      ...report(1),
      results: [row("ordinary frame", 30), ...fences.map((name) => row(name, 2100))],
    };
    expect(absoluteRegressions(fixture, rules)).toEqual([]);
    expect(
      absoluteRegressions(
        {
          ...fixture,
          results: [
            ...fixture.results,
            row("ink open fence buffer -> terminal unexpected", 2100),
            row("ordinary slow frame", 300),
          ],
        },
        rules,
      ),
    ).toHaveLength(2);
    expect(
      absoluteRegressions(
        {
          ...fixture,
          results: fixture.results.map((value) =>
            value.name === fences[0] ? row(value.name, 2501) : value,
          ),
        },
        rules,
      ),
    ).toHaveLength(1);
    expect(
      absoluteRegressions(
        { ...fixture, results: fixture.results.filter((value) => value.name !== fences[0]) },
        rules,
      ),
    ).toEqual([`Missing budgeted workload: ui-pipeline/${fences[0]}`]);
  });
  test("accepts signed retained-memory deltas and enforces release-after-clear ceilings", () => {
    const fixture: PerformanceReport = {
      ...report(1),
      results: [
        { suite: "filesystem-config-models", name: "scan", meanMs: 1, p50Ms: 1, p95Ms: 1 },
        {
          suite: "conversation-memory",
          name: "500 turns",
          meanMs: 1,
          p50Ms: 1,
          p95Ms: 1,
          metrics: { peakRssBytes: 100_000_000, postClearHeapBytes: -1000 },
        },
      ],
    };
    const rules = [
      {
        suite: "conversation-memory",
        metrics: { peakRssBytes: 1_000_000_000, postClearHeapBytes: 64_000_000 },
      },
    ];
    expect(absoluteRegressions(fixture, rules)).toEqual([]);
    const memory = fixture.results[1]!;
    expect(
      absoluteRegressions(
        {
          ...fixture,
          results: [
            fixture.results[0]!,
            {
              ...memory,
              metrics: { peakRssBytes: 2_000_000_000, postClearHeapBytes: 100_000_000 },
            },
          ],
        },
        rules,
      ),
    ).toHaveLength(2);
  });
  test("allows small release noise but blocks growth and emergency oversize", () => {
    const mib = 1024 * 1024;
    expect(sizeRegressions(150 * mib, 154 * mib, "binary")).toEqual([]);
    expect(sizeRegressions(150 * mib, 160 * mib, "binary")).toHaveLength(1);
    expect(sizeRegressions(205 * mib, 205 * mib, "binary")).toHaveLength(1);
  });
});
