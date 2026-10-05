/**
 * What a parent reads of its sub-agents' answers.
 *
 * Every finished child's whole answer is kept in the conversation's tool-result store, where
 * `retrieve_tool_result` pages through it. `wait_subagents` returns previews that share one
 * context budget across the children it returns, each with the id to retrieve the whole answer
 * by, so one long answer can never crowd another out and nothing is lost to a cut.
 */

import type { UntrustedProvenance } from "@/core/types/tools";
import type { SubagentSnapshot } from "./supervisor";
import { writeToolResult } from "../context/tool-result-offload";

export interface FinishedSubagent {
  readonly id: string;
  readonly startedAt: number;
  readonly result: unknown;
  readonly untrusted?: UntrustedProvenance;
}

/** A preview is cut at a line break when one falls in the last fifth of its budget. */
const LINE_BREAK_SEARCH_FRACTION = 0.8;

/** The answer as text: a string as is, a structured result as indented JSON. */
export function subagentResultText(result: unknown): string | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

/**
 * Keeps a finished child's whole answer in the conversation's tool-result store, with the
 * provenance of what it read. Returns the id `retrieve_tool_result` reads it by, or undefined
 * when it has no answer or the write failed; the parent then gets the preview alone.
 */
export function saveSubagentResult(
  agentId: string,
  conversationId: string,
  child: FinishedSubagent,
): string | undefined {
  const text = subagentResultText(child.result);
  if (text === undefined || text.trim() === "") {
    return undefined;
  }
  const retrieveId = `subagent-${child.id}-${String(child.startedAt)}`;
  return writeToolResult(agentId, conversationId, retrieveId, text, child.untrusted)
    ? retrieveId
    : undefined;
}

/** How the parent reads a kept answer, a page at a time. */
export function retrieveInstruction(retrieveId: string): string {
  return `Call retrieve_tool_result with tool_call_id "${retrieveId}" to read the whole answer a page at a time.`;
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
    const shown = `Preview: the first ${String(preview.length)} of ${String(text.length)} chars`;
    const note =
      child.retrieveId !== undefined
        ? `${shown}. ${retrieveInstruction(child.retrieveId)} Read it before relying on it.`
        : `${shown}; the whole answer could not be kept.`;
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
