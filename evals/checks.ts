import { existsSync, readdirSync, readFileSync } from "node:fs";
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
