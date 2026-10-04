/**
 * What a parent reads of its sub-agents' answers.
 *
 * Every finished child's whole answer is written to a file. `wait_subagents` returns previews
 * that share one context budget across the children it returns, each with the file's path, so
 * one long answer can never crowd another out and nothing is lost to a cut the parent cannot undo.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { UntrustedProvenance } from "@/core/types/tools";
import { getWorkStateDirectory } from "@/core/utils/paths";
import type { SubagentSnapshot } from "./supervisor";

export interface FinishedSubagent {
  readonly id: string;
  readonly startedAt: number;
  readonly result: unknown;
}

/** A preview is cut at a line break when one falls in the last fifth of its budget. */
const LINE_BREAK_SEARCH_FRACTION = 0.8;

/** Where a run's children's answers are kept: with the conversation's work state, deleted with it. */
export function subagentResultsDirectory(agentId: string, conversationId: string): string {
  return path.join(getWorkStateDirectory(agentId, conversationId), "subagent-results");
}

/** The answer as text: a string as is, a structured result as indented JSON. */
export function subagentResultText(result: unknown): string | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

/**
 * Writes a finished child's whole answer under `directory`. Undefined when it has no answer or
 * the write failed; the parent then gets the preview alone.
 */
export function saveSubagentResult(directory: string, child: FinishedSubagent): string | undefined {
  const text = subagentResultText(child.result);
  if (text === undefined || text.trim() === "") {
    return undefined;
  }
  const extension = typeof child.result === "string" ? "md" : "json";
  const filePath = path.join(directory, `${child.id}-${String(child.startedAt)}.${extension}`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(filePath, text, { mode: 0o600 });
    return filePath;
  } catch {
    return undefined;
  }
}

function cutAtLineBreak(text: string, maxChars: number): string {
  const head = text.slice(0, maxChars);
  const lastBreak = head.lastIndexOf("\n");
  return lastBreak >= maxChars * LINE_BREAK_SEARCH_FRACTION ? head.slice(0, lastBreak) : head;
}

/**
 * Splits `budgetChars` across the children that carry an answer: short answers take only what
 * they need, and what they leave is shared by the longer ones.
 */
function previewWithin(
  subagents: readonly SubagentSnapshot[],
  budgetChars: number,
): SubagentSnapshot[] {
  const lengths = new Map<string, number>();
  for (const child of subagents) {
    const text = subagentResultText(child.result);
    if (text !== undefined) {
      lengths.set(child.id, text.length);
    }
  }
  const allowance = new Map<string, number>();
  let remainingBudget = Math.max(0, budgetChars);
  let remainingChildren = lengths.size;
  for (const [id, length] of [...lengths].sort((left, right) => left[1] - right[1])) {
    const share = Math.floor(remainingBudget / remainingChildren);
    const granted = Math.min(length, share);
    allowance.set(id, granted);
    remainingBudget -= granted;
    remainingChildren--;
  }

  return subagents.map((child) => {
    const text = subagentResultText(child.result);
    const granted = allowance.get(child.id);
    if (text === undefined || granted === undefined || text.length <= granted) {
      return child;
    }
    const preview = cutAtLineBreak(text, granted);
    const note =
      child.resultPath !== undefined
        ? `Preview: the first ${String(preview.length)} of ${String(text.length)} chars. Read the whole answer with read_file at resultPath, by startLine and endLine when it is long, before relying on it.`
        : `Preview: the first ${String(preview.length)} of ${String(text.length)} chars; the whole answer could not be saved.`;
    return { ...child, result: preview, resultNote: note };
  });
}

/**
 * The children's answers as previews whose serialized form fits `maxSerializedChars`, the
 * budget the conversation gives one tool result.
 */
export function fitSubagentResults(
  subagents: readonly SubagentSnapshot[],
  maxSerializedChars: number,
  serialize: (subagents: readonly SubagentSnapshot[]) => string,
): SubagentSnapshot[] {
  let budget = maxSerializedChars;
  for (;;) {
    const fitted = previewWithin(subagents, budget);
    const overBy = serialize(fitted).length - maxSerializedChars;
    if (overBy <= 0 || budget === 0) {
      return fitted;
    }
    budget = Math.max(0, budget - overBy);
  }
}

/**
 * One provenance naming every child that read external content and whose answer or error is
 * shown, not only the first.
 */
export function combinedProvenance(
  subagents: readonly SubagentSnapshot[],
): UntrustedProvenance | undefined {
  const tainted = subagents.flatMap((child) =>
    child.untrusted !== undefined && (child.result !== undefined || child.error !== undefined)
      ? [child.untrusted]
      : [],
  );
  const [first] = tainted;
  if (first === undefined) {
    return undefined;
  }
  if (tainted.length === 1) {
    return first;
  }
  return {
    kind: tainted.some((provenance) => provenance.kind === "external") ? "external" : first.kind,
    source: tainted.map((provenance) => provenance.source).join(", "),
  };
}
