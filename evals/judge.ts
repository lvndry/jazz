import { join } from "node:path";
import type { JudgeFn } from "./checks";
import { EVAL_CONFIG } from "./config";
import { parseEnvelope } from "./run-jazz";

const MAIN_TS = join(import.meta.dir, "..", "src", "main.ts");

/** Pearson correlation. Returns 0 on length mismatch or zero variance. */
export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0 || n !== b.length) return 0;
  const meanA = a.reduce((sum, value) => sum + value, 0) / n;
  const meanB = b.reduce((sum, value) => sum + value, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let index = 0; index < n; index++) {
    const da = a[index]! - meanA;
    const db = b[index]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

/** Extract a clamped 0..1 score from a judge model's free-text answer. */
export function parseScore(answer: string): number {
  const match = answer.match(/-?\d*\.?\d+/);
  const value = match ? parseFloat(match[0]) : 0;
  if (Number.isNaN(value)) return 0;
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
    const proc = Bun.spawn(
      ["bun", MAIN_TS, "run", prompt, "--agent", agentId, "--json", "--timeout", String(timeoutMs)],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return parseScore(parseEnvelope(stdout).answer);
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
