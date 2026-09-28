import type { Block, ToolReceiptBlock } from "./types";

/** The tool the agent keeps its plan with. Every update to the plan settles as one of its receipts. */
const PLAN_TOOL = "manage_todos";

/**
 * A settled turn keeps one plan receipt, however many times it updated the
 * plan. Each update to the todo list left a receipt, so a five-step plan left
 * five. The live zone showed the plan while it ran; once settled, only the
 * last update survives, as `plan  5 of 5 done`, where it happened. A turn runs
 * from one user message to the next.
 */
export function foldTurn(blocks: readonly Block[]): Block[] {
  // A superseded plan receipt leaves a hole, so indices already handed out stay valid.
  const folded: (Block | undefined)[] = [];
  let planIndex: number | undefined;
  for (const block of blocks) {
    if (block.kind === "user") {
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
    folded.push(block);
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
