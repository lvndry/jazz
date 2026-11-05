/**
 * Absolute budgets for the pull-request performance lane (`bun run bench:pr`).
 * They are source constants: no environment variable or report field can
 * loosen them, and the only scaling is the explicit `--ci` flag.
 *
 * Every latency budget is the worst per-sample p95 observed on the reference
 * machine (Apple Silicon laptop, smoke profile, repeated runs while the machine
 * was busy) multiplied by PR_BUDGET_HEADROOM and rounded up. The lane catches
 * order-of-magnitude regressions in a few minutes; the paired workflow in
 * `.github/workflows/performance.yml` stays the tool for small regressions.
 */

/** Slack over the worst observed reference p95; one noisy process must not fail a PR. */
export const PR_BUDGET_HEADROOM = 2;

/**
 * Multiplier from reference-machine budgets to GitHub-hosted `ubuntu-latest`
 * runners (shared 4 vCPU x64 against a fast single-user laptop). Applied only
 * when the runner passes `--ci`.
 */
export const CI_TIME_SCALE = 2;

/** Release size may grow this much beyond the measured artifact (the repo's binaryRelativeAllowance). */
export const PR_SIZE_HEADROOM = 1.05;

export interface LatencyBudget {
  readonly suite: string;
  readonly name: string;
  readonly referenceP95Ms: number;
}

export const LATENCY_BUDGETS: readonly LatencyBudget[] = [
  { suite: "startup", name: "source --version", referenceP95Ms: 260 },
  { suite: "startup", name: "compiled --version", referenceP95Ms: 165 },
  { suite: "startup", name: "compiled OpenTUI fresh home -> typed draft", referenceP95Ms: 1900 },
  { suite: "startup", name: "compiled OpenTUI warm home -> typed draft", referenceP95Ms: 1800 },
  { suite: "startup", name: "compiled Ink fresh home -> typed draft", referenceP95Ms: 2500 },
  { suite: "startup", name: "compiled Ink warm home -> typed draft", referenceP95Ms: 1700 },
  { suite: "stream-processor", name: "process 2000 text deltas", referenceP95Ms: 150 },
  {
    suite: "stream-processor",
    name: "process 2000 deltas, structured reasoning",
    referenceP95Ms: 70,
  },
  {
    suite: "stream-processor",
    name: "process 2000 deltas through TagPairParser",
    referenceP95Ms: 75,
  },
  { suite: "transcript-rows", name: "cold full wrap (600 blocks)", referenceP95Ms: 115 },
  { suite: "transcript-rows", name: "warm streaming tail (600 settled)", referenceP95Ms: 1.5 },
  {
    suite: "transcript-rows",
    name: "fingerprint tax, unchanged blocks (600)",
    referenceP95Ms: 0.5,
  },
];

export interface SizeBudget {
  readonly binaryBytes: number;
  readonly gzipBytes: number;
}

/**
 * Compiled release size per `${process.platform}-${process.arch}`: the measured
 * artifact multiplied by PR_SIZE_HEADROOM, rounded up to the next 100KB. The
 * size includes Bun itself, so a Bun upgrade is expected to move it.
 */
export const SIZE_BUDGETS: Readonly<Record<string, SizeBudget>> = {
  "linux-x64": { binaryBytes: 206_500_000, gzipBytes: 87_200_000 },
  "darwin-arm64": { binaryBytes: 181_600_000, gzipBytes: 74_600_000 },
};
