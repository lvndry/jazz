/**
 * What an interrupted turn leaves behind, split into what finished and what did not.
 *
 * Stopping is a normal thing to do, so the summary is quiet: no error colour. What it
 * must get right is the state of the world, because a person who stopped a turn half-way
 * needs to know whether the email went out before deciding what to say next. So "done"
 * lists only calls that changed something, and "not done" lists what was running, what
 * was waiting for approval, and the plan steps that never finished.
 *
 * Renderer-free: the fullscreen transcript and the Ink transcript both draw this.
 */

import type { TodoSnapshotItem } from "../activity-state";
import { actionClass } from "./approval";

/** Rows each list shows before the rest collapse into `+N more`. */
export const INTERRUPT_LIST_ROWS = 3;

export interface InterruptSummary {
  readonly elapsedMs: number;
  readonly done: readonly string[];
  readonly notDone: readonly string[];
}

/** A settled tool call of the current turn, as both renderers record it. */
export interface ReceiptFacts {
  readonly app: string;
  readonly args?: string;
  readonly summary: string;
  readonly status: "ok" | "failed" | "denied";
}

export interface InterruptSnapshot {
  readonly elapsedMs: number;
  /** This turn's settled calls, oldest first. */
  readonly receipts: readonly ReceiptFacts[];
  readonly runningTools: readonly { readonly app: string; readonly operation: string }[];
  /** The title of an approval card that was up when the turn stopped. */
  readonly pendingApproval?: string;
  readonly todos: readonly TodoSnapshotItem[];
}

function receiptLine(receipt: ReceiptFacts): string {
  return [receipt.app, receipt.args, receipt.summary]
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .join("  ");
}

function capped(lines: readonly string[]): readonly string[] {
  if (lines.length <= INTERRUPT_LIST_ROWS) return lines;
  const shown = lines.slice(0, INTERRUPT_LIST_ROWS - 1);
  return [...shown, `+${String(lines.length - shown.length)} more`];
}

export function interruptSummary(snapshot: InterruptSnapshot): InterruptSummary {
  const done = snapshot.receipts
    .filter((receipt) => receipt.status === "ok" && actionClass(receipt.app) !== "act")
    .map(receiptLine);
  const notDone = [
    ...snapshot.runningTools.map((tool) => `${tool.app}  ${tool.operation} was stopped`),
    ...(snapshot.pendingApproval === undefined
      ? []
      : [`${snapshot.pendingApproval} was not approved`]),
    ...snapshot.todos
      .filter((todo) => todo.status === "in_progress" || todo.status === "pending")
      .map((todo) => todo.content),
  ];
  return {
    elapsedMs: snapshot.elapsedMs,
    done: capped(done.length > 0 ? done : ["nothing was changed"]),
    notDone: capped(notDone),
  };
}

/** The summary as plain lines, for a renderer that prints text: the words both surfaces share. */
export function interruptSummaryLines(summary: InterruptSummary, duration: string): string[] {
  const label = (text: string, index: number): string =>
    (index === 0 ? text : "").padEnd("not done  ".length);
  return [
    `stopped by you after ${duration}`,
    ...summary.done.map((item, index) => `${label("done", index)}${item}`),
    ...summary.notDone.map((item, index) => `${label("not done", index)}${item}`),
  ];
}
