/**
 * Sample-level reporting: rollups by difficulty tier, the safety-violation ledger, usage
 * totals, and baseline-versus-final pairing on the same (task, sample index).
 *
 * The per-task metrics in `runner.ts` answer "how many tasks does the agent solve"; these
 * answer "how often does a single attempt succeed, what did it cost, and did anything
 * unsafe happen", which is what a predeclared target is written against.
 */
import { bootstrapCI, makeRng, passHatK } from "./metrics";
import type { SafetyViolation, SampleRecord } from "./types";

export interface RunMetadata {
  agentId: string;
  provider: string;
  model: string;
  reasoning?: string;
  gitRevision: string;
  /** True when the working tree had uncommitted changes, so the revision alone does not identify the code. */
  gitDirty: boolean;
  startedAt: string;
  finishedAt: string;
  samplesPerTask: number;
  concurrency: number;
  seed: number;
  taskIds: string[];
}

export interface TierBlock {
  tasks: number;
  samples: number;
  passes: number;
  passAt1: number;
  /** Seeded bootstrap 95% CI over individual sample outcomes. */
  ci: { lo: number; hi: number; mean: number };
  /** Fraction of the tier's tasks whose every sample passed. */
  passHatK: number;
}

export interface SampleReport {
  byDifficulty: Record<string, TierBlock>;
  safety: { critical: number; minor: number; violations: SafetyViolation[] };
  totals: {
    samples: number;
    errors: number;
    totalTokens: number;
    durationMs: number;
    costUSD: number;
    /** False when any sample's provider had no pricing, so `costUSD` is a lower bound. */
    costKnown: boolean;
  };
  samples: SampleRecord[];
}

const BOOTSTRAP_SEED = 1234;

export function tierBlock(records: readonly SampleRecord[]): TierBlock {
  const outcomes = records.map((record) => (record.pass ? 1 : 0));
  const byTask = new Map<string, boolean[]>();
  for (const record of records) {
    const samples = byTask.get(record.taskId) ?? [];
    samples.push(record.pass);
    byTask.set(record.taskId, samples);
  }
  const passes = outcomes.reduce<number>((sum, outcome) => sum + outcome, 0);
  const reliableTasks = [...byTask.values()].filter((samples) => passHatK(samples) === 1).length;
  return {
    tasks: byTask.size,
    samples: records.length,
    passes,
    passAt1: records.length === 0 ? 0 : passes / records.length,
    ci: bootstrapCI(outcomes, makeRng(BOOTSTRAP_SEED)),
    passHatK: byTask.size === 0 ? 0 : reliableTasks / byTask.size,
  };
}

export function buildSampleReport(records: readonly SampleRecord[]): SampleReport {
  const ordered = [...records].sort(
    (first, second) =>
      first.taskId.localeCompare(second.taskId) || first.sampleIndex - second.sampleIndex,
  );
  const tiers = new Map<string, SampleRecord[]>();
  for (const record of ordered) {
    const tier = tiers.get(record.difficulty) ?? [];
    tier.push(record);
    tiers.set(record.difficulty, tier);
  }
  const violations = ordered.flatMap((record) => record.violations);
  return {
    byDifficulty: Object.fromEntries(
      [...tiers.entries()].map(([difficulty, tier]) => [difficulty, tierBlock(tier)]),
    ),
    safety: {
      critical: violations.filter((violation) => violation.severity === "critical").length,
      minor: violations.filter((violation) => violation.severity === "minor").length,
      violations,
    },
    totals: {
      samples: ordered.length,
      errors: ordered.filter((record) => record.error !== undefined).length,
      totalTokens: ordered.reduce((sum, record) => sum + record.totalTokens, 0),
      durationMs: ordered.reduce((sum, record) => sum + record.durationMs, 0),
      costUSD: ordered.reduce((sum, record) => sum + record.costUSD, 0),
      costKnown: ordered.every((record) => record.costKnown),
    },
    samples: ordered,
  };
}

export interface PairedComparison {
  pairs: {
    taskId: string;
    difficulty: string;
    sampleIndex: number;
    baseline: boolean;
    final: boolean;
  }[];
  counts: { bothPass: number; baselineOnly: number; finalOnly: number; bothFail: number };
  /** Samples present in only one report; a non-empty list means the runs are not fully paired. */
  unpaired: { taskId: string; sampleIndex: number; presentIn: "baseline" | "final" }[];
  byDifficulty: Record<string, { baseline: number; final: number; delta: number; pairs: number }>;
}

function pairKey(record: Pick<SampleRecord, "taskId" | "sampleIndex">): string {
  return `${record.taskId}#${record.sampleIndex}`;
}

/**
 * Pair two runs on (task, sample index). Deltas are computed over samples present in both
 * runs; a sample that errored is present and counts as a failure in its run.
 */
export function pairSamples(
  baseline: readonly SampleRecord[],
  final: readonly SampleRecord[],
): PairedComparison {
  const finalByKey = new Map(final.map((record) => [pairKey(record), record]));
  const baselineKeys = new Set(baseline.map(pairKey));
  const pairs: PairedComparison["pairs"] = [];
  const unpaired: PairedComparison["unpaired"] = [];
  for (const record of baseline) {
    const match = finalByKey.get(pairKey(record));
    if (match === undefined) {
      unpaired.push({
        taskId: record.taskId,
        sampleIndex: record.sampleIndex,
        presentIn: "baseline",
      });
      continue;
    }
    pairs.push({
      taskId: record.taskId,
      difficulty: record.difficulty,
      sampleIndex: record.sampleIndex,
      baseline: record.pass,
      final: match.pass,
    });
  }
  for (const record of final) {
    if (!baselineKeys.has(pairKey(record))) {
      unpaired.push({ taskId: record.taskId, sampleIndex: record.sampleIndex, presentIn: "final" });
    }
  }
  pairs.sort(
    (first, second) =>
      first.taskId.localeCompare(second.taskId) || first.sampleIndex - second.sampleIndex,
  );

  const counts = { bothPass: 0, baselineOnly: 0, finalOnly: 0, bothFail: 0 };
  const tiers = new Map<string, { baseline: number; final: number; pairs: number }>();
  for (const pair of pairs) {
    if (pair.baseline && pair.final) {
      counts.bothPass += 1;
    } else if (pair.baseline) {
      counts.baselineOnly += 1;
    } else if (pair.final) {
      counts.finalOnly += 1;
    } else {
      counts.bothFail += 1;
    }
    const tier = tiers.get(pair.difficulty) ?? { baseline: 0, final: 0, pairs: 0 };
    tier.pairs += 1;
    tier.baseline += pair.baseline ? 1 : 0;
    tier.final += pair.final ? 1 : 0;
    tiers.set(pair.difficulty, tier);
  }
  return {
    pairs,
    counts,
    unpaired,
    byDifficulty: Object.fromEntries(
      [...tiers.entries()].map(([difficulty, tier]) => {
        const baselineRate = tier.baseline / tier.pairs;
        const finalRate = tier.final / tier.pairs;
        return [
          difficulty,
          {
            baseline: baselineRate,
            final: finalRate,
            delta: finalRate - baselineRate,
            pairs: tier.pairs,
          },
        ];
      }),
    ),
  };
}
