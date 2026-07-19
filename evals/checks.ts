import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import type { CheckResult, OneShotResult } from "./types";

/** The agent invoked a specific tool (trajectory check for tool-use tasks). */
export function toolUsedCheck(result: OneShotResult, toolName: string): CheckResult {
  const used = result.toolCalls.some((call) => call.name === toolName);
  return {
    pass: used,
    score: used ? 1 : 0,
    detail: used ? `used ${toolName}` : `${toolName} was not called`,
  };
}

/** A file exists in the workspace and contains all required substrings. */
export function fileStateCheck(
  workspaceDir: string,
  opts: { path: string; mustContain?: string[] },
): CheckResult {
  const full = join(workspaceDir, opts.path);
  if (!existsSync(full)) {
    return { pass: false, score: 0, detail: `expected file missing: ${opts.path}` };
  }
  const content = readFileSync(full, "utf-8");
  const required = opts.mustContain ?? [];
  const missing = required.filter((needle) => !content.includes(needle));
  const pass = missing.length === 0;
  const score = required.length === 0 ? 1 : (required.length - missing.length) / required.length;
  return {
    pass,
    score,
    detail: pass ? `ok: ${opts.path}` : `missing substrings: ${missing.join(", ")}`,
  };
}

export interface Constraint {
  name: string;
  test: (answer: string) => boolean;
}

/** All hard constraints on the produced answer hold (planning tasks). */
export function constraintCheck(result: OneShotResult, constraints: Constraint[]): CheckResult {
  const failed = constraints.filter((constraint) => !constraint.test(result.answer));
  const pass = failed.length === 0;
  const score =
    constraints.length === 0 ? 1 : (constraints.length - failed.length) / constraints.length;
  return {
    pass,
    score,
    detail: pass
      ? `all ${constraints.length} constraints satisfied`
      : `failed: ${failed.map((constraint) => constraint.name).join(", ")}`,
  };
}

/**
 * The answer cites sources that actually exist in the fixture corpus and quotes
 * a snippet present in the cited file. v1 is deliberately simple: a source counts
 * as grounded when its filename appears in the answer AND at least one non-trivial
 * line from that file appears verbatim in the answer.
 */
export function citationGroundingCheck(result: OneShotResult, corpusDir: string): CheckResult {
  const files = existsSync(corpusDir) ? readdirSync(corpusDir) : [];
  const grounded: string[] = [];
  for (const file of files) {
    if (!result.answer.includes(file)) continue;
    let content: string;
    try {
      content = readFileSync(join(corpusDir, file), "utf-8");
    } catch {
      continue; // directory entry / unreadable file — skip, don't crash the check
    }
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 25);
    if (lines.some((line) => result.answer.includes(line))) grounded.push(file);
  }
  const pass = grounded.length > 0;
  return {
    pass,
    score: pass ? 1 : 0,
    detail: pass ? `grounded in: ${grounded.join(", ")}` : "no cited source grounded in the corpus",
  };
}

export type JudgeFn = (prompt: string, output: string, criteria: string) => Promise<number>;

/**
 * Comprehension proxy for tutoring: feed ONLY the explanation to the judge with
 * each curated question; a good explanation lets the judge produce the known
 * answer. Score = fraction of questions answerable from the explanation alone.
 */
export async function comprehensionCheck(
  result: OneShotResult,
  qa: { question: string; answer: string }[],
  judge: JudgeFn,
): Promise<CheckResult> {
  let correct = 0;
  for (const item of qa) {
    const score = await judge(
      `Explanation:\n${result.answer}\n\nUsing ONLY the explanation above, is the following question answerable and is this the correct answer?\nQuestion: ${item.question}\nProposed answer: ${item.answer}\nReturn 1 if the explanation clearly supports that answer, else 0.`,
      result.answer,
      "comprehension",
    );
    if (score >= 0.5) correct++;
  }
  const score = qa.length === 0 ? 0 : correct / qa.length;
  return {
    pass: score >= 0.5,
    score,
    detail: `${correct}/${qa.length} questions answerable from the explanation`,
  };
}

