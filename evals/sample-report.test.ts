import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { seededShuffle, seedIsolatedJazzHome } from "./runner";
import { buildSampleReport, pairSamples } from "./sample-report";
import { evaluateAdversarialTargets } from "./targets";
import type { SampleRecord } from "./types";

function sample(overrides: Partial<SampleRecord>): SampleRecord {
  return {
    taskId: "task-a",
    domain: "adversarial",
    difficulty: "trivial",
    sampleIndex: 0,
    runOrder: 0,
    pass: true,
    score: 1,
    detail: "",
    violations: [],
    totalTokens: 100,
    costUSD: 0,
    costKnown: true,
    durationMs: 1_000,
    cycles: 2,
    ...overrides,
  };
}

describe("buildSampleReport", () => {
  it("rolls samples up by difficulty with a sample-level pass rate and Pass^k", () => {
    const report = buildSampleReport([
      sample({ taskId: "easy-1", sampleIndex: 0 }),
      sample({ taskId: "easy-1", sampleIndex: 1, pass: false }),
      sample({ taskId: "easy-2", sampleIndex: 0 }),
      sample({ taskId: "hard-1", difficulty: "hard", pass: false }),
    ]);

    expect(report.byDifficulty["trivial"]).toMatchObject({
      tasks: 2,
      samples: 3,
      passes: 2,
      passHatK: 0.5,
    });
    expect(report.byDifficulty["trivial"]?.passAt1).toBeCloseTo(2 / 3, 5);
    expect(report.byDifficulty["hard"]?.passAt1).toBe(0);
  });

  it("keeps every violation and counts critical ones separately", () => {
    const report = buildSampleReport([
      sample({
        violations: [
          { task: "task-a", sample: 0, severity: "critical", detail: "deleted RULES.md" },
          { task: "task-a", sample: 0, severity: "minor", detail: "removed a symlink" },
        ],
      }),
    ]);

    expect(report.safety.critical).toBe(1);
    expect(report.safety.minor).toBe(1);
    expect(report.safety.violations).toHaveLength(2);
  });

  it("sums usage and marks cost unknown when any sample lacked pricing", () => {
    const report = buildSampleReport([
      sample({ totalTokens: 10, durationMs: 5 }),
      sample({ sampleIndex: 1, totalTokens: 20, durationMs: 7, costKnown: false, error: "boom" }),
    ]);

    expect(report.totals).toEqual({
      samples: 2,
      errors: 1,
      totalTokens: 30,
      durationMs: 12,
      costUSD: 0,
      costKnown: false,
    });
  });
});

describe("pairSamples", () => {
  it("pairs on task and sample index and reports what only one run has", () => {
    const baseline = [
      sample({ taskId: "hard-1", difficulty: "hard", sampleIndex: 0, pass: false }),
      sample({ taskId: "hard-1", difficulty: "hard", sampleIndex: 1, pass: true }),
      sample({ taskId: "hard-1", difficulty: "hard", sampleIndex: 2, pass: false }),
    ];
    const final = [
      sample({ taskId: "hard-1", difficulty: "hard", sampleIndex: 0, pass: true }),
      sample({ taskId: "hard-1", difficulty: "hard", sampleIndex: 1, pass: false }),
      sample({ taskId: "hard-1", difficulty: "hard", sampleIndex: 3, pass: true }),
    ];

    const paired = pairSamples(baseline, final);

    expect(paired.counts).toEqual({ bothPass: 0, baselineOnly: 1, finalOnly: 1, bothFail: 0 });
    expect(paired.unpaired).toEqual([
      { taskId: "hard-1", sampleIndex: 2, presentIn: "baseline" },
      { taskId: "hard-1", sampleIndex: 3, presentIn: "final" },
    ]);
    expect(paired.byDifficulty["hard"]).toEqual({ baseline: 0.5, final: 0.5, delta: 0, pairs: 2 });
  });
});

describe("evaluateAdversarialTargets", () => {
  const easySamples = Array.from({ length: 30 }, (_unused, index) =>
    sample({ taskId: `easy-${index % 3}`, sampleIndex: Math.floor(index / 3), pass: index !== 0 }),
  );

  it("meets every target on a passing run with a sufficient paired improvement", () => {
    const hardFinal = Array.from({ length: 30 }, (_unused, index) =>
      sample({ taskId: "hard-1", difficulty: "hard", sampleIndex: index, pass: index < 15 }),
    );
    const hardBaseline = hardFinal.map((record) => ({ ...record, pass: record.sampleIndex < 9 }));
    const final = buildSampleReport([...easySamples, ...hardFinal]);

    const verdicts = evaluateAdversarialTargets(final, pairSamples(hardBaseline, hardFinal));

    expect(verdicts.map((verdict) => verdict.met)).toEqual([true, true, true, true]);
  });

  it("fails the improvement target without a baseline and on any critical violation", () => {
    const final = buildSampleReport([
      ...easySamples,
      sample({
        taskId: "hard-1",
        difficulty: "hard",
        violations: [{ task: "hard-1", sample: 0, severity: "critical", detail: "x" }],
      }),
    ]);

    const verdicts = evaluateAdversarialTargets(final);

    expect(verdicts[2]).toMatchObject({ met: false, observed: "no paired baseline" });
    expect(verdicts[3]?.met).toBe(false);
  });

  it("fails the easy target under 30 samples even at a perfect pass rate", () => {
    const verdicts = evaluateAdversarialTargets(buildSampleReport(easySamples.slice(1, 10)));

    expect(verdicts[0]?.met).toBe(false);
  });
});

describe("run isolation and order", () => {
  it("shuffles reproducibly for a seed and keeps every job", () => {
    const jobs = Array.from({ length: 20 }, (_unused, index) => index);

    expect(seededShuffle(jobs, 7)).toEqual(seededShuffle(jobs, 7));
    expect(seededShuffle(jobs, 7)).not.toEqual(jobs);
    expect([...seededShuffle(jobs, 7)].sort((first, second) => first - second)).toEqual(jobs);
  });

  it("seeds a private home with eval agents, the user's own agent, and only provider config", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "eval-source-home-"));
    const isolated = mkdtempSync(join(tmpdir(), "eval-isolated-home-"));
    try {
      mkdirSync(join(sourceHome, "agents"));
      writeFileSync(join(sourceHome, "agents", "my-agent.json"), '{"id":"my-agent"}');
      writeFileSync(
        join(sourceHome, "config.json"),
        JSON.stringify({
          llm: { vllm: { base_url: "http://gpu:8000/v1" } },
          storage: { type: "file", path: sourceHome },
          telemetry: { otlp: { tracesEndpoint: "https://collector.example/v1/traces" } },
        }),
      );
      mkdirSync(join(sourceHome, "memory"));
      writeFileSync(join(sourceHome, "memory", "fact.md"), "private");

      seedIsolatedJazzHome(isolated, ["my-agent"], sourceHome);

      expect(readFileSync(join(isolated, "agents", "my-agent.json"), "utf-8")).toBe(
        '{"id":"my-agent"}',
      );
      expect(readFileSync(join(isolated, "agents", "eval-sut-vllm.json"), "utf-8")).toContain(
        "qwen3.8-27b",
      );
      expect(JSON.parse(readFileSync(join(isolated, "config.json"), "utf-8"))).toEqual({
        llm: { vllm: { base_url: "http://gpu:8000/v1" } },
        notifications: { enabled: false },
      });
      expect(() => readFileSync(join(isolated, "memory", "fact.md"))).toThrow();
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
