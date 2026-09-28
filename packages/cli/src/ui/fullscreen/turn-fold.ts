import type { Block, ReasoningBlock, ToolReceiptBlock } from "./types";

/** The tool the agent keeps its plan with. Every update to the plan settles as one of its receipts. */
const PLAN_TOOL = "manage_todos";

/**
 * A settled turn keeps one line for each kind of bookkeeping it did, however
 * many times it did it. A turn runs from one user message to the next.
 *
 * - Reasoning: a turn that thinks before each of three tool calls produced
 *   three folded reasoning blocks, each on its own row between the receipts.
 *   They fold into the first, which carries their combined duration and how
 *   many steps it stands for. A block the reader opened with ctrl+r, or one
 *   still live, stays where it is.
 * - The plan: each update to the todo list left a receipt, so a five-step plan
 *   left five. The live zone showed the plan while it ran; once settled, only
 *   the last update survives, as `plan  5 of 5 done`, where it happened.
 */
export function foldTurn(blocks: readonly Block[]): Block[] {
  // A superseded plan receipt leaves a hole, so indices already handed out stay valid.
  const folded: (Block | undefined)[] = [];
  let reasoningHead: { index: number; block: ReasoningBlock } | undefined;
  let planIndex: number | undefined;
  for (const block of blocks) {
    if (block.kind === "user") {
      reasoningHead = undefined;
      planIndex = undefined;
      folded.push(block);
      continue;
    }
    if (block.kind === "tool" && isPlanUpdate(block)) {
      if (planIndex !== undefined) folded[planIndex] = undefined;
      planIndex = folded.length;
      folded.push(asPlanReceipt(block));
      continue;
    }
    if (block.kind !== "reasoning" || !block.collapsed) {
      folded.push(block);
      continue;
    }
    if (reasoningHead === undefined) {
      const head: ReasoningBlock = { ...block, steps: block.steps ?? 1 };
      reasoningHead = { index: folded.length, block: head };
      folded.push(head);
      continue;
    }
    const previous = reasoningHead.block;
    const durationMs =
      previous.durationMs === undefined && block.durationMs === undefined
        ? undefined
        : (previous.durationMs ?? 0) + (block.durationMs ?? 0);
    const merged: ReasoningBlock = {
      ...previous,
      steps: (previous.steps ?? 1) + (block.steps ?? 1),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    reasoningHead = { index: reasoningHead.index, block: merged };
    folded[reasoningHead.index] = merged;
  }
  return folded.filter((block): block is Block => block !== undefined);
}

function isPlanUpdate(block: ToolReceiptBlock): boolean {
  return block.app === PLAN_TOOL && block.status === "ok" && block.expanded !== true;
}

/** The plan's JSON arguments say nothing a person reads; the outcome is the progress. */
function asPlanReceipt(block: ToolReceiptBlock): ToolReceiptBlock {
  const { args: _args, ...rest } = block;
  return { ...rest, app: "plan" };
}
