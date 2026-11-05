/** Regression gates must reject real slowdowns, incompatible runs and oversized releases. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  absoluteRegressions,
  ceilingsForTarget,
  regressions,
  sizeRegressions,
  type PerformanceReport,
} from "./performance-check";

function report(p50Ms: number, p95Ms = p50Ms, perSample = [{ p50Ms, p95Ms }]): PerformanceReport {
  return {
    version: 1,
    runtime: { platform: "linux", arch: "x64", bun: "1.4.0" },
    results: [{ suite: "stream", name: "frame", meanMs: p50Ms, p50Ms, p95Ms, perSample }],
  };
}
const pairs = (...values: number[]) => values.map((value) => ({ p50Ms: value, p95Ms: value }));
describe("performance regression gate", () => {
  test("allows runner noise and detects latency regressions including tail-only regressions", () => {
    expect(regressions(report(2), report(2.5))).toEqual([]);
    expect(regressions(report(0.01), report(0.03))).toEqual([]);
    expect(regressions(report(2), report(3))).toHaveLength(2);
    expect(regressions(report(2), report(2, 4))).toHaveLength(1);
  });
  test("ignores a slowdown that only some interleaved pairs show", () => {
    const base = report(2, 2, pairs(2, 2, 2, 2, 2));
    expect(regressions(base, report(3, 3, pairs(3, 3, 3, 2, 3)))).toEqual([]);
    expect(regressions(base, report(3, 3, pairs(3, 3, 3, 3, 3)))).toHaveLength(2);
  });
  test("rejects reports whose samples cannot be paired", () => {
    expect(() => regressions(report(2, 2, pairs(2, 2)), report(2, 2, pairs(2, 2, 2)))).toThrow(
      "unpaired samples",
    );
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
            perSample: pairs(2),
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
          perSample: pairs(p95Ms),
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
      perSample: pairs(p95Ms),
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
        {
          suite: "filesystem-config-models",
          name: "scan",
          meanMs: 1,
          p50Ms: 1,
          p95Ms: 1,
          perSample: pairs(1),
        },
        {
          suite: "conversation-memory",
          name: "500 turns",
          meanMs: 1,
          p50Ms: 1,
          p95Ms: 1,
          perSample: pairs(1),
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
    const maxBytes = 200 * mib;
    expect(sizeRegressions(150 * mib, 154 * mib, "binary", maxBytes)).toEqual([]);
    expect(sizeRegressions(150 * mib, 160 * mib, "binary", maxBytes)).toHaveLength(1);
    expect(sizeRegressions(205 * mib, 205 * mib, "binary", maxBytes)).toHaveLength(1);
  });
  test("ceilings admit the CI-measured sizes", () => {
    const ceilings = ceilingsForTarget("linux-x64");
    expect(ceilings).not.toBeNull();
    expect(sizeRegressions(217_843_888, 217_843_888, "raw", ceilings?.maxBytes ?? null)).toEqual(
      [],
    );
    expect(sizeRegressions(95_421_456, 95_421_456, "gzip", ceilings?.gzipMaxBytes ?? null)).toEqual(
      [],
    );
  });
  test("each ceiling fails an unchanged pair one byte over, independent of relative growth", () => {
    const ceilings = ceilingsForTarget("linux-x64");
    if (ceilings === null) {
      throw new Error("linux-x64 must have ceilings");
    }
    const raw = sizeRegressions(
      ceilings.maxBytes + 1,
      ceilings.maxBytes + 1,
      "raw",
      ceilings.maxBytes,
    );
    expect(raw).toHaveLength(1);
    expect(raw[0]).toContain("exceeds");
    const gzip = sizeRegressions(
      ceilings.gzipMaxBytes + 1,
      ceilings.gzipMaxBytes + 1,
      "gzip",
      ceilings.gzipMaxBytes,
    );
    expect(gzip).toHaveLength(1);
    expect(gzip[0]).toContain("exceeds");
    expect(sizeRegressions(ceilings.maxBytes, ceilings.maxBytes, "raw", ceilings.maxBytes)).toEqual(
      [],
    );
  });
  test("a target without ceilings is not failed by another target's ceiling", () => {
    const linuxCeilings = ceilingsForTarget("linux-x64");
    expect(ceilingsForTarget("darwin-arm64")).toBeNull();
    const oversized = (linuxCeilings?.maxBytes ?? 0) + 1;
    expect(
      sizeRegressions(
        oversized,
        oversized,
        "raw",
        ceilingsForTarget("darwin-arm64")?.maxBytes ?? null,
      ),
    ).toEqual([]);
  });
  test("an unknown target throws", () => {
    expect(() => ceilingsForTarget("linux-riscv")).toThrow("Unknown binary target");
  });
  test("the CLI requires a known target", () => {
    const directory = mkdtempSync(join(tmpdir(), "perf-check-"));
    try {
      const binaryPath = join(directory, "jazz");
      writeFileSync(binaryPath, "x");
      const script = fileURLToPath(new URL("./performance-check.ts", import.meta.url));
      const run = (...args: string[]) =>
        Bun.spawnSync([process.execPath, script, ...args], { stderr: "pipe", stdout: "pipe" });
      const unknown = run("--binary", "--target", "linux-riscv", binaryPath, binaryPath);
      expect(unknown.exitCode).not.toBe(0);
      expect(unknown.stderr.toString()).toContain("Unknown binary target");
      const missing = run("--binary", binaryPath, binaryPath);
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr.toString()).toContain("--target");
      const known = run("--binary", "--target", "linux-x64", binaryPath, binaryPath);
      expect(known.exitCode).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