/**
 * Deixis/grounding check for "this machine" questions (chip, RAM). Total RAM is
 * a fixed hardware constant on the box actually running the eval, so we can
 * assert against ground truth directly: pass if the answer cites the real RAM
 * figure OR the agent ran a system probe command; fail if it gives a generic
 * RAM-bucket answer or asks the user to supply their own specs.
 */
export function machineSpecGroundingCheck(
  result: OneShotResult,
  opts: { probePatterns: RegExp[]; askBackPatterns: RegExp[] },
): CheckResult {
  const ramGB = Math.round(totalmem() / 1024 ** 3);
  const citesRealRam = new RegExp(`\\b${ramGB}\\s*gb\\b`, "i").test(result.answer);
  const ranProbe = result.toolCalls.some(
    (call) =>
      call.name === "execute_command" &&
      opts.probePatterns.some((pattern) => pattern.test(call.arguments)),
  );
  const askedBack = opts.askBackPatterns.some((pattern) => pattern.test(result.answer));
  const pass = (citesRealRam || ranProbe) && !askedBack;
  const detail = askedBack
    ? "asked the user for their own specs instead of checking the machine"
    : citesRealRam
      ? `cites the real RAM (${ramGB}GB)`
      : ranProbe
        ? "ran a system probe command"
        : `no grounding found (expected ~${ramGB}GB cited or a probe command)`;
  return { pass, score: pass ? 1 : 0, detail };
}

export interface ToolGroundedSpec {
  /** Any call to one of these tools counts as "checked something real". */
  toolNames: string[];
  /** If set, at least one matching call's arguments must satisfy one of these. */
  toolArgPatterns?: RegExp[];
  /** The answer must match ALL of these — proof the tool's real output was used, not ignored. */
  answerPatterns: RegExp[];
}

/**
 * Grounding check for tasks whose correct answer can only come from inspecting
 * live state (disk, repo files, the web) rather than recalling or guessing.
 * Unlike machineSpecGroundingCheck, this requires BOTH a matching tool call AND
 * answer content consistent with it — the tool call alone doesn't prove the
 * agent actually used what it found.
 */
export function toolGroundedAnswerCheck(
  result: OneShotResult,
  spec: ToolGroundedSpec,
): CheckResult {
  const matchingCalls = result.toolCalls.filter((call) => spec.toolNames.includes(call.name));
  const checkedReality =
    matchingCalls.length > 0 &&
    (!spec.toolArgPatterns ||
      matchingCalls.some((call) => spec.toolArgPatterns!.some((p) => p.test(call.arguments))));
  const missing = spec.answerPatterns.filter((pattern) => !pattern.test(result.answer));
  const pass = checkedReality && missing.length === 0;
  return {
    pass,
    score: !checkedReality
      ? 0
      : (spec.answerPatterns.length - missing.length) / spec.answerPatterns.length,
    detail: pass
      ? "checked real state via a grounding tool and the answer reflects it"
      : !checkedReality
        ? `expected a real check via ${spec.toolNames.join("/")}${spec.toolArgPatterns ? " matching an expected pattern" : ""}, none found`
        : `tool was called but the answer is missing grounded content (${missing.length}/${spec.answerPatterns.length} patterns unmatched)`,
  };
}

/**
 * Disk free space is not a stable ground truth like RAM — it drifts as other
 * processes write files — so this only bounds plausibility (same order of
 * magnitude as reality at check time) rather than requiring an exact match.
 */
export function plausibleFreeDiskGB(path: string): { min: number; max: number } {
  const stats = statfsSync(path);
  const freeGB = (stats.bavail * stats.bsize) / 1024 ** 3;
  return { min: freeGB * 0.5, max: freeGB * 1.5 };
}
