import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JudgeFn } from "./checks";
import { EVAL_CONFIG } from "./config";
import { parseEnvelope, spawnJazz } from "./run-jazz";
import { createSandbox, removeSandbox } from "./sandbox";

/** Pearson correlation. Returns 0 on length mismatch or zero variance. */
export function pearson(first: readonly number[], second: readonly number[]): number {
  const count = first.length;
  if (count === 0 || count !== second.length) {
    return 0;
  }
  const firstMean = first.reduce((sum, value) => sum + value, 0) / count;
  const secondMean = second.reduce((sum, value) => sum + value, 0) / count;
  let covariance = 0;
  let firstVariance = 0;
  let secondVariance = 0;
  for (let index = 0; index < count; index++) {
    const firstDeviation = (first[index] ?? firstMean) - firstMean;
    const secondDeviation = (second[index] ?? secondMean) - secondMean;
    covariance += firstDeviation * secondDeviation;
    firstVariance += firstDeviation * firstDeviation;
    secondVariance += secondDeviation * secondDeviation;
  }
  if (firstVariance === 0 || secondVariance === 0) {
    return 0;
  }
  return covariance / Math.sqrt(firstVariance * secondVariance);
}

/** Extract a clamped 0..1 score from a judge model's free-text answer. */
export function parseScore(answer: string): number {
  const match = answer.match(/-?\d*\.?\d+/);
  const value = match ? parseFloat(match[0]) : 0;
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * A judge backed by a jazz agent (a strong model — never the SUT). Spawns a
 * headless one-shot with a scoring prompt and parses a 0..1 score. No web
 * cassette: judging is pure reasoning over text the caller supplies.
 */
export function makeJudge(
  agentId: string = EVAL_CONFIG.judgeAgentId,
  timeoutMs: number = EVAL_CONFIG.timeoutMs,
): JudgeFn {
  return async (prompt) => {
    const sandbox = createSandbox("judge");
    try {
      mkdirSync(join(sandbox.jazzHome, "agents"), { recursive: true });
      copyFileSync(
        join(import.meta.dir, "agents", `${agentId}.json`),
        join(sandbox.jazzHome, "agents", `${agentId}.json`),
      );
      // The judge's provider key usually lives in the OS keyring, so the keyring stays on.
      const { JAZZ_DISABLE_KEYRING: _keyringOff, ...environment } = sandbox.environment;
      const proc = spawnJazz(
        ["run", prompt, "--agent", agentId, "--json", "--timeout", String(timeoutMs)],
        { environment, stdout: "pipe", stderr: "ignore" },
      );
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return parseScore(parseEnvelope(stdout).answer);
    } finally {
      removeSandbox(sandbox);
    }
  };
}

export interface CalibrationRow {
  prompt: string;
  output: string;
  human: number;
}

/**
 * Score the human-labeled calibration set with the judge and correlate. The
 * runner refuses to trust rubric scores when `ok` is false (Pearson below the
 * configured floor).
 */
export async function calibrateJudge(
  judge: JudgeFn,
  rows: CalibrationRow[],
  minPearson: number = EVAL_CONFIG.judgeCalibrationMinPearson,
): Promise<{ r: number; ok: boolean }> {
  const judged: number[] = [];
  const human: number[] = [];
  for (const row of rows) {
    judged.push(await judge(row.prompt, row.output, "calibration"));
    human.push(row.human);
  }
  const r = pearson(judged, human);
  return { r, ok: r >= minPearson };
}
