/**
 * What an interrupted turn leaves behind, split into what finished and what did not.
 *
 * Stopping is a normal thing to do, so the summary is quiet: no error colour. What it
 * must get right is the state of the world, because a person who stopped a turn half-way
 * needs to know whether the email went out before deciding what to say next. So "done"
 * lists only calls that changed something, and "not done" lists what was running, what
 * was waiting for approval, and the plan steps that never finished.
 */

import type { TodoSnapshotItem } from "../activity-state";
import { actionClass } from "./approval-intent";
import type { Block, LiveTool, ToolReceiptBlock } from "./types";

/** Rows each list shows before the rest collapse into `+N more`. */
export const INTERRUPT_LIST_ROWS = 3;

export interface InterruptSummary {
  readonly elapsedMs: number;
  readonly done: readonly string[];
  readonly notDone: readonly string[];
}

export interface InterruptSnapshot {
  readonly elapsedMs: number;
  /** The transcript as it stands; the turn is everything after the last user message. */
  readonly blocks: readonly Block[];
  readonly runningTools: readonly LiveTool[];
  /** The title of an approval card that was up when the turn stopped. */
  readonly pendingApproval?: string;
  readonly todos: readonly TodoSnapshotItem[];
}

function currentTurn(blocks: readonly Block[]): readonly Block[] {
  let start = blocks.length;
  while (start > 0 && blocks[start - 1]?.kind !== "user") start -= 1;
  return blocks.slice(start);
}

function receiptLine(receipt: ToolReceiptBlock): string {
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
  const changed = currentTurn(snapshot.blocks).filter(
    (block): block is ToolReceiptBlock =>
      block.kind === "tool" && block.status === "ok" && actionClass(block.app) !== "act",
  );
  const done = changed.map(receiptLine);
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
